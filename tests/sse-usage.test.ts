import { describe, it, expect } from "vitest";
import { AnthropicSseUsageExtractor } from "../src/sse-usage.js";

describe("AnthropicSseUsageExtractor", () => {
  it("should extract input_tokens from message_start", () => {
    const extractor = new AnthropicSseUsageExtractor();
    extractor.processLine(JSON.stringify({
      type: "message_start",
      message: {
        usage: { input_tokens: 100, output_tokens: 0 }
      }
    }));
    const usage = extractor.getUsage();
    expect(usage.inputTokens).toBe(100);
  });

  it("should extract output_tokens from message_delta", () => {
    const extractor = new AnthropicSseUsageExtractor();
    extractor.processLine(JSON.stringify({
      type: "message_start",
      message: { usage: { input_tokens: 50, output_tokens: 0 } }
    }));
    extractor.processLine(JSON.stringify({
      type: "message_delta",
      usage: { output_tokens: 200 }
    }));
    const usage = extractor.getUsage();
    expect(usage.inputTokens).toBe(50);
    expect(usage.outputTokens).toBe(200);
  });

  it("should extract cache tokens", () => {
    const extractor = new AnthropicSseUsageExtractor();
    extractor.processLine(JSON.stringify({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 1000
        }
      }
    }));
    const usage = extractor.getUsage();
    expect(usage.cacheCreationInputTokens).toBe(500);
    expect(usage.cacheReadInputTokens).toBe(1000);
  });

  it("should handle message_start with cache_creation and cache_read", () => {
    const extractor = new AnthropicSseUsageExtractor();
    extractor.processLine(JSON.stringify({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30
        }
      }
    }));
    const usage = extractor.getUsage();
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 0,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 30
    });
  });

  it("should update output_tokens from final message_delta", () => {
    const extractor = new AnthropicSseUsageExtractor();
    extractor.processLine(JSON.stringify({
      type: "message_start",
      message: { usage: { input_tokens: 50, output_tokens: 0 } }
    }));
    // Partial delta
    extractor.processLine(JSON.stringify({
      type: "message_delta",
      usage: { output_tokens: 150 }
    }));
    // Final delta with full count
    extractor.processLine(JSON.stringify({
      type: "message_delta",
      usage: { output_tokens: 300 }
    }));
    const usage = extractor.getUsage();
    // Should keep the last (largest) output_tokens
    expect(usage.outputTokens).toBe(300);
  });

  it("should handle non-JSON lines gracefully", () => {
    const extractor = new AnthropicSseUsageExtractor();
    extractor.processLine("[DONE]");
    extractor.processLine("not json");
    extractor.processLine("");
    const usage = extractor.getUsage();
    expect(usage.inputTokens).toBeUndefined();
    expect(usage.outputTokens).toBeUndefined();
  });

  it("should handle missing usage fields gracefully", () => {
    const extractor = new AnthropicSseUsageExtractor();
    extractor.processLine(JSON.stringify({
      type: "message_start",
      message: { /* no usage */ }
    }));
    const usage = extractor.getUsage();
    expect(usage.inputTokens).toBeUndefined();
  });

  it("should process raw SSE chunk text and return remainder", () => {
    const extractor = new AnthropicSseUsageExtractor();
    const chunk = `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { usage: { input_tokens: 42, output_tokens: 0 } }
    })}\n\nevent: content_block_delta\ndata: `;
    const remainder = extractor.processChunk(chunk);
    expect(remainder).toBe("data: ");
    expect(extractor.getUsage().inputTokens).toBe(42);
  });

  it("should handle multiple SSE events in one chunk", () => {
    const extractor = new AnthropicSseUsageExtractor();
    const chunk = [
      `event: message_start`,
      `data: ${JSON.stringify({
        type: "message_start",
        message: { usage: { input_tokens: 10, output_tokens: 0 } }
      })}`,
      "",
      `event: message_delta`,
      `data: ${JSON.stringify({
        type: "message_delta",
        usage: { output_tokens: 99 }
      })}`,
      "",
      ""
    ].join("\n");
    extractor.processChunk(chunk);
    const usage = extractor.getUsage();
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(99);
  });
});
