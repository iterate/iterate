// ── the email code sign-in ── /login's email step (control-plane.ts `loginFormPost` calls these):
// a six-digit code mailed through the Email Sending binding, good for ten minutes and five tries.
// The browser holds only the challenge's id (a cookie); the challenge — the address, the code's
// hash, the tries — is a KV record that expires on its own. A test deployment (`testEmailLogin`)
// also accepts 424242, so the specs sign in without a mailbox; the reserved test domains
// (example.com, .test, …) are never mailed, on any deployment — mail to them bounces, and a bounce
// costs the sender's reputation.
import { z } from "zod";
import { codedError } from "iterate/next/lib";
import { cookieValueOf } from "iterate/next/principal";
import type { Env } from "./control-plane.ts";
import { appConfigOf } from "./app-config.ts";
import { directory, type User } from "./directory.ts";

const cookieName = "__Host-itx-login";
const cookieAttributes = "HttpOnly; Secure; SameSite=Lax; Path=/";
const LIFETIME_MS = 10 * 60_000;
/** The code every test deployment accepts (`testEmailLogin`), beside the mailed one. */
const TEST_LOGIN_CODE = "424242";

const Challenge = z.object({
  email: z.string(),
  /** sha256 of `<id>:<code>` — the id salts it */
  hash: z.string(),
  tries: z.number().int(),
  expiresAt: z.number().int(),
});
type Challenge = z.infer<typeof Challenge>;

const key = (id: string) => `login-code:${id}`;
/** RFC 2606 / 6761 names — no mailbox there ever exists. */
const reservedDomain = /@(example\.(com|net|org)|[^@]+\.(test|example|invalid|localhost))$/i;

