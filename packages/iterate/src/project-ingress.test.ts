// project-ingress.test.ts — the two ingress mechanisms as `{ url, names }` rows (parse), `{ target,
// url }` rows (compose), every rejection, and the one invariant that matters: composing then parsing
// gives the target back, for every row of both modes.
import { expect, test } from "vitest";
import {
  projectAddressOf,
  projectUrlOf,
  type IngressRouting,
  type ProjectAddress,
  customHostnameCandidatesOf,
  primaryHostnameUrlOf,
  projectPublicUrlOf,
  projectWildcardHostOf,
} from "./project-ingress.ts";

const subdomains: IngressRouting = { type: "subdomains", hostname: "iterate.app" };
const paths: IngressRouting = { type: "paths" };
const PRD = "https://os.iterate.com";
const DEV = "http://localhost:8788";

// ── projectAddressOf — subdomains ──
const subdomainRows: { url: string; names: ProjectAddress | null; why: string }[] = [
  {
    url: "https://site--p.iterate.app/x?y",
    names: { routingSlug: "site", project: "p", basePath: "" },
    why: "<routingSlug>--<project>",
  },
  {
    url: "https://site.p.iterate.app/",
    names: { routingSlug: "site", project: "p", basePath: "" },
    why: "<routingSlug>.<project>",
  },
  {
    url: "https://p.iterate.app/",
    names: { routingSlug: null, project: "p", basePath: "" },
    why: "the apex names no routing slug",
  },
  {
    url: "https://My-App--My-Proj.Iterate.App./",
    names: { routingSlug: "my-app", project: "my-proj", basePath: "" },
    why: "lowercased, the trailing dot dropped",
  },
  { url: "https://os.iterate.com/site--p", names: null, why: "not under the hostname" },
  { url: "https://iterate.app/", names: null, why: "the hostname itself has no labels" },
  { url: "https://a.b.c.iterate.app/", names: null, why: "deeper than <routingSlug>.<project>" },
  {
    url: "https://xn--bcher-kva.iterate.app/",
    names: null,
    why: "an IDN label (punycode) is never <routingSlug>--<project>, and is not a DNS label",
  },
  { url: "https://--p.iterate.app/", names: null, why: "an empty routing slug" },
  {
    url: "https://9site--p.iterate.app/",
    names: null,
    why: "a routing slug starts with a letter",
  },
  {
    url: "https://site--p-.iterate.app/",
    names: null,
    why: "a trailing hyphen is not a DNS label",
  },
  { url: "https://site..iterate.app/", names: null, why: "a present-but-empty project label" },
];
test.for(subdomainRows)("$url → $why", ({ url, names }) => {
  expect(projectAddressOf(subdomains, new URL(url), PRD)).toEqual(names);
});

// ── projectAddressOf — paths ──
const pathRows: { url: string; names: ProjectAddress | null; why: string }[] = [
  {
    url: `${PRD}/projects/p/site/x?y`,
    names: { routingSlug: "site", project: "p", basePath: "/projects/p/site" },
    why: "<project>/<routingSlug>/…",
  },
  {
    url: `${PRD}/projects/p/site`,
    names: { routingSlug: "site", project: "p", basePath: "/projects/p/site" },
    why: "<project>/<routingSlug>",
  },
  {
    url: `${PRD}/projects/p/`,
    names: { routingSlug: null, project: "p", basePath: "/projects/p" },
    why: "the apex, trailing slash",
  },
  {
    url: `${PRD}/projects/p`,
    names: { routingSlug: null, project: "p", basePath: "/projects/p" },
    why: "the apex, bare",
  },
  { url: `${PRD}/`, names: null, why: "the platform's root" },
  { url: `${PRD}`, names: null, why: "the origin alone" },
  { url: "https://other.example/projects/p/site", names: null, why: "another origin" },
  { url: `${PRD}/projects/P/site`, names: null, why: "a slug is lowercase" },
  { url: `${PRD}/projects/p/9site`, names: null, why: "a routing slug starts with a letter" },
  { url: `${PRD}/projects/p/Site`, names: null, why: "a routing slug is lowercase" },
  { url: `${PRD}/p/site`, names: null, why: "not under /projects/ — the platform's own paths" },
  { url: `${PRD}/api`, names: null, why: "a platform endpoint" },
  { url: `${PRD}/projects`, names: null, why: "the prefix alone" },
  { url: `${PRD}/projects/`, names: null, why: "the prefix alone, trailing slash" },
];
test.for(pathRows)("$url → $why", ({ url, names }) => {
  expect(projectAddressOf(paths, new URL(url), PRD)).toEqual(names);
});

test("the platform origin compares normalized", () => {
  expect(
    projectAddressOf(paths, new URL(`${PRD}/projects/p/site`), "https://OS.iterate.com:443"),
  ).toEqual({
    routingSlug: "site",
    project: "p",
    basePath: "/projects/p/site",
  });
});

