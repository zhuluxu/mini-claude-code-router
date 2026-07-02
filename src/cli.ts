import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";
import type { Config } from "./types.js";

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "mccr", "config.json");

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "start":
      await handleStart(args.slice(1));
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

async function handleStart(args: string[]) {
  const configPath = getConfigPath(args);

  if (!existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    console.error("Create a config file or use --config to specify a path");
    process.exit(1);
  }

  const config = loadConfig(configPath);
  console.log(`Loaded config from ${configPath}`);

  await startServer(config);
}

async function handleClaude(args: string[]) {
  // Check if gateway is running
  const config = loadConfigFromDefault();
  const endpoint = `http://${config.server.host}:${config.server.port}`;

  try {
    const response = await fetch(`${endpoint}/health`);
    if (!response.ok) {
      throw new Error("Gateway not responding");
    }
  } catch (error) {
    console.error("Gateway is not running. Start it with: mccr start");
    process.exit(1);
  }

  console.log(`Gateway is running at ${endpoint}`);
  console.log("Starting Claude Code...");

  // Set environment variable and spawn claude
  process.env.ANTHROPIC_BASE_URL = endpoint;

  const { spawn } = await import("node:child_process");
  const claude = spawn("claude", args, {
    stdio: "inherit",
    env: process.env
  });

  claude.on("exit", (code) => {
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
        for (const model of provider.models) {
          console.log(`  - ${provider.name}/${model}`);
        }
      }
      console.log(`\nDefault Model: ${config.router.defaultModel}`);
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

function getConfigPath(args: string[]): string {
  const configIndex = args.indexOf("--config");
  if (configIndex !== -1 && args[configIndex + 1]) {
    return args[configIndex + 1];
  }
  return DEFAULT_CONFIG_PATH;
}

function loadConfigFromDefault(): Config {
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
  start [--config <path>]    Start the gateway server
  claude [args...]           Start Claude Code with gateway configured
  status                     Show gateway status

Options:
  --config <path>            Path to config file (default: ~/.config/mccr/config.json)
  --help                     Show this help message

Examples:
  mccr start
  mccr start --config ./my-config.json
  mccr claude
  mccr claude -- --help
  mccr status
`);
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
