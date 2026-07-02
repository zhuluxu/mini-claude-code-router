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

export async function forwardRequest(
  request: { method: string; path: string; headers: Record<string, string>; body: string },
  resolved: ResolvedProvider
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const url = `${resolved.baseUrl}${request.path}`;

  const headers: Record<string, string> = {
    ...request.headers,
    "content-type": "application/json"
  };

  // Add provider-specific auth header
  if (resolved.type === "anthropic_messages") {
    headers["x-api-key"] = resolved.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["authorization"] = `Bearer ${resolved.apiKey}`;
  }

  const response = await fetch(url, {
    method: request.method,
    headers,
    body: request.method !== "GET" ? request.body : undefined
  });

  const responseBody = await response.text();
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return {
    status: response.status,
    headers: responseHeaders,
    body: responseBody
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
