// fetch-door-egress-missing-secret-502.e2e.test.ts — fetch OUT: `itx.fetch(request)` is THE egress
// door (the tutorial's chapter 2), a Request through the context's own terminal. The DO's egress
// terminal is the LAST door that owns the project scope — a `{{secret:project:NAME}}` token that
// survives substitution means no such secret is stored, and forwarding it would leak the secret's
// NAME to the destination and send a garbage credential in its place. The door scans the
// substituted request (URL first, then every header) and answers 502 BEFORE the FALLBACK terminal.
// `platform`-scope tokens are not this door's business — the next door down owns those. In solo,
// FALLBACK=DummyControlPlane does a bare `fetch(request)`, so a request that PASSES the door goes
// out to the network; the 502 cases never reach it, which is exactly what makes them observable.

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

test("a missing project secret in the URL query is a loud 502 naming the URL", async () => {
  // substituteHeaderSecrets rebuilds ONLY headers, so the door sweeps the substituted request's URL
  // too — checked FIRST, before the header sweep.
  const res = await egress("&access_token={{secret:project:GHOST}}");
  expect(res.status).toBe(502);
  const body = await res.text();
  expect(body).toMatch(/no stored project secret/);
  expect(body).toContain("{{secret:project:GHOST}}");
  expect(body).toContain("in the request URL");
});

test("a platform-scope token does NOT trip our door (the next door owns platform scope)", async () => {
  // A platform-only request would pass the door into the solo self-loop, so "forwarded untouched"
  // is not observable here. What IS observable: the door checks the URL BEFORE the headers, so a
  // platform token in the URL alongside an unresolved project token in a header is a discriminator —
  // if the door wrongly matched platform scope, the 502 would name the URL token; instead it names
  // the header's project token, proving the platform token sailed past.
  const res = await egress("&pass={{secret:platform:X}}", {
    "x-hunt-auth": "{{secret:project:GHOST}}",
  });
  expect(res.status).toBe(502);
  const body = await res.text();
  expect(body).toContain('header "x-hunt-auth"'); // the PROJECT token, in the header, tripped it
  expect(body).not.toContain("in the request URL"); // the URL's platform token did NOT
  expect(body).not.toContain("platform"); // and the platform token is nowhere in the refusal
});
