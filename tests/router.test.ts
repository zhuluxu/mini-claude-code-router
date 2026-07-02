import { describe, it, expect } from "vitest";
import { resolveModel } from "../src/router.js";
import type { Config } from "../src/types.js";

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

    it("should throw error for unknown provider", () => {
      expect(() => resolveModel("unknown/model", mockConfig)).toThrow(/unknown provider/i);
    });

    it("should throw error for unknown model", () => {
      expect(() => resolveModel("anthropic/unknown-model", mockConfig)).toThrow(/model not found/i);
    });

    it("should use default model when model is empty", () => {
      const resolved = resolveModel("", mockConfig);
      expect(resolved.name).toBe("anthropic");
      expect(resolved.model).toBe("claude-sonnet-4-20250514");
    });
  });
});
