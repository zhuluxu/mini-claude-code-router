#!/usr/bin/env node

// src/cli.ts
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync as readFileSync2, writeFileSync, unlinkSync, openSync } from "node:fs";
import { spawn, execSync } from "node:child_process";

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
  if (router.rules !== void 0) {
    if (!Array.isArray(router.rules)) {
      throw new Error("router.rules must be an array");
    }
    for (let i = 0; i < router.rules.length; i++) {
      validateRouterRule(router.rules[i], i);
    }
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
function validateRouterRule(raw, index) {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`router.rules[${index}] must be an object`);
  }
  const rule = raw;
  if (typeof rule.when !== "object" || rule.when === null) {
    throw new Error(`router.rules[${index}] missing required field: when (object)`);
  }
  const when = rule.when;
  if (when.thinking !== void 0 && typeof when.thinking !== "boolean") {
    throw new Error(`router.rules[${index}].when.thinking must be a boolean`);
  }
  if (when.tools !== void 0 && typeof when.tools !== "boolean") {
    throw new Error(`router.rules[${index}].when.tools must be a boolean`);
  }
  if (when.messagesGte !== void 0 && typeof when.messagesGte !== "number") {
    throw new Error(`router.rules[${index}].when.messagesGte must be a number`);
  }
  if (when.messagesLt !== void 0 && typeof when.messagesLt !== "number") {
    throw new Error(`router.rules[${index}].when.messagesLt must be a number`);
  }
  const conditionKeys = ["thinking", "tools", "messagesGte", "messagesLt"];
  if (!conditionKeys.some((k) => when[k] !== void 0)) {
    throw new Error(`router.rules[${index}].when must have at least one condition`);
  }
  if (typeof rule.target !== "string" || rule.target.length === 0) {
    throw new Error(`router.rules[${index}] missing required field: target (non-empty string)`);
  }
}

// src/server.ts
import { createServer } from "node:http";
import { Readable, Transform } from "node:stream";

