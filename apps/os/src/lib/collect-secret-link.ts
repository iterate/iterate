import { z } from "zod";

// The collect-secret deep link: one URL that carries everything the
// chrome-free collection page needs. Built server-side by
// itx.secrets.collectFromUser and parsed by the route's validateSearch —
// keeping both ends in this one file (plus the round-trip test next to it)
// is what stops the encoding drifting.
//
// Encoding rule: TanStack's default search parser JSON-parses each param and
// falls back to the raw string. `path` and `notify` always start with "/" —
// never valid JSON — so they ride raw. `egress` is JSON so the array
// round-trips. `description` is free text and MUST be JSON-encoded: raw
// "12345" would come back as a number and kill the link on zod.

/** Search params of `/collect-secret/$projectSlug`. */
export const CollectSecretSearch = z.object({
  /** The normalized `/secrets/…` path the submitted value lands at. */
  path: z.string().startsWith("/secrets/"),
  /** Egress origins the secret is born pinned to — shown to the user as the
   * promise of where the value can ever be sent. */
  egress: z.array(z.string()).default([]),
  /** Optional requester-written note: what the key is for, where to find it. */
  description: z.string().optional(),
  /** Agent path to message when the user submits — how the requesting agent
   * learns the secret exists. Absent when a non-agent scope minted the link. */
  notify: z.string().startsWith("/agents/").optional(),
});
export type CollectSecretSearch = z.infer<typeof CollectSecretSearch>;

export function buildCollectSecretUrl(input: {
  baseUrl: string | undefined;
  projectSlug: string;
  search: CollectSecretSearch;
}) {
  const url = new URL(input.baseUrl ?? "https://os.iterate.com");
  url.pathname = `/collect-secret/${encodeURIComponent(input.projectSlug)}`;
  url.searchParams.set("path", input.search.path);
  url.searchParams.set("egress", JSON.stringify(input.search.egress));
  if (input.search.description !== undefined) {
    url.searchParams.set("description", JSON.stringify(input.search.description));
  }
  if (input.search.notify !== undefined) {
    url.searchParams.set("notify", input.search.notify);
  }
  return url.toString();
}
