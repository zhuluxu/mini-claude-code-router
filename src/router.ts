import type { Config, ResolvedProvider } from "./types.js";

export function resolveModel(model: string, config: Config): ResolvedProvider {
  // Gateway ignores the requested model name, always uses configured provider/model
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

export async function forwardRequest(
  request: { method: string; path: string; headers: Record<string, string>; body: string },
  resolved: ResolvedProvider
): Promise<{ status: number; headers: Record<string, string>; body: string; usage?: any }> {
  // Map provider type to correct endpoint path
  let targetPath = request.path;
  if (resolved.type === "openai_chat_completions") {
    targetPath = "/v1/chat/completions";
  } else if (resolved.type === "openai_responses") {
    targetPath = "/v1/responses";
  } else if (resolved.type === "anthropic_messages") {
    targetPath = "/v1/messages";
  } else if (resolved.type === "gemini_generate_content") {
    // Gemini uses the original path structure
    targetPath = request.path;
  }

  const url = `${resolved.baseUrl}${targetPath}`;

  console.log(`  Forwarding to: ${url}`);
  console.log(`  Provider: ${resolved.name} (${resolved.type})`);
  console.log(`  API Key: ${resolved.apiKey.substring(0, 10)}...`);

  // Replace model name and transform request body based on provider type
  let bodyToSend = request.body;
  if (request.body) {
    try {
      const parsed = JSON.parse(request.body);
      if (parsed.model) {
        console.log(`  Replacing model: ${parsed.model} -> ${resolved.model}`);
        parsed.model = resolved.model;
      }

      // Transform Anthropic format to OpenAI format
      if (resolved.type === "openai_chat_completions" || resolved.type === "openai_responses") {
        // Move system message to messages array if present
        if (parsed.system) {
          const systemContent = typeof parsed.system === "string"
            ? parsed.system
            : Array.isArray(parsed.system)
              ? parsed.system.map((s: any) => s.text || s).join("\n")
              : "";
          if (systemContent) {
            parsed.messages = [
              { role: "system", content: systemContent },
              ...(parsed.messages || [])
            ];
          }
          delete parsed.system;
        }

        // Convert Anthropic message format to OpenAI format
        if (parsed.messages) {
          parsed.messages = parsed.messages.map((msg: any) => {
            // Handle content as array (Anthropic multimodal)
            if (Array.isArray(msg.content)) {
              const textParts = msg.content
                .filter((part: any) => part.type === "text")
                .map((part: any) => part.text)
                .join("\n");
              return { role: msg.role, content: textParts };
            }
            return msg;
          });
        }

        // Convert tools from Anthropic format to OpenAI format
        if (parsed.tools && Array.isArray(parsed.tools)) {
          parsed.tools = parsed.tools.map((tool: any) => {
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

        // Map max_tokens to max_completion_tokens for newer OpenAI models
        if (parsed.max_tokens && !parsed.max_completion_tokens) {
          parsed.max_completion_tokens = parsed.max_tokens;
        }

        // Remove Anthropic-specific fields that OpenAI doesn't support
        delete parsed.thinking;
        delete parsed.context_management;
        delete parsed.output_config;
        delete parsed.metadata;
        delete parsed.stream; // We'll handle streaming separately
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
      // If body is not JSON, use as-is
    }
  }

  const headers: Record<string, string> = {
    ...request.headers,
    "content-type": "application/json"
  };

  // Remove incoming auth headers since we'll add our own
  delete headers["x-api-key"];
  delete headers["authorization"];
  delete headers["anthropic-version"];
  // Remove content-length as we'll set it based on the actual body
  delete headers["content-length"];

  // Add provider-specific auth header
  if (resolved.type === "anthropic_messages") {
    headers["x-api-key"] = resolved.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    console.log(`  Auth: x-api-key`);
  } else {
    headers["authorization"] = `Bearer ${resolved.apiKey}`;
    console.log(`  Auth: Bearer token`);
  }

  // Set correct content-length for the modified body
  if (request.method !== "GET" && bodyToSend) {
    headers["content-length"] = String(Buffer.byteLength(bodyToSend, "utf8"));
  }

  let response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers,
      body: request.method !== "GET" ? bodyToSend : undefined
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
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  // Parse usage from response body
  let usage: any = undefined;
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
    // Response is not JSON or doesn't have usage info
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
