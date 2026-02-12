import { beforeEach, describe, expect, it, vi } from "vitest";

const flyProviderState = vi.hoisted(() => {
  return {
    constructorArgs: [] as Array<Record<string, string | undefined>>,
    createCalls: [] as Array<Record<string, unknown>>,
  };
});

vi.mock("./fly/provider.ts", () => {
  class FlyProviderMock {
    public readonly defaultSnapshotId = "default-fly-snapshot";

    public constructor(rawEnv: Record<string, string | undefined>) {
      flyProviderState.constructorArgs.push(rawEnv);
    }

    public getWithMachineId(args: { providerId: string; machineId?: string }) {
      return {
        providerId: args.providerId,
        machineId: args.machineId ?? "known-machine",
        type: "fly" as const,
        getBaseUrl: async ({ port }: { port: number }) => `https://fly.example:${port}`,
        getFetcher: async () => async () => new Response("{}"),
        start: async () => {},
        stop: async () => {},
        restart: async () => {},
        delete: async () => {},
        exec: async () => "",
        getState: async () => ({ state: "running" }),
      };
    }

    public async create(config: Record<string, unknown>) {
      flyProviderState.createCalls.push(config);
      return {
        providerId: "fly-provider-id",
        machineId: "fly-machine-id",
        type: "fly" as const,
        getBaseUrl: async ({ port }: { port: number }) => `https://fly.example:${port}`,
        getFetcher: async () => async () => new Response("{}"),
        start: async () => {},
        stop: async () => {},
        restart: async () => {},
        delete: async () => {},
        exec: async () => "",
        getState: async () => ({ state: "running" }),
      };
    }
  }

  return { FlyProvider: FlyProviderMock };
});

const { createMachineStub } = await import("./machine-stub.ts");

describe("createMachineStub fly metadata round-trip", () => {
  beforeEach(() => {
    flyProviderState.constructorArgs.length = 0;
    flyProviderState.createCalls.length = 0;
  });

  it("persists flyMachineCpus in create metadata and provider env override", async () => {
    const stub = await createMachineStub({
      type: "fly",
      externalId: "provider-ext-id",
      env: { FLY_API_TOKEN: "token", FLY_DEFAULT_IMAGE: "img", SANDBOX_NAME_PREFIX: "dev" },
      metadata: {
        snapshotName: "fly-snap-v1",
        flyMachineCpus: 8,
      },
    });

    const result = await stub.create({
      machineId: "machine-id-1",
      externalId: "provider-ext-id",
      name: "sandbox-name",
      envVars: { FOO: "bar" },
    });

    expect(flyProviderState.constructorArgs[0]?.FLY_DEFAULT_CPUS).toBe("8");
    expect(result.metadata).toMatchObject({
      snapshotName: "fly-snap-v1",
      flyMachineCpus: 8,
      fly: { machineId: "fly-machine-id" },
    });
    expect(flyProviderState.createCalls[0]).toMatchObject({
      providerSnapshotId: "fly-snap-v1",
    });
  });
});
