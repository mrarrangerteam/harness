// src/cli.ts
// Wiring layer â connects llm / agent / tui / tools and serves as the sole entry point.
// Session persistence: append context.messages to ~/.nanopi/session.jsonl after each turn.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runAgent } from "./agent.js";
import { Tui } from "./tui.js";
import { builtinTools } from "./tools.js";
import type { Model, Context, Message } from "./llm.js";

const SESSION_DIR = path.join(os.homedir(), ".nanopi");
const SESSION_FILE = path.join(SESSION_DIR, "session.jsonl");

/** Fixed system prompt */
const SYSTEM_PROMPT =
  "You are a coding assistant. Use the provided tools to read and write files and execute commands to complete tasks. Read before making changes, and run commands afterward to verify them.";

// Track the number of persisted messages and append only new ones.
// This is CLI process-level state (not agent stateâthe agent itself is stateless; context is the state).
let persistedCount = 0;

async function main() {
  const apiKey = process.env.NANOPI_API_KEY;
  if (!apiKey) {
    console.error("Set the NANOPI_API_KEY environment variable");
    process.exit(1);
  }

  const model: Model = {
    apiKey,
    model: process.env.NANOPI_MODEL ?? "glm-5.2",
    baseUrl: process.env.NANOPI_BASE_URL ?? "https://api.openai.com/v1",
    maxTokens: 4096,
  };

  // Initialize context: use the dedicated system prompt field and load messages from the session file
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: await loadSession(),
  };

  const tools = builtinTools();
  const tui = new Tui();

  // Each turn: user input â runAgent â forward events to the TUI â persist
  tui.onPrompt(async (text) => {
    try {
      context.messages.push({ role: "user", content: text });

      tui.setBusy(true);
      const ctrl = new AbortController();
      tui.onAbort(() => ctrl.abort()); // Create a new AbortController each turn and re-register the callback to point to it

      for await (const ev of runAgent(model, context, tools, ctrl.signal)) {
        switch (ev.type) {
          case "assistant_text":
            tui.printText(ev.delta);
            break;
          case "tool_call":
            tui.printToolCall(ev.name, ev.args);
            break;
          case "tool_result":
            tui.printToolResult(ev.name, ev.result);
            break;
          case "turn_end":
            if (ev.stopReason === "max_tokens")
              tui.printText("\n[output truncated by max_tokens]");
            if (ev.stopReason === "error") tui.printText("\n[error occurred]");
            tui.printTurnEnd();
            break;
        }
      }

      await persistSession(context.messages);
    } catch (e) {
      console.error(`\n[error] ${(e as Error).message}`);
    } finally {
      tui.setBusy(false);
    }
  });

  tui.start();
}

/** Load message history at startup to restore the previous conversation (exported for tests) */
export async function loadSession(
  file: string = SESSION_FILE,
): Promise<Message[]> {
  try {
    const data = await fs.readFile(file, "utf-8");
    const lines = data.trim().split("\n").filter(Boolean);
    // Recover line by line: skip corrupt lines instead of discarding all history (a crash may leave a partial JSON line)
    const messages = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as Message];
      } catch {
        return [];
      }
    });
    persistedCount = messages.length; // Do not rewrite messages that were already loaded
    return messages;
  } catch {
    return []; // File does not exist; start empty
  }
}

/** Persist messages to the session file (exported for tests) */
export async function persistSession(
  messages: Message[],
  file: string = SESSION_FILE,
): Promise<void> {
  await fs.mkdir(path.dirname(file) || ".", { recursive: true });
  const newMessages = messages.slice(persistedCount);
  for (const msg of newMessages) {
    await fs.appendFile(file, JSON.stringify(msg) + "\n", "utf-8");
  }
  persistedCount = messages.length;
}

// Start only when run directly (not when imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
