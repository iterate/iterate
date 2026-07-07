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
