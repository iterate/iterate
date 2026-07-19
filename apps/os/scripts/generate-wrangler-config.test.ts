import { expect, it } from "vitest";

import { envs } from "../../../envs.ts";
import { workerEventsQueueName } from "../src/queue-names.ts";
import {
  OS_CONTAINER_CLASS_NAMES,
  workerBuilderWorkerName,
  WORKER_BUILD_COORDINATOR_CLASS_NAME,
  WORKER_BUILDER_CONTAINER_CLASS_NAME,
} from "./container-class-names.ts";
import {
  builderConfig,
  config,
  localDevAuthJwks,
  localAuthServiceBinding,
  OPTIONAL_SECRETS,
  REQUIRED_SECRETS,
  envShapedVars,
  typecheckerConfig,
} from "./generate-wrangler-config.ts";
import { sandboxContainerDeploymentId, workerBuildDeploymentId } from "./deployment-revisions.ts";

it("does not emit the local forge JWKS into deployed builds", () => {
  const forgePrivateJwk = JSON.stringify({
    kty: "OKP",
    kid: "test-forge",
    crv: "Ed25519",
    x: "public-key",
    d: "private-key",
  });

  expect(localDevAuthJwks({ forgePrivateJwk, deployedEnv: "prd" })).toBeUndefined();
  expect(localDevAuthJwks({ forgePrivateJwk, deployedEnv: undefined })).toBe(
    JSON.stringify({
      keys: [{ kty: "OKP", kid: "test-forge", crv: "Ed25519", x: "public-key" }],
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
  expect(builderConfig.name).toBe("os-builder");
  expect(typecheckerConfig.name).toBe("os-typechecker");
});

it("gives deployed workers content-addressed identities while local dev stays unversioned", () => {
  const workerBuildRevision = workerBuildDeploymentId();
  const sandboxContainerRevision = sandboxContainerDeploymentId();
  expect(workerBuildRevision).toMatch(/^worker-builder-[a-f0-9]{32}$/);
  expect(sandboxContainerRevision).toMatch(/^sandbox-containers-[a-f0-9]{32}$/);
  expect(config.vars.WORKER_BUILD_DEPLOYMENT_ID).toBe("unversioned");
  expect(config.vars.SANDBOX_CONTAINER_DEPLOYMENT_ID).toBe("unversioned");
  expect(builderConfig.vars.WORKER_BUILD_DEPLOYMENT_ID).toBe("unversioned");

  for (const envName of Object.keys(config.env) as Array<keyof typeof config.env>) {
    expect(config.env[envName].vars.WORKER_BUILD_DEPLOYMENT_ID, String(envName)).toBe(
      builderConfig.env[envName].vars.WORKER_BUILD_DEPLOYMENT_ID,
    );
    expect(config.env[envName].vars.WORKER_BUILD_DEPLOYMENT_ID, String(envName)).toBe(
      workerBuildRevision,
    );
    expect(config.env[envName].vars.SANDBOX_CONTAINER_DEPLOYMENT_ID, String(envName)).toBe(
      sandboxContainerRevision,
    );
  }
});

it("gives every deployed env its own worker name derived from the service name", () => {
  for (const [envName, envBlock] of Object.entries(config.env)) {
    expect(envBlock.name, envName).toMatch(/^os-/);
    expect(envBlock.name, envName).not.toBe(config.name);
  }
});

it("bounds event-queue control-plane work without serializing project tests", () => {
  for (const [envName, envBlock] of Object.entries(config.env)) {
    const consumer = envBlock.queues.consumers.find(
      (candidate) => candidate.queue === workerEventsQueueName(envBlock.name),
    );
    expect(consumer, envName).toMatchObject({
      max_batch_size: 10,
      max_batch_timeout: 5,
      max_concurrency: 4,
    });
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

it("binds the builder namespace externally without reviving its old service API", () => {
  const builderSidecarNames = Object.values(builderConfig.env).map((sidecar) => sidecar.name);
  for (const [envName, envBlock] of Object.entries(config.env)) {
    // The retired esbuild-wasm BUILDER service API stays gone. Its route-less
    // script name now hosts the technology-neutral coordinator and backend.
    expect(
      envBlock.services.find((service) => service.binding === "BUILDER"),
      envName,
    ).toBeUndefined();
    const builderWorkerName = workerBuilderWorkerName(envBlock.name);
    expect(
      envBlock.durable_objects.bindings.find((binding) => binding.name === "WORKER_BUILDER"),
      envName,
    ).toEqual({
      name: "WORKER_BUILDER",
      class_name: WORKER_BUILD_COORDINATOR_CLASS_NAME,
      script_name: builderWorkerName,
    });
    expect(builderSidecarNames, envName).toContain(builderWorkerName);
  }
  expect(
    config.durable_objects.bindings,
    "local dev uses WORKER_BUILD_DEV_ENDPOINT",
  ).not.toContainEqual(expect.objectContaining({ name: "WORKER_BUILDER" }));
});

it("hosts the worker-builder pool only on its dedicated sidecar", async () => {
  // The pool addresses exactly WORKER_BUILDER_POOL_SIZE member names, so the
  // container app's max_instances must match — smaller would deny placements
  // for members that exist, larger would reserve quota nothing can use.
  const { WORKER_BUILDER_POOL_SIZE } = await import("../src/domains/workers/builder-pool.ts");
  for (const [envName, osEnvBlock] of Object.entries(config.env)) {
    expect(
      (osEnvBlock.containers ?? []).find(
        (entry) => entry.class_name === WORKER_BUILDER_CONTAINER_CLASS_NAME,
      ),
      envName,
    ).toBeUndefined();

    const builderEnvBlock = builderConfig.env[envName as keyof typeof builderConfig.env];
    expect(builderEnvBlock.name, envName).toBe(workerBuilderWorkerName(osEnvBlock.name));
    expect(builderEnvBlock.containers, envName).toHaveLength(1);
    expect(builderEnvBlock.containers[0], envName).toMatchObject({
      class_name: WORKER_BUILDER_CONTAINER_CLASS_NAME,
      max_instances: WORKER_BUILDER_POOL_SIZE,
      instance_type: "standard-4",
    });
    expect(builderEnvBlock.durable_objects.bindings, envName).toEqual([
      {
        name: "WORKER_BUILDER_SANDBOX",
        class_name: WORKER_BUILDER_CONTAINER_CLASS_NAME,
      },
    ]);
    expect(builderEnvBlock.containers[0]?.rollout_step_percentage, envName).toBe(
      envName.startsWith("preview_") ? 100 : undefined,
    );
  }
  expect(builderConfig.exports).toEqual({
    [WORKER_BUILD_COORDINATOR_CLASS_NAME]: { type: "durable-object", storage: "sqlite" },
    [WORKER_BUILDER_CONTAINER_CLASS_NAME]: { type: "durable-object", storage: "sqlite" },
  });
});

it("declares exactly the container classes preserved by erase-data", () => {
  for (const [envName, envBlock] of Object.entries(config.env)) {
    expect((envBlock.containers ?? []).map((entry) => entry.class_name).sort(), envName).toEqual(
      [...OS_CONTAINER_CLASS_NAMES].sort(),
    );
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

it("emits the AI response-cache key for every deployment while keeping production disabled", () => {
  expect(envShapedVars(envs.prd)).toMatchObject({
    APP_CONFIG_CLOUDFLARE_AI_GATEWAY__RESPONSE_CACHE_TTL_SECONDS: "",
  });
  expect(envShapedVars(envs.preview_6)).toMatchObject({
    APP_CONFIG_CLOUDFLARE_AI_GATEWAY__RESPONSE_CACHE_TTL_SECONDS: String(7 * 24 * 60 * 60),
  });
});

it("does not retain a reconciled Durable Object tombstone", () => {
  expect(config.exports).not.toHaveProperty("CloudflareSandboxDurableObject");
});

it("retires the short-lived main-worker builder namespace", () => {
  expect(config.exports).toHaveProperty(WORKER_BUILDER_CONTAINER_CLASS_NAME, {
    type: "durable-object",
    state: "deleted",
  });
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
      expect(entry.rollout_step_percentage, `${envName} ${entry.instance_type}`).toBe(
        envName.startsWith("preview_") ? 100 : undefined,
      );
    }
  }

  const previewSlotGib = reservedGib([
    ...(config.env.preview_6.containers ?? []),
    ...builderConfig.env.preview_6.containers,
  ]);
  const productionGib = reservedGib([
    ...(config.env.prd.containers ?? []),
    ...builderConfig.env.prd.containers,
  ]);

  expect(previewSlotGib).toBe(115);
  expect(productionGib).toBe(306.5);
  // The preview account's live concurrent-memory quota is 6 TiB. Fifteen
  // simultaneously eligible slots reserve only 1.725 TiB, leaving the test's
  // required PR-churn scenario comfortably below the placement boundary.
  expect(previewSlotGib * 15).toBeLessThan(6 * 1024);
});
