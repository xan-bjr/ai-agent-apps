# Devxanai

A static, browser-based Gemini chat workspace. Gemini streaming, the agent loop, and its tools run in the browser; conversations and notes are stored locally.

## Requirements

- Node.js 20 or newer
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

## Run locally

```powershell
npm install
npm run dev
```

Open the local URL printed by Vite, then use **Settings** to enter your Gemini API key and choose a model. The key is saved in this browser's local storage and used by the browser to call Gemini directly. It is not included in the source or logged by the app. Because requests are made from the browser, restrict the key in Google AI Studio and do not use this setup for a shared or untrusted machine.

## Build and publish

Create the static site in `dist`:

```powershell
npm run build
```

The Vite base path is configured as `/ai-agent-app/` for GitHub Pages. To publish, push the project to a GitHub repository named `ai-agent-app`, then in the repository settings choose **Pages** and deploy from **GitHub Actions**. The `dist` folder is the complete static site; no server process or backend hosting is required.

## Browser features

- Conversations, attachments, and the API key are stored in this browser. Conversation history is persisted in IndexedDB; notes and settings are stored in local storage.
- Use the sidebar to start, search, rename, delete, and export conversations.
- Markdown export includes readable user/assistant text and attachment names, but not tool-call parts or Gemini thought signatures. JSON export preserves the stored conversation data.
- Attach up to five text, image, or PDF files to a message. Each file must be 8 MB or smaller; text files have a 1 MB limit, and total attachment size is capped at 12 MB per message.
- Stop a reply at any time. Light/dark themes and the mobile sidebar are supported.

## Local tools

The Gemini function declarations and implementations are in `src/gemini.ts`. Available tools run entirely in the browser:

- `calculate` evaluates basic arithmetic.
- `get_current_datetime` returns the current time as ISO 8601.
- `add_note`, `list_notes`, `search_notes`, and `delete_note` manage notes in local storage.

To add a tool, add its Gemini function declaration to `toolDeclarations` and implement its matching case in `runLocalTool` in `src/gemini.ts`. Validate the arguments, return a string result, and keep the operation local to the browser. The agent loop returns tool results to Gemini and the chat UI renders tool-call cards.
