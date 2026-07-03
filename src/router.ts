import type { Config, ResolvedProvider, RouterRule, RouterRuleCondition } from "./types.js";
import {
  transformRequestToOpenAI,
  transformResponseFromOpenAI
} from "./transform.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForwardResult {
  status: number;
  headers: Record<string, string>;
  body?: string;
  responseStream?: ReadableStream<Uint8Array>;
  isStreaming: boolean;
  needsSseTransform: boolean;
  transformModel?: string;
  usage?: any;
  // Context for deferred logging (streaming responses log after pipe completes)
  logContext?: {
    timestamp: string;
    method: string;
    path: string;
    requestedModel?: string;
    model: string;
    provider: string;
    durationMs: number;
    statusCode: number;
  };
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

export function resolveModel(selector: string, config: Config): ResolvedProvider {
  if (!selector) {
    return resolveModel(config.router.defaultModel, config);
  }

  const slashIndex = selector.indexOf("/");
  if (slashIndex === -1) {
    // Bare model name (no provider prefix): find a provider that serves it
    const provider = config.providers.find((p) => p.model === selector);
    if (provider) {
      return { ...provider };
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

// Check if a model selector resolves to a configured provider/model.
// Used to decide whether to apply rule-based routing for unknown models.
function modelExists(selector: string, config: Config): boolean {
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

// ---------------------------------------------------------------------------
// Fallback decision
// ---------------------------------------------------------------------------

function shouldFallbackAfterStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500;
}

// ---------------------------------------------------------------------------
// Request forwarding
// ---------------------------------------------------------------------------

export async function forwardRequest(
  request: { method: string; path: string; headers: Record<string, string>; body: string },
  resolved: ResolvedProvider
): Promise<ForwardResult> {
  const isCrossProtocol =
    resolved.type === "openai_chat_completions" || resolved.type === "openai_responses";
  const isAnthropicProtocol = resolved.type === "anthropic_messages";

  // Build target URL
  let targetPath = request.path;
  if (resolved.type === "openai_chat_completions") {
    targetPath = "/v1/chat/completions";
  } else if (resolved.type === "openai_responses") {
    targetPath = "/v1/responses";
  } else if (resolved.type === "anthropic_messages") {
    targetPath = "/v1/messages";
  }

  const url = `${resolved.baseUrl}${targetPath}`;

  // Prepare body
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
        // Same protocol (anthropic_messages, gemini): only replace model, preserve everything
        parsed.model = resolved.model;
        bodyToSend = JSON.stringify(parsed);
      }
    } catch {
      // Not JSON, forward as-is
    }
  }

  // Build headers
  const headers: Record<string, string> = {};

  if (isAnthropicProtocol) {
    // Transparent passthrough: preserve all client headers except auth & content-length
    for (const [key, value] of Object.entries(request.headers)) {
      const lower = key.toLowerCase();
      if (lower === "x-api-key" || lower === "authorization") continue;
      if (lower === "content-length") continue;
      if (lower === "host") continue;
      headers[key] = value;
    }
    // Set our auth
    headers["x-api-key"] = resolved.apiKey;
    // Only set anthropic-version if client didn't provide one
    if (!headers["anthropic-version"]) {
      headers["anthropic-version"] = "2023-06-01";
    }
  } else if (isCrossProtocol) {
    // Strip Anthropic headers, add OpenAI auth
    headers["content-type"] = "application/json";
    headers["authorization"] = `Bearer ${resolved.apiKey}`;
    const accept = request.headers["accept"];
    if (accept) headers["accept"] = accept;
  } else {
    // Gemini or other: forward headers, replace auth
    for (const [key, value] of Object.entries(request.headers)) {
      const lower = key.toLowerCase();
      if (lower === "x-api-key" || lower === "authorization" || lower === "content-length" || lower === "host") continue;
      headers[key] = value;
    }
    headers["x-api-key"] = resolved.apiKey;
  }

  // Set content-length for modified body
  if (request.method !== "GET" && bodyToSend) {
    headers["content-length"] = String(Buffer.byteLength(bodyToSend, "utf8"));
  }

  const response = await fetch(url, {
    method: request.method,
    headers,
    body: request.method !== "GET" ? bodyToSend : undefined
  });

  // Build response headers (skip encoding/length — we'll set our own)
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "content-encoding" || lower === "transfer-encoding" || lower === "content-length") return;
    responseHeaders[key] = value;
  });

  // Determine if response is streaming
  const contentType = response.headers.get("content-type") || "";
  const isStreaming =
    contentType.includes("text/event-stream") || (isStreamingRequest && response.status === 200);

  const needsSseTransform = isStreaming && isCrossProtocol;

  if (isStreaming && response.body) {
    // For cross-protocol, set content-type to Anthropic SSE format
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

  // Non-streaming: buffer the response
  const responseBody = await response.text();
  let finalBody = responseBody;
  let usage: any;

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
      // Conversion failed, use original body
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
      // Not JSON or no usage
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

// ---------------------------------------------------------------------------
// Rule-based routing
// ---------------------------------------------------------------------------

// Evaluate router rules against the parsed request body.
// Returns the matched rule (with index and target) if a rule matches, or undefined if none match.
export function evaluateRules(
  parsedBody: any,
  defaultModel: string,
  rules: RouterRule[] | undefined
): { index: number; target: string; condition: RouterRuleCondition } | undefined {
  if (!rules || rules.length === 0) return undefined;

  const hasThinking = parsedBody?.thinking !== undefined && parsedBody?.thinking !== null;
  const hasTools = Array.isArray(parsedBody?.tools) && parsedBody.tools.length > 0;
  const messageCount = Array.isArray(parsedBody?.messages) ? parsedBody.messages.length : 0;

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const cond = rule.when;
    if (matchesCondition(cond, hasThinking, hasTools, messageCount)) {
      return { index: i, target: rule.target, condition: cond };
    }
  }

  return undefined;
}

