import { Octokit } from "@octokit/rest";
import { z } from "zod";

export const cloudflarePreviewCommentMarker = "<!-- CLOUDFLARE_PREVIEW_ENVIRONMENTS -->";
export const cloudflarePreviewCommentStateLabel = "CLOUDFLARE_PREVIEW_ENVIRONMENTS_STATE";

export const CloudflarePreviewCommentStatus = z.enum([
  "claim-failed",
  "cleanup-failed",
  "deploy-failed",
  "deployed",
  "fork-unavailable",
  "released",
  "tests-failed",
]);

export const CloudflarePreviewCommentEntry = z.object({
  appDisplayName: z.string().trim().min(1),
  appSlug: z.string().trim().min(1),
  status: CloudflarePreviewCommentStatus,
  updatedAt: z.string().trim().min(1),
  leasedUntil: z.number().int().positive().nullable().optional(),
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

export const CloudflarePreviewCommentState = z.record(
  z.string().trim().min(1),
  CloudflarePreviewCommentEntry,
);

export type CloudflarePreviewCommentEntry = z.infer<typeof CloudflarePreviewCommentEntry>;
export type CloudflarePreviewCommentState = z.infer<typeof CloudflarePreviewCommentState>;

export async function readCloudflarePreviewCommentState(params: {
  githubToken: string;
  repositoryFullName: string;
  pullRequestNumber: number;
}) {
  const octokit = new Octokit({
    auth: params.githubToken,
  });
  const [owner, repo] = splitRepositoryFullName(params.repositoryFullName);
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: params.pullRequestNumber,
    per_page: 100,
  });
  const existingComment = [...comments]
    .reverse()
    .find((comment: { body?: string | null }) =>
      comment.body?.includes(cloudflarePreviewCommentMarker),
    );

  return {
    commentId: existingComment?.id ?? null,
    state: parseCloudflarePreviewCommentState(existingComment?.body ?? ""),
  };
}

export function clearCloudflarePreviewDestroyPayload(
  entry: CloudflarePreviewCommentEntry,
): CloudflarePreviewCommentEntry {
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

export async function upsertCloudflarePreviewCommentEntry(params: {
  entry: CloudflarePreviewCommentEntry;
  githubToken: string;
  repositoryFullName: string;
  pullRequestNumber: number;
}) {
  const octokit = new Octokit({
    auth: params.githubToken,
  });
  const [owner, repo] = splitRepositoryFullName(params.repositoryFullName);
  const current = await readCloudflarePreviewCommentState({
    githubToken: params.githubToken,
    repositoryFullName: params.repositoryFullName,
    pullRequestNumber: params.pullRequestNumber,
  });

  const nextState = {
    ...current.state,
    [params.entry.appSlug]: params.entry,
  } satisfies CloudflarePreviewCommentState;
  const body = renderCloudflarePreviewCommentBody(nextState);

  if (current.commentId) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: current.commentId,
      body,
    });
    return {
      commentId: current.commentId,
      state: nextState,
    };
  }

  const created = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: params.pullRequestNumber,
    body,
  });
  return {
    commentId: created.data.id,
    state: nextState,
  };
}

export function parseCloudflarePreviewCommentState(body: string) {
  const current = markdownAnnotator(
    body || cloudflarePreviewCommentMarker,
    cloudflarePreviewCommentStateLabel,
  ).current;
  if (!current) {
    return {};
  }

  return CloudflarePreviewCommentState.parse(JSON.parse(current));
}

export function renderCloudflarePreviewCommentBody(state: CloudflarePreviewCommentState) {
  const rows = Object.values(state)
    .sort((left, right) => left.appDisplayName.localeCompare(right.appDisplayName))
    .map((entry) =>
      [
        `### ${entry.appDisplayName}`,
        "",
        `Status: ${renderStatusLabel(entry.status)}`,
        entry.previewEnvironmentIdentifier
          ? `Environment: \`${entry.previewEnvironmentIdentifier}\``
          : null,
        entry.previewEnvironmentDopplerConfigName
          ? `Config: \`${entry.previewEnvironmentDopplerConfigName}\``
          : null,
        entry.previewEnvironmentAlchemyStageName
          ? `Stage: \`${entry.previewEnvironmentAlchemyStageName}\``
          : null,
        entry.publicUrl ? `URL: ${entry.publicUrl}` : null,
        entry.leasedUntil ? `Leased until: ${new Date(entry.leasedUntil).toISOString()}` : null,
        entry.message ?? null,
        entry.runUrl ? `[Workflow run](${entry.runUrl})` : null,
        `Updated: ${entry.updatedAt}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");

  const withState = markdownAnnotator(
    `${cloudflarePreviewCommentMarker}\n## Preview Environments`,
    cloudflarePreviewCommentStateLabel,
  ).update(JSON.stringify(state, null, 2));

  return rows ? `${withState}\n\n${rows}` : withState;
}

function markdownAnnotator(body: string, label: string) {
  const startMarker = `<!-- ${label} -->`;
  const endMarker = `<!-- /${label} -->`;
  const lines = body.split("\n");
  const startLine = lines.findIndex((line) => line.trim() === startMarker);
  const endLine = lines.findIndex((line, index) => index > startLine && line.trim() === endMarker);

  if (startLine === -1 || endLine === -1) {
    return {
      current: null,
      update: (contents: string) =>
        `${body.trim()}\n\n${startMarker}\n${contents}\n${endMarker}`.trim(),
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

function renderStatusLabel(status: CloudflarePreviewCommentEntry["status"]) {
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

function splitRepositoryFullName(repositoryFullName: string) {
  const [owner, repo] = repositoryFullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repositoryFullName: ${repositoryFullName}`);
  }

  return [owner, repo] as const;
}
