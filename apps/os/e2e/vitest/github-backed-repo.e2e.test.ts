// GitHub-backed repos, the CI-provable half: webhook events arriving on a
// GitHub connection stream reach the linked repo's own stream
// through the exact copy subscription `repo.linkGithub` installs (same
// name, same JSONata condition on push type + GitHub's stable repository ID, same
// first-class destination). The GitHub-touching half (mirror
// push, create-on-link, syncFromGithub) authenticates against real GitHub and
// is proven by production smoke, not here.

import { expect, test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE = "events.iterate.com/github/webhook-received";

test("github pushes about a linked repository reach the repo stream", async () => {
  const marker = crypto.randomUUID();
  const repoPath = `/repos/e2e-github-${marker}`;
  const connectionPath = `/integrations/github/e2e-conn-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects.get(`os-github-repo-${RUN_SUFFIX}-${marker}`).create({});

  // A real repo, so the repo processor is live on the target stream and must
  // coexist with (ignore) the received webhook events.
  using repo = project.repos.get(repoPath);
  await repo.create({ type: "empty" });

  using connectionStream = project.streams.get(connectionPath);
  using repoStream = project.streams.get(repoPath);

  // The stream subscription linkGithub installs, verbatim (see
  // githubRepoSubscriptionEvent in src/domains/repos/github-link.ts).
  await connectionStream.append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: `github-repo:${repoPath}`,
      filter: {
        eventTypes: [GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE],
        jsonataCondition: 'payload.delivery.name = "push" and payload.body.repository.id = 101',
      },
      receiver: {
        action: "copy-to-stream",
        receivingStreamPath: repoPath,
        delivery: {
          start: "now",
          onFailingEvent: "halt",
        },
      },
    },
  });

  const arrived = repoStream.waitForEvent({
    afterOffset: 0,
    eventTypes: [GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE],
    timeoutMs: 15_000,
  });

  // Three deliveries on the installation-wide firehose: wrong repository,
  // right repository but wrong event type, then the one linked push.
  await connectionStream.append(
    {
      type: GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE,
      idempotencyKey: `github-webhook:${marker}-other`,
      payload: {
        body: {
          after: "other-head",
          ref: "refs/heads/main",
          repository: { id: 202 },
        },
        delivery: { id: `${marker}-other`, name: "push" },
        installationId: "789",
      },
    },
    {
      type: GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE,
      idempotencyKey: `github-webhook:${marker}-issue`,
      payload: {
        body: { action: "opened", repository: { id: 101 } },
        delivery: { id: `${marker}-issue`, name: "issues" },
        installationId: "789",
      },
    },
    {
      type: GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE,
      idempotencyKey: `github-webhook:${marker}-widgets`,
      payload: {
        body: {
          after: "widgets-head",
          ref: "refs/heads/main",
          repository: { id: 101 },
        },
        delivery: { id: `${marker}-widgets`, name: "push" },
        installationId: "789",
      },
    },
  );

  const copied = await arrived;
  expect(copied.payload).toMatchObject({
    body: { after: "widgets-head", ref: "refs/heads/main" },
  });
  expect(copied.source?.copiedFrom).toHaveLength(1);
  expect(copied.source?.copiedFrom?.[0]).toMatchObject({
    path: connectionPath,
    name: `github-repo:${repoPath}`,
    type: GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE,
  });

  // Neither the other repository nor the non-push event reaches the repo stream.
  await new Promise((resolve) => setTimeout(resolve, 750));
  const repoEvents = await repoStream.getEvents({ afterOffset: 0 });
  const webhooks = repoEvents.filter((event) => event.type === GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE);
  expect(webhooks.map((event) => event.payload?.delivery)).toEqual([
    { id: `${marker}-widgets`, name: "push" },
  ]);

  // The repo is still healthy after webhook events landed on its stream.
  const files = await repo.listFiles();
  expect(files.paths.length).toBeGreaterThan(0);
});
