#!/usr/bin/env node

// src/cli.ts
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

// src/config.ts
import { readFileSync } from "node:fs";
var VALID_PROVIDER_TYPES = [
  "anthropic_messages",
  "openai_chat_completions",
  "openai_responses",
  "gemini_generate_content"
];
function loadConfig(path) {
  const content = readFileSync(path, "utf-8");
  const expanded = expandEnvVars(content);
  const raw = JSON.parse(expanded);
  return validateConfig(raw);
}
function expandEnvVars(content) {
  return content.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const value = process.env[varName];
    if (value === void 0) {
      throw new Error(`Environment variable ${varName} is not set`);
    }
    return value;
  });
}
function validateConfig(raw) {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Config must be an object");
  }
  const config = raw;
  if (!config.server || typeof config.server !== "object") {
    throw new Error("Missing required field: server");
  }
  const server = config.server;
  if (typeof server.host !== "string") {
    throw new Error("Missing required field: server.host");
  }
  if (typeof server.port !== "number") {
    throw new Error("Missing required field: server.port");
  }
  if (!Array.isArray(config.providers)) {
    throw new Error("Missing required field: providers");
  }
  if (config.providers.length === 0) {
    throw new Error("At least one provider is required");
  }
  for (const provider of config.providers) {
    validateProvider(provider);
  }
  if (!config.router || typeof config.router !== "object") {
    throw new Error("Missing required field: router");
  }
  const router = config.router;
  if (typeof router.defaultModel !== "string") {
    throw new Error("Missing required field: router.defaultModel");
  }
  if (!Array.isArray(router.fallback)) {
    throw new Error("Missing required field: router.fallback");
  }
  if (!config.logging || typeof config.logging !== "object") {
    throw new Error("Missing required field: logging");
  }
  const logging = config.logging;
  if (typeof logging.enabled !== "boolean") {
    throw new Error("Missing required field: logging.enabled");
  }
  if (!["debug", "info", "warn", "error"].includes(logging.level)) {
    throw new Error("Invalid logging.level");
  }
  return config;
}
function validateProvider(raw) {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Provider must be an object");
  }
  const provider = raw;
  if (typeof provider.name !== "string" || provider.name.length === 0) {
    throw new Error("Provider missing required field: name");
  }
  if (!VALID_PROVIDER_TYPES.includes(provider.type)) {
    throw new Error(`Invalid provider type: ${provider.type}. Must be one of: ${VALID_PROVIDER_TYPES.join(", ")}`);
  }
  if (typeof provider.baseUrl !== "string") {
    throw new Error(`Provider ${provider.name} missing required field: baseUrl`);
  }
  if (typeof provider.apiKey !== "string") {
    throw new Error(`Provider ${provider.name} missing required field: apiKey`);
  }
  if (typeof provider.model !== "string" || provider.model.length === 0) {
    throw new Error(`Provider ${provider.name} missing required field: model`);
  }
}

// src/server.ts
import { createServer } from "node:http";

// src/router.ts
function resolveModel(model, config) {
  const modelSelector = model || config.router.defaultModel;
  const [providerName, ...modelNameParts] = modelSelector.split("/");
  const modelName = modelNameParts.join("/");
  if (!providerName || !modelName) {
    throw new Error(`Invalid model selector: ${modelSelector}. Expected format: provider/model`);
  }
  const provider = config.providers.find((p) => p.name === providerName);
  if (!provider) {
    throw new Error(`Unknown provider: ${providerName}`);
  }
  if (provider.model !== modelName) {
    throw new Error(`Model ${modelName} not found in provider ${providerName}. Available: ${provider.model}`);
  }
  return {
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: modelName
  };
}
async function forwardRequest(request, resolved) {
  const url = `${resolved.baseUrl}${request.path}`;
  const headers = {
    ...request.headers,
    "content-type": "application/json"
  };
  if (resolved.type === "anthropic_messages") {
    headers["x-api-key"] = resolved.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["authorization"] = `Bearer ${resolved.apiKey}`;
  }
  const response = await fetch(url, {
    method: request.method,
    headers,
    body: request.method !== "GET" ? request.body : void 0
  });
  const responseBody = await response.text();
  const responseHeaders = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  return {
    status: response.status,
    headers: responseHeaders,
    body: responseBody
  };
}
async function executeWithFallback(request, config, logger) {
  const startTime = Date.now();
  const model = extractModelFromBody(request.body);
  const resolved = resolveModel(model, config);
  const attempts = [
    `${resolved.name}/${resolved.model}`,
    ...config.router.fallback
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      const attemptResolved = resolveModel(attempt, config);
      const response = await forwardRequest(request, attemptResolved);
      logger.logRequest({
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        method: request.method,
        path: request.path,
        model: attempt,
        provider: attemptResolved.name,
        statusCode: response.status,
        durationMs: Date.now() - startTime
      });
      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push({
        provider: attempt,
        status: 0,
        error: errorMessage
      });
    }
  }
  const errorResponse = {
    error: {
      type: "gateway_error",
      message: "All providers failed",
      details: { attempts: errors }
    }
  };
  logger.logRequest({
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    method: request.method,
    path: request.path,
    model,
    provider: "all",
    statusCode: 502,
    durationMs: Date.now() - startTime,
    error: "All providers failed"
  });
  return {
    status: 502,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(errorResponse)
  };
}
function extractModelFromBody(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed.model || "";
  } catch {
    return "";
  }
}

