// __workers-tests__/first-party-facet-placement.test.ts — A FIRST-PARTY FACET IS HOSTED ONLY WHERE THE
// PLATFORM HOSTS IT. A first-party class (src/first-party-facets.ts) is minted from `ctx.exports` with
// the worker's real env and a platform loopback on the context that hosts it, so that context is its
// authority: a signed-in person who reaches `itx.facets.get(name)` on a context they hold — their own
// `global:/users/<id>`, any path of a project of theirs — must not mint `project` on their account,
// nor `secret` on a path that names no secret. The rules are src/context/first-party-facet-placement.ts
// (a table test beside it); this file proves the refusal end to end through a person who signed in
// with the login form: every wrong placement is refused FORBIDDEN, every placement the platform's own
// code makes still answers, and a secret path that resolves onto its owner's root (`/secrets/..`) is
// refused before `itx.secrets.set` can steer the `secret` facet there.

import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { afterAll, expect, test, vi } from "vitest";
import { errorCode } from "iterate/next/lib";
import type { ItxExpressionInput } from "iterate/next/expression";
import type { IterateRpcTarget } from "../src/session.ts";
import { loginPassword, ORIGIN } from "./support.ts";

const transports: Disposable[] = [];
afterAll(() => {
  for (const transport of transports.splice(0)) transport[Symbol.dispose]();
});

/** A person signed in through the login form (email + the deployment's password), then on `/api`
 *  with the browser's session cookie: an ordinary user session — no admin credential anywhere. The
 *  issuer fetches its own client metadata while it signs someone in; `fetch` reaches this worker for
 *  that one request (as control-plane.test.ts does), the network being out of reach here. */
async function signedInSession(email: string) {
  const issuerFetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) => exports.default.fetch(new Request(input, init)));
  const login = await exports.default.fetch(`${ORIGIN}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { Origin: ORIGIN },
    body: new URLSearchParams({ email, password: loginPassword(), next: "/" }),
  });
  issuerFetch.mockRestore();
  const sessionCookie = login.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("__Host-itx-session="))!
    .split(";")[0]!;
  const response = await exports.default.fetch(`${ORIGIN}/api`, {
    headers: { Upgrade: "websocket", Origin: ORIGIN, Cookie: sessionCookie },
  });
  response.webSocket!.accept();
  const transport = newWebSocketRpcSession<IterateRpcTarget>(
    response.webSocket! as unknown as WebSocket,
  );
  transports.push(transport);
  return transport.authenticate({ type: "from-server-cookie" });
}

/** What a call came to: `"answered"`, or the code it was refused with (the message when uncoded). */
async function outcomeOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "answered";
  } catch (error) {
    return errorCode(error) ?? String(error);
  }
}

/** One row: the first-party facet named on a context the person holds, and whether the platform
 *  hosts it there. `context` is `session.user` (their own `global:/users/<id>`), `organization` (an
 *  organization they created, `global:/organizations/<id>`) or `project <path>` (a path of a project
 *  they created). */
type FirstPartyFacetPlacementRow = { facet: string; context: string; allowed: boolean };

const FIRST_PARTY_FACET_PLACEMENT_ROWS: FirstPartyFacetPlacementRow[] = [
  // Where the platform's own code hosts each one — these answer before and after the fix.
  { facet: "account", context: "session.user", allowed: true },
  { facet: "organization", context: "organization", allowed: true },
  { facet: "project", context: "project /", allowed: true },
  { facet: "secret", context: "project /secrets/api-key", allowed: true },
  { facet: "repo", context: "project /repos/notes", allowed: true },
  { facet: "workspace", context: "project /", allowed: true },
  // THE HOLE: the same names on a context the person holds but the platform never hosts them on.
  { facet: "project", context: "session.user", allowed: false },
  { facet: "organization", context: "session.user", allowed: false },
  { facet: "secret", context: "session.user", allowed: false },
  { facet: "repo", context: "session.user", allowed: false },
  { facet: "workspace", context: "session.user", allowed: false },
  { facet: "account", context: "organization", allowed: false },
  { facet: "account", context: "project /", allowed: false },
  { facet: "organization", context: "project /", allowed: false },
  { facet: "project", context: "project /notes", allowed: false },
  { facet: "secret", context: "project /notes", allowed: false },
  { facet: "secret", context: "project /", allowed: false },
];

test("a signed-in person reaches `itx.facets.get(name)` on every context they hold, but a first-party facet answers only where the platform hosts it — every other placement is refused FORBIDDEN", async () => {
  const session = await signedInSession("placement@example.com");
  const organization = await session.organizations.create({ name: "placement org" });
  const project = await session.projects.create({ project: "placement", orgId: organization.id });
  const contextOf = (context: string) => {
    if (context === "session.user") return session.user;
    if (context === "organization") return session.organizations.get(organization.id);
    return project.cd(context.slice("project ".length));
  };
  const outcomes = [];
  for (const row of FIRST_PARTY_FACET_PLACEMENT_ROWS)
    outcomes.push({
      ...row,
      outcome: await outcomeOf(() =>
        contextOf(row.context).invoke(["itx", "facets", ["get", row.facet], ["snapshot"]]),
      ),
    });
  expect(outcomes).toEqual(
    FIRST_PARTY_FACET_PLACEMENT_ROWS.map((row) => ({
      ...row,
      outcome: row.allowed ? "answered" : "FORBIDDEN",
    })),
  );
});

test("`processors.enable` of a first-party name off its placement is refused before anything is appended: no row, no facet", async () => {
  const session = await signedInSession("placement-enable@example.com");
  expect(
    await outcomeOf(() => session.user.invoke(["itx", "processors", ["enable", "project"]])),
  ).toBe("FORBIDDEN");
  const rows = (await session.user.invoke(["itx", "processors", ["list"]])) as { name: string }[];
  expect(rows.map((row) => row.name)).not.toContain("project");
});

test("a secret path that resolves onto its owner's root (`/secrets/..`, `/secrets/.`) is refused at `itx.secrets.set`, before it can steer the `secret` facet onto the project's or the person's own root", async () => {
  const session = await signedInSession("placement-secret@example.com");
  const project = await session.projects.create({ project: "placement-secret" });
  for (const context of [project, session.user])
    for (const secretPath of ["/secrets/..", "/secrets/."]) {
      expect(
        await outcomeOf(() =>
          context.invoke([
            "itx",
            "secrets",
            ["set", secretPath, "material", { urls: ["https://api.example.test"] }],
          ]),
        ),
      ).toMatch(
        /a secret's path is \/secrets\/<name>, the name \[a-zA-Z0-9._-\]\+ and never "\." or "\.\."/,
      );
      const rows = (await context.invoke(["itx", "processors", ["list"]])) as { name: string }[];
      expect(rows.map((row) => row.name)).not.toContain("secret");
    }
});

// ── loaded code ── a person's OWN code: a facet or a processor loaded from the source its spec names,
// a stateless worker, a script run. It runs inside a project, never in the global namespace — the
// global contexts (a person's account, an organization) run the platform's code alone.

/** A loaded class that is both a facet (`hello`) and a processor (the two verbs the delivery loop
 *  calls on a hosting row: `catchUpFromLog` at enable, `processEventBatch` per batch). */
const TALLY_SOURCE = {
  "cap.js": `import { FacetDurableObject } from "./processor.js";
export class Tally extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "hello"];
  catchUpFromLog() {}
  processEventBatch() {}
  hello() { return "hello from loaded code"; }
}`,
};
const WORKER_SOURCE = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint { hello() { return "hello from loaded code"; } }`,
};

