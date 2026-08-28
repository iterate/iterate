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
  if (!projectSlug || !path?.startsWith("/secrets/")) return null;
  if (!Array.isArray(egress) || egress.length === 0) return null;
  if (!egress.every((entry) => typeof entry === "string")) return null;
  if (notify !== null && !notify.startsWith("/agents/")) return null;
  const description = jsonParam(parsed.searchParams.get("description"));
  return {
    description: typeof description === "string" ? description : undefined,
    egress,
    notify: notify === null ? undefined : notify,
    path,
    projectSlug,
  };
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
