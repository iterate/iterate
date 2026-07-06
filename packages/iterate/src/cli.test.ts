import { describe, expect, test, vi } from "vitest";
import { oauthResourceForOsBaseUrl, resolveChatProject, verifyOsSession } from "./cli.ts";

const createFakeSession = (input: {
  listError?: unknown;
  onConnect?: (connectInput: { auth: unknown; baseUrl: string }) => void;
  onAgentReadyWait?: (args: unknown) => void;
  description?: { principal: string };
  onProjectCreate?: (args: unknown) => void;
  projects?: Array<{
    deploymentStatus: "missing" | "ready" | "unknown";
    id: string;
    organizationId: string | null;
    organizationName: string | null;
    organizationSlug: string | null;
    slug: string;
  }>;
}) => {
  const disposeAuthenticated = vi.fn();
  const disposeProject = vi.fn();
  const disposeStream = vi.fn();
  const createSession = ((connectInput: { auth: unknown; baseUrl: string }) => {
    input.onConnect?.(connectInput);
    return {
      __describe: async () => ({
        children: {},
        instructions: "",
        principal: "user_test",
        types: "",
        ...input.description,
      }),
      projects: {
        create: async (args: unknown) => {
          input.onProjectCreate?.(args);
          return {
            streams: {
              get: () => ({
                waitForEvent: async (waitArgs: unknown) => {
                  input.onAgentReadyWait?.(waitArgs);
                  return {};
                },
                [Symbol.dispose]: disposeStream,
              }),
            },
            [Symbol.dispose]: disposeProject,
          };
        },
        list: async () => {
          if (input.listError) throw input.listError;
          return input.projects ?? [];
        },
      },
      [Symbol.dispose]: disposeAuthenticated,
    };
  }) as unknown as NonNullable<Parameters<typeof verifyOsSession>[0]["createSession"]>;

  return { createSession, disposeAuthenticated, disposeProject, disposeStream };
};

describe("oauthResourceForOsBaseUrl", () => {
  test("uses the stable portless loopback resource for local OS dev ports", () => {
    expect(oauthResourceForOsBaseUrl("http://localhost:54896")).toBe("http://localhost");
    expect(oauthResourceForOsBaseUrl("http://127.0.0.1:54896")).toBe("http://127.0.0.1");
  });

  test("preserves deployed OS origins", () => {
    expect(oauthResourceForOsBaseUrl("https://os.iterate.com/")).toBe("https://os.iterate.com");
  });
});

describe("verifyOsSession", () => {
  test("authenticates against the capnweb WebSocket /api surface with a bearer token", async () => {
    let connectInput: { auth: unknown; baseUrl: string } | undefined;
    const fake = createFakeSession({
      description: { principal: "user_123" },
      onConnect: (value) => {
        connectInput = value;
      },
    });

    const description = await verifyOsSession({
      authHeaders: { authorization: "Bearer token_123" },
      baseUrl: "https://os.iterate.com/",
      createSession: fake.createSession,
    });

    expect(connectInput).toEqual({
      auth: { credentials: { type: "bearer", token: "token_123" } },
      baseUrl: "https://os.iterate.com/",
    });
    expect(description.principal).toBe("user_123");
    expect(fake.disposeAuthenticated).toHaveBeenCalledOnce();
  });
});

