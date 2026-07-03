# mini-claude-code-router

极简的 Claude Code 网关，让 Claude Code 通过本地网关访问多个模型 Provider，支持跨协议转换与失败降级。

## 特性

- 极简配置：一个 JSON 文件即可运行
- 多 Provider 路由：按 `provider/model` 选择器路由到不同上游
- 规则路由：根据 `thinking`/`tools`/`messages` 长度自动选择模型（简单任务走轻量模型，复杂推理走强模型）
- 跨协议转换：Anthropic Messages ↔ OpenAI Chat Completions 双向转换（含工具调用、流式）
- 失败降级：主 Provider 返回 429/5xx 或网络错误时自动切换到备用 Provider
- 流式透传：SSE 流实时 pipe 到客户端，保留增量输出与中途取消能力
- 请求日志：记录每次请求的原始模型、路由模型、命中规则、provider、状态码、耗时、token 用量
- 后台运行：`mccr start` 后台启动，`mccr stop` 停止，PID 文件管理
- Claude Code 集成：`mccr claude` 一键启动并自动注入环境变量

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
      "model": "claude-sonnet-4-20250514"
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

该命令会先检查网关健康状态，然后以 `ANTHROPIC_BASE_URL` 指向网关的方式启动 `claude`，无需手动设置环境变量。

## 配置说明

### 完整示例

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
      "apiKey": "sk-ant-your-key-here",
      "model": "claude-sonnet-4-20250514"
    },
    {
      "name": "openrouter",
      "type": "openai_chat_completions",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "sk-or-your-key-here",
      "model": "anthropic/claude-sonnet-4"
    }
  ],
  "router": {
    "defaultModel": "anthropic/claude-sonnet-4-20250514",
    "fallback": ["openrouter/anthropic/claude-sonnet-4"]
  },
  "logging": {
    "enabled": true,
    "level": "info",
    "file": "/path/to/mccr.log"
  }
}
```

### Provider 类型

| type | 协议 | 转发路径 |
| --- | --- | --- |
| `anthropic_messages` | Anthropic Messages API | `/v1/messages` |
| `openai_chat_completions` | OpenAI Chat Completions API | `/v1/chat/completions` |
| `openai_responses` | OpenAI Responses API | `/v1/responses` |
| `gemini_generate_content` | Gemini GenerateContent API | 原始路径透传 |

### Provider 字段

| 字段 | 说明 |
| --- | --- |
| `name` | Provider 唯一名称，用于模型选择器 |
| `type` | 协议类型，见上表 |
| `baseUrl` | 上游 API 根地址 |
| `apiKey` | 上游 API Key，支持 `${ENV_VAR}` 环境变量展开 |
| `model` | 该 Provider 服务的模型名 |

### 模型选择器

格式：`providerName/modelName`

例如：
- `anthropic/claude-sonnet-4-20250514`
- `openrouter/anthropic/claude-sonnet-4`

支持三种匹配方式：
- `provider/model` 精确匹配：按 provider 名 + model 名定位
- 裸模型名（如 `claude-sonnet-4-20250514`）：在所有 provider 中查找 `model` 字段匹配项
- 空值：使用 `router.defaultModel`

如果找不到匹配项，网关会打警告日志并回退到 `defaultModel`，不会中断会话。

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

降级触发条件：
- 上游返回 `408` / `409` / `429` / `5xx`
- 上游网络错误（DNS、连接超时、TLS 失败等）

### 规则路由

通过 `router.rules` 配置自动模型路由。当请求的 model 为空、等于 `defaultModel`、或在配置中找不到匹配时，网关按规则顺序匹配，命中第一个规则后路由到其 `target`。用户手动 `/model` 切换到配置中已存在的模型时不走规则。

```json
{
  "router": {
    "defaultModel": "sonnet/claude-sonnet-4",
    "fallback": [],
    "rules": [
      {
        "when": { "thinking": true, "tools": true, "messagesGte": 10 },
        "target": "opus/claude-opus-4"
      },
      {
        "when": { "thinking": true, "tools": false, "messagesLt": 3 },
        "target": "sonnet/claude-sonnet-4"
      },
      {
        "when": { "tools": true, "messagesGte": 10 },
        "target": "sonnet/claude-sonnet-4"
      },
      {
        "when": { "tools": false, "messagesLt": 3 },
        "target": "haiku/claude-3-5-haiku"
      }
    ]
  }
}
```

上面的配置实现：深度推理 + 长任务走 Opus，简单推理走 Sonnet，长 agentic 任务走 Sonnet，简单问答走 Haiku，其余默认。

#### 条件字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `thinking` | `boolean` | 请求体是否有 `thinking` 字段（Claude Code 对支持思考的模型自动加） |
| `tools` | `boolean` | 请求体是否有非空 `tools` 数组（agentic 任务） |
| `messagesGte` | `number` | `messages.length >= N` |
| `messagesLt` | `number` | `messages.length < N` |

同一 `when` 里多个字段用 **AND** 逻辑（全部满足才命中）。规则按数组顺序匹配，命中第一个后停止。命中时日志会打印规则序号和条件，如 `[rules] Matched rule #3 (tools=false, messages<3) -> haiku/claude-3-5-haiku`。

### 日志配置

```json
{
  "logging": {
    "enabled": true,
    "level": "info",
    "file": "/path/to/mccr.log"
  }
}
```

- `file` 省略时输出到 stdout
- 每 10 次请求打印一次累计 token 用量统计

### 记录内容

每条请求日志包含：

