import { describe, it, expect } from "vitest";
import {
  transformRequestToOpenAI,
  transformResponseFromOpenAI,
  OpenAIToAnthropicSseTransformer,
  parseSseChunk
} from "../src/transform.js";

describe("transform", () => {
  // -------------------------------------------------------------------------
  // Request: Anthropic -> OpenAI
  // -------------------------------------------------------------------------

  describe("transformRequestToOpenAI", () => {
    it("should convert system string to system message", () => {
      const result = transformRequestToOpenAI({
        model: "gpt-4o",
        system: "You are helpful",
        messages: [{ role: "user", content: "Hi" }]
      });
      expect(result.messages[0]).toEqual({ role: "system", content: "You are helpful" });
      expect(result.messages[1]).toEqual({ role: "user", content: "Hi" });
    });

    it("should convert system array to system message", () => {
      const result = transformRequestToOpenAI({
        model: "gpt-4o",
        system: [{ type: "text", text: "Part 1" }, { type: "text", text: "Part 2" }],
        messages: [{ role: "user", content: "Hi" }]
      });
      expect(result.messages[0]).toEqual({ role: "system", content: "Part 1\nPart 2" });
    });

    it("should convert tool_use blocks to tool_calls", () => {
      const result = transformRequestToOpenAI({
        model: "gpt-4o",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me check" },
              { type: "tool_use", id: "toolu_1", name: "bash", input: { cmd: "ls" } }
            ]
          }
        ]
      });
      const assistantMsg = result.messages[0];
      expect(assistantMsg.role).toBe("assistant");
      expect(assistantMsg.content).toBe("Let me check");
      expect(assistantMsg.tool_calls).toEqual([
        {
          id: "toolu_1",
          type: "function",
          function: { name: "bash", arguments: '{"cmd":"ls"}' }
        }
      ]);
    });

    it("should convert tool_result blocks to tool messages", () => {
      const result = transformRequestToOpenAI({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "file.txt" },
              { type: "text", text: "What next?" }
            ]
          }
        ]
      });
      // tool result becomes a tool message
      expect(result.messages[0]).toEqual({
        role: "tool",
        tool_call_id: "toolu_1",
        content: "file.txt"
      });
      // text becomes a user message
      expect(result.messages[1]).toEqual({ role: "user", content: "What next?" });
    });

    it("should convert tool_result with array content", () => {
      const result = transformRequestToOpenAI({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }]
              }
            ]
          }
        ]
      });
      expect(result.messages[0].content).toBe("line1\nline2");
    });

    it("should convert tools to OpenAI function format", () => {
      const result = transformRequestToOpenAI({
        model: "gpt-4o",
        tools: [
          {
            name: "bash",
            description: "Run bash",
            input_schema: { type: "object", properties: { cmd: { type: "string" } } }
          }
        ],
        messages: [{ role: "user", content: "Hi" }]
      });
      expect(result.tools).toEqual([
        {
          type: "function",
          function: {
            name: "bash",
            description: "Run bash",
            parameters: { type: "object", properties: { cmd: { type: "string" } } }
          }
        }
      ]);
    });

    it("should convert max_tokens to max_completion_tokens", () => {
      const result = transformRequestToOpenAI({
        model: "gpt-4o",
        max_tokens: 4096,
        messages: [{ role: "user", content: "Hi" }]
      });
      expect(result.max_completion_tokens).toBe(4096);
    });

    it("should preserve stream flag", () => {
      const result = transformRequestToOpenAI({
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "Hi" }]
      });
      expect(result.stream).toBe(true);
    });

    it("should convert image blocks to image_url format", () => {
      const result = transformRequestToOpenAI({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "iVBOR..." }
              },
              { type: "text", text: "What is this?" }
            ]
          }
        ]
      });
      // Should have an image_url message
      const imgMsg = result.messages.find((m: any) =>
        Array.isArray(m.content) && m.content.some((c: any) => c.type === "image_url")
      );
      expect(imgMsg).toBeDefined();
      expect(imgMsg.content[0].image_url.url).toBe("data:image/png;base64,iVBOR...");
    });

    it("should map tool_choice", () => {
      const result = transformRequestToOpenAI({
        model: "gpt-4o",
        tool_choice: "any",
        messages: [{ role: "user", content: "Hi" }]
      });
      expect(result.tool_choice).toBe("required");
    });

    it("should map tool_choice with tool name", () => {
      const result = transformRequestToOpenAI({
        model: "gpt-4o",
        tool_choice: { type: "tool", name: "bash" },
        messages: [{ role: "user", content: "Hi" }]
      });
      expect(result.tool_choice).toEqual({ type: "function", function: { name: "bash" } });
    });

    it("should skip thinking blocks in input", () => {
      const result = transformRequestToOpenAI({
        model: "gpt-4o",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm" },
              { type: "text", text: "Answer" }
            ]
          }
        ]
      });
      expect(result.messages[0].content).toBe("Answer");
    });
  });

  // -------------------------------------------------------------------------
  // Response: OpenAI -> Anthropic (non-streaming)
  // -------------------------------------------------------------------------

  describe("transformResponseFromOpenAI", () => {
    it("should convert basic text response", () => {
      const result = transformResponseFromOpenAI(
        {
          id: "chatcmpl-1",
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hello!" },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
        },
        "claude-sonnet-4-20250514"
      );
      expect(result.type).toBe("message");
      expect(result.role).toBe("assistant");
      expect(result.content).toEqual([{ type: "text", text: "Hello!" }]);
      expect(result.stop_reason).toBe("end_turn");
      expect(result.usage.input_tokens).toBe(10);
      expect(result.usage.output_tokens).toBe(20);
    });

    it("should convert tool_calls to tool_use blocks", () => {
      const result = transformResponseFromOpenAI(
        {
          id: "chatcmpl-2",
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "bash", arguments: '{"cmd":"ls -la"}' }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ],
          usage: { prompt_tokens: 15, completion_tokens: 25 }
        },
        "claude-sonnet-4-20250514"
      );
      expect(result.content).toEqual([
        { type: "tool_use", id: "call_1", name: "bash", input: { cmd: "ls -la" } }
      ]);
      expect(result.stop_reason).toBe("tool_use");
    });

    it("should convert reasoning_content to thinking block", () => {
      const result = transformResponseFromOpenAI(
        {
          id: "chatcmpl-3",
          model: "o1",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Answer", reasoning_content: "Thinking..." },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20 }
        },
        "claude-sonnet-4-20250514"
      );
      expect(result.content[0]).toEqual({ type: "thinking", thinking: "Thinking..." });
      expect(result.content[1]).toEqual({ type: "text", text: "Answer" });
    });

    it("should map length finish_reason to max_tokens", () => {
      const result = transformResponseFromOpenAI(
        {
          id: "chatcmpl-4",
          model: "gpt-4o",
          choices: [{ index: 0, message: { content: "..." }, finish_reason: "length" }],
          usage: { prompt_tokens: 10, completion_tokens: 20 }
        },
        "gpt-4o"
      );
      expect(result.stop_reason).toBe("max_tokens");
    });
  });

  // -------------------------------------------------------------------------
  // SSE Streaming: OpenAI -> Anthropic
  // -------------------------------------------------------------------------

  describe("OpenAIToAnthropicSseTransformer", () => {
    it("should convert text streaming", () => {
      const tx = new OpenAIToAnthropicSseTransformer("claude-sonnet-4");
      const events: string[] = [];

      events.push(...tx.transformDataLine(JSON.stringify({
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
      })));
      events.push(...tx.transformDataLine(JSON.stringify({
        choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }]
      })));
      events.push(...tx.transformDataLine(JSON.stringify({
        choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }]
      })));
      events.push(...tx.transformDataLine(JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 10 }
      })));

      const allEvents = events.join("");
      expect(allEvents).toContain("message_start");
      expect(allEvents).toContain("content_block_start");
      expect(allEvents).toContain('"text_delta"');
      expect(allEvents).toContain('"text":"Hello"');
      expect(allEvents).toContain('"text":" world"');
      expect(allEvents).toContain("content_block_stop");
      expect(allEvents).toContain("message_delta");
      expect(allEvents).toContain('"stop_reason":"end_turn"');
      expect(allEvents).toContain("message_stop");
    });

    it("should convert tool_calls streaming", () => {
      const tx = new OpenAIToAnthropicSseTransformer("claude-sonnet-4");
      const events: string[] = [];

      // Tool call starts
      events.push(...tx.transformDataLine(JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "bash", arguments: "" }
            }]
          },
          finish_reason: null
        }]
      })));
      // Argument delta
      events.push(...tx.transformDataLine(JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }]
          },
          finish_reason: null
        }]
      })));
      // Finish
      events.push(...tx.transformDataLine(JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 5, completion_tokens: 15 }
      })));

      const allEvents = events.join("");
      expect(allEvents).toContain('"type":"tool_use"');
      expect(allEvents).toContain('"name":"bash"');
      expect(allEvents).toContain('"input_json_delta"');
      expect(allEvents).toContain('\\"cmd\\":\\"ls\\"');
      expect(allEvents).toContain('"stop_reason":"tool_use"');
    });

    it("should handle [DONE]", () => {
      const tx = new OpenAIToAnthropicSseTransformer("claude-sonnet-4");
      tx.transformDataLine(JSON.stringify({
        choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }]
      }));
      const events = tx.transformDataLine("[DONE]");
      const allEvents = events.join("");
      expect(allEvents).toContain("content_block_stop");
      expect(allEvents).toContain("message_stop");
    });
  });

  describe("parseSseChunk", () => {
    it("should parse complete data lines", () => {
      const { lines, remainder } = parseSseChunk("data: {\"a\":1}\n\ndata: {\"b\":2}\n\n", "");
      expect(lines).toEqual(['{"a":1}', '{"b":2}']);
      expect(remainder).toBe("");
    });

    it("should carry partial lines", () => {
      const { lines, remainder } = parseSseChunk("data: {\"a\":1}\n\ndata: {\"b\":", "");
      expect(lines).toEqual(['{"a":1}']);
      expect(remainder).toBe('data: {"b":');

      const { lines: lines2, remainder: remainder2 } = parseSseChunk("2}\n\n", remainder);
      expect(lines2).toEqual(['{"b":2}']);
      expect(remainder2).toBe("");
    });
  });
});
