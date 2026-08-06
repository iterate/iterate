import {
  classifyRepoAccessError,
  isRepoNotSeededError,
  RepoNotSeededError,
  RetryableRepoCreationError,
} from "./utils.ts";

// Healthy creates finish in about two seconds (live p99 2.1s). Hosted callers
// bound both the create attempt and an ambiguous-create readback. The durable
// coordinator deliberately passes a null create timeout: the successful
// response carries a one-time token and must not be abandoned by Promise.race.
export const HOSTED_ARTIFACT_CREATE_TIMEOUT_MS = 8_000;
export const HOSTED_ARTIFACT_RECOVERY_TIMEOUT_MS = 8_000;
const EXISTING_ARTIFACT_READY_INITIAL_RETRY_MS = 250;
const EXISTING_ARTIFACT_READY_MAX_RETRY_MS = 4_000;

export type GetOrCreateArtifactResult =
  | {
      branchState: "empty";
      created: true;
      initialWriteToken: string;
    }
  | {
      branchState: "empty" | "has-commits" | "requires-clone";
      created: false;
      initialWriteToken: null;
    };

type ExistingArtifact =
  | {
      kind: "content-readable";
      log(options: { limit: number; ref: string }): Promise<Array<{ hash: string }>>;
    }
  | { kind: "control-plane-only" };

/**
 * Create an Artifacts repository idempotently and report whether it has
 * already received a push.
 *
 * A successful create returns the initial write token Cloudflare minted with
 * the repo. Preserve it: immediately calling get()+createToken() is both
 * redundant and a create/read consistency race.
 *
 * An ALREADY_EXISTS response can mean a prior attempt committed but its
 * response was lost. In that case the create plane may reserve the name
 * before get() can observe the repo. Wait here with a separately bounded
 * exponential backoff rather than repeatedly hammering create and surfacing
 * every not-ready observation through the durable processor error path.
 */
export async function getOrCreateArtifact(
  artifacts: {
    create(
      name: string,
      input: { setDefaultBranch: string },
    ): Promise<Pick<ArtifactsCreateRepoResult, "token">>;
    get(name: string): Promise<unknown>;
  },
  name: string,
  input: {
    createTimeoutMs: number | null;
    defaultBranch: string;
    recoveryTimeoutMs: number;
  },
): Promise<GetOrCreateArtifactResult> {
  const createTimeoutMs = input.createTimeoutMs;
  try {
    const create = () => artifacts.create(name, { setDefaultBranch: input.defaultBranch });
    const created =
      createTimeoutMs === null
        ? await create()
        : await beforeArtifactCreationDeadline(create, Date.now() + createTimeoutMs, () =>
            artifactCreationTimeout(name, createTimeoutMs, undefined),
          );
    return {
      branchState: "empty",
      created: true,
      initialWriteToken: stripArtifactTokenExpiry(created.token),
    };
  } catch (error) {
    if ((error as { code?: string }).code !== "ALREADY_EXISTS") throw error;
  }

  const recoveryDeadlineAt = Date.now() + input.recoveryTimeoutMs;
  const existing = await waitForExistingArtifact(
    artifacts,
    name,
    recoveryDeadlineAt,
    input.recoveryTimeoutMs,
  );
  if (existing.kind === "control-plane-only") {
    // Artifacts can expose the documented token-management handle without its
    // content-read methods after an ambiguous empty create. The caller's
    // clone-and-seed path is authoritative: it preserves
    // an existing branch unchanged and creates the deterministic root only
    // when the Git remote is empty.
    return { branchState: "requires-clone", created: false, initialWriteToken: null };
  }
  const hasCommits = await beforeArtifactCreationDeadline(
    async () => {
      try {
        const history = await existing.log({ limit: 1, ref: input.defaultBranch });
        const head = history[0]?.hash;
        if (head === undefined) return false;
        if (!/^[0-9a-f]{40}$/i.test(head)) {
          throw new Error(`Artifact ${name} returned an invalid ${input.defaultBranch} head.`);
        }
        return true;
      } catch (error) {
        if (isRepoNotSeededError(classifyRepoAccessError(error, input.defaultBranch))) return false;
        throw error;
      }
    },
    recoveryDeadlineAt,
    () => artifactReadTimeout(name, input.recoveryTimeoutMs, undefined),
  );
  return {
    branchState: hasCommits ? "has-commits" : "empty",
    created: false,
    initialWriteToken: null,
  };
}

async function waitForExistingArtifact(
  artifacts: { get(name: string): Promise<unknown> },
  name: string,
  deadlineAt: number,
  recoveryTimeoutMs: number,
): Promise<ExistingArtifact> {
  let lastError: unknown;
  let retryDelayMs = EXISTING_ARTIFACT_READY_INITIAL_RETRY_MS;

  for (;;) {
    try {
      return requireExistingArtifact(
        await beforeArtifactCreationDeadline(
          () => artifacts.get(name),
          deadlineAt,
          () => artifactReadTimeout(name, recoveryTimeoutMs, lastError),
        ),
      );
    } catch (error) {
      if (error instanceof RetryableRepoCreationError) throw error;
      if (!isRepoNotSeededError(error)) throw error;
      lastError = error;
    }

    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelayMs, remainingMs)));
    retryDelayMs = Math.min(retryDelayMs * 2, EXISTING_ARTIFACT_READY_MAX_RETRY_MS);
  }

  throw new RepoNotSeededError(
    `Artifact ${name} did not become readable within ${recoveryTimeoutMs}ms.`,
    { cause: lastError },
  );
}

function requireExistingArtifact(value: unknown): ExistingArtifact {
  if (typeof value !== "object" || value === null) {
    throw new RepoNotSeededError("Artifacts get() did not return a repo handle.");
  }
  if (hasArtifactLog(value)) {
    // The runtime check supplies the content-read method missing from the
    // pinned workers-types release but present in the deployed binding.
    return { kind: "content-readable", log: value.log.bind(value) };
  }
  if ("createToken" in value && typeof value.createToken === "function") {
    return { kind: "control-plane-only" };
  }
  throw new RepoNotSeededError(
    "Artifacts get() returned a repo handle without log() or createToken().",
  );
}

type ExistingArtifactLog = (options: {
  limit: number;
  ref: string;
}) => Promise<Array<{ hash: string }>>;

function hasArtifactLog(value: object): value is { log: ExistingArtifactLog } {
  return "log" in value && typeof value.log === "function";
}

async function beforeArtifactCreationDeadline<T>(
  operation: () => Promise<T>,
  deadlineAt: number,
  timeoutError: () => Error,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw timeoutError();

  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(timeoutError()), remainingMs);
  try {
    return await Promise.race([operation(), timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function artifactCreationTimeout(
  name: string,
  createTimeoutMs: number,
  cause: unknown,
): RetryableRepoCreationError {
  return new RetryableRepoCreationError(
    `Artifact ${name} did not finish creating within ${createTimeoutMs}ms.`,
    { cause },
  );
}

function artifactReadTimeout(
  name: string,
  recoveryTimeoutMs: number,
  cause: unknown,
): RepoNotSeededError {
  return new RepoNotSeededError(
    `Artifact ${name} did not become readable within ${recoveryTimeoutMs}ms.`,
    { cause },
  );
}

export function stripArtifactTokenExpiry(token: string): string {
  return token.split("?expires=")[0] ?? token;
}