// src/transform.ts
function transformRequestToOpenAI(body) {
  const out = {};
  if (body.model !== void 0) out.model = body.model;
  if (body.temperature !== void 0) out.temperature = body.temperature;
  if (body.top_p !== void 0) out.top_p = body.top_p;
  if (body.stream !== void 0) out.stream = body.stream;
  if (body.stop_sequence !== void 0) out.stop = body.stop_sequence;
  if (body.max_tokens !== void 0) {
    out.max_tokens = body.max_tokens;
    out.max_completion_tokens = body.max_tokens;
  }
  const messages = [];
  if (body.system !== void 0) {
    const systemText = extractSystemText(body.system);
    if (systemText) {
      messages.push({ role: "system", content: systemText });
    }
  }
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      messages.push(...convertAnthropicMessageToOpenAI(msg));
    }
  }
  out.messages = messages;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map(convertAnthropicToolToOpenAI);
  }
  if (body.tool_choice !== void 0) {
    out.tool_choice = convertToolChoiceToOpenAI(body.tool_choice);
  }
  return out;
}
function extractSystemText(system) {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system.map((s) => typeof s === "string" ? s : s?.text || "").filter(Boolean).join("\n");
  }
  return "";
}
function convertAnthropicMessageToOpenAI(msg) {
  if (typeof msg.content === "string") {
    return [{ role: msg.role, content: msg.content }];
  }
  if (!Array.isArray(msg.content)) {
    return [{ role: msg.role, content: msg.content }];
  }
  const result = [];
  const textParts = [];
  const toolCalls = [];
  const toolResults = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {})
        }
      });
    } else if (block.type === "tool_result") {
      toolResults.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: extractToolResultContent(block.content)
      });
    } else if (block.type === "image") {
      const url = buildImageUrl(block.source);
      if (url) {
        textParts.push("");
        result.push({ role: msg.role, content: [{ type: "image_url", image_url: { url } }] });
      }
    } else if (block.type === "thinking") {
    }
  }
  for (const tr of toolResults) {
    result.push(tr);
  }
  const mainText = textParts.join("\n");
  if (toolCalls.length > 0) {
    const mainMsg = { role: msg.role };
    if (mainText) mainMsg.content = mainText;
    else mainMsg.content = null;
    mainMsg.tool_calls = toolCalls;
    result.push(mainMsg);
  } else if (mainText && result.length === 0) {
    result.push({ role: msg.role, content: mainText });
  } else if (mainText && result.length > 0 && result[result.length - 1].role === "tool") {
    result.push({ role: msg.role, content: mainText });
  } else if (mainText) {
    result.push({ role: msg.role, content: mainText });
  }
  if (result.length === 0) {
    result.push({ role: msg.role, content: "" });
  }
  return result;
}
function extractToolResultContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (typeof c === "string") return c;
      if (c.type === "text") return c.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object") return content.text || "";
  return "";
}
function buildImageUrl(source) {
  if (!source) return null;
  if (source.type === "base64") {
    const mediaType = source.media_type || "image/png";
    return `data:${mediaType};base64,${source.data}`;
  }
  if (source.type === "url") {
    return source.url;
  }
  return null;
}
function convertAnthropicToolToOpenAI(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} }
    }
  };
}
function convertToolChoiceToOpenAI(choice) {
  if (typeof choice === "string") {
    if (choice === "auto") return "auto";
    if (choice === "any") return "required";
    if (choice === "none") return "none";
    return choice;
  }
  if (choice && typeof choice === "object" && choice.type === "tool") {
    return {
      type: "function",
      function: { name: choice.name }
    };
  }
  return choice;
}
function transformResponseFromOpenAI(body, model) {
  const choice = body.choices?.[0];
  const message = choice?.message || {};
  const content = [];
  if (message.reasoning_content) {
    content.push({ type: "thinking", thinking: message.reasoning_content });
  }
  if (message.content) {
    content.push({ type: "text", text: message.content });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function?.name,
        input
      });
    }
  }
  const stopReason = convertFinishReasonToStopReason(choice?.finish_reason);
  return {
    id: body.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: body.usage?.prompt_tokens || 0,
      output_tokens: body.usage?.completion_tokens || 0,
      cache_creation_input_tokens: body.usage?.cache_creation_input_tokens || 0,
      cache_read_input_tokens: body.usage?.cache_read_input_tokens || 0
    }
  };
}
function convertFinishReasonToStopReason(finishReason) {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "end_turn";
    default:
      return "end_turn";
  }
}
var OpenAIToAnthropicSseTransformer = class {
  messageStarted = false;
  messageStopped = false;
  currentBlockIndex = -1;
  currentBlockType = null;
  model;
  messageId;
  inputTokens = 0;
  outputTokens = 0;
  constructor(model) {
    this.model = model;
    this.messageId = `msg_${Date.now()}`;
  }
  getUsage() {
    return { inputTokens: this.inputTokens, outputTokens: this.outputTokens };
  }
  // Convert one OpenAI SSE data line to Anthropic SSE event strings.
  // Returns array of fully formatted SSE event strings (each ending with \n\n).
  transformDataLine(data) {
    if (data === "[DONE]") {
      return this.finishStream();
    }
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return [];
    }
    const events = [];
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (!this.messageStarted) {
      this.inputTokens = chunk.usage?.prompt_tokens || 0;
      events.push(this.formatEvent("message_start", {
        type: "message_start",
        message: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          content: [],
          model: this.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputTokens, output_tokens: 0 }
        }
      }));
      this.messageStarted = true;
    }
    if (!delta) {
      if (choice?.finish_reason) {
        events.push(...this.handleFinish(choice.finish_reason, chunk.usage));
      }
      return events;
    }
    if (delta.content) {
      if (this.currentBlockType !== "text") {
        if (this.currentBlockIndex >= 0) {
          events.push(this.formatEvent("content_block_stop", {
            type: "content_block_stop",
            index: this.currentBlockIndex
          }));
        }
        this.currentBlockIndex++;
        this.currentBlockType = "text";
        events.push(this.formatEvent("content_block_start", {
          type: "content_block_start",
          index: this.currentBlockIndex,
          content_block: { type: "text", text: "" }
        }));
      }
      events.push(this.formatEvent("content_block_delta", {
        type: "content_block_delta",
        index: this.currentBlockIndex,
        delta: { type: "text_delta", text: delta.content }
      }));
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const tcIndex = tc.index ?? 0;
        if (tc.id || tc.function?.name && this.currentBlockType !== "tool_use") {
          if (this.currentBlockIndex >= 0) {
            events.push(this.formatEvent("content_block_stop", {
              type: "content_block_stop",
              index: this.currentBlockIndex
            }));
          }
          this.currentBlockIndex++;
          this.currentBlockType = "tool_use";
          events.push(this.formatEvent("content_block_start", {
            type: "content_block_start",
            index: this.currentBlockIndex,
            content_block: {
              type: "tool_use",
              id: tc.id || `toolu_${tcIndex}`,
              name: tc.function?.name || "",
              input: {}
            }
          }));
        }
        if (tc.function?.arguments) {
          events.push(this.formatEvent("content_block_delta", {
            type: "content_block_delta",
            index: this.currentBlockIndex,
            delta: { type: "input_json_delta", partial_json: tc.function.arguments }
          }));
        }
      }
    }
    if (choice?.finish_reason) {
      events.push(...this.handleFinish(choice.finish_reason, chunk.usage));
    }
    return events;
  }
  handleFinish(finishReason, usage) {
    const events = [];
    if (this.currentBlockIndex >= 0) {
      events.push(this.formatEvent("content_block_stop", {
        type: "content_block_stop",
        index: this.currentBlockIndex
      }));
      this.currentBlockIndex = -1;
      this.currentBlockType = null;
    }
    this.outputTokens = usage?.completion_tokens || this.outputTokens;
    const stopReason = convertFinishReasonToStopReason(finishReason);
    events.push(this.formatEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: this.outputTokens }
    }));
    events.push(this.formatEvent("message_stop", { type: "message_stop" }));
    this.messageStopped = true;
    return events;
  }
  finishStream() {
    const events = [];
    if (this.currentBlockIndex >= 0) {
      events.push(this.formatEvent("content_block_stop", {
        type: "content_block_stop",
        index: this.currentBlockIndex
      }));
      this.currentBlockIndex = -1;
      this.currentBlockType = null;
    }
    if (!this.messageStopped) {
      events.push(this.formatEvent("message_stop", { type: "message_stop" }));
      this.messageStopped = true;
    }
    return events;
  }
  formatEvent(eventType, data) {
    return `event: ${eventType}
data: ${JSON.stringify(data)}

`;
  }
};
function parseSseChunk(raw, carry) {
  const text = carry + raw;
  const parts = text.split("\n");
  const remainder = parts.pop() || "";
  const lines = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith("data: ")) {
      lines.push(trimmed.slice(6));
    } else if (trimmed.startsWith("data:")) {
      lines.push(trimmed.slice(5));
    }
  }
  return { lines, remainder };
}

