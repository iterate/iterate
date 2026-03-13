import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod/v4";
import {
  Deployment,
  createDeploymentSlug,
  DEPLOYMENT_SLUG_MAX_LENGTH,
  assertValidDeploymentSlug,
  isValidDeploymentSlug,
} from "./deployment.ts";
import type {
  DeploymentExecResult,
  DeploymentOpts,
  DeploymentProvider,
  DeploymentProviderStatus,
} from "./deployment-provider-manifest.ts";

type TestInstanceSpecificOpts = DeploymentOpts & {
  image?: string;
};

type TestLocator = {
  provider: "test";
  id: string;
};

class FakeProvider implements DeploymentProvider<TestInstanceSpecificOpts, TestLocator> {
  readonly name = "test";
  readonly providerOptsSchema = z.object({});
  readonly optsSchema = z.object({
    slug: z.string().min(1),
    rootfsSurvivesRestart: z.boolean().optional(),
    env: z.record(z.string(), z.string()).optional(),
    image: z.string().min(1).optional(),
    entrypoint: z.array(z.string()).optional(),
    cmd: z.array(z.string()).optional(),
  });
  readonly locatorSchema = z.object({
    provider: z.literal("test"),
    id: z.string().min(1),
  });
  public readonly created: Array<{ signal?: AbortSignal; opts: TestInstanceSpecificOpts }> = [];
  public readonly connected: Array<{ signal?: AbortSignal; locator: TestLocator }> = [];
  public logSnapshots: string[] = [];
  public holdLogsOpen = false;
  public envFileContent: string | null = null;
  public recoveredOpts: TestInstanceSpecificOpts = {
    slug: "runtime-slug",
    image: "sandbox:test",
  };
  public statusValue: DeploymentProviderStatus = {
    state: "running" as const,
    detail: "ok",
  };
  public execImpl: DeploymentProvider<TestInstanceSpecificOpts, TestLocator>["exec"] | null = null;
  public statusImpl: DeploymentProvider<TestInstanceSpecificOpts, TestLocator>["status"] | null =
    null;

  async create(params: { signal?: AbortSignal; opts: TestInstanceSpecificOpts }) {
    this.created.push(params);
    return {
      locator: { provider: "test", id: "created" } as const,
      baseUrl: "http://created.test",
    };
  }

  async connect(params: { signal?: AbortSignal; locator: TestLocator }) {
    this.connected.push(params);
    return {
      locator: params.locator,
      baseUrl: "http://connected.test",
    };
  }

  async recoverOpts(): Promise<TestInstanceSpecificOpts> {
    return this.recoveredOpts;
  }

  async start() {}

  async stop() {}

  async destroy() {}

  async exec(params: { signal?: AbortSignal; locator: TestLocator; cmd: string[] }) {
    const runtimeEnvResult = this.handleRuntimeEnvShell(params.cmd);
    if (runtimeEnvResult) {
      return runtimeEnvResult;
    }
    if (this.execImpl) {
      return await this.execImpl(params);
    }
    return {
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      output: "ok",
    };
  }

  async *logs(params: { locator: TestLocator; signal: AbortSignal; tail?: number }) {
    const next = this.logSnapshots.shift() ?? "";
    for (const line of next.split(/\r?\n/)) {
      if (line.length === 0) continue;
      yield { text: line };
    }
    if (!this.holdLogsOpen) return;
    await new Promise<void>((_resolve, reject) => {
      params.signal.addEventListener(
        "abort",
        () => {
          reject(
            params.signal.reason instanceof Error ? params.signal.reason : new Error("aborted"),
          );
        },
        { once: true },
      );
    });
  }

  async status(params: { signal?: AbortSignal; locator: TestLocator }) {
    if (this.statusImpl) {
      return await this.statusImpl(params);
    }
    return this.statusValue;
  }

