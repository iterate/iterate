// The generic webhook door (integration-webhook-api.ts). Signature verification
// is real (WebCrypto HMAC); only the routing primitive is mocked, so these
// tests pin the door's contract: the ACK-and-drop policy (bad signature → 401,
// unconfigured → 503, everything else validly-signed → 200) and that a claimed
// event routes with the right (slug, externalId) + provider-shaped payload.

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseConfig } from "~/config.ts";

const routeIntegrationWebhook = vi.hoisted(() => vi.fn());
vi.mock("./integration-streams.ts", () => ({ routeIntegrationWebhook }));

const { handleIntegrationWebhookApiRequest } = await import("./integration-webhook-api.ts");

const GITHUB_WEBHOOK_SECRET = "gh-webhook-secret";
const SLACK_SIGNING_SECRET = "slack-signing-secret";

function config() {
  return parseConfig({
    APP_CONFIG: JSON.stringify({
      baseUrl: "https://os.example.test",
      integrations: {
        github: {
          appSlug: "iterate-test",
          oauthClientId: "gh-client",
          oauthClientSecret: "gh-client-secret",
          webhookSecret: GITHUB_WEBHOOK_SECRET,
        },
        slack: {
          oauthClientId: "slack-client",
          oauthClientSecret: "slack-client-secret",
          webhookSigningSecret: SLACK_SIGNING_SECRET,
        },
      },
      openAiApiKey: "openai-test-key",
    }),
  });
}

function githubRequest(body: string, signature?: string) {
  const sig =
    signature ?? `sha256=${createHmac("sha256", GITHUB_WEBHOOK_SECRET).update(body).digest("hex")}`;
  return new Request("https://os.example.test/api/integrations/github/webhook", {
    body,
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "delivery-1",
      "x-github-event": "push",
      "x-hub-signature-256": sig,
    },
    method: "POST",
  });
}

describe("handleIntegrationWebhookApiRequest (github)", () => {
  afterEach(() => routeIntegrationWebhook.mockReset());

  test("valid signature + claimed installation → routes on (github, installation_id) and 200", async () => {
    routeIntegrationWebhook.mockResolvedValue({
      connection: "install-42",
      ok: true,
      projectId: "prj_1",
    });
    const body = JSON.stringify({ action: "opened", installation: { id: 42 } });
    const response = await handleIntegrationWebhookApiRequest({
      config: config(),
      request: githubRequest(body),
    });

    expect(response?.status).toBe(200);
    expect(routeIntegrationWebhook).toHaveBeenCalledTimes(1);
    const call = routeIntegrationWebhook.mock.calls[0]![0];
    expect(call.slug).toBe("github");
    expect(call.externalId).toBe("42");
    expect(call.event.type).toBe("events.iterate.com/github/webhook-received");
    expect(call.event.idempotencyKey).toBe("github-webhook:delivery-1");
    expect(call.event.payload).toMatchObject({ appSlug: "iterate-test", installationId: "42" });
  });

  test("bad signature → 401, never routes (the trust boundary)", async () => {
    const body = JSON.stringify({ installation: { id: 42 } });
    const response = await handleIntegrationWebhookApiRequest({
      config: config(),
      request: githubRequest(body, "sha256=deadbeef"),
    });
    expect(response?.status).toBe(401);
    expect(routeIntegrationWebhook).not.toHaveBeenCalled();
  });

  test("no webhook secret configured → 503", async () => {
    const bare = parseConfig({
      APP_CONFIG: JSON.stringify({
        integrations: { github: { oauthClientId: "x", oauthClientSecret: "y" } },
        openAiApiKey: "k",
      }),
    });
    const body = JSON.stringify({ installation: { id: 42 } });
    const response = await handleIntegrationWebhookApiRequest({
      config: bare,
      request: githubRequest(body),
    });
    expect(response?.status).toBe(503);
  });

  test("valid signature but no installation → 200 ACK-drop, never routes", async () => {
    const body = JSON.stringify({ zen: "ping without an installation" });
    const response = await handleIntegrationWebhookApiRequest({
      config: config(),
      request: githubRequest(body),
    });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ ignored: "no-installation" });
    expect(routeIntegrationWebhook).not.toHaveBeenCalled();
  });

  test("valid signature, unclaimed installation → 200 ACK-drop (distributed-app rule)", async () => {
    routeIntegrationWebhook.mockResolvedValue({ ignored: "external-id-not-claimed", ok: true });
    const body = JSON.stringify({ installation: { id: 999 } });
    const response = await handleIntegrationWebhookApiRequest({
      config: config(),
      request: githubRequest(body),
    });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ ignored: "external-id-not-claimed" });
  });
});

describe("handleIntegrationWebhookApiRequest (slack + routing)", () => {
  afterEach(() => routeIntegrationWebhook.mockReset());

  function slackRequest(body: string) {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac("sha256", SLACK_SIGNING_SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
    return new Request("https://os.example.test/api/integrations/slack/webhook", {
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sig,
      },
      method: "POST",
    });
  }

  test("url_verification handshake echoes the challenge, never routes", async () => {
    const body = JSON.stringify({ challenge: "abc123", type: "url_verification" });
    const response = await handleIntegrationWebhookApiRequest({
      config: config(),
      request: slackRequest(body),
    });
    expect(await response?.json()).toEqual({ challenge: "abc123" });
    expect(routeIntegrationWebhook).not.toHaveBeenCalled();
  });

  test("claimed team routes on (slack, team_id) with the exact agent-facing shape", async () => {
    routeIntegrationWebhook.mockResolvedValue({ connection: "acme", ok: true, projectId: "prj_1" });
    const body = JSON.stringify({ event_id: "Ev1", team_id: "T42", event: { type: "message" } });
    const response = await handleIntegrationWebhookApiRequest({
      config: config(),
      request: slackRequest(body),
    });

    expect(response?.status).toBe(200);
    const call = routeIntegrationWebhook.mock.calls[0]![0];
    expect(call.slug).toBe("slack");
    expect(call.externalId).toBe("T42");
    expect(call.event.type).toBe("events.iterate.com/slack/webhook-received");
    expect(call.event.idempotencyKey).toBe("slack-webhook:Ev1");
    expect(call.event.payload).toMatchObject({ slackTeamId: "T42" });
  });

  test("non-webhook path → null (not mine)", async () => {
    const response = await handleIntegrationWebhookApiRequest({
      config: config(),
      request: new Request("https://os.example.test/api/something-else"),
    });
    expect(response).toBeNull();
  });
});
