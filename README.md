# mini-claude-code-router

极简的 Claude Code 网关，让 Claude Code 通过本地网关访问多个模型 Provider。

## 特性

- 🚀 极简配置：JSON 配置文件，50 行即可运行
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

## 当前限制

**MVP 版本**：当前版本仅支持同协议 Provider 转发（所有 Provider 使用相同的 API 协议）。协议转换功能（Anthropic ↔ OpenAI ↔ Gemini）将在后续版本中添加。

## 许可证

MIT
