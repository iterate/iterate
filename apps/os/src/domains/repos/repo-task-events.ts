export type RepoCommittedFileChange = {
  path: string;
  kind: "created" | "updated" | "deleted";
};

const ZERO_COMMIT_OID = "0".repeat(40);

/**
 * Read Cloudflare's `cf.artifacts.repo.pushed` envelope after the queue
 * handler has captured it on the repo stream. Null oids represent a created
 * or deleted ref, matching Git's all-zero push sentinel.
 */
export function repoArtifactPushFromEventPayload(payload: unknown): RepoArtifactPush | null {
  const captured = record(payload);
  const body = record(captured?.body);
  if (body?.type !== "cf.artifacts.repo.pushed") return null;
  const push = record(body.payload);
  const ref = string(push?.ref);
  const before = string(push?.before);
  const after = string(push?.after);
  if (ref === null || before === null || after === null || !ref.startsWith("refs/heads/")) {
    return null;
  }
  const branch = ref.slice("refs/heads/".length);
  if (branch === "") return null;
  return {
    afterCommitOid: after === ZERO_COMMIT_OID ? null : after,
    beforeCommitOid: before === ZERO_COMMIT_OID ? null : before,
    branch,
  };
}

type RepoArtifactPush = {
  afterCommitOid: string | null;
  beforeCommitOid: string | null;
  branch: string;
};

/** Recognize a GitHub push webhook without treating it as a commit fact. */
export function repoGithubPushFromWebhookPayload(payload: unknown): {
  afterCommitOid: string;
  branch: string;
  installationId: string;
  repositoryId: number;
} | null {
  const captured = record(payload);
  const delivery = record(captured?.delivery);
  if (delivery?.name !== "push") return null;
  const installationId = string(captured?.installationId);
  const repositoryId = positiveInteger(record(record(captured?.associations)?.repository)?.id);
  const body = record(captured?.body);
  const ref = string(body?.ref);
  const afterCommitOid = string(body?.after);
  if (
    ref === null ||
    afterCommitOid === null ||
    installationId === null ||
    repositoryId === null ||
    afterCommitOid === ZERO_COMMIT_OID ||
    !ref.startsWith("refs/heads/")
  )
    return null;
  const branch = ref.slice("refs/heads/".length);
  return branch === "" ? null : { afterCommitOid, branch, installationId, repositoryId };
}

/** Markdown files below any directory segment named `tasks` are repo tasks. */
export function isRepoTaskMarkdownPath(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  return /\.(?:md|markdown)$/i.test(segments.at(-1) ?? "") && segments.includes("tasks");
}

/** Classify task changes between two complete task-file snapshots. */
export function diffRepoTaskFiles(
  previous: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): RepoCommittedFileChange[] {
  const paths = [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort();
  return paths.flatMap((path) => {
    const before = previous[path];
    const after = current[path];
    if (before === after) return [];
    return [
      {
        path,
        kind: before === undefined ? "created" : after === undefined ? "deleted" : "updated",
      },
    ];
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
