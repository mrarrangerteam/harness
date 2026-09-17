// src/tools.ts
// Four built-in toolsâthe minimum set needed to read, write, and edit code and run verification.
// Each tool is an async function returning a string; it has side effects but does not access agent state.
// Note: this teaching version does not validate args; a production agent should validate parameters before execute.

import { promises as fs } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentTool } from "./agent.js";

const execAsync = promisify(exec);

/** Tool-output truncation limit in lines; longer output is reduced to its tail with a notice */
const MAX_OUTPUT_LINES = 200;

let truncateCounter = 0;

/**
 * Truncate tool output: when it exceeds maxLines, keep only the tail and store the complete output in a temporary file.
 * Prefer the tail because errors usually appear at the end.
 */
async function truncateOutput(
  content: string,
  maxLines = MAX_OUTPUT_LINES,
): Promise<string> {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;
  const kept = lines.slice(-maxLines).join("\n");
  const tmpPath = path.join(
    os.tmpdir(),
    `nanopi-output-${process.pid}-${truncateCounter++}.txt`,
  );
  await fs.writeFile(tmpPath, content, "utf-8");
  return `[output truncated: showing last ${maxLines} of ${lines.length} lines. full output: ${tmpPath}]\n${kept}`;
}

/** read_file: return file contents (keep only the tail of oversized output) */
const readFile: AgentTool = {
  name: "read_file",
  description: "Read file contents. Parameter: path (file path). Large files are truncated to the last 200 lines.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file to read" },
    },
    required: ["path"],
  },
  execute: async (args) => {
    const { path: filePath } = args as { path: string };
    const content = await fs.readFile(filePath, "utf-8");
    return await truncateOutput(content);
  },
};

/** write_file: overwrite a file */
const writeFile: AgentTool = {
  name: "write_file",
  description: "Write a file (overwrite). Parameters: path (file path), content (file contents)",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file to write" },
      content: { type: "string", description: "File contents" },
    },
    required: ["path", "content"],
  },
  execute: async (args) => {
    const { path: filePath, content } = args as {
      path: string;
      content: string;
    };
    await fs.mkdir(path.dirname(filePath) || ".", { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
    return `wrote ${filePath} (${content.length} chars)`;
  },
};

/** edit: replace an exact substring (exact matching with uniqueness validation) */
const edit: AgentTool = {
  name: "edit",
  description:
    "Edit a file by replacing an exact substring. Parameters: path, old_string, new_string. old_string must match exactly once, or the operation fails.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      old_string: {
        type: "string",
        description: "Text to replace (must match exactly once)",
      },
      new_string: { type: "string", description: "Replacement text" },
    },
    required: ["path", "old_string", "new_string"],
  },
  execute: async (args) => {
    const {
      path: filePath,
      old_string,
      new_string,
    } = args as { path: string; old_string: string; new_string: string };
    const content = await fs.readFile(filePath, "utf-8");
    const count = content.split(old_string).length - 1;
    if (count === 0) throw new Error(`old_string not found in ${filePath}`);
    if (count > 1)
      throw new Error(
        `old_string matches ${count} places in ${filePath}, must be unique`,
      );
    // Use a replacement function so String.replace does not interpret special $ tokens in new_string ($& $` $' $1)
    const newContent = content.replace(old_string, () => new_string);
    await fs.writeFile(filePath, newContent, "utf-8");
    return `edited ${filePath}: replaced ${old_string.length} chars`;
  },
};

/** run_bash: execute a shell command (keep only the tail of oversized output) */
const runBash: AgentTool = {
  name: "run_bash",
  description:
    "Execute a shell command. Parameter: command (command string). Returns stdout+stderr, truncated to the last 200 lines.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
    },
    required: ["command"],
  },
  execute: async (args, signal) => {
    const { command } = args as { command: string };
    try {
      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: 1024 * 1024,
        timeout: 30000,
        signal,
      });
      const output = stderr ? `[stderr] ${stderr}\n[stdout] ${stdout}` : stdout;
      return await truncateOutput(output);
    } catch (e: unknown) {
      if (signal?.aborted) return "aborted";
      const err = e as NodeJS.ErrnoException & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      return `[exit ${err.code}] ${err.stderr ?? ""}${err.stdout ?? ""}`;
    }
  },
};

/** Return all built-in tools */
export function builtinTools(): AgentTool[] {
  return [readFile, writeFile, edit, runBash];
}
