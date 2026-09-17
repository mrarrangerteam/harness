// src/tui.ts
// Minimal terminal interface â single-line input + streaming output + Ctrl+C interruption.
// It has no differential renderer, component tree, or Markdown rendering.
// Those belong to a terminal UI framework; they are not the essence of building an agent from scratch.

import * as readline from "readline";

export class Tui {
  private rl: readline.Interface | null = null;
  private onPromptCb: ((text: string) => void) | null = null;
  private onAbortCb: (() => void) | null = null;
  private aborted = false;
  private busy = false; // true while the agent is running, preventing concurrent input

  /** Register the prompt callback */
  onPrompt(cb: (text: string) => void): void {
    this.onPromptCb = cb;
  }

  /** Register the Ctrl+C callback */
  onAbort(cb: () => void): void {
    this.onAbortCb = cb;
  }

  /** Start the TUI and begin reading input */
  start(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    process.stdin.on(
      "keypress",
      (_ch: string, key: { ctrl?: boolean; name?: string } | undefined) => {
        // Handle Ctrl+C only while the agent is running; when idle, leave it to readline's default behavior
        if (this.busy && key?.ctrl && key?.name === "c" && !this.aborted) {
          this.aborted = true;
          this.onAbortCb?.();
        }
      },
    );

    this.prompt();
  }
  private prompt(): void {
    if (!this.rl) return;
    if (this.busy) return; // Do not show a prompt while the agent is running
    this.aborted = false;
    this.rl.question("> ", (answer) => {
      const text = answer.trim();
      if (text) {
        this.onPromptCb?.(text);
        // Do not call prompt() recursively yet; wait for setBusy(false)
      } else {
        this.prompt(); // Empty input: prompt again without invoking the callback
      }
    });
  }

  /** Called when the agent starts running to prevent new input */
  setBusy(busy: boolean): void {
    this.busy = busy;
    if (!busy) this.prompt(); // Restore input when the agent finishes
  }

  /** Print a streamed assistant text delta */
  printText(delta: string): void {
    process.stdout.write(delta);
  }

  /** Print a tool call */
  printToolCall(name: string, args: unknown): void {
    process.stdout.write(`\n[tool: ${name}] ${JSON.stringify(args)}\n`);
  }

  /** Print a tool result */
  printToolResult(name: string, result: string): void {
    process.stdout.write(`[result: ${name}] ${result}\n`);
  }

  /** End the turn with a newline */
  printTurnEnd(): void {
    process.stdout.write("\n");
  }

  /** Stop the TUI and remove listeners */
  stop(): void {
    this.rl?.close();
    this.rl = null;
    process.stdin.removeAllListeners("keypress");
  }
}
