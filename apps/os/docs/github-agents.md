# Userspace GitHub pull-request agents

Pull-request agents are project policy. The platform verifies and records
GitHub webhooks, stores a linked-repository fact, and exposes authenticated
Octokit. The project's `worker.ts` decides whether a webhook creates or wakes
an agent and what the agent should do.

```text
GitHub App webhook
  -> /integrations/github/<connection>       verified original fact
       |-> /repos/config                     default-branch pushes only
       `-> worker.ts processEvent
            -> /agents/repos/config/pr/<n>   PR history and agent loop
```

There is no pull-request processor or pull-request Durable Object. The agent
stream is the durable journal and execution loop for its pull request.

## The webhook fact

A signed delivery for a claimed installation is appended to
`/integrations/github/<connection>`. Its idempotency key is derived from
GitHub's delivery ID. The complete decoded body is preserved, with only the
small associations userspace needs for routing:

```ts
{
  type: "events.iterate.com/github/webhook-received",
  payload: {
    appSlug: "iterate",
    installationId: "789",
    delivery: { id: "delivery-id", name: "issue_comment" },
    associations: {
      repository: { id: 123456, owner: "acme", repo: "widgets" },
      pullRequest: { number: 42 },
      author: { association: "MEMBER", login: "octocat", type: "User" },
      mentionedUsers: ["iterate"],
    },
    body: { /* complete GitHub webhook payload */ },
  },
}
```

The extractor uses Octokit's generated `EmitterWebhookEvent` payload types.
After signature verification and an exact event-name switch, it makes the one
unavoidable cast from parsed JSON to Octokit's discriminated event union. It
recognizes direct pull-request subjects only: pull requests, PR issue
comments, reviews, review comments, and review-thread events. Checks and
workflow runs are not fanned out in this proof of concept.

GitHub's numeric repository ID is stable across App installations. The
connection and installation select the credential and source stream; the ID
selects the repository. Once that ID matches the configured link, current
owner/name coordinates come from the signed webhook, so repository renames do
not change agent identity.

## Repo import is separate

Linking `/repos/config` records the connection, installation, numeric
repository ID, and current owner/name. It installs one cross-post filtered to
`push` deliveries whose raw `body.repository.id` matches the link. The repo
processor additionally verifies the provenance, connection, installation,
repository ID, and default branch before importing the push.

That cross-post exists only for default-branch import. Pull-request userspace
consumes the original connection event and rejects every cross-posted copy.

## The userspace router

The seeded [`worker.ts`](../config-repo-template/worker.ts) contains the whole
proof of concept:

```ts
protected override async processEvent(event: StreamEvent): Promise<void> {
  switch (event.type) {
    case "events.iterate.com/github/webhook-received": {
      if (event.source?.crossPostedFrom === undefined) {
        using itx = await this.env.ITX.get();
        await handleGithubPullRequestWebhook(itx, event);
      }
      break;
    }
    default:
      break;
  }
}
```

The handler reads the current link and accepts the event only when its stream
path, installation, and stable repository ID all match. Agent identity mirrors
the project-controlled repo path:

```text
/repos/config       -> /agents/repos/config/pr/42
/repos/team/service -> /agents/repos/team/service/pr/42
```

Only `pull_request:opened` calls the idempotent, zero-argument
`agent.create()`. The router then uses `agent.append(...)` for the stable
policy and status events consumed by the Agent processor. It appends the raw
webhook copy and its referencing task atomically through `agent.stream.append`
because the webhook is intentionally outside the Agent processor's consumed
vocabulary. Later events require the canonical agent birth event, so they
cannot create an agent by accident. A valid delivery can append four kinds of
facts to the PR stream:

- a keyed, versioned developer-policy context item;
- a stable title/icon status;
- the complete webhook with explicit cross-post provenance; and
- when appropriate, one developer task that wakes or interrupts the agent.

The path itself is the association. There is no second association record,
route plan, rejection protocol, or state reducer.

## Structural reviews

Rules are ordinary typed policy in `worker.ts`. Record keys are stable rule
IDs used in suppressions, comments, idempotency, and future analytics:

```ts
const githubPullRequests = {
  policyVersion: "1",
  repoPath: "/repos/config",
  rules: {
    "typescript/explain-type-cast": {
      files: ["**/*.{ts,tsx,mts,cts}"],
      invariant:
        "Every type cast must have a nearby explanation of why it is safe and cannot reasonably be avoided.",
    },
  },
};
```

An open, non-draft `opened`, `ready_for_review`, or `synchronize` delivery adds
a review task with `interrupt-current-request`. The task tells the existing
agent loop to inspect the immutable head, complete changed-file inputs, prior
reviews and native thread resolution, apply matching rules and suppressions,
then either remain silent or publish one consolidated `COMMENT` review.

Suppressions are source comments:

```ts
// iterate-lint-disable typescript/explain-type-cast -- generated SDK boundary
// iterate-lint-disable-next-line typescript/explain-type-cast -- checked above
```

The task idempotency key is semantic: connection, stable repository ID,
current owner/name coordinates, App slug, policy version, and head SHA.
Repeated webhooks for the same route and policy/head cannot restart a clean
review. A different head, route or App change, or explicit policy-version bump
can. Including every call coordinate keeps an idempotency key from ever naming
two different task payloads. A hidden marker on reviews provides a second
publication guard if an already-running task is retried:

```html
<!-- iterate-ai-lint:<repository-id>:policy:<version>:head:<sha> -->
```

The prompt also treats resolved threads and trusted human dispositions as
durable evidence unless the relevant code changes. Together these rules stop
the nondeterministic reviewer oscillating on an unchanged head.

## Mentions

A newly created PR comment, submitted review, or created review comment can
wake the agent when it mentions the receiving App slug and GitHub identifies
its non-bot author as an owner, member, or collaborator. The task then calls
`repos.checkCollaborator` through the configured Octokit connection before
following the referenced request. GitHub text remains untrusted input.

## Proof-of-concept limits

- PRs opened before the worker observed `opened` are not backfilled.
- Globs, suppressions, and findings are enforced by the agent contract, not a
  deterministic validation engine.
- Reviews are advisory `COMMENT` reviews; there is no Check Run, commit status,
  blocking policy, PostHog feed, rule fan-out, or typed timeout yet.
- A repository linked to multiple Iterate projects can be reviewed once by
  each project/App.

This is a breaking replacement for the removed platform GitHub-agent
processor. There is no historical compatibility path.
