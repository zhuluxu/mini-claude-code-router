# mini-claude-code-router 设计规格

## 概述

将 claude-code-router（Electron 桌面应用）改造为 mini-claude-code-router（纯网关 CLI 工具），去除前端页面，仅依靠配置文件配置，让 Claude Code 通过本地网关访问多个模型 Provider。

## 核心目标

1. **极简配置**：JSON 配置文件，50-100 行即可运行
2. **纯网关**：无 UI、无数据库、无复杂状态管理
3. **协议转换**：支持 Anthropic ↔ OpenAI ↔ Gemini 协议互转
4. **失败降级**：主 Provider 失败时自动切换到备用 Provider
5. **Claude Code 集成**：提供 CLI 命令自动配置并启动 Claude Code

## 架构设计

### 技术栈

- **运行时**：Node.js 22+
- **语言**：TypeScript
- **HTTP**：原生 `node:http`
- **协议转换**：`@the-next-ai/ai-gateway` 包（作为库导入，直接调用其协议转换函数）
- **构建**：esbuild

**集成方式**：`@the-next-ai/ai-gateway` 作为库导入，而非子进程。我们直接调用其提供的协议转换 API，将 Anthropic 格式的请求转换为 OpenAI/Gemini 格式，然后转发到上游。

### 项目结构

```
mini-claude-code-router/
├── src/
│   ├── cli.ts              # CLI 入口
│   ├── server.ts           # HTTP 服务器
│   ├── router.ts           # 路由决策 + fallback
│   ├── config.ts           # 配置加载和验证
│   ├── types.ts            # 类型定义
│   └── logger.ts           # 日志模块
├── package.json
├── tsconfig.json
└── README.md
```

### 架构图

```
┌─────────────────────────────────────────────────────────────┐
│              mini-claude-code-router (mccr)                  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  CLI 命令:                                                   │
│    mccr start       # 启动网关服务                             │
│    mccr claude      # 启动 Claude Code（自动配置）             │
│    mccr status      # 查看网关状态                             │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  HTTP Server (localhost:3456)                                │
│    ├── POST /v1/messages          → 核心路由                  │
│    ├── POST /v1/messages/count_tokens → 本地计数              │
│    ├── GET  /v1/models            → 返回可用模型列表           │
│    └── GET  /health               → 健康检查                  │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  核心模块:                                                    │
│    ├── Router        → 模型选择 + fallback 链                  │
│    ├── Provider      → API Key 管理 + 请求转发                 │
│    └── Logger        → 请求日志                                │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  协议转换层 (@the-next-ai/ai-gateway)                         │
│    ├── anthropic_messages                                    │
│    ├── openai_chat_completions                               │
│    └── gemini_generate_content                               │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## 配置文件

### 文件位置

- **Linux/macOS**: `~/.config/mccr/config.json`
- **Windows**: `%APPDATA%\mccr\config.json`

### 配置结构

```json
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
      "apiKey": "sk-ant-xxx",
      "models": ["claude-sonnet-4-20250514", "claude-opus-4-20250514"]
    },
    {
      "name": "openrouter",
      "type": "openai_chat_completions",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "sk-or-xxx",
      "models": ["anthropic/claude-sonnet-4", "google/gemini-2.5-pro"]
    },
    {
      "name": "deepseek",
      "type": "openai_chat_completions",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-xxx",
      "models": ["deepseek-chat", "deepseek-reasoner"]
    }
  ],

  "router": {
    "defaultModel": "anthropic/claude-sonnet-4-20250514",
    "fallback": [
      "openrouter/anthropic/claude-sonnet-4",
      "anthropic/claude-opus-4-20250514"
    ]
  },

  "logging": {
    "enabled": true,
    "level": "info",
    "file": "~/.config/mccr/gateway.log"
  }
}
```

### 配置字段说明

#### server

- `host`: 监听地址，默认 `127.0.0.1`
- `port`: 监听端口，默认 `3456`

#### providers

数组，每个 Provider 包含：

- `name`: Provider 名称（唯一标识）
- `type`: 协议类型，可选值：
  - `anthropic_messages`: Anthropic Messages API
  - `openai_chat_completions`: OpenAI Chat Completions API
  - `openai_responses`: OpenAI Responses API
  - `gemini_generate_content`: Gemini GenerateContent API
- `baseUrl`: API 基础 URL
- `apiKey`: API 密钥
- `models`: 支持的模型列表

#### router

- `defaultModel`: 默认模型，格式 `providerName/modelName`
- `fallback`: 回退模型数组，按顺序尝试

#### logging

- `enabled`: 是否启用日志
- `level`: 日志级别（`debug` / `info` / `warn` / `error`）
- `file`: 日志文件路径（可选，不设置则输出到 stdout）

## CLI 命令

### mccr start

启动网关服务（前台运行）。

```bash
mccr start
mccr start --config /path/to/config.json  # 指定配置文件
```

### mccr claude

设置环境变量并启动 Claude Code。

```bash
mccr claude
mccr claude -- --help  # 传递参数给 claude 命令
```

**实现逻辑**：
1. 检查网关是否运行
2. 设置 `ANTHROPIC_BASE_URL=http://127.0.0.1:3456`
3. 执行 `claude` 命令

