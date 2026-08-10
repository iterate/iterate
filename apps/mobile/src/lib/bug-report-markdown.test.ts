import { expect, test } from "vitest";
import { buildBugReportMarkdown } from "./bug-report-markdown.ts";

const context = {
  build: {
    branch: "my-feature",
    commit: "abc1234def5678",
    message: "mobile: add the thing",
    builtAt: "2026-08-10T12:00:00.000Z",
  },
  updates: {
    channel: "my-feature",
    channelOverride: null,
    runtimeVersion: "fingerprint:xyz",
    updateId: "0196-update-id",
  },
  server: {
    baseUrl: "https://os.iterate.com",
    project: { projectId: "proj_123", projectSlug: "dogfood" },
  },
  reportEventOffset: 42,
  entries: [
    {
      at: "2026-08-10T12:01:03.000Z",
      type: "events.iterate.com/mobile/screen-viewed",
      payload: { pathname: "/project/proj_123", params: { projectId: "proj_123" } },
    },
    {
      at: "2026-08-10T12:01:09.000Z",
      type: "events.iterate.com/mobile/error-occurred",
      payload: { source: "auth.code-exchange", message: "fetch failed" },
    },
  ],
};

test("report with a committed durable event", () => {
  expect(buildBugReportMarkdown(context)).toMatchInlineSnapshot(`
    "🐛 Bug report from the mobile app

    <!-- what went wrong? add a screenshot -->

    <details>
    <summary>Session context (my-feature@abc1234)</summary>

    - build: \`my-feature@abc1234\` — mobile: add the thing (bundled 2026-08-10T12:00:00.000Z)
    - updates: channel \`my-feature\`, runtime \`fingerprint:xyz\`, update \`0196-update-id\`
    - server: https://os.iterate.com, project: dogfood (\`proj_123\`)
    - durable report event: \`events.iterate.com/mobile/bug-report-filed\` at offset 42 on stream \`/mobile-events\` of project \`proj_123\` (https://os.iterate.com) — embeds the full session log; fetch it with \`pnpm cli itx run\` against that environment

    Recent activity (oldest first):

    \`\`\`
    12:01:03 screen-viewed /project/proj_123
    12:01:09 error-occurred [auth.code-exchange] fetch failed
    \`\`\`

    </details>
    "
  `);
});

test("append failed — trail is the only copy, channel override shown", () => {
  const markdown = buildBugReportMarkdown({
    ...context,
    updates: { ...context.updates, channelOverride: "other-pr-branch" },
    reportEventOffset: null,
  });
  expect(markdown).toContain("none committed — the trail below is the only copy");
  expect(markdown).toContain("(override `other-pr-branch`)");
  expect(markdown).not.toContain("offset");
});

test("no project open — server line says so, no event reference", () => {
  const markdown = buildBugReportMarkdown({
    ...context,
    server: { baseUrl: "https://os.iterate.com", project: null },
    reportEventOffset: null,
  });
  expect(markdown).toContain("https://os.iterate.com, no project open");
  expect(markdown).toContain("none committed — the trail below is the only copy");
});
