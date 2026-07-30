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
       `-> ReviewBotApp                       hosted processor for this connection
            -> handleGithubPullRequestWebhook
                 -> match itx.repos.list() links
                      -> /agents/repos/<project path>/pr/<n>
                           |                         conversational PR agent
                           `-> /ai-linter
                                |                    generic Agent emits diagnostics
                                `-> GithubAiLinterApp per-PR reducer and publisher
                                      -> GitHub review
```

The review bot remains userspace project policy. When the config worker sees a
repository link, `GithubAiLinter` configures a hosted-processor subscription on
that connection stream. Its stateful worker contains one `ReviewBotProcessor`
Durable Object whose durable checkpoint survives worker deployments and
evictions. Each non-draft pull request also gets a child `GithubAiLinterApp`
Durable Object. The child stream is the durable analysis journal; the generic
Agent and the linter reducer consume it independently. The platform still has
no pull-request processor of its own.

This proof of concept assumes a freshly recreated production data plane.
Hosted processors therefore use their normal beginning-of-stream checkpoint;
there is no compatibility checkpoint or version-fenced Durable Object identity
for an earlier deployment. The processor rejects irrelevant webhook envelopes
before opening ITX. Structural review rules are read from the config's explicit
paths as one commit-pinned snapshot, so routing a webhook never enumerates or
clones the linked product repository.

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

The router lives in
[`iterate/starter-apps/github-ai-linter`](../../../packages/iterate/src/starter-apps/github-ai-linter/review-bot.ts).
The package contains the hosted processor, the
`handleGithubPullRequestWebhook` router, and the rule loader it calls. The
config worker passes its environment and app config to `GithubAiLinter.create`
and forwards project events to it. A repository-link event installs or
replaces the connection-specific subscription. A root
`project/worker-updated` event also reapplies subscriptions for every current
repo link, so a policy version or rule-path change takes effect without
relinking GitHub. The source stream then wakes the hosted processor with
verified first-hand webhooks. The router's stable idempotency keys collapse
redelivery, and copied webhooks are ignored.

The router lists the project's repos, reads their current links, and accepts
the event only when one link's stream path, installation, and stable repository
ID all match. This lets one connection drive agents for every linked repo
without hard-coding a single path. Agent identity mirrors the matching
project-controlled repo path:

```text
/repos/config       -> /agents/repos/config/pr/42
/repos/team/service -> /agents/repos/team/service/pr/42
```

`pull_request:opened`, `ready_for_review`, and `synchronize` deliveries create
the parent agent when it is missing. This matters after a deliberate production
recreation: the next push repairs the route without replaying the historical
`opened` delivery. A trusted explicit mention can also create the parent. The
router then uses `agent.append(...)` for the stable policy and summary consumed
by the Agent processor. It appends the GitHub binding and any authorized
mention context through `agent.stream.append`.

- a keyed, versioned developer-policy context item;
- a stable agent summary and a GitHub pull-request binding;
- a subscription which copies complete, verified PR webhook history; and
- when appropriate, trusted developer instructions plus one externally
  authored request that wakes the conversational agent.

For an open, non-draft lifecycle delivery the router also creates
`<parent>/ai-linter`, configures its per-PR linter processor, appends one
`github-ai-linter/analysis-requested` fact, and then appends a developer task
which references that committed request offset. Splitting those last two
appends is intentional: the task needs the canonical offset, and webhook
redelivery safely retries a missing task because both appends are
idempotently keyed.

The paths themselves are the associations. There is no second route plan or
mutable association record.

Context references retain the original stream coordinate for provenance. A
rendered ref such as `/integrations/github/acme@81` means exactly event offset
81 on that stream; the agent's system protocol explains the corresponding
`itx.streams.get(path).getEvent({ offset })` call. The userspace router already
holds the committed event, however, so it validates and transcribes that event
directly rather than spending an agent turn fetching the same webhook again.

## Structural reviews

Rules are Markdown files at the explicit paths declared by the config worker.
Frontmatter IDs are stable rule names used in diagnostics and suppressions.
Severity is explicit rather than inferred from prose:

