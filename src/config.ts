import { readFileSync } from "node:fs";
import type { Config, ProviderType } from "./types.js";

const VALID_PROVIDER_TYPES: ProviderType[] = [
  "anthropic_messages",
  "openai_chat_completions",
  "openai_responses",
  "gemini_generate_content"
];

export function loadConfig(path: string): Config {
  const content = readFileSync(path, "utf-8");
  const expanded = expandEnvVars(content);
  const raw = JSON.parse(expanded);
  return validateConfig(raw);
}

function expandEnvVars(content: string): string {
  return content.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const value = process.env[varName];
    if (value === undefined) {
      throw new Error(`Environment variable ${varName} is not set`);
    }
    return value;
  });
}

export function validateConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Config must be an object");
  }

  const config = raw as Record<string, unknown>;

  // Validate server
  if (!config.server || typeof config.server !== "object") {
    throw new Error("Missing required field: server");
  }
  const server = config.server as Record<string, unknown>;
  if (typeof server.host !== "string") {
    throw new Error("Missing required field: server.host");
  }
  if (typeof server.port !== "number") {
    throw new Error("Missing required field: server.port");
  }

  // Validate providers
  if (!Array.isArray(config.providers)) {
    throw new Error("Missing required field: providers");
  }
  if (config.providers.length === 0) {
    throw new Error("At least one provider is required");
  }

  for (const provider of config.providers) {
    validateProvider(provider);
  }

  // Validate router
  if (!config.router || typeof config.router !== "object") {
    throw new Error("Missing required field: router");
  }
  const router = config.router as Record<string, unknown>;
  if (typeof router.defaultModel !== "string") {
    throw new Error("Missing required field: router.defaultModel");
  }
  if (!Array.isArray(router.fallback)) {
    throw new Error("Missing required field: router.fallback");
  }

  // Validate rules (optional)
  if (router.rules !== undefined) {
    if (!Array.isArray(router.rules)) {
      throw new Error("router.rules must be an array");
    }
    for (let i = 0; i < router.rules.length; i++) {
      validateRouterRule(router.rules[i], i);
    }
  }

  // Validate logging
  if (!config.logging || typeof config.logging !== "object") {
    throw new Error("Missing required field: logging");
  }
  const logging = config.logging as Record<string, unknown>;
  if (typeof logging.enabled !== "boolean") {
    throw new Error("Missing required field: logging.enabled");
  }
  if (!["debug", "info", "warn", "error"].includes(logging.level as string)) {
    throw new Error("Invalid logging.level");
  }

  return config as unknown as Config;
}

function validateProvider(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Provider must be an object");
  }

  const provider = raw as Record<string, unknown>;

  if (typeof provider.name !== "string" || provider.name.length === 0) {
    throw new Error("Provider missing required field: name");
  }

  if (!VALID_PROVIDER_TYPES.includes(provider.type as ProviderType)) {
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

function validateRouterRule(raw: unknown, index: number): void {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`router.rules[${index}] must be an object`);
  }

  const rule = raw as Record<string, unknown>;

  // Validate when
  if (typeof rule.when !== "object" || rule.when === null) {
    throw new Error(`router.rules[${index}] missing required field: when (object)`);
  }
  const when = rule.when as Record<string, unknown>;

  if (when.thinking !== undefined && typeof when.thinking !== "boolean") {
    throw new Error(`router.rules[${index}].when.thinking must be a boolean`);
  }
  if (when.tools !== undefined && typeof when.tools !== "boolean") {
    throw new Error(`router.rules[${index}].when.tools must be a boolean`);
  }
  if (when.messagesGte !== undefined && typeof when.messagesGte !== "number") {
    throw new Error(`router.rules[${index}].when.messagesGte must be a number`);
  }
  if (when.messagesLt !== undefined && typeof when.messagesLt !== "number") {
    throw new Error(`router.rules[${index}].when.messagesLt must be a number`);
  }

  // Must have at least one condition
  const conditionKeys = ["thinking", "tools", "messagesGte", "messagesLt"];
  if (!conditionKeys.some((k) => when[k] !== undefined)) {
    throw new Error(`router.rules[${index}].when must have at least one condition`);
  }

  // Validate target
  if (typeof rule.target !== "string" || rule.target.length === 0) {
    throw new Error(`router.rules[${index}] missing required field: target (non-empty string)`);
  }
}
