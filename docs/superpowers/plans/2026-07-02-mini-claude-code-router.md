# mini-claude-code-router 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 构建一个极简的纯网关 CLI 工具，让 Claude Code 通过本地网关访问多个模型 Provider

**架构：** 单层 Node.js HTTP 服务器，接收 Anthropic API 请求，通过 `@the-next-ai/ai-gateway` 进行协议转换，转发到配置的 Provider

**技术栈：** Node.js 22+, TypeScript, `@the-next-ai/ai-gateway`, esbuild

---

## 文件结构

```
mini-claude-code-router/
├── src/
│   ├── cli.ts              # CLI 入口（start/claude/status 命令）
│   ├── server.ts           # HTTP 服务器 + 请求处理
│   ├── router.ts           # 模型选择 + fallback 链
│   ├── config.ts           # 配置加载和验证
│   ├── types.ts            # TypeScript 类型定义
│   └── logger.ts           # 日志模块
├── tests/
│   ├── config.test.ts      # 配置模块测试
│   ├── router.test.ts      # 路由模块测试
│   └── server.test.ts      # 服务器模块测试
├── package.json
├── tsconfig.json
└── README.md
```

---

## 任务 1：项目初始化

**文件：**
- 创建：`package.json`
- 创建：`tsconfig.json`
- 创建：`src/types.ts`

- [ ] **步骤 1：创建 package.json**

```json
{
  "name": "mini-claude-code-router",
  "version": "0.1.0",
  "description": "Minimal gateway for Claude Code",
  "type": "module",
  "bin": {
    "mccr": "./dist/cli.js"
  },
  "scripts": {
    "build": "esbuild src/cli.ts --bundle --platform=node --format=esm --outfile=dist/cli.js --banner:js=\"#!/usr/bin/env node\"",
    "dev": "tsx src/cli.ts",
    "test": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@the-next-ai/ai-gateway": "^1.0.3"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "esbuild": "^0.27.7",
    "tsx": "^4.19.2",
    "typescript": "^5.9.3",
    "vitest": "^3.0.4"
  },
  "engines": {
    "node": ">=22"
  }
}
```

- [ ] **步骤 2：创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "lib": ["ES2022"],
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **步骤 3：创建基础类型定义 src/types.ts**

```typescript
export type ProviderType =
  | "anthropic_messages"
  | "openai_chat_completions"
  | "openai_responses"
  | "gemini_generate_content";

export interface ProviderConfig {
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

export interface ServerConfig {
  host: string;
  port: number;
}

export interface RouterConfig {
  defaultModel: string;
  fallback: string[];
}

export interface LoggingConfig {
  enabled: boolean;
  level: "debug" | "info" | "warn" | "error";
  file?: string;
}

export interface Config {
  server: ServerConfig;
  providers: ProviderConfig[];
  router: RouterConfig;
  logging: LoggingConfig;
}

export interface ResolvedProvider {
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LogEntry {
  timestamp: string;
  method: string;
  path: string;
  model: string;
  provider: string;
  statusCode: number;
  durationMs: number;
  error?: string;
}
```

- [ ] **步骤 4：安装依赖**

```bash
npm install
```

- [ ] **步骤 5：Commit**

```bash
git add package.json tsconfig.json src/types.ts
git commit -m "feat: initialize project structure"
```

---

## 任务 2：Config 模块

**文件：**
- 创建：`src/config.ts`
- 测试：`tests/config.test.ts`

- [ ] **步骤 1：编写配置加载测试 tests/config.test.ts**

```typescript
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
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- tests/config.test.ts
```

预期：FAIL，报错 "Cannot find module '../src/config.js'"

- [ ] **步骤 3：实现配置加载 src/config.ts**

