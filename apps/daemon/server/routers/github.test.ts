import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.ts";

const sqlite = new Database(":memory:");
sqlite.exec(`
  CREATE TABLE agents (
    path text PRIMARY KEY NOT NULL,
    working_directory text NOT NULL,
    metadata text,
    created_at integer DEFAULT (unixepoch()),
    updated_at integer DEFAULT (unixepoch()),
    archived_at integer,
    short_status text NOT NULL DEFAULT 'idle',
    is_working integer NOT NULL DEFAULT 0
  );
  CREATE TABLE agent_routes (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    agent_path text NOT NULL,
    destination text NOT NULL,
    active integer DEFAULT 1 NOT NULL,
    metadata text,
    created_at integer DEFAULT (unixepoch()),
    updated_at integer DEFAULT (unixepoch())
  );
  CREATE UNIQUE INDEX agent_routes_active_unique ON agent_routes (agent_path) WHERE active = 1;
  CREATE TABLE github_pr_agent_path (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    owner text NOT NULL,
    repo text NOT NULL,
    pr_number integer NOT NULL,
    agent_path text NOT NULL,
    source text NOT NULL DEFAULT 'deterministic',
    updated_at integer DEFAULT (unixepoch()),
    expires_at integer
  );
  CREATE UNIQUE INDEX github_pr_agent_path_owner_repo_pr_number_unique ON github_pr_agent_path (owner, repo, pr_number);
  CREATE TABLE github_webhook_state (
    agent_path text PRIMARY KEY NOT NULL,
    instructions_sent_at integer,
    last_event_hash text,
    last_event_at integer,
    last_seen_at integer DEFAULT (unixepoch())
  );
  CREATE TABLE github_webhook_buffer (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    agent_path text NOT NULL,
    bucket_key text NOT NULL,
    event_kind text NOT NULL,
    payload text NOT NULL,
    created_at integer DEFAULT (unixepoch()),
    flush_after_at integer NOT NULL
  );
`);

const testDb = drizzle(sqlite, { schema });

vi.mock("../db/index.ts", () => ({
  db: testDb,
}));

const { githubRouter } = await import("./github.ts");

