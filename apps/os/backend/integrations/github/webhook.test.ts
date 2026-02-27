import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { githubApp } from "./github.ts";

// Mock the dependencies
vi.mock("../../../env.ts", () => ({
  waitUntil: vi.fn((promise) => promise),
}));

vi.mock("../../tag-logger.ts", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../services/machine-creation.ts", () => ({
  createMachineForProject: vi.fn().mockResolvedValue({
    machine: { id: "mach_test123", name: "test-machine" },
  }),
}));

vi.mock("../../lib/posthog.ts", () => ({
  trackWebhookEvent: vi.fn(),
}));

// Helper to generate valid signature
async function generateSignature(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return (
    "sha256=" +
    Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

// Test payloads
const validWorkflowRunPayload = {
  action: "completed",
  workflow_run: {
    id: 12345,
    name: "CI",
    head_branch: "main",
    head_sha: "abc123def456",
    path: ".github/workflows/ci.yml",
    conclusion: "success",
    repository: {
      full_name: "iterate/iterate",
    },
  },
  repository: {
    full_name: "iterate/iterate",
  },
};

describe("GitHub Webhook Handler", () => {
  const WEBHOOK_SECRET = "test-webhook-secret";

  function createMockDb() {
    return {
      query: {
        event: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        project: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        projectRepo: {
          findMany: vi.fn().mockResolvedValue([]),
          findFirst: vi.fn().mockResolvedValue(null),
        },
        projectConnection: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      },
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "evt_test123" }]),
          }),
        }),
      }),
    };
  }

  // Create a test app with mocked db and env
  function createTestApp(appStage = "prd") {
    const mockDb = createMockDb();
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("db" as never, mockDb as never);
      c.env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, APP_STAGE: appStage } as never;
      await next();
    });
    app.route("/", githubApp);

    return { app, mockDb };
  }

  async function makeWebhookRequest(params: {
    app: Hono;
    payload: Record<string, unknown>;
    event: string;
    deliveryId?: string;
    signature?: string | null;
  }) {
    const body = JSON.stringify(params.payload);
    const signature =
      params.signature === undefined
        ? await generateSignature(WEBHOOK_SECRET, body)
        : params.signature;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-github-event": params.event,
      "x-github-delivery": params.deliveryId ?? `delivery-${Date.now()}`,
    };
    if (signature !== null) headers["x-hub-signature-256"] = signature;
    return params.app.request("/webhook", {
      method: "POST",
      body,
      headers,
    });
  }

  async function expectWebhookMatch(res: Response, expected: Record<string, unknown>) {
    expect(await res.json()).toMatchObject(expected);
  }

  describe("signature verification", () => {
    it("rejects requests without signature", async () => {
      const { app } = createTestApp();
      const res = await makeWebhookRequest({
        app,
        payload: validWorkflowRunPayload,
        event: "workflow_run",
        signature: null,
      });

      expect(res.status).toBe(401);
      await expectWebhookMatch(res, { error: "Invalid signature" });
    });

    it("rejects requests with invalid signature", async () => {
      const { app } = createTestApp();
      const res = await makeWebhookRequest({
        app,
        payload: validWorkflowRunPayload,
        event: "workflow_run",
        signature: "sha256=invalid",
      });

      expect(res.status).toBe(401);
    });

    it("accepts requests with valid signature", async () => {
      const { app } = createTestApp();
      const res = await makeWebhookRequest({
        app,
        payload: validWorkflowRunPayload,
        event: "workflow_run",
        deliveryId: "delivery-123",
      });

      expect(res.status).toBe(200);
    });
  });

  describe("event filtering", () => {
    const cases = [
      {
        name: "filters out unrecognized event types",
        appStage: "prd",
        event: "push",
        payload: {},
        expected: { message: "No filter for event type push" },
      },
      {
        name: "acknowledges workflow_run events that don't match handlers",
        appStage: "prd",
        event: "workflow_run",
        payload: { ...validWorkflowRunPayload, action: "requested" },
        expected: { received: true },
      },
      {
        name: "acknowledges non-success conclusions",
        appStage: "prd",
        event: "workflow_run",
        payload: {
          ...validWorkflowRunPayload,
          workflow_run: { ...validWorkflowRunPayload.workflow_run, conclusion: "failure" },
        },
        expected: { received: true },
      },
      {
        name: "filters out non-main branches via JSONata",
        appStage: "prd",
        event: "workflow_run",
        payload: {
          ...validWorkflowRunPayload,
          workflow_run: { ...validWorkflowRunPayload.workflow_run, head_branch: "feature-branch" },
        },
        expected: { message: "Event filtered out" },
      },
      {
        name: "acknowledges non-ci.yml workflows",
        appStage: "prd",
        event: "workflow_run",
        payload: {
          ...validWorkflowRunPayload,
          workflow_run: {
            ...validWorkflowRunPayload.workflow_run,
            path: ".github/workflows/deploy.yml",
          },
        },
        expected: { received: true },
      },
      {
        name: "acknowledges non-iterate/iterate repos",
        appStage: "prd",
        event: "workflow_run",
        payload: {
          ...validWorkflowRunPayload,
          workflow_run: {
            ...validWorkflowRunPayload.workflow_run,
            repository: { full_name: "other/repo" },
          },
        },
        expected: { received: true },
      },
      {
        name: "accepts valid CI completion events in prd",
        appStage: "prd",
        event: "workflow_run",
        payload: validWorkflowRunPayload,
        expected: { received: true },
      },
      {
        name: "filters out workflow_run in non-prd environments",
        appStage: "dev",
        event: "workflow_run",
        payload: validWorkflowRunPayload,
        expected: { message: "Event filtered out" },
      },
      {
        name: "accepts PR-linked workflow_run in non-prd environments",
        appStage: "dev",
        event: "workflow_run",
        payload: {
          ...validWorkflowRunPayload,
          workflow_run: {
            ...validWorkflowRunPayload.workflow_run,
            pull_requests: [{ number: 123 }],
          },
        },
        expected: { received: true },
      },
    ] as const;

    it.each(cases)("$name", async ({ appStage, event, payload, expected }) => {
      const { app } = createTestApp(appStage);
      const res = await makeWebhookRequest({
        app,
        payload,
        event,
        deliveryId: "delivery-123",
      });
      await expectWebhookMatch(res, expected);
    });
  });

  describe("issue_comment filtering", () => {
    const issueCommentCases = [
      {
        name: "filters out issue comments on issues",
        payload: {
          action: "created",
          repository: { full_name: "iterate/iterate" },
          issue: {
            number: 12,
            title: "Issue title",
            body: "Issue body",
            html_url: "https://github.com/iterate/iterate/issues/12",
            user: { login: "alice" },
            pull_request: null,
          },
          comment: {
            id: 123,
            body: "Hello",
            user: { login: "alice" },
          },
        },
        expected: { message: "Event filtered out" },
      },
      {
        name: "accepts issue comments on pull requests",
        payload: {
          action: "created",
          repository: { full_name: "iterate/iterate" },
          issue: {
            number: 34,
            title: "PR title",
            body: "PR body",
            html_url: "https://github.com/iterate/iterate/pull/34",
            user: { login: "bob" },
            pull_request: { url: "https://api.github.com/repos/iterate/iterate/pulls/34" },
          },
          comment: {
            id: 456,
            body: "@iterate please check",
            user: { login: "bob" },
          },
        },
        expected: { received: true },
      },
    ] as const;

    it.each(issueCommentCases)("$name", async ({ payload, expected }) => {
      const { app } = createTestApp();
      const res = await makeWebhookRequest({ app, payload, event: "issue_comment" });
      await expectWebhookMatch(res, expected);
    });
  });

  describe("pull_request filtering", () => {
    const pullRequestCases = [
      {
        name: "filters out non-merged pull_request events",
        payload: {
          action: "closed",
          repository: { full_name: "iterate/iterate" },
          pull_request: {
            number: 34,
            title: "PR title",
            body: "PR body",
            html_url: "https://github.com/iterate/iterate/pull/34",
            user: { login: "bob" },
            merged: false,
          },
        },
        expected: { message: "Event filtered out" },
      },
      {
        name: "accepts merged pull_request events",
        payload: {
          action: "closed",
          repository: { full_name: "iterate/iterate" },
          pull_request: {
            number: 34,
            title: "PR title",
            body: "PR body",
            html_url: "https://github.com/iterate/iterate/pull/34",
            user: { login: "bob" },
            merged: true,
            merge_commit_sha: "abc123",
            merged_by: { login: "bob" },
          },
        },
        expected: { received: true },
      },
    ] as const;

    it.each(pullRequestCases)("$name", async ({ payload, expected }) => {
      const { app } = createTestApp();
      const res = await makeWebhookRequest({ app, payload, event: "pull_request" });
      await expectWebhookMatch(res, expected);
    });
  });

  describe("commit_comment filtering", () => {
    const validCommitCommentPayload = {
      action: "created",
      comment: {
        id: 12345,
        body: "Testing [refresh] [APP_STAGE=dev]",
        commit_id: "abc123def456",
        user: { login: "testuser" },
      },
      repository: { full_name: "iterate/iterate" },
    };

    const commitCommentCases = [
      {
        name: "accepts commit_comment with matching APP_STAGE tag",
        payload: validCommitCommentPayload,
        expected: { received: true },
      },
      {
        name: "filters out commit_comment without APP_STAGE tag",
        payload: {
          ...validCommitCommentPayload,
          comment: { ...validCommitCommentPayload.comment, body: "Testing [refresh]" },
        },
        expected: { message: "Event filtered out" },
      },
      {
        name: "filters out commit_comment with wrong APP_STAGE tag",
        payload: {
          ...validCommitCommentPayload,
          comment: {
            ...validCommitCommentPayload.comment,
            body: "Testing [refresh] [APP_STAGE=prd]",
          },
        },
        expected: { message: "Event filtered out" },
      },
    ] as const;

    it.each(commitCommentCases)("$name", async ({ payload, expected }) => {
      const { app } = createTestApp("dev");
      const res = await makeWebhookRequest({ app, payload, event: "commit_comment" });
      await expectWebhookMatch(res, expected);
    });
  });
});
