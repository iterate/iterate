import { z } from "zod";

// ---------------------------------------------------------------------------
// CF event envelope (the full message body from the queue)
// ---------------------------------------------------------------------------

const CfEventSource = z.object({
  type: z.string(),
  namespace: z.string().optional(),
  repo_name: z.string().optional(),
});

const CfEventMetadata = z.object({
  accountId: z.string().optional(),
  eventSubscriptionId: z.string().optional(),
  eventSchemaVersion: z.string().optional(),
  eventTimestamp: z.string().optional(),
});

export const CfArtifactEvent = z.object({
  type: z.string(),
  source: CfEventSource.optional(),
  payload: z.record(z.string(), z.unknown()),
  metadata: CfEventMetadata.optional(),
});

export type CfArtifactEvent = z.infer<typeof CfArtifactEvent>;

// ---------------------------------------------------------------------------
// CF event type constants
// ---------------------------------------------------------------------------

export const CF_EVENT_TYPES = {
  // Account-level
  REPO_CREATED: "cf.artifacts.repo.created",
  REPO_DELETED: "cf.artifacts.repo.deleted",
  REPO_FORKED: "cf.artifacts.repo.forked",
  REPO_IMPORTED: "cf.artifacts.repo.imported",
  // Repo-level
  PUSHED: "cf.artifacts.pushed",
  CLONED: "cf.artifacts.cloned",
  FETCHED: "cf.artifacts.fetched",
} as const;

export const ACCOUNT_LEVEL_CF_TYPES: ReadonlySet<string> = new Set([
  CF_EVENT_TYPES.REPO_CREATED,
  CF_EVENT_TYPES.REPO_DELETED,
  CF_EVENT_TYPES.REPO_FORKED,
  CF_EVENT_TYPES.REPO_IMPORTED,
]);

export const REPO_LEVEL_CF_TYPES: ReadonlySet<string> = new Set([
  CF_EVENT_TYPES.PUSHED,
  CF_EVENT_TYPES.CLONED,
  CF_EVENT_TYPES.FETCHED,
]);

// ---------------------------------------------------------------------------
// Iterate stream event types (what we emit to our streams)
// ---------------------------------------------------------------------------

/** Raw CF event captured to the global cloudflare events stream. */
export const CF_EVENT_RECEIVED_TYPE = "events.iterate.com/cloudflare/event-received" as const;

/** Repo-level fan-out event types for /repos/{slug} streams. */
export const REPO_PUSHED_TYPE = "events.iterate.com/repo/pushed" as const;
export const REPO_CLONED_TYPE = "events.iterate.com/repo/cloned" as const;
export const REPO_FETCHED_TYPE = "events.iterate.com/repo/fetched" as const;

/** Account-level fan-out event types for global /repos stream. */
export const REPO_ARTIFACT_CREATED_TYPE = "events.iterate.com/repo/artifact-created" as const;
export const REPO_ARTIFACT_DELETED_TYPE = "events.iterate.com/repo/artifact-deleted" as const;
export const REPO_ARTIFACT_FORKED_TYPE = "events.iterate.com/repo/artifact-forked" as const;
export const REPO_ARTIFACT_IMPORTED_TYPE = "events.iterate.com/repo/artifact-imported" as const;

// ---------------------------------------------------------------------------
// Mapping from CF types to our stream event types
// ---------------------------------------------------------------------------

export const CF_TO_REPO_STREAM_TYPE: Record<string, string> = {
  [CF_EVENT_TYPES.PUSHED]: REPO_PUSHED_TYPE,
  [CF_EVENT_TYPES.CLONED]: REPO_CLONED_TYPE,
  [CF_EVENT_TYPES.FETCHED]: REPO_FETCHED_TYPE,
};

export const CF_TO_GLOBAL_REPOS_TYPE: Record<string, string> = {
  [CF_EVENT_TYPES.REPO_CREATED]: REPO_ARTIFACT_CREATED_TYPE,
  [CF_EVENT_TYPES.REPO_DELETED]: REPO_ARTIFACT_DELETED_TYPE,
  [CF_EVENT_TYPES.REPO_FORKED]: REPO_ARTIFACT_FORKED_TYPE,
  [CF_EVENT_TYPES.REPO_IMPORTED]: REPO_ARTIFACT_IMPORTED_TYPE,
};

// ---------------------------------------------------------------------------
// Payload schemas for fan-out events
// ---------------------------------------------------------------------------

export const RepoPushedPayload = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  commits: z.array(
    z.object({
      id: z.string(),
      message: z.string(),
      timestamp: z.string(),
      author: z.object({ name: z.string(), email: z.string() }),
      committer: z.object({ name: z.string(), email: z.string() }),
    }),
  ),
  totalCommits: z.number(),
  cfPayload: z.record(z.string(), z.unknown()),
});

export const RepoClonedPayload = z.object({
  cfPayload: z.record(z.string(), z.unknown()),
});

export const RepoFetchedPayload = z.object({
  cfPayload: z.record(z.string(), z.unknown()),
});

export const RepoArtifactAccountEventPayload = z.object({
  artifactName: z.string(),
  projectId: z.string().nullable(),
  repoSlug: z.string().nullable(),
  cfPayload: z.record(z.string(), z.unknown()),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse an artifact name like `{projectId}--{repoSlug}` into its parts. */
export function parseArtifactName(artifactName: string): {
  projectId: string;
  repoSlug: string;
} | null {
  const separatorIndex = artifactName.indexOf("--");
  if (separatorIndex === -1) return null;
  const projectId = artifactName.slice(0, separatorIndex);
  const repoSlug = artifactName.slice(separatorIndex + 2);
  if (!projectId || !repoSlug) return null;
  return { projectId, repoSlug };
}

/**
 * Derive the artifact name from a CF event.
 * For repo-level events, the source has namespace + repo_name.
 * For account-level events, the payload may contain enough info but typically
 * we need to look at source.repo_name.
 */
export function deriveArtifactNameFromEvent(event: CfArtifactEvent): string | null {
  return event.source?.repo_name ?? null;
}
