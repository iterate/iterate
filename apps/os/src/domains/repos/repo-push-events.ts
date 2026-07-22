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
  const body = record(captured?.body);
  const candidateRepositoryId = record(body?.repository)?.id;
  const repositoryId =
    typeof candidateRepositoryId === "number" &&
    Number.isSafeInteger(candidateRepositoryId) &&
    candidateRepositoryId > 0
      ? candidateRepositoryId
      : null;
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

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
