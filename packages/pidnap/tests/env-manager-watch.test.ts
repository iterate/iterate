import { writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EnvManager } from "../src/env-manager.ts";
import { logger as baseLogger } from "../src/logger.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("EnvManager - File Watching", () => {
  const testDir = join(import.meta.dirname, ".temp/env-manager-watch");
  const logger = baseLogger({ name: "env-manager-watch" });

  beforeEach(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(async () => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should call onChange callback when global env file changes", async () => {
    writeFileSync(join(testDir, ".env"), "VAR1=value1");

    const envManager = new EnvManager({ cwd: testDir }, logger);

    const events: string[] = [];
    const unsubscribe = envManager.onChange((event) => {
      events.push(event.type);
    });

    // Modify the file
    await wait(100);
    writeFileSync(join(testDir, ".env"), "VAR1=value2");

    // Wait for file watcher to detect change
    await wait(300);

    expect(events.length).toBeGreaterThan(0);
    expect(events).toContain("global");

    unsubscribe();
    envManager.close();
  });

  it("should update env vars when file changes", async () => {
    writeFileSync(join(testDir, ".env"), "VAR1=original");

    const envManager = new EnvManager({ cwd: testDir }, logger);

    expect(envManager.getEnvVars("any")).toEqual({ VAR1: "original" });

    // Wait a bit before modifying
    await wait(200);

    // Modify the file
    writeFileSync(join(testDir, ".env"), "VAR1=updated\nVAR2=new");

    // Wait for file watcher (increased for reliability)
    await wait(500);

    expect(envManager.getEnvVars("any")).toEqual({ VAR1: "updated", VAR2: "new" });

    envManager.close();
  });

  it("should handle multiple env files changing", async () => {
    writeFileSync(join(testDir, ".env"), "GLOBAL=1");
    writeFileSync(join(testDir, ".env.app"), "APP=1");

    const envManager = new EnvManager({ cwd: testDir }, logger);

    const events: string[] = [];
    envManager.onChange((event) => {
      if (event.type === "global") {
        events.push("global");
      } else {
        events.push(event.key);
      }
    });

    // Modify both files
    await wait(100);
    writeFileSync(join(testDir, ".env"), "GLOBAL=2");
    await wait(100);
    writeFileSync(join(testDir, ".env.app"), "APP=2");

    // Wait for file watchers
    await wait(500);

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events).toContain("global");
    expect(events).toContain("app");

    envManager.close();
  });

  it("should allow unsubscribing from onChange", async () => {
    writeFileSync(join(testDir, ".env"), "VAR=1");

    const envManager = new EnvManager({ cwd: testDir }, logger);

    let callCount = 0;
    const unsubscribe = envManager.onChange(() => {
      callCount++;
    });

    await wait(100);
    writeFileSync(join(testDir, ".env"), "VAR=2");
    await wait(300);

    expect(callCount).toBe(1);

    // Unsubscribe
    unsubscribe();

    // Change file again
    await wait(100);
    writeFileSync(join(testDir, ".env"), "VAR=3");
    await wait(300);

    // Should still be 1 (not called after unsubscribe)
    expect(callCount).toBe(1);

    envManager.close();
  });

  it("should detect new .env.* files created in cwd", async () => {
    writeFileSync(join(testDir, ".env"), "GLOBAL=1");

    const envManager = new EnvManager({ cwd: testDir }, logger);

    const events: string[] = [];
    envManager.onChange((event) => {
      if (event.type === "process") {
        events.push(event.key);
      }
    });

    // Wait for watcher to be ready
    await wait(200);

    // Create a new env file
    writeFileSync(join(testDir, ".env.newapp"), "NEW_VAR=value");

    // Wait for file watcher
    await wait(500);

    expect(events).toContain("newapp");
    expect(envManager.getEnvVars("newapp")).toEqual({
      GLOBAL: "1",
      NEW_VAR: "value",
    });

    envManager.close();
  });

  it("should cleanup watchers on close", async () => {
    writeFileSync(join(testDir, ".env"), "VAR=1");

    const envManager = new EnvManager({ cwd: testDir }, logger);

    let callCount = 0;
    envManager.onChange(() => {
      callCount++;
    });

    // Close immediately
    envManager.close();

    // Try to change file
    await wait(100);
    writeFileSync(join(testDir, ".env"), "VAR=2");
    await wait(300);

    // Should not be called after close
    expect(callCount).toBe(0);
  });

  it("should handle file deletion", async () => {
    writeFileSync(join(testDir, ".env"), "GLOBAL=1");
    writeFileSync(join(testDir, ".env.app"), "APP=1");

    const envManager = new EnvManager({ cwd: testDir }, logger);

    expect(envManager.getEnvVars("app")).toEqual({ GLOBAL: "1", APP: "1" });

    const events: string[] = [];
    envManager.onChange((event) => {
      if (event.type === "process") {
        events.push(event.key);
      }
    });

    // Wait for watcher to be ready
    await wait(200);

    // Delete the app env file
    rmSync(join(testDir, ".env.app"));

    // Wait for file watcher
    await wait(300);

    expect(events).toContain("app");
    // After deletion, only global env should remain
    expect(envManager.getEnvVars("app")).toEqual({ GLOBAL: "1" });

    envManager.close();
  });
});
