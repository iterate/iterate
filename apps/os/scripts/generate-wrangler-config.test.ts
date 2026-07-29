import { expect, it } from "vitest";

import { envs } from "../../../envs.ts";
import {
  config,
  localDevAuthJwks,
  localAuthServiceBinding,
  OPTIONAL_SECRETS,
  REQUIRED_SECRETS,
  envShapedVars,
  typecheckerConfig,
  workerBundlerConfig,
} from "./generate-wrangler-config.ts";

it("does not emit the local forge JWKS into deployed builds", () => {
  const forgePrivateJwk = JSON.stringify({
    kty: "EC",
    kid: "test-forge",
    crv: "P-256",
    alg: "ES256",
    x: "public-x",
    y: "public-y",
    d: "private-key",
  });

  expect(localDevAuthJwks({ forgePrivateJwk, deployedEnv: "prd" })).toBeUndefined();
  expect(localDevAuthJwks({ forgePrivateJwk, deployedEnv: undefined })).toBe(
    JSON.stringify({
      keys: [
        { kty: "EC", kid: "test-forge", crv: "P-256", alg: "ES256", x: "public-x", y: "public-y" },
      ],
    }),
  );
});

it.each([
  "APP_CONFIG_LOGS",
  "APP_CONFIG_GEMINI_API_KEY",
  "APP_CONFIG_SLACK_BOT_TOKEN",
  "APP_CONFIG_X_AI_API_KEY",
])("does not ship the retired %s override", (name) => {
  expect(OPTIONAL_SECRETS).not.toContain(name);
  expect(REQUIRED_SECRETS).not.toContain(name);
});

// Wrangler tags every `--env` deploy with `cf:service=<top-level name>` and
// `cf:environment=<env>`. The top-level names below are therefore the fleet's
// observability service identities, not just local dev worker names — an
// env-flavored name here ("os-dev") mis-buckets every deployed environment
// under a fake "dev" service (observed live on os-prd-builder, 2026-07-04).
it("names the top-level configs by service so cf:service script tags stay env-less", () => {
  expect(config.name).toBe("os");
  expect(typecheckerConfig.name).toBe("os-typechecker");
  expect(workerBundlerConfig.name).toBe("os-worker-bundler");
});

it("gives every deployed env its own worker name derived from the service name", () => {
  for (const [envName, envBlock] of Object.entries(config.env)) {
    expect(envBlock.name, envName).toMatch(/^os-/);
    expect(envBlock.name, envName).not.toBe(config.name);
  }
});

it("binds the os worker to its own env's typechecker sidecar", () => {
  for (const [envName, envBlock] of Object.entries(config.env)) {
    const typechecker = envBlock.services.find((service) => service.binding === "TYPECHECKER");
    expect(typechecker?.service, envName).toBe(`${envBlock.name}-typechecker`);
    const sidecarNames = Object.values(typecheckerConfig.env).map((sidecar) => sidecar.name);
    expect(sidecarNames, envName).toContain(typechecker?.service);
  }
});

it("binds the os worker to its own env's worker-bundler sidecar", () => {
  for (const [envName, envBlock] of Object.entries(config.env)) {
    const bundler = envBlock.services.find((service) => service.binding === "WORKER_BUNDLER");
    expect(bundler?.service, envName).toBe(`${envBlock.name}-worker-bundler`);
    const sidecarNames = Object.values(workerBundlerConfig.env).map((sidecar) => sidecar.name);
    expect(sidecarNames, envName).toContain(bundler?.service);
  }
});

it("binds every deployed OS worker to the matching auth worker's default entrypoint", () => {
  for (const [envName, envBlock] of Object.entries(config.env)) {
    const auth = envBlock.services.find((service) => service.binding === "AUTH");
    expect(auth, envName).toEqual({
      binding: "AUTH",
      service: envs[envName as keyof typeof envs].authWorkerName,
    });
  }
});

it("binds local OS to the selected auth worker's default entrypoint", () => {
  const selected = localAuthServiceBinding({
    issuer: process.env.APP_CONFIG_ITERATE_AUTH__ISSUER,
    allowProductionRemote: process.env.ALLOW_REMOTE_PRODUCTION_AUTH_RPC === "1",
  });
  const auth = config.services.find((service) => service.binding === "AUTH");

  expect(auth).toEqual({
    binding: "AUTH",
    service: selected.authWorkerName,
    ...(selected.authRemote ? { remote: true } : {}),
  });
});

