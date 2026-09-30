import { expect, test } from "vitest";
import { emailAllowed } from "./allowed-emails.ts";

const rows: [patterns: string[] | undefined, email: string, allowed: boolean][] = [
  // no list admits everyone
  [undefined, "anyone@anywhere.dev", true],
  // a domain wildcard: any local part, that domain exactly, whatever the case
  [["*@iterate.com"], "jonas@iterate.com", true],
  [["*@iterate.com"], " Jonas@Iterate.COM ", true],
  [["*@iterate.com"], "jonas@iterate.com.evil.dev", false],
  [["*@iterate.com"], "jonas@notiterate.com", false],
  [["*@iterate.com"], "jonas@sub.iterate.com", false],
  // a subdomain wildcard is spelled out
  [["*@*.iterate.com"], "jonas@sub.iterate.com", true],
  [["*@*.iterate.com"], "jonas@iterate.com", false],
  // an exact address, any of several patterns
  [["*@iterate.com", "friend@example.org"], "friend@example.org", true],
  [["*@iterate.com", "friend@example.org"], "other@example.org", false],
  // regex characters in a pattern are literal
  [["a.b@iterate.com"], "axb@iterate.com", false],
  [["a+tag@iterate.com"], "a+tag@iterate.com", true],
];
for (const [patterns, email, allowed] of rows)
  test(`emailAllowed(${JSON.stringify(patterns)}, ${JSON.stringify(email)}) → ${allowed}`, () => {
    expect(emailAllowed(patterns, email)).toBe(allowed);
  });
