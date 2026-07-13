import { beforeEach, describe, expect, it, vi } from "vitest";

type CloudflareApi = (path: string, init?: RequestInit) => Promise<unknown>;

interface RetirementEnv {
  baseUrl: string;
  dopplerConfig: string;
  eventDocsBaseUrl: string;
  osWorkerName: string;
  projectHostnameBases: string[];
}

interface RetirementContext {
  cf: CloudflareApi;
  env: RetirementEnv;
}

interface DeployInput {
  afterDeploy?: (ctx: RetirementContext) => Promise<void> | void;
}

type SmokeResponse = (
  url: string,
  ok: (response: Response) => boolean | Promise<boolean>,
  label: string,
) => Promise<void>;

const mocks = vi.hoisted(() => ({
  createCliRun: vi.fn(),
  deleteDopplerSecretIfPresent:
    vi.fn<(input: { config: string; project: string; secretName: string }) => boolean>(),
  deployApp: vi.fn<(input: DeployInput) => Promise<void>>(),
  smoke: vi.fn<(url: string, ok: (status: number) => boolean, label: string) => Promise<void>>(),
  smokeResponse: vi.fn<SmokeResponse>(),
}));

vi.mock("trpc-cli", () => ({
  createBuiltInPrompts: vi.fn(),
  createCli: vi.fn(() => ({ run: mocks.createCliRun })),
  isAgent: vi.fn(() => true),
  yamlTableConsoleLogger: {},
}));

vi.mock("../../../scripts/lib/deploy-app.ts", () => ({ deployApp: mocks.deployApp }));

vi.mock("../../../scripts/lib/deploy-helpers.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../scripts/lib/deploy-helpers.ts")>()),
  deleteDopplerSecretIfPresent: mocks.deleteDopplerSecretIfPresent,
  smoke: mocks.smoke,
  smokeResponse: mocks.smokeResponse,
}));

import deploy from "./deploy.ts";

const secretName = "APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN";
const workerName = "os-preview-4";
const workerSecretsPath = `/workers/scripts/${workerName}/secrets`;
const workerSecretDeletePath = `${workerSecretsPath}/${secretName}?url_encoded=true`;
const workerSecretBinding = { name: secretName, type: "secret_text" };
const env = {
  baseUrl: "https://os.preview.example.test",
  dopplerConfig: "preview_4",
  eventDocsBaseUrl: "https://events.preview.example.test",
  osWorkerName: workerName,
  projectHostnameBases: ["iterate-preview-4.test"],
} satisfies RetirementEnv;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.deployApp.mockResolvedValue(undefined);
  mocks.smoke.mockResolvedValue(undefined);
  mocks.deleteDopplerSecretIfPresent.mockReturnValue(true);
});

async function getAfterDeploy() {
  await deploy({ env: "preview_4" });
  const afterDeploy = mocks.deployApp.mock.calls[0]?.[0].afterDeploy;
  if (!afterDeploy) throw new Error("deploy did not register an afterDeploy hook");
  return afterDeploy;
}

function queueAuthRpc404(body: unknown) {
  mocks.smokeResponse.mockImplementationOnce(async (_url, ok, label) => {
    const response = Response.json(body, { status: 404 });
    if (!(await ok(response))) throw new Error(`Smoke failed: ${label}`);
  });
}

function contextWith(cf: CloudflareApi): RetirementContext {
  return { cf, env };
}

function workerSecretRevocationSucceeds() {
  let listCount = 0;
  return vi.fn(async (path: string, init?: RequestInit) => {
    if (path === workerSecretsPath && !init) {
      listCount += 1;
      return listCount === 1 ? [workerSecretBinding] : [];
    }
    if (path === workerSecretDeletePath && init?.method === "DELETE") return undefined;
    throw new Error(`unexpected Cloudflare request: ${init?.method ?? "GET"} ${path}`);
  });
}

