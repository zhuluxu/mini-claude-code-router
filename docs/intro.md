# mini-claude-code-router：让 Claude Code 用上任意模型的极简网关

## 为什么做这个项目

如果你正在使用 Claude Code，大概率会遇到一个尴尬的现实：

**Anthropic 官方 API 不是唯一选择。** 国内访问不稳定、价格不便宜、有时候你想试试 DeepSeek、通义千问、mimo 等其他模型的能力。但 Claude Code 只认 Anthropic 的 API 协议，你没法直接把它指向一个 OpenAI 兼容的端点。

**不同任务该用不同模型。** 写一行注释用 Opus 是杀鸡用牛刀，复杂推理用 Haiku 又力不从心。手动每次 `/model` 切换太繁琐，而且容易忘。

**主力 provider 挂了怎么办？** 高峰期 429、服务波动，你不想盯着报错手动切到备用 key。

mini-claude-code-router 就是为解决这三个问题做的——一个跑在本地的极简网关，夹在 Claude Code 和上游模型 API 之间，做三件事：**路由、转换、降级**。

## 它能做什么

### 1. 一个 Claude Code，接多个模型

你可以在配置里挂多个 provider——Anthropic 官方、OpenRouter、DeepSeek、通义千问、任何 OpenAI 兼容的 API。Claude Code 不用改任何设置，照常 `/model` 切换，网关帮你把请求路由到对应的上游。

### 2. 自动协议转换

Claude Code 说的是 Anthropic 协议，DeepSeek 说的是 OpenAI 协议，语言不通？网关在中间做实时翻译——请求体格式转换、工具调用格式转换、流式响应转换，Claude Code 感知不到差异，该用工具用工具，该流式流式。

### 3. 智能模型路由

这是最有意思的部分。你可以配规则，让网关根据请求特征自动选模型：

- 请求带 `thinking`（深度推理）+ 有工具调用 + 长对话 → 走强模型（如 DeepSeek Pro）
- 请求带 `thinking` + 简单问答 → 走平衡模型（如 Qwen Plus）
- 没有工具 + 短对话（一句话问答）→ 走轻量模型（如 mimo），省钱
- 有工具 + 长对话（agentic 代码任务）→ 走平衡模型

你不用手动切，网关看请求内容自己判断。规则可以自由配，按顺序匹配，命中第一个就路由。

### 4. 失败自动降级

主力 provider 返回 429（限流）或 5xx（服务异常），网关自动切到配置的 fallback 链，你无感知。网络错误同理。不用重启，不用手动切。

### 5. 请求日志

每次对话的 token 消耗、用了哪个模型、命中了哪条路由规则、耗时多久——全记在日志里。流式请求也照样提取 token 用量（从 SSE 流里实时解析，不缓冲不修改流内容）。让你对成本和用量有数。

## 怎么用

三步跑起来。

### 第一步：装

```bash
git clone https://github.com/zhuluxu/mini-claude-code-router.git
cd mini-claude-code-router
npm install
npm run build
npm link
```

装完后你会有一个 `mccr` 命令。

### 第二步：写配置

```bash
mkdir -p ~/.config/mccr
cat > ~/.config/mccr/config.json << 'EOF'
{
  "server": { "host": "127.0.0.1", "port": 13456 },
  "providers": [
    {
      "name": "qwen",
      "type": "anthropic_messages",
      "baseUrl": "https://your-api-endpoint",
      "apiKey": "${YOUR_API_KEY}",
      "model": "qwen3.7-plus"
    },
    {
      "name": "deepseek",
      "type": "openai_chat_completions",
      "baseUrl": "https://your-api-endpoint",
      "apiKey": "${YOUR_API_KEY}",
      "model": "deepseek-v4-pro"
    },
    {
      "name": "mimo",
      "type": "openai_chat_completions",
      "baseUrl": "https://your-api-endpoint",
      "apiKey": "${YOUR_API_KEY}",
      "model": "mimo-v2.5-pro"
    }
  ],
  "router": {
    "defaultModel": "qwen/qwen3.7-plus",
    "fallback": ["deepseek/deepseek-v4-pro"],
    "rules": [
      { "when": { "thinking": true, "tools": true, "messagesGte": 10 }, "target": "deepseek/deepseek-v4-pro" },
      { "when": { "thinking": true, "tools": false, "messagesLt": 3 }, "target": "qwen/qwen3.7-plus" },
      { "when": { "thinking": true, "tools": false, "messagesGte": 3 }, "target": "deepseek/deepseek-v4-pro" },
      { "when": { "tools": true, "messagesGte": 10 }, "target": "qwen/qwen3.7-plus" },
      { "when": { "tools": false, "messagesLt": 3 }, "target": "mimo/mimo-v2.5-pro" }
    ]
  },
  "logging": { "enabled": true, "level": "info" }
}
EOF
```

