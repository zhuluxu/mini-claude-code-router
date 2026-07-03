import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server as HttpServer } from "node:http";
import { Readable, Transform } from "node:stream";
import type { Config } from "./types.js";
import { executeWithFallback, type ForwardResult } from "./router.js";
import { logRequest, initLogger } from "./logger.js";
import { OpenAIToAnthropicSseTransformer, parseSseChunk } from "./transform.js";
import { AnthropicSseUsageExtractor } from "./sse-usage.js";

export async function startServer(config: Config): Promise<HttpServer> {
  initLogger(config.logging);

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
    console.log(`    Model: ${provider.model}`);
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

  console.log(`\n[${new Date().toISOString()}] Request: ${method} ${path}`);

  // Health check
  if (path === "/health" && method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Models list endpoint
  if (path === "/v1/models" && method === "GET") {
    const models = config.providers.map((provider) => ({
      id: `${provider.name}/${provider.model}`,
      object: "model",
      created: Date.now(),
      owned_by: provider.name
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: models }));
    return;
  }

  // Core endpoint: POST /v1/messages
  if (path === "/v1/messages" && method === "POST") {
    const body = await readBody(req);

    try {
      const parsed = JSON.parse(body);
      console.log(`  Requested model: ${parsed.model || "not specified"}`);
      if (parsed.stream) console.log(`  Stream: ${parsed.stream}`);
    } catch {
      console.log("  Could not parse request body");
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        headers[key] = value;
      }
    }

    const result = await executeWithFallback(
      { method, path, headers, body },
      config,
      { logRequest }
    );

    await writeResultToResponse(result, res, logRequest);
    return;
  }

  // 404 for other routes
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found" } }));
}

async function writeResultToResponse(
  result: ForwardResult,
  res: ServerResponse,
  logRequestFn: (entry: any) => void
): Promise<void> {
  if (result.isStreaming && result.responseStream) {
    // Streaming: pipe directly to client
    res.writeHead(result.status, result.headers);

    const nodeStream = Readable.fromWeb(
      result.responseStream as unknown as import("node:stream/web").ReadableStream
    );

    let transformer: OpenAIToAnthropicSseTransformer | null = null;
    let usageExtractor: AnthropicSseUsageExtractor | null = null;

    if (result.needsSseTransform && result.transformModel) {
      // Cross-protocol: pipe through SSE transformer (which also tracks usage)
      transformer = new OpenAIToAnthropicSseTransformer(result.transformModel);
      const transformStream = createSseTransformStream(transformer);
      nodeStream.pipe(transformStream).pipe(res);
    } else {
      // Same protocol: transparent passthrough with usage extraction
      usageExtractor = new AnthropicSseUsageExtractor();
      const usageStream = createUsagePassthroughStream(usageExtractor);
      nodeStream.pipe(usageStream).pipe(res);
    }

    // Log after stream ends (with extracted usage) or on error
    const finishLogging = (error?: string) => {
      if (!result.logContext) return;
      let usage = result.usage;
      if (transformer) {
        const tUsage = transformer.getUsage();
        usage = { inputTokens: tUsage.inputTokens, outputTokens: tUsage.outputTokens };
      } else if (usageExtractor) {
        usageExtractor.finish();
        usage = usageExtractor.getUsage();
      }
      logRequestFn({
        ...result.logContext,
        usage: usage || undefined,
        error
      });
    };

    nodeStream.on("end", () => finishLogging());
    nodeStream.on("error", (err) => finishLogging(err.message));
    res.on("close", () => {
      if (!res.writableEnded) {
        finishLogging("client disconnected");
      }
    });
    return;
  }

  // Non-streaming: write buffered body
  res.writeHead(result.status, result.headers);
  res.end(result.body);
}

function createSseTransformStream(transformer: OpenAIToAnthropicSseTransformer): Transform {
  let carry = "";

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString("utf8");
      const { lines, remainder } = parseSseChunk(text, carry);
      carry = remainder;

      for (const line of lines) {
        const events = transformer.transformDataLine(line);
        for (const event of events) {
          this.push(event);
        }
      }
      callback();
    },
    flush(callback) {
      if (carry.trim()) {
        const { lines } = parseSseChunk("\n", carry);
        for (const line of lines) {
          const events = transformer.transformDataLine(line);
          for (const event of events) {
            this.push(event);
          }
        }
      }
      callback();
    }
  });
}

function createUsagePassthroughStream(extractor: AnthropicSseUsageExtractor): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      // Feed to extractor for usage parsing, then pass chunk through unchanged
      extractor.processChunk(chunk.toString("utf8"));
      this.push(chunk);
      callback();
    },
    flush(callback) {
      extractor.finish();
      callback();
    }
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
