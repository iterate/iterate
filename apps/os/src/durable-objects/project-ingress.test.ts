import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  EXAMPLE_EGRESS_SECRET_KEY,
  EXAMPLE_EGRESS_SECRET_MATERIAL,
} from "~/domains/secrets/example-secret.ts";
import { decideIngressRoute } from "~/workers/shared/router.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("decideIngressRoute", () => {
  const config = {
    baseUrl: "https://os.iterate.com",
    mcp: { baseUrl: "https://mcp.iterate.com" },
    projectHostnameBases: ["iterate.app"],
  };

  beforeEach(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        custom_hostname TEXT UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    ).run();
    await env.DB.prepare(`DELETE FROM projects`).run();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO projects (id, slug, custom_hostname) VALUES (?, ?, ?)`).bind(
        "prj_demo",
        "demo",
        "demo.example.com",
      ),
      env.DB.prepare(`INSERT INTO projects (id, slug, custom_hostname) VALUES (?, ?, ?)`).bind(
        "prj_other",
        "other",
        null,
      ),
    ]);
  });

  afterEach(async () => {
    await env.DB.prepare(`DELETE FROM projects WHERE id IN (?, ?)`)
      .bind("prj_demo", "prj_other")
      .run();
  });

  test.each([
    {
      name: "app host routes to the OS lane",
      config,
      method: "GET",
      url: "https://os.iterate.com/projects",
      expectedDecision: { lane: "os" },
    },
    {
      name: "event docs host routes to the OS lane",
      config,
      method: "GET",
      url: "https://events.iterate.com/core",
      expectedDecision: { lane: "os" },
    },
    {
      name: "configured MCP host routes to the MCP lane",
      config,
      method: "GET",
      url: "https://mcp.iterate.com/.well-known/oauth-protected-resource",
      expectedDecision: { lane: "mcp" },
    },
    {
      name: "localhost app config routes path-mounted MCP to the MCP lane",
      config: {
        ...config,
        baseUrl: "http://localhost:5176",
        mcp: undefined,
        projectHostnameBases: ["localhost"],
      },
      method: "GET",
      url: "http://localhost:5176/api/__mcp",
      expectedDecision: { lane: "mcp" },
    },
    {
      name: "project slug platform host routes to project ingress",
      config,
      method: "GET",
      url: "https://demo.iterate.app/",
      expectedDecision: {
        lane: "project",
        requestHost: "demo.iterate.app",
        projectId: "prj_demo",
        appSlug: null,
      },
    },
    {
      name: "project id platform host routes to project ingress",
      config,
      method: "GET",
      url: "https://prj_demo.iterate.app/",
      expectedDecision: {
        lane: "project",
        requestHost: "prj_demo.iterate.app",
        projectId: "prj_demo",
        appSlug: null,
      },
    },
    {
      name: "dotted app slug platform host routes to project ingress",
      config,
      method: "GET",
      url: "https://app1.demo.iterate.app/",
      expectedDecision: {
        lane: "project",
        requestHost: "app1.demo.iterate.app",
        projectId: "prj_demo",
        appSlug: "app1",
        headers: { "x-iterate-app-slug": "app1" },
      },
    },
    {
      name: "__ app slug platform host routes to project ingress",
      config,
      method: "GET",
      url: "https://app1__demo.iterate.app/",
      expectedDecision: {
        lane: "project",
        requestHost: "app1__demo.iterate.app",
        projectId: "prj_demo",
        appSlug: "app1",
        headers: { "x-iterate-app-slug": "app1" },
      },
    },
    {
      name: "localhost dotted app host routes to project ingress",
      config: {
        ...config,
        baseUrl: "http://localhost:5176",
        projectHostnameBases: ["localhost"],
      },
      method: "GET",
      url: "http://app1.demo.localhost:5176/",
      expectedDecision: {
        lane: "project",
        requestHost: "app1.demo.localhost",
        projectId: "prj_demo",
        appSlug: "app1",
        headers: { "x-iterate-app-slug": "app1" },
      },
    },
    {
      name: "dev tunnel base host routes to the OS lane",
      config: {
        ...config,
        baseUrl: "https://jonas.tunnels.iterate.com",
        projectHostnameBases: ["jonas.tunnels.iterate.com"],
      },
      method: "GET",
      url: "https://jonas.tunnels.iterate.com/projects",
      expectedDecision: { lane: "os" },
    },
    {
      name: "dev tunnel project subdomain routes to project ingress",
      config: {
        ...config,
        baseUrl: "https://jonas.tunnels.iterate.com",
        projectHostnameBases: ["jonas.tunnels.iterate.com"],
      },
      method: "GET",
      url: "https://demo.jonas.tunnels.iterate.com/",
      expectedDecision: {
        lane: "project",
        requestHost: "demo.jonas.tunnels.iterate.com",
        projectId: "prj_demo",
        appSlug: null,
      },
    },
    {
      name: "dev tunnel app host routes to project ingress",
      config: {
        ...config,
        baseUrl: "https://jonas.tunnels.iterate.com",
        projectHostnameBases: ["jonas.tunnels.iterate.com"],
      },
      method: "GET",
      url: "https://app1__demo.jonas.tunnels.iterate.com/",
      expectedDecision: {
        lane: "project",
        requestHost: "app1__demo.jonas.tunnels.iterate.com",
        projectId: "prj_demo",
        appSlug: "app1",
        headers: { "x-iterate-app-slug": "app1" },
      },
    },
    {
      name: "itx capability host routes to capability ingress before project ingress",
      config,
      method: "GET",
      url: "https://hello--demo.iterate.app/",
      expectedDecision: {
        lane: "itx",
        requestHost: "hello--demo.iterate.app",
        projectId: "prj_demo",
        capability: "hello",
      },
    },
    {
      name: "custom hostname routes to project ingress",
      config,
      method: "GET",
      url: "https://demo.example.com/",
      expectedDecision: {
        lane: "project",
        requestHost: "demo.example.com",
        projectId: "prj_demo",
        appSlug: null,
      },
    },
    {
      name: "single-label custom hostname app routes to project ingress",
      config,
      method: "POST",
      url: "https://webhooks.demo.example.com/github",
      expectedDecision: {
        lane: "project",
        requestHost: "webhooks.demo.example.com",
        projectId: "prj_demo",
        appSlug: "webhooks",
        headers: { "x-iterate-app-slug": "webhooks" },
      },
    },
    {
      name: "forwarded host is the public routing host",
      config,
      headers: {
        "x-forwarded-host": "demo.iterate.app",
        "x-forwarded-proto": "https",
      },
      method: "GET",
      url: "http://localhost:5173/",
      expectedDecision: {
        lane: "project",
        requestHost: "demo.iterate.app",
        projectId: "prj_demo",
        appSlug: null,
      },
    },
    {
      name: "unknown project platform host is not found",
      config,
      method: "GET",
      url: "https://missing.iterate.app/",
      expectedDecision: { lane: "notFound" },
    },
    {
      name: "unrecognized host is not found",
      config,
      method: "GET",
      url: "https://unknown.example.net/",
      expectedDecision: { lane: "notFound" },
    },
  ])("$name", async ({ config, expectedDecision, headers, method, url }) => {
    const decision = await decideIngressRoute({
      config,
      db: env.DB,
      headers,
      method,
      url,
    });

    if (decision.lane !== "project" && decision.lane !== "itx") {
      expect(decision).toEqual(expectedDecision);
      return;
    }

    if (decision.lane === "itx") {
      expect({
        lane: decision.lane,
        requestHost: decision.requestHost,
        projectId: decision.resolved.projectId,
        capability: decision.resolved.capability,
      }).toEqual(expectedDecision);
      return;
    }

    expect({
      lane: decision.lane,
      requestHost: decision.requestHost,
      projectId: decision.resolved.projectId,
      appSlug: decision.resolved.appSlug,
      headers: decision.headers,
    }).toEqual(expectedDecision);
  });
});

// Regression: a brand-new stream announces itself to every ancestor stream so
// each maintains immediate childPaths. The
// announcement is a core-processor side effect of the `stream/created` append;
// it once ran mid-append against the pre-commit "uninitialized" core state and
// dialed `uninitialized:/...` durable objects instead of the real ancestors.
test("creating a stream registers childPaths on its ancestor streams", async () => {
  const { getInitializedStreamStub } = await import("~/domains/streams/stream-runtime.ts");
  const { StreamPath } = await import("@iterate-com/shared/streams/types");
  const namespace = "proj__local__childpaths";
  const streamNamespace = env.STREAM as unknown as Parameters<
    typeof getInitializedStreamStub
  >[0]["durableObjectNamespace"];

  const child = await getInitializedStreamStub({
    durableObjectNamespace: streamNamespace,
    namespace,
    path: StreamPath.parse("/probe/a"),
  });
  await child.getState();

  const root = await getInitializedStreamStub({
    durableObjectNamespace: streamNamespace,
    namespace,
    path: StreamPath.parse("/"),
  });
  const intermediate = await getInitializedStreamStub({
    durableObjectNamespace: streamNamespace,
    namespace,
    path: StreamPath.parse("/probe"),
  });

  // The ancestor announcements are fire-and-forget background appends.
  const deadline = Date.now() + 5_000;
  let rootState = await root.getState();
  let intermediateState = await intermediate.getState();
  while (
    Date.now() < deadline &&
    (rootState.childPaths.length === 0 || intermediateState.childPaths.length === 0)
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    rootState = await root.getState();
    intermediateState = await intermediate.getState();
  }
  expect(rootState.childPaths).toEqual(["/probe"]);
  expect(intermediateState.childPaths).toEqual(["/probe/a"]);
});

describe("Project ingress routing", () => {
  test("routes iterate.localhost project hosts through the Project Durable Object", async () => {
    const createResponse = await SELF.fetch("https://os.iterate.localhost/__test/create-project");
    expect(createResponse.ok).toBe(true);
    await expect(createResponse.json()).resolves.toMatchObject({
      defaultHost: "demo.iterate.localhost",
      hosts: ["demo.iterate.localhost", "proj__local__test.iterate.localhost"],
      id: "proj__local__test",
      slug: "demo",
    });

    await waitForProjectStreamEvents([
      expect.objectContaining({
        type: "events.iterate.com/project/create-requested",
        payload: expect.objectContaining({
          projectId: "proj__local__test",
          slug: "demo",
        }),
      }),
      expect.objectContaining({
        type: "events.iterate.com/project/created",
        payload: expect.objectContaining({
          defaultHost: "demo.iterate.localhost",
          projectId: "proj__local__test",
          slug: "demo",
        }),
      }),
      expect.objectContaining({
        type: "events.iterate.com/project/repo-initialized",
        payload: expect.objectContaining({
          projectId: "proj__local__test",
          repoSlug: "project",
        }),
      }),
      expect.objectContaining({
        type: "events.iterate.com/project/create-completed",
        payload: expect.objectContaining({
          projectId: "proj__local__test",
        }),
      }),
    ]);

    const projectState = await waitForProjectState();
    expect(projectState.state.project).toMatchObject({
      defaultHost: "demo.iterate.localhost",
      projectId: "proj__local__test",
      slug: "demo",
    });
    expect(projectState.state.onboarding).toBe("in-progress");
    expect(projectState.state.phase).toBe("ready");
    expect(projectState.offset).toBeGreaterThanOrEqual(4);

    const onboardingResponse = await SELF.fetch(
      "https://os.iterate.localhost/__test/read-stream?path=/agents/onboarding",
    );
    expect(onboardingResponse.ok).toBe(true);
    const onboardingBody = (await onboardingResponse.json()) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(onboardingBody.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "events.iterate.com/agent/input-added",
          payload: expect.objectContaining({
            content: expect.stringContaining("Please read BOOTSTRAP.md"),
          }),
        }),
      ]),
    );

    const onboardingCompletedResponse = await SELF.fetch(
      "https://os.iterate.localhost/__test/append-onboarding-completed",
    );
    expect(onboardingCompletedResponse.ok).toBe(true);
    const { appended: onboardingCompleted } = (await onboardingCompletedResponse.json()) as {
      appended: { offset: number };
    };
    await vi.waitFor(async () => {
      const state = await (
        await SELF.fetch("https://os.iterate.localhost/__test/project-state")
      ).json();
      expect((state as { offset: number }).offset).toBeGreaterThanOrEqual(
        onboardingCompleted.offset,
      );
      expect((state as { state: { onboarding: string } }).state.onboarding).toBe("completed");
    });

    // itx.project deep-traverses in one expression (path proxy; regression
    // for "value.bind is not a function" when the fallthrough Proxy bound
    // getter results).
    const phaseResponse = await SELF.fetch(
      "https://os.iterate.localhost/__test/itx-project-processor-phase",
    );
    expect(phaseResponse.ok).toBe(true);
    const { phase } = (await phaseResponse.json()) as { phase: string };
    expect(["none", "creating", "ready"]).toContain(phase);

    // Creation cross-posts create-requested onto the deployment-wide global
    // audit stream (namespace "global", path /projects).
    const globalResponse = await SELF.fetch(
      "https://os.iterate.localhost/__test/global-projects-stream",
    );
    expect(globalResponse.ok).toBe(true);
    const globalBody = (await globalResponse.json()) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(globalBody.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "events.iterate.com/project/create-requested",
          payload: expect.objectContaining({
            projectId: "proj__local__test",
            slug: "demo",
          }),
        }),
      ]),
    );

    // A spoofed create-requested naming another project is ignored: no
    // reduced-state change, no D1 row for the foreign id.
    const spoofResponse = await SELF.fetch(
      "https://os.iterate.localhost/__test/append-spoofed-create",
    );
    expect(spoofResponse.ok).toBe(true);
    const { offset: spoofOffset } = (await spoofResponse.json()) as { offset: number };
    await vi.waitFor(async () => {
      const state = await (
        await SELF.fetch("https://os.iterate.localhost/__test/project-state")
      ).json();
      expect((state as { offset: number }).offset).toBeGreaterThanOrEqual(spoofOffset);
    });
    const afterSpoof = (await (
      await SELF.fetch("https://os.iterate.localhost/__test/project-state")
    ).json()) as { state: { project: { projectId: string } } };
    expect(afterSpoof.state.project.projectId).toBe("proj__local__test");
    const evilRow = await env.DB.prepare(`SELECT id FROM projects WHERE id = ?`)
      .bind("proj__local__evil")
      .first();
    expect(evilRow).toBeNull();

    // Creation side effects (the processor's create-requested steps) have
    // completed once phase is "ready" — the example secret is one of them.
    const exampleSecret = await env.DB.prepare(
      `SELECT key, material
       FROM project_secrets
       WHERE project_id = ? AND key = ?
       LIMIT 1`,
    )
      .bind("proj__local__test", EXAMPLE_EGRESS_SECRET_KEY)
      .first<{ key: string; material: string }>();
    expect(exampleSecret).toEqual({
      key: EXAMPLE_EGRESS_SECRET_KEY,
      material: EXAMPLE_EGRESS_SECRET_MATERIAL,
    });

    const repoResponse = await SELF.fetch("https://os.iterate.localhost/__test/project-repo");
    expect(repoResponse.ok).toBe(true);
    const repo = (await repoResponse.json()) as {
      git: {
        cloneCommand: string;
        pushCommand: string;
      };
      token: string;
    };
    expect(repo).toMatchObject({
      defaultBranch: "main",
      git: expect.objectContaining({
        cloneCommand: expect.stringContaining("git -c http.extraHeader="),
        remote: "https://artifacts.example.test/proj__local__test--project.git",
      }),
      remote: "https://artifacts.example.test/proj__local__test--project.git",
      slug: "project",
      token: expect.stringContaining("mock-write-"),
    });
    expect(repo.token).toContain("?expires=");
    expect(repo.git.cloneCommand).not.toContain("?expires=");
    expect(repo.git.pushCommand).not.toContain("?expires=");

    const projectIngressResponse = await waitForProjectIngressResponse({
      expectedText: "Bundled project worker",
      url: "https://demo.iterate.localhost/",
    });
    expect(projectIngressResponse.text).toBe("Bundled project worker");

    const projectIdIngressResponse = await waitForProjectIngressResponse({
      expectedText: "Bundled project worker",
      url: "https://proj__local__test.iterate.localhost/",
    });
    expect(projectIdIngressResponse.text).toBe("Bundled project worker");

    const appOneDotResponse = await SELF.fetch("https://app1.demo.iterate.localhost/");
    expect(appOneDotResponse.ok).toBe(true);
    await expect(appOneDotResponse.text()).resolves.toBe("hello from app one");

    const appOneUnderscoreResponse = await SELF.fetch("https://app1__demo.iterate.localhost/");
    expect(appOneUnderscoreResponse.ok).toBe(true);
    await expect(appOneUnderscoreResponse.text()).resolves.toBe("hello from app one");

    const appOneProjectIdDotResponse = await SELF.fetch(
      "https://app1.proj__local__test.iterate.localhost/",
    );
    expect(appOneProjectIdDotResponse.ok).toBe(true);
    await expect(appOneProjectIdDotResponse.text()).resolves.toBe("hello from app one");

    const appOneProjectIdUnderscoreResponse = await SELF.fetch(
      "https://app1__proj__local__test.iterate.localhost/",
    );
    expect(appOneProjectIdUnderscoreResponse.ok).toBe(true);
    await expect(appOneProjectIdUnderscoreResponse.text()).resolves.toBe("hello from app one");

    const appTwoDotResponse = await SELF.fetch("https://app2.demo.iterate.localhost/");
    expect(appTwoDotResponse.ok).toBe(true);
    await expect(appTwoDotResponse.text()).resolves.toBe("hello from app two");

    const appTwoUnderscoreResponse = await SELF.fetch("https://app2__demo.iterate.localhost/");
    expect(appTwoUnderscoreResponse.ok).toBe(true);
    await expect(appTwoUnderscoreResponse.text()).resolves.toBe("hello from app two");

    await env.DB.prepare(`UPDATE projects SET custom_hostname = ? WHERE id = ?`)
      .bind("shiterate.localhost", "proj__local__test")
      .run();

    const customHostnameResponse = await waitForProjectIngressResponse({
      expectedText: "Bundled project worker",
      url: "https://shiterate.localhost/",
    });
    expect(customHostnameResponse.text).toBe("Bundled project worker");

    const customHostnameAppResponse = await SELF.fetch("https://app1.shiterate.localhost/");
    expect(customHostnameAppResponse.ok).toBe(true);
    await expect(customHostnameAppResponse.text()).resolves.toBe("hello from app one");

    const nestedCustomHostnameAppResponse = await SELF.fetch(
      "https://nested.app1.shiterate.localhost/",
    );
    expect(nestedCustomHostnameAppResponse.status).toBe(404);
    await expect(nestedCustomHostnameAppResponse.text()).resolves.toBe("No ingress route matched.");

    await env.DB.prepare(`UPDATE projects SET custom_hostname = ? WHERE id = ?`)
      .bind("iterate.localhost", "proj__local__test")
      .run();

    const appHostnameResponse = await SELF.fetch("https://os.iterate.localhost/");
    expect(appHostnameResponse.status).toBe(404);
    await expect(appHostnameResponse.text()).resolves.toBe("No ingress route matched.");

    const streamsResponse = await SELF.fetch("https://streams.demo.iterate.localhost/", {
      headers: { accept: "text/html" },
    });
    expect(streamsResponse.ok).toBe(true);
    expect(await streamsResponse.text()).toBe("Bundled project worker");
  });

  test("substitutes egress header secrets through the Project Durable Object", async () => {
    const fetchSpy = mockPublicEchoFetch();
    await createProject();
    await SELF.fetch(
      "https://os.iterate.localhost/__test/upsert-secret?key=openai&material=mvp-secret-value",
    );

    const response = await SELF.fetch(
      `https://os.iterate.localhost/__test/egress?target=${encodeURIComponent("https://httpbingo.org/anything")}`,
      {
        headers: {
          "x-iterate-test-secret": `getSecret('openai')`,
        },
      },
    );
    expect(response.ok).toBe(true);
    const body = (await response.json()) as {
      headers: Record<string, string[]>;
    };

    expect(body.headers["x-iterate-test-secret"]).toEqual(["mvp-secret-value"]);
    expect(JSON.stringify(body)).not.toContain("getSecret");
    fetchSpy.mockRestore();
  });

  test("a live fetch-cap shadow intercepts egress and sees secret placeholders unsubstituted", async () => {
    await createProject();
    await SELF.fetch(
      "https://os.iterate.localhost/__test/upsert-secret?key=openai&material=mvp-secret-value",
    );

    // The shadow is a LIVE cap defined for the duration of one request (see
    // the /__test/egress-with-fetch-shadow route): it receives the request
    // instead of the network, with the getSecret() reference verbatim —
    // substitution only happens in the default pipe, so an interceptor never
    // sees secret material.
    const response = await SELF.fetch(
      `https://os.iterate.localhost/__test/egress-with-fetch-shadow?target=${encodeURIComponent("https://api.example.com/v1/models?x=1")}`,
      {
        headers: {
          "x-iterate-test-secret": `getSecret('openai')`,
        },
      },
    );

    expect(response.ok).toBe(true);
    const body = (await response.json()) as {
      headers: Record<string, string[]>;
      url: string;
    };

    expect(body.url).toBe("https://api.example.com/v1/models?x=1");
    expect(body.headers["x-iterate-test-secret"]).toEqual([`getSecret('openai')`]);
    expect(JSON.stringify(body)).not.toContain("mvp-secret-value");
  });

  test("fails egress descriptively when a referenced secret is missing", async () => {
    await createProject();

    const response = await SELF.fetch("https://os.iterate.localhost/__test/egress", {
      headers: {
        "x-iterate-test-secret": `getSecret({ key: "missing" })`,
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "project_egress_secret_substitution_failed",
      header: "x-iterate-test-secret",
      message: `Project egress secret substitution failed: Secret not found for key "missing".`,
      secretKey: "missing",
    });
  });
});