// src/router.ts
function resolveModel(selector, config) {
  if (!selector) {
    return resolveModel(config.router.defaultModel, config);
  }
  const slashIndex = selector.indexOf("/");
  if (slashIndex === -1) {
    const provider2 = config.providers.find((p) => p.model === selector);
    if (provider2) {
      return { ...provider2 };
    }
    console.warn(
      `[router] Model "${selector}" not found in any provider, falling back to default "${config.router.defaultModel}"`
    );
    return resolveModel(config.router.defaultModel, config);
  }
  const providerName = selector.slice(0, slashIndex);
  const modelName = selector.slice(slashIndex + 1);
  const provider = config.providers.find((p) => p.name === providerName);
  if (!provider) {
    console.warn(
      `[router] Provider "${providerName}" not found for selector "${selector}", falling back to default "${config.router.defaultModel}"`
    );
    return resolveModel(config.router.defaultModel, config);
  }
  if (provider.model !== modelName) {
    console.warn(
      `[router] Model "${modelName}" not found in provider "${providerName}" (available: ${provider.model}), falling back to default "${config.router.defaultModel}"`
    );
    return resolveModel(config.router.defaultModel, config);
  }
  return { ...provider };
}
function modelExists(selector, config) {
  if (!selector) return false;
  const slashIndex = selector.indexOf("/");
  if (slashIndex === -1) {
    return config.providers.some((p) => p.model === selector);
  }
  const providerName = selector.slice(0, slashIndex);
  const modelName = selector.slice(slashIndex + 1);
  const provider = config.providers.find((p) => p.name === providerName);
  return !!provider && provider.model === modelName;
}
function shouldFallbackAfterStatus(statusCode) {
  return statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500;
}
async function forwardRequest(request, resolved) {
  const isCrossProtocol = resolved.type === "openai_chat_completions" || resolved.type === "openai_responses";
  const isAnthropicProtocol = resolved.type === "anthropic_messages";
  let targetPath = request.path;
  if (resolved.type === "openai_chat_completions") {
    targetPath = "/v1/chat/completions";
  } else if (resolved.type === "openai_responses") {
    targetPath = "/v1/responses";
  } else if (resolved.type === "anthropic_messages") {
    targetPath = "/v1/messages";
  }
  const url = `${resolved.baseUrl}${targetPath}`;
  let bodyToSend = request.body;
  let isStreamingRequest = false;
  if (request.body) {
    try {
      const parsed = JSON.parse(request.body);
      isStreamingRequest = parsed.stream === true;
      if (isCrossProtocol) {
        const transformed = transformRequestToOpenAI(parsed);
        transformed.model = resolved.model;
        bodyToSend = JSON.stringify(transformed);
      } else {
        parsed.model = resolved.model;
        bodyToSend = JSON.stringify(parsed);
      }
    } catch {
    }
  }
  const headers = {};
  if (isAnthropicProtocol) {
    for (const [key, value] of Object.entries(request.headers)) {
      const lower = key.toLowerCase();
      if (lower === "x-api-key" || lower === "authorization") continue;
      if (lower === "content-length") continue;
      if (lower === "host") continue;
      headers[key] = value;
    }
    headers["x-api-key"] = resolved.apiKey;
    if (!headers["anthropic-version"]) {
      headers["anthropic-version"] = "2023-06-01";
    }
  } else if (isCrossProtocol) {
    headers["content-type"] = "application/json";
    headers["authorization"] = `Bearer ${resolved.apiKey}`;
    const accept = request.headers["accept"];
    if (accept) headers["accept"] = accept;
  } else {
    for (const [key, value] of Object.entries(request.headers)) {
      const lower = key.toLowerCase();
      if (lower === "x-api-key" || lower === "authorization" || lower === "content-length" || lower === "host") continue;
      headers[key] = value;
    }
    headers["x-api-key"] = resolved.apiKey;
  }
  if (request.method !== "GET" && bodyToSend) {
    headers["content-length"] = String(Buffer.byteLength(bodyToSend, "utf8"));
  }
  const response = await fetch(url, {
    method: request.method,
    headers,
    body: request.method !== "GET" ? bodyToSend : void 0
  });
  const responseHeaders = {};
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "content-encoding" || lower === "transfer-encoding" || lower === "content-length") return;
    responseHeaders[key] = value;
  });
  const contentType = response.headers.get("content-type") || "";
  const isStreaming = contentType.includes("text/event-stream") || isStreamingRequest && response.status === 200;
  const needsSseTransform = isStreaming && isCrossProtocol;
  if (isStreaming && response.body) {
    if (isCrossProtocol) {
      responseHeaders["content-type"] = "text/event-stream; charset=utf-8";
    }
    return {
      status: response.status,
      headers: responseHeaders,
      responseStream: response.body,
      isStreaming: true,
      needsSseTransform,
      transformModel: resolved.model
    };
  }
  const responseBody = await response.text();
  let finalBody = responseBody;
  let usage;
  if (isCrossProtocol) {
    try {
      const parsed = JSON.parse(responseBody);
      if (parsed.choices && Array.isArray(parsed.choices)) {
        const anthropicResponse = transformResponseFromOpenAI(parsed, resolved.model);
        finalBody = JSON.stringify(anthropicResponse);
        usage = {
          inputTokens: anthropicResponse.usage.input_tokens,
          outputTokens: anthropicResponse.usage.output_tokens
        };
      }
    } catch {
    }
  } else {
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
  }
  responseHeaders["content-length"] = String(Buffer.byteLength(finalBody, "utf8"));
  return {
    status: response.status,
    headers: responseHeaders,
    body: finalBody,
    isStreaming: false,
    needsSseTransform: false,
    transformModel: resolved.model,
    usage
  };
}
function evaluateRules(parsedBody, defaultModel, rules) {
  if (!rules || rules.length === 0) return void 0;
  const hasThinking = parsedBody?.thinking !== void 0 && parsedBody?.thinking !== null;
  const hasTools = Array.isArray(parsedBody?.tools) && parsedBody.tools.length > 0;
  const messageCount = Array.isArray(parsedBody?.messages) ? parsedBody.messages.length : 0;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const cond = rule.when;
    if (matchesCondition(cond, hasThinking, hasTools, messageCount)) {
      return { index: i, target: rule.target, condition: cond };
    }
  }
  return void 0;
}
function matchesCondition(cond, hasThinking, hasTools, messageCount) {
  if (cond.thinking !== void 0 && cond.thinking !== hasThinking) return false;
  if (cond.tools !== void 0 && cond.tools !== hasTools) return false;
  if (cond.messagesGte !== void 0 && messageCount < cond.messagesGte) return false;
  if (cond.messagesLt !== void 0 && messageCount >= cond.messagesLt) return false;
  return true;
}
function formatCondition(cond) {
  const parts = [];
  if (cond.thinking !== void 0) parts.push(`thinking=${cond.thinking}`);
  if (cond.tools !== void 0) parts.push(`tools=${cond.tools}`);
  if (cond.messagesGte !== void 0) parts.push(`messages>=${cond.messagesGte}`);
  if (cond.messagesLt !== void 0) parts.push(`messages<${cond.messagesLt}`);
  return parts.join(", ");
}
async function executeWithFallback(request, config, logger) {
  const startTime = Date.now();
  const requestedModel = extractModelFromBody(request.body);
  let routedModel = requestedModel;
  const isUnresolvedRequest = !requestedModel || requestedModel === config.router.defaultModel || !modelExists(requestedModel, config);
  if (isUnresolvedRequest && config.router.rules) {
    let parsedBody;
    try {
      parsedBody = JSON.parse(request.body);
    } catch {
      parsedBody = null;
    }
    const ruleMatch = evaluateRules(parsedBody, config.router.defaultModel, config.router.rules);
    if (ruleMatch) {
      const condStr = formatCondition(ruleMatch.condition);
      console.log(`  [rules] Matched rule #${ruleMatch.index + 1} (${condStr}) -> ${ruleMatch.target}`);
      routedModel = ruleMatch.target;
    }
  }
  const primaryResolved = resolveModel(routedModel, config);
  const attempts = [
    `${primaryResolved.name}/${primaryResolved.model}`,
    ...config.router.fallback
  ];
  const errors = [];
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const hasMore = i < attempts.length - 1;
    try {
      const resolved = resolveModel(attempt, config);
      const result = await forwardRequest(request, resolved);
      if (hasMore && shouldFallbackAfterStatus(result.status)) {
        if (result.responseStream) {
          await result.responseStream.cancel().catch(() => {
          });
        }
        errors.push({ provider: attempt, status: result.status, error: `HTTP ${result.status}` });
        continue;
      }
      if (result.isStreaming) {
        result.logContext = {
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          method: request.method,
          path: request.path,
          requestedModel: requestedModel || void 0,
          model: attempt,
          provider: resolved.name,
          durationMs: Date.now() - startTime,
          statusCode: result.status
        };
      } else {
        logger.logRequest({
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          method: request.method,
          path: request.path,
          requestedModel: requestedModel || void 0,
          model: attempt,
          provider: resolved.name,
          statusCode: result.status,
          durationMs: Date.now() - startTime,
          usage: result.usage
        });
      }
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push({ provider: attempt, status: 0, error: errorMessage });
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
    requestedModel: requestedModel || void 0,
    model: requestedModel,
    provider: "all",
    statusCode: 502,
    durationMs: Date.now() - startTime,
    error: "All providers failed"
  });
  return {
    status: 502,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(errorResponse),
    isStreaming: false,
    needsSseTransform: false,
    transformModel: requestedModel
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
    `${entry.method} ${entry.path}`
  ];
  if (entry.requestedModel && entry.requestedModel !== entry.model) {
    parts.push(`requested=${entry.requestedModel}`);
  }
  parts.push(
    `model=${entry.model}`,
    `provider=${entry.provider}`,
    `status=${entry.statusCode}`,
    `duration=${entry.durationMs}ms`
  );
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

