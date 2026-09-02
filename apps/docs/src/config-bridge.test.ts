import { afterEach, describe, expect, test, vi } from "vitest";
import { DocsApp } from "./config-bridge.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DocsApp", () => {
  test("preserves a declined request body when proxying the complete URL", async () => {
    const dispose = vi.fn();
    const authFetch = vi.fn(async (_request: Request) => null);
    const fetchMock = vi.fn(
      async (request: Request) => new Response(`${request.url}|${await request.text()}`),
    );
    vi.stubGlobal("fetch", fetchMock);
    const app = DocsApp.create(
      {
        ITX: {
          get: async () => ({
            [Symbol.dispose]: dispose,
            appUrl: async () => "https://docs--demo.iterate.app",
            auth: { get: () => ({ fetch: authFetch }) },
            kv: { get: async () => null },
          }),
        },
      },
      {
        auth: { policy: "project-member" },
        proxy: {
          origin: "https://docs.iterate.workers.dev",
          originOverrideKvKey: "docs-app-origin",
        },
      },
    );

    const request = new Request(
      "https://docs--demo.iterate.app/?workspace=%2Fworkspaces%2Fagents%2Freviewer&path=plan.md",
      { body: "still here", method: "POST" },
    );
    const response = await app.fetch(request);

    await expect(response.text()).resolves.toBe(
      "https://docs.iterate.workers.dev/?workspace=%2Fworkspaces%2Fagents%2Freviewer&path=plan.md|still here",
    );
    expect(authFetch).toHaveBeenCalledOnce();
    expect(authFetch.mock.calls[0]![0]).not.toBe(request);
    expect(authFetch.mock.calls[0]![0].body).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  test("drops a local project host's port when rewriting to the vessel origin", async () => {
    const fetchMock = vi.fn(async (request: Request) => new Response(request.url));
    vi.stubGlobal("fetch", fetchMock);
    const app = DocsApp.create(
      {
        ITX: {
          get: async () => ({
            [Symbol.dispose]: () => undefined,
            appUrl: async () => "http://docs--test.localhost:50209",
            auth: { get: () => ({ fetch: async () => null }) },
            kv: { get: async () => "https://jonas-docs.tunnels.iterate.com" },
          }),
        },
      },
      {
        auth: { policy: "project-member" },
        proxy: {
          origin: "https://docs.iterate.workers.dev",
          originOverrideKvKey: "docs-app-origin",
        },
      },
    );

    const response = await app.fetch(
      new Request("http://docs--test.localhost:50209/log?repo=%2Frepos%2Fconfig"),
    );
    // The KV override wins, and the request's :50209 must not survive the
    // rewrite (an HTTPS origin with no explicit port means the default one).
    await expect(response.text()).resolves.toBe(
      "https://jonas-docs.tunnels.iterate.com/log?repo=%2Frepos%2Fconfig",
    );
  });

  test("returns the member gate response without contacting the vessel", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const denied = new Response("sign in", { status: 401 });
    const app = DocsApp.create(
      {
        ITX: {
          get: async () => ({
            [Symbol.dispose]: () => undefined,
            appUrl: async () => "https://docs--demo.iterate.app",
            auth: { get: () => ({ fetch: async () => denied }) },
            kv: { get: async () => null },
          }),
        },
      },
      {
        auth: { policy: "project-member" },
        proxy: {
          origin: "https://docs.iterate.workers.dev",
          originOverrideKvKey: "docs-app-origin",
        },
      },
    );

    await expect(app.fetch(new Request("https://docs--demo.iterate.app/"))).resolves.toBe(denied);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("builds an environment-correct review link for a workspace document", async () => {
    const dispose = vi.fn();
    const appUrl = vi.fn(async () => "https://docs--demo.iterate-preview-3.app");
    const app = DocsApp.create(
      {
        ITX: {
          get: async () => ({
            [Symbol.dispose]: dispose,
            appUrl,
            auth: { get: () => ({ fetch: async () => null }) },
            kv: { get: async () => null },
          }),
        },
      },
      {
        auth: { policy: "project-member" },
        proxy: {
          origin: "https://docs.iterate.workers.dev",
          originOverrideKvKey: "docs-app-origin",
        },
      },
    );

    await expect(
      app.rpc.link({
        workspace: "/workspaces/agents/reviewer",
        path: "reviews/launch plan.md",
      }),
    ).resolves.toBe(
      "https://docs--demo.iterate-preview-3.app/?workspace=%2Fworkspaces%2Fagents%2Freviewer&path=reviews%2Flaunch+plan.md",
    );
    expect(appUrl).toHaveBeenCalledWith("docs");
    expect(dispose).toHaveBeenCalledOnce();
  });

  test("builds a board link when the input carries a repo", async () => {
    const dispose = vi.fn();
    const appUrl = vi.fn(async () => "https://docs--demo.iterate-preview-3.app");
    const app = DocsApp.create(
      {
        ITX: {
          get: async () => ({
            [Symbol.dispose]: dispose,
            appUrl,
            auth: { get: () => ({ fetch: async () => null }) },
            kv: { get: async () => null },
          }),
        },
      },
      {
        auth: { policy: "project-member" },
        proxy: {
          origin: "https://docs.iterate.workers.dev",
          originOverrideKvKey: "docs-app-origin",
        },
      },
    );

    await expect(
      app.rpc.link({
        workspace: "/workspaces/agents/reviewer",
        repo: "/repos/config",
        task: "tasks/plan.md",
      }),
    ).resolves.toBe(
      "https://docs--demo.iterate-preview-3.app/w?workspace=%2Fworkspaces%2Fagents%2Freviewer&repo=%2Frepos%2Fconfig&task=tasks%2Fplan.md",
    );
    expect(appUrl).toHaveBeenCalledWith("docs");
    expect(dispose).toHaveBeenCalledOnce();
  });

  test("builds a notes link when the input carries notes (no workspace)", async () => {
    const dispose = vi.fn();
    const appUrl = vi.fn(async () => "https://docs--demo.iterate-preview-3.app");
    const app = DocsApp.create(
      {
        ITX: {
          get: async () => ({
            [Symbol.dispose]: dispose,
            appUrl,
            auth: { get: () => ({ fetch: async () => null }) },
            kv: { get: async () => null },
          }),
        },
      },
      {
        auth: { policy: "project-member" },
        proxy: {
          origin: "https://docs.iterate.workers.dev",
          originOverrideKvKey: "docs-app-origin",
        },
      },
    );

    await expect(
      app.rpc.link({ notes: "/repos/config", note: "notes/launch plan.md" }),
    ).resolves.toBe(
      "https://docs--demo.iterate-preview-3.app/notes?repo=%2Frepos%2Fconfig&note=notes%2Flaunch+plan.md",
    );
    // No note: the view opens on its default (the long-running log).
    await expect(app.rpc.link({ notes: "/repos/config" })).resolves.toBe(
      "https://docs--demo.iterate-preview-3.app/notes?repo=%2Frepos%2Fconfig",
    );
    expect(appUrl).toHaveBeenCalledWith("docs");
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  test("names the exactly-one rule when two lenses are asked for", async () => {
    const itxGet = vi.fn();
    const app = DocsApp.create(
      { ITX: { get: itxGet } },
      {
        auth: { policy: "project-member" },
        proxy: {
          origin: "https://docs.iterate.workers.dev",
          originOverrideKvKey: "docs-app-origin",
        },
      },
    );

    await expect(
      app.rpc.link({ notes: "/repos/config", repo: "/repos/config" } as never),
    ).rejects.toThrow("pass exactly one of path (document view), repo (board view), or notes");
    await expect(app.rpc.link({ note: "notes/plan.md" } as never)).rejects.toThrow(
      "pass exactly one of",
    );
    expect(itxGet).not.toHaveBeenCalled();
  });

  test.each([
    { path: "../review.md", workspace: "/workspaces/agents/reviewer" },
    { path: "reviews/../review.md", workspace: "/workspaces/agents/reviewer" },
    { path: "review.txt", workspace: "/workspaces/agents/reviewer" },
    { path: "", workspace: "/workspaces/agents/reviewer" },
    { path: "review.md", workspace: "/repos/config" },
    { path: "review.md", workspace: "/workspaces/agents/../reviewer" },
    // Board form: bad repos, absolute/non-task task paths, and both-lenses.
    { repo: "/repos", workspace: "/workspaces/agents/reviewer" },
    { repo: "config", workspace: "/workspaces/agents/reviewer" },
    { repo: "/repos/config", task: "/tasks/plan.md", workspace: "/workspaces/agents/reviewer" },
    { repo: "/repos/config", task: "docs/plan.md", workspace: "/workspaces/agents/reviewer" },
    { path: "review.md", repo: "/repos/config", workspace: "/workspaces/agents/reviewer" },
    // Notes form: bad repos, and notes that are absolute, outside notes/, or
    // not Markdown.
    { notes: "/repos" },
    { notes: "config" },
    { notes: "/repos/config", note: "/notes/plan.md" },
    { notes: "/repos/config", note: "docs/plan.md" },
    { notes: "/repos/config", note: "notes/../plan.md" },
    { notes: "/repos/config", note: "notes/plan.txt" },
    { notes: "/repos/config", note: "notes/" },
    // The workspace views still need a workspace.
    { path: "review.md" },
    { repo: "/repos/config" },
  ])(
    "refuses to mint a link the UI would reject (%j)",
    async ({ path, repo, task, workspace, notes, note }: Record<string, string | undefined>) => {
      const itxGet = vi.fn();
      const app = DocsApp.create(
        { ITX: { get: itxGet } },
        {
          auth: { policy: "project-member" },
          proxy: {
            origin: "https://docs.iterate.workers.dev",
            originOverrideKvKey: "docs-app-origin",
          },
        },
      );

      await expect(
        app.rpc.link({ path, repo, task, workspace, notes, note } as never),
      ).rejects.toThrow();
      expect(itxGet).not.toHaveBeenCalled();
    },
  );
});