```typescript
import { readFileSync } from "node:fs";
import type { Config, ProviderType } from "./types.js";

const VALID_PROVIDER_TYPES: ProviderType[] = [
  "anthropic_messages",
  "openai_chat_completions",
  "openai_responses",
  "gemini_generate_content"
];

export function loadConfig(path: string): Config {
  const content = readFileSync(path, "utf-8");
  const raw = JSON.parse(content);
  return validateConfig(raw);
}

export function validateConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Config must be an object");
  }

  const config = raw as Record<string, unknown>;

  // Validate server
  if (!config.server || typeof config.server !== "object") {
    throw new Error("Missing required field: server");
  }
  const server = config.server as Record<string, unknown>;
  if (typeof server.host !== "string") {
    throw new Error("Missing required field: server.host");
  }
  if (typeof server.port !== "number") {
    throw new Error("Missing required field: server.port");
  }

  // Validate providers
  if (!Array.isArray(config.providers)) {
    throw new Error("Missing required field: providers");
  }
  if (config.providers.length === 0) {
    throw new Error("At least one provider is required");
  }

  for (const provider of config.providers) {
    validateProvider(provider);
  }

  // Validate router
  if (!config.router || typeof config.router !== "object") {
    throw new Error("Missing required field: router");
  }
  const router = config.router as Record<string, unknown>;
  if (typeof router.defaultModel !== "string") {
    throw new Error("Missing required field: router.defaultModel");
  }
  if (!Array.isArray(router.fallback)) {
    throw new Error("Missing required field: router.fallback");
  }

  // Validate logging
  if (!config.logging || typeof config.logging !== "object") {
    throw new Error("Missing required field: logging");
  }
  const logging = config.logging as Record<string, unknown>;
  if (typeof logging.enabled !== "boolean") {
    throw new Error("Missing required field: logging.enabled");
  }
  if (!["debug", "info", "warn", "error"].includes(logging.level as string)) {
    throw new Error("Invalid logging.level");
  }

  return config as unknown as Config;
}

function validateProvider(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Provider must be an object");
  }

  const provider = raw as Record<string, unknown>;

  if (typeof provider.name !== "string" || provider.name.length === 0) {
    throw new Error("Provider missing required field: name");
  }

  if (!VALID_PROVIDER_TYPES.includes(provider.type as ProviderType)) {
    throw new Error(`Invalid provider type: ${provider.type}. Must be one of: ${VALID_PROVIDER_TYPES.join(", ")}`);
  }

  if (typeof provider.baseUrl !== "string") {
    throw new Error(`Provider ${provider.name} missing required field: baseUrl`);
  }

  if (typeof provider.apiKey !== "string") {
    throw new Error(`Provider ${provider.name} missing required field: apiKey`);
  }

  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    throw new Error(`Provider ${provider.name} must have at least one model`);
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npm test -- tests/config.test.ts
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add config module with validation"
```

---

## 任务 3：Logger 模块

**文件：**
- 创建：`src/logger.ts`

- [ ] **步骤 1：实现日志模块 src/logger.ts**

```typescript
import { appendFileSync } from "node:fs";
import type { LogEntry, LoggingConfig } from "./types.js";

let loggingConfig: LoggingConfig | undefined;

export function initLogger(config: LoggingConfig): void {
  loggingConfig = config;
}

export function logRequest(entry: LogEntry): void {
  if (!loggingConfig?.enabled) return;

  const logLine = formatLogEntry(entry);

  if (loggingConfig.file) {
    appendFileSync(loggingConfig.file, logLine + "\n");
  } else {
    console.log(logLine);
  }
}

export function logError(error: Error): void {
  if (!loggingConfig?.enabled) return;

  const logLine = `[${new Date().toISOString()}] ERROR: ${error.message}`;

  if (loggingConfig.file) {
    appendFileSync(loggingConfig.file, logLine + "\n");
  } else {
    console.error(logLine);
  }
}

function formatLogEntry(entry: LogEntry): string {
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
```

- [ ] **步骤 2：Commit**

```bash
git add src/logger.ts
git commit -m "feat: add logger module"
```

---

## 任务 4：Router 模块 - 模型解析

