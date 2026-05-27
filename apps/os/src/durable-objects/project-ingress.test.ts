import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  EXAMPLE_EGRESS_SECRET_KEY,
  EXAMPLE_EGRESS_SECRET_MATERIAL,
} from "~/domains/secrets/example-secret.ts";

afterEach(() => {
  vi.restoreAllMocks();
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

    const ingressRows = await env.DB.prepare(
      `SELECT host, project_id, callable_json
       FROM ingress_routes
       WHERE project_id = ?
       ORDER BY host ASC`,
    )
      .bind("proj__local__test")
      .all<{ host: string; project_id: string; callable_json: string }>();
    expect(ingressRows.results.map((row) => row.host)).toEqual([
      "demo.iterate.localhost",
      "proj__local__test.iterate.localhost",
    ]);
    expect(
      ingressRows.results.map((row) => ({
        host: row.host,
        exportName: (
          JSON.parse(row.callable_json) as {
            via: { exportName: string };
          }
        ).via.exportName,
      })),
    ).toEqual([
      { host: "demo.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "proj__local__test.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
    ]);

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

    const streamResponse = await SELF.fetch("https://os.iterate.localhost/__test/project-stream");
    expect(streamResponse.ok).toBe(true);
    const streamBody = (await streamResponse.json()) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(streamBody.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "events.iterate.com/project/created",
          payload: expect.objectContaining({
            defaultHost: "demo.iterate.localhost",
            projectId: "proj__local__test",
            slug: "demo",
          }),
        }),
      ]),
    );
    await waitForProjectLifecycleEvents([
      expect.objectContaining({
        type: "events.iterate.com/project/config-worker-built",
        payload: expect.objectContaining({
          mainModule: "worker.js",
          projectId: "proj__local__test",
          repoSlug: "iterate-config",
        }),
      }),
    ]);

    const lifecycleState = await waitForProjectLifecycleState();
    expect(lifecycleState.state.project).toMatchObject({
      defaultHost: "demo.iterate.localhost",
      projectId: "proj__local__test",
      slug: "demo",
    });
    expect(lifecycleState.reducedThroughOffset).toBeGreaterThanOrEqual(4);
    expect(lifecycleState.afterAppendCompletedThroughOffset).toBeGreaterThanOrEqual(4);

    const repoResponse = await SELF.fetch(
      "https://os.iterate.localhost/__test/iterate-config-repo",
    );
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
        remote: "https://artifacts.example.test/proj__local__test--iterate-config.git",
      }),
      remote: "https://artifacts.example.test/proj__local__test--iterate-config.git",
      slug: "iterate-config",
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

  test("requires the admin API secret for the Project Egress Intercept Route", async () => {
    await createProject();

    const response = await SELF.fetch(
      "https://demo.iterate.localhost/__iterate/intercept-project-egress",
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "Unauthorized." });
  });

  test("withholds egress header secrets and forwards through a Project Egress Intercept Tunnel", async () => {
    await createProject();
    await SELF.fetch(
      "https://os.iterate.localhost/__test/upsert-secret?key=openai&material=mvp-secret-value",
    );
    await SELF.fetch("https://os.iterate.localhost/__test/connect-egress-intercept");

    const response = await SELF.fetch(
      `https://os.iterate.localhost/__test/egress?target=${encodeURIComponent("https://api.example.com/v1/models?x=1")}`,
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
    expect(body.headers["x-iterate-test-secret"]).toEqual([
      `Secret value withheld because this Project Egress Intercept Tunnel is active. Requested "getSecret('openai')"`,
    ]);
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
      headers: headersToArrays(request.headers),
      url: request.url,
    });
  });
}

function headersToArrays(headers: Headers) {
  return Object.fromEntries([...headers].map(([key, value]) => [key, [value]]));
}

async function waitForProjectLifecycleState() {
  const deadline = Date.now() + 5_000;
  let latest: unknown;

  while (Date.now() < deadline) {
    const response = await SELF.fetch(
      "https://os.iterate.localhost/__test/project-lifecycle-state",
    );
    latest = await response.json();
    const state = latest as {
      afterAppendCompletedThroughOffset: number;
      reducedThroughOffset: number;
      state: {
        project: { projectId: string } | null;
      };
    };
    if (state.state.project?.projectId === "proj__local__test") {
      return state;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for project lifecycle state: ${JSON.stringify(latest)}`);
}

async function waitForProjectLifecycleEvents(expectedEvents: unknown[]) {
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
