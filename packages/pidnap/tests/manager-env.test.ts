import { writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Manager } from "../src/manager.ts";
import { logger } from "../src/logger.ts";

describe("Manager with EnvManager integration", () => {
  const testDir = join(import.meta.dirname, ".temp/manager-env");

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

  it("should merge env vars in correct order: .env -> config.env -> envFile -> definition.env", async () => {
    // Create env files
    writeFileSync(join(testDir, ".env"), "BASE=from_dotenv\nOVERRIDE=dotenv");
    writeFileSync(join(testDir, "custom.env"), "CUSTOM=from_custom\nOVERRIDE=custom");

    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
        env: {
          GLOBAL_CONFIG: "from_config",
          OVERRIDE: "config",
        },
        processes: [
          {
            name: "app1",
            definition: {
              command: "echo",
              args: ["test"],
              env: {
                SPECIFIC: "from_definition",
                OVERRIDE: "definition",
              },
            },
            envOptions: { envFile: "custom.env" }, // This replaces .env.app1 (if any)
          },
        ],
      },
      testLogger,
    );

    await manager.start();

    const proc = manager.getRestartingProcess("app1");
    expect(proc).toBeDefined();

    // Get the process definition to check merged env (via lazyProcess)
    const definition = proc!.lazyProcess.definition;

    // Merge order: .env (global) -> config.env -> envFile -> definition.env
    // Note: When envFile is specified, it replaces .env.<name> auto-discovery
    expect(definition.env).toEqual({
      BASE: "from_dotenv", // From .env
      GLOBAL_CONFIG: "from_config", // From config.env
      CUSTOM: "from_custom", // From custom.env (envFile)
      SPECIFIC: "from_definition", // From definition.env
      OVERRIDE: "definition", // Highest priority wins
    });

    await manager.stop();
  });

  it("should load .env.* files based on process name", async () => {
    writeFileSync(join(testDir, ".env"), "GLOBAL=base");
    writeFileSync(join(testDir, ".env.worker"), "WORKER_VAR=worker_value");

    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
        processes: [
          {
            name: "worker",
            definition: {
              command: "echo",
              args: ["test"],
            },
          },
        ],
      },
      testLogger,
    );

    await manager.start();

    const proc = manager.getRestartingProcess("worker");
    const definition = proc!.lazyProcess.definition;

    expect(definition.env).toEqual({
      GLOBAL: "base",
      WORKER_VAR: "worker_value",
    });

    await manager.stop();
  });

  it("should handle custom envFile on process entry", async () => {
    writeFileSync(join(testDir, "custom.env"), "CUSTOM_VAR=custom_value");
    writeFileSync(join(testDir, ".env.app"), "APP_VAR=app_value"); // Should be ignored

    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
        processes: [
          {
            name: "app",
            definition: {
              command: "echo",
              args: ["test"],
            },
            envOptions: { envFile: "custom.env" }, // Custom env file overrides .env.app
          },
        ],
      },
      testLogger,
    );

    await manager.start();

    const proc = manager.getRestartingProcess("app");
    const definition = proc!.lazyProcess.definition;

    // When envFile is specified, it replaces .env.<name> auto-discovery
    expect(definition.env).toEqual({
      CUSTOM_VAR: "custom_value",
    });

    await manager.stop();
  });

  it("should work without any env files", async () => {
    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
        env: {
          CONFIG_VAR: "config_value",
        },
        processes: [
          {
            name: "simple",
            definition: {
              command: "echo",
              args: ["test"],
              env: {
                SPECIFIC: "specific_value",
              },
            },
          },
        ],
      },
      testLogger,
    );

    await manager.start();

    const proc = manager.getRestartingProcess("simple");
    const definition = proc!.lazyProcess.definition;

    expect(definition.env).toEqual({
      CONFIG_VAR: "config_value",
      SPECIFIC: "specific_value",
    });

    await manager.stop();
  });

  it("should add process at runtime with env merging", async () => {
    writeFileSync(join(testDir, ".env"), "GLOBAL=base");
    writeFileSync(join(testDir, ".env.dynamic"), "DYNAMIC_VAR=dynamic_value");

    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
        env: {
          CONFIG_VAR: "config_value",
        },
      },
      testLogger,
    );

    await manager.start();

    const proc = await manager.addProcess("dynamic", {
      command: "echo",
      args: ["dynamic"],
      env: {
        SPECIFIC: "specific_value",
      },
    });

    const definition = proc!.lazyProcess.definition;

    expect(definition.env).toEqual({
      GLOBAL: "base",
      DYNAMIC_VAR: "dynamic_value",
      CONFIG_VAR: "config_value",
      SPECIFIC: "specific_value",
    });

    await manager.stop();
  });

  it("should skip global env when inheritGlobalEnv is false", async () => {
    writeFileSync(join(testDir, ".env"), "GLOBAL=base\nSHARED=global");
    writeFileSync(join(testDir, ".env.app"), "APP_VAR=app_value\nSHARED=app");

    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
        env: {
          CONFIG_VAR: "config_value",
        },
        processes: [
          {
            name: "app",
            definition: {
              command: "echo",
              args: ["test"],
              env: {
                SPECIFIC: "specific_value",
              },
            },
            envOptions: { inheritGlobalEnv: false },
          },
        ],
      },
      testLogger,
    );

    await manager.start();

    const proc = manager.getRestartingProcess("app");
    const definition = proc!.lazyProcess.definition;

    // Should NOT include GLOBAL from .env, but should include .env.app, config, and definition
    expect(definition.env).toEqual({
      APP_VAR: "app_value",
      SHARED: "app", // From .env.app (not from .env since global is skipped)
      CONFIG_VAR: "config_value",
      SPECIFIC: "specific_value",
    });

    await manager.stop();
  });

  it("should set inheritProcessEnv to false on definition", async () => {
    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
        processes: [
          {
            name: "isolated",
            definition: {
              command: "echo",
              args: ["test"],
              env: {
                ONLY_THIS: "value",
              },
            },
            envOptions: { inheritProcessEnv: false },
          },
        ],
      },
      testLogger,
    );

    await manager.start();

    const proc = manager.getRestartingProcess("isolated");
    const definition = proc!.lazyProcess.definition;

    // Should have inheritProcessEnv set to false
    expect(definition.inheritProcessEnv).toBe(false);
    expect(definition.env).toEqual({
      ONLY_THIS: "value",
    });

    await manager.stop();
  });

  it("should combine inheritGlobalEnv and inheritProcessEnv options", async () => {
    writeFileSync(join(testDir, ".env"), "GLOBAL=base");
    writeFileSync(join(testDir, "custom.env"), "CUSTOM=value");

    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
        env: {
          CONFIG: "config_value",
        },
        processes: [
          {
            name: "minimal",
            definition: {
              command: "echo",
              args: ["test"],
              env: {
                ONLY: "this",
              },
            },
            envOptions: {
              envFile: "custom.env",
              inheritGlobalEnv: false,
              inheritProcessEnv: false,
            },
          },
        ],
      },
      testLogger,
    );

    await manager.start();

    const proc = manager.getRestartingProcess("minimal");
    const definition = proc!.lazyProcess.definition;

    // Should NOT include GLOBAL from .env
    // Should include custom.env vars, config.env, and definition.env
    expect(definition.env).toEqual({
      CUSTOM: "value", // From custom.env
      CONFIG: "config_value", // From config.env
      ONLY: "this", // From definition.env
    });
    expect(definition.inheritProcessEnv).toBe(false);

    await manager.stop();
  });

  it("should work with addProcess and envOptions", async () => {
    writeFileSync(join(testDir, ".env"), "GLOBAL=base");

    const testLogger = logger({ name: "test" });
    const manager = new Manager(
      {
        cwd: testDir,
      },
      testLogger,
    );

    await manager.start();

    const proc = await manager.addProcess(
      "dynamic-proc",
      {
        command: "echo",
        args: ["proc"],
        env: { PROC_ENV: "value" },
      },
      undefined, // options
      { inheritGlobalEnv: false, inheritProcessEnv: false },
    );

    const definition = proc!.lazyProcess.definition;

    // Should NOT include GLOBAL from .env
    expect(definition.env).toEqual({
      PROC_ENV: "value",
    });
    expect(definition.inheritProcessEnv).toBe(false);

    await manager.stop();
  });
});
