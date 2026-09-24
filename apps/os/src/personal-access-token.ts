// A PERSONAL ACCESS TOKEN: iterate's own API key. A person mints one (grants.ts `mint`, from the
// Dash's Sessions page or `iterate tokens create`); their account keeps its SHA-256, never the key
// (src/account/contract.ts `personalAccessTokens`); and oauth.ts `validateToken` admits its bearer at
// `/api`, at `/mcp` and on the hosts of the projects it covers. One key works in all three places.
// An OAuth access token cannot do that: each one is bound to one resource (RFC 8707).
//
// THE FORMAT, `itk_<user>_<key>_<secret><checksum>` (103 characters, under the Kit's 128-byte key
// field, apps/kit/src/firmware/config-image.ts):
//   itk_       the prefix, so a leaked key is recognisable in a log, a paste or a repository
//   <user>     32 hex, the person's id without `user_`: whose account holds the key
//   <key>      16 hex, the key's id without `pat_`: which of the account's keys it is
//   <secret>   43 base62 characters, 256 random bits
//   <checksum> 6 base62 characters, the CRC32 of everything before it, as GitHub's tokens carry one
//              (https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/):
//              a secret scanner, and the validator, tell a key from look-alike text without a lookup
// A secret-scanning pattern: `\bitk_[0-9a-f]{32}_[0-9a-f]{16}_[0-9A-Za-z]{49}\b`.
//
// THE INDEX, what makes a key prove itself before any Durable Object is dialled: `OAUTH_KV` holds
// `personal-access-token:<the key's SHA-256>` → its person and id, from the mint (before the key is
// answered) until it is revoked or expires. The format and the CRC32 are public arithmetic and user
// ids are not secret (they are in every key, `whoami` and event stamps), so anyone can write a
// well-formed key under any person's id; only the whole key, its 256-bit secret included, hashes to
// an entry. oauth.ts reads the index first and refuses a miss on that one KV read, as the OAuth
// library refuses an access token its KV does not hold. Only a hit reads the person's account,
// which stays the truth of the key: its hash, its end, its expiry. An entry the account does not
// back (a record that failed to land, an end whose clean-up failed) admits nothing.

const PREFIX = "itk_";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SHAPE = /^itk_([0-9a-f]{32})_([0-9a-f]{16})_[0-9A-Za-z]{43}([0-9A-Za-z]{6})$/;

/** Whether `token` claims to be a personal access token: the validator's branch, before any check. */
export const isPersonalAccessToken = (token: string) => token.startsWith(PREFIX);

/** A new key for `userId`: its id, the bearer (answered once, then only its hash exists) and that
 *  hash. The id and user are readable in the bearer; the 256-bit secret is what proves it. */
export async function newPersonalAccessToken(userId: string) {
  // control-plane/catalog.ts `newId` mints `user_` and 32 hex; the key reads the account back from it
  const user = /^user_([0-9a-f]{32})$/.exec(userId)?.[1];
  if (!user) throw new Error(`A personal access token needs a user id of 32 hex, not ${userId}.`);
  const key = [...crypto.getRandomValues(new Uint8Array(8))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  let secret = "";
  // Rejection sampling: 248 is the largest multiple of 62 a byte holds, so every character is
  // equally likely.
  while (secret.length < 43)
    for (const byte of crypto.getRandomValues(new Uint8Array(64)))
      if (byte < 248 && secret.length < 43) secret += BASE62[byte % 62];
  const body = `${PREFIX}${user}_${key}_${secret}`;
  const token = `${body}${checksum(body)}`;
  return { id: `pat_${key}`, token, hash: await personalAccessTokenHash(token) };
}

/** The account and key a bearer names: null unless it has the format above and its checksum holds.
 *  Nothing here is secret or verified: anyone can compute a checksum. The index, then the account's
 *  hash, are what admit the key. */
export function parsePersonalAccessToken(token: string) {
  const match = SHAPE.exec(token);
  if (!match || checksum(token.slice(0, -6)) !== match[3]) return null;
  return { userId: `user_${match[1]}`, id: `pat_${match[2]}` };
}

/** The SHA-256 of a key, in hex: all the account keeps. A salt or a slow hash would buy nothing for
 *  256 random bits, which no dictionary holds. */
export async function personalAccessTokenHash(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether a presented key's SHA-256 is the account's `hash`, compared in constant time with
 *  Workers' `crypto.subtle.timingSafeEqual`
 *  (https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/). */
export function personalAccessTokenHashMatches(presented: string, hash: string) {
  const left = new TextEncoder().encode(presented);
  const right = new TextEncoder().encode(hash);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}

const indexKey = (hash: string) => `personal-access-token:${hash}`;

/** The key's entry in the index (above), written by the mint before its record lands. An expiring
 *  key's entry expires with it (KV refuses an expiry under a minute away, so never sooner than two
 *  minutes: the account refuses the key past its own expiry either way). */
export async function indexPersonalAccessToken(
  kv: KVNamespace,
  key: { hash: string; userId: string; id: string; expiresAt: number | null },
) {
  await kv.put(
    indexKey(key.hash),
    JSON.stringify({ userId: key.userId, id: key.id }),
    key.expiresAt === null
      ? {}
      : {
          expiration: Math.max(
            Math.ceil(key.expiresAt / 1000),
            Math.floor(Date.now() / 1000) + 120,
          ),
        },
  );
}

/** Whether the index holds the key whose SHA-256 is `hash`, under the person and id it names. */
export async function personalAccessTokenIndexed(
  kv: KVNamespace,
  hash: string,
  named: { userId: string; id: string },
) {
  const entry = await kv.get<{ userId?: unknown; id?: unknown }>(indexKey(hash), "json");
  return entry?.userId === named.userId && entry.id === named.id;
}

/** The key's entry gone, after its end landed on the account (the revocation truth). */
export async function unindexPersonalAccessToken(kv: KVNamespace, hash: string) {
  await kv.delete(indexKey(hash));
}

/** The CRC32 (IEEE, reflected, as zlib computes it) of `body`, as 6 base62 characters. */
function checksum(body: string) {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(body)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  let value = (crc ^ 0xffffffff) >>> 0;
  let encoded = "";
  for (let digit = 0; digit < 6; digit++) {
    encoded = BASE62[value % 62] + encoded;
    value = Math.floor(value / 62);
  }
  return encoded;
}
