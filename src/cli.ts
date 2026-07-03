import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync, openSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";
import type { Config } from "./types.js";

const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "mccr");
const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, "config.json");
const PID_FILE = join(DEFAULT_CONFIG_DIR, "gateway.pid");
const LOG_FILE = join(DEFAULT_CONFIG_DIR, "gateway.log");

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "start":
      await handleStart(args.slice(1));
      break;
    case "stop":
      await handleStop();
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
  const endpoint = `http://${config.server.host}:${config.server.port}`;

  // Foreground mode: start server directly, skip PID file and running check
  if (args.includes("--foreground")) {
    console.log(`Loaded config from ${configPath}`);
    await startServer(config);
    return;
  }

  // Background mode: check if gateway is already running
  if (await isGatewayRunning(endpoint)) {
    let pid = readPidFile();
    if (!pid) {
      // Gateway is running but PID file is missing — try to recover it
      pid = findGatewayPid(endpoint);
      if (pid) {
        mkdirSync(DEFAULT_CONFIG_DIR, { recursive: true });
        writeFileSync(PID_FILE, String(pid));
      }
    }
    console.error(`Gateway is already running${pid ? ` (PID ${pid})` : ""}`);
    console.error(`Endpoint: ${endpoint}`);
    console.error("Stop it first with: mccr stop");
    process.exit(1);
  }

  // Clean up stale PID file if any
  cleanupStalePidFile();

  // Background mode: spawn a detached child process running the server
  mkdirSync(DEFAULT_CONFIG_DIR, { recursive: true });

  const logFd = openSync(LOG_FILE, "a");
  const entry = resolveSelfEntry();
  const child = spawn(process.execPath, [entry, "start", "--config", configPath, "--foreground"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env
  });

  child.unref();

  writeFileSync(PID_FILE, String(child.pid));

  // Wait briefly for startup, then verify
  await sleep(800);
  if (await isGatewayRunning(endpoint)) {
    console.log(`Gateway started in background (PID ${child.pid})`);
    console.log(`Endpoint: ${endpoint}`);
    console.log(`Default Model: ${config.router.defaultModel}`);
    console.log(`Log: ${LOG_FILE}`);
    console.log("Stop with: mccr stop");
  } else {
    console.error("Gateway failed to start. Check log:");
    console.error(`  ${LOG_FILE}`);
    cleanupStalePidFile();
    process.exit(1);
  }
}

async function handleStop() {
  const pid = readPidFile();
  if (!pid) {
    console.log("No PID file found. Gateway is not running (or was started with --foreground).");
    return;
  }

  const alive = isProcessAlive(pid);
  if (!alive) {
    console.log(`Process ${pid} is not running. Cleaning up stale PID file.`);
    cleanupStalePidFile();
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    // Wait up to 3s for graceful shutdown
    for (let i = 0; i < 30; i++) {
      if (!isProcessAlive(pid)) break;
      await sleep(100);
    }
    if (isProcessAlive(pid)) {
      console.log(`Process ${pid} did not exit after SIGTERM, sending SIGKILL.`);
      process.kill(pid, "SIGKILL");
    }
    console.log(`Gateway stopped (PID ${pid}).`);
  } catch (error) {
    console.error(`Failed to stop process ${pid}:`, error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    cleanupStalePidFile();
  }
}

// Resolve the current entry script path for re-spawning.
// Works for both: tsx dev mode (src/cli.ts) and built bundle (dist/cli.js).
function resolveSelfEntry(): string {
  const arg1 = process.argv[1];
  if (!arg1) {
    throw new Error("Cannot determine entry script for background spawn");
  }
  return arg1;
}

function readPidFile(): number | undefined {
  try {
    const content = readFileSync(PID_FILE, "utf-8").trim();
    const pid = Number(content);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function cleanupStalePidFile(): void {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findGatewayPid(endpoint: string): number | undefined {
  const port = new URL(endpoint).port;
  if (!port) return undefined;
  try {
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      stdio: ["ignore", "pipe", "ignore"]
    }).toString().trim();
    const pid = Number(out.split("\n")[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function isGatewayRunning(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleClaude(args: string[]) {
  // Check if gateway is running
  const config = loadConfigFromDefault();
  const endpoint = `http://${config.server.host}:${config.server.port}`;

  console.log(`Checking gateway at ${endpoint}...`);
  try {
    const response = await fetch(`${endpoint}/health`);
    if (!response.ok) {
      throw new Error("Gateway not responding");
    }
    console.log("✓ Gateway is running");
  } catch (error) {
    console.error("✗ Gateway is not running. Start it with: mccr start (background) or mccr start --foreground");
    process.exit(1);
  }

  console.log(`\nStarting Claude Code with:`);
  console.log(`  ANTHROPIC_BASE_URL=${endpoint}`);
  console.log(`  ANTHROPIC_API_KEY=${config.providers[0]?.apiKey.substring(0, 10)}...`);
  console.log(`Passing arguments: ${args.join(" ") || "(none)"}\n`);

  // Set environment variables and spawn claude
  process.env.ANTHROPIC_BASE_URL = endpoint;
  // Use a dummy API key since the gateway handles authentication
  process.env.ANTHROPIC_API_KEY = config.providers[0]?.apiKey || "mccr-gateway";

  const { spawn } = await import("node:child_process");
  const claude = spawn("claude", args, {
    stdio: "inherit",
    env: process.env
  });

  claude.on("error", (error) => {
    console.error("Failed to start Claude Code:", error.message);
    process.exit(1);
  });

  claude.on("exit", (code) => {
    console.log(`\nClaude Code exited with code ${code}`);
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
        console.log(`  - ${provider.name}/${provider.model}`);
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
  start [--config <path>] [--foreground]   Start the gateway (background by default)
  stop                                     Stop the background gateway
  claude [args...]                         Start Claude Code with gateway configured
  status                                   Show gateway status

Options:
  --config <path>      Path to config file (default: ~/.config/mccr/config.json)
  --foreground         Run gateway in foreground (logs to stdout)
  --help               Show this help message

Examples:
  mccr start                        # start in background
  mccr start --foreground           # start in foreground
  mccr start --config ./my.json
  mccr stop                         # stop background gateway
  mccr claude
  mccr claude -- --help
  mccr status
`);
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
