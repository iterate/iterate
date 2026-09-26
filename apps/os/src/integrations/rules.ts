// src/integrations/rules.ts — the pure rules the providers' webhooks, GitHub's connect, an
// incremental consent, a sign-in that keeps its token (identity.ts), a person's account connected to
// a project (context/built-ins.ts `integrations.connect`) and the one-token pointer behind it
// (secret/durable-object.ts) apply, covered row by row in rules.test.ts.
//
// THE WEBHOOK RESPONSE CODES. A Slack app or a GitHub App is one webhook URL for every workspace or
// installation it is in, and Slack disables an app's deliveries to all of them once most of an
// hour's fail (any non-2xx counts), so a receiver answers:
//   1. 401 — the signature is wrong, stale (Slack: over five minutes) or missing. The only non-2xx a
//      sender can cause.
//   2. 400 — GitHub only: signed, but no `x-github-delivery` or `x-github-event`.
//   3. 200 `{ ignored: <reason> }` — signed but unusable: an unparseable body, no team or
//      installation, one no connection holds, or one other than the connection's own.
//   4. a thrown error (5xx) — the append failed, so the provider retries; nothing unstored is ACKed.
//   5. 503 — the deployment has no app to check the signature with.
//   6. 200 — stored, or already stored under the delivery's idempotency key.
//
// GITHUB'S INSTALLATION PROOF. An install redirect's `installation_id` can be forged, and a user
// token lists every installation the user can merely read, while the connection's token acts with
// the whole installation's permissions. So the human proves they administer the installation's
// account: it is their own user account, or an organization they are an active admin of.
import { z } from "zod";
import { isRecord } from "../secrets.ts";

/** How far a request's `x-slack-request-timestamp` may be from now: Slack's own advice, which stops
 *  a captured request being replayed later. */
const SLACK_SIGNATURE_WINDOW_SECONDS = 5 * 60;

/** Answers whether `hex` is the HMAC-SHA256 of `payload` under the signing secret, wherever it is
 *  kept (constant-time). */
export type HmacHexMatches = (payload: string, signatureHex: string) => Promise<boolean>;

/** Slack's v0 signature (https://docs.slack.dev/authentication/verifying-requests-from-slack):
 *  `x-slack-signature: v0=<hex HMAC of "v0:<timestamp>:<raw body>">`, the timestamp in the window. */
export async function slackSignatureValid(input: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  nowSeconds: number;
  hmacHexMatches: HmacHexMatches;
}): Promise<boolean> {
  const hex = /^v0=([0-9a-f]{64})$/i.exec(input.signature?.trim() || "")?.[1];
  if (!hex || !input.timestamp || !/^\d{1,12}$/.test(input.timestamp)) return false;
  if (Math.abs(input.nowSeconds - Number(input.timestamp)) > SLACK_SIGNATURE_WINDOW_SECONDS)
    return false;
  return input.hmacHexMatches(`v0:${input.timestamp}:${input.rawBody}`, hex);
}

/** The body Slack sent: the Events API's JSON, or interactivity's `payload=<json>` form field;
 *  null when it is neither. */
export function slackPayloadOf(
  rawBody: string,
  interactivity: boolean,
): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(
      (interactivity ? new URLSearchParams(rawBody).get("payload") : rawBody) || "",
    );
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The workspace a Slack payload is from: `team_id` (Events API), `team.id` (interactivity), or
 *  `event.team` (an event in a shared channel). */
export function slackTeamIdOf(payload: Record<string, unknown>): string | null {
  const candidates = [
    payload.team_id,
    isRecord(payload.team) ? payload.team.id : undefined,
    isRecord(payload.event) ? payload.event.team : undefined,
  ];
  return candidates.find((id): id is string => typeof id === "string" && id !== "") ?? null;
}

/** GitHub's signature: `x-hub-signature-256: sha256=<hex HMAC of the raw body>`. */
export async function githubSignatureValid(input: {
  rawBody: string;
  signature: string | null;
  hmacHexMatches: HmacHexMatches;
}): Promise<boolean> {
  const hex = /^sha256=([0-9a-f]{64})$/i.exec(input.signature?.trim() || "")?.[1];
  return hex ? input.hmacHexMatches(input.rawBody, hex) : false;
}