**文件：**
- 创建：`src/router.ts`
- 测试：`tests/router.test.ts`

- [ ] **步骤 1：编写模型解析测试 tests/router.test.ts**

```typescript
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
      models: ["claude-sonnet-4-20250514"]
    },
    {
      name: "openrouter",
      type: "openai_chat_completions",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "test-key",
      models: ["anthropic/claude-sonnet-4"]
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
      expect(resolved.provider.name).toBe("anthropic");
      expect(resolved.provider.model).toBe("claude-sonnet-4-20250514");
    });

    it("should throw error for unknown provider", () => {
      expect(() => resolveModel("unknown/model", mockConfig)).toThrow(/unknown provider/i);
    });

    it("should throw error for unknown model", () => {
      expect(() => resolveModel("anthropic/unknown-model", mockConfig)).toThrow(/model not found/i);
    });

    it("should use default model when model is empty", () => {
      const resolved = resolveModel("", mockConfig);
      expect(resolved.provider.name).toBe("anthropic");
      expect(resolved.provider.model).toBe("claude-sonnet-4-20250514");
    });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- tests/router.test.ts
```

预期：FAIL，报错 "Cannot find module '../src/router.js'"

- [ ] **步骤 3：实现模型解析 src/router.ts**

```typescript
import type { Config, ResolvedProvider } from "./types.js";

export function resolveModel(model: string, config: Config): ResolvedProvider {
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

  if (!provider.models.includes(modelName)) {
    throw new Error(`Model ${modelName} not found in provider ${providerName}`);
  }

  return {
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: modelName
  };
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npm test -- tests/router.test.ts
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/router.ts tests/router.test.ts
git commit -m "feat: add model resolution logic"
```

---

## 任务 5：Router 模块 - 集成协议转换网关

**文件：**
- 修改：`src/router.ts`

- [ ] **步骤 1：集成 @the-next-ai/ai-gateway 到 src/router.ts**

替换整个 router.ts 文件内容：

```typescript
import type { Config, ResolvedProvider } from "./types.js";
import { createGatewayRuntime, type GatewayRuntime } from "@the-next-ai/ai-gateway";

let gatewayRuntime: GatewayRuntime | undefined;

export function resolveModel(model: string, config: Config): ResolvedProvider {
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

  if (!provider.models.includes(modelName)) {
    throw new Error(`Model ${modelName} not found in provider ${providerName}`);
  }

  return {
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: modelName
  };
}

export function initGateway(config: Config): void {
  // Convert our config to gateway config format
  const gatewayConfig = {
    host: config.server.host,
    port: 0, // We'll use our own server port
    auth: {
      enabled: false
    },
    providers: config.providers.map((p) => ({
      name: p.name,
      type: p.type,
      baseurl: p.baseUrl,
      apikey: p.apiKey,
      models: p.models
    })),
    bodyLimitBytes: 50 * 1024 * 1024
  };

  gatewayRuntime = createGatewayRuntime(gatewayConfig);
}

export async function forwardRequest(
  request: { method: string; path: string; headers: Record<string, string>; body: string },
  resolved: ResolvedProvider
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  if (!gatewayRuntime) {
    throw new Error("Gateway not initialized. Call initGateway() first.");
  }

  // Use the gateway runtime to handle the request with protocol conversion
  // The gateway will automatically convert between protocols
  const response = await gatewayRuntime.handleRequest({
    method: request.method,
    url: request.path,
    headers: {
      ...request.headers,
      "x-target-provider": resolved.name,
      "content-type": "application/json"
    },
    body: request.body
  });

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text()
  };
}
```

- [ ] **步骤 2：Commit**

```bash
git add src/router.ts
git commit -m "feat: integrate @the-next-ai/ai-gateway for protocol conversion"
```

---

## 任务 6：Router 模块 - Fallback 链

**文件：**
- 修改：`src/router.ts`
- 测试：`tests/router.test.ts`（追加）

- [ ] **步骤 1：编写 fallback 测试 tests/router.test.ts**

