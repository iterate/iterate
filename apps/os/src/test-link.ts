// test-link.ts — THE ONE-CLICK SIGN-IN LINK of a per-PR preview (and local dev): a signed URL that
// signs the browser in to the issuer as one reserved test address and sends it on, so a reviewer
// opens a PR's Dash from the PR body without typing an email or a password. It restores #2485's
// preview `Login ↗` for the in-worker issuer. Pure — WebCrypto and nothing else — so
// scripts/preview.ts mints with the very code the worker verifies with (worker.ts
// `/.auth/test-link`, issuer-session.ts `testLinkResponse`).
//
// The token is `base64url(JSON claims).base64url(HMAC-SHA256)`. Why it is not a standing
// credential:
//   • OFF unless `login.testLink` is configured, which app-config.ts refuses unless `urls.os` is a
//     workers.dev or localhost origin — prd can never turn it on; only previewWranglerConfig (the
//     config `wrangler preview` reads, never deploy.ts's) and local dev set it.
//   • `aud` must be the redeeming deployment's platform origin: every preview inherits one
//     `secrets.key`, yet a link minted for pr123's preview is refused on pr124's.
//   • it names one email, which must be under `login.testLink.emailDomain` (`.test` is reserved:
//     nothing ever mails it), and it expires (CI mints 14 days and re-mints on every push); the
//     preview, and the link with it, is deleted when the PR closes.
//   • every claim is under the MAC: nobody edits the link into another person, another `next` or
//     another client list.

/** Where the worker redeems a link, beside `/version` on the platform origin. */
export const TEST_LINK_PATH = "/.auth/test-link";

/** The reserved domain the preview's test people live under: `pr<N>@preview.iterate.test`.
 *  `.test` is RFC 6761's — password-and-code-sign-in.ts never mails it. */
export const TEST_LINK_EMAIL_DOMAIN = "preview.iterate.test";

/** A preview's CI identity: the person `pr<N>@preview.iterate.test`, whose project is `pr<N>` —
 *  scripts/preview.ts seeds the pair, and consent.ts auto-approves a sibling app for exactly that
 *  project (the email's local part). */
export const testLinkIdentityOf = (prNumber: string) => ({
  email: `pr${prNumber}@${TEST_LINK_EMAIL_DOMAIN}`,
  project: `pr${prNumber}`,
});

/** What a link says, all of it under the MAC. `clients` are the origins of the sibling app
 *  previews CI deployed beside this one: consent.ts approves their authorization without the Allow
 *  page for this session (issuer-session.ts stamps them on the grant). */
type TestLinkClaims = {
  v: 1;
  /** the platform origin the link is for (`platformAddressesOf`) */
  aud: string;
  email: string;
  /** where the browser goes once signed in: the platform origin, or an app preview's page */
  next: string;
  clients: string[];
  /** expiry, epoch milliseconds */
  exp: number;
};

/** Mint a link's token (`?t=` on `TEST_LINK_PATH`). `key` is the deployment's `secrets.key`: the
 *  HMAC key derives from it under its own label, so the raw key is never reused. */
export async function mintTestLink(input: {
  key: string;
  audience: string;
  email: string;
  next: string;
  clients: string[];
  expiresAt: number;
}) {
  const claims: TestLinkClaims = {
    v: 1,
    aud: input.audience,
    email: input.email,
    next: input.next,
    clients: input.clients,
    exp: input.expiresAt,
  };
  const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKeyOf(input.key),
    new TextEncoder().encode(payload),
  );
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

/** THE REDEMPTION DECISION, pure: what `GET /.auth/test-link?t=` answers before any effect. 404
 *  where the deployment has no `login.testLink`; 403 with a plain reason for a link that is not this
 *  deployment's to honour; else who to sign in and where to send them. */
export async function redeemTestLink(
  token: string | null,
  deployment: {
    /** `login.testLink`; absent ⇒ the route does not exist */
    testLink: { emailDomain: string } | undefined;
    key: string;
    platformOrigin: string;
    now: number;
  },
): Promise<
  | { status: 404 | 403; message: string }
  | { status: 302; email: string; project: string; next: string; clients: string[] }
> {
  if (!deployment.testLink) return { status: 404, message: "Not found" };
  const refuse = (message: string) => ({ status: 403 as const, message });
  const [payload, signature, ...rest] = (token || "").split(".");
  if (!payload || !signature || rest.length) return refuse("This sign-in link is malformed.");
  const bytes = fromBase64url(signature);
  const valid =
    bytes &&
    (await crypto.subtle.verify(
      "HMAC",
      await hmacKeyOf(deployment.key),
      bytes,
      new TextEncoder().encode(payload),
    ));
  if (!valid) return refuse("This sign-in link's signature is not valid here.");
  const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload)!)) as TestLinkClaims;
  if (claims.v !== 1) return refuse("This sign-in link is of an unknown version.");
  if (claims.aud !== deployment.platformOrigin)
    return refuse(`This sign-in link is for ${claims.aud}, not this deployment.`);
  if (claims.exp <= deployment.now)
    return refuse("This sign-in link has expired. The next push to the PR mints a fresh one.");
  const [local, domain] = claims.email.split("@");
  if (!local || domain !== deployment.testLink.emailDomain)
    return refuse(
      `This sign-in link is for an address outside ${deployment.testLink.emailDomain}.`,
    );
  if (!isLinkedOrigin(claims.next, deployment.platformOrigin))
    return refuse("This sign-in link leads somewhere this deployment does not send people.");
  if (!claims.clients.every((client) => isLinkedOrigin(client, deployment.platformOrigin)))
    return refuse("This sign-in link names a client this deployment does not approve.");
  return {
    status: 302,
    email: claims.email,
    project: local,
    next: claims.next,
    clients: claims.clients,
  };
}

/** Where a link may send a browser, and which clients it may pre-approve: the platform origin
 *  itself, or another preview's (an https workers.dev origin — the app previews beside it) or a
 *  local one (localhost, 127.0.0.1). Signed as it is, `next` is still never an arbitrary site. */
function isLinkedOrigin(value: string, platformOrigin: string) {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.origin === platformOrigin) return true;
  if (url.protocol === "https:" && url.hostname.endsWith(".workers.dev")) return true;
  return ["localhost", "127.0.0.1"].includes(url.hostname);
}

/** The HMAC key: SHA-256 of `iterate-test-link:<secrets.key>` — the key under its own label, as
 *  app-config.ts `sessionSigningSecretOf` derives the session-signing secret under another. */
async function hmacKeyOf(key: string) {
  const derived = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`iterate-test-link:${key}`),
  );
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** null for anything that is not base64url. */
function fromBase64url(text: string) {
  // a length ≡ 1 (mod 4) is no whole byte: `atob` would throw on it
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
