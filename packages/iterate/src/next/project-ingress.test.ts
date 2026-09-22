// project-ingress.test.ts — the two ingress mechanisms as `{ url, names }` rows (parse), `{ target,
// url }` rows (compose), every rejection, and the one invariant that matters: composing then parsing
// gives the target back, for every row of both modes.
import { describe, expect, test } from "vitest";
import {
  projectAddressOf,
  projectUrlOf,
  type IngressRouting,
  type ProjectAddress,
  customProjectHostOf,
} from "./project-ingress.ts";

const subdomains: IngressRouting = { type: "subdomains", hostname: "iterate2.app" };
const paths: IngressRouting = { type: "paths" };
const PRD = "https://os.iterate2.com";
const DEV = "http://localhost:8788";

describe("projectAddressOf — subdomains", () => {
  const rows: { url: string; names: ProjectAddress | null; why: string }[] = [
    {
      url: "https://site--p.iterate2.app/x?y",
      names: { app: "site", project: "p", basePath: "" },
      why: "<app>--<project>",
    },
    {
      url: "https://site.p.iterate2.app/",
      names: { app: "site", project: "p", basePath: "" },
      why: "<app>.<project>",
    },
    {
      url: "https://p.iterate2.app/",
      names: { app: null, project: "p", basePath: "" },
      why: "the apex names no app",
    },
    {
      url: "https://My-App--My-Proj.Iterate2.App./",
      names: { app: "my-app", project: "my-proj", basePath: "" },
      why: "lowercased, the trailing dot dropped",
    },
    { url: "https://os.iterate2.com/site--p", names: null, why: "not under the hostname" },
    { url: "https://iterate2.app/", names: null, why: "the hostname itself has no labels" },
    { url: "https://a.b.c.iterate2.app/", names: null, why: "deeper than <app>.<project>" },
    {
      url: "https://xn--bcher-kva.iterate2.app/",
      names: null,
      why: "an IDN label (punycode) is never <app>--<project>, and is not a DNS label",
    },
    { url: "https://--p.iterate2.app/", names: null, why: "an empty app label" },
    {
      url: "https://9site--p.iterate2.app/",
      names: null,
      why: "an app label starts with a letter",
    },
    {
      url: "https://site--p-.iterate2.app/",
      names: null,
      why: "a trailing hyphen is not a DNS label",
    },
    { url: "https://site..iterate2.app/", names: null, why: "a present-but-empty project label" },
  ];
  test.each(rows)("$url → $why", ({ url, names }) => {
    expect(projectAddressOf(subdomains, new URL(url), PRD)).toEqual(names);
  });
});

describe("projectAddressOf — paths", () => {
  const rows: { url: string; names: ProjectAddress | null; why: string }[] = [
    {
      url: `${PRD}/projects/p/site/x?y`,
      names: { app: "site", project: "p", basePath: "/projects/p/site" },
      why: "<project>/<app>/…",
    },
    {
      url: `${PRD}/projects/p/site`,
      names: { app: "site", project: "p", basePath: "/projects/p/site" },
      why: "<project>/<app>",
    },
    {
      url: `${PRD}/projects/p/`,
      names: { app: null, project: "p", basePath: "/projects/p" },
      why: "the apex, trailing slash",
    },
    {
      url: `${PRD}/projects/p`,
      names: { app: null, project: "p", basePath: "/projects/p" },
      why: "the apex, bare",
    },
    { url: `${PRD}/`, names: null, why: "the platform's root" },
    { url: `${PRD}`, names: null, why: "the origin alone" },
    { url: "https://other.example/projects/p/site", names: null, why: "another origin" },
    { url: `${PRD}/projects/P/site`, names: null, why: "a slug is lowercase" },
    { url: `${PRD}/projects/p/9site`, names: null, why: "an app label starts with a letter" },
    { url: `${PRD}/projects/p/Site`, names: null, why: "an app label is lowercase" },
    { url: `${PRD}/p/site`, names: null, why: "not under /projects/ — the platform's own paths" },
    { url: `${PRD}/api`, names: null, why: "a platform door" },
    { url: `${PRD}/projects`, names: null, why: "the prefix alone" },
    { url: `${PRD}/projects/`, names: null, why: "the prefix alone, trailing slash" },
  ];
  test.each(rows)("$url → $why", ({ url, names }) => {
    expect(projectAddressOf(paths, new URL(url), PRD)).toEqual(names);
  });

  test("the platform origin compares normalized", () => {
    expect(
      projectAddressOf(paths, new URL(`${PRD}/projects/p/site`), "https://OS.iterate2.com:443"),
    ).toEqual({
      app: "site",
      project: "p",
      basePath: "/projects/p/site",
    });
  });
});

