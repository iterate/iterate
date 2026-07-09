// GitHub-backed repos, the CI-provable half: webhook events arriving on a
// GitHub connection stream cross-post onto the linked repo's own stream
// through the exact push subscription `repo.linkGithub` installs (same
// subscriptionKey, same JSONata condition on repository.full_name, same
// ingest-targeting delivery expression). The GitHub-touching half (mirror
// push, create-on-link, syncFromGithub) authenticates against real GitHub and
// is proven by production smoke, not here.

import { expect, test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE = "events.iterate.com/github/webhook-received";

test("github webhooks about a linked repository cross-post onto the repo stream", async () => {
  const marker = crypto.randomUUID();
  const repoPath = `/repos/e2e-github-${marker}`;
  const connectionPath = `/integrations/github/e2e-conn-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `os-github-repo-${RUN_SUFFIX}-${marker}` });

  // A real repo, so the repo processor is live on the target stream and must
  // coexist with (ignore) the cross-posted webhook events.
  using repo = project.repos.get(repoPath);
  await repo.create();

  using connectionStream = project.streams.get(connectionPath);
  using repoStream = project.streams.get(repoPath);

  // The push subscription linkGithub installs, verbatim (see
  // githubCrossPostSubscriptionEvent in src/domains/repos/github-link.ts).
  await connectionStream.append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      subscriptionKey: `github-repo:${repoPath}`,
      selector: {
        eventTypes: [GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE],
        condition: 'payload.body.repository.full_name = "acme/widgets"',
      },
      delivery: {
        mode: "push",
        expression: ["streams", ["get", repoPath], "ingest"],
      },
      deliver: "new",
    },
  });

  const arrived = repoStream.waitForEvent({
    afterOffset: 0,
    eventTypes: [GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE],
    timeoutMs: 15_000,
  });

  // Two webhook deliveries on the connection stream — the installation-wide
  // firehose — of which only one is about the linked repository.
  await connectionStream.append(
    {
      type: GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE,
      idempotencyKey: `github-webhook:${marker}-other`,
      payload: {
        body: { action: "opened", repository: { full_name: "acme/other" } },
        headers: { githubDelivery: `${marker}-other`, githubEvent: "issues" },
        installationId: "789",
      },
    },
    {
      type: GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE,
      idempotencyKey: `github-webhook:${marker}-widgets`,
      payload: {
        body: { action: "opened", repository: { full_name: "acme/widgets" } },
        headers: { githubDelivery: `${marker}-widgets`, githubEvent: "issues" },
        installationId: "789",
      },
    },
  );

  const copied = await arrived;
  expect(copied.payload).toMatchObject({
    body: { repository: { full_name: "acme/widgets" } },
  });
  expect(copied.source?.crossPostedFrom).toHaveLength(1);
  expect(copied.source?.crossPostedFrom?.[0]).toMatchObject({
    path: connectionPath,
    subscriptionKey: `github-repo:${repoPath}`,
    type: GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE,
  });

  // The event about the other repository never reaches the repo stream.
  await new Promise((resolve) => setTimeout(resolve, 750));
  const repoEvents = await repoStream.getEvents({ afterOffset: 0 });
  const webhooks = repoEvents.filter((event) => event.type === GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE);
  expect(
    webhooks.map(
      (event) =>
        (event.payload?.body as { repository?: { full_name?: string } })?.repository?.full_name,
    ),
  ).toEqual(["acme/widgets"]);

  // The repo is still healthy after webhook events landed on its stream.
  const files = await repo.listFiles();
  expect(files.paths.length).toBeGreaterThan(0);
});