配置说明：
- **providers**：你想用的所有模型源，每个声明类型（`anthropic_messages` 同协议透传，`openai_chat_completions` 自动协议转换）
- **rules**：按需配，不想自动路由就留空数组
- **apiKey** 支持环境变量展开（`${YOUR_API_KEY}`），避免硬编码

### 第三步：启动

```bash
mccr start    # 后台启动网关
mccr claude   # 启动 Claude Code，自动连到网关
```

就这样。Claude Code 照常使用，背后已经是多个模型在协作了。

如果你想直接用 `claude` 命令而不通过 `mccr claude`，把环境变量写入 shell：

```bash
echo 'export ANTHROPIC_BASE_URL=http://127.0.0.1:13456' >> ~/.bashrc
echo 'export ANTHROPIC_API_KEY=mccr-gateway' >> ~/.bashrc
source ~/.bashrc
```

之后直接 `claude` 即可，效果和 `mccr claude` 一样。

## 日常使用

| 命令 | 作用 |
| --- | --- |
| `mccr start` | 后台启动网关 |
| `mccr stop` | 停止网关 |
| `mccr status` | 查看网关状态和可用模型 |
| `mccr claude` | 启动 Claude Code（自动连网关） |

网关后台运行，日志在 `~/.config/mccr/gateway.log`。你可以在里面看到每次请求命中了哪条规则、路由到了哪个模型、消耗了多少 token：

```
[rules] Matched rule #5 (tools=false, messages<3) -> mimo/mimo-v2.5-pro
POST /v1/messages requested=claude-sonnet-4 model=mimo/mimo-v2.5-pro status=200 duration=1200ms tokens=[in=252, out=100]
```

## 一些设计取舍

**为什么不直接改 Claude Code？** Claude Code 是闭源的，而且它会持续更新。做网关而不是改客户端，意味着 Claude Code 升级后网关仍然兼容，不用追着改。

**为什么不做复杂的管理界面？** 这是一个"50 行配置跑起来"的工具，不是平台。你需要的是路由和转换，不是又一个 dashboard。配置文件就是最好的 UI。

**为什么规则路由只看 `thinking`/`tools`/`messages` 三个维度？** 因为这三个维度足够区分绝大多数场景，再多就是过度设计。规则可读、可调试、可预测，比一个黑盒模型决策器更让人放心。规则命中会打日志，你能看到每次为什么走了某个模型。

## 适用场景

- 想用 Claude Code 但 Anthropic 官方 API 不好访问或太贵
- 想在多个模型间灵活切换，不想手动操作
- 想让简单任务走便宜模型、复杂任务走强模型，自动判断
- 想要 fallback 保障，主力 key 挂了不中断
- 想看每次对话的 token 消耗和路由决策

## 未来规划

当前版本是"规则路由 + 日志记录"的极简形态，后续围绕两个方向深化：

### 智能模型路由，专注于降低成本

现在的规则路由是人工配的——你写下"thinking + 长对话走 DeepSeek"，网关照执行。这已经能省不少钱，但还不够聪明：

- **基于历史用量的自适应**：网关记录每个模型在你实际使用中的 token 消耗、响应质量、耗时，自动调整路由权重。某个模型在你这里性价比 consistently 更高，就多用；某个经常超时，就少用。
- **按任务复杂度分级**：不只是看 `thinking`/`tools`/`messages` 三维度，还能结合请求内容（代码长度、文件数、工具调用类型）判断任务复杂度，更精准地匹配模型能力。
- **成本上限与预算控制**：配一个月度预算，网关在接近上限时自动把请求往便宜模型倾斜，超限则拒绝或提醒。让你对成本有硬性把控。
- **A/B 路由**：同一类请求按比例分流到不同模型，对比效果和成本，帮你找到最优配置。

目标：让网关自己算账，而不是你手动调规则。

### 消耗可视化与统计

现在日志是文本行，能看但不够直观。后续会加：

- **Web 仪表盘**：一个轻量本地页面，展示按天/周/月的 token 消耗趋势、各模型占比、成本估算。不用登录，不用部署，`mccr status` 给你一个 URL 打开就是。
- **按会话/项目维度聚合**：不只是全局统计，还能按 Claude Code 的会话 ID 或工作目录维度看消耗——哪个项目最费 token、哪个会话走了最贵的模型，一目了然。
- **路由决策回顾**：可视化每次请求命中了哪条规则、路由到了哪个模型，帮你理解和调优规则配置。
- **成本对比**：展示"如果全走 Opus 要多少钱" vs "经过路由后实际花了多少钱"，让省钱效果可见。

目标：让每一笔 token 花在哪、省在哪，看得见。

## 项目地址

**GitHub：** https://github.com/zhuluxu/mini-claude-code-router

MIT 协议，欢迎试用、提 issue、贡献规则配置示例。
