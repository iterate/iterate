import { writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EnvManager } from "../src/env-manager.ts";
import { logger as baseLogger } from "../src/logger.ts";

describe("EnvManager", () => {
  const testDir = join(import.meta.dirname, ".temp/env-manager");
  const logger = baseLogger({ name: "env-manager" });

  beforeEach(() => {
    // Create a temporary directory for test env files
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should load .env file as global", () => {
    writeFileSync(join(testDir, ".env"), "GLOBAL_VAR=global_value");

    const envManager = new EnvManager({ cwd: testDir }, logger);
    // Use a dummy key to get global vars (they're always merged)
    const env = envManager.getEnvVars("any-key");

    expect(env).toEqual({ GLOBAL_VAR: "global_value" });
    envManager.close();
  });

  it("should load .env.* files", () => {
    writeFileSync(join(testDir, ".env"), "BASE_VAR=base");
    writeFileSync(join(testDir, ".env.app"), "APP_VAR=app_value");
    writeFileSync(join(testDir, ".env.test"), "TEST_VAR=test_value");

    const envManager = new EnvManager({ cwd: testDir }, logger);

    expect(envManager.getEnvVars("nonexistent")).toEqual({ BASE_VAR: "base" });
    expect(envManager.getEnvVars("app")).toEqual({
      BASE_VAR: "base",
      APP_VAR: "app_value",
    });
    expect(envManager.getEnvVars("test")).toEqual({
      BASE_VAR: "base",
      TEST_VAR: "test_value",
    });
    envManager.close();
  });

  it("should override global vars with process-specific vars", () => {
    writeFileSync(join(testDir, ".env"), "VAR=global");
    writeFileSync(join(testDir, ".env.app"), "VAR=app_specific");

    const envManager = new EnvManager({ cwd: testDir }, logger);
    const appEnv = envManager.getEnvVars("app");

    expect(appEnv.VAR).toBe("app_specific");
    envManager.close();
  });

  it("should load explicitly specified files via customEnvFiles", () => {
    writeFileSync(join(testDir, "custom.env"), "CUSTOM_VAR=custom_value");

    const envManager = new EnvManager(
      {
        cwd: testDir,
        customEnvFiles: {
          custom: "custom.env",
        },
      },
      logger,
    );

    expect(envManager.getEnvVars("custom")).toEqual({ CUSTOM_VAR: "custom_value" });
    envManager.close();
  });

  it("should handle non-existent files gracefully", () => {
    const envManager = new EnvManager(
      {
        cwd: testDir,
        customEnvFiles: {
          missing: "non-existent.env",
        },
      },
      logger,
    );

    // Should return just global env (which is empty)
    expect(envManager.getEnvVars("missing")).toEqual({});
    envManager.close();
  });

  it("should return empty object when no env files exist", () => {
    const envManager = new EnvManager({ cwd: testDir }, logger);

    expect(envManager.getEnvVars("nonexistent")).toEqual({});
    expect(envManager.getEnvVars("app")).toEqual({});
    envManager.close();
  });

  it("should merge multiple env files correctly", () => {
    writeFileSync(join(testDir, ".env"), "A=1\nB=2");
    writeFileSync(join(testDir, ".env.prod"), "B=3\nC=4");

    const envManager = new EnvManager({ cwd: testDir }, logger);
    const prodEnv = envManager.getEnvVars("prod");

    expect(prodEnv).toEqual({
      A: "1",
      B: "3", // Overridden by .env.prod
      C: "4",
    });
    envManager.close();
  });

  it("should handle absolute paths in customEnvFiles config", () => {
    const absolutePath = join(testDir, "absolute.env");
    writeFileSync(absolutePath, "ABSOLUTE_VAR=absolute");

    const envManager = new EnvManager(
      {
        cwd: testDir,
        customEnvFiles: {
          abs: absolutePath,
        },
      },
      logger,
    );

    expect(envManager.getEnvVars("abs")).toEqual({ ABSOLUTE_VAR: "absolute" });
    envManager.close();
  });

  it("should use custom globalEnvFile when specified", () => {
    writeFileSync(join(testDir, "custom-global.env"), "CUSTOM_GLOBAL=value");

    const envManager = new EnvManager(
      {
        cwd: testDir,
        globalEnvFile: "custom-global.env",
      },
      logger,
    );

    expect(envManager.getEnvVars("any-key")).toEqual({ CUSTOM_GLOBAL: "value" });
    envManager.close();
  });

  it("should handle customEnvFiles overriding auto-discovered files", () => {
    writeFileSync(join(testDir, ".env"), "GLOBAL=original");
    writeFileSync(join(testDir, ".env.app"), "APP=from_dotenv_app");
    writeFileSync(join(testDir, "override.env"), "APP=from_override");

    const envManager = new EnvManager(
      {
        cwd: testDir,
        customEnvFiles: {
          app: "override.env", // Override .env.app
        },
      },
      logger,
    );

    // The custom file should be used instead of .env.app
    expect(envManager.getEnvVars("app")).toEqual({
      GLOBAL: "original",
      APP: "from_override",
    });
    envManager.close();
  });

  it("should register files dynamically via registerFile", () => {
    writeFileSync(join(testDir, "dynamic.env"), "DYNAMIC=value");

    const envManager = new EnvManager({ cwd: testDir }, logger);

    // Initially no dynamic key
    expect(envManager.getEnvVars("dynamic")).toEqual({});

    // Register the file
    envManager.registerFile("dynamic", "dynamic.env");

    expect(envManager.getEnvVars("dynamic")).toEqual({ DYNAMIC: "value" });
    envManager.close();
  });

  it("should track custom files via hasCustomFile", () => {
    writeFileSync(join(testDir, "custom.env"), "VAR=value");

    const envManager = new EnvManager(
      {
        cwd: testDir,
        customEnvFiles: {
          custom: "custom.env",
        },
      },
      logger,
    );

    expect(envManager.hasCustomFile("custom")).toBe(true);
    expect(envManager.hasCustomFile("other")).toBe(false);
    envManager.close();
  });
});
