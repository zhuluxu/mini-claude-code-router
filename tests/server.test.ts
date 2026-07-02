import { describe, it, expect, afterAll } from "vitest";
import { startServer } from "../src/server.js";
import type { Config } from "../src/types.js";

const mockConfig: Config = {
  server: { host: "127.0.0.1", port: 0 }, // port 0 = random port
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
  logging: { enabled: false, level: "info" }
};

describe("server", () => {
  let server: any;

  afterAll(async () => {
    if (server) {
      server.close();
    }
  });

  it("should start server and respond to health check", async () => {
    server = await startServer(mockConfig);
    const address = server.address();
    const port = address.port;

    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe("ok");
  });
});
