// __workers-tests__/forged-facet-inputs.test.ts — WHAT FEEDS A FACET IS THE PLATFORM'S, NEVER A
// CALLER'S. A facet that reduces its context's log — a first-party processor (`account`, `project`) or
// a person's own loaded one — is fed by the subscription delivery loop: the log's committed events,
// with the scanned range that proves them. A person who reaches `itx.facets.get(name)` on a context
// they hold must not hand that facet a batch of their own: a forged fact would enter its state
// without ever being on the log, and a forged range would move its checkpoint past real events it
// would then never reduce. Nor may they drive the facet's catch-up or its revive, which only the
// delivery loop and the context's alarm schedule. Likewise the `secret` facet holds a value only
// through `itx.secrets`, whose verbs append the attributed `secret/set` / `secret/deleted` facts:
// nobody writes, clears, begins or completes an OAuth exchange on it directly, and the operator's
// export takes the admin credential only over native RPC, never through an expression a project's
// rules could read.
//
// Every test acts as a person who signed in with the login form (the export's, as the operator) and
// asserts what can be observed afterwards — the facet's state and checkpoint, what the next real fact
// does, whether the secret's value still verifies, whether a direct call answered — never which
// mechanism refused it.

import { expect, test, vi } from "vitest";
import { hmacSha256Hex } from "../src/secrets.ts";
import { adminCredentials, signedInSession, stub } from "./support.ts";

/** How far past the facet's checkpoint a forged range claims the log reaches. */
const FORGED_RANGE_LENGTH = 1000;

type Snapshot<State> = { offset: number; state: State };

// ── forged batches ──

test("a signed-in person pushes a forged batch into their own `account` facet: no forged fact enters its state, its checkpoint does not move past the log, and their next real fact still folds", async () => {
  const session = await signedInSession("forged-account@example.com");
  const account = session.user;
  const snapshot = () =>
    account.invoke(["itx", "facets", ["get", "account"], ["snapshot"]]) as Promise<
      Snapshot<{ authentications: { operationId: string }[]; secrets: Record<string, unknown> }>
    >;
  const before = await snapshot();
  const forgedThrough = before.offset + FORGED_RANGE_LENGTH;
  const forgedBatch = [
    forgedEvent(forgedThrough - 1, "events.iterate.com/account/authenticated", {
      credential: "admin-secret",
      at: Date.now(),
      operationId: "forged",
    }),
    forgedEvent(forgedThrough, "events.iterate.com/secret/set", {
      path: "/secrets/forged",
      urls: ["https://evil.example.test"],
    }),
  ];

  await attempted(() =>
    account.invoke([
      "itx",
      "facets",
      ["get", "account"],
      ["processEventBatch", forgedBatch, { after: before.offset, through: forgedThrough }],
    ]),
  );

  const after = await snapshot();
  expect.soft(after.state.authentications.map((fact) => fact.operationId)).not.toContain("forged");
  expect.soft(Object.keys(after.state.secrets)).not.toContain("/secrets/forged");
  expect.soft(after.offset).toBeLessThan(forgedThrough);
  // The next real fact on the account: a secret of the person's own, its certificate cross-posted
  // to their account, where `itx.secrets.list()` reads the catalog.
  await account.invoke([
    "itx",
    "secrets",
    ["set", "/secrets/after-forgery", "material", { urls: ["https://api.example.test"] }],
  ]);
  const listed = (await account.invoke(["itx", "secrets", ["list"]])) as { path: string }[];
  expect(listed.map((row) => row.path)).toEqual(["/secrets/after-forgery"]);
});

test("a project member pushes a forged batch into the `project` facet at `/`: no forged certificate enters the catalog, its checkpoint does not move past the log, and the next real secret still lists", async () => {
  const session = await signedInSession("forged-project@example.com");
  const project = await session.projects.create({ project: "forged-project" });
  const snapshot = () =>
    project.invoke(["itx", "facets", ["get", "project"], ["snapshot"]]) as Promise<
      Snapshot<{ secrets: Record<string, unknown> }>
    >;
  const before = await snapshot();
  const forgedThrough = before.offset + FORGED_RANGE_LENGTH;

  await attempted(() =>
    project.invoke([
      "itx",
      "facets",
      ["get", "project"],
      [
        "processEventBatch",
        [
          forgedEvent(forgedThrough, "events.iterate.com/secret/set", {
            path: "/secrets/forged",
            urls: ["https://evil.example.test"],
          }),
        ],
        { after: before.offset, through: forgedThrough },
      ],
    ]),
  );

  const after = await snapshot();
  expect.soft(Object.keys(after.state.secrets)).not.toContain("/secrets/forged");
  expect.soft(after.offset).toBeLessThan(forgedThrough);
  await project.invoke([
    "itx",
    "secrets",
    ["set", "/secrets/after-forgery", "material", { urls: ["https://api.example.test"] }],
  ]);
  const listed = (await project.invoke(["itx", "secrets", ["list"]])) as { path: string }[];
  expect(listed.map((row) => row.path)).toEqual(["/secrets/after-forgery"]);
});

