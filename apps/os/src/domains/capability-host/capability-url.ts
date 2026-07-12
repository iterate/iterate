import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Capability URLs — reach an addressable live capability by a URL instead of by
// an itx path.
//
// A project reaches `itx.jonasComputer` two ways now:
//   - itx.jonasComputer.fetch(req)                    — RPC. A Response copy
//     serializes fine, but a WebSocket upgrade cannot cross the RPC hop
//     (`DataCloneError`); the socket dies in the mesh.
//   - fetch("http://jonascomputer.iterate/…", req)    — a real fetch(). Every
//     hop is a real workerd stub fetch, so it terminates at the capability-host
//     Durable Object, where an upgrade IS allowed (WebSocketPair) and frames
//     bridge to the provider. This is the whole reason the URL form exists: a
//     URL changes the transport class from RPC to fetch-native.
//
// Grammar (`.iterate` is the internal host suffix — never DNS-routable):
//   <cap>.<projectId>.iterate   e.g. jonascomputer.prj_123.iterate  (explicit)
//   <cap>.iterate               e.g. jonascomputer.iterate          (caller's project)
// The request path/query ride the URL path; the capability path is the host
// label(s) before the projectId. v1 addresses single-segment, root-scope mounts.
//
// DNS lowercases the host, so `itx.jonasComputer` is reached at `jonascomputer`
// — capability labels match mounts case-INSENSITIVELY at serve time.
//
// The full fetch-vs-RPC model: apps/os/docs/dynamic-worker-dispatch.md.
// ─────────────────────────────────────────────────────────────────────────────

const CAPABILITY_HOST_SUFFIX = ".iterate";

export type CapabilityUrl = {
  /** Explicit projectId from the host, or null for the short form (the caller's project). */
  projectId: string | null;
  /** The capability-host scope the mount lives on. v1: always the project root "/". */
  scope: string;
  /** The capability mount path — host labels before the projectId, e.g. ["jonascomputer"]. */
  capabilityPath: string[];
};

/** Whether a host label is a projectId (`prj_…`) rather than a capability name. */
function isProjectIdLabel(label: string): boolean {
  return label.startsWith("prj_");
}

/**
 * Parse a capability URL, or return null when `url` is not one (any host that
 * does not end in `.iterate`, or a bare `{projectId}.iterate` with no capability
 * label). Never throws — a non-URL string is simply "not a capability URL".
 */
export function parseCapabilityUrl(rawUrl: string): CapabilityUrl | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (!host.endsWith(CAPABILITY_HOST_SUFFIX)) return null;
  const prefix = host.slice(0, -CAPABILITY_HOST_SUFFIX.length);
  if (prefix === "") return null;

  const labels = prefix.split(".");
  const last = labels[labels.length - 1]!;
  const hasProjectId = isProjectIdLabel(last);
  const projectId = hasProjectId ? last : null;
  const capabilityPath = hasProjectId ? labels.slice(0, -1) : labels;
  // A bare `{projectId}.iterate` names no capability — it is an ordinary
  // Durable Object name, not a routable capability URL.
  if (capabilityPath.length === 0) return null;

  return { projectId, scope: "/", capabilityPath };
}

// ── The dispatch header ──────────────────────────────────────────────────────
// A real fetch has no argument channel besides the request, so the resolved
// capability path rides a header from the project egress hop to the capability
// host — the role `x-iterate-worker-dispatch` plays for dynamic workers. It is
// internal: OS ingress strips it at the trust boundary (`stripInternalHeaders`),
// and the capability host removes it before serving.

export const CAPABILITY_FETCH_DISPATCH_HEADER = "x-iterate-capability-dispatch";

const CapabilityFetchDispatch = z.strictObject({
  capabilityPath: z.array(z.string()),
});

export function withCapabilityDispatchHeader(
  request: Request,
  dispatch: { capabilityPath: string[] },
): Request {
  const headers = new Headers(request.headers);
  headers.set(CAPABILITY_FETCH_DISPATCH_HEADER, JSON.stringify(dispatch));
  return new Request(request, { headers });
}

/**
 * Read and strip the dispatch header. Returns null when absent; throws on a
 * malformed value (an internal caller composed it, so a parse failure is a bug).
 */
export function takeCapabilityDispatch(
  request: Request,
): { capabilityPath: string[]; request: Request } | null {
  const raw = request.headers.get(CAPABILITY_FETCH_DISPATCH_HEADER);
  if (raw === null) return null;
  const { capabilityPath } = CapabilityFetchDispatch.parse(JSON.parse(raw));
  const headers = new Headers(request.headers);
  headers.delete(CAPABILITY_FETCH_DISPATCH_HEADER);
  return { capabilityPath, request: new Request(request, { headers }) };
}
