// src/agent.ts
// Agent loop â the heart of the entire project: one while loop.
//
// Stream the LLM response â execute each tool_call â return results to Context â continue streaming
// until the model stops calling tools (end_turn / max_tokens) or is interrupted (aborted / error).
//
// Import stream directly instead of using dependency injection so learners can immediately see the LLM interaction point.
// pi uses StreamFn parameter injection to support interchangeable backends; this teaching version omits it.

import {
  stream,
  buildAssistantMessage,
  buildToolResultMessage,
  type Model,
  type Context,
} from "./llm.js";

/** Tool definition: name + description + JSON Schema parameters + execute function */
export type AgentTool = {
  name: string;
  description: string;
  parameters: object; // JSON Schema
  execute: (args: unknown, signal?: AbortSignal) => Promise<string>;
};

/** Agent event stream exposed for the UI to consume */
export type AgentEvent =
  | { type: "assistant_text"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; result: string }
  | {
      type: "turn_end";
      stopReason: "end_turn" | "max_tokens" | "aborted" | "error";
    };

/** Compaction threshold: compact older messages when the count reaches this value */
const COMPACT_THRESHOLD = 50;
/** Number of recent messages preserved during compaction */
const KEEP_RECENT = 20;

/**
 * Conversation compaction: when there are too many messages, have the LLM summarize the older messages and replace them with the summary.
 * This demonstrates a core agent capability: context is limited and must be compacted when full.
 * pi's implementation spans 970 lines for token estimates, cut-point boundaries, split turns, and more; this teaching version uses a simple message-count approximation.
 */
async function compactContext(
  model: Model,
  context: Context,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return; // Do not compact on abort; an empty summary could corrupt context
  if (context.messages.length < COMPACT_THRESHOLD) return;

  const oldMessages = context.messages.slice(0, -KEEP_RECENT);
  const recentMessages = context.messages.slice(-KEEP_RECENT);

  // Serialize older messages as plain text for the LLM to summarize
  const conversationText = oldMessages
    .map(
      (m) =>
        `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`,
    )
    .join("\n");

  // Collect a summary from the LLM stream without forwarding it to the UI
  const summaryContext: Context = {
    systemPrompt:
      "Summarize the following conversation into a concise context summary, preserving key decisions, completed work, and remaining tasks.",
    messages: [{ role: "user", content: conversationText }],
  };

  let summary = "";
  let failed = false;
  for await (const ev of stream(model, summaryContext, { signal })) {
    if (ev.type === "text_delta") summary += ev.delta;
    else if (
      ev.type === "error" ||
      (ev.type === "done" && ev.stopReason === "aborted")
    ) {
      failed = true;
      break;
    }
  }

  // Do not replace context if compaction fails; preserving the original messages is safer than an empty summary
  if (failed || !summary) return;

  // Replace older messages with the summary while preserving recent messages
  context.messages = [
    { role: "user", content: `[context summary]\n${summary}` },
    ...recentMessages,
  ];
}

/**
 * Run the agent loop. There is no max_stepsâthe loop runs until the model says to stop. pi likewise has no hard-coded step limit, but adds a shouldStopAfterTurn callback; this teaching version omits it.
 *
 * @param model    Model configuration
 * @param context  Conversation context (mutated in place)
 * @param tools    Tool registry
 * @param signal   Abort signal
 */
export async function* runAgent(
  model: Model,
  context: Context,
  tools: AgentTool[],
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const toolDefs = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  while (true) {
    // 0. Context compaction: compact older messages first when there are too many
    await compactContext(model, context, signal);

    // 1. Stream the LLM call and collect text and tool_calls
    let text = "";
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "aborted" =
      "end_turn";
    const toolCalls: { id: string; name: string; args: unknown }[] = [];

    for await (const ev of stream(model, context, {
      tools: toolDefs,
      signal,
    })) {
      if (ev.type === "text_delta") {
        text += ev.delta;
        yield { type: "assistant_text", delta: ev.delta };
      } else if (ev.type === "tool_call") {
        toolCalls.push({ id: ev.id, name: ev.name, args: ev.args });
        yield { type: "tool_call", id: ev.id, name: ev.name, args: ev.args };
      } else if (ev.type === "done") {
        stopReason = ev.stopReason;
        if (ev.stopReason === "aborted") {
          // Discard tool_calls on abort; without matching tool_result entries, the API would fail after session restoration
          context.messages.push(buildAssistantMessage(text, []));
          yield { type: "turn_end", stopReason: "aborted" };
          return;
        }
      } else if (ev.type === "error") {
        context.messages.push(buildAssistantMessage(text, []));
        yield {
          type: "assistant_text",
          delta: `\n[error] ${ev.error.message}`,
        };
        yield { type: "turn_end", stopReason: "error" };
        return;
      }
    }

    // 2. Add the assistant response to context
    context.messages.push(buildAssistantMessage(text, toolCalls));

    // 3. Handle truncation: tool args may be incomplete at max_tokens, so do not execute them; return an error to Context so the model can retry
    if (stopReason === "max_tokens" && toolCalls.length > 0) {
      const results = toolCalls.map((tc) => ({
        tool_use_id: tc.id,
        content: `error: output truncated by max_tokens, tool "${tc.name}" args may be incomplete.`,
      }));
      context.messages.push(buildToolResultMessage(results));
      for (let i = 0; i < toolCalls.length; i++) {
        yield {
          type: "tool_result",
          id: toolCalls[i].id,
          name: toolCalls[i].name,
          result: results[i].content,
        };
      }
      continue;
    }

    // 4. No tool_call â exit the loop
    // A malformed API response may report tool_use without a tool_call delta; treat it as a normal end
    const reason = stopReason === "tool_use" ? "end_turn" : stopReason;
    if (toolCalls.length === 0) {
      yield { type: "turn_end", stopReason: reason };
      return;
    }

    // 5. Execute tool_calls serially (pi supports sequential and parallel modes; this teaching version always uses serial execution)
    // Pass args directly to execute without validating against parameters (simplified for teaching; production code should validate first)
    const results: { tool_use_id: string; content: string }[] = [];
    for (const tc of toolCalls) {
      const tool = toolMap.get(tc.name);
      let result: string;
      if (!tool) {
        result = `error: tool "${tc.name}" not found`;
      } else {
        try {
          result = await tool.execute(tc.args, signal);
        } catch (e) {
          result = `error: ${(e as Error).message}`;
        }
      }
      results.push({ tool_use_id: tc.id, content: result });
      yield { type: "tool_result", id: tc.id, name: tc.name, result };
      if (signal?.aborted) break;
    }

    // 6. Add error results for tool_calls skipped due to abort (the API requires one tool_result for every tool_call)
    for (const tc of toolCalls.slice(results.length)) {
      results.push({ tool_use_id: tc.id, content: "error: aborted" });
      yield {
        type: "tool_result",
        id: tc.id,
        name: tc.name,
        result: "error: aborted",
      };
    }

    // 7. Return tool_result to Context and begin the next turn
    context.messages.push(buildToolResultMessage(results));
  }
}