```md
---
id: typescript/explain-type-cast
severity: error
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
an analysis task to the child stream with `interrupt-current-request`. The
request pins the base SHA, head SHA, policy version, prompt version, and
rules-commit snapshot. Its committed stream offset is the analysis ID. A newer
request interrupts the generic Agent and the linter processor settles the
previous unfinished analysis as cancelled.

The Agent has no privileged linter or GitHub-write capability. It reads the
pull request through Octokit, analyses the complete head while restricting
primary locations to changed RIGHT-side lines, and appends ordinary stream
events:

```text
github-ai-linter/analysis-requested
  -> github-ai-linter/diagnostic-reported       zero or more
  -> github-ai-linter/diagnostic-suppressed     zero or more, referencing diagnostics
  -> github-ai-linter/analysis-settled          exactly one terminal result
  -> github-ai-linter/review-publication-requested
  -> github-ai-linter/review-publication-settled
```

Diagnostics use Oxlint-style terminology: `ruleName`, severity, message,
optional help, and one or more labelled source spans. `diagnosticKey` is a
semantic cross-analysis identity made from the rule, filename, and stable code
anchor, not a line number. The reducer uses that identity to classify visible
diagnostics as new, persistent, or reintroduced and to identify resolved
diagnostics. It retains lightweight headers for every analysis and fully
materializes only the active and latest successful results so the per-PR
Durable Object does not accumulate every prompt and diagnostic forever.

A diagnostic may also carry one exact contiguous replacement:

```ts
{
  kind: "suggestion",
  span: { startLine: 10, endLine: 12 },
  content: "the exact replacement source",
}
```

The publisher translates that value mechanically into GitHub's fenced
suggested-change format. It rechecks that the pull request is still open,
non-draft, and on the pinned base/head before writing. Visible errors force
`REQUEST_CHANGES`; warnings force at least `COMMENT`; the Agent's qualitative
assessment can strengthen but never weaken that verdict. Suppressed
diagnostics do not affect the verdict or produce inline comments.

Suppressions are source comments:

```ts
// iterate-lint-disable typescript/explain-type-cast -- generated SDK boundary
// iterate-lint-enable typescript/explain-type-cast
// iterate-lint-disable-line typescript/explain-type-cast -- deliberate compatibility cast
// iterate-lint-disable-next-line typescript/explain-type-cast -- checked above
```

The Agent records a separate `diagnostic-suppressed` event after the diagnostic
so the audit trail preserves both the violation and the source directive which
hid it. In this first version the LLM interprets the Oxlint-like grammar; the
event protocol deliberately allows a deterministic parser to replace that
step later without changing publication or reduced state.

The analysis idempotency key includes connection, App slug, stable repository
ID, current owner/name coordinates, pull-request number, policy and prompt
versions, rules commit, base SHA, and head SHA. Repeated webhooks for the same
immutable inputs therefore return the same analysis offset and task identity.
A hidden marker on the immutable GitHub review provides a second publication
guard if the review landed but the settlement append was interrupted:

```html
<!-- iterate-github-ai-linter:<repository-id>:analysis:<offset>:head:<sha> -->
```

The parent PR agent remains a normal conversational agent throughout. Mentions
go to the parent and can discuss qualitative or borderline issues without
being forced through the rule-diagnostic protocol. It may publish PR
conversation comments and replies, but it cannot create, submit, or dismiss a
GitHub review; the `/ai-linter` processor alone owns review verdict state.

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

- A later `ready_for_review` or `synchronize` delivery repairs missing parent
  and child agents, but there is no periodic crawler for completely inactive
  pull requests.
- File globs, changed-line eligibility, suppression parsing, and diagnostics
  are enforced by the LLM contract, not a deterministic validation engine.
  The stream shapes are intended to survive that later automation.
- The latest successful analysis compares semantic diagnostic keys with the
  previous result. It does not yet ingest GitHub thread resolution or other
  human dispositions when deciding whether an issue is persistent.
- There is no Check Run, commit status, PostHog feed, rule fan-out, automatic
  fix application, or typed analysis-expiry event yet. Failures and cancelled
  publications are nevertheless explicit terminal stream facts.
- The review marker does not yet include an Iterate project identity. Separate
  projects with identical repository, head, and stream-offset coordinates can
  therefore converge on one existing review instead of publishing duplicates.

This is a breaking replacement for the removed platform GitHub-agent
processor. There is no historical compatibility path.
