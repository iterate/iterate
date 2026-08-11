import { expect, test } from "vitest";
import { emailFromJwt } from "./jwt-claims.ts";

const fakeJwt = (claims: object) =>
  `eyJhbGciOiJFUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`;

test("reads the email claim out of an access token", () => {
  expect(emailFromJwt(fakeJwt({ sub: "u1", email: "pr2462+test@nustom.com" }))).toBe(
    "pr2462+test@nustom.com",
  );
});

// The claim is optional in AccessTokenClaims (apps/auth/src/lib/session.ts)
// and tokens from elsewhere are arbitrary — anything unexpected must read as
// "no email", never throw.
test("anything that isn't a JWT with a string email claim reads as null", () => {
  expect(emailFromJwt(fakeJwt({ sub: "u1" }))).toBeNull();
  expect(emailFromJwt(fakeJwt({ email: 42 }))).toBeNull();
  expect(emailFromJwt("not-a-jwt")).toBeNull();
  expect(emailFromJwt("a.!!!not-base64!!!.c")).toBeNull();
  expect(emailFromJwt(`a.${Buffer.from("[1,2,3]").toString("base64url")}.c`)).toBeNull();
  expect(emailFromJwt("")).toBeNull();
});