/** Each way code is loaded on a context, as the call a client makes. */
const LOADED_CODE_CALLS: Record<string, ItxExpressionInput> = {
  "facets.get(name, spec)": [
    "itx",
    "facets",
    ["get", "tally", { source: TALLY_SOURCE, className: "Tally" }],
    ["hello"],
  ],
  "processors.enable(name, spec)": [
    "itx",
    "processors",
    ["enable", "tally-processor", { source: TALLY_SOURCE, className: "Tally" }],
  ],
  "workers.get(spec)": ["itx", "workers", ["get", { source: WORKER_SOURCE }], ["hello"]],
  "run(script)": ["itx", ["run", "async (itx) => 'hello from loaded code'"]],
};

type LoadedCodeRow = { call: keyof typeof LOADED_CODE_CALLS; context: string; allowed: boolean };

const LOADED_CODE_ROWS: LoadedCodeRow[] = [
  // Inside a project, a person's own code runs.
  { call: "facets.get(name, spec)", context: "project /", allowed: true },
  { call: "processors.enable(name, spec)", context: "project /", allowed: true },
  { call: "workers.get(spec)", context: "project /notes", allowed: true },
  { call: "run(script)", context: "project /", allowed: true },
  // In the global namespace it never loads.
  { call: "facets.get(name, spec)", context: "session.user", allowed: false },
  { call: "processors.enable(name, spec)", context: "session.user", allowed: false },
  { call: "workers.get(spec)", context: "session.user", allowed: false },
  { call: "run(script)", context: "session.user", allowed: false },
  { call: "facets.get(name, spec)", context: "organization", allowed: false },
  { call: "workers.get(spec)", context: "organization", allowed: false },
];

test("a signed-in person's own code — a facet, a processor, a worker, a script — runs inside their project, and never on their account or their organization in the global namespace", async () => {
  const session = await signedInSession("loaded-code@example.com");
  const organization = await session.organizations.create({ name: "loaded code org" });
  const project = await session.projects.create({
    project: "loaded-code",
    orgId: organization.id,
  });
  const contextOf = (context: string) => {
    if (context === "session.user") return session.user;
    if (context === "organization") return session.organizations.get(organization.id);
    return project.cd(context.slice("project ".length));
  };
  const outcomes = [];
  for (const row of LOADED_CODE_ROWS) {
    const outcome = await outcomeOf(() =>
      contextOf(row.context).invoke(LOADED_CODE_CALLS[row.call]),
    );
    // A refused script run settles `failed` on the log; its message crosses, its code does not.
    outcomes.push({
      ...row,
      outcome: /loaded code runs only in a project/.test(outcome) ? "FORBIDDEN" : outcome,
    });
  }
  expect(outcomes).toEqual(
    LOADED_CODE_ROWS.map((row) => ({ ...row, outcome: row.allowed ? "answered" : "FORBIDDEN" })),
  );
  // A refused processor left no row behind, and a refused facet no class to address.
  const rows = (await session.user.invoke(["itx", "processors", ["list"]])) as { name: string }[];
  expect(rows.map((row) => row.name)).not.toContain("tally-processor");
});
