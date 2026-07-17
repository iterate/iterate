import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import {
  defaultBareInvocationToChat,
  ensureBearerAuthHeadersForChat,
  oauthResourceForOsBaseUrl,
  refreshOAuthSession,
  replaceWithInheritedProcess,
  resolveChatProject,
  verifyOsSession,
} from "./cli.ts";

const createFakeSession = (input: {
  listError?: unknown;
  onConnect?: (connectInput: { auth: unknown; baseUrl: string }) => void;
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

  return { createSession, disposeAuthenticated, disposeProject };
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

describe("refreshOAuthSession", () => {
  test("uses the same normalized loopback resource as login", async () => {
    let body: URLSearchParams | undefined;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body =
        init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init?.body));
      return new Response(
        JSON.stringify({
          access_token: "new-token",
          expires_in: 3600,
          refresh_token: "refresh-token",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetch);

    try {
      await refreshOAuthSession({
        config: {
          authBaseUrl: "https://auth.iterate.com",
          osBaseUrl: "http://localhost:54896",
        },
        session: {
          clientId: "client-id",
          refreshToken: "refresh-token",
          token: "old-token",
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetch).toHaveBeenCalledWith(
      "https://auth.iterate.com/api/auth/oauth2/token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(body?.get("resource")).toBe("http://localhost");
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

describe("defaultBareInvocationToChat", () => {
  test("runs chat for a bare invocation", () => {
    expect(defaultBareInvocationToChat([])).toEqual(["chat"]);
  });

  test("leaves explicit commands and flags untouched", () => {
    const explicit = ["chat", "--project", "prj_123"];
    expect(defaultBareInvocationToChat(explicit)).toBe(explicit);

    const help = ["--help"];
    expect(defaultBareInvocationToChat(help)).toBe(help);
  });
});

describe("replaceWithInheritedProcess", () => {
  test("replaces the launcher process with inherited arguments and environment", () => {
    const replacementReached = new Error("replacement reached");
    const execve = vi.fn(
      (_file: string, _args: string[], _environment: Record<string, string>): never => {
        throw replacementReached;
      },
    );

    expect(() =>
      replaceWithInheritedProcess({
        command: process.execPath,
        args: ["entrypoint.mjs", "--flag"],
        env: {
          ITERATE_EXECVE_TEST: "inherited",
          ITERATE_EXECVE_UNSET: undefined,
        },
        execve,
      }),
    ).toThrow(replacementReached);

    expect(execve).toHaveBeenCalledOnce();
    expect(execve).toHaveBeenCalledWith(
      process.execPath,
      [process.execPath, "entrypoint.mjs", "--flag"],
      expect.objectContaining({ ITERATE_EXECVE_TEST: "inherited" }),
    );
    const environment = execve.mock.calls[0]?.[2];
    expect(environment).not.toHaveProperty("ITERATE_EXECVE_UNSET");
  });
});

describe("bin wrapper", () => {
  test("can load repo source through Node's strip-only TypeScript loader", () => {
    const binPath = fileURLToPath(new URL("../bin/iterate.js", import.meta.url));
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const result = spawnSync(process.execPath, [binPath, "--help"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });

    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("iterate");
  });

  test("npx-style execution uses the published package instead of repo source", () => {
    const sourceBinPath = fileURLToPath(new URL("../bin/iterate.js", import.meta.url));
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const tempRoot = mkdtempSync(join(tmpdir(), "iterate-bin-test-"));
    const fakePackageRoot = join(tempRoot, "node_modules", "iterate");
    const fakeBinDir = join(fakePackageRoot, "bin");
    const fakeDistDir = join(fakePackageRoot, "dist");
    const fakeBinPath = join(fakeBinDir, "iterate.js");

    try {
      mkdirSync(fakeBinDir, { recursive: true });
      mkdirSync(fakeDistDir, { recursive: true });
      writeFileSync(join(fakePackageRoot, "package.json"), '{"type":"module"}\n');
      writeFileSync(fakeBinPath, readFileSync(sourceBinPath));
      writeFileSync(
        join(fakeDistDir, "index.mjs"),
        "export async function runCli() { console.log('fake published dist'); }\n",
      );

      const result = spawnSync(process.execPath, [fakeBinPath], {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          npm_command: "exec",
          npm_lifecycle_event: "npx",
        },
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout.trim()).toBe("fake published dist");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  test("the PTY harness can force the built artifact while running inside the repo", () => {
    const sourceBinPath = fileURLToPath(new URL("../bin/iterate.js", import.meta.url));
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const tempRoot = mkdtempSync(join(tmpdir(), "iterate-bin-test-"));
    const fakePackageRoot = join(tempRoot, "node_modules", "iterate");
    const fakeBinDir = join(fakePackageRoot, "bin");
    const fakeDistDir = join(fakePackageRoot, "dist");
    const fakeBinPath = join(fakeBinDir, "iterate.js");

    try {
      mkdirSync(fakeBinDir, { recursive: true });
      mkdirSync(fakeDistDir, { recursive: true });
      writeFileSync(join(fakePackageRoot, "package.json"), '{"type":"module"}\n');
      writeFileSync(fakeBinPath, readFileSync(sourceBinPath));
      writeFileSync(
        join(fakeDistDir, "index.mjs"),
        "export async function runCli() { console.log('forced built dist'); }\n",
      );

      const result = spawnSync(process.execPath, [fakeBinPath], {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          ITERATE_FORCE_BUILT_PACKAGE: "1",
          npm_command: "",
          npm_lifecycle_event: "",
        },
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout.trim()).toBe("forced built dist");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  test("normal installed execution still delegates to repo source", () => {
    const sourceBinPath = fileURLToPath(new URL("../bin/iterate.js", import.meta.url));
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const tempRoot = mkdtempSync(join(tmpdir(), "iterate-bin-test-"));
    const fakePackageRoot = join(tempRoot, "node_modules", "iterate");
    const fakeBinDir = join(fakePackageRoot, "bin");
    const fakeDistDir = join(fakePackageRoot, "dist");
    const fakeBinPath = join(fakeBinDir, "iterate.js");

    try {
      mkdirSync(fakeBinDir, { recursive: true });
      mkdirSync(fakeDistDir, { recursive: true });
      writeFileSync(join(fakePackageRoot, "package.json"), '{"type":"module"}\n');
      writeFileSync(fakeBinPath, readFileSync(sourceBinPath));
      writeFileSync(
        join(fakeDistDir, "index.mjs"),
        "export async function runCli() { console.log('fake published dist'); }\n",
      );

      const result = spawnSync(process.execPath, [fakeBinPath, "--help"], {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          NO_COLOR: "1",
          npm_command: "",
          npm_lifecycle_event: "",
        },
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).not.toContain("fake published dist");
      expect(`${result.stdout}\n${result.stderr}`).toContain("Iterate CLI");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });
});

describe("ensureBearerAuthHeadersForChat", () => {
  test("uses an existing bearer session without logging in", async () => {
    const login = vi.fn();
    await expect(
      ensureBearerAuthHeadersForChat({
        getAuthHeaders: async () => ({ authorization: "Bearer token_123" }),
        login,
        osBaseUrl: "https://os.iterate.com",
      }),
    ).resolves.toEqual({ authorization: "Bearer token_123" });

    expect(login).not.toHaveBeenCalled();
  });

  test("logs in when the stored session is not usable as a bearer token", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const login = vi.fn();
    const getAuthHeaders = vi
      .fn<() => Promise<{ authorization?: string; cookie?: string }>>()
      .mockResolvedValueOnce({ cookie: "session=old" })
      .mockResolvedValueOnce({ authorization: "Bearer token_new" });

    await expect(
      ensureBearerAuthHeadersForChat({
        getAuthHeaders,
        login,
        osBaseUrl: "https://os.iterate.com",
      }),
    ).resolves.toEqual({ authorization: "Bearer token_new" });

    expect(login).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "Stored session for https://os.iterate.com cannot be used for chat. Starting browser login...",
    );
    consoleError.mockRestore();
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
    const fake = createFakeSession({
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
      waitUntilReady: false,
    });
    expect(fake.disposeProject).toHaveBeenCalledOnce();
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
      waitUntilReady: false,
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
      waitUntilReady: false,
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

  test("uses an explicit project id without enumerating accessible projects", async () => {
    const onConnect = vi.fn();
    const fake = createFakeSession({
      listError: new Error("project catalog must not be queried"),
      onConnect,
    });

    await expect(
      resolveChatProject({
        auth: { credentials: { type: "bearer", token: "token_123" } },
        baseUrl: "https://os.iterate.com",
        configName: "prd",
        configPath: "/tmp/config.json",
        explicitProject: "prj_explicit",
        createSession: fake.createSession,
      }),
    ).resolves.toBe("prj_explicit");

    expect(onConnect).not.toHaveBeenCalled();
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
