import { describe, it, expect, vi } from "vitest";
import { resolveModel, evaluateRules } from "../src/router.js";
import type { Config, RouterRule } from "../src/types.js";

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
});
