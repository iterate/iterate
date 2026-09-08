// fetch-door-egress-missing-secret-502.e2e.test.ts — fetch OUT: `itx.fetch(request)` is THE egress
// door (the tutorial's chapter 2), a Request through the context's own terminal. The DO's egress
// terminal is the LAST door that owns the project scope — a `{{secret:project:NAME}}` token that
// survives substitution means no such secret is stored, and forwarding it would leak the secret's
// NAME to the destination and send a garbage credential in its place. The door scans the
// request (URL first, then every header) as it substitutes and answers 502 BEFORE the terminal
// `fetch`. A request that PASSES the door goes out to the network; the 502 cases never reach it,
// which is exactly what makes them observable.

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

/** Send a Request through a fresh context's egress terminal, with test query/headers. (WHATWG URL
 *  serialization keeps `{{`/`}}` literal in the query — verified — so a URL token arrives at the
 *  door byte-identical.) The Response rides back over capnweb. */
const egress = (query: string, headers?: Record<string, string>): Promise<Response> =>
  openItx(freshCtx("egress")).fetch(
    new Request(`https://egress.invalid/hunt?probe=1${query}`, { headers }),
  );

test("a missing project secret in a HEADER is a loud 502 naming the header and the token", async () => {
  const res = await egress("", { "x-hunt-auth": "Bearer {{secret:project:GHOST}}" });
  expect(res.status).toBe(502);
  const body = await res.text();
  expect(body).toMatch(/no stored project secret/);
  expect(body).toContain("{{secret:project:GHOST}}"); // the token is named to US, not the destination
  expect(body).toContain('header "x-hunt-auth"'); // …and WHERE it sat, so the caller can fix it
});

test("a missing project secret in the URL query is a loud 502 naming the URL — checked FIRST, before the headers", async () => {
  const res = await egress("&access_token={{secret:project:GHOST}}", {
    "x-hunt-auth": "{{secret:project:GHOST}}",
  });
  expect(res.status).toBe(502);
  const body = await res.text();
  expect(body).toMatch(/no stored project secret/);
  expect(body).toContain("{{secret:project:GHOST}}");
  expect(body).toContain("in the request URL");
  expect(body).not.toContain("x-hunt-auth");
});