test("project config worker receives root-stream events and appends facts back", async () => {
  await createProject();

  // No build gate anymore: the forwarder loads the worker from its repo
  // source on demand (R2 memo); creation only has to finish.
  await waitForProjectStreamEvents([
    expect.objectContaining({ type: "events.iterate.com/project/create-completed" }),
  ]);

  // Append a fact to the project root stream. ProjectProcessor forwards it to
  // the config worker's processEvent export, which echoes it onto
  // /config-worker-saw — proving the whole chain: subscription wiring,
  // checkpointed forward, entrypoint resolution, and the object-export env
  // argument, all in real workerd.
  const appendResponse = await SELF.fetch(
    "https://os.iterate.localhost/__test/append-project-event?n=42",
  );
  expect(appendResponse.ok).toBe(true);

  const deadline = Date.now() + 10_000;
  let latest: unknown;
  while (Date.now() < deadline) {
    const response = await SELF.fetch(
      "https://os.iterate.localhost/__test/read-stream?path=/config-worker-saw",
    );
    latest = await response.json();
    const body = latest as { events: Array<{ type: string; payload: Record<string, unknown> }> };
    const saw = body.events.find((event) => event.type === "test.project/config-worker-saw");
    if (saw) {
      expect(saw.payload).toMatchObject({ n: 42 });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`config worker never saw the ping: ${JSON.stringify(latest)}`);
});

async function createProject() {
  const response = await SELF.fetch("https://os.iterate.localhost/__test/create-project");
  expect(response.ok).toBe(true);
}

function mockPublicEchoFetch() {
  const originalFetch = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname !== "httpbingo.org") {
      return await originalFetch(input, init);
    }

    return Response.json({
      headers: Object.fromEntries([...request.headers].map(([key, value]) => [key, [value]])),
      url: request.url,
    });
  });
}

