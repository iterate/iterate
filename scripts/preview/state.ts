import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { markdownAnnotator } from "../../packages/shared/src/jonasland/markdown-annotator.ts";
import { splitRepositoryFullName } from "./repository-full-name.ts";

const cloudflarePreviewSectionLabel = "CLOUDFLARE_PREVIEW_ENVIRONMENTS";
const cloudflarePreviewStateLabel = "CLOUDFLARE_PREVIEW_ENVIRONMENTS_STATE";
const CloudflarePreviewStatus = z.enum([
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

type CloudflarePreviewEntry = z.infer<typeof CloudflarePreviewEntry>;
type CloudflarePreviewState = Record<string, CloudflarePreviewEntry>;

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
  const current = markdownAnnotator(body, cloudflarePreviewStateLabel).current;
  if (!current) {
    return {};
  }

  try {
    const parsed = JSON.parse(current);
    return z.record(z.string().trim().min(1), CloudflarePreviewEntry).parse(parsed);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return {};
    }

    throw error;
  }
}

export function renderCloudflarePreviewPullRequestBody(
  body: string,
  state: CloudflarePreviewState,
) {
  return markdownAnnotator(body, cloudflarePreviewSectionLabel).update(
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
    markdownAnnotator("", cloudflarePreviewStateLabel).update(JSON.stringify(state, null, 2)),
    rows ? `\n${rows}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderPreviewEntry(entry: CloudflarePreviewEntry) {
  const summary = summarizePreviewMessage(entry.message);
  const details = readPreviewMessage(entry.message);
  const showFailureDetails = entry.status !== "deployed" && entry.status !== "released" && details;

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

  return interestingLine.length <= 180 ? interestingLine : `${interestingLine.slice(0, 179)}…`;
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

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
