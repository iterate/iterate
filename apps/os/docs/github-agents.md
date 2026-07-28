# Userspace GitHub pull-request agents

Pull-request agents are project policy. The platform verifies and records
GitHub webhooks, stores a linked-repository fact, and exposes authenticated
Octokit. The config worker declares the packaged `GithubAiLinter` app and its
rule source. The app decides whether a webhook creates or wakes an agent and
what the agent should do.

```text
GitHub App webhook
  -> /integrations/github/<connection>       verified original fact
       |-> /repos/<project path>              default-branch pushes only
       `-> ReviewBotApp (packaged userspace DO, wake subscription per connection)
            -> ReviewBotProcessor -> handleGithubPullRequestWebhook
                 -> match itx.repos.list() links
                      -> /agents/repos/<project path>/pr/<n>
                                                PR history and agent loop
```

The review bot is a USERSPACE stream processor: `ReviewBotProcessor` (the
same `iterate/processors` machinery as the seeded guestbook) hosted by a
`ReviewBotApp` Durable Object, one instance per GitHub connection, attached
to that connection's webhook stream through a durable wake subscription. The
platform still has no pull-request processor of its own. The agent stream
remains the durable journal and execution loop for its pull request; the
bot's processor folds no state — every durable fact it produces lives on
agent streams, under stable idempotency keys.

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
repository ID, and current owner/name. It configures the repo stream to receive
only `push` deliveries whose raw `body.repository.id` matches the link. The repo
processor additionally verifies the provenance, connection, installation,
repository ID, and default branch before importing the push.

That stream relationship exists only for default-branch import. Pull-request
userspace consumes the original connection event and rejects every received copy.

## The userspace router

The router and its host live in
[`iterate/starter-apps/github-ai-linter`](../../../packages/iterate/src/starter-apps/github-ai-linter/review-bot.ts).
The package contains the `ReviewBotProcessorContract` (consuming
`events.iterate.com/github/webhook-received`), the processor, and the
`handleGithubPullRequestWebhook` router it runs per delivered webhook inside
`blockProcessorWhile` — short must-happen work, so the cursor is held, a crash
redelivers the frame, and the router's stable idempotency keys collapse the
re-run.

Event processing uses the guestbook's hosted-processor wake mechanism, with one difference: webhook streams
are per connection and no user action touches them directly, so nothing can
configure the subscription at creation time. Instead the config worker passes
its environment and app config to `GithubAiLinter.create`, keeps the returned
app in a private field, and calls its dependency-free `processEvent(event)`
method explicitly. On a `repo/github-link-configured` event
(whose payload names the connection), it idempotently appends the bot's
`stream/subscription-configured` event to that
connection's webhook stream, once per (re-)link rather than once per webhook.
The stream spine wakes the newly configured hosted processor immediately, and
a fresh subscription replays from offset zero, so pull requests opened shortly
before the link are still delivered. Because that replay covers the stream's
whole history, the processor drops webhooks older than a freshness horizon
(`reviewBotFreshnessHorizonMs`) — attaching to an old stream must not review
long-dead pull requests. A project that already had linked repos before
adopting this template picks the bot up by re-running `linkGithub` (re-links
replace subscriptions by key and repair by design).

The router lists the project's repos, reads their current links, and accepts
the event only when one link's stream path, installation, and stable repository
ID all match. This lets one connection drive agents for every linked repo
without hard-coding a single path. Agent identity mirrors the matching
project-controlled repo path:

```text
/repos/config       -> /agents/repos/config/pr/42
/repos/team/service -> /agents/repos/team/service/pr/42
```

Only `pull_request:opened` or a trusted explicit mention calls the idempotent,
zero-argument `agent.create()`. The router then uses `agent.append(...)` for
the stable policy and agent summary consumed by the Agent processor.
It appends the GitHub binding, raw webhook copy, and referencing task
atomically through `agent.stream.append`; the raw API is needed because the
webhook sits outside the Agent processor's vocabulary, while valid binding and
context events retain exactly the same reducer meaning through either append
API. Other later events require the canonical agent birth event, so they cannot
create an agent by accident. A valid delivery can append the following groups
of facts to the PR stream:

- a keyed, versioned developer-policy context item;
- a stable agent summary and a GitHub pull-request binding;
- the complete webhook with explicit source-stream provenance; and
- when appropriate, trusted developer instructions and one externally authored
  request that wakes or interrupts the agent.

The path itself is the association. There is no second association record,
route plan, rejection protocol, or state reducer.

Context references retain the original stream coordinate for provenance. A
rendered ref such as `/integrations/github/acme@81` means exactly event offset
81 on that stream; the agent's system protocol explains the corresponding
`itx.streams.get(path).getEvent({ offset })` call. The userspace router already
holds the committed event, however, so it validates and transcribes that event
directly rather than spending an agent turn fetching the same webhook again.

## Structural reviews

Rules are Markdown files in the repo and glob declared by the config worker.
Frontmatter IDs are stable keys used in suppressions, comments, idempotency,
and future analytics:

```md
---
id: typescript/explain-type-cast
files:
  - "**/*.{ts,tsx,mts,cts}"
  - "!**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"
  - "!**/{__tests__,test,tests,spec,specs}/**"
---

Every type cast must have a nearby explanation of why it is safe and cannot
reasonably be avoided.
```

A rule applies only when a changed path matches at least one positive glob and
none of its `!`-prefixed negative globs. The current rules exclude conventional
test and spec filenames and directories from every structural rule.

The same project policy applies to every GitHub-linked repo. The router derives
each agent path from the matched Iterate repo path; GitHub owner/name changes
therefore do not move its history.

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
its non-bot author as an `OWNER`, `MEMBER`, or `COLLABORATOR`. That
`author_association` is part of the signed webhook, so userspace performs the
authorization check before waking the agent; no redundant Octokit access-check
turn is needed. If the PR agent does not exist yet, the trusted mention creates
it first.

The router appends a trusted developer item that names the already-authorized
connection and reply call, followed by the exact GitHub message as externally
authored user context. Only the latter triggers an LLM request. Straightforward
requests can therefore be answered by the first script without rereading the
webhook or checking collaboration, while GitHub text never gains developer
instruction precedence.

## Proof-of-concept limits

- PRs opened before the worker observed `opened` are backfilled only by a
  trusted explicit mention.
- Globs, suppressions, and findings are enforced by the agent contract, not a
  deterministic validation engine.
- Reviews are advisory `COMMENT` reviews; there is no Check Run, commit status,
  blocking policy, PostHog feed, rule fan-out, or typed timeout yet.
- A repository linked to multiple Iterate projects can be reviewed once by
  each project/App.

This is a breaking replacement for the removed platform GitHub-agent
processor. There is no historical compatibility path.