describe("projectUrlOf", () => {
  const rows: {
    routing: IngressRouting;
    origin: string;
    target: { project: string; app?: string | null; path?: string };
    url: string | null;
    why: string;
  }[] = [
    {
      routing: subdomains,
      origin: PRD,
      target: { project: "p", app: "site" },
      url: "https://site--p.iterate2.app/",
      why: "an app, the root",
    },
    {
      routing: subdomains,
      origin: PRD,
      target: { project: "p", app: "site", path: "/a/b?c=1" },
      url: "https://site--p.iterate2.app/a/b?c=1",
      why: "an app, a path with a query",
    },
    {
      routing: subdomains,
      origin: PRD,
      target: { project: "p" },
      url: "https://p.iterate2.app/",
      why: "the apex",
    },
    {
      routing: subdomains,
      origin: PRD,
      target: { project: "p", app: null, path: "/hooks" },
      url: "https://p.iterate2.app/hooks",
      why: "the apex, a path",
    },
    {
      routing: { type: "subdomains", hostname: "localhost" },
      origin: DEV,
      target: { project: "p", app: "site" },
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
      target: { project: "p", app: "site" },
      url: `${PRD}/projects/p/site/`,
      why: "an app, the root — a trailing slash so relative URLs resolve inside it",
    },
    {
      routing: paths,
      origin: PRD,
      target: { project: "p", app: "site", path: "/a/b?c=1" },
      url: `${PRD}/projects/p/site/a/b?c=1`,
      why: "an app, a path with a query",
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
      target: { project: "p", app: "site" },
      url: `${DEV}/projects/p/site/`,
      why: "local dev",
    },
    {
      routing: null,
      origin: PRD,
      target: { project: "p", app: "site" },
      url: null,
      why: "no ingress",
    },
    {
      routing: subdomains,
      origin: PRD,
      target: { project: "P", app: "site" },
      url: null,
      why: "a bad slug composes nothing",
    },
    {
      routing: paths,
      origin: PRD,
      target: { project: "p", app: "9site" },
      url: null,
      why: "a bad app label composes nothing",
    },
    {
      routing: paths,
      origin: PRD,
      target: { project: "p", app: "site", path: "/../other" },
      url: null,
      why: "a path may not climb out of its app",
    },
    {
      routing: paths,
      origin: PRD,
      target: { project: "p", app: "site", path: "/../../q/x" },
      url: null,
      why: "nor out of its project",
    },
  ];
  test.each(rows)("$why", ({ routing, origin, target, url }) => {
    expect(projectUrlOf(routing, origin, target)?.href ?? null).toBe(url);
  });

  test("a path without a leading slash is a programmer error", () => {
    expect(() => projectUrlOf(paths, PRD, { project: "p", path: "x" })).toThrow(/must start with/);
  });

  test("every composed URL parses back to its target", () => {
    for (const { routing, origin, target, url } of rows) {
      if (!url) continue;
      const parsed = projectAddressOf(routing, new URL(url), origin);
      expect(parsed, url).toMatchObject({ project: target.project, app: target.app || null });
      // and the app sees the path it was given, once the edge strips basePath
      const seen = new URL(url).pathname.slice(parsed!.basePath.length) + new URL(url).search;
      expect(seen, url).toBe(target.path || "/");
    }
  });
});

describe("customProjectHostOf", () => {
  const hostnames = { "iterate2.com": "iterate" };
  test.each([
    {
      hostname: "iterate2.com",
      becomes: { app: null, project: "iterate" },
      why: "the apex, as named",
    },
    {
      hostname: "Iterate2.COM.",
      becomes: { app: null, project: "iterate" },
      why: "case and a trailing dot forgiven",
    },
    {
      hostname: "www.iterate2.com",
      becomes: null,
      why: "only the hostnames named — no wildcard under them",
    },
    {
      hostname: "os.iterate2.com",
      becomes: null,
      why: "the platform's own origin is not a project",
    },
  ])("$hostname → $why", ({ hostname, becomes }) => {
    expect(customProjectHostOf(hostname, hostnames)).toEqual(becomes);
  });
});