async function hashOf(id: string, code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${id}:${code}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function putChallenge(env: Env, id: string, challenge: Challenge): Promise<void> {
  await env.OAUTH_KV.put(key(id), JSON.stringify(challenge), {
    // KV wants at least a minute of life; a try in the last minute may keep the record that long
    expiration: Math.max(Math.ceil(challenge.expiresAt / 1000), Math.ceil(Date.now() / 1000) + 60),
  });
}

async function challengeOf(
  env: Env,
  request: Request,
): Promise<{ id: string; challenge: Challenge } | null> {
  const id = cookieValueOf(request.headers.get("cookie"), cookieName);
  if (!id) return null;
  const stored = Challenge.safeParse(await env.OAUTH_KV.get(key(id), "json"));
  return stored.success && stored.data.expiresAt > Date.now()
    ? { id, challenge: stored.data }
    : null;
}

/** Whether this deployment signs people in by email at all: a mailbox to send from (the binding and
 *  a from address), or the test flag. */
export function emailSignInOffered(env: Env): boolean {
  const config = appConfigOf(env);
  return Boolean(env.EMAIL && config.loginEmailFrom) || config.testEmailLogin;
}

/** How often a code may go OUT: three to one address, and twenty from one client, in ten minutes —
 *  a counter per subject that expires with the window. KV counts are eventually consistent, so a
 *  burst at two edges may pass the cap by a little; what it protects is an inbox from a flood and
 *  the account's daily sending quota from one abuser. Only a mailed code counts (a reserved-domain
 *  address, or a deployment without a mailbox, sends nothing). */
async function mailAllowed(env: Env, address: string, client: string | null): Promise<boolean> {
  const caps = [
    [`login-code-rate:address:${address}`, 3],
    [`login-code-rate:client:${client || "unknown"}`, 20],
  ] as const;
  // both counters are read before either is charged: a refusal costs nothing
  const counts = await Promise.all(caps.map(([key]) => env.OAUTH_KV.get(key)));
  if (caps.some(([, limit], i) => (Number(counts[i]) || 0) >= limit)) return false;
  await Promise.all(
    caps.map(([key], i) =>
      env.OAUTH_KV.put(key, String((Number(counts[i]) || 0) + 1), {
        expirationTtl: LIFETIME_MS / 1000,
      }),
    ),
  );
  return true;
}

/** Start: mail a code to `email` and remember its hash; the cookie returned names the challenge.
 *  `client` is the caller's address (`cf-connecting-ip`), for the sending cap. */
export async function startLoginCode(
  env: Env,
  email: string,
  client: string | null = null,
): Promise<{ setCookie: string }> {
  const config = appConfigOf(env);
  if (!emailSignInOffered(env)) throw codedError("UNAUTHENTICATED", "Sign in with Google.");
  const address = email.trim().toLowerCase();
  if (!z.email().safeParse(address).success) throw codedError("INVALID_INPUT", "Enter an email.");
  const mailing = Boolean(env.EMAIL && config.loginEmailFrom && !reservedDomain.test(address));
  if (mailing && !(await mailAllowed(env, address, client)))
    throw codedError(
      "INVALID_INPUT",
      "Too many codes were sent for that address just now. Wait a few minutes and try again.",
    );
  const id = crypto.randomUUID();
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
  await putChallenge(env, id, {
    email: address,
    hash: await hashOf(id, code),
    tries: 0,
    expiresAt: Date.now() + LIFETIME_MS,
  });
  if (mailing) {
    try {
      const sent = await env.EMAIL!.send({
        to: address,
        from: config.loginEmailFrom,
        subject: `${code} is your iterate sign-in code`,
        text: `${code}\n\nEnter this code to sign in to iterate. It expires in 10 minutes.\n\nIf you did not try to sign in, ignore this email.`,
        html: `<p style="font:15px/1.5 ui-sans-serif,system-ui,sans-serif;color:#18181b;margin:0 0 8px">Enter this code to sign in to iterate:</p><p style="font:600 32px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.2em;color:#18181b;margin:0 0 16px">${code}</p><p style="font:13px/1.5 ui-sans-serif,system-ui,sans-serif;color:#71717a;margin:0">It expires in 10 minutes. If you did not try to sign in, ignore this email.</p>`,
      });
      console.log(
        JSON.stringify({ event: "login-code.sent", to: address, messageId: sent.messageId }),
      );
    } catch (error) {
      // a test deployment still has its test code; anywhere else the person must hear about it
      console.error("login-code.send-failed", error);
      if (!config.testEmailLogin)
        throw codedError("INVALID_INPUT", "The code could not be sent. Try again.");
    }
  }
  return { setCookie: `${cookieName}=${id}; ${cookieAttributes}; Max-Age=${LIFETIME_MS / 1000}` };
}

/** The address a code went to, when the browser is mid sign-in — the page shows the code step. */
export async function loginCodePending(env: Env, request: Request): Promise<string | null> {
  return (await challengeOf(env, request))?.challenge.email || null;
}

/** Finish: `code` against the challenge the cookie names. Right → the user (created on first
 *  sign-in), the challenge spent. Wrong → one try fewer, `{ error }`; none left, or no live
 *  challenge (expired, restarted) → `{ error, restart: true }`: back to the email step. */
export async function finishLoginCode(
  env: Env,
  request: Request,
  code: string,
): Promise<{ user: User } | { error: string; restart?: true }> {
  const found = await challengeOf(env, request);
  if (!found) return { error: "That code has expired. Enter your email again.", restart: true };
  const { id, challenge } = found;
  const entered = code.replace(/\D/g, "");
  const right =
    (appConfigOf(env).testEmailLogin && entered === TEST_LOGIN_CODE) ||
    (entered.length === 6 && (await hashOf(id, entered)) === challenge.hash);
  if (!right) {
    // the fifth wrong try ends the challenge
    if (challenge.tries + 1 >= 5) {
      await env.OAUTH_KV.delete(key(id));
      return { error: "Too many tries. Enter your email again for a new code.", restart: true };
    }
    await putChallenge(env, id, { ...challenge, tries: challenge.tries + 1 });
    return { error: "That code is not right. Try again." };
  }
  await env.OAUTH_KV.delete(key(id));
  return { user: await directory(env.DB).upsertUser(challenge.email) };
}

/** The cookie's end — a sign-in finished, or the person starting over with another email. */
export const clearLoginCookie = `${cookieName}=; ${cookieAttributes}; Max-Age=0`;
