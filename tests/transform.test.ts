import { describe, it, expect } from "vitest";
import {
  transformRequestToOpenAI,
  transformResponseFromOpenAI,
  OpenAIToAnthropicSseTransformer,
  transformRequestToGemini,
  transformResponseFromGemini,
  GeminiToAnthropicSseTransformer,
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

  // -------------------------------------------------------------------------
  // Request: Anthropic -> Gemini
  // -------------------------------------------------------------------------

  describe("transformRequestToGemini", () => {
    it("should convert system string to systemInstruction", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
        system: "You are helpful",
        messages: [{ role: "user", content: "Hi" }]
      });
      expect(result.systemInstruction).toEqual({
        parts: [{ text: "You are helpful" }]
      });
      expect(result.contents[0]).toEqual({
        role: "user",
        parts: [{ text: "Hi" }]
      });
    });

    it("should convert system array to systemInstruction", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
        system: [{ type: "text", text: "Part 1" }, { type: "text", text: "Part 2" }],
        messages: [{ role: "user", content: "Hi" }]
      });
      expect(result.systemInstruction).toEqual({
        parts: [{ text: "Part 1" }, { text: "Part 2" }]
      });
    });

    it("should map assistant role to model role", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello!" },
          { role: "user", content: "Bye" }
        ]
      });
      expect(result.contents[0].role).toBe("user");
      expect(result.contents[1].role).toBe("model");
      expect(result.contents[2].role).toBe("user");
    });

    it("should merge system-role messages into systemInstruction (Gemini rejects role:system in contents)", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
        system: "You are helpful",
        messages: [
          { role: "system", content: "Agent types: claude, explore" },
          { role: "user", content: "Hi" },
          { role: "system", content: "Extra context" }
        ]
      });
      const roles = result.contents.map((m: any) => m.role);
      expect(roles).not.toContain("system");
      expect(result.contents.map((m: any) => m.role)).toEqual(["user"]);
      expect(result.systemInstruction.parts.map((p: any) => p.text)).toEqual([
        "You are helpful",
        "Agent types: claude, explore",
        "Extra context"
      ]);
    });

    it("should convert string content to parts with text", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
        messages: [{ role: "user", content: "Hello world" }]
      });
      expect(result.contents[0].parts).toEqual([{ text: "Hello world" }]);
    });

    it("should convert text blocks to text parts", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Hello" }, { type: "text", text: "world" }]
          }
        ]
      });
      expect(result.contents[0].parts).toEqual([{ text: "Hello" }, { text: "world" }]);
    });

    it("should convert tool_use blocks to functionCall parts (native Gemini function calling in history)", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
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
      const parts = result.contents[0].parts;
      expect(parts[0]).toEqual({ text: "Let me check" });
      expect(parts[1]).toEqual({
        functionCall: { name: "bash", args: { cmd: "ls" } }
      });
    });

    it("should convert tool_result blocks to functionResponse parts with name lookup", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_1", name: "bash", input: { cmd: "ls" } }
            ]
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "file.txt" }
            ]
          }
        ]
      });
      expect(result.contents[0].parts[0]).toEqual({
        functionCall: { name: "bash", args: { cmd: "ls" } }
      });
      expect(result.contents[1].parts[0]).toEqual({
        functionResponse: { name: "bash", response: { output: "file.txt" } }
      });
    });

    it("should convert tool_result with array content to functionResponse part", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "read", input: {} }]
          },
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
      expect(result.contents[1].parts[0]).toEqual({
        functionResponse: { name: "read", response: { output: "line1\nline2" } }
      });
    });

    it("should handle tool_result whose tool_use_id has no matching tool_use (fallback to id as name)", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_orphan", content: "data" }
            ]
          }
        ]
      });
      expect(result.contents[0].parts[0]).toEqual({
        functionResponse: { name: "toolu_orphan", response: { output: "data" } }
      });
    });

    it("should fall back to text part when tool_result content is non-text (e.g. image)", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "screenshot", input: {} }]
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR..." } }]
              }
            ]
          }
        ]
      });
      // image content cannot be represented in functionResponse.response as text;
      // fall back to a text placeholder so the model still sees a tool result marker
      expect(result.contents[1].parts[0]).toMatchObject({
        functionResponse: { name: "screenshot" }
      });
    });

    it("should convert image blocks to inlineData parts", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
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
      expect(result.contents[0].parts[0]).toEqual({
        inlineData: { mimeType: "image/png", data: "iVBOR..." }
      });
      expect(result.contents[0].parts[1]).toEqual({ text: "What is this?" });
    });

    it("should skip thinking blocks in input", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
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
      expect(result.contents[0].parts).toEqual([{ text: "Answer" }]);
    });

    it("should convert tools to functionDeclarations", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
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
          functionDeclarations: [
            {
              name: "bash",
              description: "Run bash",
              parameters: { type: "object", properties: { cmd: { type: "string" } } }
            }
          ]
        }
      ]);
    });

    it("should strip unsupported JSON Schema fields from tool parameters", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
        tools: [
          {
            name: "edit",
            description: "Edit a file",
            input_schema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              properties: {
                path: { type: "string", minLength: 1, maxLength: 4096 },
                content: { type: "string", description: "new content" },
                lines: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 100 }
              },
              required: ["path"],
              additionalProperties: false
            }
          }
        ],
        messages: [{ role: "user", content: "Hi" }]
      });
      const params = result.tools[0].functionDeclarations[0].parameters;
      expect(params.$schema).toBeUndefined();
      expect(params.additionalProperties).toBeUndefined();
      expect(params.properties.path.minLength).toBeUndefined();
      expect(params.properties.path.maxLength).toBeUndefined();
      expect(params.properties.lines.minItems).toBeUndefined();
      expect(params.properties.lines.maxItems).toBeUndefined();
      expect(params.properties.path.type).toBe("string");
      expect(params.properties.lines.items.type).toBe("string");
      expect(params.type).toBe("object");
      expect(params.required).toEqual(["path"]);
    });

    it("should map tool_choice auto to AUTO mode", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
        tool_choice: "auto",
        messages: [{ role: "user", content: "Hi" }]
      });
      expect(result.toolConfig).toEqual({
        functionCallingConfig: { mode: "AUTO" }
      });
    });

    it("should map tool_choice any to ANY mode", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
        tool_choice: "any",
        messages: [{ role: "user", content: "Hi" }]
      });
      expect(result.toolConfig.functionCallingConfig.mode).toBe("ANY");
    });

    it("should map tool_choice none to NONE mode", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
        tool_choice: "none",
        messages: [{ role: "user", content: "Hi" }]
      });
      expect(result.toolConfig.functionCallingConfig.mode).toBe("NONE");
    });

    it("should map tool_choice specific tool to ANY with allowedFunctionNames", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
        tool_choice: { type: "tool", name: "bash" },
        messages: [{ role: "user", content: "Hi" }]
      });
      expect(result.toolConfig.functionCallingConfig).toEqual({
        mode: "ANY",
        allowedFunctionNames: ["bash"]
      });
    });

    it("should map generation config fields", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
        max_tokens: 4096,
        temperature: 0.7,
        top_p: 0.9,
        stop_sequences: ["END"],
        messages: [{ role: "user", content: "Hi" }]
      });
      expect(result.generationConfig).toEqual({
        maxOutputTokens: 4096,
        temperature: 0.7,
        topP: 0.9,
        stopSequences: ["END"]
      });
    });

    it("should not include stream field in output", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
        stream: true,
        messages: [{ role: "user", content: "Hi" }]
      });
      expect(result.stream).toBeUndefined();
    });

    it("should not include model field in output body", () => {
      const result = transformRequestToGemini({
        model: "gemini-3.5-flash",
        messages: [{ role: "user", content: "Hi" }]
      });
      expect(result.model).toBeUndefined();
      expect(result.contents).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Response: Gemini -> Anthropic (non-streaming)
  // -------------------------------------------------------------------------

  describe("transformResponseFromGemini", () => {
    it("should convert basic text response", () => {
      const result = transformResponseFromGemini(
        {
          candidates: [
            {
              index: 0,
              content: {
                role: "model",
                parts: [{ text: "Hello!" }]
              },
              finishReason: "STOP"
            }
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 20,
            totalTokenCount: 30
          }
        },
        "gemini-3.5-flash"
      );
      expect(result.type).toBe("message");
      expect(result.role).toBe("assistant");
      expect(result.content).toEqual([{ type: "text", text: "Hello!" }]);
      expect(result.stop_reason).toBe("end_turn");
      expect(result.usage.input_tokens).toBe(10);
      expect(result.usage.output_tokens).toBe(20);
    });

    it("should convert functionCall to tool_use blocks", () => {
      const result = transformResponseFromGemini(
        {
          candidates: [
            {
              index: 0,
              content: {
                role: "model",
                parts: [
                  { text: "Let me check" },
                  { functionCall: { name: "bash", args: { cmd: "ls -la" } } }
                ]
              },
              finishReason: "TOOL_USE"
            }
          ],
          usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 25 }
        },
        "gemini-3.5-flash"
      );
      expect(result.content[0]).toEqual({ type: "text", text: "Let me check" });
      expect(result.content[1].type).toBe("tool_use");
      expect(result.content[1].name).toBe("bash");
      expect(result.content[1].input).toEqual({ cmd: "ls -la" });
      expect(result.content[1].id).toMatch(/^toolu_/);
      expect(result.stop_reason).toBe("tool_use");
    });

    it("should convert thought parts to thinking blocks", () => {
      const result = transformResponseFromGemini(
        {
          candidates: [
            {
              index: 0,
              content: {
                role: "model",
                parts: [
                  { thought: true, text: "Thinking..." },
                  { text: "Answer" }
                ]
              },
              finishReason: "STOP"
            }
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 }
        },
        "gemini-3.5-flash"
      );
      expect(result.content[0]).toEqual({ type: "thinking", thinking: "Thinking..." });
      expect(result.content[1]).toEqual({ type: "text", text: "Answer" });
    });

    it("should map MAX_TOKENS finishReason to max_tokens", () => {
      const result = transformResponseFromGemini(
        {
          candidates: [
            {
              index: 0,
              content: { role: "model", parts: [{ text: "..." }] },
              finishReason: "MAX_TOKENS"
            }
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 }
        },
        "gemini-3.5-flash"
      );
      expect(result.stop_reason).toBe("max_tokens");
    });

    it("should map cachedContentTokenCount to cache_read_input_tokens", () => {
      const result = transformResponseFromGemini(
        {
          candidates: [
            {
              index: 0,
              content: { role: "model", parts: [{ text: "Hi" }] },
              finishReason: "STOP"
            }
          ],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            cachedContentTokenCount: 50
          }
        },
        "gemini-3.5-flash"
      );
      expect(result.usage.cache_read_input_tokens).toBe(50);
    });

    it("should handle empty candidates gracefully", () => {
      const result = transformResponseFromGemini(
        {
          candidates: [],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 }
        },
        "gemini-3.5-flash"
      );
      expect(result.content).toEqual([]);
      expect(result.stop_reason).toBe("end_turn");
    });

    it("should generate message id", () => {
      const result = transformResponseFromGemini(
        {
          candidates: [
            {
              content: { role: "model", parts: [{ text: "Hi" }] },
              finishReason: "STOP"
            }
          ]
        },
        "gemini-3.5-flash"
      );
      expect(result.id).toMatch(/^msg_/);
    });
  });

  // -------------------------------------------------------------------------
  // SSE Streaming: Gemini -> Anthropic
  // -------------------------------------------------------------------------

  describe("GeminiToAnthropicSseTransformer", () => {
    it("should convert text streaming", () => {
      const tx = new GeminiToAnthropicSseTransformer("gemini-3.5-flash");
      const events: string[] = [];

      // First chunk with text
      events.push(...tx.transformDataLine(JSON.stringify({
        candidates: [
          {
            index: 0,
            content: { role: "model", parts: [{ text: "Hello" }] }
          }
        ]
      })));
      // Second chunk with more text
      events.push(...tx.transformDataLine(JSON.stringify({
        candidates: [
          {
            index: 0,
            content: { role: "model", parts: [{ text: " world" }] }
          }
        ]
      })));
      // Final chunk with finishReason and usage
      events.push(...tx.transformDataLine(JSON.stringify({
        candidates: [
          {
            index: 0,
            content: { role: "model", parts: [] },
            finishReason: "STOP"
          }
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15 }
      })));

      const allEvents = events.join("");
      expect(allEvents).toContain("message_start");
      expect(allEvents).toContain("content_block_start");
      expect(allEvents).toContain('"text":"Hello"');
      expect(allEvents).toContain('"text":" world"');
      expect(allEvents).toContain("content_block_stop");
      expect(allEvents).toContain("message_delta");
      expect(allEvents).toContain('"stop_reason":"end_turn"');
      expect(allEvents).toContain("message_stop");
    });

    it("should convert functionCall streaming as tool_use", () => {
      const tx = new GeminiToAnthropicSseTransformer("gemini-3.5-flash");
      const events: string[] = [];

      // Text part then function call in one chunk
      events.push(...tx.transformDataLine(JSON.stringify({
        candidates: [
          {
            index: 0,
            content: {
              role: "model",
              parts: [
                { text: "Let me run that" },
                { functionCall: { name: "bash", args: { cmd: "ls" } } }
              ]
            },
            finishReason: "TOOL_USE"
          }
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 15, totalTokenCount: 20 }
      })));

      const allEvents = events.join("");
      expect(allEvents).toContain('"type":"text"');
      expect(allEvents).toContain('"text":"Let me run that"');
      expect(allEvents).toContain('"type":"tool_use"');
      expect(allEvents).toContain('"name":"bash"');
      expect(allEvents).toContain('"input_json_delta"');
      expect(allEvents).toContain('"stop_reason":"tool_use"');
    });

    it("should extract usage from final chunk", () => {
      const tx = new GeminiToAnthropicSseTransformer("gemini-3.5-flash");
      tx.transformDataLine(JSON.stringify({
        candidates: [
          {
            index: 0,
            content: { role: "model", parts: [{ text: "Hi" }] },
            finishReason: "STOP"
          }
        ],
        usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 99, totalTokenCount: 141 }
      }));

      const usage = tx.getUsage();
      expect(usage.inputTokens).toBe(42);
      expect(usage.outputTokens).toBe(99);
    });

    it("should handle empty parts in chunk", () => {
      const tx = new GeminiToAnthropicSseTransformer("gemini-3.5-flash");
      const events: string[] = [];

      // Chunk with empty parts and finishReason
      events.push(...tx.transformDataLine(JSON.stringify({
        candidates: [
          {
            index: 0,
            content: { role: "model", parts: [] },
            finishReason: "STOP"
          }
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0, totalTokenCount: 5 }
      })));

      const allEvents = events.join("");
      // Should still emit message_start and message_stop
      expect(allEvents).toContain("message_start");
      expect(allEvents).toContain("message_stop");
    });
  });
});
