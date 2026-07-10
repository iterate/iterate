import { expect, it } from "vitest";

import { builderConfig, config } from "./generate-wrangler-config.ts";

// Wrangler tags every `--env` deploy with `cf:service=<top-level name>` and
// `cf:environment=<env>`. The top-level names below are therefore the fleet's
// observability service identities, not just local dev worker names — an
// env-flavored name here ("os-dev") mis-buckets every deployed environment
// under a fake "dev" service (observed live on os-prd-builder, 2026-07-04).
it("names the top-level configs by service so cf:service script tags stay env-less", () => {
  expect(config.name).toBe("os");
  expect(builderConfig.name).toBe("os-builder");
});

it("gives every deployed env its own worker name derived from the service name", () => {
  for (const [envName, envBlock] of Object.entries(config.env)) {
    expect(envBlock.name, envName).toMatch(/^os-/);
    expect(envBlock.name, envName).not.toBe(config.name);
  }
  for (const [envName, envBlock] of Object.entries(builderConfig.env)) {
    expect(envBlock.name, envName).toMatch(/^os-.*-builder$/);
    expect(envBlock.name, envName).not.toBe(builderConfig.name);
  }
});

it("binds the os worker to its own env's builder sidecar", () => {
  for (const [envName, envBlock] of Object.entries(config.env)) {
    const builder = envBlock.services.find((service) => service.binding === "BUILDER");
    expect(builder?.service, envName).toBe(`${envBlock.name}-builder`);
    const builderNames = Object.values(builderConfig.env).map((builderEnv) => builderEnv.name);
    expect(builderNames, envName).toContain(builder?.service);
  }
});

it("routes public event docs hosts to the os worker", () => {
  const productionRoutes = config.env.prd.routes ?? [];

  expect(productionRoutes).toContainEqual({
    pattern: "events.iterate.com/*",
    zone_name: "iterate.com",
  });
});

it("routes Cloudflare for SaaS custom hostnames through the project provider zone", () => {
  expect(config.env.prd.routes ?? []).toContainEqual({
    pattern: "*/*",
    zone_name: "iterate.app",
  });
});

it("does not add SaaS catch-all routes to preview zones without SSL-for-SaaS quota", () => {
  expect(config.env.preview_6.routes ?? []).not.toContainEqual({
    pattern: "*/*",
    zone_name: "iterate-preview-6.app",
  });
  expect(config.env.preview_6.routes ?? []).toContainEqual({
    pattern: "*.iterate-preview-6.app/*",
    zone_name: "iterate-preview-6.app",
  });
});

it("pins newborn agents to an account-safe default model outside production", () => {
  expect(config.env.prd.vars?.APP_CONFIG_DEFAULT_AGENT_MODEL).toBeUndefined();
  expect(config.env.preview_2.vars?.APP_CONFIG_DEFAULT_AGENT_MODEL).toBe(
    "@cf/moonshotai/kimi-k2.7-code",
  );
  expect(config.vars?.APP_CONFIG_DEFAULT_AGENT_MODEL).toBe("@cf/moonshotai/kimi-k2.7-code");
});

// One container class per Cloudflare instance type, with the instance type
// as its own wrangler `instance_type` — the whole point of the per-type
// class split (instance-types.ts). Deploy-time quota is validated per
// account as Σ(max_instances × instance memory), and the preview account is
// shared by every slot — so previews must reserve strictly less than
// production. Memory per type (GiB): lite 0.25, basic 1, standard-1 4,
// standard-2 6, standard-3 8, standard-4 12.
it("keeps deployed sandbox capacity within account quota", () => {
  const memoryGib: Record<string, number> = {
    lite: 0.25,
    basic: 1,
    "standard-1": 4,
    "standard-2": 6,
    "standard-3": 8,
    "standard-4": 12,
  };
  const reservedGib = (containers: { instance_type: string; max_instances: number }[]) =>
    containers.reduce(
      (total, entry) => total + memoryGib[entry.instance_type]! * entry.max_instances,
      0,
    );

  for (const [envName, envBlock] of Object.entries(config.env)) {
    const containers = envBlock.containers ?? [];
    expect(
      containers.map((entry) => entry.instance_type),
      envName,
    ).toEqual(["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"]);
    for (const entry of containers) {
      expect(entry.max_instances, `${envName} ${entry.instance_type}`).toBeGreaterThan(0);
    }
  }

  // A preview slot's fleet reserves well under production's — ten slots share
  // one account quota.
  expect(reservedGib(config.env.preview_6.containers ?? [])).toBeLessThan(100);
  expect(reservedGib(config.env.prd.containers ?? [])).toBeLessThan(300);
});
