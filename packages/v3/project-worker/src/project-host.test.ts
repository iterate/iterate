// project-host.test.ts — the hostname convention as a table: `{ hostname, base, becomes }` rows.
import { expect, test } from "vitest";
import { projectHostOf } from "./project-host.ts";

const rows: { hostname: string; base: string; becomes: ReturnType<typeof projectHostOf> }[] = [
  // the convention
  {
    hostname: "site--prj-1.iterate.app",
    base: "iterate.app",
    becomes: { projectId: "prj-1", itxExpression: "itx.apps.site" },
  },
  {
    hostname: "prj-1.iterate.app",
    base: "iterate.app",
    becomes: { projectId: "prj-1", itxExpression: "itx.apps.default" },
  }, // the apex is the label `default`
  {
    hostname: "default--prj-1.iterate.app",
    base: "iterate.app",
    becomes: { projectId: "prj-1", itxExpression: "itx.apps.default" },
  },
  {
    hostname: "my-site--a1.iterate.app",
    base: "iterate.app",
    becomes: { projectId: "a1", itxExpression: "itx.apps.my-site" },
  },
  {
    hostname: "Site--PRJ-1.Iterate.App",
    base: "iterate.app",
    becomes: { projectId: "prj-1", itxExpression: "itx.apps.site" },
  },
  {
    hostname: "site--prj-1.localhost",
    base: "localhost",
    becomes: { projectId: "prj-1", itxExpression: "itx.apps.site" },
  },
  {
    hostname: "site--prj-1.iterate.app.", // a fully-qualified Host
    base: "iterate.app",
    becomes: { projectId: "prj-1", itxExpression: "itx.apps.site" },
  },
  // not a project host
  { hostname: "project-worker.iterate.workers.dev", base: "iterate.app", becomes: null },
  { hostname: "iterate.app", base: "iterate.app", becomes: null },
  { hostname: "a.site--prj-1.iterate.app", base: "iterate.app", becomes: null }, // deeper than one label
  { hostname: "site--prj_1.iterate.app", base: "iterate.app", becomes: null }, // `_` is not a DNS label
  { hostname: "site--prj--1.iterate.app", base: "iterate.app", becomes: null }, // a second `--`
  { hostname: "3d--prj-1.iterate.app", base: "iterate.app", becomes: null }, // an app label is an identifier
  { hostname: "--prj-1.iterate.app", base: "iterate.app", becomes: null },
  { hostname: "site--.iterate.app", base: "iterate.app", becomes: null },
  { hostname: "site--prj-1.iterate.app", base: "", becomes: null }, // blank base ⇒ no ingress
];
for (const { hostname, base, becomes } of rows)
  test(`${hostname} under ${JSON.stringify(base)} ⇒ ${JSON.stringify(becomes)}`, () => {
    expect(projectHostOf(hostname, base)).toEqual(becomes);
  });