async function waitForProjectState() {
  const deadline = Date.now() + 5_000;
  let latest: unknown;

  while (Date.now() < deadline) {
    const response = await SELF.fetch("https://os.iterate.localhost/__test/project-state");
    latest = await response.json();
    const snapshot = latest as {
      offset: number;
      state: {
        onboarding: string;
        phase: string;
        project: { projectId: string } | null;
      };
    };
    if (
      snapshot.state.project?.projectId === "proj__local__test" &&
      snapshot.state.phase === "ready"
    ) {
      return snapshot;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for project state: ${JSON.stringify(latest)}`);
}

async function waitForProjectStreamEvents(expectedEvents: unknown[]) {
  const deadline = Date.now() + 5_000;
  let latest: unknown;

  while (Date.now() < deadline) {
    const response = await SELF.fetch("https://os.iterate.localhost/__test/project-stream");
    latest = await response.json();
    const body = latest as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };

    try {
      expect(body.events).toEqual(expect.arrayContaining(expectedEvents));
      return body.events;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new Error(`Timed out waiting for project lifecycle events: ${JSON.stringify(latest)}`);
}

async function waitForProjectIngressResponse(input: { expectedText: string; url: string }) {
  const deadline = Date.now() + 5_000;
  let latest: unknown;

  while (Date.now() < deadline) {
    const response = await SELF.fetch(input.url);
    const text = await response.text();
    latest = {
      status: response.status,
      text,
      runtime: response.headers.get("x-project-ingress-runtime"),
    };
    if (response.ok && text === input.expectedText) {
      return {
        headers: response.headers,
        text,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for project ingress response: ${JSON.stringify(latest)}`);
}
