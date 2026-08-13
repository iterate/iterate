import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";
import { buildFacetProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { isCanonicalRepoPath, resolveAbsolutePath } from "./paths.ts";
import {
  WorkspaceProcessorContract,
  type WorkspaceMount,
  type WorkspaceMountOverlay,
} from "./workspace-processor-contract.ts";

// A placeholder projectId used only to round-trip the PATH through the codec.
// Its value never leaves this module — real workspace names carry the caller's
// projectId — it just has to be a legal projectId so stringify/parse run.
const ROUND_TRIP_PROJECT_ID = "prj_roundtrip";

// Every workspace lives under this collection prefix, matching the addressing
// convention used by `/secrets/...`, `/repos/...`, and `/sandboxes/...`.
export const WORKSPACE_PATH_PREFIX = "/workspaces";

/**
 * Where an agent's own workspace (`itx.workspace`) lives: the agent path under
 * the workspace prefix — `/agents/bla` → `/workspaces/agents/bla`. One
 * function so the birth-certificate mount and anything else addressing an
 * agent's workspace can never disagree on the mapping.
 */
export function agentWorkspacePath(agentPath: string): string {
  return normalizeWorkspacePath(`${WORKSPACE_PATH_PREFIX}${normalizePath(agentPath)}`);
}

/**
 * The workspace path is durable identity (it becomes the Durable Object name
 * AND the workspace's stream path), so this guard sits at the edge where
 * callers choose a path — same role as `assertSandboxPath` / `parseAgentPath`.
 * Beyond the prefix, the only real constraint is codec safety: the path must
 * survive the `{projectId}.iterate{path}` name round trip unchanged, so two
 * spellings can never mint two Durable Objects that parse back to one
 * canonical path.
 */
export function normalizeWorkspacePath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized.startsWith(`${WORKSPACE_PATH_PREFIX}/`)) {
    throw new Error(
      `workspace paths live under ${WORKSPACE_PATH_PREFIX}/ (an agent's workspace at ` +
        `${WORKSPACE_PATH_PREFIX}<agent path>, standalone ones under ` +
        `${WORKSPACE_PATH_PREFIX}/<anything>; there is no root workspace — repos are ` +
        `mounted into each workspace instead), got "${normalized}"`,
    );
  }
  const roundTripped = DurableObjectNameCodec.parse(
    DurableObjectNameCodec.stringify({ path: normalized, projectId: ROUND_TRIP_PROJECT_ID }),
  ).path;
  if (roundTripped !== normalized) {
    throw new Error(
      `workspace path must be a stable Durable Object path (it round-trips unchanged ` +
        `through the name codec), got "${normalized}" which normalizes to "${roundTripped}"`,
    );
  }
  return normalized;
}

/**
 * The EFFECTIVE mount table: every project repo mounted at its own `/repos/**`
 * stream path (commit-to-main), with the workspace's stored overlays merged
 * per mount point on top. Mount path = repo path VERBATIM — the workspace
 * filesystem is a view of the project's one path namespace, so `/repos/config`
 * in every workspace is the repo at stream path `/repos/config`.
 *
 * A partial overlay at a derived path deviates just those fields (e.g.
 * `{ policy: "read-only" }` on a big imported repo); a complete overlay
 * mounts a repo at any extra path. A partial overlay at a NON-derived path
 * never forms a complete mount and is dropped here — tolerantly, because this
 * also runs under reduced state; the configure door rejects such patches
 * loudly before they can be appended.
 */
export function effectiveWorkspaceMounts(
  repoPaths: readonly string[],
  overlays: Record<string, WorkspaceMountOverlay>,
): Record<string, WorkspaceMount> {
  const mounts: Record<string, WorkspaceMount> = {};
  for (const path of repoPaths) {
    if (!isCanonicalRepoPath(path)) continue;
    mounts[path] = { policy: "commit-to-main", repoPath: path };
  }
  for (const [path, overlay] of Object.entries(overlays)) {
    // "/" is never a mount — the workspace root is the project namespace.
    // The doors reject it, but a raw-appended (or pre-derivation legacy)
    // overlay must not revive a root mount in the live table either.
    if (path === "/") continue;
    const merged = { ...mounts[path], ...overlay };
    if (!merged.policy || !merged.repoPath) continue;
    mounts[path] = { policy: merged.policy, repoPath: merged.repoPath };
  }
  return mounts;
}

