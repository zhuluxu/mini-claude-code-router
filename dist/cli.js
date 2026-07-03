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
  const [providerName, ...modelNameParts] = config.router.defaultModel.split("/");
  const modelName = modelNameParts.join("/");
  if (!providerName || !modelName) {
    throw new Error(`Invalid default model in config: ${config.router.defaultModel}. Expected format: provider/model`);
  }
  const provider = config.providers.find((p) => p.name === providerName);
  if (!provider) {
    throw new Error(`Default provider ${providerName} not found in config`);
  }
  return {
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model
  };
}
async function forwardRequest(request, resolved) {
  let targetPath = request.path;
  if (resolved.type === "openai_chat_completions") {
    targetPath = "/v1/chat/completions";
  } else if (resolved.type === "openai_responses") {
    targetPath = "/v1/responses";
  } else if (resolved.type === "anthropic_messages") {
    targetPath = "/v1/messages";
  } else if (resolved.type === "gemini_generate_content") {
    targetPath = request.path;
  }
  const url = `${resolved.baseUrl}${targetPath}`;
  console.log(`  Forwarding to: ${url}`);
  console.log(`  Provider: ${resolved.name} (${resolved.type})`);
  console.log(`  API Key: ${resolved.apiKey.substring(0, 10)}...`);
  let bodyToSend = request.body;
  if (request.body) {
    try {
      const parsed = JSON.parse(request.body);
      if (parsed.model) {
        console.log(`  Replacing model: ${parsed.model} -> ${resolved.model}`);
        parsed.model = resolved.model;
      }
      if (resolved.type === "openai_chat_completions" || resolved.type === "openai_responses") {
        if (parsed.system) {
          const systemContent = typeof parsed.system === "string" ? parsed.system : Array.isArray(parsed.system) ? parsed.system.map((s) => s.text || s).join("\n") : "";
          if (systemContent) {
            parsed.messages = [
              { role: "system", content: systemContent },
              ...parsed.messages || []
            ];
          }
          delete parsed.system;
        }
        if (parsed.messages) {
          parsed.messages = parsed.messages.map((msg) => {
            if (Array.isArray(msg.content)) {
              const textParts = msg.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
              return { role: msg.role, content: textParts };
            }
            return msg;
          });
        }
        if (parsed.tools && Array.isArray(parsed.tools)) {
          parsed.tools = parsed.tools.map((tool) => {
            if (tool.input_schema) {
              return {
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description || "",
                  parameters: tool.input_schema
                }
              };
            }
            return tool;
          });
          console.log(`  Transformed: converted ${parsed.tools.length} tools to OpenAI format`);
        }
        if (parsed.max_tokens && !parsed.max_completion_tokens) {
          parsed.max_completion_tokens = parsed.max_tokens;
        }
        delete parsed.thinking;
        delete parsed.context_management;
        delete parsed.output_config;
        delete parsed.metadata;
        delete parsed.stream;
        console.log(`  Transformed: removed Anthropic-specific fields`);
      }
      bodyToSend = JSON.stringify(parsed);
      console.log(`  Transformed body (first 500 chars): ${bodyToSend.substring(0, 500)}`);
      console.log(`  Transformed body length: ${bodyToSend.length} bytes`);
      console.log(`  Request fields: ${Object.keys(parsed).join(", ")}`);
      if (parsed.stream) console.log(`  Stream: ${parsed.stream}`);
      if (parsed.temperature) console.log(`  Temperature: ${parsed.temperature}`);
      if (parsed.top_p) console.log(`  Top_p: ${parsed.top_p}`);
      if (parsed.tools) console.log(`  Tools count: ${parsed.tools.length}`);
      if (parsed.messages) console.log(`  Messages count: ${parsed.messages.length}`);
    } catch {
    }
  }
  const headers = {
    ...request.headers,
    "content-type": "application/json"
  };
  delete headers["x-api-key"];
  delete headers["authorization"];
  delete headers["anthropic-version"];
  delete headers["content-length"];
  if (resolved.type === "anthropic_messages") {
    headers["x-api-key"] = resolved.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    console.log(`  Auth: x-api-key`);
  } else {
    headers["authorization"] = `Bearer ${resolved.apiKey}`;
    console.log(`  Auth: Bearer token`);
  }
  if (request.method !== "GET" && bodyToSend) {
    headers["content-length"] = String(Buffer.byteLength(bodyToSend, "utf8"));
  }
  let response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers,
      body: request.method !== "GET" ? bodyToSend : void 0
    });
  } catch (error) {
    console.error(`  Fetch error type: ${error?.constructor?.name}`);
    console.error(`  Fetch error message: ${error?.message}`);
    if (error?.cause) {
      console.error(`  Fetch error cause: ${JSON.stringify(error.cause, null, 2)}`);
    }
    console.error(`  Full error: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`);
    throw error;
  }
  const responseBody = await response.text();
  const responseHeaders = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  let usage = void 0;
  try {
    const parsed = JSON.parse(responseBody);
    if (parsed.usage) {
      usage = {
        inputTokens: parsed.usage.input_tokens || parsed.usage.prompt_tokens,
        outputTokens: parsed.usage.output_tokens || parsed.usage.completion_tokens,
        cacheCreationInputTokens: parsed.usage.cache_creation_input_tokens,
        cacheReadInputTokens: parsed.usage.cache_read_input_tokens
      };
    }
  } catch {
  }
  if (response.status !== 200) {
    console.log(`  Response status: ${response.status}`);
    console.log(`  Response body: ${responseBody.substring(0, 500)}`);
  }
  return {
    status: response.status,
    headers: responseHeaders,
    body: responseBody,
    usage
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
        durationMs: Date.now() - startTime,
        usage: response.usage
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
var totalTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  requestCount: 0
};
function initLogger(config) {
  loggingConfig = config;
}
function logRequest(entry) {
  if (!loggingConfig?.enabled) return;
  if (entry.usage) {
    if (entry.usage.inputTokens) totalTokens.inputTokens += entry.usage.inputTokens;
    if (entry.usage.outputTokens) totalTokens.outputTokens += entry.usage.outputTokens;
    if (entry.usage.cacheCreationInputTokens) totalTokens.cacheCreationInputTokens += entry.usage.cacheCreationInputTokens;
    if (entry.usage.cacheReadInputTokens) totalTokens.cacheReadInputTokens += entry.usage.cacheReadInputTokens;
    totalTokens.requestCount++;
  }
  const logLine = formatLogEntry(entry);
  if (loggingConfig.file) {
    appendFileSync(loggingConfig.file, logLine + "\n");
  } else {
    console.log(logLine);
    if (totalTokens.requestCount % 10 === 0 && totalTokens.requestCount > 0) {
      console.log(`
\u{1F4CA} Cumulative Token Usage (last ${totalTokens.requestCount} requests):`);
      console.log(`   Input tokens: ${totalTokens.inputTokens.toLocaleString()}`);
      console.log(`   Output tokens: ${totalTokens.outputTokens.toLocaleString()}`);
      if (totalTokens.cacheCreationInputTokens > 0) {
        console.log(`   Cache creation: ${totalTokens.cacheCreationInputTokens.toLocaleString()}`);
      }
      if (totalTokens.cacheReadInputTokens > 0) {
        console.log(`   Cache read: ${totalTokens.cacheReadInputTokens.toLocaleString()}`);
      }
      console.log(`   Total: ${(totalTokens.inputTokens + totalTokens.outputTokens).toLocaleString()} tokens
`);
    }
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
  if (entry.usage) {
    const usageStr = [];
    if (entry.usage.inputTokens) usageStr.push(`in=${entry.usage.inputTokens}`);
    if (entry.usage.outputTokens) usageStr.push(`out=${entry.usage.outputTokens}`);
    if (entry.usage.cacheCreationInputTokens) usageStr.push(`cache_create=${entry.usage.cacheCreationInputTokens}`);
    if (entry.usage.cacheReadInputTokens) usageStr.push(`cache_read=${entry.usage.cacheReadInputTokens}`);
    if (usageStr.length > 0) {
      parts.push(`tokens=[${usageStr.join(", ")}]`);
    }
  }
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
  console.log(`Checking gateway at ${endpoint}...`);
  try {
    const response = await fetch(`${endpoint}/health`);
    if (!response.ok) {
      throw new Error("Gateway not responding");
    }
    console.log("\u2713 Gateway is running");
  } catch (error) {
    console.error("\u2717 Gateway is not running. Start it with: mccr start");
    process.exit(1);
  }
  console.log(`
Starting Claude Code with:`);
  console.log(`  ANTHROPIC_BASE_URL=${endpoint}`);
  console.log(`  ANTHROPIC_API_KEY=${config.providers[0]?.apiKey.substring(0, 10)}...`);
  console.log(`Passing arguments: ${args.join(" ") || "(none)"}
`);
  process.env.ANTHROPIC_BASE_URL = endpoint;
  process.env.ANTHROPIC_API_KEY = config.providers[0]?.apiKey || "mccr-gateway";
  const { spawn } = await import("node:child_process");
  const claude = spawn("claude", args, {
    stdio: "inherit",
    env: process.env
  });
  claude.on("error", (error) => {
    console.error("Failed to start Claude Code:", error.message);
    process.exit(1);
  });
  claude.on("exit", (code) => {
    console.log(`
Claude Code exited with code ${code}`);
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
        console.log(`  - ${provider.name}/${provider.model}`);
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