| 字段 | 说明 |
| --- | --- |
| `timestamp` | ISO 时间戳 |
| `method` + `path` | HTTP 方法与路径 |
| `requested` | 客户端请求的原始模型名（与路由后模型不同时才显示） |
| `model` | 实际路由到的模型（如 `anthropic/claude-sonnet-4`） |
| `provider` | Provider 名称 |
| `status` | HTTP 状态码 |
| `duration` | 耗时（毫秒） |
| `tokens` | token 用量：`in`（输入）、`out`（输出）、`cache_create`（缓存写入）、`cache_read`（缓存读取） |
| `error` | 错误信息（如有） |

日志行示例：

```
[2026-07-03T09:48:58.597Z] POST /v1/messages requested=claude-opus-4-8 model=opencode-mimo-pro/mimo-v2.5-pro provider=opencode-mimo-pro status=200 duration=5337ms tokens=[in=252, out=100]
```

规则命中时额外打印：

```
[rules] Matched rule #6 (tools=false, messages<3) -> opencode-mimo-pro/mimo-v2.5-pro
```

**流式请求的 token 提取**：网关在 SSE 流透传过程中实时解析 `message_start` 和 `message_delta` 事件中的 `usage` 字段，流结束后补记到日志，不缓冲或修改流内容。跨协议（OpenAI → Anthropic）的流式转换同样提取 usage。

### 环境变量展开

配置文件中的 `${VAR}` 会从环境变量读取，未设置的变量会导致启动报错：

```json
{
  "apiKey": "${ANTHROPIC_API_KEY}"
}
```

## CLI 命令

### mccr start

启动网关服务，默认后台运行。

```bash
mccr start                                # 后台启动
mccr start --foreground                   # 前台启动（日志输出到 stdout）
mccr start --config /path/to/config.json  # 指定配置文件
```

默认配置路径：`~/.config/mccr/config.json`

后台运行时：
- PID 文件：`~/.config/mccr/gateway.pid`
- 日志文件：`~/.config/mccr/gateway.log`
- 自动检测重复启动并拒绝，提示已有进程的 PID

### mccr stop

停止后台运行的网关。

```bash
mccr stop
```

向后台进程发送 `SIGTERM` 优雅关闭，3 秒未退出则发送 `SIGKILL`。停止后自动清理 PID 文件。

### mccr claude

启动 Claude Code 并自动连接到网关。

```bash
mccr claude
mccr claude -- --help
mccr claude -- --model claude-opus-4-20250514
```

执行流程：
1. 读取默认配置，检查网关 `/health` 是否在线
2. 设置 `ANTHROPIC_BASE_URL` 指向网关
3. 设置 `ANTHROPIC_API_KEY` 为配置中第一个 Provider 的 key
4. 启动 `claude`，透传额外参数

### mccr status

显示网关状态和可用模型。

```bash
mccr status
```

## 协议转换能力

当 Claude Code（使用 Anthropic Messages 协议）请求一个 OpenAI 协议的 Provider 时，网关会自动做双向转换：

### 请求方向（Anthropic → OpenAI）

- `system` 字段 → `role: "system"` 消息
- `tool_use` 块 → `tool_calls` 数组
- `tool_result` 块 → `role: "tool"` 消息
- `input_schema` → `parameters`
- `image` 块（base64/url）→ `image_url` 格式
- `max_tokens` → `max_completion_tokens`
- `tool_choice` 映射（`any` → `required`，`{type:"tool",name}` → `{type:"function",function:{name}}`）
- `thinking` 块在输入中跳过（OpenAI 不支持）

### 响应方向（OpenAI → Anthropic）

- `choices[0].message` → `content` 数组
- `reasoning_content` → `thinking` 块
- `tool_calls` → `tool_use` 块（解析 `arguments` JSON）
- `finish_reason` 映射（`stop` → `end_turn`，`tool_calls` → `tool_use`，`length` → `max_tokens`）
- `usage` 字段映射（`prompt_tokens` → `input_tokens` 等）

### 流式转换（OpenAI SSE → Anthropic SSE）

- `message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop` 完整事件序列
- 文本增量：`delta.content` → `text_delta`
- 工具调用增量：`tool_calls[].function.arguments` → `input_json_delta`
- 跨 chunk 的不完整 SSE 行自动拼接

### Anthropic 同协议透传

当 Provider 类型为 `anthropic_messages` 时，网关**只替换 model 名和 auth 头**，其余字段（`thinking`、`context_management`、`metadata`、`cache_control`、`anthropic-beta` 头等）全部原样透传，不干扰 Claude Code 的会话管理特性。

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查，返回 `{"status":"ok"}` |
| GET | `/v1/models` | 列出配置的模型（静态，来自 config） |
| POST | `/v1/messages` | 核心端点，转发到上游 Provider |

## 项目结构

```
src/
  cli.ts        CLI 入口，命令分发、后台进程管理
  config.ts     配置加载、环境变量展开、校验
  types.ts      类型定义
  router.ts     模型解析、规则路由、请求转发、fallback 编排
  transform.ts  Anthropic ↔ OpenAI 协议转换纯函数
  sse-usage.ts  从 Anthropic SSE 流提取 token usage（透传不修改）
  server.ts     HTTP 服务、流式 pipe、SSE 转换
  logger.ts     请求日志、累计 token 统计
tests/
  config.test.ts    配置校验测试
  router.test.ts    模型解析 + 规则路由测试（18 例）
  transform.test.ts 协议转换测试（21 例）
  sse-usage.test.ts SSE usage 提取测试（9 例）
  server.test.ts    服务启动测试
  cli.test.ts       进程管理测试
```

## 开发

```bash
npm run dev        # tsx 直接运行
npm run build      # esbuild 打包到 dist/
npm run typecheck  # tsc 类型检查
npm test           # vitest 运行测试
```

## 许可证

MIT
