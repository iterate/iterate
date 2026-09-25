import { expect, test } from "vitest";
import {
  isIterateSignInChallenge,
  pathsIngressRefusalOf,
  projectHostCallerOf,
  projectHostSignInAnswerOf,
  type ProjectHostCaller,
} from "./project-host-sign-in.ts";

const HOST = "https://site--acme.projects.test";

// ── rules 1–4: who arrives ──
test.for<{
  name: string;
  authorization: { via: "bearer" | "cookie"; reachesProject: boolean } | null;
  method: string;
  headers: Record<string, string>;
  arrivesAs: ProjectHostCaller;
}>([
  {
    name: "no credential",
    authorization: null,
    method: "GET",
    headers: {},
    arrivesAs: "anonymous",
  },
  {
    name: "a bearer that does not reach the project",
    authorization: { via: "bearer", reachesProject: false },
    method: "GET",
    headers: {},
    arrivesAs: "non-member",
  },
  {
    name: "a cookie that does not reach the project",
    authorization: { via: "cookie", reachesProject: false },
    method: "POST",
    headers: { origin: HOST },
    arrivesAs: "non-member",
  },
  {
    name: "a member's cookie on a cross-site GET",
    authorization: { via: "cookie", reachesProject: true },
    method: "GET",
    headers: { origin: "https://evil.example" },
    arrivesAs: "member",
  },
  {
    name: "a member's cookie on a same-origin POST",
    authorization: { via: "cookie", reachesProject: true },
    method: "POST",
    headers: { origin: HOST },
    arrivesAs: "member",
  },
  {
    name: "a member's cookie on a POST with no Origin",
    authorization: { via: "cookie", reachesProject: true },
    method: "POST",
    headers: {},
    arrivesAs: "member",
  },
  {
    name: "a member's cookie on a cross-site POST",
    authorization: { via: "cookie", reachesProject: true },
    method: "POST",
    headers: { origin: "https://evil.example" },
    arrivesAs: "anonymous",
  },
  {
    name: "a member's cookie on a POST from a sibling project host",
    authorization: { via: "cookie", reachesProject: true },
    method: "DELETE",
    headers: { origin: "https://other--acme.projects.test" },
    arrivesAs: "anonymous",
  },
  {
    name: "a member's cookie on a POST from a sandboxed document (Origin: null)",
    authorization: { via: "cookie", reachesProject: true },
    method: "POST",
    headers: { origin: "null" },
    arrivesAs: "anonymous",
  },
  {
    name: "a member's cookie on a cross-site WebSocket upgrade",
    authorization: { via: "cookie", reachesProject: true },
    method: "GET",
    headers: { upgrade: "websocket", origin: "https://evil.example" },
    arrivesAs: "anonymous",
  },
  {
    name: "a member's cookie on a same-origin WebSocket upgrade",
    authorization: { via: "cookie", reachesProject: true },
    method: "GET",
    headers: { upgrade: "WebSocket", origin: HOST },
    arrivesAs: "member",
  },
  {
    name: "a member's bearer on a cross-site POST",
    authorization: { via: "bearer", reachesProject: true },
    method: "POST",
    headers: { origin: "https://evil.example" },
    arrivesAs: "member",
  },
])("$name → $arrivesAs", ({ authorization, method, headers, arrivesAs }) => {
  const request = new Request(`${HOST}/x`, { method, headers });
  expect(projectHostCallerOf({ authorization, request })).toBe(arrivesAs);
});

