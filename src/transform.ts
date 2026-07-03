// Protocol transformation: Anthropic Messages API <-> OpenAI Chat Completions API
// Pure functions for testability. Handles tool_use/tool_result/tool_calls,
// images, cache_control markers, and SSE stream conversion.

// ---------------------------------------------------------------------------
// Request: Anthropic Messages -> OpenAI Chat Completions
// ---------------------------------------------------------------------------

export function transformRequestToOpenAI(body: any): any {
  const out: any = {};

  if (body.model !== undefined) out.model = body.model;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stream !== undefined) out.stream = body.stream;
  if (body.stop_sequence !== undefined) out.stop = body.stop_sequence;

  // max_tokens -> max_completion_tokens (keep max_tokens too for older endpoints)
  if (body.max_tokens !== undefined) {
    out.max_tokens = body.max_tokens;
    out.max_completion_tokens = body.max_tokens;
  }

  // system -> first message with role "system"
  const messages: any[] = [];
  if (body.system !== undefined) {
    const systemText = extractSystemText(body.system);
    if (systemText) {
      messages.push({ role: "system", content: systemText });
    }
  }

  // Convert messages
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      messages.push(...convertAnthropicMessageToOpenAI(msg));
    }
  }

  out.messages = messages;

  // tools -> OpenAI function tools
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map(convertAnthropicToolToOpenAI);
  }

  // tool_choice mapping
  if (body.tool_choice !== undefined) {
    out.tool_choice = convertToolChoiceToOpenAI(body.tool_choice);
  }

  return out;
}

function extractSystemText(system: any): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((s: any) => (typeof s === "string" ? s : s?.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function convertAnthropicMessageToOpenAI(msg: any): any[] {
  if (typeof msg.content === "string") {
    return [{ role: msg.role, content: msg.content }];
  }

  if (!Array.isArray(msg.content)) {
    return [{ role: msg.role, content: msg.content }];
  }

  const result: any[] = [];
  const textParts: string[] = [];
  const toolCalls: any[] = [];
  const toolResults: any[] = [];

  for (const block of msg.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {})
        }
      });
    } else if (block.type === "tool_result") {
      toolResults.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: extractToolResultContent(block.content)
      });
    } else if (block.type === "image") {
      // OpenAI image_url format
      const url = buildImageUrl(block.source);
      if (url) {
        textParts.push(""); // placeholder to signal content exists
        result.push({ role: msg.role, content: [{ type: "image_url", image_url: { url } }] });
      }
    } else if (block.type === "thinking") {
      // Skip thinking blocks - OpenAI doesn't support them in input
    }
  }

  // Tool results become separate messages
  for (const tr of toolResults) {
    result.push(tr);
  }

  // Build the main message with text and tool_calls
  const mainText = textParts.join("\n");
  if (toolCalls.length > 0) {
    const mainMsg: any = { role: msg.role };
    if (mainText) mainMsg.content = mainText;
    else mainMsg.content = null;
    mainMsg.tool_calls = toolCalls;
    result.push(mainMsg);
  } else if (mainText && result.length === 0) {
    result.push({ role: msg.role, content: mainText });
  } else if (mainText && result.length > 0 && result[result.length - 1].role === "tool") {
    // Text after tool results becomes a user message
    result.push({ role: msg.role, content: mainText });
  } else if (mainText) {
    result.push({ role: msg.role, content: mainText });
  }

  // Edge case: content array was empty or only thinking blocks
  if (result.length === 0) {
    result.push({ role: msg.role, content: "" });
  }

  return result;
}

function extractToolResultContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (typeof c === "string") return c;
        if (c.type === "text") return c.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") return content.text || "";
  return "";
}

function buildImageUrl(source: any): string | null {
  if (!source) return null;
  if (source.type === "base64") {
    const mediaType = source.media_type || "image/png";
    return `data:${mediaType};base64,${source.data}`;
  }
  if (source.type === "url") {
    return source.url;
  }
  return null;
}

function convertAnthropicToolToOpenAI(tool: any): any {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} }
    }
  };
}

function convertToolChoiceToOpenAI(choice: any): any {
  if (typeof choice === "string") {
    if (choice === "auto") return "auto";
    if (choice === "any") return "required";
    if (choice === "none") return "none";
    return choice;
  }
  if (choice && typeof choice === "object" && choice.type === "tool") {
    return {
      type: "function",
      function: { name: choice.name }
    };
  }
  return choice;
}

// ---------------------------------------------------------------------------
// Response: OpenAI Chat Completions -> Anthropic Messages (non-streaming)
// ---------------------------------------------------------------------------

export function transformResponseFromOpenAI(body: any, model: string): any {
  const choice = body.choices?.[0];
  const message = choice?.message || {};

  const content: any[] = [];

  // Reasoning content -> thinking block
  if (message.reasoning_content) {
    content.push({ type: "thinking", thinking: message.reasoning_content });
  }

  // Text content
  if (message.content) {
    content.push({ type: "text", text: message.content });
  }

  // Tool calls -> tool_use blocks
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let input: any = {};
      try {
        input = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function?.name,
        input
      });
    }
  }

  const stopReason = convertFinishReasonToStopReason(choice?.finish_reason);

  return {
    id: body.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: body.usage?.prompt_tokens || 0,
      output_tokens: body.usage?.completion_tokens || 0,
      cache_creation_input_tokens: body.usage?.cache_creation_input_tokens || 0,
      cache_read_input_tokens: body.usage?.cache_read_input_tokens || 0
    }
  };
}