### mccr status

显示网关状态和可用模型。

```bash
mccr status
```

**输出示例**：
```
Gateway Status: Running
Endpoint: http://127.0.0.1:3456
Uptime: 2h 15m

Available Models:
  - anthropic/claude-sonnet-4-20250514
  - anthropic/claude-opus-4-20250514
  - openrouter/anthropic/claude-sonnet-4
  - deepseek/deepseek-chat
  - deepseek/deepseek-reasoner

Default Model: anthropic/claude-sonnet-4-20250514
Fallback Chain:
  1. openrouter/anthropic/claude-sonnet-4
  2. anthropic/claude-opus-4-20250514
```

## 核心模块设计

### 1. Config 模块

**职责**：加载、验证、监听配置文件变化

**关键函数**：
- `loadConfig(path: string): Config` - 加载配置
- `validateConfig(config: unknown): Config` - 验证配置
- `watchConfig(path: string, callback: () => void): void` - 监听变化

### 2. Server 模块

**职责**：HTTP 服务器，接收请求并路由到 Router

**关键函数**：
- `startServer(config: Config): Promise<Server>` - 启动服务器
- `handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void>` - 处理请求

**端点**：
- `POST /v1/messages` - 核心路由（Anthropic Messages API）
- `POST /v1/messages/count_tokens` - 本地 token 计数
- `GET /v1/models` - 返回可用模型列表
- `GET /health` - 健康检查

### 3. Router 模块

**职责**：模型选择、fallback 链执行

**关键函数**：
- `resolveModel(model: string, config: Config): ResolvedModel` - 解析模型选择器
- `executeWithFallback(request: Request, config: Config): Promise<Response>` - 执行请求（含 fallback）

**模型选择器解析**：
- 格式：`providerName/modelName`
- 解析逻辑：从配置的 providers 中找到匹配的 provider，获取 baseUrl、apiKey 和协议类型

**Fallback 逻辑**：
1. 尝试主模型
2. 如果失败（HTTP 4xx/5xx），按 fallback 数组顺序尝试
3. 所有模型都失败，返回最后一个错误

### 4. Logger 模块

**职责**：记录请求日志

**关键函数**：
- `logRequest(entry: LogEntry): void` - 记录请求
- `logError(error: Error): void` - 记录错误

**日志字段**：
- 时间戳
- 请求方法、路径
- 模型名称
- Provider 名称
- HTTP 状态码
- 响应时间
- 错误信息（如果有）

## 数据流

```
1. Claude Code 发送请求
   POST /v1/messages
   Body: { model: "claude-sonnet-4-20250514", ... }

2. Server 接收请求
   - 解析请求体
   - 提取模型名称

3. Router 解析模型
   - 如果 model 不含 provider 前缀，添加 defaultModel 的 provider
   - 解析为 { provider: "anthropic", model: "claude-sonnet-4-20250514" }

4. Router 执行请求（含 fallback）
   - 构建 fallback 链: [主模型, ...fallback 数组]
   - 循环尝试：
     a. 获取 provider 的 baseUrl 和 apiKey
     b. 转发请求到上游 API
     c. 如果成功，返回响应
     d. 如果失败（4xx/5xx），尝试下一个

5. @the-next-ai/ai-gateway 协议转换
   - 根据 provider.type 选择协议转换器
   - 转换请求/响应格式

6. 响应返回给 Claude Code
   - 流式传输响应
   - 记录日志
```

## 错误处理

### HTTP 状态码处理

- `200-299`: 成功
- `400-499`: 客户端错误，不触发 fallback（除非是 408/409/429）
- `500-599`: 服务器错误，触发 fallback
- `429`: Rate limit，解析 `Retry-After` 头或指数退避

### 错误响应格式

```json
{
  "error": {
    "type": "gateway_error",
    "message": "All providers failed",
    "details": {
      "attempts": [
        { "provider": "anthropic", "status": 503, "error": "Service unavailable" },
        { "provider": "openrouter", "status": 429, "error": "Rate limit exceeded" }
      ]
    }
  }
}
```

## 实现优先级

### Phase 1: 核心功能（MVP）

1. 配置文件加载
2. HTTP 服务器（`/v1/messages` 端点）
3. 模型选择器解析
4. 单 Provider 请求转发
5. CLI 命令（`start`、`claude`）

### Phase 2: Fallback 和日志

1. Fallback 链实现
2. 请求日志
3. 错误处理优化

### Phase 3: 增强功能

1. `/v1/models` 端点
2. `/health` 端点
3. `status` 命令
4. 配置文件热重载

## 参考实现

从 claude-code-router 提取的核心逻辑：

1. **协议识别**：`requestProtocolForPath()` - 根据 URL 路径识别协议
2. **模型选择器**：`normalizeRouteSelector()` - 解析 `Provider/model` 格式
3. **Fallback 逻辑**：`fetchUpstreamWithFallback()` - 重试和模型链
4. **Provider 配置**：`GatewayProviderConfig` - Provider 结构定义

## 不在范围内

- Electron UI
- Bot gateway 集成
- Profile 管理
- Plugin 系统
- MCP Fusion 工具
- 系统代理模式
- SQLite 数据库
- 多 API Key 轮换（Phase 3 可能添加）