function matchesCondition(
  cond: RouterRuleCondition,
  hasThinking: boolean,
  hasTools: boolean,
  messageCount: number
): boolean {
  if (cond.thinking !== undefined && cond.thinking !== hasThinking) return false;
  if (cond.tools !== undefined && cond.tools !== hasTools) return false;
  if (cond.messagesGte !== undefined && messageCount < cond.messagesGte) return false;
  if (cond.messagesLt !== undefined && messageCount >= cond.messagesLt) return false;
  return true;
}

function formatCondition(cond: RouterRuleCondition): string {
  const parts: string[] = [];
  if (cond.thinking !== undefined) parts.push(`thinking=${cond.thinking}`);
  if (cond.tools !== undefined) parts.push(`tools=${cond.tools}`);
  if (cond.messagesGte !== undefined) parts.push(`messages>=${cond.messagesGte}`);
  if (cond.messagesLt !== undefined) parts.push(`messages<${cond.messagesLt}`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Fallback orchestration
// ---------------------------------------------------------------------------

export async function executeWithFallback(
  request: { method: string; path: string; headers: Record<string, string>; body: string },
  config: Config,
  logger: { logRequest: (entry: any) => void }
): Promise<ForwardResult> {
  const startTime = Date.now();
  const requestedModel = extractModelFromBody(request.body);

  // Rule-based routing: applies when user didn't manually select a known model
  // (i.e., requested model is empty, equals defaultModel, or not found in config)
  let routedModel = requestedModel;
  const isUnresolvedRequest =
    !requestedModel ||
    requestedModel === config.router.defaultModel ||
    !modelExists(requestedModel, config);
  if (isUnresolvedRequest && config.router.rules) {
    let parsedBody: any;
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

  // Resolve primary: routed model, resolveModel falls back to default with warning if not found
  const primaryResolved = resolveModel(routedModel, config);

  const attempts: string[] = [
    `${primaryResolved.name}/${primaryResolved.model}`,
    ...config.router.fallback
  ];

  const errors: Array<{ provider: string; status: number; error: string }> = [];

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const hasMore = i < attempts.length - 1;

    try {
      const resolved = resolveModel(attempt, config);
      const result = await forwardRequest(request, resolved);

      if (hasMore && shouldFallbackAfterStatus(result.status)) {
        // Drain streaming response if needed
        if (result.responseStream) {
          await result.responseStream.cancel().catch(() => {});
        }
        errors.push({ provider: attempt, status: result.status, error: `HTTP ${result.status}` });
        continue;
      }

      if (result.isStreaming) {
        // Streaming: defer logging until pipe completes (usage extracted from SSE)
        result.logContext = {
          timestamp: new Date().toISOString(),
          method: request.method,
          path: request.path,
          requestedModel: requestedModel || undefined,
          model: attempt,
          provider: resolved.name,
          durationMs: Date.now() - startTime,
          statusCode: result.status
        };
      } else {
        // Non-streaming: log immediately with usage from buffered response
        logger.logRequest({
          timestamp: new Date().toISOString(),
          method: request.method,
          path: request.path,
          requestedModel: requestedModel || undefined,
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
    requestedModel: requestedModel || undefined,
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

function extractModelFromBody(body: string): string {
  try {
    const parsed = JSON.parse(body);
    return parsed.model || "";
  } catch {
    return "";
  }
}