function convertFinishReasonToStopReason(finishReason: string | undefined): string {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "end_turn";
    default:
      return "end_turn";
  }
}

// ---------------------------------------------------------------------------
// SSE Streaming: OpenAI Chat Completions SSE -> Anthropic Messages SSE
// ---------------------------------------------------------------------------

export class OpenAIToAnthropicSseTransformer {
  private messageStarted = false;
  private messageStopped = false;
  private currentBlockIndex = -1;
  private currentBlockType: string | null = null;
  private model: string;
  private messageId: string;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(model: string) {
    this.model = model;
    this.messageId = `msg_${Date.now()}`;
  }

  getUsage(): { inputTokens: number; outputTokens: number } {
    return { inputTokens: this.inputTokens, outputTokens: this.outputTokens };
  }

  // Convert one OpenAI SSE data line to Anthropic SSE event strings.
  // Returns array of fully formatted SSE event strings (each ending with \n\n).
  transformDataLine(data: string): string[] {
    if (data === "[DONE]") {
      return this.finishStream();
    }

    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      return [];
    }

    const events: string[] = [];
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    // Emit message_start on first chunk
    if (!this.messageStarted) {
      this.inputTokens = chunk.usage?.prompt_tokens || 0;
      events.push(this.formatEvent("message_start", {
        type: "message_start",
        message: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          content: [],
          model: this.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputTokens, output_tokens: 0 }
        }
      }));
      this.messageStarted = true;
    }

    if (!delta) {
      // Could be the final chunk with usage + finish_reason
      if (choice?.finish_reason) {
        events.push(...this.handleFinish(choice.finish_reason, chunk.usage));
      }
      return events;
    }

    // Text content delta
    if (delta.content) {
      if (this.currentBlockType !== "text") {
        if (this.currentBlockIndex >= 0) {
          events.push(this.formatEvent("content_block_stop", {
            type: "content_block_stop",
            index: this.currentBlockIndex
          }));
        }
        this.currentBlockIndex++;
        this.currentBlockType = "text";
        events.push(this.formatEvent("content_block_start", {
          type: "content_block_start",
          index: this.currentBlockIndex,
          content_block: { type: "text", text: "" }
        }));
      }
      events.push(this.formatEvent("content_block_delta", {
        type: "content_block_delta",
        index: this.currentBlockIndex,
        delta: { type: "text_delta", text: delta.content }
      }));
    }

    // Tool calls delta
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const tcIndex = tc.index ?? 0;

        if (tc.id || (tc.function?.name && this.currentBlockType !== "tool_use")) {
          // New tool call starts
          if (this.currentBlockIndex >= 0) {
            events.push(this.formatEvent("content_block_stop", {
              type: "content_block_stop",
              index: this.currentBlockIndex
            }));
          }
          this.currentBlockIndex++;
          this.currentBlockType = "tool_use";
          events.push(this.formatEvent("content_block_start", {
            type: "content_block_start",
            index: this.currentBlockIndex,
            content_block: {
              type: "tool_use",
              id: tc.id || `toolu_${tcIndex}`,
              name: tc.function?.name || "",
              input: {}
            }
          }));
        }

        // Argument delta
        if (tc.function?.arguments) {
          events.push(this.formatEvent("content_block_delta", {
            type: "content_block_delta",
            index: this.currentBlockIndex,
            delta: { type: "input_json_delta", partial_json: tc.function.arguments }
          }));
        }
      }
    }

    // Check for finish_reason
    if (choice?.finish_reason) {
      events.push(...this.handleFinish(choice.finish_reason, chunk.usage));
    }

    return events;
  }

  private handleFinish(finishReason: string, usage: any): string[] {
    const events: string[] = [];

    // Close current block
    if (this.currentBlockIndex >= 0) {
      events.push(this.formatEvent("content_block_stop", {
        type: "content_block_stop",
        index: this.currentBlockIndex
      }));
      this.currentBlockIndex = -1;
      this.currentBlockType = null;
    }

    this.outputTokens = usage?.completion_tokens || this.outputTokens;

    const stopReason = convertFinishReasonToStopReason(finishReason);
    events.push(this.formatEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: this.outputTokens }
    }));
    events.push(this.formatEvent("message_stop", { type: "message_stop" }));
    this.messageStopped = true;

    return events;
  }

  private finishStream(): string[] {
    const events: string[] = [];
    if (this.currentBlockIndex >= 0) {
      events.push(this.formatEvent("content_block_stop", {
        type: "content_block_stop",
        index: this.currentBlockIndex
      }));
      this.currentBlockIndex = -1;
      this.currentBlockType = null;
    }
    if (!this.messageStopped) {
      events.push(this.formatEvent("message_stop", { type: "message_stop" }));
      this.messageStopped = true;
    }
    return events;
  }

  private formatEvent(eventType: string, data: any): string {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}

// Parse a raw SSE chunk (buffer/string) into individual data lines,
// preserving partial lines across chunks via the returned remainder.
export function parseSseChunk(raw: string, carry: string): { lines: string[]; remainder: string } {
  const text = carry + raw;
  const parts = text.split("\n");
  const remainder = parts.pop() || "";
  const lines: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith("data: ")) {
      lines.push(trimmed.slice(6));
    } else if (trimmed.startsWith("data:")) {
      lines.push(trimmed.slice(5));
    }
  }
  return { lines, remainder };
}
