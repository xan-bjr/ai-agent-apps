import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { Part } from "@google/genai";
import type { GeminiContent } from "./gemini";

type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  text?: string;
  data?: string;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[];
  toolCalls?: ToolCard[];
  history?: GeminiContent[];
};

type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
};

type WorkspaceState = {
  conversations: Conversation[];
  activeConversationId: string;
};

type ToolCard = {
  id: string;
  functionCallId?: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
};

const API_KEY_STORAGE_KEY = "devxanai-gemini-api-key";
const MODEL_STORAGE_KEY = "devxanai-gemini-model";
const THEME_STORAGE_KEY = "devxanai-theme";
const DATABASE_NAME = "devxanai-workspace";
const DATABASE_VERSION = 1;
const WORKSPACE_STORE = "workspace";
const WORKSPACE_KEY = "main";
const MODEL_OPTIONS = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-flash-latest",
] as const;
const SUPPORTED_MODELS: ReadonlySet<string> = new Set(MODEL_OPTIONS);
const DEFAULT_MODEL = MODEL_OPTIONS[0];
const PREVIOUS_DEFAULT_MODEL = "gemini-3.8-flash";
const STREAM_IDLE_TIMEOUT_MS = 120_000;
const MAX_ATTACHMENT_COUNT = 5;
const MAX_ATTACHMENT_SIZE = 8 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_SIZE = 12 * 1024 * 1024;
let workspaceDatabase: Promise<IDBDatabase> | null = null;

