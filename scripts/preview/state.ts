import { Octokit } from "@octokit/rest";
import { stripAnsi } from "../../packages/shared/src/jonasland/strip-ansi.ts";
import { z } from "zod";
import { splitRepositoryFullName } from "./repository-full-name.ts";

const cloudflarePreviewSectionLabel = "CLOUDFLARE_PREVIEW_ENVIRONMENTS";
export const cloudflarePreviewStateLabel = "CLOUDFLARE_PREVIEW_ENVIRONMENTS_STATE";

export const CloudflarePreviewStatus = z.enum([
  "claim-failed",
  "cleanup-failed",
  "deploy-failed",
  "deployed",
  "fork-unavailable",
  "released",
  "tests-failed",
]);

export const CloudflarePreviewEntry = z.object({
  appDisplayName: z.string().trim().min(1),
  appSlug: z.string().trim().min(1),
  status: CloudflarePreviewStatus,
  updatedAt: z.string().trim().min(1),
  leasedUntil: z.number().int().positive().nullable().optional(),
  headSha: z.string().trim().min(1).nullable().optional(),
  message: z.string().trim().min(1).nullable().optional(),
  previewEnvironmentAlchemyStageName: z.string().trim().min(1).nullable().optional(),
  previewEnvironmentDopplerConfigName: z.string().trim().min(1).nullable().optional(),
  previewEnvironmentIdentifier: z.string().trim().min(1).nullable().optional(),
  previewEnvironmentSemaphoreLeaseId: z.string().uuid().nullable().optional(),
  previewEnvironmentSlug: z.string().trim().min(1).nullable().optional(),
  previewEnvironmentType: z.string().trim().min(1).nullable().optional(),
  publicUrl: z.string().trim().url().nullable().optional(),
  runUrl: z.string().trim().url().nullable().optional(),
  shortSha: z.string().trim().min(1).nullable().optional(),
});

export const CloudflarePreviewState = z.record(z.string().trim().min(1), CloudflarePreviewEntry);

export type CloudflarePreviewEntry = z.infer<typeof CloudflarePreviewEntry>;
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

export async function upsertCloudflarePreviewStateEntry(params: {
  entry: CloudflarePreviewEntry;
  githubToken: string;
  repositoryFullName: string;
  pullRequestNumber: number;
}) {
  const current = await readCloudflarePreviewState(params);
  const nextState = {
    ...current.state,
    [params.entry.appSlug]: params.entry,
  } satisfies CloudflarePreviewState;

  await writePullRequestBody({
    ...params,
    body: renderCloudflarePreviewPullRequestBody(current.body, nextState),
  });

  return {
    state: nextState,
  };
}

export function clearCloudflarePreviewDestroyPayload(
  entry: CloudflarePreviewEntry,
): CloudflarePreviewEntry {
  return {
    ...entry,
    leasedUntil: null,
    previewEnvironmentAlchemyStageName: null,
    previewEnvironmentDopplerConfigName: null,
    previewEnvironmentIdentifier: null,
    previewEnvironmentSemaphoreLeaseId: null,
    previewEnvironmentSlug: null,
    previewEnvironmentType: null,
  };
}

export function parseCloudflarePreviewState(body: string) {
  const current = annotateMarkdownBlock(body, cloudflarePreviewStateLabel).current;
  if (!current) {
    return {};
  }

  return CloudflarePreviewState.parse(JSON.parse(current));
}

export function renderCloudflarePreviewPullRequestBody(
  body: string,
  state: CloudflarePreviewState,
) {
  return annotateMarkdownBlock(body, cloudflarePreviewSectionLabel).update(
    renderCloudflarePreviewSection(state),
  );
}

function renderCloudflarePreviewSection(state: CloudflarePreviewState) {
  const rows = Object.values(state)
    .sort((left, right) => left.appDisplayName.localeCompare(right.appDisplayName))
    .map(renderPreviewEntry)
    .join("\n\n");

  return [
    "## Preview Environments",
    "",
    renderHiddenMarkdownBlock(cloudflarePreviewStateLabel, JSON.stringify(state, null, 2)),
    rows ? `\n${rows}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderPreviewEntry(entry: CloudflarePreviewEntry) {
  const summary = summarizePreviewMessage(entry.message);
  const details = sanitizePreviewMessage(entry.message);
  const showFailureDetails = isFailureStatus(entry.status) && Boolean(details);

  return [
    `### ${entry.appDisplayName}`,
    "",
    `Status: ${renderStatusLabel(entry.status)}`,
    entry.shortSha ? `Commit: \`${entry.shortSha}\`` : null,
    entry.publicUrl ? `Preview: ${entry.publicUrl}` : null,
    entry.previewEnvironmentIdentifier
      ? `Environment: \`${entry.previewEnvironmentIdentifier}\``
      : null,
    entry.previewEnvironmentDopplerConfigName
      ? `Config: \`${entry.previewEnvironmentDopplerConfigName}\``
      : null,
    entry.previewEnvironmentAlchemyStageName
      ? `Stage: \`${entry.previewEnvironmentAlchemyStageName}\``
      : null,
    entry.leasedUntil ? `Leased until: ${new Date(entry.leasedUntil).toISOString()}` : null,
    summary ? `Summary: ${summary}` : null,
    entry.runUrl ? `[Workflow run](${entry.runUrl})` : null,
    `Updated: ${entry.updatedAt}`,
    showFailureDetails
      ? [
          "",
          "<details>",
          "<summary>Failure details</summary>",
          "",
          `<pre>${escapeHtml(details)}</pre>`,
          "",
          "</details>",
        ].join("\n")
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function isFailureStatus(status: CloudflarePreviewEntry["status"]) {
  return status !== "deployed" && status !== "released";
}

function summarizePreviewMessage(message: string | null | undefined) {
  const sanitized = sanitizePreviewMessage(message);
  if (!sanitized) {
    return null;
  }

  const lines = sanitized
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

  return truncateLine(interestingLine, 180);
}

function sanitizePreviewMessage(message: string | null | undefined) {
  if (!message) {
    return null;
  }

  const normalized = stripAnsi(message)
    .replaceAll("\r\n", "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized.length > 0 ? normalized : null;
}

function truncateLine(line: string, maxLength: number) {
  if (line.length <= maxLength) {
    return line;
  }

  return `${line.slice(0, maxLength - 1)}…`;
}

function renderHiddenMarkdownBlock(label: string, contents: string) {
  return `<!-- ${label} -->\n${contents}\n<!-- /${label} -->`;
}

function annotateMarkdownBlock(body: string, label: string) {
  const startMarker = `<!-- ${label} -->`;
  const endMarker = `<!-- /${label} -->`;
  const lines = body.split("\n");
  const startLine = lines.findIndex((line) => line.trim() === startMarker);
  const endLine = lines.findIndex((line, index) => index > startLine && line.trim() === endMarker);

  if (startLine === -1 || endLine === -1) {
    return {
      current: null,
      update: (contents: string) => {
        const trimmedBody = body.trim();
        const block = renderHiddenMarkdownBlock(label, contents);

        return trimmedBody ? `${trimmedBody}\n\n${block}` : block;
      },
    };
  }

  return {
    current: lines.slice(startLine + 1, endLine).join("\n"),
    update: (contents: string) =>
      [
        ...lines.slice(0, startLine),
        startMarker,
        contents,
        endMarker,
        ...lines.slice(endLine + 1),
      ].join("\n"),
  };
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderStatusLabel(status: CloudflarePreviewEntry["status"]) {
  switch (status) {
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
    owner,
    repo,
    pull_number: params.pullRequestNumber,
    body: params.body,
  });
}
