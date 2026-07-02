import { appendFileSync } from "node:fs";
import type { LogEntry, LoggingConfig } from "./types.js";

let loggingConfig: LoggingConfig | undefined;

export function initLogger(config: LoggingConfig): void {
  loggingConfig = config;
}

export function logRequest(entry: LogEntry): void {
  if (!loggingConfig?.enabled) return;

  const logLine = formatLogEntry(entry);

  if (loggingConfig.file) {
    appendFileSync(loggingConfig.file, logLine + "\n");
  } else {
    console.log(logLine);
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
  const parts = [
    `[${entry.timestamp}]`,
    `${entry.method} ${entry.path}`,
    `model=${entry.model}`,
    `provider=${entry.provider}`,
    `status=${entry.statusCode}`,
    `duration=${entry.durationMs}ms`
  ];

  if (entry.error) {
    parts.push(`error=${entry.error}`);
  }

  return parts.join(" ");
}
