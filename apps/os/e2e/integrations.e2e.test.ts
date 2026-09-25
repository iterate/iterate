// integrations.e2e.test.ts — Slack, Google and GitHub on a deployed worker, against the deployed pet
// shop's fakes, which a preview names as iterate's apps (scripts/preview-*-app.ts). Each row connects
// through the project facet, follows the provider's redirect to the platform's callback as a project
// member, which finishes the connection, then calls the provider with its real SDK through egress
// (the token substituted in its secret's facet), receives a signed webhook and disconnects.
// Deployed only: the shop fires the webhooks, and it cannot reach a local worker.
import { createPublicKey } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { RpcTarget } from "capnweb";
import { WebClient } from "@slack/web-api";
import { expect } from "vitest";
import { PREVIEW_GITHUB_APP, previewGithubAppPrivateKey } from "../scripts/preview-github-app.ts";
import { PREVIEW_SLACK_APP } from "../scripts/preview-slack-app.ts";
import { readAll, until, workerUrl } from "./support/client.ts";
import { SOURCES } from "./support/sources.ts";
import {
  connectThroughProvider,
  integrationRows,
  projectWithMember,
} from "./support/integrations.ts";
import {
  petshopBaseUrl,
  petshopGithubCheckRuns,
  petshopGithubFireWebhook,
  petshopGithubSeedPull,
  petshopMintClient,
  petshopRegisterGithubInstallation,
  petshopSlackFireWebhook,
  petshopSlackMessages,
} from "./support/petshop.ts";
import { deployedOnly } from "./support/project-host.ts";

deployedOnly(
  "Slack through iterate's app: connected by the callback, WebClient through egress, a signed webhook onto the connection's log once, disconnect",
  async ({ skip }) => {
    const { itx, memberBearer } = await projectWithMember("slack-iterate");
    const teamId = fresh("T");
    const connected = await connectThroughProvider(
      itx,
      { provider: "slack", connection: "acme", client: "iterate" },
      { team: teamId, approve: "1" },
      memberBearer,
    );
    if (!connected) return skip("this deployment's Slack app is not the pet shop's fake");
    expect(await integrationRows(itx)).toMatchObject({
      "/integrations/slack/acme": { provider: "slack", client: "iterate", externalId: teamId },
    });
    await expectSlackWebClient(itx, "/secrets/slack-acme", teamId);
    await expectSlackWebhook(itx, {
      url: workerUrl("/api/integrations/slack/webhook"),
      signingSecret: PREVIEW_SLACK_APP.webhookSigningSecret,
      teamId,
      connection: "acme",
    });
    await itx.facets
      .get("project")
      .disconnectIntegration({ provider: "slack", connection: "acme" });
    expect(await integrationRows(itx)).toEqual({});
  },
);

deployedOnly(
  "Slack through the project's own app: its credentials in the connection's secret, its per-connection webhook URL",
  async () => {
    const { itx, memberBearer, projectId } = await projectWithMember("slack-own");
    const { clientId, clientSecret } = await petshopMintClient();
    const signingSecret = crypto.randomUUID();
    await itx.secrets.set(
      "/secrets/slack-own",
      { clientId, clientSecret, signingSecret },
      { urls: [petshopBaseUrl()] },
    );
    const teamId = fresh("T");
    await connectThroughProvider(
      itx,
      { provider: "slack", connection: "own", client: "project" },
      { team: teamId, approve: "1" },
      memberBearer,
    );
    expect(await integrationRows(itx)).toMatchObject({
      "/integrations/slack/own": { client: "project", externalId: teamId },
    });
    await expectSlackWebhook(itx, {
      url: workerUrl(`/api/integrations/slack/webhook/${projectId}/own`),
      signingSecret,
      teamId,
      connection: "own",
    });
  },
);

deployedOnly(
  "Google through iterate's client: connected by the callback, Gmail through egress, disconnect",
  async ({ skip }) => {
    const { itx, memberBearer } = await projectWithMember("google-iterate");
    const email = `${fresh("u")}@example.com`;
    const connected = await connectThroughProvider(
      itx,
      { provider: "google", connection: "me", client: "iterate" },
      { email },
      memberBearer,
    );
    if (!connected) return skip("this deployment's Google client is not the pet shop's fake");
    expect(await integrationRows(itx)).toMatchObject({
      "/integrations/google/me": { provider: "google", client: "iterate", account: email },
    });
    const profile = await itx.fetch(
      new Request(`${petshopBaseUrl()}/gmail/v1/users/me/profile`, {
        headers: {
          authorization: 'Bearer getSecret("/secrets/google-me", { field: "accessToken" })',
        },
      }),
    );
    expect(await profile.json()).toMatchObject({ emailAddress: email });
    await itx.facets.get("project").disconnectIntegration({ provider: "google", connection: "me" });
    expect(await integrationRows(itx)).toEqual({});
  },
);

