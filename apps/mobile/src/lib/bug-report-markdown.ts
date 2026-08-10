// Pure rendering of the bug-report clipboard block — everything arrives as
// arguments (no expo imports) so bug-report-markdown.test.ts can run it in
// plain node. bug-report.ts gathers the real values.
import type { SessionLogEntry } from "./session-log.ts";

export type BugReportContext = {
  build: {
    branch: string;
    commit: string;
    message: string;
    builtAt: string;
  };
  updates: {
    channel: string | null;
    channelOverride: string | null;
    runtimeVersion: string | null;
    updateId: string | null;
  };
  server: {
    baseUrl: string;
    project: { projectId: string; projectSlug: string } | null;
  };
  /** Offset of the durable bug-report-filed event, or null if the append
   * failed/timed out — or there was no project open to append to (the trail
   * below is then the only copy). */
  reportEventOffset: number | null;
  entries: SessionLogEntry[];
};

/** How many trail lines to show inline. The durable report event embeds the
 * full snapshot; this is just the human/agent-skimmable tail. */
const TRAIL_LINES = 25;

export function buildBugReportMarkdown(context: BugReportContext): string {
  const { build, updates, server } = context;
  const commit = build.commit.slice(0, 7);
  const reportRef =
    context.reportEventOffset === null || server.project === null
      ? "durable report event: none committed — the trail below is the only copy"
      : `durable report event: \`events.iterate.com/mobile/bug-report-filed\` at offset ${context.reportEventOffset} ` +
        `on stream \`/mobile-events\` of project \`${server.project.projectId}\` (${server.baseUrl}) — ` +
        "embeds the full session log; fetch it with `pnpm cli itx run` against that environment";
  const trail = context.entries
    .slice(-TRAIL_LINES)
    .map((entry) => `${entry.at.slice(11, 19)} ${describeEntry(entry)}`)
    .join("\n");

  return [
    "🐛 Bug report from the mobile app",
    "",
    "<!-- what went wrong? add a screenshot -->",
    "",
    "<details>",
    `<summary>Session context (${build.branch}@${commit})</summary>`,
    "",
    `- build: \`${build.branch}@${commit}\` — ${build.message || "(no message)"} (bundled ${build.builtAt})`,
    `- updates: channel \`${updates.channel || "?"}\`` +
      (updates.channelOverride ? ` (override \`${updates.channelOverride}\`)` : "") +
      `, runtime \`${updates.runtimeVersion || "?"}\`, update \`${updates.updateId || "?"}\``,
    `- server: ${server.baseUrl}` +
      (server.project
        ? `, project: ${server.project.projectSlug} (\`${server.project.projectId}\`)`
        : ", no project open"),
    `- ${reportRef}`,
    "",
    "Recent activity (oldest first):",
    "",
    "```",
    trail || "(empty)",
    "```",
    "",
    "</details>",
    "",
  ].join("\n");
}

function describeEntry(entry: SessionLogEntry): string {
  const shortType = entry.type.replace("events.iterate.com/mobile/", "");
  if (shortType === "screen-viewed" && typeof entry.payload.pathname === "string") {
    return `${shortType} ${entry.payload.pathname}`;
  }
  if (shortType === "error-occurred") {
    return `${shortType} [${String(entry.payload.source)}] ${String(entry.payload.message)}`.slice(
      0,
      160,
    );
  }
  return `${shortType} ${JSON.stringify(entry.payload)}`.slice(0, 160);
}
