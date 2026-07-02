import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { Config } from "./types.js";
import { executeWithFallback } from "./router.js";
import { logRequest, initLogger } from "./logger.js";

export async function startServer(config: Config): Promise<HttpServer> {
  initLogger(config.logging);

  const server = createServer(async (req, res) => {
    await handleRequest(req, res, config);
  });

  return new Promise((resolve) => {
    server.listen(config.server.port, config.server.host, () => {
      console.log(`Gateway listening on http://${config.server.host}:${config.server.port}`);
      resolve(server);
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method || "GET";

  // Health check
  if (path === "/health" && method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Core endpoint: POST /v1/messages
  if (path === "/v1/messages" && method === "POST") {
    const body = await readBody(req);
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