/** A person's own processor, loaded from source: it counts the ticks on its context's log. */
const TALLY_SOURCE = {
  "cap.js": /* js */ `
import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "tally",
  version: "1.0.0",
  description: "counts the ticks on its context's log",
  stateSchema: z.object({ ticks: z.number().default(0) }),
  consumes: ["*"],
  emits: [],
});
class TallyProcessor extends StreamProcessor {
  contract = contract;
  reduce({ state, event }) {
    return event.type === "events.iterate.com/test/ticked" ? { ticks: state.ticks + 1 } : state;
  }
}
export class TallyDurableObject extends StreamProcessorDurableObject {
  processor = new TallyProcessor();
}
`,
};

test("a project member pushes forged ticks into their own loaded processor's facet: its count and checkpoint are untouched, and the next real tick still counts", async () => {
  const { facet, tick, snapshot } = await projectWithTally(
    "forged-loaded@example.com",
    "forged-loaded",
  );
  const before = await snapshot();
  expect(before).toMatchObject({ state: { ticks: 1 } });
  const forgedThrough = before.offset + FORGED_RANGE_LENGTH;
  const forgedTicks = [1, 2, 3, 4, 5].map((n) =>
    forgedEvent(before.offset + n, "events.iterate.com/test/ticked", {}),
  );

  await attempted(() =>
    facet(["processEventBatch", forgedTicks, { after: before.offset, through: forgedThrough }]),
  );

  const after = await snapshot();
  expect.soft(after.state.ticks).toBe(1);
  expect.soft(after.offset).toBeLessThan(forgedThrough);
  await tick();
  expect(await snapshot()).toMatchObject({ state: { ticks: 2 } });
});

test("a project member cannot drive their loaded processor's catch-up or revive: both are the platform's to schedule, and neither answers a caller", async () => {
  const { facet } = await projectWithTally("drive-loaded@example.com", "drive-loaded");
  expect.soft(await attempted(() => facet(["catchUpFromLog"]))).toBe("refused");
  expect(await attempted(() => facet(["revive"]))).toBe("refused");
});

// ── the `secret` facet: only `itx.secrets` writes it ──

test("a project member writes the `secret` facet directly: refused, and the value `itx.secrets.set` stored is the one that still verifies", async () => {
  const { secretFacet, verifies } = await projectWithSecret(
    "direct-secret-write@example.com",
    "direct-secret-write",
  );
  expect
    .soft(
      await attempted(() =>
        secretFacet([
          "write",
          { material: "forged-key", urls: ["https://evil.example.test"], refresh: null },
        ]),
      ),
    )
    .toBe("refused");
  expect(await verifies("forged-key")).toBe(false);
  expect(await verifies("original-key")).toBe(true);
});

test("a project member clears the `secret` facet directly: refused, and the value still verifies", async () => {
  const { secretFacet, verifies } = await projectWithSecret(
    "direct-secret-clear@example.com",
    "direct-secret-clear",
  );
  expect.soft(await attempted(() => secretFacet(["clear"]))).toBe("refused");
  expect(await verifies("original-key")).toBe(true);
});

const OAUTH_PROVIDER = {
  authorizationEndpoint: "https://provider.example.test/authorize",
  tokenEndpoint: "https://provider.example.test/token",
  clientId: "a-client",
};

test("a project member begins an OAuth attempt on the `secret` facet directly, with a callback origin of their choosing: refused", async () => {
  const { secretFacet } = await projectWithSecret(
    "direct-secret-begin@example.com",
    "direct-secret-begin",
  );
  expect(
    await attempted(() =>
      secretFacet([
        "beginOAuth",
        {
          ...OAUTH_PROVIDER,
          clientSecret: "",
          clientAuth: "client_secret_basic",
          urls: ["https://provider.example.test"],
          extra: {},
        },
        "https://evil.example.test",
      ]),
    ),
  ).toBe("refused");
});