describe("resolveChatProject", () => {
  test("uses the only ready accessible project when no config default is set", async () => {
    const fake = createFakeSession({
      projects: [
        {
          deploymentStatus: "ready",
          id: "prj_only",
          organizationId: null,
          organizationName: null,
          organizationSlug: null,
          slug: "only",
        },
      ],
    });

    await expect(
      resolveChatProject({
        auth: { credentials: { type: "bearer", token: "token_123" } },
        baseUrl: "https://os.iterate.com",
        configName: "prd",
        configPath: "/tmp/config.json",
        createSession: fake.createSession,
      }),
    ).resolves.toBe("prj_only");
  });

  test("sets up the only missing accessible project before selecting it for chat", async () => {
    let createArgs: unknown;
    let waitArgs: unknown;
    const fake = createFakeSession({
      onAgentReadyWait: (args) => {
        waitArgs = args;
      },
      onProjectCreate: (args) => {
        createArgs = args;
      },
      projects: [
        {
          deploymentStatus: "missing",
          id: "prj_missing",
          organizationId: null,
          organizationName: null,
          organizationSlug: null,
          slug: "missing",
        },
      ],
    });

    await expect(
      resolveChatProject({
        auth: { credentials: { type: "bearer", token: "token_123" } },
        baseUrl: "https://os.iterate.com",
        configName: "prd",
        configPath: "/tmp/config.json",
        createSession: fake.createSession,
      }),
    ).resolves.toBe("prj_missing");

    expect(createArgs).toEqual({
      projectId: "prj_missing",
      slug: "missing",
      waitUntilCreated: false,
    });
    expect(waitArgs).toEqual({
      afterOffset: 0,
      eventTypes: ["events.iterate.com/agent/llm-provider-selected"],
      timeoutMs: 15_000,
    });
    expect(fake.disposeProject).toHaveBeenCalledOnce();
    expect(fake.disposeStream).toHaveBeenCalledOnce();
  });

  test("resolves and sets up a configured project slug when it is missing", async () => {
    let createArgs: unknown;
    const fake = createFakeSession({
      onProjectCreate: (args) => {
        createArgs = args;
      },
      projects: [
        {
          deploymentStatus: "missing",
          id: "prj_default",
          organizationId: null,
          organizationName: null,
          organizationSlug: null,
          slug: "default",
        },
      ],
    });

    await expect(
      resolveChatProject({
        auth: { credentials: { type: "bearer", token: "token_123" } },
        baseUrl: "https://os.iterate.com",
        configName: "prd",
        configPath: "/tmp/config.json",
        configuredDefaultProject: "default",
        createSession: fake.createSession,
      }),
    ).resolves.toBe("prj_default");

    expect(createArgs).toEqual({
      projectId: "prj_default",
      slug: "default",
      waitUntilCreated: false,
    });
  });

  test("passes the organization slug when setting up a missing project", async () => {
    let createArgs: unknown;
    const fake = createFakeSession({
      onProjectCreate: (args) => {
        createArgs = args;
      },
      projects: [
        {
          deploymentStatus: "missing",
          id: "prj_org_project",
          organizationId: "org_123",
          organizationName: "Acme",
          organizationSlug: "acme",
          slug: "org-project",
        },
      ],
    });

    await expect(
      resolveChatProject({
        auth: { credentials: { type: "bearer", token: "token_123" } },
        baseUrl: "https://os.iterate.com",
        configName: "prd",
        configPath: "/tmp/config.json",
        createSession: fake.createSession,
      }),
    ).resolves.toBe("prj_org_project");

    expect(createArgs).toEqual({
      organizationSlug: "acme",
      projectId: "prj_org_project",
      slug: "org-project",
      waitUntilCreated: false,
    });
  });

  test("rejects a configured project slug that is not accessible", async () => {
    const fake = createFakeSession({
      projects: [
        {
          deploymentStatus: "ready",
          id: "prj_other",
          organizationId: null,
          organizationName: null,
          organizationSlug: null,
          slug: "other",
        },
      ],
    });

    await expect(
      resolveChatProject({
        auth: { credentials: { type: "bearer", token: "token_123" } },
        baseUrl: "https://os.iterate.com",
        configName: "prd",
        configPath: "/tmp/config.json",
        configuredDefaultProject: "missing-slug",
        createSession: fake.createSession,
      }),
    ).rejects.toThrow(
      /Project "missing-slug" was not found among accessible projects.*other \(prj_other, ready\)/,
    );
  });

  test("passes through a configured project id that is not in the project list", async () => {
    const fake = createFakeSession({ projects: [] });

    await expect(
      resolveChatProject({
        auth: { credentials: { type: "bearer", token: "token_123" } },
        baseUrl: "https://os.iterate.com",
        configName: "prd",
        configPath: "/tmp/config.json",
        configuredDefaultProject: "prj_manual",
        createSession: fake.createSession,
      }),
    ).resolves.toBe("prj_manual");
  });

  test("does not bypass project resolution when listing accessible projects fails", async () => {
    const fake = createFakeSession({ listError: new Error("list exploded") });

    await expect(
      resolveChatProject({
        auth: { credentials: { type: "bearer", token: "token_123" } },
        baseUrl: "https://os.iterate.com",
        configName: "prd",
        configPath: "/tmp/config.json",
        configuredDefaultProject: "default",
        createSession: fake.createSession,
      }),
    ).rejects.toThrow(
      /could not list accessible projects.*cannot resolve slugs or recover auth-known projects.*list exploded/,
    );
  });

  test("keeps asking for an explicit project when multiple projects are accessible", async () => {
    const fake = createFakeSession({
      projects: [
        {
          deploymentStatus: "ready",
          id: "prj_one",
          organizationId: null,
          organizationName: null,
          organizationSlug: null,
          slug: "one",
        },
        {
          deploymentStatus: "ready",
          id: "prj_two",
          organizationId: null,
          organizationName: null,
          organizationSlug: null,
          slug: "two",
        },
      ],
    });

    await expect(
      resolveChatProject({
        auth: { credentials: { type: "bearer", token: "token_123" } },
        baseUrl: "https://os.iterate.com",
        configName: "prd",
        configPath: "/tmp/config.json",
        createSession: fake.createSession,
      }),
    ).rejects.toThrow(/Accessible projects: one \(prj_one, ready\), two \(prj_two, ready\)/);
  });
});
