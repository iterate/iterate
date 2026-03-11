import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseProjectIngressHostname,
  isProjectIngressHostname,
} from "@iterate-com/shared/project-ingress";

vi.mock("@iterate-com/sandbox/providers/machine-stub", () => ({
  createMachineStub: vi.fn(),
}));

vi.mock("../db/client.ts", () => ({
  getDb: vi.fn(),
}));

vi.mock("../tag-logger.ts", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    set: vi.fn(),
  },
}));

type MockDb = {
  select: ReturnType<typeof vi.fn>;
  query: {
    machine: {
      findFirst: ReturnType<typeof vi.fn>;
    };
  };
};

function createResponse(status = 200): Response {
  return new Response("ok", { status });
}

function createProjectIngressDb(params: {
  maxProjectQueriesBeforeFailure?: number;
  machineState?: "active" | "detached" | "starting";
}) {
  let projectQueryCount = 0;
  let machineQueryCount = 0;

  const db: MockDb = {
    select: vi.fn(() => {
      const chain = {
        from: vi.fn(() => chain),
        innerJoin: vi.fn(() => chain),
        leftJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(async () => {
          projectQueryCount += 1;
          if (
            params.maxProjectQueriesBeforeFailure !== undefined &&
            projectQueryCount > params.maxProjectQueriesBeforeFailure
          ) {
            throw new Error("remaining connection slots are reserved for superuser connections");
          }

          if (params.machineState === "starting") {
            return [
              {
                machine: {
                  id: "mach_123",
                  state: "starting",
                  externalId: "ext_123",
                  type: "docker",
                  metadata: {},
                },
                defaultPort: 3000,
                membershipId: "mem_123",
              },
            ];
          }

          return [
            {
              projectId: "proj_123",
              defaultPort: 3000,
              membershipId: "mem_123",
            },
          ];
        }),
      };

      return chain;
    }),
    query: {
      machine: {
        findFirst: vi.fn(async () => {
          machineQueryCount += 1;
          return {
            id: "mach_123",
            projectId: "proj_123",
            state: params.machineState ?? "active",
            externalId: "ext_123",
            type: "docker",
            metadata: {},
          };
        }),
      },
    },
  };

  return {
    db,
    getProjectQueryCount: () => projectQueryCount,
    getMachineQueryCount: () => machineQueryCount,
  };
}

async function loadProjectIngressProxyModule() {
  return import("./project-ingress-proxy.ts");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("project ingress hostname matching", () => {
  it("matches project slug host under iterate.app", () => {
    expect(isProjectIngressHostname("misha.iterate.app", "iterate.app")).toBe(true);
  });

  it("matches nested dev subdomain host", () => {
    expect(isProjectIngressHostname("misha.jonas.dev.iterate.app", "jonas.dev.iterate.app")).toBe(
      true,
    );
  });

  it("does not match the ingress domain itself", () => {
    expect(isProjectIngressHostname("iterate.app", "iterate.app")).toBe(false);
  });

  it("matches machine id host under iterate.app", () => {
    expect(isProjectIngressHostname("mach_123.iterate.app", "iterate.app")).toBe(true);
  });

  it("does not match unrelated hostnames", () => {
    expect(isProjectIngressHostname("google.com", "iterate.app")).toBe(false);
  });

  it("does not match unrelated hostnames with subdomain", () => {
    expect(isProjectIngressHostname("misha.example.com", "iterate.app")).toBe(false);
  });
});

describe("project ingress hostname resolution", () => {
  it("resolves project slug host with explicit port prefix", () => {
    expect(parseProjectIngressHostname("4096__banana.dev-jonas-os.dev.iterate.com")).toEqual({
      ok: true,
      target: { kind: "project", projectSlug: "banana", targetPort: 4096, isPortExplicit: true },
      rootDomain: "dev-jonas-os.dev.iterate.com",
    });
  });

  it("rejects invalid project slug tokens", () => {
    expect(parseProjectIngressHostname("1234.dev-jonas-os.dev.iterate.com")).toEqual({
      ok: false,
      error: "invalid_project_slug",
    });
  });
});

describe("project ingress request hostname", () => {
  it("avoids repeated DB lookups across a warm burst of authenticated ingress requests", async () => {
    const { createMachineStub } = await import("@iterate-com/sandbox/providers/machine-stub");
    const { getDb } = await import("../db/client.ts");
    const { handleProjectIngressRequest } = await loadProjectIngressProxyModule();

    const db = createProjectIngressDb({ maxProjectQueriesBeforeFailure: 1 });
    vi.mocked(getDb).mockReturnValue(db.db as never);
    vi.mocked(createMachineStub).mockResolvedValue({
      getFetcher: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(createResponse())),
    } as never);

    const request = new Request("https://demo.iterate.app/api/health", {
      headers: { host: "demo.iterate.app" },
    });
    const env = {
      PROJECT_INGRESS_DOMAIN: "iterate.app",
      VITE_PUBLIC_URL: "https://os.iterate.com",
    } as never;
    const session = {
      user: { id: "usr_123", role: "user" },
    } as never;

    await handleProjectIngressRequest(request, env, session);

    const responses = await Promise.all(
      Array.from({ length: 100 }, () => handleProjectIngressRequest(request, env, session)),
    );

    expect(responses).toHaveLength(100);
    expect(db.getProjectQueryCount()).toBe(1);
    expect(db.getMachineQueryCount()).toBe(1);
  });

  it("does not cache machine resolutions for starting machines", async () => {
    const { createMachineStub } = await import("@iterate-com/sandbox/providers/machine-stub");
    const { getDb } = await import("../db/client.ts");
    const { handleProjectIngressRequest } = await loadProjectIngressProxyModule();

    const db = createProjectIngressDb({ machineState: "starting" });
    vi.mocked(getDb).mockReturnValue(db.db as never);
    vi.mocked(createMachineStub).mockResolvedValue({
      getFetcher: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(createResponse())),
    } as never);

    const env = {
      PROJECT_INGRESS_DOMAIN: "iterate.app",
      VITE_PUBLIC_URL: "https://os.iterate.com",
    } as never;
    const session = {
      user: { id: "usr_123", role: "user" },
    } as never;

    const requestA = new Request("https://mach_123.iterate.app/api/health", {
      headers: { host: "mach_123.iterate.app" },
    });
    const requestB = new Request("https://mach_123.iterate.app/api/health", {
      headers: { host: "mach_123.iterate.app" },
    });

    await handleProjectIngressRequest(requestA, env, session);
    await handleProjectIngressRequest(requestB, env, session);

    expect(db.getProjectQueryCount()).toBe(2);
  });

  it("prefers host header when request url host is localhost", async () => {
    const { getProjectIngressRequestHostname } = await loadProjectIngressProxyModule();
    const request = new Request("http://localhost/api/pty/ws", {
      headers: {
        host: "3000__mach_01kh7nrrtkfap865vjbmv559ta.jonas2.dev.iterate.com",
      },
    });

    expect(getProjectIngressRequestHostname(request)).toBe(
      "3000__mach_01kh7nrrtkfap865vjbmv559ta.jonas2.dev.iterate.com",
    );
  });

  it("prefers x-forwarded-host over host", async () => {
    const { getProjectIngressRequestHostname } = await loadProjectIngressProxyModule();
    const request = new Request("http://localhost/", {
      headers: {
        host: "localhost:5173",
        "x-forwarded-host": "4096__mach_abc.dev.iterate.com",
      },
    });

    expect(getProjectIngressRequestHostname(request)).toBe("4096__mach_abc.dev.iterate.com");
  });
});