// ── rules 5–7: the app's answer, as the browser or client gets it ──
const NAVIGATE = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
test.for<{
  name: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  caller: ProjectHostCaller;
  status?: number;
  wwwAuthenticate?: string;
  becomes: { status: number; location?: string } | "unchanged";
}>([
  {
    name: "anonymous navigation",
    url: `${HOST}/notes?view=all`,
    headers: NAVIGATE,
    caller: "anonymous",
    becomes: { status: 302, location: "/.auth/login?next=%2Fnotes%3Fview%3Dall" },
  },
  {
    name: "anonymous navigation under paths keeps the base path",
    url: "https://os.test/projects/acme/site/notes",
    headers: NAVIGATE,
    caller: "anonymous",
    becomes: { status: 302, location: "/.auth/login?next=%2Fprojects%2Facme%2Fsite%2Fnotes" },
  },
  {
    name: "non-member navigation",
    headers: NAVIGATE,
    caller: "non-member",
    becomes: { status: 302, location: "/.auth/login?project=acme&next=%2Fx" },
  },
  {
    name: "HEAD navigation",
    method: "HEAD",
    headers: NAVIGATE,
    caller: "anonymous",
    becomes: { status: 302, location: "/.auth/login?next=%2Fx" },
  },
  {
    name: "no Sec-Fetch headers, Accept: text/html",
    headers: { accept: "text/html,application/xhtml+xml" },
    caller: "anonymous",
    becomes: { status: 302, location: "/.auth/login?next=%2Fx" },
  },
  {
    name: "a path that would leave the host (`//evil.example`) returns to /",
    url: `${HOST}//evil.example/x`,
    headers: NAVIGATE,
    caller: "anonymous",
    becomes: { status: 302, location: "/.auth/login?next=%2F" },
  },
  {
    name: "the challenge among others, scheme in any case",
    headers: NAVIGATE,
    caller: "anonymous",
    wwwAuthenticate: 'Basic realm="a, b", BEARER error="x", Realm=iterate',
    becomes: { status: 302, location: "/.auth/login?next=%2Fx" },
  },
  { name: "anonymous fetch", headers: {}, caller: "anonymous", becomes: "unchanged" },
  {
    name: "non-member fetch",
    headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
    caller: "non-member",
    becomes: { status: 403 },
  },
  {
    name: "anonymous navigation into a frame",
    headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
    caller: "anonymous",
    becomes: "unchanged",
  },
  {
    name: "anonymous POST from a page",
    method: "POST",
    headers: { ...NAVIGATE, accept: "text/html" },
    caller: "anonymous",
    becomes: "unchanged",
  },
  { name: "non-member POST", method: "POST", caller: "non-member", becomes: { status: 403 } },
  {
    name: "anonymous WebSocket upgrade",
    headers: { upgrade: "websocket", accept: "text/html" },
    caller: "anonymous",
    becomes: "unchanged",
  },
  {
    name: "non-member WebSocket upgrade",
    headers: { upgrade: "websocket" },
    caller: "non-member",
    becomes: { status: 403 },
  },
  { name: "a member's 401", headers: NAVIGATE, caller: "member", becomes: "unchanged" },
  {
    name: "an app's own Basic challenge",
    headers: NAVIGATE,
    caller: "anonymous",
    wwwAuthenticate: 'Basic realm="iterate"',
    becomes: "unchanged",
  },
  {
    name: "an app's own Bearer realm",
    headers: NAVIGATE,
    caller: "non-member",
    wwwAuthenticate: 'Bearer realm="my-app"',
    becomes: "unchanged",
  },
  {
    name: "a Bearer challenge naming no realm",
    headers: NAVIGATE,
    caller: "anonymous",
    wwwAuthenticate: 'Bearer error="invalid_token"',
    becomes: "unchanged",
  },
  {
    name: "a 403 carrying the challenge",
    headers: NAVIGATE,
    caller: "anonymous",
    status: 403,
    becomes: "unchanged",
  },
  {
    name: "a 101",
    headers: { upgrade: "websocket" },
    caller: "non-member",
    status: 101,
    becomes: "unchanged",
  },
])("$name → $becomes", ({ url, method, headers, caller, status, wwwAuthenticate, becomes }) => {
  const answer = {
    status: status ?? 401,
    headers: new Headers({ "www-authenticate": wwwAuthenticate || 'Bearer realm="iterate"' }),
  };
  const response = projectHostSignInAnswerOf({
    answer,
    request: new Request(url || `${HOST}/x`, { method: method || "GET", headers }),
    caller,
    projectSlug: "acme",
    loginUrl: "/.auth/login",
  });
  if (becomes === "unchanged") return expect(response).toBeNull();
  expect(response).toMatchObject({ status: becomes.status });
  expect(response!.headers.get("location") ?? undefined).toBe(becomes.location);
});