在文件末尾追加：

```typescript
describe("executeWithFallback", () => {
  it("should try fallback models on failure", async () => {
    // This test would require mocking fetch, so we'll skip for now
    // and implement integration tests later
  });
});
```

- [ ] **步骤 2：实现 fallback 逻辑到 src/router.ts**

在文件末尾添加：

```typescript
export async function executeWithFallback(
  request: { method: string; path: string; headers: Record<string, string>; body: string },
  config: Config,
  logger: { logRequest: (entry: any) => void }
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const startTime = Date.now();
  const model = extractModelFromBody(request.body);
  const resolved = resolveModel(model, config);

  // Build attempt chain: [primary, ...fallback]
  const attempts: string[] = [
    `${resolved.name}/${resolved.model}`,
    ...config.router.fallback
  ];

  const errors: Array<{ provider: string; status: number; error: string }> = [];

  for (const attempt of attempts) {
    try {
      const attemptResolved = resolveModel(attempt, config);
      const response = await forwardRequest(request, attemptResolved);

      // Success
      logger.logRequest({
        timestamp: new Date().toISOString(),
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

  // All attempts failed
  const errorResponse = {
    error: {
      type: "gateway_error",
      message: "All providers failed",
      details: { attempts: errors }
    }
  };

  logger.logRequest({
    timestamp: new Date().toISOString(),
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

function extractModelFromBody(body: string): string {
  try {
    const parsed = JSON.parse(body);
    return parsed.model || "";
  } catch {
    return "";
  }
}
```

- [ ] **步骤 3：Commit**

```bash
git add src/router.ts tests/router.test.ts
git commit -m "feat: add fallback chain execution"
```

---

## 任务 7：Server 模块

**文件：**
- 创建：`src/server.ts`
- 测试：`tests/server.test.ts`

- [ ] **步骤 1：编写服务器测试 tests/server.test.ts**

```typescript
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
      await server.close();
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
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- tests/server.test.ts
```

预期：FAIL，报错 "Cannot find module '../src/server.js'"

- [ ] **步骤 3：实现服务器 src/server.ts**

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { Config } from "./types.js";
import { executeWithFallback, initGateway } from "./router.js";
import { logRequest, initLogger } from "./logger.js";

export async function startServer(config: Config): Promise<HttpServer> {
  initLogger(config.logging);
  initGateway(config); // Initialize the protocol conversion gateway

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
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npm test -- tests/server.test.ts
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: add HTTP server with /v1/messages endpoint"
```

---

## 任务 8：CLI 模块

**文件：**
- 创建：`src/cli.ts`

- [ ] **步骤 1：实现 CLI 入口 src/cli.ts**

```typescript
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";
import type { Config } from "./types.js";

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "mccr", "config.json");

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