it("selects the matching remote auth worker for local dev and the local worker for dev-all", () => {
  expect(localAuthServiceBinding({ issuer: undefined, allowProductionRemote: false })).toEqual({
    authWorkerName: "auth-dev-global",
    authRemote: true,
  });
  expect(
    localAuthServiceBinding({
      issuer: "https://auth.iterate-preview-3.com/api/auth",
      allowProductionRemote: false,
    }),
  ).toEqual({
    authWorkerName: "auth-preview-3",
    authRemote: true,
  });
  expect(
    localAuthServiceBinding({
      issuer: "http://localhost:50123/api/auth",
      allowProductionRemote: false,
    }),
  ).toEqual({
    authWorkerName: "auth",
    authRemote: false,
  });
  expect(() =>
    localAuthServiceBinding({
      issuer: "https://unknown-auth.example/api/auth",
      allowProductionRemote: false,
    }),
  ).toThrow(/does not match a known auth environment/);
  expect(() =>
    localAuthServiceBinding({
      issuer: "https://auth.iterate.com/api/auth",
      allowProductionRemote: false,
    }),
  ).toThrow(/requires ALLOW_REMOTE_PRODUCTION_AUTH_RPC=1/);
  expect(
    localAuthServiceBinding({
      issuer: "https://auth.iterate.com/api/auth",
      allowProductionRemote: true,
    }),
  ).toEqual({ authWorkerName: "auth-prd", authRemote: true });
});

it("never ships the old shared auth service token to OS", () => {
  expect(OPTIONAL_SECRETS).not.toContain("APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN");
  expect(config.secrets.required).not.toContain("APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN");
});

it("requires the first-party PostHog project token in every deployed environment", () => {
  expect(REQUIRED_SECRETS).toContain("APP_CONFIG_POSTHOG");
  expect(OPTIONAL_SECRETS).not.toContain("APP_CONFIG_POSTHOG");
});

it("requires the Cloudflare API token and marks only deployed environments", () => {
  expect(REQUIRED_SECRETS).toContain("APP_CONFIG_CLOUDFLARE__API_TOKEN");
  expect(OPTIONAL_SECRETS).not.toContain("APP_CONFIG_CLOUDFLARE__API_TOKEN");
  expect(config.vars).not.toHaveProperty("DEPLOYMENT_ENV");
  for (const [envName, envBlock] of Object.entries(config.env)) {
    expect(envBlock.vars).toMatchObject({ DEPLOYMENT_ENV: envName });
  }
});

it("emits the AI response-cache key for every deployment while keeping production disabled", () => {
  expect(envShapedVars(envs.prd)).toMatchObject({
    APP_CONFIG_CLOUDFLARE_AI_GATEWAY__RESPONSE_CACHE_TTL_SECONDS: "",
  });
  expect(envShapedVars(envs.preview_6)).toMatchObject({
    APP_CONFIG_CLOUDFLARE_AI_GATEWAY__RESPONSE_CACHE_TTL_SECONDS: String(7 * 24 * 60 * 60),
  });
});

it("exposes the selected environment name to browser-facing config", () => {
  expect(config.vars.APP_CONFIG_ENVIRONMENT_NAME).toBe(process.env.DOPPLER_CONFIG?.trim() || "dev");
  expect(envShapedVars(envs.prd).APP_CONFIG_ENVIRONMENT_NAME).toBe("prd");
  expect(envShapedVars(envs.preview_6).APP_CONFIG_ENVIRONMENT_NAME).toBe("preview_6");
});

it("does not retain a reconciled Durable Object tombstone", () => {
  expect(config.exports).not.toHaveProperty("CloudflareSandboxDurableObject");
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

it("routes the owned iterate.com apex and single-label apps to the production os worker", () => {
  const productionRoutes = config.env.prd.routes ?? [];
  expect(productionRoutes).toContainEqual({
    pattern: "iterate.com/*",
    zone_name: "iterate.com",
  });
  expect(productionRoutes).toContainEqual({
    pattern: "*.iterate.com/*",
    zone_name: "iterate.com",
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