// src/logger.ts
import { appendFileSync } from "node:fs";
var loggingConfig;
function initLogger(config) {
  loggingConfig = config;
}
function logRequest(entry) {
  if (!loggingConfig?.enabled) return;
  const logLine = formatLogEntry(entry);
  if (loggingConfig.file) {
    appendFileSync(loggingConfig.file, logLine + "\n");
  } else {
    console.log(logLine);
  }
}
function formatLogEntry(entry) {
  const parts = [
    `[${entry.timestamp}]`,
    `${entry.method} ${entry.path}`,
    `model=${entry.model}`,
    `provider=${entry.provider}`,
    `status=${entry.statusCode}`,
    `duration=${entry.durationMs}ms`
  ];
  if (entry.error) {
    parts.push(`error=${entry.error}`);
  }
  return parts.join(" ");
}

// src/server.ts
async function startServer(config) {
  initLogger(config.logging);
  printStartupInfo(config);
  const server = createServer(async (req, res) => {
    await handleRequest(req, res, config);
  });
  return new Promise((resolve) => {
    server.listen(config.server.port, config.server.host, () => {
      console.log(`
Gateway listening on http://${config.server.host}:${config.server.port}`);
      console.log("Ready to accept requests.\n");
      resolve(server);
    });
  });
}
function printStartupInfo(config) {
  console.log("=".repeat(60));
  console.log("Mini Claude Code Router - Starting");
  console.log("=".repeat(60));
  console.log(`
Server: http://${config.server.host}:${config.server.port}`);
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
  console.log(`
Logging: ${config.logging.enabled ? "enabled" : "disabled"} (${config.logging.level})`);
  console.log("=".repeat(60));
}
async function handleRequest(req, res, config) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method || "GET";
  console.log(`
[${(/* @__PURE__ */ new Date()).toISOString()}] Request: ${method} ${path}`);
  if (path === "/health" && method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
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
  if (path === "/v1/messages" && method === "POST") {
    console.log(`
[${(/* @__PURE__ */ new Date()).toISOString()}] Incoming request: ${method} ${path}`);
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body);
      console.log(`  Requested model: ${parsed.model || "not specified"}`);
    } catch {
      console.log("  Could not parse request body");
    }
    const headers = {};
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
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found" } }));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// src/cli.ts
var DEFAULT_CONFIG_PATH = join(homedir(), ".config", "mccr", "config.json");
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  switch (command) {
    case "start":
      await handleStart(args.slice(1));
      break;
    case "claude":
      await handleClaude(args.slice(1));
      break;
    case "status":
      await handleStatus();
      break;
    default:
      printUsage();
      process.exit(1);
  }
}
async function handleStart(args) {
  const configPath = getConfigPath(args);
  if (!existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    console.error("Create a config file or use --config to specify a path");
    process.exit(1);
  }
  const config = loadConfig(configPath);
  console.log(`Loaded config from ${configPath}`);
  await startServer(config);
}
async function handleClaude(args) {
  const config = loadConfigFromDefault();
  const endpoint = `http://${config.server.host}:${config.server.port}`;
  try {
    const response = await fetch(`${endpoint}/health`);
    if (!response.ok) {
      throw new Error("Gateway not responding");
    }
  } catch (error) {
    console.error("Gateway is not running. Start it with: mccr start");
    process.exit(1);
  }
  console.log(`Gateway is running at ${endpoint}`);
  console.log("Starting Claude Code...");
  process.env.ANTHROPIC_BASE_URL = endpoint;
  const { spawn } = await import("node:child_process");
  const claude = spawn("claude", args, {
    stdio: "inherit",
    env: process.env
  });
  claude.on("exit", (code) => {
    process.exit(code || 0);
  });
}
async function handleStatus() {
  const config = loadConfigFromDefault();
  const endpoint = `http://${config.server.host}:${config.server.port}`;
  try {
    const response = await fetch(`${endpoint}/health`);
    if (response.ok) {
      console.log("Gateway Status: Running");
      console.log(`Endpoint: ${endpoint}`);
      console.log("\nAvailable Models:");
      for (const provider of config.providers) {
        for (const model of provider.models) {
          console.log(`  - ${provider.name}/${model}`);
        }
      }
      console.log(`
Default Model: ${config.router.defaultModel}`);
      if (config.router.fallback.length > 0) {
        console.log("Fallback Chain:");
        config.router.fallback.forEach((model, i) => {
          console.log(`  ${i + 1}. ${model}`);
        });
      }
    } else {
      console.log("Gateway Status: Not responding");
    }
  } catch {
    console.log("Gateway Status: Not running");
  }
}
function getConfigPath(args) {
  const configIndex = args.indexOf("--config");
  if (configIndex !== -1 && args[configIndex + 1]) {
    return args[configIndex + 1];
  }
  return DEFAULT_CONFIG_PATH;
}
function loadConfigFromDefault() {
  if (!existsSync(DEFAULT_CONFIG_PATH)) {
    console.error(`Config file not found: ${DEFAULT_CONFIG_PATH}`);
    process.exit(1);
  }
  return loadConfig(DEFAULT_CONFIG_PATH);
}
function printUsage() {
  console.log(`
Usage: mccr <command> [options]

Commands:
  start [--config <path>]    Start the gateway server
  claude [args...]           Start Claude Code with gateway configured
  status                     Show gateway status

Options:
  --config <path>            Path to config file (default: ~/.config/mccr/config.json)
  --help                     Show this help message

Examples:
  mccr start
  mccr start --config ./my-config.json
  mccr claude
  mccr claude -- --help
  mccr status
`);
}
main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
