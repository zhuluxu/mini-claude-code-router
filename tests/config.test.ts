import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, validateConfig } from "../src/config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `mccr-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should load valid config from JSON file", () => {
    const configPath = join(tempDir, "config.json");
    const validConfig = {
      server: { host: "127.0.0.1", port: 3456 },
      providers: [
        {
          name: "test",
          type: "anthropic_messages",
          baseUrl: "https://api.test.com",
          apiKey: "test-key",
          models: ["test-model"]
        }
      ],
      router: {
        defaultModel: "test/test-model",
        fallback: []
      },
      logging: { enabled: true, level: "info" }
    };

    writeFileSync(configPath, JSON.stringify(validConfig, null, 2));
    const config = loadConfig(configPath);

    expect(config.server.host).toBe("127.0.0.1");
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].name).toBe("test");
  });

  it("should throw error for missing required fields", () => {
    const configPath = join(tempDir, "config.json");
    const invalidConfig = {
      server: { host: "127.0.0.1" }
      // missing port, providers, router, logging
    };

    writeFileSync(configPath, JSON.stringify(invalidConfig, null, 2));

    expect(() => loadConfig(configPath)).toThrow(/missing required field/i);
  });

  it("should validate provider type", () => {
    const invalidProvider = {
      name: "test",
      type: "invalid_type",
      baseUrl: "https://api.test.com",
      apiKey: "test-key",
      models: ["test-model"]
    };

    expect(() => validateConfig({
      server: { host: "127.0.0.1", port: 3456 },
      providers: [invalidProvider],
      router: { defaultModel: "test/model", fallback: [] },
      logging: { enabled: true, level: "info" }
    })).toThrow(/invalid provider type/i);
  });

  it("should expand environment variables", () => {
    const configPath = join(tempDir, "config.json");
    const configWithEnv = {
      server: { host: "127.0.0.1", port: 3456 },
      providers: [
        {
          name: "test",
          type: "anthropic_messages",
          baseUrl: "https://api.test.com",
          apiKey: "${TEST_API_KEY}",
          models: ["test-model"]
        }
      ],
      router: {
        defaultModel: "test/test-model",
        fallback: []
      },
      logging: { enabled: true, level: "info" }
    };

    writeFileSync(configPath, JSON.stringify(configWithEnv, null, 2));

    // Set environment variable
    process.env.TEST_API_KEY = "secret-key-123";

    const config = loadConfig(configPath);
    expect(config.providers[0].apiKey).toBe("secret-key-123");

    // Clean up
    delete process.env.TEST_API_KEY;
  });

  it("should throw error for undefined environment variable", () => {
    const configPath = join(tempDir, "config.json");
    const configWithEnv = {
      server: { host: "127.0.0.1", port: 3456 },
      providers: [
        {
          name: "test",
          type: "anthropic_messages",
          baseUrl: "https://api.test.com",
          apiKey: "${UNDEFINED_VAR}",
          models: ["test-model"]
        }
      ],
      router: {
        defaultModel: "test/test-model",
        fallback: []
      },
      logging: { enabled: true, level: "info" }
    };

    writeFileSync(configPath, JSON.stringify(configWithEnv, null, 2));

    expect(() => loadConfig(configPath)).toThrow(/environment variable UNDEFINED_VAR is not set/i);
  });
});