// ── projectUrlOf ──
const urlRows: {
  routing: IngressRouting;
  origin: string;
  target: { project: string; routingSlug?: string | null; path?: string };
  url: string | null;
  why: string;
}[] = [
  {
    routing: subdomains,
    origin: PRD,
    target: { project: "p", routingSlug: "site" },
    url: "https://site--p.iterate.app/",
    why: "a routing slug, the root",
  },
  {
    routing: subdomains,
    origin: PRD,
    target: { project: "p", routingSlug: "site", path: "/a/b?c=1" },
    url: "https://site--p.iterate.app/a/b?c=1",
    why: "a routing slug, a path with a query",
  },
  {
    routing: subdomains,
    origin: PRD,
    target: { project: "p" },
    url: "https://p.iterate.app/",
    why: "the apex",
  },
  {
    routing: subdomains,
    origin: PRD,
    target: { project: "p", routingSlug: null, path: "/hooks" },
    url: "https://p.iterate.app/hooks",
    why: "the apex, a path",
  },
  {
    routing: { type: "subdomains", hostname: "localhost" },
    origin: DEV,
    target: { project: "p", routingSlug: "site" },
    url: "http://site--p.localhost:8788/",
    why: "local dev keeps the scheme and port",
  },
  {
    routing: { type: "subdomains", hostname: "localhost" },
    origin: DEV,
    target: { project: "p" },
    url: "http://p.localhost:8788/",
    why: "local dev, the apex",
  },
  {
    routing: paths,
    origin: PRD,
    target: { project: "p", routingSlug: "site" },
    url: `${PRD}/projects/p/site/`,
    why: "a routing slug, the root — a trailing slash so relative URLs resolve inside it",
  },
  {
    routing: paths,
    origin: PRD,
    target: { project: "p", routingSlug: "site", path: "/a/b?c=1" },
    url: `${PRD}/projects/p/site/a/b?c=1`,
    why: "a routing slug, a path with a query",
  },
  {
    routing: paths,
    origin: PRD,
    target: { project: "p" },
    url: `${PRD}/projects/p/`,
    why: "the apex",
  },
  {
    routing: paths,
    origin: DEV,
    target: { project: "p", routingSlug: "site" },
    url: `${DEV}/projects/p/site/`,
    why: "local dev",
  },
  {
    routing: null,
    origin: PRD,
    target: { project: "p", routingSlug: "site" },
    url: null,
    why: "no ingress",
  },
  {
    routing: subdomains,
    origin: PRD,
    target: { project: "P", routingSlug: "site" },
    url: null,
    why: "a bad slug composes nothing",
  },
  {
    routing: paths,
    origin: PRD,
    target: { project: "p", routingSlug: "9site" },
    url: null,
    why: "a bad routing slug composes nothing",
  },
  {
    routing: paths,
    origin: PRD,
    target: { project: "p", routingSlug: "site", path: "/../other" },
    url: null,
    why: "a path may not climb out of its routing slug",
  },
  {
    routing: paths,
    origin: PRD,
    target: { project: "p", routingSlug: "site", path: "/../../q/x" },
    url: null,
    why: "nor out of its project",
  },
];
test.for(urlRows)("$why", ({ routing, origin, target, url }) => {
  expect(projectUrlOf(routing, origin, target)?.href ?? null).toBe(url);
});

test("a path without a leading slash is a programmer error", () => {
  expect(() => projectUrlOf(paths, PRD, { project: "p", path: "x" })).toThrow(/must start with/);
});

test("every composed URL parses back to its target", () => {
  for (const { routing, origin, target, url } of urlRows) {
    if (!url) continue;
    const parsed = projectAddressOf(routing, new URL(url), origin);
    expect(parsed, url).toMatchObject({
      project: target.project,
      routingSlug: target.routingSlug || null,
    });
    // and the config worker sees the path it was given, once the edge strips basePath
    const seen = new URL(url).pathname.slice(parsed!.basePath.length) + new URL(url).search;
    expect(seen, url).toBe(target.path || "/");
  }
});

// ── projectWildcardHostOf ──
const wildcard = {
  hostname: "iterate.com",
  project: "iterate",
  excludedHostnames: [
    "os.iterate.com",
    "mcp.iterate.com",
    "dash.iterate.com",
    "k.iterate.com",
    "voice.iterate.com",
    "install.iterate.com",
  ],
};
test.for([
  { hostname: "iterate.com", project: "iterate" },
  { hostname: "Iterate.COM.", project: "iterate" },
  { hostname: "www.iterate.com", project: "iterate" },
  { hostname: "Blog.Iterate.com.", project: "iterate" },
  { hostname: "deep.www.iterate.com", project: null },
  { hostname: "notiterate.com", project: null },
  { hostname: "www.iterate.app", project: null },
  ...wildcard.excludedHostnames.map((hostname) => ({ hostname, project: null })),
])("project wildcard $hostname → $project", ({ hostname, project }) => {
  expect(projectWildcardHostOf(hostname, wildcard)?.project ?? null).toBe(project);
});

test("no project wildcard names no project", () => {
  expect(projectWildcardHostOf("iterate.com", undefined)).toBeNull();
});