test("a project member completes an OAuth exchange on the `secret` facet directly, skipping the `secret/set` fact: refused, and no token is live", async () => {
  const { project, verifies } = await projectWithSecret(
    "direct-secret-complete@example.com",
    "direct-secret-complete",
  );
  // The attempt begins the platform's way; its nonce rides the signed `state` of the authorize URL.
  const { authorizationUrl } = (await project.invoke([
    "itx",
    "secrets",
    ["beginOAuth", "/secrets/oauth", OAUTH_PROVIDER],
  ])) as { authorizationUrl: string };
  const [claims] = new URL(authorizationUrl).searchParams.get("state")!.split(".");
  const { nonce } = JSON.parse(
    atob(
      claims!
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(claims!.length / 4) * 4, "="),
    ),
  ) as { nonce: string };
  // The provider answers the exchange with a token.
  const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    return request.url === OAUTH_PROVIDER.tokenEndpoint
      ? Response.json({ access_token: "direct-access-token", refresh_token: "direct-refresh" })
      : new Response("not found", { status: 404 });
  });
  try {
    expect
      .soft(
        await attempted(() =>
          project
            .cd("/secrets/oauth")
            .invoke([
              "itx",
              "facets",
              ["get", "secret"],
              ["completeOAuth", { code: "a-code", nonce }],
            ]),
        ),
      )
      .toBe("refused");
  } finally {
    provider.mockRestore();
  }
  expect(await verifies("direct-access-token", "/secrets/oauth", "accessToken")).toBe(false);
});

test("the operator's secret export takes the admin credential only over native RPC — never through an expression a project's rules could read", async () => {
  const session = await signedInSession("direct-secret-export@example.com");
  const project = (await session.projects.create({ project: "direct-secret-export" })) as {
    invoke(call: unknown[]): Promise<unknown>;
  };
  await project.invoke([
    "itx",
    "secrets",
    ["set", "/secrets/hook", "original-key", { urls: ["https://api.example.test"] }],
  ]);
  const { projectId } = (await project.invoke(["itx", ["whoami"]])) as { projectId: string };
  expect(
    await attempted(() =>
      stub(`${projectId}.iterate/secrets/hook`).invoke([
        "itx",
        "facets",
        ["get", "secret"],
        ["exportForProjectSeed", adminCredentials().secret],
      ]),
    ),
  ).toBe("refused");
});

/** What a direct call came to: it answered, or it was refused (whatever refused it). */
async function attempted(call: () => Promise<unknown>): Promise<"answered" | "refused"> {
  try {
    await call();
    return "answered";
  } catch {
    return "refused";
  }
}

/** A committed-looking event no log ever held, at `offset`. */
function forgedEvent(offset: number, type: string, payload: unknown) {
  return { offset, type, payload, path: "/", createdAt: new Date().toISOString() };
}

/** A project with the tally processor enabled at `/tally` and one real tick reduced. */
async function projectWithTally(email: string, slug: string) {
  const session = await signedInSession(email);
  const project = await session.projects.create({ project: slug });
  const tally = project.cd("/tally");
  await tally.invoke([
    "itx",
    "processors",
    ["enable", "tally", { source: TALLY_SOURCE, className: "TallyDurableObject" }],
  ]);
  const facet = (call: unknown[]) => tally.invoke(["itx", "facets", ["get", "tally"], call]);
  const tick = async () => {
    const [appended] = (await tally.invoke([
      "itx",
      ["append", { type: "events.iterate.com/test/ticked" }],
    ])) as { offset: number }[];
    await facet(["waitUntilProcessed", { offset: appended!.offset }]);
  };
  await tick();
  return {
    facet,
    tick,
    snapshot: () => facet(["snapshot"]) as Promise<Snapshot<{ ticks: number }>>,
  };
}

/** A project with `/secrets/hook` set through `itx.secrets.set`, and what a caller reaches: the
 *  secret's facet directly, and whether a key verifies as the stored value. */
async function projectWithSecret(email: string, slug: string) {
  const session = await signedInSession(email);
  const project = await session.projects.create({ project: slug });
  await project.invoke([
    "itx",
    "secrets",
    ["set", "/secrets/hook", "original-key", { urls: ["https://api.example.test"] }],
  ]);
  const verifies = async (key: string, secretPath = "/secrets/hook", field?: string) =>
    project.invoke([
      "itx",
      "secrets",
      [
        "verifyHmac",
        secretPath,
        {
          payload: "a webhook body",
          signature: await hmacSha256Hex(key, "a webhook body"),
          field,
        },
      ],
    ]) as Promise<boolean>;
  expect(await verifies("original-key")).toBe(true);
  return {
    project,
    secretFacet: (call: unknown[]) =>
      project.cd("/secrets/hook").invoke(["itx", "facets", ["get", "secret"], call]),
    verifies,
  };
}
