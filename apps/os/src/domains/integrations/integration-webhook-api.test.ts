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

/** The github config without a webhook secret (the 503 lane). */
function bareConfig() {
  return parseConfig({
    APP_CONFIG: JSON.stringify({
      integrations: { github: { oauthClientId: "x", oauthClientSecret: "y" } },
      openAiApiKey: "k",
    }),
  });
}

function githubRequest(
  body: string,
  signature?: string,
  eventName: string | null = "push",
  delivery: string | null = "delivery-1",
) {
  const sig =
    signature ?? `sha256=${createHmac("sha256", GITHUB_WEBHOOK_SECRET).update(body).digest("hex")}`;
  const headers = new Headers({
    "content-type": "application/json",
    "x-hub-signature-256": sig,
  });
  if (delivery !== null) headers.set("x-github-delivery", delivery);
  if (eventName !== null) headers.set("x-github-event", eventName);
  return new Request("https://os.example.test/api/integrations/github/webhook", {
    body,
    headers,
    method: "POST",
  });
}

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

describe("handleIntegrationWebhookApiRequest (github)", () => {
  afterEach(() => routeIntegrationWebhook.mockReset());

  test.for([
    {
      name: "valid signature + claimed installation → routes on (github, installation_id) and 200",
      body: JSON.stringify({
        action: "opened",
        installation: { id: 42 },
        pull_request: { number: 7 },
        repository: { full_name: "acme/widgets", id: 101, node_id: "R_101" },
        sender: { id: 44, login: "jonas", node_id: "U_44", type: "User" },
      }),
      eventName: "pull_request",
      mockRoute: { connection: "install-42", ok: true, projectId: "prj_1" },
      expectedStatus: 200,
      expectedJson: { ok: true },
      expectedCall: {
        slug: "github",
        externalId: "42",
        event: {
          type: "events.iterate.com/github/webhook-received",
          idempotencyKey: "github-webhook:delivery-1",
          payload: {
            appSlug: "iterate-test",
            associations: {
              actor: { id: 44, login: "jonas", nodeId: "U_44", type: "User" },
              mentionedUsers: [],
              problems: [],
              pullRequests: [{ basis: "subject", number: 7, repositoryId: 101 }],
              repository: { fullName: "acme/widgets", id: 101, nodeId: "R_101" },
            },
            delivery: { action: "opened", id: "delivery-1", name: "pull_request" },
            installationId: "42",
          },
        },
      },
    },
    {
      name: "bad signature → 401, never routes (the trust boundary)",
      body: JSON.stringify({ installation: { id: 42 } }),
      signature: "sha256=deadbeef",
      expectedStatus: 401,
      expectedJson: { error: "Invalid GitHub signature." },
    },
    {
      name: "valid signature without a delivery ID → explicit 400",
      body: JSON.stringify({ installation: { id: 42 } }),
      delivery: null,
      expectedStatus: 400,
      expectedJson: { error: "Missing required GitHub webhook delivery headers." },
    },
    {
      name: "valid signature without an event name → explicit 400",
      body: JSON.stringify({ installation: { id: 42 } }),
      eventName: null,
      expectedStatus: 400,
      expectedJson: { error: "Missing required GitHub webhook delivery headers." },
    },
    {
      name: "no webhook secret configured → 503",
      bare: true,
      body: JSON.stringify({ installation: { id: 42 } }),
      expectedStatus: 503,
      expectedJson: { error: "GitHub integration is not configured." },
    },
    {
      name: "valid signature but no installation → 200 ACK-drop, never routes",
      body: JSON.stringify({ zen: "ping without an installation" }),
      expectedStatus: 200,
      expectedJson: { ignored: "no-installation", ok: true },
    },
    {
      name: "valid signature, unclaimed installation → 200 ACK-drop (distributed-app rule)",
      body: JSON.stringify({ installation: { id: 999 } }),
      mockRoute: { ignored: "external-id-not-claimed", ok: true },
      expectedStatus: 200,
      expectedJson: { ignored: "external-id-not-claimed", ok: true },
      expectedCall: { slug: "github", externalId: "999" },
    },
  ])(
    "$name",
    async ({
      bare,
      body,
      delivery,
      eventName,
      expectedCall,
      expectedJson,
      expectedStatus,
      mockRoute,
      signature,
    }) => {
      if (mockRoute !== undefined) routeIntegrationWebhook.mockResolvedValue(mockRoute);

      const response = await handleIntegrationWebhookApiRequest({
        config: bare === true ? bareConfig() : config(),
        request: githubRequest(body, signature, eventName, delivery),
      });

      expect(response?.status).toBe(expectedStatus);
      expect(await response?.json()).toEqual(expectedJson);
      if (expectedCall === undefined) {
        expect(routeIntegrationWebhook).not.toHaveBeenCalled();
      } else {
        expect(routeIntegrationWebhook).toHaveBeenCalledTimes(1);
        expect(routeIntegrationWebhook.mock.calls[0]![0]).toMatchObject(expectedCall);
        if ("event" in expectedCall) {
          expect(routeIntegrationWebhook.mock.calls[0]![0].event.payload.body).toEqual(
            JSON.parse(body),
          );
        }
      }
    },
  );
});

describe("handleIntegrationWebhookApiRequest (slack + routing)", () => {
  afterEach(() => routeIntegrationWebhook.mockReset());

  test.for([
    {
      name: "url_verification handshake echoes the challenge, never routes",
      body: JSON.stringify({ challenge: "abc123", type: "url_verification" }),
      expectedJson: { challenge: "abc123" },
    },
    {
      name: "claimed team routes on (slack, team_id) with the exact agent-facing shape",
      body: JSON.stringify({ event_id: "Ev1", team_id: "T42", event: { type: "message" } }),
      mockRoute: { connection: "acme", ok: true, projectId: "prj_1" },
      expectedStatus: 200,
      expectedJson: { ok: true },
      expectedCall: {
        slug: "slack",
        externalId: "T42",
        event: {
          type: "events.iterate.com/slack/webhook-received",
          idempotencyKey: "slack-webhook:Ev1",
          payload: { slackTeamId: "T42" },
        },
      },
    },
  ])("$name", async ({ body, expectedCall, expectedJson, expectedStatus, mockRoute }) => {
    if (mockRoute !== undefined) routeIntegrationWebhook.mockResolvedValue(mockRoute);

    const response = await handleIntegrationWebhookApiRequest({
      config: config(),
      request: slackRequest(body),
    });

    if (expectedStatus !== undefined) expect(response?.status).toBe(expectedStatus);
    expect(await response?.json()).toEqual(expectedJson);
    if (expectedCall === undefined) {
      expect(routeIntegrationWebhook).not.toHaveBeenCalled();
    } else {
      expect(routeIntegrationWebhook.mock.calls[0]![0]).toMatchObject(expectedCall);
    }
  });

  test("non-webhook path → null (not mine)", async () => {
    const response = await handleIntegrationWebhookApiRequest({
      config: config(),
      request: new Request("https://os.example.test/api/something-else"),
    });
    expect(response).toBeNull();
  });
});
