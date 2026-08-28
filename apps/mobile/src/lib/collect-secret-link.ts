// Reading the secret-collection deep link an agent sends into a chat.
//
// The link is minted server-side by `itx.secrets.collectFromUser` and its
// encoding is defined in apps/os/src/lib/collect-secret-link.ts — keep this
// parser in step with that builder. The rule there: TanStack's search parser
// JSON-parses each param and falls back to the raw string, so `path` and
// `notify` (which always start with "/") ride raw, while `egress` and
// `description` are JSON so an array round-trips and free text cannot come
// back as a number.
//
// The app parses the link itself rather than opening the page, because it can
// already do everything the page does: it holds an authenticated itx session,
// so the secret goes app → itx → Secret DO with no browser, no second
// sign-in, and no leaving the thread.

export type CollectSecretRequest = {
  /** Requester-written note: what the key is for, where to find it. */
  description: string | undefined;
  /** Origins the secret is born pinned to — shown as the promise of where the
   * value can ever be sent. */
  egress: string[];
  /** Agent to message once the secret is stored, if a named one asked. */
  notify: string | undefined;
  /** The `/secrets/…` path the submitted value lands at. */
  path: string;
  projectSlug: string;
};

/** The collection request a link describes, or null when it does not describe
 * a usable one — a truncated or rewritten link (chat clients mangle long
 * URLs), or one pinned to nothing, which could never be used. */
export function parseCollectSecretLink(url: string): CollectSecretRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/");
  if (segments[1] !== "collect-secret") return null;
  const projectSlug = decodeURIComponent(segments[2] || "");
  const path = parsed.searchParams.get("path");
  const egress = jsonParam(parsed.searchParams.get("egress"));
  const notify = parsed.searchParams.get("notify");
  const description = jsonParam(parsed.searchParams.get("description"));
  if (!projectSlug) return null;
  if (!isSecretPath(path)) return null;
  if (!isEgressPin(egress)) return null;
  if (notify !== null && !isAgentPath(notify)) return null;
  return {
    description: typeof description === "string" ? description : undefined,
    egress,
    notify: notify === null ? undefined : notify,
    path,
    projectSlug,
  };
}

/** Where the submitted value lands. Anything else addresses a different kind
 * of node, and this screen only ever writes secrets. */
function isSecretPath(value: string | null): value is string {
  return value !== null && value.startsWith("/secrets/");
}

/** The agent to tell once the secret is stored. */
function isAgentPath(value: string): boolean {
  return value.startsWith("/agents/");
}

/** The origins the secret is born pinned to. Must be a non-empty list of
 * strings: a secret pinned to nothing could never be substituted into any
 * request, so a link carrying one does not describe a usable request. */
function isEgressPin(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string")
  );
}

/** A JSON-encoded search param, or the raw string when it is not JSON — the
 * same fallback TanStack's parser applies on the other end. */
function jsonParam(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
