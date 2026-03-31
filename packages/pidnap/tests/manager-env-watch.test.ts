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

  it("should reload process immediately when env file changes by default", async () => {
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
            // reloadDelay defaults to "immediately"
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

    // Wait for file watch + immediate reload + process restart.
    await wait(1000);

    // Process should have been reloaded
    const reloadedDefinition = proc!.lazyProcess.definition;
    expect(reloadedDefinition.env?.TEST_VAR).toBe("updated");

    await manager.stop();
  }, 5000);

  it("should reload process immediately when reloadDelay is true", async () => {
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
            envOptions: { reloadDelay: true }, // Immediate reload
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

  it("should reload process immediately when reloadDelay is 'immediately'", async () => {
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
            envOptions: { reloadDelay: "immediately" },
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

  it("should not reload process when reloadDelay is false", async () => {
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
            envOptions: { reloadDelay: false }, // Disabled
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
            envOptions: { reloadDelay: 1000 }, // 1 second
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
            envOptions: { reloadDelay: true },
          },
          {
            name: "app2",
            definition: {
              command: "sleep",
              args: ["30"],
            },
            envOptions: { reloadDelay: true },
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
            envOptions: { reloadDelay: true },
          },
          {
            name: "app2",
            definition: {
              command: "sleep",
              args: ["30"],
            },
            envOptions: { reloadDelay: true },
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

  it("should skip env-triggered restart when only unrelated env keys change", async () => {
    writeFileSync(
      join(testDir, ".env"),
      "CLOUDFLARE_TUNNEL_TOKEN=original-token\nUNRELATED_VAR=original",
    );

    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
        processes: [
          {
            name: "cloudflare-tunnel",
            definition: {
              command: "sleep",
              args: ["30"],
            },
            envOptions: {
              reloadDelay: true,
              onlyRestartIfChanged: ["CLOUDFLARE_TUNNEL_TOKEN"],
            },
          },
          {
            name: "ungated",
            definition: {
              command: "sleep",
              args: ["30"],
            },
            envOptions: { reloadDelay: true },
          },
        ],
      },
      testLogger,
    );

    await manager.start();

    const gatedProc = manager.getRestartingProcess("cloudflare-tunnel");
    const ungatedProc = manager.getRestartingProcess("ungated");
    const initialGatedDefinition = gatedProc!.lazyProcess.definition;
    const initialUngatedDefinition = ungatedProc!.lazyProcess.definition;

    await wait(200);

    writeFileSync(
      join(testDir, ".env"),
      "CLOUDFLARE_TUNNEL_TOKEN=original-token\nUNRELATED_VAR=updated",
    );

    await wait(1000);

    expect(gatedProc!.lazyProcess.definition).toBe(initialGatedDefinition);
    expect(gatedProc!.lazyProcess.definition.env?.UNRELATED_VAR).toBe("original");

    expect(ungatedProc!.lazyProcess.definition).not.toBe(initialUngatedDefinition);
    expect(ungatedProc!.lazyProcess.definition.env?.UNRELATED_VAR).toBe("updated");

    await manager.stop();
  }, 5000);

  it("should reload process when an allowlisted env key changes", async () => {
    writeFileSync(
      join(testDir, ".env"),
      "CLOUDFLARE_TUNNEL_TOKEN=original-token\nUNRELATED_VAR=original",
    );

    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
        processes: [
          {
            name: "cloudflare-tunnel",
            definition: {
              command: "sleep",
              args: ["30"],
            },
            envOptions: {
              reloadDelay: true,
              onlyRestartIfChanged: ["CLOUDFLARE_TUNNEL_TOKEN"],
            },
          },
        ],
      },
      testLogger,
    );

    await manager.start();

    const proc = manager.getRestartingProcess("cloudflare-tunnel");
    const initialDefinition = proc!.lazyProcess.definition;

    await wait(200);

    writeFileSync(
      join(testDir, ".env"),
      "CLOUDFLARE_TUNNEL_TOKEN=updated-token\nUNRELATED_VAR=updated",
    );

    await wait(1000);

    const reloadedDefinition = proc!.lazyProcess.definition;
    expect(reloadedDefinition).not.toBe(initialDefinition);
    expect(reloadedDefinition.env?.CLOUDFLARE_TUNNEL_TOKEN).toBe("updated-token");

    await manager.stop();
  }, 5000);

  it("should ignore global env changes when inheritGlobalEnv is false", async () => {
    writeFileSync(
      join(testDir, ".env"),
      "CLOUDFLARE_TUNNEL_TOKEN=global-token\nUNRELATED_VAR=original",
    );
    writeFileSync(join(testDir, ".env.cloudflare-tunnel"), "CLOUDFLARE_TUNNEL_TOKEN=process-token");

    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
        processes: [
          {
            name: "cloudflare-tunnel",
            definition: {
              command: "sleep",
              args: ["30"],
            },
            envOptions: {
              inheritGlobalEnv: false,
              reloadDelay: true,
              onlyRestartIfChanged: ["CLOUDFLARE_TUNNEL_TOKEN"],
            },
          },
        ],
      },
      testLogger,
    );

    await manager.start();

    const proc = manager.getRestartingProcess("cloudflare-tunnel");
    const initialDefinition = proc!.lazyProcess.definition;
    expect(initialDefinition.env?.CLOUDFLARE_TUNNEL_TOKEN).toBe("process-token");
    expect(initialDefinition.env?.UNRELATED_VAR).toBeUndefined();

    await wait(200);

    writeFileSync(
      join(testDir, ".env"),
      "CLOUDFLARE_TUNNEL_TOKEN=global-token-updated\nUNRELATED_VAR=updated",
    );

    await wait(1000);

    expect(proc!.lazyProcess.definition).toBe(initialDefinition);
    expect(proc!.lazyProcess.definition.env?.CLOUDFLARE_TUNNEL_TOKEN).toBe("process-token");
    expect(proc!.lazyProcess.definition.env?.UNRELATED_VAR).toBeUndefined();

    await manager.stop();
  }, 5000);
});
