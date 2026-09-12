# Grant gate review

Claude Fable 5.1, xhigh. Read-only CLI review of the preceding source snapshot.

Accepted: normalize resource comparisons while preserving the client wire value; default iterate scope; refuse token exchange when fewer than 60 seconds remain; split OAuth policy from protocol and UI routing to remove value import cycles. Kept the conservative access deadline because live connection revocation needs it. Personal/device branches will be tested in their implementation slice.

Reviewed all seven snapshot files against the pinned provider. The shape holds: one provider, audience arrays, admin through the external hook, D1 deny marker ahead of KV. Below are the defects this slice introduced, the code it can shed, and the layering it left behind.

## Defects introduced

- **Root MCP resource fails the exact match.** `oauth.ts:63` compares the client's `resource` byte-for-byte against `https://mcp.iterate2.com`. A WHATWG URL parser serializes an empty path as `/`, so any client that round-trips the PRM `resource` through `new URL(...)` sends a trailing slash. The TypeScript MCP SDK builds its resource parameter that way, and the provider itself treats both forms as one audience at line 4671. Result in owner routing: `invalid_target` at consent. The tests use `${ORIGIN}/mcp`, which has a path, so this is uncovered. Fix: compare `new URL(x).href` on both sides. The provider already validated each value as an absolute HTTP or HTTPS URI before returning it, so this cannot throw.

- **Omitted `scope` mints a dead token.** The provider returns an empty list for a missing scope. `control-plane.ts:248` then grants an empty list, the token carries it, and `oauth.ts:92` answers a bare 401 forever. Consent and exchange both succeed, so the client gets no signal. Clients may omit scope. Fix: grant `["iterate"]` unconditionally. The provider's downscope still refuses broadening, so that test stands.

- **Deadline under 60s surfaces as `invalid_request`.** `oauth.ts:164` clamps the TTL to the remaining deadline. Below 60s the provider rejects with "must be at least 60 seconds" at lines 4197 and 2895. Clients read `invalid_request` as retryable, not as re-authorize. Fix: treat `deadline - now < 60_000` as expired in the existing deadline check.

- **Docs now misstate the gate.** `mcp.ts:14-17` and the whoami text at `mcp.ts:111` say project tokens and secrets are accepted at MCP. `session.ts:6-13` still describes `from-server-cookie` on `/api` and MCP going through `verifyCredentials`. `control-plane.ts:24-25` names `/oauth/register`. All describe the previous boundary.

## Unnecessary code

- **Personal and device branches** at `oauth.ts:161-179`: four branches, unreachable because consent mints only `oauth`. Untested code in the token path. Drop until the personal-token slice lands with its tests; keep the enum value if you want schema stability.

- **`expiresAt` in AccessGrant** at `oauth.ts:34,91,173` duplicates the provider's expiry, which is checked before props are decrypted at line 3894. On refresh the provider clamps TTL after the callback at line 2887, so the props value can exceed the truth. Remove the field and the check.

- **Dead `authorization_servers`** at `oauth.ts:141`. Your handler at `oauth.ts:193` bypasses the provider's PRM route, so nothing reads it. The https condition exists only to satisfy validation of a dead option. Keep `scopes_supported`, which feeds the WWW-Authenticate scope hint.

- **`from-server-cookie`** at `session.ts:60,106-113` is unreachable. `authenticate` refuses all but admin-secret and the project-host lane never tries it. Remove the variant, the case, and that file's `isSameOriginBrowserRequest` import.

- **`props.resources`** is a record, not a guard. Audience comes from the KV grant's `resource`, never from props, so the comment at `oauth.ts:17-18` overstates it. Keep the field if you like; fix the comment.

## Layering, cycles, D1

**Two new value cycles.** worker.ts imports `oauth` while oauth.ts imports `appConfigOf`. oauth.ts imports `consoleHandler` while control-plane.ts imports `parseAuthorization`. Both are safe today because every cross-reference sits inside a function body. A module-level use on either side fails in one import order with a TDZ error. Root cause: `appConfigOf` lives in the front door, so anything needing config imports the hub. Fix with two pure moves and no new abstraction. First, `parseAppConfig`, `appConfigOf` and `AppConfig` go to their own file. Second, `protectedApi`, `providerOptions` and `oauth` move into worker.ts, which already imports every handler it wires. oauth.ts then holds only the grant contract, which control-plane.ts may import freely. The pre-existing worker and control-plane edge via `sameOriginPath` remains unless that moves to lib.ts.

**SQL in two files.** `directory.ts:7-8` says it holds the control plane's whole SQL. `oauth.ts:74-111` adds two statements. Move them onto the directory object or amend the claim.

**D1 semantics are right.** The revocation read is a primary read on every admission and every refresh, ahead of the waitUntil write, and the admin path never touches D1. The activity upsert throttles to once a minute correctly, though it still issues one write statement per admission. Nothing in the snapshot writes `revoked_at` or `cleanup_pending`; only the test does. The 30-day deadline matches the provider's default refresh TTL at line 4550, so KV grants and deadlines age out together.

**Audience enforcement checks out.** An MCP-only token fails at `/api` on origin mismatch and vice versa. Both-audience tokens pass both gates, and the admin hook returns both. One optional tightening: the MCP host also serves the provider's AS metadata with the platform issuer, reachable through `worker.ts:174`. Restricting that host to the PRM path removes a surface no client needs.
