export type ProviderType =
  | "anthropic_messages"
  | "openai_chat_completions"
  | "openai_responses"
  | "gemini_generate_content";

export interface ProviderConfig {
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ServerConfig {
  host: string;
  port: number;
}

export interface RouterRuleCondition {
  thinking?: boolean;
  tools?: boolean;
  messagesGte?: number;
  messagesLt?: number;
}

export interface RouterRule {
  when: RouterRuleCondition;
  target: string;
}

export interface RouterConfig {
  defaultModel: string;
  fallback: string[];
  rules?: RouterRule[];
}

export interface LoggingConfig {
  enabled: boolean;
  level: "debug" | "info" | "warn" | "error";
  file?: string;
}

export interface Config {
  server: ServerConfig;
  providers: ProviderConfig[];
  router: RouterConfig;
  logging: LoggingConfig;
}

export interface ResolvedProvider {
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LogEntry {
  timestamp: string;
  method: string;
  path: string;
  requestedModel?: string;
  model: string;
  provider: string;
  statusCode: number;
  durationMs: number;
  error?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
}
