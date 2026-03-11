import { describe, expect, test } from "vitest";
import { z } from "zod/v4";
import {
  Deployment,
  createDeploymentSlug,
  DEPLOYMENT_SLUG_MAX_LENGTH,
  assertValidDeploymentSlug,
  type DeploymentProvider,
  type DeploymentOpts,
  isValidDeploymentSlug,
} from "./deployment.ts";

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
  public statusValue = {
    state: "running",
    detail: "ok",
  };

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
    return {
      slug: "runtime-slug",
      image: "sandbox:test",
    };
  }

  async start() {}

  async stop() {}

  async destroy() {}

  async exec() {
    return {
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      output: "ok",
    };
  }

  async *logs() {
    const next = this.logSnapshots.shift() ?? "";
    for (const line of next.split(/\r?\n/)) {
      if (line.length === 0) continue;
      yield { line };
    }
  }

  async status() {
    return this.statusValue;
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
    });
  });

  test("events yields provider log events", async () => {
    const provider = new FakeProvider();
    provider.logSnapshots = ["hello\nworld\n"];
    const deployment = await Deployment.create({
      provider,
      opts: {
        slug: "stream-slug",
        image: "sandbox:test",
      },
    });

    const eventStream = deployment.events({
      signal: AbortSignal.timeout(50),
    });
    const iterator = eventStream[Symbol.asyncIterator]();

    const first = await iterator.next();
    const second = await iterator.next();
    const third = await iterator.next();

    expect(first.value).toMatchObject({
      type: "https://events.iterate.com/deployment/started",
      payload: { detail: "ok" },
    });
    expect(second.value).toMatchObject({
      type: "https://events.iterate.com/deployment/logged",
      payload: { line: "hello" },
    });
    expect(third.value).toMatchObject({
      type: "https://events.iterate.com/deployment/logged",
      payload: { line: "world" },
    });
  });
});
