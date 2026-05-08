# Preview Agent Browser Smoke

Use this when you need to prove that a deployed OS2 preview works through the
real browser, Clerk, TanStack Start routing, and the app UI.

## What The Existing Smoke Covers

`pnpm test:e2e:preview` runs `apps/os2/e2e/preview-smoke.ts`. It verifies the
preview worker, unauthenticated redirect behavior, admin-token project setup,
and MCP/codemode metadata wiring.

It does not exercise Slack. Slack is covered by
`apps/os2/e2e/vitest/codemode-mcp-provider-stack.e2e.test.ts`. When
`APP_CONFIG_SLACK_BOT_TOKEN` is present in the test process, the test discovers
`#slack-agent-e2e-test` and sends a real Slack message through the deployed
codemode Slack capability.

## Authenticated Browser Smoke

Preview uses a Clerk development instance. Create a disposable Clerk user, add it
to the target organization, seed a disposable project, grant that Clerk
organization access to the project, mint a Clerk testing token, mint a
short-lived sign-in token, and drive the deployed app with `agent-browser`.

Keep all generated credentials in `/tmp`, do not print token values, and delete
the Clerk user when finished.

```bash
doppler run --project os2 --config preview_2 -- pnpm exec tsx -e '
import { createClerkClient } from "@clerk/backend";
import { writeFileSync } from "node:fs";

async function main() {
  const clerk = createClerkClient({
    secretKey: process.env.APP_CONFIG_CLERK__SECRET_KEY,
  });

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `agent-browser+${suffix}@iterate.com`;
  const password = `AgentBrowser-${suffix}!Aa1`;
  const organizationSlug = "iterate-1778011847733685074";
  const projectSlug = `agent-browser-ui-smoke-${Date.now()}`;

  const user = await clerk.users.createUser({
    emailAddress: [email],
    password,
    firstName: "Agent",
    lastName: "Browser",
    skipPasswordChecks: true,
    skipLegalChecks: true,
    publicMetadata: { createdBy: "os2-agent-browser-smoke" },
  });

  const org = await clerk.organizations.getOrganization({
    slug: organizationSlug,
  });

  await clerk.organizations.createOrganizationMembership({
    organizationId: org.id,
    userId: user.id,
    role: "org:admin",
  });

  const createProjectResponse = await fetch(
    "https://os2.iterate-preview-2.com/api/projects",
    {
      body: JSON.stringify({
        metadata: { seededBy: "os2-agent-browser-smoke" },
        slug: projectSlug,
      }),
      headers: {
        authorization: `Bearer ${process.env.APP_CONFIG_ADMIN_API_SECRET}`,
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
  if (!createProjectResponse.ok) {
    throw new Error(
      `Project create failed: ${createProjectResponse.status} ${await createProjectResponse.text()}`,
    );
  }
  const project = await createProjectResponse.json() as {
    id: string;
    slug: string;
  };

  const testingToken = await clerk.testingTokens.createTestingToken();
  const signInToken = await clerk.signInTokens.createSignInToken({
    userId: user.id,
    expiresInSeconds: 600,
  });

  writeFileSync(
    "/tmp/os2-agent-browser-clerk-smoke.json",
    JSON.stringify(
      {
        userId: user.id,
        organizationId: org.id,
        organizationSlug,
        projectId: project.id,
        projectSlug: project.slug,
        testingToken: testingToken.token,
        signInToken: signInToken.token,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  console.log(
    JSON.stringify({
      userId: user.id,
      organizationId: org.id,
      organizationSlug,
      projectId: project.id,
      projectSlug: project.slug,
    }),
  );
}

main();
'
```

Grant the Clerk organization access to the seeded project. Admin-created
projects intentionally do not assign Clerk ownership, so this smoke inserts the
permission explicitly.

```bash
node > /tmp/os2-agent-browser-permission.sql <<'NODE'
const fs = require("node:fs");
const data = JSON.parse(
  fs.readFileSync("/tmp/os2-agent-browser-clerk-smoke.json", "utf8"),
);
function sqlString(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}
console.log(
  `insert or ignore into project_permissions (project_id, principal_type, principal_id, role) values (${sqlString(data.projectId)}, 'clerk_organization', ${sqlString(data.organizationId)}, 'owner');`,
);
NODE

doppler run --project os2 --config preview_2 -- \
  pnpm exec wrangler d1 execute os2-preview-2-db \
  --remote \
  --file /tmp/os2-agent-browser-permission.sql
```

Open the preview with the one-time sign-in token. This logs into Clerk without
requiring an email verification inbox.

```bash
node -e '
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const data = JSON.parse(
  fs.readFileSync("/tmp/os2-agent-browser-clerk-smoke.json", "utf8"),
);
const url = new URL("https://os2.iterate-preview-2.com/sign-in");
url.searchParams.set("__clerk_ticket", data.signInToken);
url.searchParams.set("__clerk_testing_token", data.testingToken);
url.searchParams.set(
  "redirect_url",
  `/orgs/${data.organizationSlug}/projects/${data.projectSlug}/streams`,
);

for (const args of [
  ["open", url.toString()],
  ["wait", "5000"],
  ["snapshot", "-i"],
]) {
  const result = spawnSync("agent-browser", args, {
    stdio: args[0] === "open" ? ["ignore", "ignore", "inherit"] : "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
'
```

The snapshot should show the project-bound Streams page, including the
breadcrumb, filter/create combo box, `Reset`, `Create stream`, and the sortable
`Stream path`, `Created`, and `Woke` table headers.

To prove the UI can mutate deployed state, create a stream from the combo box:

```bash
agent-browser fill @COMBOBOX_REF agent-browser-ui-smoke
agent-browser click @CREATE_STREAM_BUTTON_REF
agent-browser wait 3000
agent-browser snapshot -i
agent-browser get url
```

The final URL should be:

```text
https://os2.iterate-preview-2.com/orgs/<organizationSlug>/projects/<projectSlug>/streams/agent-browser-ui-smoke
```

## Cleanup

Delete the disposable Clerk user and temp file.

```bash
doppler run --project os2 --config preview_2 -- pnpm exec tsx -e '
import { createClerkClient } from "@clerk/backend";
import { readFileSync, rmSync } from "node:fs";

async function main() {
  const data = JSON.parse(
    readFileSync("/tmp/os2-agent-browser-clerk-smoke.json", "utf8"),
  );
  const clerk = createClerkClient({
    secretKey: process.env.APP_CONFIG_CLERK__SECRET_KEY,
  });
  await clerk.users.deleteUser(data.userId);
  rmSync("/tmp/os2-agent-browser-clerk-smoke.json", { force: true });
  rmSync("/tmp/os2-agent-browser-permission.sql", { force: true });
  console.log(JSON.stringify({ deletedUserId: data.userId }));
}

main();
'
```

Close the browser when the smoke is done:

```bash
agent-browser close
```
