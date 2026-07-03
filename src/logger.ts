import { appendFileSync } from "node:fs";
import type { LogEntry, LoggingConfig } from "./types.js";

let loggingConfig: LoggingConfig | undefined;

// Cumulative token tracking
let totalTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  requestCount: 0
};

export function initLogger(config: LoggingConfig): void {
  loggingConfig = config;
}

export function logRequest(entry: LogEntry): void {
  if (!loggingConfig?.enabled) return;

  // Update cumulative totals
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

    // Print cumulative stats every 10 requests
    if (totalTokens.requestCount % 10 === 0 && totalTokens.requestCount > 0) {
      console.log(`\n📊 Cumulative Token Usage (last ${totalTokens.requestCount} requests):`);
      console.log(`   Input tokens: ${totalTokens.inputTokens.toLocaleString()}`);
      console.log(`   Output tokens: ${totalTokens.outputTokens.toLocaleString()}`);
      if (totalTokens.cacheCreationInputTokens > 0) {
        console.log(`   Cache creation: ${totalTokens.cacheCreationInputTokens.toLocaleString()}`);
      }
      if (totalTokens.cacheReadInputTokens > 0) {
        console.log(`   Cache read: ${totalTokens.cacheReadInputTokens.toLocaleString()}`);
      }
      console.log(`   Total: ${(totalTokens.inputTokens + totalTokens.outputTokens).toLocaleString()} tokens\n`);
    }
  }
}

export function logError(error: Error): void {
  if (!loggingConfig?.enabled) return;

  const logLine = `[${new Date().toISOString()}] ERROR: ${error.message}`;

  if (loggingConfig.file) {
    appendFileSync(loggingConfig.file, logLine + "\n");
  } else {
    console.error(logLine);
  }
}

function formatLogEntry(entry: LogEntry): string {
  const parts: string[] = [
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

  // Add token usage if available
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

export function getTotalTokens() {
  return { ...totalTokens };
}