const suggestions = [
  { icon: "⌘", title: "Write code", description: "Build a useful Python script" },
  { icon: "✳", title: "Explore an idea", description: "Explain a complex topic simply" },
  { icon: "↗", title: "Get unstuck", description: "Help me solve a tricky problem" },
  { icon: "▤", title: "Draft something", description: "Turn a rough idea into a plan" },
];

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => createWorkspace());
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [conversationSearch, setConversationSearch] = useState("");
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(API_KEY_STORAGE_KEY) ?? "");
  const [keyDraft, setKeyDraft] = useState(apiKey);
  const [model, setModel] = useState(() => {
    const savedModel = localStorage.getItem(MODEL_STORAGE_KEY);
    return savedModel &&
      savedModel !== PREVIOUS_DEFAULT_MODEL &&
      SUPPORTED_MODELS.has(savedModel)
      ? savedModel
      : DEFAULT_MODEL;
  });
  const [modelDraft, setModelDraft] = useState(model);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    return savedTheme === "dark" ? "dark" : "light";
  });
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeRequestRef = useRef<AbortController | null>(null);
  const userStoppedRef = useRef(false);
  const activeConversation = workspace.conversations.find(
    (conversation) => conversation.id === workspace.activeConversationId,
  );
  const messages = activeConversation?.messages ?? [];

  useEffect(() => {
    let cancelled = false;
    void loadWorkspace()
      .then((savedWorkspace) => {
        if (cancelled) return;
        if (savedWorkspace) setWorkspace(savedWorkspace);
        setWorkspaceLoaded(true);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError(
          loadError instanceof Error
            ? `Could not restore saved conversations: ${loadError.message}`
            : "Could not restore saved conversations.",
        );
        setWorkspaceLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!workspaceLoaded) return;
    const timeout = window.setTimeout(() => {
      void saveWorkspace(workspace).catch((saveError: unknown) => {
        setError(
          saveError instanceof Error
            ? `Could not save conversations: ${saveError.message}`
            : "Could not save conversations.",
        );
      });
    }, 400);
    return () => window.clearTimeout(timeout);
  }, [workspace, workspaceLoaded]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (!error) return;
    const timeout = window.setTimeout(() => setError(""), 6000);
    return () => window.clearTimeout(timeout);
  }, [error]);

  function updateConversationMessages(
    conversationId: string,
    update: Message[] | ((current: Message[]) => Message[]),
  ) {
    setWorkspace((current) => ({
      ...current,
      conversations: current.conversations.map((conversation) => {
        if (conversation.id !== conversationId) return conversation;
        const updatedMessages =
          typeof update === "function" ? update(conversation.messages) : update;
        const firstUserMessage = updatedMessages.find((message) => message.role === "user");
        return {
          ...conversation,
          title:
            conversation.title === "New chat" && firstUserMessage
              ? createConversationTitle(
                  firstUserMessage.content || firstUserMessage.attachments?.[0]?.name || "",
                )
              : conversation.title,
          messages: updatedMessages,
          updatedAt: Date.now(),
        };
      }),
    }));
  }

  async function sendMessage(text = draft) {
    const content = text.trim();
    if (!workspaceLoaded || (!content && attachments.length === 0) || streaming) return;
    if (!apiKey) {
      setKeyDraft(apiKey);
      setModelDraft(model);
      setSettingsOpen(true);
      return;
    }

    const conversationId = workspace.activeConversationId;
    const nextMessages: Message[] = [
      ...messages,
      { role: "user", content, ...(attachments.length ? { attachments: [...attachments] } : {}) },
    ];
    const assistantMessage: Message = { role: "assistant", content: "", toolCalls: [] };
    updateConversationMessages(conversationId, [...nextMessages, assistantMessage]);
    setDraft("");
    setAttachments([]);
    setError("");
    setStreaming(true);
    const abortController = new AbortController();
    activeRequestRef.current = abortController;
    userStoppedRef.current = false;
    let timedOut = false;
    let receivedDone = false;
    let timeoutId = window.setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, STREAM_IDLE_TIMEOUT_MS);
    const resetStreamTimeout = () => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, STREAM_IDLE_TIMEOUT_MS);
    };

    try {
      let answer = "";
      const toolCalls: ToolCard[] = [];
      const history: GeminiContent[] = [];

      const saveAssistantProgress = () => {
        updateConversationMessages(conversationId, [
          ...nextMessages,
          {
            role: "assistant",
            content: answer,
            toolCalls: [...toolCalls],
            history: [...history],
          },
        ]);
      };

      const { streamGeminiAgent } = await import("./gemini");
      for await (const event of streamGeminiAgent(
        apiKey,
        model,
        toGeminiContents(nextMessages),
        abortController.signal,
      )) {
        resetStreamTimeout();
        if (event.type === "text") answer += event.content;
        if (event.type === "history") history.push(...event.contents);
        if (event.type === "tool_start") toolCalls.push(event.toolCall);
        if (event.type === "tool_result") {
          const call = toolCalls.find((toolCall) => toolCall.id === event.id);
          if (call) call.result = event.result;
        }
        if (event.type === "done") receivedDone = true;
        saveAssistantProgress();
      }

      if (!abortController.signal.aborted && !receivedDone) {
        throw new Error("The AI service ended before completing the response.");
      }
      if (!answer && toolCalls.length === 0 && !userStoppedRef.current) {
        throw new Error("The AI service returned no message.");
      }
    } catch (requestError) {
      const message =
        timedOut
          ? "Gemini did not respond in time. Please try again."
          : requestError instanceof Error
            ? requestError.message
            : "Something went wrong.";
      if (!userStoppedRef.current) setError(message);
      updateConversationMessages(conversationId, (current) => {
        const last = current[current.length - 1];
        return last?.role === "assistant" && !last.content && !last.toolCalls?.length
          ? current.slice(0, -1)
          : current;
      });
    } finally {
      window.clearTimeout(timeoutId);
      if (activeRequestRef.current === abortController) activeRequestRef.current = null;
      userStoppedRef.current = false;
      setStreaming(false);
      inputRef.current?.focus();
    }
  }

  function stopReply() {
    if (!activeRequestRef.current) return;
    userStoppedRef.current = true;
    activeRequestRef.current.abort();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  function startNewConversation() {
    if (streaming) return;
    const conversation = createConversation();
    setWorkspace((current) => ({
      conversations: [conversation, ...current.conversations],
      activeConversationId: conversation.id,
    }));
    setAttachments([]);
    setDraft("");
    setError("");
    setSidebarOpen(false);
    inputRef.current?.focus();
  }

  function selectConversation(conversationId: string) {
    if (streaming) return;
    if (conversationId === workspace.activeConversationId) {
      setSidebarOpen(false);
      return;
    }
    setWorkspace((current) => ({ ...current, activeConversationId: conversationId }));
    setAttachments([]);
    setDraft("");
    setError("");
    setSidebarOpen(false);
  }

  function deleteConversation(conversationId: string) {
    if (streaming) return;
    setWorkspace((current) => {
      const remaining = current.conversations.filter(
        (conversation) => conversation.id !== conversationId,
      );
      const replacement = remaining.length ? remaining : [createConversation()];
      const activeConversationId =
        current.activeConversationId === conversationId
          ? replacement[0].id
          : current.activeConversationId;
      return { conversations: replacement, activeConversationId };
    });
    setAttachments([]);
    setDraft("");
    setError("");
  }

  function beginRenameConversation(conversation: Conversation) {
    setRenamingConversationId(conversation.id);
    setRenameDraft(conversation.title);
  }

  function renameConversation(event: FormEvent<HTMLFormElement>, conversationId: string) {
    event.preventDefault();
    const title = renameDraft.trim();
    if (!title) return;
    setWorkspace((current) => ({
      ...current,
      conversations: current.conversations.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, title, updatedAt: Date.now() }
          : conversation,
      ),
    }));
    setRenamingConversationId(null);
    setRenameDraft("");
  }

  function exportConversation(format: "json" | "markdown") {
    if (!activeConversation) return;
    const filename = slugify(activeConversation.title) || "conversation";
    const blob =
      format === "json"
        ? new Blob(
            [
              JSON.stringify(
                { ...activeConversation, exportedAt: new Date().toISOString() },
                null,
                2,
              ),
            ],
            { type: "application/json" },
          )
        : new Blob([conversationToMarkdown(activeConversation)], {
            type: "text/markdown;charset=utf-8",
          });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${filename}.${format === "json" ? "json" : "md"}`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function addAttachments(files: FileList | null) {
    if (!files?.length) return;
    setError("");
    try {
      const selectedFiles = Array.from(files);
      if (attachments.length + selectedFiles.length > MAX_ATTACHMENT_COUNT) {
        throw new Error(`Attach up to ${MAX_ATTACHMENT_COUNT} files per message.`);
      }
      const currentSize = attachments.reduce((total, attachment) => total + attachment.size, 0);
      const added = await Promise.all(selectedFiles.map(readAttachment));
      const addedSize = added.reduce((total, attachment) => total + attachment.size, 0);
      if (currentSize + addedSize > MAX_TOTAL_ATTACHMENT_SIZE) {
        throw new Error("Attachments must total 12 MB or less per message.");
      }
      setAttachments((current) => [...current, ...added]);
    } catch (attachmentError) {
      setError(
        attachmentError instanceof Error
          ? attachmentError.message
          : "Could not read the selected file.",
      );
    }
  }

  function removeAttachment(attachmentId: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
  }

  function saveApiKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const savedKey = keyDraft.trim();
    const savedModel = modelDraft.trim();
    if (!savedKey || !savedModel) return;
    localStorage.setItem(API_KEY_STORAGE_KEY, savedKey);
    localStorage.setItem(MODEL_STORAGE_KEY, savedModel);
    setApiKey(savedKey);
    setModel(savedModel);
    setSettingsOpen(false);
    setError("");
    inputRef.current?.focus();
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <button
          className="mobile-history-button"
          onClick={() => setSidebarOpen((open) => !open)}
          aria-label="Toggle conversation history"
        >
          ☰
        </button>
        <a className="brand" href={import.meta.env.BASE_URL} aria-label="Devxanai home">
          <span className="brand-mark">d</span>
          <span>devxanai</span>
        </a>
        <div className="topbar-actions">
          <span className="workspace-label">AI workspace</span>
          <button
            className="theme-button"
            onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          >
            {theme === "light" ? "☾" : "☀"}
          </button>
          {streaming && (
            <button className="stop-button" onClick={stopReply}>
              <span>■</span> Stop
            </button>
          )}
          <button
            className="settings-button"
            onClick={() => {
              setKeyDraft(apiKey);
              setModelDraft(model);
              setSettingsOpen(true);
            }}
          >
            <span aria-hidden="true">⚙</span>
            Settings
            <span className={`key-status ${apiKey ? "configured" : ""}`} />
          </button>
        </div>
      </header>

      <div className="workspace-layout">
        <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
          <div className="sidebar-heading">
            <span className="sidebar-label">WORKSPACE</span>
            <button
              className="sidebar-close"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close conversation history"
            >
              ×
            </button>
          </div>
          <button
            className="new-chat-button"
            onClick={startNewConversation}
            disabled={!workspaceLoaded || streaming}
          >
            <span>＋</span> New chat
          </button>
          <label className="conversation-search">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              placeholder="Search conversations"
              aria-label="Search conversations"
              value={conversationSearch}
              onChange={(event) => setConversationSearch(event.target.value)}
            />
          </label>
          <div className="conversation-section-label">YOUR CONVERSATIONS</div>
          <nav className="conversation-list" aria-label="Conversations">
            {[...workspace.conversations]
              .sort((left, right) => right.updatedAt - left.updatedAt)
              .filter((conversation) => matchesConversation(conversation, conversationSearch))
              .map((conversation) => (
                <div className="conversation-row" key={conversation.id}>
                  {renamingConversationId === conversation.id ? (
                    <form
                      className="rename-form"
                      onSubmit={(event) => renameConversation(event, conversation.id)}
                    >
                      <input
                        autoFocus
                        value={renameDraft}
                        aria-label="Conversation name"
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setRenamingConversationId(null);
                        }}
                      />
                      <button type="submit" aria-label="Save conversation name">✓</button>
                    </form>
                  ) : (
                    <>
                      <button
                        className={`conversation-button ${conversation.id === workspace.activeConversationId ? "active" : ""}`}
                        onClick={() => selectConversation(conversation.id)}
                        disabled={!workspaceLoaded || streaming}
                      >
                        <span className="conversation-icon">◷</span>
                        <span className="conversation-title">{conversation.title}</span>
                      </button>
                      <div className="conversation-row-actions">
                        <button
                          className="conversation-rename"
                          onClick={() => beginRenameConversation(conversation)}
                          disabled={!workspaceLoaded || streaming}
                          aria-label={`Rename ${conversation.title}`}
                          title="Rename conversation"
                        >
                          ✎
                        </button>
                        <button
                          className="conversation-delete"
                          onClick={() => deleteConversation(conversation.id)}
                          disabled={!workspaceLoaded || streaming}
                          aria-label={`Delete ${conversation.title}`}
                          title="Delete conversation"
                        >
                          ×
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            {workspace.conversations.length > 0 &&
              !workspace.conversations.some((conversation) =>
                matchesConversation(conversation, conversationSearch),
              ) && <p className="no-conversations">No matching conversations.</p>}
          </nav>
          <div className="sidebar-footer">
            <div className="export-actions">
              <button className="export-button" onClick={() => exportConversation("markdown")} disabled={!activeConversation?.messages.length}>
                <span>↓</span> Markdown
              </button>
              <button className="export-button" onClick={() => exportConversation("json")} disabled={!activeConversation?.messages.length}>
                <span>↓</span> JSON
              </button>
            </div>
            <span className="local-storage-note">Saved in this browser</span>
          </div>
        </aside>
        {sidebarOpen && (
          <button
            className="sidebar-backdrop"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close conversation history"
          />
        )}

      <section className={`chat-area ${messages.length ? "has-messages" : ""}`}>
        {messages.length === 0 ? (
          <div className="welcome">
            <div className="eyebrow"><span /> YOUR THOUGHT PARTNER</div>
            <h1>Good ideas start<br />with <span>a conversation.</span></h1>
            <p className="welcome-copy">
              Think it through, work it out, or just get started.<br />
              I’m here to help with whatever’s on your mind.
            </p>
            <div className="suggestions">
              {suggestions.map((suggestion) => (
                <button
                  className="suggestion-card"
                  key={suggestion.title}
                  onClick={() => {
                    setDraft(suggestion.description);
                    inputRef.current?.focus();
                  }}
                >
                  <span className="suggestion-icon">{suggestion.icon}</span>
                  <span className="suggestion-title">{suggestion.title}</span>
                  <span className="suggestion-description">{suggestion.description}</span>
                  <span className="suggestion-arrow">↗</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="message-list" aria-live="polite">
            {messages.map((message, index) => (
              <article
                className={`message ${message.role}`}
                key={`${index}-${message.role}`}
              >
                {message.role === "assistant" && <span className="assistant-mark">d</span>}
                <div className="assistant-message-body">
                  <div className="message-content">
                    {message.content || (streaming && index === messages.length - 1 ? (
                      <span className="thinking-indicator">Thinking...</span>
                    ) : null)}
                  </div>
                  {message.role === "user" && message.attachments && (
                    <div className="message-attachments">
                      {message.attachments.map((attachment) => (
                        <div className="message-attachment" key={attachment.id}>
                          <span>{attachment.data ? "▧" : "▤"}</span>
                          <span>{attachment.name}</span>
                          <small>{formatFileSize(attachment.size)}</small>
                        </div>
                      ))}
                    </div>
                  )}
                  {message.toolCalls?.map((toolCall) => (
                    <ToolCallCard key={toolCall.id} toolCall={toolCall} />
                  ))}
                </div>
              </article>
            ))}
            <div ref={bottomRef} />
          </div>
        )}

        <div className="composer-wrap">
          <form className="composer" onSubmit={handleSubmit}>
            <input
              ref={fileInputRef}
              className="file-input"
              type="file"
              multiple
              accept="image/*,application/pdf,text/*,.txt,.md,.csv,.json,.js,.jsx,.ts,.tsx,.py,.html,.css,.xml,.yaml,.yml,.toml,.sh,.ps1,.sql,.log"
              onChange={(event) => {
                void addAttachments(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
            {attachments.length > 0 && (
              <div className="attachment-list" aria-label="Attached files">
                {attachments.map((attachment) => (
                  <div className="attachment-chip" key={attachment.id}>
                    <span className="attachment-chip-icon">{attachment.data ? "▧" : "▤"}</span>
                    <span className="attachment-chip-name" title={attachment.name}>
                      {attachment.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(attachment.id)}
                      aria-label={`Remove ${attachment.name}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="Ask anything, or tell me what you're working on..."
              rows={1}
              disabled={!workspaceLoaded || streaming}
              aria-label="Message"
            />
            <div className="composer-footer">
              <span className="composer-hint">A little curiosity goes a long way.</span>
              <div className="composer-controls">
                <button
                  className="attach-button"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!workspaceLoaded || streaming}
                  aria-label="Attach files"
                  title="Attach files"
                >
                  ＋
                </button>
                <span className="enter-hint">↵ <span>to send</span></span>
                <button
                  className="send-button"
                  type="submit"
                  disabled={!workspaceLoaded || (!draft.trim() && attachments.length === 0) || streaming}
                  aria-label="Send message"
                >
                  ↑
                </button>
              </div>
            </div>
          </form>
          <p className="disclaimer">AI can make mistakes. Check important information.</p>
        </div>
      </section>
      </div>

      {error && (
        <div className="error-toast" role="alert">
          <span className="toast-icon">!</span>
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="Dismiss error">×</button>
        </div>
      )}

      {settingsOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
        >
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <button
              className="modal-close"
              onClick={() => setSettingsOpen(false)}
              aria-label="Close settings"
            >
              ×
            </button>
            <div className="modal-icon">⚙</div>
            <p className="modal-eyebrow">PERSONALIZE YOUR WORKSPACE</p>
            <h2 id="settings-title">Gemini settings</h2>
            <p className="modal-description">
              Add your Gemini API key and choose a model. Your key is saved only in this browser
              and sent to the local proxy with each request.
            </p>
            <form onSubmit={saveApiKey}>
              <label className="field-label" htmlFor="api-key">Gemini API key</label>
              <input
                id="api-key"
                type="password"
                value={keyDraft}
                onChange={(event) => setKeyDraft(event.target.value)}
                placeholder="Enter your Gemini API key"
                autoComplete="off"
                autoFocus
              />
              <label className="field-label model-field-label" htmlFor="gemini-model">Model</label>
              <select
                id="gemini-model"
                value={modelDraft}
                onChange={(event) => setModelDraft(event.target.value)}
              >
                {MODEL_OPTIONS.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
              <div className="modal-actions">
                {apiKey && (
                  <button
                    className="remove-key-button"
                    type="button"
                    onClick={() => {
                      localStorage.removeItem(API_KEY_STORAGE_KEY);
                      setApiKey("");
                      setKeyDraft("");
                    }}
                  >
                    Remove key
                  </button>
                )}
                <button
                  className="save-key-button"
                  type="submit"
                  disabled={!keyDraft.trim() || !modelDraft.trim()}
                >
                  Save settings <span>→</span>
                </button>
              </div>
            </form>
            <div className="security-note"><span>▣</span> Your key stays private and is never stored on a server.</div>
          </section>
        </div>
      )}
    </main>
  );
}