// ── rules 8–10: paths ingress is members-only ──
test.for<{
  name: string;
  method?: string;
  headers?: Record<string, string>;
  caller: ProjectHostCaller;
  becomes: { status: number; location?: string; wwwAuthenticate?: string } | "passes";
}>([
  { name: "a member", headers: NAVIGATE, caller: "member", becomes: "passes" },
  {
    name: "a member's WebSocket upgrade",
    headers: { upgrade: "websocket" },
    caller: "member",
    becomes: "passes",
  },
  {
    name: "anonymous navigation, back to the base path",
    headers: NAVIGATE,
    caller: "anonymous",
    becomes: {
      status: 302,
      location: "/.auth/login?next=%2Fprojects%2Facme%2Fsite%2Fnotes%3Fview%3Dall",
    },
  },
  {
    name: "anonymous HEAD navigation",
    method: "HEAD",
    headers: NAVIGATE,
    caller: "anonymous",
    becomes: {
      status: 302,
      location: "/.auth/login?next=%2Fprojects%2Facme%2Fsite%2Fnotes%3Fview%3Dall",
    },
  },
  {
    name: "anonymous fetch",
    headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
    caller: "anonymous",
    becomes: { status: 401, wwwAuthenticate: 'Bearer realm="iterate"' },
  },
  {
    name: "anonymous POST",
    method: "POST",
    caller: "anonymous",
    becomes: { status: 401, wwwAuthenticate: 'Bearer realm="iterate"' },
  },
  {
    name: "anonymous WebSocket upgrade",
    headers: { upgrade: "websocket", accept: "text/html" },
    caller: "anonymous",
    becomes: { status: 401, wwwAuthenticate: 'Bearer realm="iterate"' },
  },
  {
    name: "non-member navigation",
    headers: NAVIGATE,
    caller: "non-member",
    becomes: { status: 403 },
  },
  { name: "non-member fetch", caller: "non-member", becomes: { status: 403 } },
])("paths: $name → $becomes", ({ method, headers, caller, becomes }) => {
  const response = pathsIngressRefusalOf({
    request: new Request("https://os.test/projects/acme/site/notes?view=all", {
      method: method || "GET",
      headers,
    }),
    caller,
    projectSlug: "acme",
    loginUrl: "/.auth/login",
  });
  if (becomes === "passes") return expect(response).toBeNull();
  expect(response).toMatchObject({ status: becomes.status });
  expect(response!.headers.get("location") ?? undefined).toBe(becomes.location);
  expect(response!.headers.get("www-authenticate") ?? undefined).toBe(becomes.wwwAuthenticate);
});

// ── the challenge parser ──
test.for<{ header: string | null; ours: boolean }>([
  { header: 'Bearer realm="iterate"', ours: true },
  { header: "bearer realm=iterate", ours: true },
  { header: 'Bearer error="invalid_token", realm="iterate"', ours: true },
  { header: 'Negotiate abc==, Bearer realm="iterate"', ours: true },
  { header: 'Basic realm="x,y", Bearer realm="iterate", scope="a"', ours: true },
  { header: 'Bearer realm="it\\erate"', ours: true },
  { header: 'Bearer realm="Iterate"', ours: false },
  { header: 'Bearer realm="iterate-app"', ours: false },
  { header: 'Basic realm="iterate"', ours: false },
  { header: 'Bearer realm="app", Basic realm="iterate"', ours: false },
  { header: 'Bearer error="realm=iterate"', ours: false },
  { header: 'Bearerx realm="iterate"', ours: false },
  { header: 'realm="iterate"', ours: false },
  { header: '"Bearer" realm="iterate"', ours: false },
  { header: "", ours: false },
  { header: null, ours: false },
])("WWW-Authenticate: $header → $ours", ({ header, ours }) => {
  expect(isIterateSignInChallenge(header)).toBe(ours);
});
