# GitHub production smoke testing

Use this after a planned production recreation to prove the `iterate` project's
GitHub connection, config-repo synchronization, webhook assignment, and PR
routing. It creates one temporary draft PR in `iterate/config`; do not mention
the production GitHub App login in its title or body, so it cannot wake an LLM
turn.

Run OS commands from `apps/os`. Resolve the production project ID rather than
hard-coding it:

```bash
doppler run --config prd -- pnpm cli itx run -e '
  const projects = await itx.projects.list({ scope: "deployment" });
  return projects.filter((project) => project.slug === "iterate");
'
```

## Prove the connection and config repo

Use the resolved ID as `--context`. This makes an authenticated GitHub request,
pulls GitHub's default branch into Artifacts, pushes the equal head back through
the linked repo, and reports all heads:

```bash
doppler run --config prd -- pnpm cli itx run --context <iterate-project-id> -e '
  const before = await itx.repo.processor.snapshot();
  const github = before.state.github;
  if (github === null) throw new Error("config repo is not linked to GitHub");
  const status = await itx.integrations.getConnection({
    provider: "github",
    connection: github.connection,
  });
  const octokit = itx.integrations.github.get(github.connection).octokit;
  const repository = await octokit.rest.repos.get({ owner: github.owner, repo: github.repo });
  const branch = repository.data.default_branch;
  const remoteBefore = await octokit.rest.git.getRef({
    owner: github.owner,
    repo: github.repo,
    ref: `heads/${branch}`,
  });
  const sync = await itx.repo.syncFromGithub({ force: true });
  const push = await itx.repo.pushToGithub({});
  const local = await itx.repo.listFiles();
  return {
    status,
    link: github,
    fullName: repository.data.full_name,
    remoteHead: remoteBefore.data.object.sha,
    localHead: local.commitOid,
    sync,
    push,
  };
'
```

Require a connected status with the recorded installation ID, `iterate/config`,
and equal remote, local, sync, and push commit OIDs. This proves both GitHub App
requests and full-history config synchronization; it does not yet prove webhook
routing.

## Prove webhook routing with `gh`

Create an empty-commit draft PR from a temporary clone. The user must have
authorized this externally visible smoke action (the recreation operator normally
asks once before cutover):

```bash
TMP=$(mktemp -d)
gh repo clone iterate/config "$TMP/config"
cd "$TMP/config"
BRANCH="smoke/recreate-production-$(date -u +%Y%m%d-%H%M%S)"
git switch -c "$BRANCH"
git commit --allow-empty -m "Smoke test production GitHub routing"
git push -u origin "$BRANCH"
gh pr create --repo iterate/config --base main --head "$BRANCH" --draft \
  --title "Smoke: production GitHub routing" \
  --body "Temporary post-recreation webhook-routing smoke. No review requested."
```

Record the PR number. Then inspect both the original connection fact and the
userspace path derived from the internal repo address:

```bash
doppler run --config prd -- pnpm cli itx run \
  --context <iterate-project-id> \
  --vars '{"pullRequest":123}' \
  -e '
    const snapshot = await itx.repo.processor.snapshot();
    const github = snapshot.state.github;
    if (github === null) throw new Error("config repo is not linked to GitHub");
    const connectionPath = `/integrations/github/${github.connection}`;
    const agentPath = `/agents/repos/config/pr/${vars.pullRequest}`;
    const readAll = async (stream, eventTypes) => {
      const events = [];
      let afterOffset = 0;
      for (;;) {
        const page = await stream.getEvents({ afterOffset, eventTypes, limit: 500 });
        events.push(...page);
        if (page.length < 500) return events;
        afterOffset = page.at(-1).offset;
      }
    };
    const [connectionEvents, agentEvents] = await Promise.all([
      readAll(itx.streams.get(connectionPath), [
        "events.iterate.com/github/webhook-received",
      ]),
      readAll(itx.streams.get(agentPath)),
    ]);
    return {
      agentPath,
      connectionPath,
      originalDeliveries: connectionEvents
        .filter((event) =>
          event.payload?.associations?.pullRequest?.number === vars.pullRequest,
        )
        .map((event) => ({
          offset: event.offset,
          installationId: event.payload?.installationId,
          delivery: event.payload?.delivery,
          associations: event.payload?.associations,
        })),
      agentCreated: agentEvents.find(
        (event) => event.type === "events.iterate.com/agent/created",
      ),
      copiedDeliveries: agentEvents.filter(
        (event) => event.type === "events.iterate.com/github/webhook-received",
      ),
      processorSubscriptions: agentEvents
        .filter(
          (event) =>
            event.type ===
              "events.iterate.com/stream/subscription-configured" &&
            event.payload?.receiver?.action === "processor-wake",
        )
        // The subscription NAME selects the contract (name == registered slug).
        .map((event) => event.payload?.name),
    };
  '
```

Webhook delivery is asynchronous; retry the read for up to a minute. Require one
original `pull_request:opened` delivery whose singular pull-request association,
repository ID, and installation match the link; the canonical `agent/created`
fact at `/agents/repos/config/pr/<number>`; and the same complete delivery copied
to that stream. The processor subscriptions must contain the ordinary `agent`
and `capability-host` processors and must not contain the removed
`github-agent`. This proves the installation directory selected the right
connection and the current userspace config worker created and routed the PR
agent without a platform GitHub-agent processor.

Close the PR and delete its branch after recording evidence:

```bash
gh pr close --repo iterate/config <number> --delete-branch
```

The post-recreation GitHub smoke is complete only when both sections pass. A PR
created before the recreation is baseline evidence, not restore evidence.
