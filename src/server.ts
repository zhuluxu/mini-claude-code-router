import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { Config } from "./types.js";
import { executeWithFallback } from "./router.js";
import { logRequest, initLogger } from "./logger.js";

export async function startServer(config: Config): Promise<HttpServer> {
  initLogger(config.logging);

  // Print startup information
  printStartupInfo(config);

  const server = createServer(async (req, res) => {
    await handleRequest(req, res, config);
  });

  return new Promise((resolve) => {
    server.listen(config.server.port, config.server.host, () => {
      console.log(`\nGateway listening on http://${config.server.host}:${config.server.port}`);
      console.log("Ready to accept requests.\n");
      resolve(server);
    });
  });
}

function printStartupInfo(config: Config): void {
  console.log("=".repeat(60));
  console.log("Mini Claude Code Router - Starting");
  console.log("=".repeat(60));
  console.log(`\nServer: http://${config.server.host}:${config.server.port}`);
  console.log(`Default Model: ${config.router.defaultModel}`);

  console.log("\nProviders:");
  for (const provider of config.providers) {
    console.log(`  - ${provider.name} (${provider.type})`);
    console.log(`    Base URL: ${provider.baseUrl}`);
    console.log(`    API Key: ${provider.apiKey.substring(0, 3)}...`);
    console.log(`    Models: ${provider.models.join(", ")}`);
  }

  if (config.router.fallback.length > 0) {
    console.log("\nFallback Chain:");
    config.router.fallback.forEach((model, i) => {
      console.log(`  ${i + 1}. ${model}`);
    });
  }

  console.log(`\nLogging: ${config.logging.enabled ? "enabled" : "disabled"} (${config.logging.level})`);
  console.log("=".repeat(60));
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method || "GET";

  // Log ALL incoming requests
  console.log(`\n[${new Date().toISOString()}] Request: ${method} ${path}`);

  // Health check
  if (path === "/health" && method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Models list endpoint
  if (path === "/v1/models" && method === "GET") {
    const models = config.providers.flatMap((provider) =>
      provider.models.map((model) => ({
        id: `${provider.name}/${model}`,
        object: "model",
        created: Date.now(),
        owned_by: provider.name
      }))
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: models }));
    return;
  }

  // Core endpoint: POST /v1/messages
  if (path === "/v1/messages" && method === "POST") {
    console.log(`\n[${new Date().toISOString()}] Incoming request: ${method} ${path}`);
    const body = await readBody(req);

    // Parse and log the model being requested
    try {
      const parsed = JSON.parse(body);
      console.log(`  Requested model: ${parsed.model || "not specified"}`);
    } catch {
      console.log("  Could not parse request body");
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        headers[key] = value;
      }
    }

    const response = await executeWithFallback(
      { method, path, headers, body },
      config,
      { logRequest }
    );

    console.log(`  Response status: ${response.status}`);
    res.writeHead(response.status, response.headers);
    res.end(response.body);
    return;
  }

  // 404 for other routes
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found" } }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
