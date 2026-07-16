# GitHub production smoke testing

Use this after a planned production recreation to prove the `iterate` project's
GitHub connection, config-repo synchronization, webhook assignment, and PR
routing. It creates one temporary draft PR in `iterate/config`; do not put
`@iterate` in its title or body, so it cannot wake an LLM turn.

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

Record the PR number. Then compute its deterministic routed stream from the
restored config-repo link and inspect the raw delivery:

```bash
doppler run --config prd -- pnpm cli itx run \
  --context <iterate-project-id> \
  --vars '{"pullRequest":123}' \
  -e '
    const snapshot = await itx.repo.processor.snapshot();
    const github = snapshot.state.github;
    if (github === null) throw new Error("config repo is not linked to GitHub");
    const identity = JSON.stringify([
      "/repos/config",
      github.installationId,
      github.owner,
      github.repo,
    ]);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)),
    );
    const fingerprint = [...digest]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const path = `/agents/repos/g~${fingerprint}/pull-requests/${vars.pullRequest}`;
    const events = await itx.streams.get(path).getEvents({
      eventTypes: ["events.iterate.com/github/webhook-received"],
      limit: 500,
    });
    return {
      path,
      deliveries: events
        .filter((event) => event.payload?.body?.action === "opened")
        .map((event) => ({
          offset: event.offset,
          connection: event.payload?.connection,
          installationId: event.payload?.installationId,
          repository: event.payload?.body?.repository?.full_name,
          pullRequest: event.payload?.body?.pull_request?.number,
        })),
    };
  '
```

Webhook delivery is asynchronous; retry the read for up to a minute. Require one
`opened` delivery for the smoke PR, `iterate/config`, and the recorded connection
and installation. This proves the global GitHub directory claim assigned the
webhook to the Iterate project and the restored repo link routed it.

Close the PR and delete its branch after recording evidence:

```bash
gh pr close --repo iterate/config <number> --delete-branch
```

The post-recreation GitHub smoke is complete only when both sections pass. A PR
created before the recreation is baseline evidence, not restore evidence.