function toGeminiContents(messages: Message[]): GeminiContent[] {
  const result: GeminiContent[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const parts: Part[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const attachment of message.attachments ?? []) {
        if (attachment.text !== undefined) {
          parts.push({ text: `File: ${attachment.name}\n${attachment.text}` });
        } else if (attachment.data) {
          parts.push({
            inlineData: { mimeType: attachment.mimeType, data: attachment.data },
          });
        }
      }
      if (parts.length) result.push({ role: "user", parts });
      continue;
    }

    if (message.history?.length) {
      result.push(...message.history);
    } else if (message.content) {
      result.push({ role: "model", parts: [{ text: message.content }] });
    }
  }
  return result;
}

function createConversation(): Conversation {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function createWorkspace(): WorkspaceState {
  const firstConversation = createConversation();
  return {
    conversations: [firstConversation],
    activeConversationId: firstConversation.id,
  };
}

function createConversationTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 38 ? `${normalized.slice(0, 38).trimEnd()}…` : normalized || "New chat";
}

function matchesConversation(conversation: Conversation, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return (
    conversation.title.toLowerCase().includes(normalizedQuery) ||
    conversation.messages.some(
      (message) =>
        message.content.toLowerCase().includes(normalizedQuery) ||
        message.attachments?.some((attachment) =>
          attachment.name.toLowerCase().includes(normalizedQuery),
        ),
    )
  );
}

