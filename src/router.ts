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