describe("github router", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    sqlite.exec(
      "DELETE FROM github_webhook_buffer; DELETE FROM github_webhook_state; DELETE FROM github_pr_agent_path; DELETE FROM agent_routes; DELETE FROM agents;",
    );
    fetchSpy.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("forwards draft PR comments immediately", async () => {
    const response = await githubRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "issue_comment",
        deliveryId: "d-1",
        payload: {
          action: "created",
          repository: {
            full_name: "iterate/iterate",
            owner: { login: "iterate" },
            name: "iterate",
          },
          issue: {
            number: 1095,
            html_url: "https://github.com/iterate/iterate/pull/1095",
            body: "draft PR body",
            pull_request: { url: "https://api.github.com/repos/iterate/iterate/pulls/1095" },
          },
          comment: {
            body: "@iterate please fix",
            html_url: "https://github.com/iterate/iterate/pull/1095#issuecomment-1",
            user: { login: "alice" },
          },
          pull_request: { draft: true },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3001/api/agents/github/iterate/iterate/pr-1095",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("falls back to deterministic github path when mapped non-github path is stale", async () => {
    sqlite
      .prepare(
        "INSERT INTO github_pr_agent_path (owner, repo, pr_number, agent_path, source) VALUES (?, ?, ?, ?, ?)",
      )
      .run("iterate", "iterate", 1095, "/slack/C09K1CTN4M7/1772136258.963519", "marker");

    const response = await githubRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "pull_request_review_comment",
        deliveryId: "d-2",
        payload: {
          action: "created",
          repository: {
            full_name: "iterate/iterate",
            owner: { login: "iterate" },
            name: "iterate",
          },
          pull_request: {
            number: 1095,
            html_url: "https://github.com/iterate/iterate/pull/1095",
            body: "<!-- iterate:agent-pr -->",
          },
          comment: {
            body: "nit",
            html_url: "https://github.com/iterate/iterate/pull/1095#discussion_r1",
            user: { login: "bob" },
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3001/api/agents/github/iterate/iterate/pr-1095",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("ignores marker paths with placeholder PR ids like pr-NEW", async () => {
    const response = await githubRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "issue_comment",
        deliveryId: "d-5",
        payload: {
          action: "created",
          repository: {
            full_name: "iterate/iterate",
            owner: { login: "iterate" },
            name: "iterate",
          },
          issue: {
            number: 1105,
            html_url: "https://github.com/iterate/iterate/pull/1105",
            body: "<!-- iterate-agent-context\nagent_path: /github/iterate/iterate/pr-NEW\n-->\n<!-- iterate:agent-pr -->",
            pull_request: { url: "https://api.github.com/repos/iterate/iterate/pulls/1105" },
          },
          comment: {
            body: "please fix this",
            html_url: "https://github.com/iterate/iterate/pull/1105#issuecomment-1",
            user: { login: "alice" },
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3001/api/agents/github/iterate/iterate/pr-1105",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("debounces workflow_run events into a single batch prompt", async () => {
    sqlite
      .prepare(
        "INSERT INTO github_pr_agent_path (owner, repo, pr_number, agent_path, source) VALUES (?, ?, ?, ?, ?)",
      )
      .run("iterate", "iterate", 1095, "/github/iterate/iterate/pr-1095", "deterministic");

    const payload = {
      action: "completed",
      repository: { full_name: "iterate/iterate", owner: { login: "iterate" }, name: "iterate" },
      workflow_run: {
        name: "CI",
        conclusion: "failure",
        head_branch: "feature",
        html_url: "https://github.com/iterate/iterate/actions/runs/1",
        pull_requests: [{ number: 1095 }],
      },
    };

    await githubRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType: "workflow_run", deliveryId: "d-3", payload }),
    });
    await githubRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType: "workflow_run", deliveryId: "d-4", payload }),
    });

    expect(fetchSpy).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3001/api/agents/github/iterate/iterate/pr-1095",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("forwards merged pull_request events using stored mapping without marker", async () => {
    sqlite
      .prepare(
        "INSERT INTO github_pr_agent_path (owner, repo, pr_number, agent_path, source) VALUES (?, ?, ?, ?, ?)",
      )
      .run("iterate", "iterate", 1500, "/github/iterate/iterate/pr-1500", "mention");

    const response = await githubRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "pull_request",
        deliveryId: "d-merge-mapping",
        payload: {
          action: "closed",
          repository: {
            full_name: "iterate/iterate",
            owner: { login: "iterate" },
            name: "iterate",
          },
          pull_request: {
            number: 1500,
            merged: true,
            body: "regular PR body without marker",
            html_url: "https://github.com/iterate/iterate/pull/1500",
          },
          sender: { login: "octocat" },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3001/api/agents/github/iterate/iterate/pr-1500",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("retries buffered flush after transient agent post failure", async () => {
    sqlite
      .prepare(
        "INSERT INTO github_pr_agent_path (owner, repo, pr_number, agent_path, source) VALUES (?, ?, ?, ?, ?)",
      )
      .run("iterate", "iterate", 1300, "/github/iterate/iterate/pr-1300", "deterministic");

    fetchSpy
      .mockRejectedValueOnce(new Error("agent unavailable"))
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const payload = {
      action: "completed",
      repository: { full_name: "iterate/iterate", owner: { login: "iterate" }, name: "iterate" },
      workflow_run: {
        name: "CI",
        conclusion: "failure",
        head_branch: "feature",
        html_url: "https://github.com/iterate/iterate/actions/runs/22",
        pull_requests: [{ number: 1300 }],
      },
    };

    await githubRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType: "workflow_run", deliveryId: "d-retry", payload }),
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3001/api/agents/github/iterate/iterate/pr-1300",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not resend already-flushed buckets after partial flush failure", async () => {
    sqlite
      .prepare(
        "INSERT INTO github_pr_agent_path (owner, repo, pr_number, agent_path, source) VALUES (?, ?, ?, ?, ?)",
      )
      .run("iterate", "iterate", 1400, "/github/iterate/iterate/pr-1400", "deterministic");
    sqlite
      .prepare(
        "INSERT INTO github_pr_agent_path (owner, repo, pr_number, agent_path, source) VALUES (?, ?, ?, ?, ?)",
      )
      .run("iterate", "iterate", 1401, "/github/iterate/iterate/pr-1400", "deterministic");

    fetchSpy
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockRejectedValueOnce(new Error("second bucket failed"))
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const payload1400 = {
      action: "completed",
      repository: { full_name: "iterate/iterate", owner: { login: "iterate" }, name: "iterate" },
      workflow_run: {
        name: "CI-A",
        conclusion: "failure",
        head_branch: "feature",
        html_url: "https://github.com/iterate/iterate/actions/runs/1400",
        pull_requests: [{ number: 1400 }],
      },
    };

    const payload1401 = {
      action: "completed",
      repository: { full_name: "iterate/iterate", owner: { login: "iterate" }, name: "iterate" },
      workflow_run: {
        name: "CI-B",
        conclusion: "failure",
        head_branch: "feature",
        html_url: "https://github.com/iterate/iterate/actions/runs/1401",
        pull_requests: [{ number: 1401 }],
      },
    };

    await githubRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "workflow_run",
        deliveryId: "d-partial-a",
        payload: payload1400,
      }),
    });
    await githubRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "workflow_run",
        deliveryId: "d-partial-b",
        payload: payload1401,
      }),
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("resolves marker session_id to active agent path", async () => {
    sqlite
      .prepare("INSERT INTO agents (path, working_directory) VALUES (?, ?)")
      .run("/slack/C123/123.456", "/workspace/repo");
    sqlite
      .prepare("INSERT INTO agent_routes (agent_path, destination, active) VALUES (?, ?, 1)")
      .run("/slack/C123/123.456", "/opencode/sessions/ses_abc123");

    const response = await githubRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "issue_comment",
        deliveryId: "d-6",
        payload: {
          action: "created",
          repository: {
            full_name: "iterate/iterate",
            owner: { login: "iterate" },
            name: "iterate",
          },
          issue: {
            number: 1105,
            html_url: "https://github.com/iterate/iterate/pull/1105",
            body: "<!-- iterate-agent-context\nsession_id: ses_abc123\n-->\n<!-- iterate:agent-pr -->",
            pull_request: { url: "https://api.github.com/repos/iterate/iterate/pulls/1105" },
          },
          comment: {
            body: "route to session",
            html_url: "https://github.com/iterate/iterate/pull/1105#issuecomment-2",
            user: { login: "alice" },
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3001/api/agents/slack/C123/123.456",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("ignores untagged events without marker or mention", async () => {
    const response = await githubRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "issue_comment",
        deliveryId: "d-ignore",
        payload: {
          action: "created",
          repository: {
            full_name: "iterate/iterate",
            owner: { login: "iterate" },
            name: "iterate",
          },
          issue: {
            number: 1200,
            html_url: "https://github.com/iterate/iterate/pull/1200",
            body: "plain body",
            pull_request: { url: "https://api.github.com/repos/iterate/iterate/pulls/1200" },
          },
          comment: {
            body: "looks good",
            html_url: "https://github.com/iterate/iterate/pull/1200#issuecomment-1",
            user: { login: "alice" },
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it("routes issue_comment via stored mapping even without marker or mention", async () => {
    sqlite
      .prepare(
        "INSERT INTO github_pr_agent_path (owner, repo, pr_number, agent_path, source) VALUES (?, ?, ?, ?, ?)",
      )
      .run("iterate", "iterate", 1300, "/github/iterate/iterate/pr-1300", "marker");

    const response = await githubRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "issue_comment",
        deliveryId: "d-mapping-comment",
        payload: {
          action: "created",
          repository: {
            full_name: "iterate/iterate",
            owner: { login: "iterate" },
            name: "iterate",
          },
          issue: {
            number: 1300,
            html_url: "https://github.com/iterate/iterate/pull/1300",
            body: "plain body without marker",
            pull_request: { url: "https://api.github.com/repos/iterate/iterate/pulls/1300" },
          },
          comment: {
            body: "can you rebase this?",
            html_url: "https://github.com/iterate/iterate/pull/1300#issuecomment-1",
            user: { login: "alice" },
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3001/api/agents/github/iterate/iterate/pr-1300",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("routes pull_request_review via stored mapping even without marker or mention", async () => {
    sqlite
      .prepare(
        "INSERT INTO github_pr_agent_path (owner, repo, pr_number, agent_path, source) VALUES (?, ?, ?, ?, ?)",
      )
      .run("iterate", "iterate", 1400, "/github/iterate/iterate/pr-1400", "marker");

    const response = await githubRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "pull_request_review",
        deliveryId: "d-mapping-review",
        payload: {
          action: "submitted",
          repository: {
            full_name: "iterate/iterate",
            owner: { login: "iterate" },
            name: "iterate",
          },
          pull_request: {
            number: 1400,
            html_url: "https://github.com/iterate/iterate/pull/1400",
            body: "plain body without marker",
          },
          review: {
            body: "looks good overall",
            html_url: "https://github.com/iterate/iterate/pull/1400#pullrequestreview-1",
            user: { login: "NickBlow" },
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3001/api/agents/github/iterate/iterate/pr-1400",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("accepts marker comments with trailing annotation text", async () => {
    const response = await githubRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "issue_comment",
        deliveryId: "d-marker-annotated",
        payload: {
          action: "created",
          repository: {
            full_name: "iterate/iterate",
            owner: { login: "iterate" },
            name: "iterate",
          },
          issue: {
            number: 1201,
            html_url: "https://github.com/iterate/iterate/pull/1201",
            body: "<!-- iterate:agent-pr # from your environment variable -->",
            pull_request: { url: "https://api.github.com/repos/iterate/iterate/pulls/1201" },
          },
          comment: {
            body: "looks good",
            html_url: "https://github.com/iterate/iterate/pull/1201#issuecomment-1",
            user: { login: "alice" },
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3001/api/agents/github/iterate/iterate/pr-1201",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("resolves marker session_id even when route is inactive", async () => {
    sqlite
      .prepare("INSERT INTO agents (path, working_directory) VALUES (?, ?)")
      .run("/slack/C123/999.000", "/workspace/repo");
    sqlite
      .prepare("INSERT INTO agent_routes (agent_path, destination, active) VALUES (?, ?, 0)")
      .run("/slack/C123/999.000", "/opencode/sessions/ses_oldprsession");

    const response = await githubRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "issue_comment",
        deliveryId: "d-8",
        payload: {
          action: "created",
          repository: {
            full_name: "iterate/iterate",
            owner: { login: "iterate" },
            name: "iterate",
          },
          issue: {
            number: 1108,
            html_url: "https://github.com/iterate/iterate/pull/1108",
            body: "<!-- iterate-agent-context\nsession_id: ses_oldprsession\n-->\n<!-- iterate:agent-pr -->",
            pull_request: { url: "https://api.github.com/repos/iterate/iterate/pulls/1108" },
          },
          comment: {
            body: "reuse original session route",
            html_url: "https://github.com/iterate/iterate/pull/1108#issuecomment-3",
            user: { login: "alice" },
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3001/api/agents/slack/C123/999.000",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("falls back to deterministic path when marker session_id is unresolved", async () => {
    const response = await githubRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "issue_comment",
        deliveryId: "d-7",
        payload: {
          action: "created",
          repository: {
            full_name: "iterate/iterate",
            owner: { login: "iterate" },
            name: "iterate",
          },
          issue: {
            number: 1106,
            html_url: "https://github.com/iterate/iterate/pull/1106",
            body: "<!-- iterate-agent-context\nsession_id: ses_missing\n-->\n<!-- iterate:agent-pr -->",
            pull_request: { url: "https://api.github.com/repos/iterate/iterate/pulls/1106" },
          },
          comment: {
            body: "new routing please",
            html_url: "https://github.com/iterate/iterate/pull/1106#issuecomment-2",
            user: { login: "alice" },
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3001/api/agents/github/iterate/iterate/pr-1106",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