deployedOnly(
  "GitHub through iterate's App: one install redirect connects an installation the member administers, Octokit through egress, a signed webhook once, disconnect",
  async ({ skip }) => {
    const { itx, installation } = await githubConnected("github-iterate");
    if (!installation) return skip("this deployment's GitHub App is not the pet shop's fake");
    expect(await integrationRows(itx)).toMatchObject({
      "/integrations/github/acme": {
        provider: "github",
        account: installation.accountLogin,
        externalId: installation.installationId,
      },
    });
    // the real Octokit, unmodified: its auth is the placeholder and its transport `itx.fetch`
    const octokit = new Octokit({
      auth: 'getSecret("/secrets/github-acme", { field: "accessToken" })',
      baseUrl: petshopBaseUrl(),
      request: { fetch: (url: string, init: RequestInit) => itx.fetch(new Request(url, init)) },
    });
    const { data } = await octokit.rest.apps.listReposAccessibleToInstallation();
    expect(data).toMatchObject({
      repositories: [{ full_name: `${installation.accountLogin}/pets` }],
    });
    const event = {
      ref: "refs/heads/main",
      installation: { id: Number(installation.installationId) },
    };
    const deliveryId = crypto.randomUUID();
    const url = workerUrl("/api/integrations/github/webhook");
    for (const delivery of [1, 2])
      expect(
        await petshopGithubFireWebhook({
          installationId: installation.installationId,
          url,
          event,
          deliveryId,
          eventName: "push",
        }),
        `delivery ${delivery}`,
      ).toMatchObject({ status: 200, body: { ok: true } });
    expect(await webhooksOn(itx, "/integrations/github/acme", "github")).toMatchObject([
      { idempotencyKey: `github-webhook:${deliveryId}`, source: { platform: true } },
    ]);
    await itx.facets
      .get("project")
      .disconnectIntegration({ provider: "github", connection: "acme" });
    expect(await integrationRows(itx)).toEqual({});
  },
);

deployedOnly(
  "the project's own AI linter, a processor on the GitHub connection's log: one Check Run per pull request commit, through the connection's token and a shadowed itx.ai, none for a pull request from before it was installed, none twice",
  async ({ skip }) => {
    const { itx, installation } = await githubConnected("github-linter");
    if (!installation) return skip("this deployment's GitHub App is not the pet shop's fake");
    const connection = itx.cd("/integrations/github/acme");
    const pullRequest = async (number: number, headSha: string, deliveryId: string) => {
      await petshopGithubSeedPull({
        installationId: installation.installationId,
        owner: installation.accountLogin,
        repo: "pets",
        number,
        headSha,
        files: [
          { filename: "pets.ts", status: "modified", patch: `@@ -1 +1 @@\n-cat\n+dog ${number}` },
        ],
      });
      const fired = await petshopGithubFireWebhook({
        installationId: installation.installationId,
        url: workerUrl("/api/integrations/github/webhook"),
        deliveryId,
        eventName: "pull_request",
        event: {
          action: "opened",
          installation: { id: Number(installation.installationId) },
          repository: {
            name: "pets",
            full_name: `${installation.accountLogin}/pets`,
            owner: { login: installation.accountLogin },
            url: `${petshopBaseUrl()}/repos/${installation.accountLogin}/pets`,
          },
          pull_request: { number, draft: false, state: "open", head: { sha: headSha } },
        },
      });
      expect(fired, `pull request ${number}`).toMatchObject({ status: 200, body: { ok: true } });
    };
    // before the linter: a pull request it must never lint
    await pullRequest(1, fresh("sha"), crypto.randomUUID());
    // the linter's reach from the connection's log, which only a project's root has by default:
    // the internet through the root's egress (its secrets), and a model — here, a shadow
    await connection.append({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.fetch", target: "itx.builtins.cd('/').fetch" },
    });
    const ai = new VerdictAi({ conclusion: "neutral", summary: "1 finding" });
    await connection.provide("itx.ai", ai);
    await connection.processors.enable("pr-linter", {
      source: SOURCES.prLinter,
      className: "PrLinterDurableObject",
      consumes: ["events.iterate.com/github/webhook-received", "pr-linter-installed"],
    });
    await connection.append({ type: "pr-linter-installed", payload: {} });
    const sha = fresh("sha");
    const deliveryId = crypto.randomUUID();
    await pullRequest(2, sha, deliveryId);
    await pullRequest(2, sha, deliveryId); // a redelivery: the same event, stored once
    await pullRequest(2, sha, crypto.randomUUID()); // another delivery of the same commit
    const linted = await until("the linter's Check Run", async () => {
      const { check_runs } = await petshopGithubCheckRuns(installation.installationId);
      return check_runs.length > 0 && check_runs;
    });
    expect(linted).toMatchObject([
      {
        head_sha: sha,
        name: "Iterate GitHub AI linter",
        conclusion: "neutral",
        external_id: `pr-linter:${installation.accountLogin}/pets#2@${sha}`,
        output: { summary: "1 finding" },
      },
    ]);
    expect(JSON.stringify(ai.calls[0])).toContain("+dog 2");
    // every delivery processed, and still one run: none twice, none for the pull request before
    const [lastWebhook] = (await webhooksOn(itx, "/integrations/github/acme", "github")).slice(-1);
    await until(
      "the linter past the last delivery",
      async () =>
        (await connection.facets.get("pr-linter").snapshot()).offset >= lastWebhook.offset,
    );
    expect((await petshopGithubCheckRuns(installation.installationId)).check_runs).toHaveLength(1);
    expect(ai.calls).toHaveLength(1);
  },
);