function conversationToMarkdown(conversation: Conversation): string {
  const output = [
    `# ${conversation.title}`,
    "",
    `Created: ${new Date(conversation.createdAt).toLocaleString()}`,
    "",
  ];

  for (const message of conversation.messages) {
    if (!message.content.trim() && !message.attachments?.length) continue;
    output.push(`## ${message.role === "user" ? "You" : "Assistant"}`, "");
    if (message.content.trim()) output.push(message.content.trim(), "");
    if (message.role === "user" && message.attachments?.length) {
      output.push(
        `Attachments: ${message.attachments.map((attachment) => attachment.name).join(", ")}`,
        "",
      );
    }
  }
  return `${output.join("\n").trimEnd()}\n`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function readAttachment(file: File): Promise<Attachment> {
  if (file.size > MAX_ATTACHMENT_SIZE) {
    throw new Error(`${file.name} is larger than the 8 MB per-file limit.`);
  }

  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = file.type || (extension === "pdf" ? "application/pdf" : "");
  const textFile =
    mimeType.startsWith("text/") ||
    ["application/json", "application/javascript", "application/xml"].includes(mimeType) ||
    /\.(txt|md|csv|json|js|jsx|ts|tsx|py|html|css|xml|yaml|yml|toml|sh|ps1|sql|log)$/i.test(file.name);

  if (textFile) {
    if (file.size > 1024 * 1024) {
      throw new Error(`${file.name} is larger than the 1 MB text-file limit.`);
    }
    return {
      id: crypto.randomUUID(),
      name: file.name,
      mimeType: mimeType || "text/plain",
      size: file.size,
      text: await file.text(),
    };
  }

  if (!mimeType.startsWith("image/") && mimeType !== "application/pdf") {
    throw new Error(`${file.name} is not a supported image, PDF, or text file.`);
  }

  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error(`Could not read ${file.name}.`));
        return;
      }
      const comma = reader.result.indexOf(",");
      if (comma < 0) {
        reject(new Error(`Could not encode ${file.name}.`));
        return;
      }
      resolve(reader.result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });

  return {
    id: crypto.randomUUID(),
    name: file.name,
    mimeType,
    size: file.size,
    data,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (!isRecord(value) || !Array.isArray(value.conversations)) return false;
  return (
    typeof value.activeConversationId === "string" &&
    value.conversations.every(
      (conversation) =>
        isRecord(conversation) &&
        typeof conversation.id === "string" &&
        typeof conversation.title === "string" &&
        typeof conversation.createdAt === "number" &&
        typeof conversation.updatedAt === "number" &&
        Array.isArray(conversation.messages) &&
        conversation.messages.every(
          (message) =>
            isRecord(message) &&
            (message.role === "user" || message.role === "assistant") &&
            typeof message.content === "string",
        ),
    ) &&
    value.conversations.some(
      (conversation) => isRecord(conversation) && conversation.id === value.activeConversationId,
    )
  );
}

