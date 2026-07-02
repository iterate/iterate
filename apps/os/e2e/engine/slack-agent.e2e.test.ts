// Slack agent end-to-end smoke (Phase 12): synthetic human webhook -> webhook
// route (signature-verified, ACK-200 semantics) -> slack router processor ->
// routed agent stream -> slack-agent transcription -> LLM -> codemode reply
// whose Slack Web API side effect goes out through the secret-substituting
// project egress (asserted via the bot-token secret's audit trail — we stop at
// the outbound attempt; the token is fake, slack.com rejects it).
//
// Needs a deployment with Slack integration config (the signing secret) and an
// admin API secret — both come from the Doppler config the suite runs under.
// Bot messages never trigger agents, so the synthetic webhook is a HUMAN
// message (see incident_agent_anchor_skips_first_input).

import { expect, test } from "vitest";
import type { StreamEvent } from "../../src/next/types.ts";
import { adminSecret, buildUrl, withItxSession } from "./test-helpers.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const SLACK_BOT_TOKEN_SECRET_PATH = "/secrets/integrations/slack/bot-token";
const SLACK_TEAM_DIRECTORY_STREAM_PATH = "/integrations/slack-team-directory";

function slackSigningSecret(): string | null {
  const raw = process.env.APP_CONFIG_INTEGRATIONS__SLACK;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { webhookSigningSecret?: string };
    return parsed.webhookSigningSecret?.trim() || null;
  } catch {
    return null;
  }
}

async function signedSlackWebhookRequest(body: string, signingSecret: string): Promise<Request> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)),
  );
  const signature = `v0=${Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return new Request(buildUrl({ path: "/api/integrations/slack/webhook" }), {
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
      "x-slack-event-id": `Ev${RUN_SUFFIX}`,
    },
    method: "POST",
  });
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  message: () => string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (predicate(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${message()}; last=${JSON.stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

const signingSecret = slackSigningSecret();

test.skipIf(signingSecret === null)(
  "inbound Slack webhook routes to a slack agent that attempts a Web API reply",
  { timeout: 240_000 },
  async () => {
    const teamId = `T0E2E${RUN_SUFFIX.toUpperCase()}`;
    const channel = "C0E2ESLACK";
    const threadTs = `${Math.floor(Date.now() / 1000)}.000100`;
    const agentStreamPath = `/agents/slack/${channel.toLowerCase()}/ts-${threadTs.replace(".", "-")}`;

    using session = withItxSession();
    using root = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = root.projects.create({ slug: `slack-agent-e2e-${RUN_SUFFIX}` });
    const { projectId } = await project.describe();

    // --- Seed a claimed workspace without OAuth: fake bot token secret +
    // global team directory claim (the storage the OAuth callback writes).
    using secret = project.secrets.get(SLACK_BOT_TOKEN_SECRET_PATH);
    await secret.update({
      egress: { urls: ["https://slack.com"] },
      material: `xoxb-e2e-fake-${RUN_SUFFIX}`,
    });
    await waitFor(
      () => secret.describe(),
      (description) => description.hasMaterial,
      () => "bot token secret material to fold",
    );
    using directory = root.streams.get(SLACK_TEAM_DIRECTORY_STREAM_PATH);
    await directory.append({
      type: "events.iterate.com/slack/team-claimed",
      idempotencyKey: `slack-team-claimed:${teamId}:${projectId}`,
      payload: { projectId, teamId, teamName: `e2e-${RUN_SUFFIX}` },
    });

    // --- An unclaimed team's validly-signed event must be ACKed 200 and
    // dropped (the auto-disable rule; see integration-api.ts).
    const unclaimedBody = JSON.stringify({
      type: "event_callback",
      team_id: "T0UNCLAIMED",
      event_id: `EvUnclaimed${RUN_SUFFIX}`,
      event: { type: "message", channel, user: "UHUMAN", text: "hi", ts: threadTs },
    });
    const unclaimedResponse = await fetch(
      await signedSlackWebhookRequest(unclaimedBody, signingSecret!),
    );
    expect(unclaimedResponse.status).toBe(200);
    expect(await unclaimedResponse.json()).toMatchObject({ ok: true, ignored: "team-not-claimed" });

    // --- A badly-signed request is the one deliberate non-2xx (trust boundary).
    const badSignature = await signedSlackWebhookRequest(unclaimedBody, "wrong-signing-secret");
    expect((await fetch(badSignature)).status).toBe(401);

    // --- The synthetic HUMAN message in the claimed workspace.
    const humanBody = JSON.stringify({
      type: "event_callback",
      team_id: teamId,
      event_id: `Ev${RUN_SUFFIX}`,
      authorizations: [{ is_bot: true, user_id: "UBOT", bot_id: "BBOT" }],
      event: {
        type: "message",
        channel,
        user: "UHUMAN",
        text: "Please reply in this thread with a short greeting.",
        ts: threadTs,
      },
    });
    const webhookResponse = await fetch(await signedSlackWebhookRequest(humanBody, signingSecret!));
    expect(webhookResponse.status).toBe(200);
    expect(await webhookResponse.json()).toMatchObject({ ok: true });

    // --- Router: the webhook lands on /integrations/slack and is forwarded to
    // the routed agent stream with its thread route fact.
    using integrationStream = project.streams.get("/integrations/slack");
    await waitFor(
      () => integrationStream.getEvents({ afterOffset: 0 }),
      (events) =>
        events.some((event) => event.type === "events.iterate.com/slack/webhook-received") &&
        events.some(
          (event) =>
            event.type === "events.iterate.com/slack/thread-route-configured" &&
            (event.payload as { streamPath?: string }).streamPath === agentStreamPath,
        ),
      () => "webhook + thread route on /integrations/slack",
    );

    using agentStream = project.streams.get(agentStreamPath);
    const hasEvent = (events: StreamEvent[], type: string) =>
      events.some((event) => event.type === type);

    // --- slack-agent: webhook transcribed into triggering agent input, and the
    // agent processor schedules + requests LLM work for it.
    await waitFor(
      () => agentStream.getEvents({ afterOffset: 0 }),
      (events) =>
        hasEvent(events, "events.iterate.com/slack/webhook-received") &&
        hasEvent(events, "events.iterate.com/agent/input-added") &&
        hasEvent(events, "events.iterate.com/agent/llm-request-requested"),
      () => `agent input + llm request on ${agentStreamPath}`,
      120_000,
    );

    // --- LLM reply: codemode script execution requested on the agent stream.
    // The Slack prompt tells the model to reply via itx.slack.chat.postMessage.
    const withScript = await waitFor(
      () => agentStream.getEvents({ afterOffset: 0 }),
      (events) => hasEvent(events, "events.iterate.com/itx/script-execution-requested"),
      () => `itx script execution on ${agentStreamPath}`,
      120_000,
    );
    const scripts = withScript.filter(
      (event) => event.type === "events.iterate.com/itx/script-execution-requested",
    );
    expect(
      scripts.some((event) => ((event.payload as { code?: string }).code ?? "").includes("slack")),
    ).toBe(true);

    // --- Outbound attempt: the Web API side effects (router eyes-ack and/or
    // the reply's chat.postMessage) traversed project egress and substituted
    // the bot token secret — its audit trail records the slack.com attempt.
    // We assert up to this outbound attempt; the fake token cannot go further.
    await waitFor(
      () => secret.describe(),
      (description) =>
        description.audit.usedCount >= 1 &&
        (description.audit.lastUsedUrl ?? "").startsWith("https://slack.com/api/"),
      () => "bot token secret outbound usage audit",
      120_000,
    );
  },
);
