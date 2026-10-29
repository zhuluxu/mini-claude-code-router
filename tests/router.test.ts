import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveModel, evaluateRules, forwardRequest } from "../src/router.js";
import type { Config, RouterRule, ResolvedProvider } from "../src/types.js";

const mockConfig: Config = {
  server: { host: "127.0.0.1", port: 3456 },
  providers: [
    {
      name: "anthropic",
      type: "anthropic_messages",
      baseUrl: "https://api.anthropic.com",
      apiKey: "test-key",
      model: "claude-sonnet-4-20250514"
    },
    {
      name: "openrouter",
      type: "openai_chat_completions",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "test-key",
      model: "anthropic/claude-sonnet-4"
    }
  ],
  router: {
    defaultModel: "anthropic/claude-sonnet-4-20250514",
    fallback: ["openrouter/anthropic/claude-sonnet-4"]
  },
  logging: { enabled: false, level: "info" }
};

describe("router", () => {
  describe("resolveModel", () => {
    it("should resolve model with provider prefix", () => {
      const resolved = resolveModel("anthropic/claude-sonnet-4-20250514", mockConfig);
      expect(resolved.name).toBe("anthropic");
      expect(resolved.model).toBe("claude-sonnet-4-20250514");
    });

    it("should resolve bare model name by searching providers", () => {
      const resolved = resolveModel("claude-sonnet-4-20250514", mockConfig);
      expect(resolved.name).toBe("anthropic");
      expect(resolved.model).toBe("claude-sonnet-4-20250514");
    });

    it("should warn and fall back to default for unknown provider", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const resolved = resolveModel("unknown/model", mockConfig);
      expect(resolved.name).toBe("anthropic");
      expect(resolved.model).toBe("claude-sonnet-4-20250514");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Provider "unknown" not found')
      );
      warnSpy.mockRestore();
    });

    it("should warn and fall back to default for unknown model", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const resolved = resolveModel("anthropic/unknown-model", mockConfig);
      expect(resolved.name).toBe("anthropic");
      expect(resolved.model).toBe("claude-sonnet-4-20250514");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Model "unknown-model" not found in provider "anthropic"')
      );
      warnSpy.mockRestore();
    });

    it("should warn and fall back to default for bare unknown model", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const resolved = resolveModel("nonexistent-model", mockConfig);
      expect(resolved.name).toBe("anthropic");
      expect(resolved.model).toBe("claude-sonnet-4-20250514");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Model "nonexistent-model" not found in any provider')
      );
      warnSpy.mockRestore();
    });

    it("should use default model when model is empty", () => {
      const resolved = resolveModel("", mockConfig);
      expect(resolved.name).toBe("anthropic");
      expect(resolved.model).toBe("claude-sonnet-4-20250514");
    });
  });

  describe("evaluateRules", () => {
    const rules: RouterRule[] = [
      { when: { thinking: true }, target: "opus/claude-opus-4" },
      { when: { tools: true, messagesGte: 10 }, target: "sonnet/claude-sonnet-4" },
      { when: { tools: false, messagesLt: 3 }, target: "haiku/claude-3-5-haiku" }
    ];

    it("should match thinking=true rule", () => {
      const result = evaluateRules({ thinking: { type: "enabled" }, messages: [] }, "default", rules);
      expect(result?.target).toBe("opus/claude-opus-4");
      expect(result?.index).toBe(0);
    });

    it("should match tools=true + messagesGte rule", () => {
      const result = evaluateRules(
        { tools: [{ name: "bash" }], messages: Array(12).fill({ role: "user", content: "hi" }) },
        "default",
        rules
      );
      expect(result?.target).toBe("sonnet/claude-sonnet-4");
      expect(result?.index).toBe(1);
    });

    it("should match tools=false + messagesLt rule", () => {
      const result = evaluateRules(
        { messages: [{ role: "user", content: "hi" }] },
        "default",
        rules
      );
      expect(result?.target).toBe("haiku/claude-3-5-haiku");
      expect(result?.index).toBe(2);
    });

    it("should return undefined when no rule matches", () => {
      const result = evaluateRules(
        { tools: [{ name: "bash" }], messages: [{ role: "user", content: "hi" }] },
        "default",
        rules
      );
      expect(result).toBeUndefined();
    });

    it("should return undefined when rules is empty or undefined", () => {
      expect(evaluateRules({ messages: [] }, "default", undefined)).toBeUndefined();
      expect(evaluateRules({ messages: [] }, "default", [])).toBeUndefined();
    });

    it("should match first rule only (priority order)", () => {
      const rulesWithOverlap: RouterRule[] = [
        { when: { thinking: true, tools: true }, target: "opus/claude-opus-4" },
        { when: { thinking: true }, target: "sonnet/claude-sonnet-4" }
      ];
      const result = evaluateRules(
        { thinking: { type: "enabled" }, tools: [{ name: "bash" }] },
        "default",
        rulesWithOverlap
      );
      expect(result?.target).toBe("opus/claude-opus-4");
      expect(result?.index).toBe(0);
    });

    it("should treat thinking=null as no thinking", () => {
      const result = evaluateRules({ thinking: null, messages: [] }, "default", rules);
      expect(result?.target).toBe("haiku/claude-3-5-haiku");
    });

    it("should treat empty tools array as no tools", () => {
      const result = evaluateRules({ tools: [], messages: [] }, "default", rules);
      expect(result?.target).toBe("haiku/claude-3-5-haiku");
    });

    it("should handle missing messages array", () => {
      const result = evaluateRules({ tools: false }, "default", rules);
      // No messages field → messageCount=0, tools=false, messagesLt=3 → matches haiku
      expect(result?.target).toBe("haiku/claude-3-5-haiku");
    });

    it("should handle messagesGte boundary (exactly N)", () => {
      const result = evaluateRules(
        { tools: [{ name: "bash" }], messages: Array(10).fill({ role: "user", content: "x" }) },
        "default",
        rules
      );
      expect(result?.target).toBe("sonnet/claude-sonnet-4");
    });

    it("should handle messagesLt boundary (exactly N-1)", () => {
      const result = evaluateRules(
        { messages: Array(2).fill({ role: "user", content: "x" }) },
        "default",
        rules
      );
      expect(result?.target).toBe("haiku/claude-3-5-haiku");
    });

    it("should not match messagesLt when count equals N", () => {
      const result = evaluateRules(
        { messages: Array(3).fill({ role: "user", content: "x" }) },
        "default",
        rules
      );
      // messagesLt: 3, count: 3 → 3 < 3 is false → no match
      expect(result).toBeUndefined();
    });

    it("should return condition in match result", () => {
      const result = evaluateRules({ thinking: true, messages: [] }, "default", rules);
      expect(result?.condition).toEqual({ thinking: true });
    });
  });

  describe("forwardRequest opencode session headers", () => {
    const opencodeOpenAIProvider: ResolvedProvider = {
      name: "opencode-glm-5.2",
      type: "openai_chat_completions",
      baseUrl: "https://opencode.ai/zen/go",
      apiKey: "sk-test",
      model: "glm-5.2"
    };

    const opencodeAnthropicProvider: ResolvedProvider = {
      name: "opencode-qwen-plus",
      type: "anthropic_messages",
      baseUrl: "https://opencode.ai/zen/go",
      apiKey: "sk-test",
      model: "qwen3.7-plus"
    };

    function stubOpenAISuccess() {
      const fetchSpy = vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        )
      );
      vi.stubGlobal("fetch", fetchSpy);
      return fetchSpy;
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("derives x-opencode-session from Claude Code metadata.user_id and forwards user-agent (cross-protocol)", async () => {
      const fetchSpy = stubOpenAISuccess();

      await forwardRequest(
        {
          method: "POST",
          path: "/v1/messages",
          headers: { "content-type": "application/json", "user-agent": "claude-cli/2.1.0" },
          body: JSON.stringify({
            model: "claude",
            metadata: { user_id: "user_abc_account__session_11111111-2222-3333-4444-555555555555" },
            messages: [{ role: "user", content: "Hi" }]
          })
        },
        opencodeOpenAIProvider
      );

      const [, options] = fetchSpy.mock.calls[0];
      expect(options.headers["x-opencode-session"]).toBe("11111111-2222-3333-4444-555555555555");
      expect(options.headers["user-agent"]).toBe("claude-cli/2.1.0");
    });

    it("forwards an existing x-opencode-session header", async () => {
      const fetchSpy = stubOpenAISuccess();

      await forwardRequest(
        {
          method: "POST",
          path: "/v1/messages",
          headers: { "content-type": "application/json", "x-opencode-session": "ses_explicit" },
          body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "Hi" }] })
        },
        opencodeOpenAIProvider
      );

      const [, options] = fetchSpy.mock.calls[0];
      expect(options.headers["x-opencode-session"]).toBe("ses_explicit");
    });

    it("injects x-opencode-session for anthropic_messages opencode provider", async () => {
      const mockResponse = new Response(
        JSON.stringify({ type: "message", content: [{ type: "text", text: "hi" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
      const fetchSpy = vi.fn().mockResolvedValue(mockResponse);
      vi.stubGlobal("fetch", fetchSpy);

      await forwardRequest(
        {
          method: "POST",
          path: "/v1/messages",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude",
            metadata: { user_id: "user_x_account__session_deadbeef" },
            messages: [{ role: "user", content: "Hi" }]
          })
        },
        opencodeAnthropicProvider
      );

      const [, options] = fetchSpy.mock.calls[0];
      expect(options.headers["x-opencode-session"]).toBe("deadbeef");
    });

    it("does not add x-opencode-session for non-opencode providers", async () => {
      const openrouterProvider: ResolvedProvider = {
        name: "openrouter",
        type: "openai_chat_completions",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-test",
        model: "anthropic/claude-sonnet-4"
      };
      const fetchSpy = stubOpenAISuccess();

      await forwardRequest(
        {
          method: "POST",
          path: "/v1/messages",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "Hi" }] })
        },
        openrouterProvider
      );

      const [, options] = fetchSpy.mock.calls[0];
      expect(options.headers["x-opencode-session"]).toBeUndefined();
    });

    it("produces a stable session id when no session info is available", async () => {
      const fetchSpy = stubOpenAISuccess();

      const body = JSON.stringify({ model: "claude", messages: [{ role: "user", content: "Hi" }] });

      await forwardRequest(
        { method: "POST", path: "/v1/messages", headers: { "content-type": "application/json" }, body },
        opencodeOpenAIProvider
      );
      await forwardRequest(
        { method: "POST", path: "/v1/messages", headers: { "content-type": "application/json" }, body },
        opencodeOpenAIProvider
      );

      const first = fetchSpy.mock.calls[0][1].headers["x-opencode-session"];
      const second = fetchSpy.mock.calls[1][1].headers["x-opencode-session"];
      expect(first).toBeDefined();
      expect(first).toBe(second);
    });
  });

  describe("forwardRequest accept-encoding handling", () => {
    const anthropicProvider: ResolvedProvider = {
      name: "deepseek-v4-pro",
      type: "anthropic_messages",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "test-key",
      model: "deepseek-v4-pro"
    };

    const openaiProvider: ResolvedProvider = {
      name: "openrouter",
      type: "openai_chat_completions",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "test-key",
      model: "anthropic/claude-sonnet-4"
    };

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function stubSuccess() {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
      vi.stubGlobal("fetch", fetchSpy);
      return fetchSpy;
    }

    it("does not forward client accept-encoding for anthropic passthrough", async () => {
      const fetchSpy = stubSuccess();

      await forwardRequest(
        {
          method: "POST",
          path: "/v1/messages",
          headers: {
            "content-type": "application/json",
            "accept-encoding": "gzip, deflate, br, zstd"
          },
          body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "Hi" }] })
        },
        anthropicProvider
      );

      const [, options] = fetchSpy.mock.calls[0];
      expect(options.headers["accept-encoding"]).toBeUndefined();
      expect(options.headers["Accept-Encoding"]).toBeUndefined();
    });

    it("does not forward client accept-encoding for cross-protocol", async () => {
      const fetchSpy = stubSuccess();

      await forwardRequest(
        {
          method: "POST",
          path: "/v1/messages",
          headers: {
            "content-type": "application/json",
            "accept-encoding": "gzip, deflate, br, zstd"
          },
          body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "Hi" }] })
        },
        openaiProvider
      );

      const [, options] = fetchSpy.mock.calls[0];
      expect(options.headers["accept-encoding"]).toBeUndefined();
      expect(options.headers["Accept-Encoding"]).toBeUndefined();
    });
  });

  describe("forwardRequest with gemini", () => {
    const geminiProvider: ResolvedProvider = {
      name: "gemini-test",
      type: "gemini_generate_content",
      baseUrl: "https://gemini.example.com",
      apiKey: "secret-key",
      model: "gemini-3.5-flash"
    };

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("should build correct URL with model in path for non-streaming", async () => {
      const mockResponse = new Response(JSON.stringify({
        candidates: [{
          content: { role: "model", parts: [{ text: "Hi" }] },
          finishReason: "STOP"
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
      }), { status: 200, headers: { "content-type": "application/json" } });

      const fetchSpy = vi.fn().mockResolvedValue(mockResponse);
      vi.stubGlobal("fetch", fetchSpy);

      await forwardRequest(
        { method: "POST", path: "/v1/messages", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-opus-4", messages: [{ role: "user", content: "Hi" }] }) },
        geminiProvider
      );

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://gemini.example.com/v1/models/gemini-3.5-flash:generateContent");
    });

    it("should transform request body to Gemini format", async () => {
      const mockResponse = new Response(JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] }, finishReason: "STOP" }]
      }), { status: 200, headers: { "content-type": "application/json" } });

      const fetchSpy = vi.fn().mockResolvedValue(mockResponse);
      vi.stubGlobal("fetch", fetchSpy);

      await forwardRequest(
        { method: "POST", path: "/v1/messages", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-opus-4", messages: [{ role: "user", content: "Hi" }], max_tokens: 100 }) },
        geminiProvider
      );

      const [, options] = fetchSpy.mock.calls[0];
      const sentBody = JSON.parse(options.body);
      expect(sentBody.contents).toBeDefined();
      expect(sentBody.contents[0].parts).toEqual([{ text: "Hi" }]);
      expect(sentBody.model).toBeUndefined();
      expect(sentBody.generationConfig.maxOutputTokens).toBe(100);
    });

    it("should transform Gemini response to Anthropic format", async () => {
      const mockResponse = new Response(JSON.stringify({
        candidates: [{
          content: { role: "model", parts: [{ text: "Hello!" }] },
          finishReason: "STOP"
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 }
      }), { status: 200, headers: { "content-type": "application/json" } });

      const fetchSpy = vi.fn().mockResolvedValue(mockResponse);
      vi.stubGlobal("fetch", fetchSpy);

      const result = await forwardRequest(
        { method: "POST", path: "/v1/messages", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "Hi" }] }) },
        geminiProvider
      );

      expect(result.status).toBe(200);
      expect(result.isStreaming).toBe(false);
      expect(result.providerType).toBe("gemini_generate_content");

      const parsedBody = JSON.parse(result.body!);
      expect(parsedBody.type).toBe("message");
      expect(parsedBody.content).toEqual([{ type: "text", text: "Hello!" }]);
      expect(parsedBody.usage.input_tokens).toBe(10);
      expect(parsedBody.usage.output_tokens).toBe(20);
    });

    it("should build streaming URL with alt=sse for streaming requests", async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.close();
        }
      });
      const mockResponse = new Response(mockStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });

      const fetchSpy = vi.fn().mockResolvedValue(mockResponse);
      vi.stubGlobal("fetch", fetchSpy);

      const result = await forwardRequest(
        { method: "POST", path: "/v1/messages", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "Hi" }], stream: true }) },
        geminiProvider
      );

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://gemini.example.com/v1/models/gemini-3.5-flash:streamGenerateContent?alt=sse");
      expect(result.isStreaming).toBe(true);
      expect(result.needsSseTransform).toBe(true);
      expect(result.providerType).toBe("gemini_generate_content");
    });

    it("should use x-goog-api-key header for gemini auth", async () => {
      const mockResponse = new Response(JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] }, finishReason: "STOP" }]
      }), { status: 200, headers: { "content-type": "application/json" } });

      const fetchSpy = vi.fn().mockResolvedValue(mockResponse);
      vi.stubGlobal("fetch", fetchSpy);

      await forwardRequest(
        { method: "POST", path: "/v1/messages", headers: { "content-type": "application/json", "x-api-key": "client-key" }, body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "Hi" }] }) },
        geminiProvider
      );

      const [, options] = fetchSpy.mock.calls[0];
      expect(options.headers["x-goog-api-key"]).toBe("secret-key");
      expect(options.headers["authorization"]).toBeUndefined();
    });

    it("should not include stream field in transformed Gemini body", async () => {
      const mockResponse = new Response(JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] }, finishReason: "STOP" }]
      }), { status: 200, headers: { "content-type": "application/json" } });

      const fetchSpy = vi.fn().mockResolvedValue(mockResponse);
      vi.stubGlobal("fetch", fetchSpy);

      await forwardRequest(
        { method: "POST", path: "/v1/messages", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "Hi" }], stream: false }) },
        geminiProvider
      );

      const [, options] = fetchSpy.mock.calls[0];
      const sentBody = JSON.parse(options.body);
      expect(sentBody.stream).toBeUndefined();
    });
  });
});
