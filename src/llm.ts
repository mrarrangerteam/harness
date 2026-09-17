// src/llm.ts
// Unified LLM API â parses OpenAI Completions SSE responses into four event types.
// This teaching version supports only the OpenAI-compatible format (also supported by GLM, DeepSeek, Ollama, and others).

// ===== Types =====

/** Model configuration */
export type Model = {
  apiKey: string;
  model: string; // For example, "gpt-4o" or "glm-5.2"
  baseUrl?: string; // Defaults to https://api.openai.com/v1
  maxTokens?: number; // If unset, the API chooses the default (cli.ts sets it to 4096)
};

/**
 * Content block: a structured unit of message content.
 * Note: tool_result is placed in a ContentBlock inside a user message;
 * in pi it is a separate ToolResultMessage type, while nanopi simplifies this into one structure.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

/** Message: user and assistant share the same structure */
export type Message = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

/** Context: plain JSON that can be stringified and persisted */
export type Context = {
  systemPrompt?: string;
  messages: Message[];
};

/** Stream events: the llm module's unified external output */
export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | {
      type: "done";
      stopReason: "end_turn" | "tool_use" | "max_tokens" | "aborted";
    }
  | { type: "error"; error: Error };

/** Tool definition format passed in by the agent module */
export type ToolDef = {
  name: string;
  description: string;
  parameters: object;
};

// ===== Helper functions =====

/**
 * Convert nanopi Context into the OpenAI messages format.
 * This is a pure conversion function with no network logic.
 */
export function contextToOpenAIMessages(context: Context): object[] {
  const messages: object[] = [];
  if (context.systemPrompt)
    messages.push({ role: "system", content: context.systemPrompt });

  for (const msg of context.messages) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    const blocks = msg.content;
    if (msg.role === "assistant") {
      const toolCalls: object[] = [];
      let text = "";
      for (const b of blocks) {
        if (b.type === "text") text += b.text;
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          });
        }
      }
      // OpenAI requires an assistant message to have non-null content or tool_calls.
      // For a tool_call-only message, content is null; if both are empty (such as a contentless turn after abort/error), use an empty string to avoid an API 400 response.
      const content = text || (toolCalls.length ? null : "");
      messages.push({
        role: "assistant",
        content,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      });
    } else {
      // A tool_result block in a user message â OpenAI requires a separate role:tool message
      for (const b of blocks) {
        if (b.type === "tool_result") {
          messages.push({
            role: "tool",
            tool_call_id: b.tool_use_id,
            content: b.content,
          });
        } else if (b.type === "text") {
          messages.push({ role: "user", content: b.text });
        }
      }
    }
  }
  return messages;
}

/** Minimal type for an OpenAI SSE chunk */
type OpenAIChunk = {
  choices: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
};

/** Parse one SSE data line, accumulate tool_calls, and return text_delta and stop_reason */
function handleSSELine(
  data: string,
  toolCallBuffers: Map<number, { id: string; name: string; argsBuf: string }>,
): {
  textDelta: string | null;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | null;
} {
  let chunk: OpenAIChunk;
  try {
    chunk = JSON.parse(data) as OpenAIChunk;
  } catch {
    return { textDelta: null, stopReason: null };
  }

  const choice = chunk.choices[0];
  if (!choice) return { textDelta: null, stopReason: null };

  let textDelta: string | null = null;
  let stopReason: "end_turn" | "tool_use" | "max_tokens" | null = null;

  if (choice.delta?.content) textDelta = choice.delta.content;

  // tool_call delta: accumulate partial JSON for name + arguments by index
  if (choice.delta?.tool_calls) {
    for (const tc of choice.delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!toolCallBuffers.has(idx)) {
        toolCallBuffers.set(idx, {
          id: tc.id ?? `call_${idx}`,
          name: "",
          argsBuf: "",
        });
      }
      const entry = toolCallBuffers.get(idx)!;
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.name = tc.function.name;
      if (tc.function?.arguments) entry.argsBuf += tc.function.arguments;
    }
  }

  // finish_reason mapping: tool_calls â tool_use, length â max_tokens, stop â end_turn (default)
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";

  return { textDelta, stopReason };
}

/** At stream end, emit accumulated tool_calls in order */
function flushToolCalls(
  toolCallBuffers: Map<number, { id: string; name: string; argsBuf: string }>,
): { id: string; name: string; args: unknown }[] {
  const calls: { id: string; name: string; args: unknown }[] = [];
  for (const [, tc] of [...toolCallBuffers].sort((a, b) => a[0] - b[0])) {
    let args: unknown = {};
    if (tc.argsBuf) {
      try {
        args = JSON.parse(tc.argsBuf);
      } catch {
        args = {};
      }
    }
    calls.push({ id: tc.id, name: tc.name, args });
  }
  return calls;
}

// ===== stream function =====

/**
 * Call the OpenAI Completions API (streaming) and return a unified event stream.
 *
 * @param model    Model configuration
 * @param context  Conversation context
 * @param opts     Tools + abort signal
 */
export async function* stream(
  model: Model,
  context: Context,
  opts: { tools?: ToolDef[]; signal?: AbortSignal } = {},
): AsyncGenerator<StreamEvent> {
  const url = `${model.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`;
  const messages = contextToOpenAIMessages(context);

  const body: Record<string, unknown> = {
    model: model.model,
    stream: true,
    messages,
  };
  if (model.maxTokens) body.max_tokens = model.maxTokens;
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  // Send the request
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) {
      yield { type: "done", stopReason: "aborted" };
      return;
    }
    yield { type: "error", error: e as Error };
    return;
  }

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "unknown error");
    yield {
      type: "error",
      error: new Error(`API ${response.status}: ${text}`),
    };
    return;
  }

  // Parse SSE line by line
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";
  const toolCallBuffers = new Map<
    number,
    { id: string; name: string; argsBuf: string }
  >();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;

        const result = handleSSELine(data, toolCallBuffers);
        if (result.textDelta)
          yield { type: "text_delta", delta: result.textDelta };
        if (result.stopReason) stopReason = result.stopReason;
      }
    }
  } catch (e) {
    if (opts.signal?.aborted) {
      yield { type: "done", stopReason: "aborted" };
      return;
    }
    yield { type: "error", error: e as Error };
    return;
  }

  // Emit accumulated tool_calls
  for (const tc of flushToolCalls(toolCallBuffers)) {
    yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };
  }
  yield {
    type: "done",
    stopReason: opts.signal?.aborted ? "aborted" : stopReason,
  };
}

// ===== Message construction helpers =====

/** Accumulate events from one streamed turn into an assistant message */
export function buildAssistantMessage(
  text: string,
  toolCalls: { id: string; name: string; args: unknown }[],
): Message {
  const content: ContentBlock[] = [];
  if (text) content.push({ type: "text", text });
  for (const tc of toolCalls) {
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input: tc.args,
    });
  }
  return { role: "assistant", content };
}

/** Construct a tool_result user message */
export function buildToolResultMessage(
  results: { tool_use_id: string; content: string }[],
): Message {
  return {
    role: "user",
    content: results.map((r) => ({
      type: "tool_result" as const,
      tool_use_id: r.tool_use_id,
      content: r.content,
    })),
  };
}