function openWorkspaceDatabase(): Promise<IDBDatabase> {
  if (workspaceDatabase) return workspaceDatabase;
  const requestPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(WORKSPACE_STORE)) {
        request.result.createObjectStore(WORKSPACE_STORE);
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        workspaceDatabase = null;
      };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open conversation storage."));
    request.onblocked = () => reject(new Error("Conversation storage upgrade is blocked."));
  });
  workspaceDatabase = requestPromise;
  void requestPromise.catch(() => {
    if (workspaceDatabase === requestPromise) workspaceDatabase = null;
  });
  return requestPromise;
}

async function loadWorkspace(): Promise<WorkspaceState | null> {
  const database = await openWorkspaceDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(WORKSPACE_STORE, "readonly");
    const request = transaction.objectStore(WORKSPACE_STORE).get(WORKSPACE_KEY);
    request.onsuccess = () => {
      const value: unknown = request.result;
      if (value === undefined) {
        resolve(null);
      } else if (isWorkspaceState(value)) {
        resolve(value);
      } else {
        reject(new Error("Saved conversation data is invalid."));
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Could not load conversations."));
  });
}

async function saveWorkspace(workspace: WorkspaceState): Promise<void> {
  const database = await openWorkspaceDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(WORKSPACE_STORE, "readwrite");
    transaction.objectStore(WORKSPACE_STORE).put(workspace, WORKSPACE_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save conversations."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Saving conversations was interrupted."));
  });
}

function ToolCallCard({ toolCall }: { toolCall: ToolCard }) {
  const title = toolCall.name.replace(/_/g, " ");
  const failed = toolCall.result?.startsWith("Tool error:") ?? false;
  return (
    <section
      className={`tool-card ${toolCall.result === undefined ? "running" : failed ? "failed" : "complete"}`}
    >
      <div className="tool-card-heading">
        <span className="tool-card-icon">⌘</span>
        <span className="tool-card-title">{title}</span>
        <span className="tool-card-status">
          {toolCall.result === undefined ? "Running" : failed ? "Failed" : "Complete"}
        </span>
      </div>
      <div className="tool-card-detail">
        <span>INPUT</span>
        <code>{JSON.stringify(toolCall.arguments)}</code>
      </div>
      {toolCall.result !== undefined && (
        <div className="tool-card-detail">
          <span>OUTPUT</span>
          <code>{toolCall.result}</code>
        </div>
      )}
    </section>
  );
}
