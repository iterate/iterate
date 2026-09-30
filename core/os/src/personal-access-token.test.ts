import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { expect, test } from "vitest";
import {
  isPersonalAccessToken,
  newPersonalAccessToken,
  parsePersonalAccessToken,
} from "./personal-access-token.ts";

const userId = `user_${"0123456789abcdef".repeat(2)}`;

test("a new key: the scannable format, its id and user readable back, its SHA-256 the only thing kept", async () => {
  const { id, token, hash } = await newPersonalAccessToken(userId);
  expect(token).toMatch(/^itk_[0-9a-f]{32}_[0-9a-f]{16}_[0-9A-Za-z]{49}$/);
  expect(token).toHaveLength(103); // under the Kit config image's 128-byte key field
  expect(id).toMatch(/^pat_[0-9a-f]{16}$/);
  expect(isPersonalAccessToken(token)).toBe(true);
  expect(parsePersonalAccessToken(token)).toEqual({ userId, id });
  expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
  // the checksum is zlib's CRC32 of everything before it, in six base62 digits
  const checksum = [...token.slice(-6)].reduce(
    (value, digit) =>
      value * 62 + "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".indexOf(digit),
    0,
  );
  expect(checksum).toBe(crc32(token.slice(0, -6)));
  // two keys share nothing but the prefix and the user
  const other = await newPersonalAccessToken(userId);
  expect(other).not.toMatchObject({ id });
  expect(other.token.slice(54)).not.toBe(token.slice(54));
});

test("a bearer is a key's only if its shape and checksum hold; nothing is looked up for the rest", async () => {
  const { token } = await newPersonalAccessToken(userId);
  const secretStart = "itk_".length + 32 + 1 + 16 + 1;
  const flipped = token[secretStart] === "a" ? "b" : "a";
  for (const bearer of [
    `${token.slice(0, secretStart)}${flipped}${token.slice(secretStart + 1)}`, // one secret character
    token.slice(0, -1), // truncated
    `${token}x`,
    token.toUpperCase(),
    "itk_",
    "user_x:grant:secret", // the OAuth library's shape
  ])
    expect(parsePersonalAccessToken(bearer)).toBeNull();
});

test("a key names its account by the user id's 32 hex, so any other id is refused at the mint", async () => {
  await expect(newPersonalAccessToken("user_1")).rejects.toThrow(/32 hex/);
  await expect(newPersonalAccessToken("admin")).rejects.toThrow(/32 hex/);
});
