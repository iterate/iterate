import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { markdownAnnotator } from "../../packages/shared/src/dev/markdown-annotator.ts";
import { splitRepositoryFullName } from "./repository-full-name.ts";

const cloudflarePreviewSectionLabel = "CLOUDFLARE_PREVIEW";
const cloudflarePreviewStateLabel = "CLOUDFLARE_PREVIEW_STATE";

const CloudflarePreviewStatus = z.enum([
  "awaiting-tests",
  "claim-failed",
  "cleanup-failed",
  "deploy-failed",
  "deployed",
  "fork-unavailable",
  "released",
  "tests-failed",
]);

export const EnvironmentConfigLease = z.object({
  dopplerConfig: z.string().trim().min(1),
  leasedUntil: z.number().int().positive(),
  leaseId: z.string().uuid(),
  slug: z.string().trim().min(1),
  type: z.string().trim().min(1),
});

export const CloudflarePreviewAppEntry = z.object({
  appDisplayName: z.string().trim().min(1),
  appSlug: z.string().trim().min(1),
  status: CloudflarePreviewStatus,
  updatedAt: z.string().trim().min(1),
  headSha: z.string().trim().min(1).nullable().optional(),
  message: z.string().trim().min(1).nullable().optional(),
  publicUrl: z.string().trim().url().nullable().optional(),
  runUrl: z.string().trim().url().nullable().optional(),
  shortSha: z.string().trim().min(1).nullable().optional(),
  cleanupDurationMs: z.number().nonnegative().finite().nullable().optional(),
  deployDurationMs: z.number().nonnegative().finite().nullable().optional(),
  testDurationMs: z.number().nonnegative().finite().nullable().optional(),
});

export const CloudflarePreviewState = z.object({
  apps: z.record(z.string().trim().min(1), CloudflarePreviewAppEntry).default({}),
  environmentConfigLease: EnvironmentConfigLease.nullable().default(null),
});

export type EnvironmentConfigLease = z.infer<typeof EnvironmentConfigLease>;
export type CloudflarePreviewAppEntry = z.infer<typeof CloudflarePreviewAppEntry>;
export type CloudflarePreviewState = z.infer<typeof CloudflarePreviewState>;

export async function readCloudflarePreviewState(params: {
  githubToken: string;
  repositoryFullName: string;
  pullRequestNumber: number;
}) {
  const body = await readPullRequestBody(params);

  return {
    body,
    state: parseCloudflarePreviewState(body),
  };
}

export async function updateCloudflarePreviewState(params: {
  githubToken: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  update: (state: CloudflarePreviewState) => CloudflarePreviewState;
}) {
  const current = await readCloudflarePreviewState(params);
  const nextState = CloudflarePreviewState.parse(params.update(current.state));

  await writePullRequestBody({
    ...params,
    body: renderCloudflarePreviewPullRequestBody(current.body, nextState),
  });

  return {
    state: nextState,
  };
}

export function parseCloudflarePreviewState(body: string): CloudflarePreviewState {
  const current = markdownAnnotator(body, cloudflarePreviewStateLabel).current;
  if (!current) {
    return CloudflarePreviewState.parse({});
  }

  try {
    const parsed = JSON.parse(unwrapHiddenStateBlock(current));
    return CloudflarePreviewState.parse(parsed);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return CloudflarePreviewState.parse({});
    }

    throw error;
  }
}

export function renderCloudflarePreviewPullRequestBody(
  body: string,
  state: CloudflarePreviewState,
) {
  return markdownAnnotator(body, cloudflarePreviewSectionLabel).update(
    renderCloudflarePreviewSection(CloudflarePreviewState.parse(state)),
  );
}

