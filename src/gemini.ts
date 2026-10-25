import { GoogleGenAI, ThinkingLevel, Type, type FunctionDeclaration, type Part } from "@google/genai";

export type GeminiContent = {
  role: "user" | "model";
  parts: Part[];
};

export type GeminiToolCall = {
  id: string;
  functionCallId?: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type GeminiAgentEvent =
  | { type: "text"; content: string }
  | { type: "history"; contents: GeminiContent[] }
  | { type: "tool_start"; toolCall: GeminiToolCall }
  | { type: "tool_result"; id: string; result: string }
  | { type: "done" };

type LocalNote = {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

const NOTES_STORAGE_KEY = "devxanai-notes";
const MAX_AGENT_ITERATIONS = 10;

const toolDeclarations: FunctionDeclaration[] = [
  {
    name: "calculate",
    description:
      "Evaluate a basic arithmetic expression using numbers and +, -, *, /, %, and parentheses.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        expression: { type: Type.STRING, description: "The arithmetic expression to evaluate." },
      },
      required: ["expression"],
    },
  },
  {
    name: "get_current_datetime",
    description: "Get the current date and time in ISO 8601 format.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "add_note",
    description: "Save a note in this browser.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: "A short title for the note." },
        content: { type: Type.STRING, description: "The note text to save." },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "list_notes",
    description: "List all notes saved in this browser.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "search_notes",
    description: "Search saved notes by matching their title or content.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Text to search for in saved notes." },
      },
      required: ["query"],
    },
  },
  {
    name: "delete_note",
    description: "Delete a saved note by its note ID.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.STRING, description: "The ID of the note to delete." },
      },
      required: ["id"],
    },
  },
];

export async function* streamGeminiAgent(
  apiKey: string,
  model: string,
  contents: GeminiContent[],
  signal: AbortSignal,
): AsyncGenerator<GeminiAgentEvent> {
  const ai = new GoogleGenAI({ apiKey });
  const conversation = [...contents];

  for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration += 1) {
    if (signal.aborted) return;
    const stream = await ai.models.generateContentStream({
      model,
      contents: conversation,
      config: {
        abortSignal: signal,
        tools: [{ functionDeclarations: toolDeclarations }],
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });

    const modelParts: Part[] = [];
    const toolCalls = new Map<string, GeminiToolCall>();
    let anonymousCall = 0;

    for await (const chunk of stream) {
      if (signal.aborted) return;
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        modelParts.push(part);
        if (typeof part.text === "string") {
          yield { type: "text", content: part.text };
        }

        const functionCall = part.functionCall;
        if (!functionCall?.name) continue;
        const functionCallId = functionCall.id;
        const id = functionCallId || `${functionCall.name}-${anonymousCall++}`;
        toolCalls.set(id, {
          id,
          functionCallId,
          name: functionCall.name,
          arguments: isRecord(functionCall.args) ? functionCall.args : {},
        });
      }
    }

    if (signal.aborted) return;
    const modelContent: GeminiContent = { role: "model", parts: modelParts };
    conversation.push(modelContent);

    if (toolCalls.size === 0) {
      yield { type: "history", contents: [modelContent] };
      yield { type: "done" };
      return;
    }

    const functionResponseParts: Part[] = [];
    for (const toolCall of toolCalls.values()) {
      yield { type: "tool_start", toolCall };
      const result = runLocalTool(toolCall.name, toolCall.arguments);
      yield { type: "tool_result", id: toolCall.id, result };
      functionResponseParts.push({
        functionResponse: {
          ...(toolCall.functionCallId ? { id: toolCall.functionCallId } : {}),
          name: toolCall.name,
          response: { result },
        },
      });
    }

    const functionResponseContent: GeminiContent = {
      role: "user",
      parts: functionResponseParts,
    };
    conversation.push(functionResponseContent);
    yield { type: "history", contents: [modelContent, functionResponseContent] };
  }

  throw new Error(`The assistant reached the ${MAX_AGENT_ITERATIONS}-iteration tool-call limit.`);
}

