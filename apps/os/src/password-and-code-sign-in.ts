// ── the sign-in mechanisms without an identity provider ── /login's form posts (issuer-pages.ts
// `loginFormPost` calls these):
//
//   THE PASSWORD (`login.password`): one global password — anyone who knows it signs in as the email
//   they type; the membership is the password, the email is the name tag. The self-host default,
//   and how the specs sign in. Wrong attempts are counted, per email and per client.
//
//   THE MAILED CODE (`login.emailCode`): a six-digit code mailed through the Email Sending binding,
//   good for ten minutes and five tries. The browser holds only the challenge's id (a cookie); the
//   challenge — the address, the code's hash, the tries — is a KV record that expires on its own.
//   The reserved test domains (example.com, .test, …) are never mailed, on any deployment — mail to
//   them bounces, and a bounce costs the sender's reputation.
import { z } from "zod";
import { codedError } from "iterate/next/lib";
import { cookieValueOf } from "iterate/next/principal";
import type { Env } from "./env.ts";
import { appConfigOf } from "./app-config.ts";
import { directory, type User } from "./directory.ts";

const cookieName = "__Host-itx-login";
const cookieAttributes = "HttpOnly; Secure; SameSite=Lax; Path=/";
const LIFETIME_MS = 10 * 60_000;

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

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function hashOf(id: string, code: string): Promise<string> {
  return Array.from(await sha256(`${id}:${code}`), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Whether two secrets are the same, in time that does not depend on where they differ: both are
 *  hashed (fixed length) and the digests compared byte by byte, every byte. */
async function secretsEqual(candidate: string, secret: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(candidate), sha256(secret)]);
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

/** The address as the directory knows it: trimmed, lowercased, and an email at all. */
function addressOf(email: string): string {
  const address = email.trim().toLowerCase();
  if (!z.email().safeParse(address).success) throw codedError("INVALID_INPUT", "Enter an email.");
  return address;
}

/** A counter per subject that expires with the window (ten minutes). KV counts are eventually
 *  consistent, so a burst at two edges may pass a cap by a little; what the caps protect is an inbox
 *  from a flood, the account's daily sending quota from one abuser, and the password from a guess. */
async function countersOf(env: Env, keys: readonly string[]): Promise<number[]> {
  return (await Promise.all(keys.map((key) => env.OAUTH_KV.get(key)))).map(
    (count) => Number(count) || 0,
  );
}
async function charge(env: Env, keys: readonly string[], counts: number[]): Promise<void> {
  await Promise.all(
    keys.map((key, i) =>
      env.OAUTH_KV.put(key, String(counts[i]! + 1), { expirationTtl: LIFETIME_MS / 1000 }),
    ),
  );
}

// ── the password ──

/** `password` for `email`: right → the user (created on first sign-in); wrong → `{ error }`, one
 *  more wrong attempt on the books. Five wrong attempts per email, twenty per client (`client` is the
 *  caller's address, `cf-connecting-ip`), in ten minutes; over either cap the attempt is refused
 *  before the password is even looked at. */
export async function signInWithPassword(
  env: Env,
  email: string,
  password: string,
  client: string | null = null,
): Promise<{ user: User } | { error: string }> {
  const secret = appConfigOf(env).login.password.exposeSecret();
  if (!secret) throw codedError("UNAUTHENTICATED", "Password sign-in is not offered here.");
  const address = addressOf(email);
  const keys = [
    `login-password-rate:address:${address}`,
    `login-password-rate:client:${client || "unknown"}`,
  ] as const;
  const counts = await countersOf(env, keys);
  if (counts[0]! >= 5 || counts[1]! >= 20) return { error: "Too many tries. Wait a few minutes." };
  if (!(await secretsEqual(password, secret))) {
    await charge(env, keys, counts);
    return { error: "That password is not right." };
  }
  return { user: await directory(env.DB).upsertUser(address) };
}

// ── the mailed code ──

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

/** How often a code may go OUT: three to one address, and twenty from one client, in ten minutes. */
async function mailAllowed(env: Env, address: string, client: string | null): Promise<boolean> {
  const keys = [
    `login-code-rate:address:${address}`,
    `login-code-rate:client:${client || "unknown"}`,
  ] as const;
  // both counters are read before either is charged: a refusal costs nothing
  const counts = await countersOf(env, keys);
  if (counts[0]! >= 3 || counts[1]! >= 20) return false;
  await charge(env, keys, counts);
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
  if (!(env.EMAIL && config.login.emailCode))
    throw codedError("UNAUTHENTICATED", "Email sign-in is not offered here.");
  const address = addressOf(email);
  if (reservedDomain.test(address))
    throw codedError("INVALID_INPUT", "Enter an email that can receive mail.");
  if (!(await mailAllowed(env, address, client)))
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
  try {
    const sent = await env.EMAIL.send({
      to: address,
      from: config.login.emailCode.from,
      subject: `${code} is your iterate sign-in code`,
      text: `${code}\n\nEnter this code to sign in to iterate. It expires in 10 minutes.\n\nIf you did not try to sign in, ignore this email.`,
      html: `<p style="font:15px/1.5 ui-sans-serif,system-ui,sans-serif;color:#18181b;margin:0 0 8px">Enter this code to sign in to iterate:</p><p style="font:600 32px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.2em;color:#18181b;margin:0 0 16px">${code}</p><p style="font:13px/1.5 ui-sans-serif,system-ui,sans-serif;color:#71717a;margin:0">It expires in 10 minutes. If you did not try to sign in, ignore this email.</p>`,
    });
    console.log(
      JSON.stringify({ event: "login-code.sent", to: address, messageId: sent.messageId }),
    );
  } catch (error) {
    console.error("login-code.send-failed", error);
    await env.OAUTH_KV.delete(key(id));
    throw codedError("INVALID_INPUT", "The code could not be sent. Try again.");
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
  const right = entered.length === 6 && (await hashOf(id, entered)) === challenge.hash;
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