// ── customHostnameCandidatesOf ── a project's own hostname is its apex; one label under it, a routing slug
test.for([
  {
    host: "iterate.somedomain.com",
    candidates: [
      { hostname: "iterate.somedomain.com", routingSlug: null },
      { hostname: "somedomain.com", routingSlug: "iterate" },
    ],
  },
  {
    host: "notes.iterate.somedomain.com",
    candidates: [
      { hostname: "notes.iterate.somedomain.com", routingSlug: null },
      { hostname: "iterate.somedomain.com", routingSlug: "notes" },
    ],
  },
  {
    host: "Notes.Iterate.SomeDomain.com.",
    candidates: [
      { hostname: "notes.iterate.somedomain.com", routingSlug: null },
      { hostname: "iterate.somedomain.com", routingSlug: "notes" },
    ],
  },
  // a bare domain's parent is a TLD, never a project's hostname
  { host: "garple.com", candidates: [{ hostname: "garple.com", routingSlug: null }] },
  // a first label that is no routing slug (a digit first, `--`) names no routing slug: only the exact host
  {
    host: "1st.iterate.somedomain.com",
    candidates: [{ hostname: "1st.iterate.somedomain.com", routingSlug: null }],
  },
  {
    host: "a--b.iterate.somedomain.com",
    candidates: [{ hostname: "a--b.iterate.somedomain.com", routingSlug: null }],
  },
  { host: "localhost", candidates: [{ hostname: "localhost", routingSlug: null }] },
])("custom hostname candidates of $host", ({ host, candidates }) => {
  expect(customHostnameCandidatesOf(host)).toEqual(candidates);
});

// ── primaryHostnameUrlOf ── a routing slug is one label under the primary hostname; the apex is the hostname
test.for([
  { target: {}, url: "https://templestein.com/" },
  { target: { routingSlug: null, path: "/a?b=1" }, url: "https://templestein.com/a?b=1" },
  { target: { routingSlug: "here-public" }, url: "https://here-public.templestein.com/" },
  {
    target: { routingSlug: "blog", path: "/posts/1" },
    url: "https://blog.templestein.com/posts/1",
  },
  { target: { routingSlug: "9lives" }, url: null },
  { target: { routingSlug: "a--b" }, url: null },
  // a path never changes the host: the edge passes a visitor's own path here
  { target: { path: "//evil.test/x" }, url: "https://templestein.com//evil.test/x" },
  { target: { path: "/\\evil.test/x" }, url: "https://templestein.com//evil.test/x" },
  { target: { path: "/@evil.test/x" }, url: "https://templestein.com/@evil.test/x" },
])("primary hostname URL of $target", ({ target, url }) => {
  expect(primaryHostnameUrlOf("templestein.com", target)?.href ?? null).toBe(url);
});

test("a primary hostname URL's path without a leading slash is a programmer error", () => {
  expect(() => primaryHostnameUrlOf("templestein.com", { path: "x" })).toThrow(/must start with/);
});

test("a primary hostname URL parses back to its routing slug as a custom hostname candidate", () => {
  const url = primaryHostnameUrlOf("templestein.com", { routingSlug: "blog" })!;
  expect(customHostnameCandidatesOf(url.hostname)).toContainEqual({
    hostname: "templestein.com",
    routingSlug: "blog",
  });
});

// ── projectPublicUrlOf ── `itx.url` and `whoami().projectUrl`: the primary hostname when there is one, else the ingress
test.for([
  {
    primaryHostname: null,
    routing: subdomains,
    target: {},
    url: "https://templestein.iterate.app/",
  },
  {
    primaryHostname: null,
    routing: subdomains,
    target: { routingSlug: "blog", path: "/a" },
    url: "https://blog--templestein.iterate.app/a",
  },
  {
    primaryHostname: null,
    routing: paths,
    target: { routingSlug: "blog" },
    url: "https://os.iterate.com/projects/templestein/blog/",
  },
  { primaryHostname: null, routing: null, target: {}, url: null },
  {
    primaryHostname: "templestein.com",
    routing: subdomains,
    target: {},
    url: "https://templestein.com/",
  },
  {
    primaryHostname: "templestein.com",
    routing: subdomains,
    target: { routingSlug: "blog", path: "/a" },
    url: "https://blog.templestein.com/a",
  },
  // the primary is the project's own hostname, whatever the deployment's ingress
  {
    primaryHostname: "templestein.com",
    routing: paths,
    target: {},
    url: "https://templestein.com/",
  },
  {
    primaryHostname: "templestein.com",
    routing: null,
    target: {},
    url: "https://templestein.com/",
  },
  {
    primaryHostname: "templestein.com",
    routing: subdomains,
    target: { routingSlug: "a--b" },
    url: null,
  },
] satisfies {
  primaryHostname: string | null;
  routing: IngressRouting;
  target: { routingSlug?: string; path?: string };
  url: string | null;
}[])(
  "public URL of $target with primary $primaryHostname under $routing",
  ({ primaryHostname, routing, target, url }) => {
    expect(
      projectPublicUrlOf(routing, PRD, { project: "templestein", primaryHostname, ...target })
        ?.href ?? null,
    ).toBe(url);
  },
);