// src/sse-usage.ts
var AnthropicSseUsageExtractor = class {
  usage = {};
  carry = "";
  // Process a raw SSE chunk (may contain partial lines).
  // Returns the trailing partial line to carry to the next chunk.
  processChunk(raw) {
    const text = this.carry + raw;
    const parts = text.split("\n");
    const remainder = parts.pop() || "";
    this.carry = remainder;
    for (const line of parts) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) {
        this.processLine(trimmed.slice(6));
      } else if (trimmed.startsWith("data:")) {
        this.processLine(trimmed.slice(5));
      }
    }
    return remainder;
  }
  // Process a single SSE data line (the JSON payload after "data: ").
  processLine(data) {
    if (!data || data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === "message_start" && parsed.message?.usage) {
        const u = parsed.message.usage;
        if (typeof u.input_tokens === "number") this.usage.inputTokens = u.input_tokens;
        if (typeof u.output_tokens === "number") this.usage.outputTokens = u.output_tokens;
        if (typeof u.cache_creation_input_tokens === "number") {
          this.usage.cacheCreationInputTokens = u.cache_creation_input_tokens;
        }
        if (typeof u.cache_read_input_tokens === "number") {
          this.usage.cacheReadInputTokens = u.cache_read_input_tokens;
        }
      } else if (parsed.type === "message_delta" && parsed.usage) {
        const u = parsed.usage;
        if (typeof u.output_tokens === "number") this.usage.outputTokens = u.output_tokens;
      }
    } catch {
    }
  }
  getUsage() {
    return { ...this.usage };
  }
  // Flush any remaining carry buffer
  finish() {
    if (this.carry.trim()) {
      const trimmed = this.carry.trim();
      if (trimmed.startsWith("data: ")) {
        this.processLine(trimmed.slice(6));
      } else if (trimmed.startsWith("data:")) {
        this.processLine(trimmed.slice(5));
      }
      this.carry = "";
    }
  }
};

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
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body);
      console.log(`  Requested model: ${parsed.model || "not specified"}`);
      if (parsed.stream) console.log(`  Stream: ${parsed.stream}`);
    } catch {
      console.log("  Could not parse request body");
    }
    const headers = {};
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
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found" } }));
}
async function writeResultToResponse(result, res, logRequestFn) {
  if (result.isStreaming && result.responseStream) {
    res.writeHead(result.status, result.headers);
    const nodeStream = Readable.fromWeb(
      result.responseStream
    );
    let transformer = null;
    let usageExtractor = null;
    if (result.needsSseTransform && result.transformModel) {
      transformer = new OpenAIToAnthropicSseTransformer(result.transformModel);
      const transformStream = createSseTransformStream(transformer);
      nodeStream.pipe(transformStream).pipe(res);
    } else {
      usageExtractor = new AnthropicSseUsageExtractor();
      const usageStream = createUsagePassthroughStream(usageExtractor);
      nodeStream.pipe(usageStream).pipe(res);
    }
    const finishLogging = (error) => {
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
        usage: usage || void 0,
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
  res.writeHead(result.status, result.headers);
  res.end(result.body);
}
function createSseTransformStream(transformer) {
  let carry = "";
  return new Transform({
    transform(chunk, _encoding, callback) {
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
function createUsagePassthroughStream(extractor) {
  return new Transform({
    transform(chunk, _encoding, callback) {
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
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// src/cli.ts
var DEFAULT_CONFIG_DIR = join(homedir(), ".config", "mccr");
var DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, "config.json");
var PID_FILE = join(DEFAULT_CONFIG_DIR, "gateway.pid");
var LOG_FILE = join(DEFAULT_CONFIG_DIR, "gateway.log");
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  switch (command) {
    case "start":
      await handleStart(args.slice(1));
      break;
    case "stop":
      await handleStop();
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
  const endpoint = `http://${config.server.host}:${config.server.port}`;
  if (args.includes("--foreground")) {
    console.log(`Loaded config from ${configPath}`);
    await startServer(config);
    return;
  }
  if (await isGatewayRunning(endpoint)) {
    let pid = readPidFile();
    if (!pid) {
      pid = findGatewayPid(endpoint);
      if (pid) {
        mkdirSync(DEFAULT_CONFIG_DIR, { recursive: true });
        writeFileSync(PID_FILE, String(pid));
      }
    }
    console.error(`Gateway is already running${pid ? ` (PID ${pid})` : ""}`);
    console.error(`Endpoint: ${endpoint}`);
    console.error("Stop it first with: mccr stop");
    process.exit(1);
  }
  cleanupStalePidFile();
  mkdirSync(DEFAULT_CONFIG_DIR, { recursive: true });
  const logFd = openSync(LOG_FILE, "a");
  const entry = resolveSelfEntry();
  const child = spawn(process.execPath, [entry, "start", "--config", configPath, "--foreground"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  await sleep(800);
  if (await isGatewayRunning(endpoint)) {
    console.log(`Gateway started in background (PID ${child.pid})`);
    console.log(`Endpoint: ${endpoint}`);
    console.log(`Default Model: ${config.router.defaultModel}`);
    console.log(`Log: ${LOG_FILE}`);
    console.log("Stop with: mccr stop");
  } else {
    console.error("Gateway failed to start. Check log:");
    console.error(`  ${LOG_FILE}`);
    cleanupStalePidFile();
    process.exit(1);
  }
}
async function handleStop() {
  const pid = readPidFile();
  if (!pid) {
    console.log("No PID file found. Gateway is not running (or was started with --foreground).");
    return;
  }
  const alive = isProcessAlive(pid);
  if (!alive) {
    console.log(`Process ${pid} is not running. Cleaning up stale PID file.`);
    cleanupStalePidFile();
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 30; i++) {
      if (!isProcessAlive(pid)) break;
      await sleep(100);
    }
    if (isProcessAlive(pid)) {
      console.log(`Process ${pid} did not exit after SIGTERM, sending SIGKILL.`);
      process.kill(pid, "SIGKILL");
    }
    console.log(`Gateway stopped (PID ${pid}).`);
  } catch (error) {
    console.error(`Failed to stop process ${pid}:`, error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    cleanupStalePidFile();
  }
}
function resolveSelfEntry() {
  const arg1 = process.argv[1];
  if (!arg1) {
    throw new Error("Cannot determine entry script for background spawn");
  }
  return arg1;
}
function readPidFile() {
  try {
    const content = readFileSync2(PID_FILE, "utf-8").trim();
    const pid = Number(content);
    return Number.isFinite(pid) && pid > 0 ? pid : void 0;
  } catch {
    return void 0;
  }
}
function cleanupStalePidFile() {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {
  }
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function findGatewayPid(endpoint) {
  const port = new URL(endpoint).port;
  if (!port) return void 0;
  try {
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      stdio: ["ignore", "pipe", "ignore"]
    }).toString().trim();
    const pid = Number(out.split("\n")[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : void 0;
  } catch {
    return void 0;
  }
}
async function isGatewayRunning(endpoint) {
  try {
    const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    console.error("\u2717 Gateway is not running. Start it with: mccr start (background) or mccr start --foreground");
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
  const { spawn: spawn2 } = await import("node:child_process");
  const claude = spawn2("claude", args, {
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
  start [--config <path>] [--foreground]   Start the gateway (background by default)
  stop                                     Stop the background gateway
  claude [args...]                         Start Claude Code with gateway configured
  status                                   Show gateway status

Options:
  --config <path>      Path to config file (default: ~/.config/mccr/config.json)
  --foreground         Run gateway in foreground (logs to stdout)
  --help               Show this help message

Examples:
  mccr start                        # start in background
  mccr start --foreground           # start in foreground
  mccr start --config ./my.json
  mccr stop                         # stop background gateway
  mccr claude
  mccr claude -- --help
  mccr status
`);
}
main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