/** A project connected to a fresh installation of iterate's App (`acme`), which a fresh admin
 *  administers — or no installation when the deployment's App is not the pet shop's fake. */
async function githubConnected(prefix: string) {
  const { itx, memberBearer } = await projectWithMember(prefix);
  const installation = {
    installationId: String(Math.floor(1e9 + Math.random() * 8e9)),
    accountLogin: fresh("org-"),
    adminLogin: fresh("user-"),
  };
  await petshopRegisterGithubInstallation({
    ...installation,
    appId: PREVIEW_GITHUB_APP.appId,
    appSlug: PREVIEW_GITHUB_APP.appSlug,
    // the public half of the preview's throwaway key (Doppler os/preview), what the shop verifies
    publicKeyPem: createPublicKey(previewGithubAppPrivateKey())
      .export({ type: "spki", format: "pem" })
      .toString(),
    webhookSecret: PREVIEW_GITHUB_APP.webhookSecret,
    callbackUrl: workerUrl("/api/integrations/github/callback"),
  });
  const connected = await connectThroughProvider(
    itx,
    { provider: "github", connection: "acme", client: "iterate" },
    { installation_id: installation.installationId, login: installation.adminLogin },
    memberBearer,
  );
  return { itx, installation: connected ? installation : null };
}

/** `itx.ai` shadowed for the linter: Workers AI's answer shape, the verdict as its text; each call
 *  recorded. */
class VerdictAi extends RpcTarget {
  readonly calls: { model: string; input: unknown }[] = [];
  readonly #verdict: object;
  constructor(verdict: object) {
    super();
    this.#verdict = verdict;
  }
  run(model: string, input: unknown) {
    this.calls.push({ model, input });
    return { response: JSON.stringify(this.#verdict) };
  }
}

/** The real Slack SDK, unmodified but for its transport: its token is the placeholder and its
 *  requests go through `itx.fetch`, so egress substitutes the bot token; the shop records the post. */
async function expectSlackWebClient(itx: any, tokenSecretPath: string, teamId: string) {
  const slack = new WebClient(`getSecret("${tokenSecretPath}", { field: "accessToken" })`, {
    slackApiUrl: `${petshopBaseUrl()}/api/`,
    adapter: async (config: any) => {
      const response: Response = await itx.fetch(
        new Request(new URL(config.url, config.baseURL), {
          method: config.method.toUpperCase(),
          headers: config.headers.toJSON(),
          body: config.data,
        }),
      );
      return {
        data: await response.json(),
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        config,
        request: {},
      };
    },
  });
  const text = `hello ${fresh("")}`;
  expect(await slack.chat.postMessage({ channel: "C0GENERAL", text })).toMatchObject({ ok: true });
  expect(await petshopSlackMessages(teamId)).toMatchObject({
    messages: [{ channel: "C0GENERAL", text }],
  });
}

/** A Slack-signed event lands on the connection's log once (a redelivery lands nothing new), and a
 *  bad signature is a 401. */
async function expectSlackWebhook(
  itx: any,
  route: { url: string; signingSecret: string; teamId: string; connection: string },
) {
  const event = {
    type: "event_callback",
    team_id: route.teamId,
    event_id: fresh("Ev"),
    event: { type: "message", text: "hi" },
  };
  for (const delivery of [1, 2])
    expect(
      await petshopSlackFireWebhook({ url: route.url, signingSecret: route.signingSecret, event }),
      `delivery ${delivery}`,
    ).toMatchObject({ status: 200, body: { ok: true } });
  expect(
    await petshopSlackFireWebhook({
      url: route.url,
      signingSecret: route.signingSecret,
      event,
      badSignature: true,
    }),
  ).toMatchObject({ status: 401 });
  expect(await webhooksOn(itx, `/integrations/slack/${route.connection}`, "slack")).toMatchObject([
    {
      idempotencyKey: `slack-webhook:${event.event_id}`,
      source: { platform: true },
      payload: { body: event, teamId: route.teamId },
    },
  ]);
}

async function webhooksOn(itx: any, path: string, provider: string) {
  return (await readAll(itx.cd(path))).filter(
    (event: any) => event.type === `events.iterate.com/${provider}/webhook-received`,
  );
}

const fresh = (prefix: string) =>
  `${prefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
