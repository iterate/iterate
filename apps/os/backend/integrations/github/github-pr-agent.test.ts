import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMachineStub } from "@iterate-com/sandbox/providers/machine-stub";
import { routePullRequestSignalToAgent } from "./github-pr-agent.ts";
import { getGitHubInstallationToken } from "./github.ts";

vi.mock("@iterate-com/sandbox/providers/machine-stub", () => ({
  createMachineStub: vi.fn(),
}));

vi.mock("./github.ts", () => ({
  getGitHubInstallationToken: vi.fn(),
}));

vi.mock("../../tag-logger.ts", () => ({
  logger: {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function responseJson(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function createDbMock() {
  return {
    query: {
      project: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "proj_1",
            slug: "demo",
            machines: [
              {
                id: "mach_1",
                type: "docker",
                externalId: "ext_1",
                metadata: {},
              },
            ],
          },
        ]),
      },
      projectConnection: {
        findFirst: vi.fn().mockResolvedValue({ providerData: { installationId: 11 } }),
      },
    },
  };
}

async function routeWithPrBody(params: { body: string; author?: string }) {
  const db = createDbMock();
  const fetcher = vi.fn().mockResolvedValue(responseJson({ success: true }));
  vi.mocked(createMachineStub).mockResolvedValue({
    getFetcher: vi.fn().mockResolvedValue(fetcher),
  } as never);
  vi.mocked(getGitHubInstallationToken).mockResolvedValue("ghs_token");

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith("/pulls/123")) {
        return responseJson({
          number: 123,
          title: "Test PR",
          body: params.body,
          html_url: "https://github.com/iterate/iterate/pull/123",
          user: { login: params.author ?? "alice" },
        });
      }
      if (value.includes("/issues/123/comments")) return responseJson([]);
      if (value.includes("/pulls/123/reviews")) return responseJson([]);
      if (value.includes("/pulls/123/comments")) return responseJson([]);
      throw new Error(`Unexpected fetch URL: ${value}`);
    }),
  );

  await routePullRequestSignalToAgent({
    db: db as never,
    env: { GITHUB_APP_SLUG: "iterate" } as never,
    signal: {
      repo: { owner: "iterate", name: "iterate", fullName: "iterate/iterate" },
      prNumber: 123,
      eventKind: "issue_comment",
      action: "created",
      actorLogin: "someone",
      eventBody: "",
      eventUrl: "https://github.com/iterate/iterate/issues/123#issuecomment-1",
    },
  });

  return { fetcher };
}

describe("routePullRequestSignalToAgent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses marker agent_path when present", async () => {
    const { fetcher } = await routeWithPrBody({
      body: "<!-- iterate-agent-context\nagent_path: /custom/live/path\n-->\n<!-- iterate:agent-pr -->",
      author: "iterate[bot]",
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/agents/custom/live/path",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("falls back to deterministic path when marker path is invalid", async () => {
    const { fetcher } = await routeWithPrBody({
      body: "<!-- iterate-agent-context\nagent_path: custom/live/path\n-->\n<!-- iterate:agent-pr -->",
      author: "iterate[bot]",
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/agents/github/iterate/iterate/pr-123",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("ignores marker path from non-iterate author without mention", async () => {
    const { fetcher } = await routeWithPrBody({
      body: "<!-- iterate-agent-context\nagent_path: /from/context/block\n-->",
      author: "human-dev",
    });

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects marker path traversal segments and falls back", async () => {
    const { fetcher } = await routeWithPrBody({
      body: "<!-- iterate-agent-context\nagent_path: /../../../other\n-->\n<!-- iterate:agent-pr -->",
      author: "iterate[bot]",
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/agents/github/iterate/iterate/pr-123",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("ignores PR with no marker, no mention, non-bot author", async () => {
    const { fetcher } = await routeWithPrBody({
      body: "plain body with no mentions",
      author: "human-dev",
    });

    expect(fetcher).not.toHaveBeenCalled();
  });
});