/** The installation a GitHub delivery is for (`installation.id`), or null. */
export function githubInstallationIdOf(payload: Record<string, unknown>): string | null {
  const id = isRecord(payload.installation) ? payload.installation.id : undefined;
  return typeof id === "number" || (typeof id === "string" && id) ? String(id) : null;
}

/** GitHub's answers the installation proof reads: the user (`GET /user`), the installation's account
 *  (from `GET /user/installations`, null when the user cannot see it at all) and, for an
 *  organization, the user's membership (`GET /user/memberships/orgs/<org>`, null on a 404). */
export type GithubInstallationEvidence = {
  user: { id: number };
  account: { id: number; login: string; type: string } | null;
  membership: { state: string; role: string } | null;
};

/** Whether the human administers the installation's account (the header's rule): null when they do,
 *  else the reason they do not. */
export function githubInstallationRefusal(evidence: GithubInstallationEvidence): string | null {
  const { user, account, membership } = evidence;
  if (!account) return "your GitHub account cannot see this installation";
  if (account.type === "User")
    return account.id === user.id ? null : `the App is installed on another user, ${account.login}`;
  if (membership?.state === "active" && membership.role === "admin") return null;
  return `only an owner of ${account.login} can connect its installation`;
}

/** The account a token endpoint's answer is for: Slack's `team.id`, or the OpenID `sub` of the
 *  `id_token` (Google, Cloudflare). The ID token came straight from the token endpoint over TLS, so
 *  its claims are read without checking its signature (OpenID Connect Core §3.1.3.7). */
