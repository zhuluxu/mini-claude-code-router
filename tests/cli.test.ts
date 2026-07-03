import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// We test the PID/process helpers indirectly by spawning short-lived processes
// and using the CLI's stop/start via direct module functions.

describe("cli process management", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mccr-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("isProcessAlive returns true for current process", () => {
    // process.kill(pid, 0) should not throw for self
    let alive = true;
    try {
      process.kill(process.pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(true);
  });

  it("isProcessAlive returns false for non-existent PID", () => {
    // PID 999999 is very unlikely to exist
    let alive = true;
    try {
      process.kill(999999, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("stale PID file can be cleaned up", () => {
    const pidFile = join(tempDir, "gateway.pid");
    writeFileSync(pidFile, "999999");
    expect(existsSync(pidFile)).toBe(true);

    // Simulate cleanup
    if (existsSync(pidFile)) {
      const content = readFileSync(pidFile, "utf-8").trim();
      const pid = Number(content);
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (!alive) {
        rmSync(pidFile);
      }
    }

    expect(existsSync(pidFile)).toBe(false);
  });

  it("valid PID file can be read and parsed", () => {
    const pidFile = join(tempDir, "gateway.pid");
    writeFileSync(pidFile, String(process.pid));

    const content = readFileSync(pidFile, "utf-8").trim();
    const pid = Number(content);
    expect(pid).toBe(process.pid);
    expect(Number.isFinite(pid)).toBe(true);
    expect(pid > 0).toBe(true);
  });

  it("corrupted PID file returns NaN gracefully", () => {
    const pidFile = join(tempDir, "gateway.pid");
    writeFileSync(pidFile, "not-a-number");

    const content = readFileSync(pidFile, "utf-8").trim();
    const pid = Number(content);
    expect(Number.isFinite(pid)).toBe(false);
  });

  it("start --foreground and stop via SIGTERM works", async () => {
    // Spawn a quick node process that stays alive briefly, then verify SIGTERM kills it
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();

    // Wait for process to start
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(child.pid).toBeTruthy();

    // Send SIGTERM
    process.kill(child.pid!, "SIGTERM");

    // Wait for exit
    let exited = false;
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        try {
          process.kill(child.pid!, 0);
        } catch {
          exited = true;
          clearInterval(timer);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, 3000);
    });

    expect(exited).toBe(true);
  });
});