/**
 * The mount-table door guard, shared by `create` and `configure`: raw stream
 * appends bypass it (and merely reduce into config), but every platform door
 * validates here so a bad table fails loudly at the caller instead of quietly
 * mis-routing reads. Returns the table with normalized mount-point keys.
 * Values may be partial (configure patches) or null (unmount) — `repoPath` is
 * checked when present.
 */
export function normalizeWorkspaceMountKeys<
  Value extends { policy?: string; repoPath?: string | undefined } | null,
>(mounts: Record<string, Value>): Record<string, Value> {
  const normalized: Record<string, Value> = {};
  for (const [key, value] of Object.entries(mounts)) {
    const path = resolveAbsolutePath(key);
    if (path === "/") {
      throw new Error(
        `mount path "/" is not allowed — the workspace root is the project namespace; repos mount at their own /repos/** paths`,
      );
    }
    if (path.split("/").includes(".git")) {
      throw new Error(`mount path "${key}" contains a reserved .git segment`);
    }
    if (path in normalized) {
      throw new Error(`duplicate mount path "${path}" — mount paths must be unique`);
    }
    if (value?.repoPath) {
      const repoPath = normalizePath(value.repoPath);
      if (!repoPath.startsWith("/repos/")) {
        throw new Error(`mount repoPath must name a /repos/** stream, got "${value.repoPath}"`);
      }
      normalized[path] = { ...value, repoPath };
      continue;
    }
    normalized[path] = value;
  }
  return normalized;
}

/**
 * The complete atomic workspace birth batch: the `workspace/created`
 * existence marker, an optional initial `workspace/configured` overlay patch
 * (deviations from the derived table — every project repo at its own
 * /repos/** path), and the processor subscription. The created and configured
 * keys contain identity only: identical retries dedupe, while a retry with a
 * different initial overlay fails through the stream's
 * same-key-different-body check.
 */
export function workspaceCreationEvents(input: {
  mounts?: Record<string, WorkspaceMountOverlay>;
  path: string;
  projectId: string;
}) {
  const desiredMounts = input.mounts
    ? WorkspaceProcessorContract.stateSchema.shape.config.parse({
        mounts: normalizeWorkspaceMountKeys(input.mounts),
      }).mounts
    : undefined;
  return [
    WorkspaceProcessorContract.buildEvent({
      type: "events.iterate.com/workspace/created",
      idempotencyKey: `workspace-created:${input.projectId}:${input.path}`,
      payload: {},
    }),
    ...(desiredMounts
      ? [
          WorkspaceProcessorContract.buildEvent({
            type: "events.iterate.com/workspace/configured",
            idempotencyKey: `workspace-configured-at-creation:${input.projectId}:${input.path}`,
            payload: { config: { mounts: desiredMounts } },
          }),
        ]
      : []),
    buildFacetProcessorSubscriptionConfiguredEvent({
      idempotencyKey: `stream/subscription-configured:${WorkspaceProcessorContract.slug}`,
      name: WorkspaceProcessorContract.slug,
    }),
  ];
}

/**
 * The repo write lane wants text as text (reviewable diffs on GitHub mirrors)
 * and bytes as base64; a workspace file is just bytes. Valid UTF-8 rides as
 * a string, anything else (images, PDFs) as base64 — the same convention as
 * `files.put`.
 */
export function encodeRepoContent(
  bytes: Uint8Array,
): { content: string } | { contentBase64: string } {
  try {
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    let binary = "";
    // Chunked: String.fromCharCode(...bytes) overflows the arg limit on big files.
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { contentBase64: btoa(binary) };
  }
}
