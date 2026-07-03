// Extract token usage from Anthropic SSE stream without modifying it.
// Used for same-protocol passthrough to record token consumption.

export interface ExtractedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export class AnthropicSseUsageExtractor {
  private usage: ExtractedUsage = {};
  private carry = "";

  // Process a raw SSE chunk (may contain partial lines).
  // Returns the trailing partial line to carry to the next chunk.
  processChunk(raw: string): string {
    const text = this.carry + raw;
    const parts = text.split("\n");
    const remainder = parts.pop() || "";
    this.carry = remainder;

    for (const line of parts) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) {
        this.processLine(trimmed.slice(6));
      } else if (trimmed.startsWith("data:")) {
        this.processLine(trimmed.slice(5));
      }
    }

    return remainder;
  }

  // Process a single SSE data line (the JSON payload after "data: ").
  processLine(data: string): void {
    if (!data || data === "[DONE]") return;

    try {
      const parsed = JSON.parse(data);
      if (parsed.type === "message_start" && parsed.message?.usage) {
        const u = parsed.message.usage;
        if (typeof u.input_tokens === "number") this.usage.inputTokens = u.input_tokens;
        if (typeof u.output_tokens === "number") this.usage.outputTokens = u.output_tokens;
        if (typeof u.cache_creation_input_tokens === "number") {
          this.usage.cacheCreationInputTokens = u.cache_creation_input_tokens;
        }
        if (typeof u.cache_read_input_tokens === "number") {
          this.usage.cacheReadInputTokens = u.cache_read_input_tokens;
        }
      } else if (parsed.type === "message_delta" && parsed.usage) {
        const u = parsed.usage;
        // message_delta carries the final output_tokens count
        if (typeof u.output_tokens === "number") this.usage.outputTokens = u.output_tokens;
      }
    } catch {
      // Not JSON or unexpected format — ignore
    }
  }

  getUsage(): ExtractedUsage {
    return { ...this.usage };
  }

  // Flush any remaining carry buffer
  finish(): void {
    if (this.carry.trim()) {
      const trimmed = this.carry.trim();
      if (trimmed.startsWith("data: ")) {
        this.processLine(trimmed.slice(6));
      } else if (trimmed.startsWith("data:")) {
        this.processLine(trimmed.slice(5));
      }
      this.carry = "";
    }
  }
}
