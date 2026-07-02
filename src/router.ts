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