  private handleRuntimeEnvShell(cmd: string[]) {
    const shellScript = cmd[2] ?? "";
    if (shellScript.includes("__DEPLOYMENT_ENV_PRESENT__")) {
      const stdout =
        this.envFileContent == null
          ? "__DEPLOYMENT_ENV_MISSING__"
          : `__DEPLOYMENT_ENV_PRESENT__\n${this.envFileContent}`;
      return {
        exitCode: 0,
        stdout,
        stderr: "",
        output: stdout,
      };
    }
    if (shellScript.includes("__DEPLOYMENT_ENV_FILE__")) {
      const [, rest = ""] = shellScript.split("<<'__DEPLOYMENT_ENV_FILE__'\n");
      const markerIndex = rest.indexOf("\n__DEPLOYMENT_ENV_FILE__");
      this.envFileContent = markerIndex >= 0 ? rest.slice(0, markerIndex) : rest;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        output: "",
      };
    }
    return null;
  }
}

describe("Deployment", () => {
  test("createDeploymentSlug builds a deployment-safe slug with optional date prefix", () => {
    const slug = createDeploymentSlug({
      input: "Local Ingress / Docker",
      includeDate: true,
      now: new Date("2026-03-10T12:00:00Z"),
    });

    expect(slug).toBe("20260310-local-ingress-docker");
    expect(isValidDeploymentSlug(slug)).toBe(true);
  });

  test("createDeploymentSlug caps deployment slugs to the deployment slug limit", () => {
    const slug = createDeploymentSlug({
      input:
        "local ingress docker default service changes and restart persistence across very long task names",
      includeDate: true,
      now: new Date("2026-03-10T12:00:00Z"),
    });

    expect(slug.length).toBeLessThanOrEqual(DEPLOYMENT_SLUG_MAX_LENGTH);
    expect(isValidDeploymentSlug(slug)).toBe(true);
    expect(slug.startsWith("20260310-")).toBe(true);
  });

  test("assertValidDeploymentSlug rejects invalid slugs", () => {
    expect(() => assertValidDeploymentSlug("UPPERCASE")).toThrow(/Invalid deployment slug/);
    expect(() => assertValidDeploymentSlug("-leading-dash")).toThrow(/Invalid deployment slug/);
    expect(() => assertValidDeploymentSlug("has_underscore")).toThrow(/Invalid deployment slug/);
    expect(() => assertValidDeploymentSlug("a".repeat(DEPLOYMENT_SLUG_MAX_LENGTH + 1))).toThrow(
      /Invalid deployment slug/,
    );
  });

  test("create attaches slug and provider result", async () => {
    const provider = new FakeProvider();
    const deployment = await Deployment.create({
      provider,
      opts: {
        slug: "example-slug",
        image: "sandbox:test",
      },
    });
    const locator = deployment.locator;

    expect(locator).toEqual({ provider: "test", id: "created" });
    expect(provider.created).toEqual([
      {
        opts: {
          slug: "example-slug",
          image: "sandbox:test",
        },
      },
    ]);
    expect(deployment.slug).toBe("runtime-slug");
    expect(deployment.baseUrl).toBe("http://created.test");
    expect(deployment.opts).toEqual({
      slug: "runtime-slug",
      image: "sandbox:test",
    });
  });

  test("create rejects invalid slug input before provisioning", async () => {
    const provider = new FakeProvider();
    await expect(
      Deployment.create({
        provider,
        opts: {
          slug: "INVALID_SLUG",
          image: "sandbox:test",
        },
      }),
    ).rejects.toThrow(/Invalid deployment slug/);

    expect(provider.created).toHaveLength(0);
  });

  test("connect rehydrates an existing locator", async () => {
    const provider = new FakeProvider();
    provider.envFileContent = 'FROM_FILE="live"\nOTHER_VALUE="2"';
    provider.recoveredOpts = {
      slug: "runtime-slug",
      image: "sandbox:test",
      env: {
        FROM_FILE: "stale",
      },
    };
    const deployment = await Deployment.connect({
      provider,
      locator: { provider: "test", id: "existing" },
    });
    const locator = deployment.locator;

    expect(locator).toEqual({ provider: "test", id: "existing" });
    expect(provider.connected).toEqual([
      {
        locator: { provider: "test", id: "existing" },
      },
    ]);
    expect(deployment.baseUrl).toBe("http://connected.test");
    expect(deployment.opts).toEqual({
      slug: "runtime-slug",
      image: "sandbox:test",
      env: {
        FROM_FILE: "live",
        OTHER_VALUE: "2",
      },
    });
    expect(deployment.env).toEqual({
      FROM_FILE: "live",
      OTHER_VALUE: "2",
    });
  });

  test("create bootstraps recovered env into the runtime env file", async () => {
    const provider = new FakeProvider();
    provider.recoveredOpts = {
      slug: "runtime-slug",
      image: "sandbox:test",
      env: {
        CUSTOM_TOKEN: "abc123",
        ITERATE_INGRESS_HOST: "runtime.example.test",
      },
    };

    const deployment = await Deployment.create({
      provider,
      opts: {
        slug: "example-slug",
        image: "sandbox:test",
      },
    });

    expect(provider.envFileContent).toBe(
      'CUSTOM_TOKEN="abc123"\nITERATE_INGRESS_HOST="runtime.example.test"',
    );
    expect(deployment.env).toEqual({
      CUSTOM_TOKEN: "abc123",
      ITERATE_INGRESS_HOST: "runtime.example.test",
    });
  });

  test("logs yields provider log entries", async () => {
    const provider = new FakeProvider();
    provider.logSnapshots = ["hello\nworld\n"];
    const deployment = await Deployment.create({
      provider,
      opts: {
        slug: "stream-slug",
        image: "sandbox:test",
      },
    });

    const eventStream = deployment.logs({
      signal: AbortSignal.timeout(50),
    });
    const iterator = eventStream[Symbol.asyncIterator]();

    const first = await iterator.next();
    const second = await iterator.next();
    const third = await iterator.next();
    const fourth = await iterator.next();

    expect(first.value).toMatchObject({
      text: "hello",
      observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(second.value).toMatchObject({
      text: "world",
      observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(third.done).toBe(true);
    expect(fourth.done).toBe(true);
  });

  test("logs polling refreshes provider status in snapshot", async () => {
    const provider = new FakeProvider();
    provider.statusValue = {
      state: "stopped",
      detail: "not running",
    };
    const deployment = await Deployment.create({
      provider,
      opts: {
        slug: "status-slug",
        image: "sandbox:test",
      },
    });

    const logs = deployment.logs({
      signal: AbortSignal.timeout(50),
      tail: 0,
    });
    const iterator = logs[Symbol.asyncIterator]();
    await iterator.next();

    expect(deployment.snapshot().providerStatus).toMatchObject({
      state: "stopped",
      detail: "not running",
    });
  });

  test("logs cleanup does not wait for caller abort after iterator closes early", async () => {
    const provider = new FakeProvider();
    provider.logSnapshots = ["hello\n"];
    const deployment = await Deployment.create({
      provider,
      opts: {
        slug: "early-close-slug",
        image: "sandbox:test",
      },
    });
    const controller = new AbortController();
    const logs = deployment.logs({
      signal: controller.signal,
    });
    const iterator = logs[Symbol.asyncIterator]();

    await iterator.next();
    const result = await Promise.race([
      iterator.return?.(),
      sleep(100).then(() => "timed-out" as const),
    ]);

    expect(result).not.toBe("timed-out");
  });

  test("logs abort does not warn for expected status-poll cancellation", async () => {
    const provider = new FakeProvider();
    provider.holdLogsOpen = true;
    provider.statusImpl = async (params) => {
      await new Promise<void>((_resolve, reject) => {
        params.signal?.addEventListener(
          "abort",
          () => {
            reject(
              params.signal?.reason instanceof Error ? params.signal.reason : new Error("aborted"),
            );
          },
          { once: true },
        );
      });
      return provider.statusValue;
    };
    const deployment = await Deployment.create({
      provider,
      opts: {
        slug: "abort-cleanup-slug",
        image: "sandbox:test",
      },
    });
    const controller = new AbortController();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logs = deployment.logs({
      signal: controller.signal,
      tail: 0,
    });
    const iterator = logs[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    controller.abort();
    await nextPromise;

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("shell composes timeoutMs into the provider signal", async () => {
    const provider = new FakeProvider();
    provider.execImpl = async (params) => {
      const runtimeEnvResult = provider["handleRuntimeEnvShell"](params.cmd);
      if (runtimeEnvResult) {
        return runtimeEnvResult;
      }
      return await new Promise<DeploymentExecResult>((_resolve, reject) => {
        params.signal?.addEventListener(
          "abort",
          () => {
            reject(
              params.signal?.reason instanceof Error ? params.signal.reason : new Error("aborted"),
            );
          },
          { once: true },
        );
      });
    };
    const deployment = await Deployment.create({
      provider,
      opts: {
        slug: "shell-timeout-slug",
        image: "sandbox:test",
      },
    });

    await expect(
      deployment.shell({
        cmd: "echo never",
        timeoutMs: 10,
      }),
    ).rejects.toThrow();
  });

  test("reloadEnv re-reads the runtime env file and updates deployment.env", async () => {
    const provider = new FakeProvider();
    provider.envFileContent = 'ALPHA="1"';
    const deployment = await Deployment.connect({
      provider,
      locator: { provider: "test", id: "existing" },
    });

    provider.envFileContent = 'ALPHA="2"\nBETA="3"';
    const reloaded = await deployment.reloadEnv();

    expect(reloaded).toEqual({
      ALPHA: "2",
      BETA: "3",
    });
    expect(deployment.env).toEqual({
      ALPHA: "2",
      BETA: "3",
    });
  });

  test("setEnvVars accepts shell-compatible non-typed keys and rewrites full env content", async () => {
    const provider = new FakeProvider();
    provider.recoveredOpts = {
      slug: "runtime-slug",
      image: "sandbox:test",
      env: {
        EXISTING_VALUE: "one",
      },
    };
    const deployment = await Deployment.create({
      provider,
      opts: {
        slug: "env-update-slug",
        image: "sandbox:test",
      },
    });

    await deployment.setEnvVars(
      {
        CUSTOM_TOKEN: "two",
      },
      { waitForHealthy: false },
    );

    expect(provider.envFileContent).toBe('CUSTOM_TOKEN="two"\nEXISTING_VALUE="one"');
    expect(deployment.env).toEqual({
      CUSTOM_TOKEN: "two",
      EXISTING_VALUE: "one",
    });
  });

  test("setEnvVars rejects non-shell-compatible keys", async () => {
    const provider = new FakeProvider();
    const deployment = await Deployment.create({
      provider,
      opts: {
        slug: "invalid-env-key-slug",
        image: "sandbox:test",
      },
    });

    await expect(
      deployment.setEnvVars(
        {
          "NOT-VALID": "x",
        },
        { waitForHealthy: false },
      ),
    ).rejects.toThrow(/Invalid environment variable key/);
  });

  test("setEnvVars waits for healthy by default", async () => {
    const provider = new FakeProvider();
    const deployment = await Deployment.create({
      provider,
      opts: {
        slug: "wait-default-slug",
        image: "sandbox:test",
      },
    });
    const waitUntilHealthySpy = vi
      .spyOn(deployment, "waitUntilHealthy")
      .mockImplementation(async () => {});
    const waitForConfiguredTargetsSpy = vi
      .spyOn(
        deployment as unknown as {
          waitForConfiguredNetworkTargets: (params: {
            env: Record<string, string>;
            timeoutMs: number;
          }) => Promise<void>;
        },
        "waitForConfiguredNetworkTargets",
      )
      .mockImplementation(async () => {});

    await deployment.setEnvVars({
      CUSTOM_TOKEN: "value",
    });

    expect(waitUntilHealthySpy).toHaveBeenCalledOnce();
    expect(waitForConfiguredTargetsSpy).toHaveBeenCalledOnce();
  });
});