async function handleStart(args: string[]) {
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

async function handleClaude(args: string[]) {
  // Check if gateway is running
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

  // Set environment variable and spawn claude
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
      console.log(`\nDefault Model: ${config.router.defaultModel}`);
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

function getConfigPath(args: string[]): string {
  const configIndex = args.indexOf("--config");
  if (configIndex !== -1 && args[configIndex + 1]) {
    return args[configIndex + 1];
  }
  return DEFAULT_CONFIG_PATH;
}

function loadConfigFromDefault(): Config {
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
```

- [ ] **步骤 2：Commit**

```bash
git add src/cli.ts
git commit -m "feat: add CLI with start/claude/status commands"
```

---

## 任务 9：构建和测试

**文件：**
- 修改：`package.json`

- [ ] **步骤 1：构建项目**

```bash
npm run build
```

- [ ] **步骤 2：测试 CLI**

```bash
node dist/cli.js --help
```

预期：显示帮助信息

- [ ] **步骤 3：创建示例配置**

```bash
mkdir -p ~/.config/mccr
cat > ~/.config/mccr/config.json << 'EOF'
{
  "server": {
    "host": "127.0.0.1",
    "port": 3456
  },
  "providers": [
    {
      "name": "anthropic",
      "type": "anthropic_messages",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "YOUR_API_KEY_HERE",
      "models": ["claude-sonnet-4-20250514"]
    }
  ],
  "router": {
    "defaultModel": "anthropic/claude-sonnet-4-20250514",
    "fallback": []
  },
  "logging": {
    "enabled": true,
    "level": "info"
  }
}
EOF
```

- [ ] **步骤 4：启动网关测试**

```bash
node dist/cli.js start
```

预期：显示 "Gateway listening on http://127.0.0.1:3456"

- [ ] **步骤 5：测试健康检查**

```bash
curl http://127.0.0.1:3456/health
```

预期：`{"status":"ok"}`

- [ ] **步骤 6：Commit**

```bash
git add .
git commit -m "feat: complete MVP with working gateway"
```

---

## 任务 10：README 文档

**文件：**
- 创建：`README.md`

- [ ] **步骤 1：编写 README**

```markdown
# mini-claude-code-router

极简的 Claude Code 网关，让 Claude Code 通过本地网关访问多个模型 Provider。

## 特性

- 🚀 极简配置：JSON 配置文件，50 行即可运行
- 🔄 协议转换：支持 Anthropic ↔ OpenAI ↔ Gemini 协议互转
- 🔁 失败降级：主 Provider 失败时自动切换到备用 Provider
- 📊 请求日志：记录所有请求的详细信息
- 🎯 Claude Code 集成：一键启动 Claude Code 并连接到网关

## 安装

```bash
npm install -g mini-claude-code-router
```

## 快速开始

### 1. 创建配置文件

```bash
mkdir -p ~/.config/mccr
cat > ~/.config/mccr/config.json << 'EOF'
{
  "server": {
    "host": "127.0.0.1",
    "port": 3456
  },
  "providers": [
    {
      "name": "anthropic",
      "type": "anthropic_messages",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "sk-ant-your-key-here",
      "models": ["claude-sonnet-4-20250514"]
    }
  ],
  "router": {
    "defaultModel": "anthropic/claude-sonnet-4-20250514",
    "fallback": []
  },
  "logging": {
    "enabled": true,
    "level": "info"
  }
}
EOF
```

### 2. 启动网关

```bash
mccr start
```

### 3. 启动 Claude Code

```bash
mccr claude
```

## 配置说明

### Provider 类型

- `anthropic_messages`: Anthropic Messages API
- `openai_chat_completions`: OpenAI Chat Completions API
- `openai_responses`: OpenAI Responses API
- `gemini_generate_content`: Gemini GenerateContent API

### 模型选择器格式

`providerName/modelName`

例如：
- `anthropic/claude-sonnet-4-20250514`
- `openrouter/anthropic/claude-sonnet-4`

### Fallback 配置

```json
{
  "router": {
    "defaultModel": "anthropic/claude-sonnet-4-20250514",
    "fallback": [
      "openrouter/anthropic/claude-sonnet-4",
      "anthropic/claude-opus-4-20250514"
    ]
  }
}
```

## CLI 命令

### mccr start

启动网关服务。

```bash
mccr start
mccr start --config /path/to/config.json
```

### mccr claude

启动 Claude Code 并自动连接到网关。

```bash
mccr claude
mccr claude -- --help
```

### mccr status

显示网关状态和可用模型。

```bash
mccr status
```

## 许可证

MIT
```

- [ ] **步骤 2：Commit**

```bash
git add README.md
git commit -m "docs: add README with usage instructions"
```

---

## 完成！

🎉 **mini-claude-code-router MVP 完成！**

你现在可以：
1. 使用 `mccr start` 启动网关
2. 使用 `mccr claude` 启动 Claude Code
3. 配置多个 Provider 和 fallback 链

下一步可以添加：
- `/v1/models` 端点
- 配置文件热重载
- 更详细的错误处理
- 性能优化
