import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { githubWebhookApp } from "./webhook.ts";

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

  // Create a test app with mocked db and env
  function createTestApp() {
    const mockDb = {
      query: {
        event: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        project: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      }),
    };

    const mockEnv = {
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    };

    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("db" as never, mockDb as never);
      c.env = mockEnv as never;
      await next();
    });
    app.route("/", githubWebhookApp);

    return { app, mockDb };
  }

  describe("signature verification", () => {
    it("rejects requests without signature", async () => {
      const { app } = createTestApp();
      const body = JSON.stringify(validWorkflowRunPayload);

      const res = await app.request("/", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-github-event": "workflow_run",
        },
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "Invalid signature" });
    });

    it("rejects requests with invalid signature", async () => {
      const { app } = createTestApp();
      const body = JSON.stringify(validWorkflowRunPayload);

      const res = await app.request("/", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-github-event": "workflow_run",
          "x-hub-signature-256": "sha256=invalid",
        },
      });

      expect(res.status).toBe(401);
    });

    it("accepts requests with valid signature", async () => {
      const { app } = createTestApp();
      const body = JSON.stringify(validWorkflowRunPayload);
      const signature = await generateSignature(WEBHOOK_SECRET, body);

      const res = await app.request("/", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-github-event": "workflow_run",
          "x-hub-signature-256": signature,
          "x-github-delivery": "delivery-123",
        },
      });

      expect(res.status).toBe(200);
    });
  });

  describe("event filtering", () => {
    async function makeRequest(
      app: Hono,
      payload: Record<string, unknown>,
      event = "workflow_run",
    ) {
      const body = JSON.stringify(payload);
      const signature = await generateSignature(WEBHOOK_SECRET, body);

      return app.request("/", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-hub-signature-256": signature,
          "x-github-delivery": "delivery-123",
        },
      });
    }

    it("ignores non-workflow_run events", async () => {
      const { app } = createTestApp();
      const res = await makeRequest(app, {}, "push");
      const json = await res.json();
      expect(json).toMatchObject({ ignored: true, reason: "not workflow_run" });
    });

    it("ignores non-completed actions", async () => {
      const { app } = createTestApp();
      const payload = { ...validWorkflowRunPayload, action: "requested" };
      const res = await makeRequest(app, payload);
      const json = await res.json();
      expect(json).toMatchObject({ ignored: true, reason: "not completed" });
    });

    it("ignores non-success conclusions", async () => {
      const { app } = createTestApp();
      const payload = {
        ...validWorkflowRunPayload,
        workflow_run: { ...validWorkflowRunPayload.workflow_run, conclusion: "failure" },
      };
      const res = await makeRequest(app, payload);
      const json = await res.json();
      expect(json).toMatchObject({ ignored: true, reason: "not success" });
    });

    it("ignores non-main branches", async () => {
      const { app } = createTestApp();
      const payload = {
        ...validWorkflowRunPayload,
        workflow_run: { ...validWorkflowRunPayload.workflow_run, head_branch: "feature-branch" },
      };
      const res = await makeRequest(app, payload);
      const json = await res.json();
      expect(json).toMatchObject({ ignored: true, reason: "not main branch" });
    });

    it("ignores non-ci.yml workflows", async () => {
      const { app } = createTestApp();
      const payload = {
        ...validWorkflowRunPayload,
        workflow_run: {
          ...validWorkflowRunPayload.workflow_run,
          path: ".github/workflows/deploy.yml",
        },
      };
      const res = await makeRequest(app, payload);
      const json = await res.json();
      expect(json).toMatchObject({ ignored: true, reason: "not ci.yml" });
    });

    it("ignores non-iterate/iterate repos", async () => {
      const { app } = createTestApp();
      const payload = {
        ...validWorkflowRunPayload,
        workflow_run: {
          ...validWorkflowRunPayload.workflow_run,
          repository: { full_name: "other/repo" },
        },
      };
      const res = await makeRequest(app, payload);
      const json = await res.json();
      expect(json).toMatchObject({ ignored: true, reason: "not iterate/iterate" });
    });

    it("accepts valid CI completion events", async () => {
      const { app } = createTestApp();
      const res = await makeRequest(app, validWorkflowRunPayload);
      const json = await res.json();
      expect(json).toMatchObject({ received: true, workflowRunId: "12345" });
    });
  });
});