describe("retired auth service-token orchestration", () => {
  it("prevents every deletion when the initial auth RPC smoke gets a wrong-body 404", async () => {
    queueAuthRpc404({ error: "route not found" });
    const cf = vi.fn(async () => []);
    const afterDeploy = await getAfterDeploy();

    await expect(afterDeploy(contextWith(cf))).rejects.toThrow("Smoke failed: auth Workers RPC");

    expect(cf).not.toHaveBeenCalled();
    expect(mocks.deleteDopplerSecretIfPresent).not.toHaveBeenCalled();
  });

  it.for([
    {
      cf: () =>
        vi.fn(async (path: string, init?: RequestInit) => {
          if (path === workerSecretsPath && !init) return [workerSecretBinding];
          if (path === workerSecretDeletePath && init?.method === "DELETE") {
            throw new Error("Cloudflare rejected the Worker-secret deletion");
          }
          throw new Error(`unexpected Cloudflare request: ${init?.method ?? "GET"} ${path}`);
        }),
      failure: "Cloudflare rejected the Worker-secret deletion",
      name: "Worker-secret deletion",
    },
    {
      cf: () =>
        vi.fn(async (path: string, init?: RequestInit) => {
          if (path === workerSecretsPath && !init) return [workerSecretBinding];
          if (path === workerSecretDeletePath && init?.method === "DELETE") return undefined;
          throw new Error(`unexpected Cloudflare request: ${init?.method ?? "GET"} ${path}`);
        }),
      failure: "Cloudflare reported success but retired Worker secret remains",
      name: "Worker-secret verification",
    },
  ])("preserves the Doppler secret after $name failure", async ({ cf: makeCf, failure }) => {
    queueAuthRpc404({ error: "not found" });
    const cf = makeCf();
    const afterDeploy = await getAfterDeploy();

    await expect(afterDeploy(contextWith(cf))).rejects.toThrow(failure);

    expect(mocks.smoke).not.toHaveBeenCalled();
    expect(mocks.deleteDopplerSecretIfPresent).not.toHaveBeenCalled();
  });

  it("preserves the Doppler secret when post-revocation app verification fails", async () => {
    queueAuthRpc404({ error: "not found" });
    mocks.smoke.mockRejectedValueOnce(new Error("post-revocation dashboard smoke failed"));
    const cf = workerSecretRevocationSucceeds();
    const afterDeploy = await getAfterDeploy();

    await expect(afterDeploy(contextWith(cf))).rejects.toThrow(
      "post-revocation dashboard smoke failed",
    );

    expect(cf).toHaveBeenCalledTimes(3);
    expect(mocks.smokeResponse).toHaveBeenCalledOnce();
    expect(mocks.deleteDopplerSecretIfPresent).not.toHaveBeenCalled();
  });

  it("preserves the Doppler secret when the post-revocation auth RPC smoke fails", async () => {
    queueAuthRpc404({ error: "not found" });
    queueAuthRpc404({ error: "route not found" });
    const cf = workerSecretRevocationSucceeds();
    const afterDeploy = await getAfterDeploy();

    await expect(afterDeploy(contextWith(cf))).rejects.toThrow(
      "Smoke failed: auth Workers RPC after secret revocation",
    );

    expect(cf).toHaveBeenCalledTimes(3);
    expect(mocks.smoke).toHaveBeenCalledTimes(3);
    expect(mocks.smokeResponse).toHaveBeenCalledTimes(2);
    expect(mocks.deleteDopplerSecretIfPresent).not.toHaveBeenCalled();
  });

  it("deletes the Doppler source only after all revocation probes pass", async () => {
    queueAuthRpc404({ error: "not found" });
    queueAuthRpc404({ error: "not found" });
    const cf = workerSecretRevocationSucceeds();
    const afterDeploy = await getAfterDeploy();

    await expect(afterDeploy(contextWith(cf))).resolves.toBeUndefined();

    expect(cf.mock.calls).toEqual([
      [workerSecretsPath],
      [workerSecretDeletePath, { method: "DELETE" }],
      [workerSecretsPath],
    ]);
    expect(mocks.smoke).toHaveBeenCalledTimes(3);
    expect(mocks.smokeResponse).toHaveBeenCalledTimes(2);
    expect(mocks.deleteDopplerSecretIfPresent).toHaveBeenCalledWith({
      config: "preview_4",
      project: "os",
      secretName,
    });
  });
});
