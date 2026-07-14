import { beforeEach, describe, expect, it, vi } from "vitest";

interface DeploymentEnv {
  authBaseUrl: string;
  baseUrl: string;
  dopplerConfig: string;
  eventDocsBaseUrl: string;
  osWorkerName: string;
  projectHostnameBases: string[];
}

interface DeploymentContext {
  cf: (path: string, init?: RequestInit) => Promise<unknown>;
  env: DeploymentEnv;
  name: string;
  secrets: Record<string, string>;
}

interface DeployInput {
  afterDeploy?: (ctx: DeploymentContext) => Promise<void> | void;
  prepare?: (
    ctx: DeploymentContext,
    secretValues: Record<string, string>,
    credentials: Record<string, string>,
  ) => Promise<void> | void;
}

type SmokeResponse = (
  url: string,
  ok: (response: Response) => boolean | Promise<boolean>,
  label: string,
) => Promise<void>;

const mocks = vi.hoisted(() => ({
  assertDopplerSecretAbsent: vi.fn(),
  assertWorkerSecretAbsent: vi.fn(async () => {}),
  bakeStaticAuthJwks: vi.fn(async () => "baked-jwks"),
  createCliRun: vi.fn(),
  deployApp: vi.fn<(input: DeployInput) => Promise<void>>(),
  ensureContainerClasses: vi.fn(async () => {}),
  ensureR2Bucket: vi.fn(async () => {}),
  ensureWorkerEventsQueue: vi.fn(async () => {}),
  parseConfig: vi.fn(),
  run: vi.fn(),
  smokeResponse: vi.fn<SmokeResponse>(),
  writeWranglerConfig: vi.fn(),
}));

vi.mock("trpc-cli", () => ({
  createBuiltInPrompts: vi.fn(),
  createCli: vi.fn(() => ({ run: mocks.createCliRun })),
  isAgent: vi.fn(() => true),
  yamlTableConsoleLogger: {},
}));

vi.mock("../../../scripts/lib/bake-auth-jwks.ts", () => ({
  bakeStaticAuthJwks: mocks.bakeStaticAuthJwks,
}));
vi.mock("../../../scripts/lib/deploy-app.ts", () => ({ deployApp: mocks.deployApp }));
vi.mock("../../../scripts/lib/deploy-helpers.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../scripts/lib/deploy-helpers.ts")>()),
  assertDopplerSecretAbsent: mocks.assertDopplerSecretAbsent,
  assertWorkerSecretAbsent: mocks.assertWorkerSecretAbsent,
  run: mocks.run,
  smokeResponse: mocks.smokeResponse,
}));
vi.mock("../../../scripts/lib/do-reset.ts", () => ({
  ensureContainerClasses: mocks.ensureContainerClasses,
}));
vi.mock("../src/config.ts", () => ({ parseConfig: mocks.parseConfig }));
vi.mock("./event-queue-resources.ts", () => ({
  ensureWorkerEventsQueue: mocks.ensureWorkerEventsQueue,
}));
vi.mock("./ensure-resources.ts", () => ({ ensureR2Bucket: mocks.ensureR2Bucket }));
vi.mock("./generate-wrangler-config.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./generate-wrangler-config.ts")>()),
  writeWranglerConfig: mocks.writeWranglerConfig,
}));

import deploy from "./deploy.ts";

const secretName = "APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN";
const workerName = "os-preview-4";
const env = {
  authBaseUrl: "https://auth.preview.example.test",
  baseUrl: "https://os.preview.example.test",
  dopplerConfig: "preview_4",
  eventDocsBaseUrl: "https://events.preview.example.test",
  osWorkerName: workerName,
  projectHostnameBases: ["iterate-preview-4.test"],
} satisfies DeploymentEnv;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.deployApp.mockResolvedValue(undefined);
  mocks.assertWorkerSecretAbsent.mockResolvedValue(undefined);
  mocks.bakeStaticAuthJwks.mockResolvedValue("baked-jwks");
  mocks.ensureContainerClasses.mockResolvedValue(undefined);
  mocks.ensureR2Bucket.mockResolvedValue(undefined);
  mocks.ensureWorkerEventsQueue.mockResolvedValue(undefined);
});

async function getDeployInput() {
  await deploy({ env: "preview_4" });
  const input = mocks.deployApp.mock.calls[0]?.[0];
  if (!input) throw new Error("deploy did not invoke deployApp");
  return input;
}

function deploymentContext(secrets: Record<string, string> = {}): DeploymentContext {
  return {
    cf: vi.fn(async () => []),
    env,
    name: "preview_4",
    secrets,
  };
}

function queueAuthRpc404(body: unknown) {
  mocks.smokeResponse.mockImplementationOnce(async (_url, ok, label) => {
    const response = Response.json(body, { status: 404 });
    if (!(await ok(response))) throw new Error(`Smoke failed: ${label}`);
  });
}

describe("forbidden auth service-token invariants", () => {
  it("asserts Doppler and Worker absence before any deployment preparation", async () => {
    const input = await getDeployInput();
    const context = deploymentContext();

    await input.prepare?.(context, {}, {});

    expect(mocks.assertDopplerSecretAbsent).toHaveBeenCalledWith({
      project: "os",
      config: "preview_4",
      secretName,
      secrets: context.secrets,
    });
    expect(mocks.assertWorkerSecretAbsent).toHaveBeenCalledWith({
      cf: context.cf,
      workerName,
      secretName,
    });
    expect(mocks.assertWorkerSecretAbsent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.bakeStaticAuthJwks.mock.invocationCallOrder[0] as number,
    );
  });

  it("stops before Cloudflare or build preparation when Doppler contains the secret", async () => {
    mocks.assertDopplerSecretAbsent.mockImplementationOnce(() => {
      throw new Error("forbidden Doppler secret");
    });
    const input = await getDeployInput();

    await expect(
      input.prepare?.(deploymentContext({ [secretName]: "redacted" }), {}, {}),
    ).rejects.toThrow("forbidden Doppler secret");

    expect(mocks.assertWorkerSecretAbsent).not.toHaveBeenCalled();
    expect(mocks.bakeStaticAuthJwks).not.toHaveBeenCalled();
  });

  it("stops before build preparation when the live Worker contains the secret", async () => {
    mocks.assertWorkerSecretAbsent.mockRejectedValueOnce(new Error("forbidden Worker secret"));
    const input = await getDeployInput();

    await expect(input.prepare?.(deploymentContext(), {}, {})).rejects.toThrow(
      "forbidden Worker secret",
    );

    expect(mocks.bakeStaticAuthJwks).not.toHaveBeenCalled();
  });
});

describe("auth Workers RPC deployment proof", () => {
  it("accepts only the exact OS project-miss response", async () => {
    queueAuthRpc404({ error: "not found" });
    const input = await getDeployInput();

    await expect(input.afterDeploy?.(deploymentContext())).resolves.toBeUndefined();

    expect(mocks.smokeResponse).toHaveBeenCalledOnce();
  });

  it("rejects an unrelated 404 body", async () => {
    queueAuthRpc404({ error: "route not found" });
    const input = await getDeployInput();

    await expect(input.afterDeploy?.(deploymentContext())).rejects.toThrow(
      "Smoke failed: auth Workers RPC",
    );
  });
});
