import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";
import { CONFIG_REPO_PATH } from "../repos/paths.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { resolveAbsolutePath } from "./paths.ts";
import { WorkspaceProcessorContract, type WorkspaceMount } from "./workspace-processor-contract.ts";

// A placeholder projectId used only to round-trip the PATH through the codec.
// Its value never leaves this module — real workspace names carry the caller's
// projectId — it just has to be a legal projectId so stringify/parse run.
const ROUND_TRIP_PROJECT_ID = "prj_roundtrip";

// Every workspace lives under this collection prefix, matching the addressing
// convention used by `/secrets/...`, `/repos/...`, and `/sandboxes/...`.
const WORKSPACE_PATH_PREFIX = "/workspaces";

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
 * callers choose a path. Beyond the prefix, the only real constraint is codec
 * safety: the path must survive the `{projectId}.iterate{path}` name round
 * trip unchanged, so two spellings can never mint two Durable Objects that
 * parse back to one canonical path.
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
 * The mount table every workspace is born with unless the caller passes its
 * own: the project's config repo at the workspace root, committable — which
 * makes a fresh workspace behave exactly like the old single-parent overlay
 * (reads fall through to the config repo's main, `git.commit` lands there).
 */
function defaultWorkspaceMounts(): Record<string, WorkspaceMount> {
  return { "/": { policy: "commit-to-main", repoPath: CONFIG_REPO_PATH } };
}

/**
 * The mount-table door guard, shared by `create` and `configure`: raw stream
 * appends bypass it (and merely fold into config), but every platform door
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
    if (path.split("/").includes(".git")) {
      throw new Error(`mount path "${key}" contains a reserved .git segment`);
    }
    if (path in normalized) {
      throw new Error(`duplicate mount path "${path}" — mount paths must be unique`);
    }
    if (value !== null && value.repoPath !== undefined) {
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
 * The two events that birth a workspace: the `workspace/created` birth
 * certificate plus the processor subscription that wires the workspace's
 * Durable Object to its stream. Every birth path (first touch and the
 * explicit create door, which both run inside the DO) appends this SAME
 * certificate, so races collapse on the idempotencyKey; custom mount tables
 * are `workspace/configured` patches on top, never certificate variants.
 */
export function workspaceCreationEvents(input: { path: string; projectId: string }) {
  return [
    WorkspaceProcessorContract.buildEvent({
      type: "events.iterate.com/workspace/created",
      // The certificate body is ALWAYS the default table — identical on every
      // append, so this key can never hit the stream's different-body
      // idempotency rejection. Custom tables are `configured` patches.
      idempotencyKey: `workspace-created:${input.projectId}:${input.path}`,
      payload: { config: { mounts: defaultWorkspaceMounts() } },
    }),
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName: DurableObjectNameCodec.stringify({
        path: input.path,
        projectId: input.projectId,
      }),
      processor: ["workspaces", ["get", input.path], "processor"],
      processorSlug: WorkspaceProcessorContract.slug,
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