function runLocalTool(name: string, args: Record<string, unknown>): string {
  try {
    switch (name) {
      case "calculate":
        if (typeof args.expression !== "string") throw new Error("Provide an expression.");
        return String(calculate(args.expression));
      case "get_current_datetime":
        return new Date().toISOString();
      case "add_note":
        if (typeof args.title !== "string" || typeof args.content !== "string") {
          throw new Error("Provide a title and note content.");
        }
        return saveNote(args.title, args.content);
      case "list_notes":
        return serializeNotes(readNotes());
      case "search_notes": {
        if (typeof args.query !== "string") throw new Error("Provide a search query.");
        const query = args.query.trim().toLocaleLowerCase();
        const results = readNotes().filter(
          (note) =>
            note.title.toLocaleLowerCase().includes(query) ||
            note.content.toLocaleLowerCase().includes(query),
        );
        return serializeNotes(results);
      }
      case "delete_note":
        if (typeof args.id !== "string") throw new Error("Provide the note ID.");
        return deleteNote(args.id);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool execution failed.";
    return `Tool error: ${message}`;
  }
}

function readNotes(): LocalNote[] {
  const saved = localStorage.getItem(NOTES_STORAGE_KEY);
  if (!saved) return [];
  const notes: unknown = JSON.parse(saved);
  if (
    !Array.isArray(notes) ||
    !notes.every(
      (note) =>
        isRecord(note) &&
        typeof note.id === "string" &&
        typeof note.title === "string" &&
        typeof note.content === "string" &&
        typeof note.createdAt === "string" &&
        typeof note.updatedAt === "string",
    )
  ) {
    throw new Error("Saved notes are invalid.");
  }
  return notes;
}

function saveNote(title: string, content: string): string {
  const notes = readNotes();
  const now = new Date().toISOString();
  const note: LocalNote = {
    id: crypto.randomUUID(),
    title: title.trim(),
    content,
    createdAt: now,
    updatedAt: now,
  };
  if (!note.title || !note.content.trim()) throw new Error("Note title and content cannot be empty.");
  localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify([note, ...notes]));
  return JSON.stringify(note);
}

function deleteNote(id: string): string {
  const notes = readNotes();
  const remaining = notes.filter((note) => note.id !== id);
  if (remaining.length === notes.length) return `No note found with ID ${id}.`;
  localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(remaining));
  return `Deleted note ${id}.`;
}

function serializeNotes(notes: LocalNote[]): string {
  return notes.length ? JSON.stringify(notes) : "No notes saved.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function calculate(expression: string): number {
  if (expression.length > 256) throw new Error("The expression is too long to evaluate.");
  const tokens = expression.match(/\d+(?:\.\d+)?|[()+\-*/%]/g);
  if (!tokens || tokens.join("") !== expression.replace(/\s+/g, "")) {
    throw new Error("Only numbers, parentheses, and +, -, *, /, % are supported.");
  }

  let position = 0;
  const parsePrimary = (): number => {
    const token = tokens[position++];
    if (token === "+" || token === "-") {
      const value = parsePrimary();
      return token === "-" ? -value : value;
    }
    if (token === "(") {
      const value = parseExpression();
      if (tokens[position++] !== ")") throw new Error("Missing closing parenthesis.");
      return value;
    }
    if (!token || !/^\d+(?:\.\d+)?$/.test(token)) {
      throw new Error("Invalid arithmetic expression.");
    }
    return Number(token);
  };
  const parseTerm = (): number => {
    let value = parsePrimary();
    while (["*", "/", "%"].includes(tokens[position] ?? "")) {
      const operator = tokens[position++];
      const right = parsePrimary();
      if ((operator === "/" || operator === "%") && right === 0) {
        throw new Error("Division by zero is not allowed.");
      }
      if (operator === "*") value *= right;
      else if (operator === "/") value /= right;
      else value %= right;
    }
    return value;
  };
  const parseExpression = (): number => {
    let value = parseTerm();
    while (tokens[position] === "+" || tokens[position] === "-") {
      const operator = tokens[position++];
      const right = parseTerm();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  };

  const result = parseExpression();
  if (position !== tokens.length || !Number.isFinite(result)) {
    throw new Error("Invalid arithmetic expression.");
  }
  return result;
}