function tokenResponseAccountOf(data: unknown): string | null {
  if (!isRecord(data)) return null;
  if (isRecord(data.team) && typeof data.team.id === "string") return data.team.id;
  if (typeof data.id_token !== "string") return null;
  try {
    const payload = data.id_token.split(".")[1] ?? "";
    const claims: unknown = JSON.parse(
      atob(
        payload
          .replaceAll("-", "+")
          .replaceAll("_", "/")
          .padEnd(Math.ceil(payload.length / 4) * 4, "="),
      ),
    );
    return isRecord(claims) && typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

/** The Slack workspace a token endpoint's answer installed the app into (`oauth.v2.access`'s
 *  `team`), or null for an answer that names none. */
export function slackTeamOfTokenResponse(data: unknown): { id: string; name: string } | null {
  const parsed = SlackTokenResponseTeam.safeParse(data);
  if (!parsed.success) return null;
  const { id, name } = parsed.data.team;
  return { id, name: name || id };
}
const SlackTokenResponseTeam = z.object({
  team: z.object({ id: z.string().min(1), name: z.string().optional() }),
});

/** Why an incremental consent is refused — the provider answered for another account than the
 *  connection holds, or for one it does not name — or null when it is the same account. */
export function consentAccountRefusal(expected: string, data: unknown): string | null {
  const actual = tokenResponseAccountOf(data);
  if (actual === expected) return null;
  return actual
    ? `the provider answered for another account (${actual}) than this connection's (${expected}) — connect it as a new connection instead`
    : `the provider's answer names no account, so it cannot be checked against this connection's (${expected})`;
}

/** The providers a person signs in with (identity.ts), each through the deployment's one client for
 *  it: Google and Cloudflare speak OpenID Connect, GitHub its App's user authorization. */
export type SignInProvider = "google" | "cloudflare" | "github";

/** A sign-in's authorize parameters. Google and GitHub show their account picker every time
 *  (`prompt=select_account`), so "switch account" never signs the browser's last account in
 *  silently; Cloudflare's authorize endpoint (Ory Hydra) has no picker prompt, so it is asked none.
 *  Google is asked for offline access with every scope granted before included, so a returning
 *  person keeps what they gave; `consentFor` (the address the first answer came back as) shows the
 *  consent screen again, the only way Google issues a second refresh token. GitHub takes no scope
 *  (the App's permissions are the grant) and no nonce. */
export function signInAuthorizeParams(
  provider: SignInProvider,
  input: {
    clientId: string;
    redirectUri: string;
    scopes: readonly string[];
    state: string;
    nonce: string;
    codeChallenge: string;
    consentFor?: string;
  },
): Record<string, string> {
  const common = {
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  };
  if (provider === "github") return { ...common, prompt: "select_account" };
  const oidc = { ...common, scope: input.scopes.join(" "), nonce: input.nonce };
  if (provider === "cloudflare") return oidc;
  const google = {
    ...oidc,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: input.consentFor ? "select_account consent" : "select_account",
    login_hint: input.consentFor || "",
  };
  // a parameter with no value is not sent
  return Object.fromEntries(Object.entries(google).filter(([, value]) => value));
}

/** Whether a sign-in goes back for the consent screen once: Google issues a refresh token only on
 *  a consent, so a person with no connection yet whose answer carried none is asked again — once. */
export function signInNeedsConsent(input: {
  provider: SignInProvider;
  refreshToken: boolean;
  connected: boolean;
  bounced: boolean;
}): boolean {
  return input.provider === "google" && !input.refreshToken && !input.connected && !input.bounced;
}

/** Why a sign-in through a FAKE provider (a preview's pet shop, which mints any address) is
 *  refused: only addresses under the test-link domain may sign in that way, and none where the
 *  deployment has no test links. Null when admitted. */
export function fakeProviderEmailRefusal(
  email: string,
  testLinkDomain: string | null,
): string | null {
  if (!testLinkDomain) return "this deployment signs in with no fake provider";
  return email.toLowerCase().endsWith(`@${testLinkDomain}`)
    ? null
    : `a fake provider signs in addresses under ${testLinkDomain} alone`;
}

/** A LEND (secret/durable-object.ts): the lender's secret answers a borrower's use only while the
 *  lend is live, for the project it was lent to, and while the lender still reaches that project.
 *  A lend to every project (the deployment's own secret, lent by the operator) answers each project
 *  that still borrows it (`borrowing`: its path has not returned it), and the instance reaches
 *  every project. The path the borrower uses it as, or why the use is refused; `revoke` says the
 *  lend ends with it (the lender left the project: nothing would bring the lend back). */
export function lendVerdict(input: {
  lend: { to: string; as: string } | null;
  borrower: string;
  borrowing: boolean;
  lender: "instance" | { reachesBorrower: boolean };
}): { as: string } | { refused: string; revoke?: "membership-ended" } {
  if (!input.lend) return { refused: "this lend was revoked" };
  if (input.lend.to === "every-project" && !input.borrowing)
    return { refused: "this project no longer borrows this lend" };
  if (input.lend.to !== "every-project" && input.lend.to !== input.borrower)
    return { refused: "this lend is to another project" };
  if (input.lender !== "instance" && !input.lender.reachesBorrower)
    return {
      refused: "the lender is no longer a member of this project",
      revoke: "membership-ended",
    };
  return { as: input.lend.as };
}

/** Google's short names for its identity scopes, which a sign-in asks for and a token response may
 *  answer in either spelling. */
const GOOGLE_SCOPE_ALIASES: Record<string, string> = {
  email: "https://www.googleapis.com/auth/userinfo.email",
  profile: "https://www.googleapis.com/auth/userinfo.profile",
};

/** WHAT A PERSON'S ACCOUNT LACKS for a project (`itx.integrations.connect(provider, { account })`):
 *  the scopes `asked` that `granted` does not hold, in the order asked — none means the account is
 *  connected at once, any means an incremental consent on the person's own connection first. Google
 *  spells `email` and `profile` two ways; every other scope is compared as written. */
export function missingScopes(
  provider: string,
  granted: readonly string[],
  asked: readonly string[],
): string[] {
  const spelled = (scope: string) =>
    provider === "google" ? GOOGLE_SCOPE_ALIASES[scope] || scope : scope;
  const held = new Set(granted.map(spelled));
  return [...new Set(asked)].filter((scope) => !held.has(spelled(scope)));
}

/** WHAT A CONSENT GRANTED, off the token response (RFC 6749 §5.1): its `scope`, space-separated
 *  (a comma-separated one, as some providers send, too); the `asked` scope when the response names
 *  none, which the RFC allows only when the grant is exactly what was asked. A connection records
 *  these, never what it asked for, so a scope the person unticked is not claimed. */
export function grantedScopesOf(tokenResponse: unknown, asked: string): string[] {
  const scope =
    isRecord(tokenResponse) && typeof tokenResponse.scope === "string"
      ? tokenResponse.scope
      : asked;
  return [...new Set(scope.split(/[\s,]+/).filter(Boolean))];
}
