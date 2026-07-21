import { expect, it } from "vitest";
import { CloudflareApiError } from "../../../scripts/lib/env-context.ts";
import { ensureInboundEmailRouting } from "./email-routing-resources.ts";

it("enables routing but explicitly defers a catch-all for a worker that is not deployed yet", async () => {
  const calls: string[] = [];
  const ctx = emailRoutingContext(calls, {
    routingEnabled: false,
    workerExists: false,
    zoneExists: true,
  });

  await expect(
    ensureInboundEmailRouting(ctx, {
      projectHostnameBases: ["iterate-preview-10.app", "iterate-preview-10.com"],
      workerName: "os-preview-10",
      workerRequirement: "allow-missing-before-first-deploy",
    }),
  ).resolves.toBe("deferred-until-worker-deploy");

  expect(calls).toEqual([
    "GET /zones?account.id=account-1&per_page=500",
    "GET /zones/zone-10/email/routing",
    "POST /zones/zone-10/email/routing/enable",
    "GET /workers/scripts/os-preview-10/settings",
  ]);
});

it("installs the catch-all when the worker exists", async () => {
  const calls: string[] = [];
  const ctx = emailRoutingContext(calls, {
    routingEnabled: true,
    workerExists: true,
    zoneExists: true,
  });

  await expect(
    ensureInboundEmailRouting(ctx, {
      projectHostnameBases: ["iterate-preview-10.app"],
      workerName: "os-preview-10",
      workerRequirement: "require-deployed-worker",
    }),
  ).resolves.toBe("configured");

  expect(calls).toEqual([
    "GET /zones?account.id=account-1&per_page=500",
    "GET /zones/zone-10/email/routing",
    "GET /workers/scripts/os-preview-10/settings",
    "PUT /zones/zone-10/email/routing/rules/catch_all",
  ]);
});

it("fails a post-deploy reconciliation when the worker is still missing", async () => {
  const calls: string[] = [];
  const ctx = emailRoutingContext(calls, {
    routingEnabled: true,
    workerExists: false,
    zoneExists: true,
  });

  await expect(
    ensureInboundEmailRouting(ctx, {
      projectHostnameBases: ["iterate-preview-10.app"],
      workerName: "os-preview-10",
      workerRequirement: "require-deployed-worker",
    }),
  ).rejects.toThrow("requires deployed worker os-preview-10");
});

it("defers a missing zone during create-only setup but rejects it after deployment", async () => {
  const setupCalls: string[] = [];
  const setupContext = emailRoutingContext(setupCalls, {
    routingEnabled: false,
    workerExists: false,
    zoneExists: false,
  });

  await expect(
    ensureInboundEmailRouting(setupContext, {
      projectHostnameBases: ["iterate-preview-10.app"],
      workerName: "os-preview-10",
      workerRequirement: "allow-missing-before-first-deploy",
    }),
  ).resolves.toBe("deferred-until-zone");
  expect(setupCalls).toEqual(["GET /zones?account.id=account-1&per_page=500"]);

  const deployCalls: string[] = [];
  const deployContext = emailRoutingContext(deployCalls, {
    routingEnabled: false,
    workerExists: true,
    zoneExists: false,
  });
  await expect(
    ensureInboundEmailRouting(deployContext, {
      projectHostnameBases: ["iterate-preview-10.app"],
      workerName: "os-preview-10",
      workerRequirement: "require-deployed-worker",
    }),
  ).rejects.toThrow("no zone named iterate-preview-10.app");
});

function emailRoutingContext(
  calls: string[],
  options: { routingEnabled: boolean; workerExists: boolean; zoneExists: boolean },
) {
  return {
    name: "preview_10",
    env: { cloudflareAccountId: "account-1", dopplerConfig: "preview_10" },
    secrets: {},
    cf: async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push(`${init?.method || "GET"} ${path}`);
      if (path === "/workers/scripts/os-preview-10/settings") {
        if (!options.workerExists) {
          throw new CloudflareApiError("GET", path, 404, [{ code: 10090 }]);
        }
        return {} as T;
      }
      throw new Error(`unexpected account call ${init?.method || "GET"} ${path}`);
    },
    cfV4: async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push(`${init?.method || "GET"} ${path}`);
      if (path === "/zones?account.id=account-1&per_page=500") {
        return (options.zoneExists ? [{ id: "zone-10", name: "iterate-preview-10.app" }] : []) as T;
      }
      if (path === "/zones/zone-10/email/routing") {
        return { enabled: options.routingEnabled } as T;
      }
      if (path === "/zones/zone-10/email/routing/enable" && init?.method === "POST") {
        return {} as T;
      }
      if (path === "/zones/zone-10/email/routing/rules/catch_all" && init?.method === "PUT") {
        return {} as T;
      }
      throw new Error(`unexpected v4 call ${init?.method || "GET"} ${path}`);
    },
  };
}