function renderCloudflarePreviewSection(state: CloudflarePreviewState) {
  const entries = Object.values(state.apps).sort((left, right) =>
    left.appDisplayName.localeCompare(right.appDisplayName),
  );
  const table = entries.length > 0 ? renderPreviewAppTable(entries) : null;
  const failureDetails = entries.map(renderPreviewAppFailureDetails).filter(Boolean).join("\n\n");

  return [
    "## Environment Config Lease",
    markdownAnnotator("", cloudflarePreviewStateLabel).update(wrapHiddenStateBlock(state)),
    state.environmentConfigLease
      ? renderEnvironmentConfigLease(state.environmentConfigLease)
      : "No active environment config lease.",
    table,
    failureDetails || null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderEnvironmentConfigLease(lease: EnvironmentConfigLease) {
  return [
    `Lease: \`${lease.slug}\``,
    `Doppler config: \`${lease.dopplerConfig}\``,
    `Type: \`${lease.type}\``,
    `Leased until: ${new Date(lease.leasedUntil).toISOString()}`,
  ].join("\n");
}

function renderPreviewAppTable(entries: CloudflarePreviewAppEntry[]) {
  const headers = [
    "app",
    "status",
    "commit",
    "preview",
    "deploy duration",
    "test duration",
    "cleanup duration",
    "workflow run",
    "updated",
    "summary",
  ];

  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...entries.map(renderPreviewAppTableRow),
  ].join("\n");
}

function renderPreviewAppTableRow(entry: CloudflarePreviewAppEntry) {
  const summary = summarizePreviewMessage(entry.message);
  const cells = [
    entry.appDisplayName,
    renderStatusLabel(entry.status),
    entry.shortSha ? `\`${entry.shortSha}\`` : "",
    entry.publicUrl ? `[${entry.publicUrl}](${entry.publicUrl})` : "",
    entry.deployDurationMs != null ? formatDurationMs(entry.deployDurationMs) : "",
    entry.testDurationMs != null ? formatDurationMs(entry.testDurationMs) : "",
    entry.cleanupDurationMs != null ? formatDurationMs(entry.cleanupDurationMs) : "",
    entry.runUrl ? `[Workflow run](${entry.runUrl})` : "",
    entry.updatedAt,
    summary || "",
  ];

  return `| ${cells.map((value) => value.replaceAll("\n", "<br>").replaceAll("|", "\\|")).join(" | ")} |`;
}

function renderPreviewAppFailureDetails(entry: CloudflarePreviewAppEntry) {
  const details = readPreviewMessage(entry.message);
  const showFailureDetails = entry.status !== "deployed" && entry.status !== "released" && details;

  if (!showFailureDetails) {
    return null;
  }

  return [
    "<details>",
    `<summary>${escapeHtml(entry.appDisplayName)} failure details</summary>`,
    "",
    `<pre>${escapeHtml(details)}</pre>`,
    "",
    "</details>",
  ].join("\n");
}

export function formatDurationMs(durationMs: number) {
  if (durationMs < 1_000) {
    return `${Math.round(durationMs)}ms`;
  }

  return `${(durationMs / 1_000).toFixed(1)}s`;
}

function readPreviewMessage(message: string | null | undefined) {
  return message?.trim() || null;
}

function summarizePreviewMessage(message: string | null | undefined) {
  const details = readPreviewMessage(message);
  if (!details) {
    return null;
  }

  const lines = details
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }

  const interestingLine =
    lines.find((line) =>
      /(assertionerror|error:|failed|timed out|cannot |malformed|unavailable|released|already gone)/i.test(
        line,
      ),
    ) ?? lines[0];

  return interestingLine.length <= 180 ? interestingLine : `${interestingLine.slice(0, 179)}...`;
}

function renderStatusLabel(status: CloudflarePreviewAppEntry["status"]) {
  switch (status) {
    case "awaiting-tests":
      return "awaiting tests";
    case "deployed":
      return "deployed";
    case "tests-failed":
      return "tests failed";
    case "deploy-failed":
      return "deploy failed";
    case "claim-failed":
      return "claim failed";
    case "released":
      return "released";
    case "cleanup-failed":
      return "cleanup failed";
    case "fork-unavailable":
      return "unavailable for forks";
  }
}

/** Escape command output before embedding it in the preview status markdown block. */
function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Pair with unwrapHiddenStateBlock: serialize preview state into a hidden markdown comment. */
function wrapHiddenStateBlock(state: CloudflarePreviewState) {
  return ["<!--", JSON.stringify(state, null, 2), "-->"].join("\n");
}

function unwrapHiddenStateBlock(contents: string) {
  const lines = contents.trim().split("\n");
  if (lines[0] === "<!--" && lines.at(-1) === "-->") {
    return lines.slice(1, -1).join("\n");
  }

  return contents;
}

async function readPullRequestBody(params: {
  githubToken: string;
  repositoryFullName: string;
  pullRequestNumber: number;
}) {
  const octokit = new Octokit({
    auth: params.githubToken,
  });
  const [owner, repo] = splitRepositoryFullName(params.repositoryFullName);
  const pullRequest = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: params.pullRequestNumber,
  });

  return pullRequest.data.body ?? "";
}

async function writePullRequestBody(params: {
  body: string;
  githubToken: string;
  repositoryFullName: string;
  pullRequestNumber: number;
}) {
  const octokit = new Octokit({
    auth: params.githubToken,
  });
  const [owner, repo] = splitRepositoryFullName(params.repositoryFullName);
  await octokit.rest.pulls.update({
    body: params.body,
    owner,
    repo,
    pull_number: params.pullRequestNumber,
  });
}
