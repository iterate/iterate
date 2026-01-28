import { writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Manager } from "../src/manager.ts";
import { logger } from "../src/logger.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Manager - Env File Watching", () => {
  const testDir = join(import.meta.dirname, ".temp/manager-env-watch");

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

  it("should reload process when env file changes with default delay", async () => {
    writeFileSync(join(testDir, ".env"), "TEST_VAR=original");

    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
        processes: [
          {
            name: "test-proc",
            definition: {
              command: "sleep",
              args: ["30"],
            },
            // envReloadDelay defaults to 5000ms
          },
        ],
      },
      testLogger,
    );

    await manager.start();

    const proc = manager.getRestartingProcess("test-proc");
    expect(proc).toBeDefined();

    const initialDefinition = proc!.lazyProcess.definition;
    expect(initialDefinition.env?.TEST_VAR).toBe("original");

    // Wait a bit before changing
    await wait(200);

    // Change env file
    writeFileSync(join(testDir, ".env"), "TEST_VAR=updated");

    // Wait for file watch (100ms debounce) + env reload debounce (100ms) + default reload delay (5000ms) + extra buffer
    await wait(6000);

    // Process should have been reloaded
    const reloadedDefinition = proc!.lazyProcess.definition;
    expect(reloadedDefinition.env?.TEST_VAR).toBe("updated");

    await manager.stop();
  }, 10000); // 10 second timeout

  it("should reload process immediately when envReloadDelay is true", async () => {
    writeFileSync(join(testDir, ".env"), "TEST_VAR=original");

    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
        processes: [
          {
            name: "test-proc",
            definition: {
              command: "sleep",
              args: ["30"],
            },
            envReloadDelay: true, // Immediate reload
          },
        ],
      },
      testLogger,
    );

    await manager.start();

    const proc = manager.getRestartingProcess("test-proc");
    const initialDefinition = proc!.lazyProcess.definition;
    expect(initialDefinition.env?.TEST_VAR).toBe("original");

    await wait(200);

    // Change env file
    writeFileSync(join(testDir, ".env"), "TEST_VAR=updated");

    // Wait for file watch + debounce + immediate reload + process restart
    await wait(1000);

    // Process should have been reloaded quickly
    const reloadedDefinition = proc!.lazyProcess.definition;
    expect(reloadedDefinition.env?.TEST_VAR).toBe("updated");

    await manager.stop();
  }, 5000);

  it("should reload process immediately when envReloadDelay is 'immediately'", async () => {
    writeFileSync(join(testDir, ".env"), "TEST_VAR=original");

    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
        processes: [
          {
            name: "test-proc",
            definition: {
              command: "sleep",
              args: ["30"],
            },
            envReloadDelay: "immediately",
          },
        ],
      },
      testLogger,
    );

    await manager.start();

    const proc = manager.getRestartingProcess("test-proc");
    const initialDefinition = proc!.lazyProcess.definition;
    expect(initialDefinition.env?.TEST_VAR).toBe("original");

    await wait(200);

    // Change env file
    writeFileSync(join(testDir, ".env"), "TEST_VAR=updated");

    // Wait for file watch + debounce + immediate reload
    await wait(1000);

    // Process should have been reloaded quickly
    const reloadedDefinition = proc!.lazyProcess.definition;
    expect(reloadedDefinition.env?.TEST_VAR).toBe("updated");

    await manager.stop();
  }, 5000);

  it("should not reload process when envReloadDelay is false", async () => {
    writeFileSync(join(testDir, ".env"), "TEST_VAR=original");

    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
        processes: [
          {
            name: "test-proc",
            definition: {
              command: "sleep",
              args: ["30"],
            },
            envReloadDelay: false, // Disabled
          },
        ],
      },
      testLogger,
    );

    await manager.start();

    const proc = manager.getRestartingProcess("test-proc");
    const initialDefinition = proc!.lazyProcess.definition;
    expect(initialDefinition.env?.TEST_VAR).toBe("original");

    // Change env file
    writeFileSync(join(testDir, ".env"), "TEST_VAR=updated");

    // Wait to ensure no reload happens
    await wait(1000);

    // Process should NOT have been reloaded
    const definition = proc!.lazyProcess.definition;
    expect(definition.env?.TEST_VAR).toBe("original");

    await manager.stop();
  });

  it("should reload process with custom delay", async () => {
    writeFileSync(join(testDir, ".env"), "TEST_VAR=original");

    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
        processes: [
          {
            name: "test-proc",
            definition: {
              command: "sleep",
              args: ["30"],
            },
            envReloadDelay: 1000, // 1 second
          },
        ],
      },
      testLogger,
    );

    await manager.start();

    const proc = manager.getRestartingProcess("test-proc");
    const initialDefinition = proc!.lazyProcess.definition;
    expect(initialDefinition.env?.TEST_VAR).toBe("original");

    await wait(200);

    // Change env file
    writeFileSync(join(testDir, ".env"), "TEST_VAR=updated");

    // Wait for file watch + debounce + custom 1s delay
    await wait(1800);

    // Process should have been reloaded
    const reloadedDefinition = proc!.lazyProcess.definition;
    expect(reloadedDefinition.env?.TEST_VAR).toBe("updated");

    await manager.stop();
  }, 5000);

  it("should reload only affected processes when process-specific env changes", async () => {
    writeFileSync(join(testDir, ".env"), "GLOBAL=1");
    writeFileSync(join(testDir, ".env.app1"), "APP1_VAR=original");

    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
        processes: [
          {
            name: "app1",
            definition: {
              command: "sleep",
              args: ["30"],
            },
            envReloadDelay: true,
          },
          {
            name: "app2",
            definition: {
              command: "sleep",
              args: ["30"],
            },
            envReloadDelay: true,
          },
        ],
      },
      testLogger,
    );

    await manager.start();

    const proc1 = manager.getRestartingProcess("app1");
    const proc2 = manager.getRestartingProcess("app2");

    const initialDef1 = proc1!.lazyProcess.definition;
    const initialDef2 = proc2!.lazyProcess.definition;

    expect(initialDef1.env?.APP1_VAR).toBe("original");
    expect(initialDef2.env?.APP1_VAR).toBeUndefined();

    await wait(200);

    // Change only app1's env file
    writeFileSync(join(testDir, ".env.app1"), "APP1_VAR=updated");

    await wait(1000);

    // Only app1 should be reloaded
    const reloadedDef1 = proc1!.lazyProcess.definition;
    expect(reloadedDef1.env?.APP1_VAR).toBe("updated");

    // app2 should be unchanged (same definition reference since no reload)
    const def2 = proc2!.lazyProcess.definition;
    expect(def2).toBe(initialDef2);

    await manager.stop();
  }, 5000);

  it("should reload all processes when global env changes", async () => {
    writeFileSync(join(testDir, ".env"), "GLOBAL_VAR=original");

    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
        processes: [
          {
            name: "app1",
            definition: {
              command: "sleep",
              args: ["30"],
            },
            envReloadDelay: true,
          },
          {
            name: "app2",
            definition: {
              command: "sleep",
              args: ["30"],
            },
            envReloadDelay: true,
          },
        ],
      },
      testLogger,
    );

    await manager.start();

    const proc1 = manager.getRestartingProcess("app1");
    const proc2 = manager.getRestartingProcess("app2");

    const initialDef1 = proc1!.lazyProcess.definition;
    const initialDef2 = proc2!.lazyProcess.definition;

    expect(initialDef1.env?.GLOBAL_VAR).toBe("original");
    expect(initialDef2.env?.GLOBAL_VAR).toBe("original");

    await wait(200);

    // Change global env file
    writeFileSync(join(testDir, ".env"), "GLOBAL_VAR=updated");

    await wait(1000);

    // Both processes should be reloaded
    const reloadedDef1 = proc1!.lazyProcess.definition;
    const reloadedDef2 = proc2!.lazyProcess.definition;

    expect(reloadedDef1.env?.GLOBAL_VAR).toBe("updated");
    expect(reloadedDef2.env?.GLOBAL_VAR).toBe("updated");

    await manager.stop();
  }, 5000);
});
