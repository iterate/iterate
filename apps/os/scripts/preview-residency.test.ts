import { describe, expect, test } from "vitest";
import {
  DURABLE_OBJECT_RESIDENCY_QUERY,
  DurableObjectResidencyAnswer,
  durableObjectAnalyticsCoverWindow,
  durableObjectResidencyVariables,
  durableObjectResidencyVerdict,
  durableObjectResidencyWindow,
  previewDurableObjectNamespaces,
  renderDurableObjectResidency,
} from "./preview-residency.ts";

const window = {
  start: new Date("2026-09-23T10:05:00Z"),
  end: new Date("2026-09-23T10:10:00Z"),
};
const namespaces = [
  { id: "ns-context", script: "os-next-preview", class: "IterateContextDurableObject" },
  { id: "ns-repo", script: "os-next-preview", class: "RepoDurableObject" },
];

/** One object's window minutes, as `"<name> <class namespace> <seconds a minute, one per minute>"`:
 *  `"prj_a.iterate/ ns-context 60 60 60 60 60"` is active all five minutes. */
function windowMinutes(...objects: string[]) {
  return objects.flatMap((object) => {
    const [name, namespaceId, ...seconds] = object.split(" ");
    return seconds.map((activeSeconds, minute) => ({
      dimensions: {
        datetimeMinute: new Date(window.start.getTime() + minute * 60_000).toISOString(),
        namespaceId: namespaceId!,
        objectId: `id-${name}`,
        name: name === "(unnamed)" ? null : name,
      },
      sum: { activeTime: Number(activeSeconds) * 1e6 },
    }));
  });
}

const runObjects = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ dimensions: { objectId: `id-${index}` } }));

describe("rule 1: the preview's objects are the objects in its own namespaces", () => {
  test.each([
    { namespace: { script: "os-next-preview", preview: { name: "pr1-x" } }, included: true },
    { namespace: { script: "os-next-preview", preview: { name: "pr2-y" } }, included: false },
    // the parent's own namespaces carry no preview
    { namespace: { script: "os-next-preview", preview: null }, included: false },
    // an app on top's preview of the same name is another worker's
    { namespace: { script: "dash-preview", preview: { name: "pr1-x" } }, included: false },
  ])("$namespace.script / $namespace.preview.name → $included", ({ namespace, included }) => {
    expect(
      previewDurableObjectNamespaces([{ id: "n", ...namespace }], {
        parentWorkerName: "os-next-preview",
        previewName: "pr1-x",
      }).length === 1,
    ).toBe(included);
  });
});

describe("rule 2: five whole minutes, five minutes after the suite ended", () => {
  test.each([
    { suiteEnded: "2026-09-23T09:59:40Z", start: "10:05", end: "10:10" },
    { suiteEnded: "2026-09-23T10:00:00Z", start: "10:05", end: "10:10" },
    { suiteEnded: "2026-09-23T10:00:01Z", start: "10:06", end: "10:11" },
  ])("suite ended $suiteEnded → $start–$end", ({ suiteEnded, start, end }) => {
    const { start: windowStart, end: windowEnd } = durableObjectResidencyWindow(
      new Date(suiteEnded),
    );
    expect([
      windowStart.toISOString().slice(11, 16),
      windowEnd.toISOString().slice(11, 16),
    ]).toEqual([start, end]);
  });

  test("the run's objects are counted from the minute the suite started through the minute it ended; each read carries its own moment", () => {
    expect(
      durableObjectResidencyVariables({
        accountTag: "acct",
        namespaceIds: ["ns-context"],
        window,
        suite: {
          started: new Date("2026-09-23T09:50:30Z"),
          ended: new Date("2026-09-23T09:59:40Z"),
        },
        readAt: new Date("2026-09-23T10:11:12.345Z"),
      }),
    ).toEqual({
      accountTag: "acct",
      namespaceIds: ["ns-context"],
      windowStart: "2026-09-23T10:05:00.000Z",
      windowEnd: "2026-09-23T10:10:00.000Z",
      readAt: "2026-09-23T10:11:12.345Z",
      suiteStarted: "2026-09-23T09:50:00.000Z",
      suiteEnded: "2026-09-23T10:00:00.000Z",
    });
  });

  test("the query reads the account's newest minute, the window's minutes and the run's objects, each bounded by the read's moment (Cloudflare caches an identical request)", () => {
    expect(DURABLE_OBJECT_RESIDENCY_QUERY).toContain(
      "filter: { datetimeMinute_geq: $windowStart, datetime_leq: $readAt }, orderBy: [datetimeMinute_DESC]",
    );
    expect(DURABLE_OBJECT_RESIDENCY_QUERY).toContain(
      "filter: { namespaceId_in: $namespaceIds, datetimeMinute_geq: $windowStart, datetimeMinute_lt: $windowEnd, datetime_leq: $readAt }",
    );
    expect(DURABLE_OBJECT_RESIDENCY_QUERY).toContain(
      "filter: { namespaceId_in: $namespaceIds, datetimeMinute_geq: $suiteStarted, datetimeMinute_lt: $suiteEnded, datetime_leq: $readAt }",
    );
  });
});

test.each([
  {
    newestMinute: "2026-09-23T10:11:00Z",
    previewNewestMinute: "2026-09-23T09:59:00Z",
    covers: true,
  },
  {
    newestMinute: "2026-09-23T10:13:00Z",
    previewNewestMinute: "2026-09-23T09:58:00Z",
    covers: true,
  },
  // the window's last minute (10:09) is still filling in while 10:10 is the newest
  {
    newestMinute: "2026-09-23T10:10:00Z",
    previewNewestMinute: "2026-09-23T09:59:00Z",
    covers: false,
  },
  {
    newestMinute: "2026-09-23T10:09:00Z",
    previewNewestMinute: "2026-09-23T09:59:00Z",
    covers: false,
  },
  { newestMinute: undefined, previewNewestMinute: "2026-09-23T09:59:00Z", covers: false },
  // the account is current but this new preview's own data trails it (main-6b39ca9, 2026-09-23)
  {
    newestMinute: "2026-09-23T10:11:00Z",
    previewNewestMinute: "2026-09-23T09:52:00Z",
    covers: false,
  },
  { newestMinute: "2026-09-23T10:11:00Z", previewNewestMinute: undefined, covers: false },
])(
  "the window (10:05–10:10, suite ended 09:59:40) is in once the account reports the minute after next and the preview its suite's end: account $newestMinute, preview $previewNewestMinute → $covers",
  ({ newestMinute, previewNewestMinute, covers }) => {
    const minute = (at: string | undefined) => (at ? [{ dimensions: { datetimeMinute: at } }] : []);
    const account = {
      newestMinute: minute(newestMinute),
      previewNewestMinute: minute(previewNewestMinute),
      windowMinutes: [],
      runObjects: [],
    };
    expect(
      durableObjectAnalyticsCoverWindow(account, window, new Date("2026-09-23T09:59:40Z")),
    ).toBe(covers);
  },
);

describe("rules 3–8: the verdict", () => {
  const residentByDesign = [
    { namePattern: /^prj_schedule_/, reason: "a scheduled append's alarm" },
  ];
  test.each([
    {
      rule: "4: active the whole window is a leak",
      minutes: ["prj_a.iterate/ ns-context 60 60 60 60 60"],
      resident: ["prj_a.iterate/ IterateContextDurableObject 300 leak"],
      failures: [
        "1 Durable Object resident for at least 80 % of the window with no client connected",
      ],
    },
    {
      rule: "4: four minutes of five is 80 %, a leak",
      minutes: ["prj_a.iterate/repos/config ns-context 60 60 60 60 0"],
      resident: ["prj_a.iterate/repos/config IterateContextDurableObject 240 leak"],
      failures: [
        "1 Durable Object resident for at least 80 % of the window with no client connected",
      ],
    },
    {
      rule: "4: a tail that ends inside the window is not resident",
      minutes: ["prj_a.iterate/ ns-context 60 60 60 30"],
      resident: [],
      failures: [],
    },
    {
      rule: "3: a facet doubles the meter, but a minute counts at most 60 s",
      minutes: ["prj_a.iterate/ ns-context 120 120"],
      resident: [],
      failures: [],
    },
    {
      rule: "5: resident by design is listed with its reason and passes",
      minutes: ["prj_schedule_1a2b3c4d_3_0.iterate/ ns-context 60 60 60 60 60"],
      resident: [
        "prj_schedule_1a2b3c4d_3_0.iterate/ IterateContextDurableObject 300 a scheduled append's alarm",
      ],
      failures: [],
    },
    {
      rule: "5: an unnamed object cannot be resident by design",
      minutes: ["(unnamed) ns-repo 60 60 60 60 60"],
      resident: ["(unnamed) RepoDurableObject 300 leak"],
      failures: [
        "1 Durable Object resident for at least 80 % of the window with no client connected",
      ],
    },
    {
      rule: "6: more objects than the cap fails",
      minutes: [],
      runObjectCount: 2001,
      resident: [],
      failures: ["the run touched 2001 Durable Objects, above the cap of 2000"],
    },
    {
      rule: "8: a run the analytics never saw fails",
      minutes: [],
      runObjectCount: 0,
      resident: [],
      failures: [
        "the analytics show no Durable Object the suite touched, so the gate cannot see this preview",
      ],
    },
  ])("rule $rule", ({ minutes, runObjectCount = 500, resident, failures }) => {
    const verdict = durableObjectResidencyVerdict({
      account: {
        newestMinute: [],
        previewNewestMinute: [],
        windowMinutes: windowMinutes(...minutes),
        runObjects: runObjects(runObjectCount),
      },
      namespaces,
      window,
      residentByDesign,
    });
    expect(
      verdict.residentDurableObjects.map(
        (object) =>
          `${object.name || "(unnamed)"} ${object.className} ${object.residentSeconds} ${object.residentByDesign || "leak"}`,
      ),
    ).toEqual(resident);
    expect(verdict.failures).toEqual(failures);
  });

  test.each([
    // the six careless-facet fixtures the list once allowed: no longer resident by design since a
    // loaded facet holding no claim is reset (FacetHost `resetUnclaimedLoadedFacets`)
    { name: "prj_live_bb1d9e20_28_0.iterate/", byDesign: false },
    { name: "prj_rest_bb1d9e20_13_8.iterate/", byDesign: false },
    { name: "prj_residency_careless_data_bb1d9e20_23_8.iterate/", byDesign: false },
    { name: "prj_residency_careless_live_bb1d9e20_23_9.iterate/", byDesign: false },
    { name: "prj_residency_careless_sibling_bb1d9e20_23_10.iterate/", byDesign: false },
    { name: "prj_residency_live_state_sink_bb1d9e20_23_11.iterate/", byDesign: false },
    // and every other fixture is a leak
    { name: "prj_live_bb1d9e20_28_0.iterate/repos/config", byDesign: false },
    { name: "prj_residency_root_bb1d9e20_23_6.iterate/", byDesign: false },
    { name: "prj_ws_bb1d9e20_12_2.iterate/", byDesign: false },
    { name: "prj_ws_bb1d9e20_12_2.iterate/workspaces/gone", byDesign: false },
    { name: "prj_lsruntime_bb1d9e20_28_2.iterate/", byDesign: false },
    { name: "prj_0ecaba34ebba4fc8925448d1a445a50c.iterate/", byDesign: false },
  ])("rule 5, the shipped list: $name resident by design → $byDesign", ({ name, byDesign }) => {
    const verdict = durableObjectResidencyVerdict({
      account: {
        newestMinute: [],
        previewNewestMinute: [],
        windowMinutes: windowMinutes(`${name} ns-context 60 60 60 60 60`),
        runObjects: runObjects(500),
      },
      namespaces,
      window,
    });
    expect(verdict.failures.length === 0).toBe(byDesign);
  });

  test("rule 7: an answer at the row limit fails, whatever it holds", () => {
    const verdict = durableObjectResidencyVerdict({
      account: {
        newestMinute: [],
        previewNewestMinute: [],
        windowMinutes: [],
        runObjects: runObjects(10_000),
      },
      namespaces,
      window,
    });
    expect(verdict.failures).toContain(
      "the analytics answer hit its 10000-row limit, so it cannot prove what is not resident",
    );
  });

  test("the longest resident comes first", () => {
    const verdict = durableObjectResidencyVerdict({
      account: {
        newestMinute: [],
        previewNewestMinute: [],
        windowMinutes: windowMinutes(
          "prj_b.iterate/ ns-context 60 60 60 60 0",
          "prj_a.iterate/ ns-context 60 60 60 60 60",
        ),
        runObjects: runObjects(10),
      },
      namespaces,
      window,
    });
    expect(verdict.residentDurableObjects.map((object) => object.name)).toEqual([
      "prj_a.iterate/",
      "prj_b.iterate/",
    ]);
  });
});

describe("the rendered verdict (the job log and the PR body)", () => {
  const verdictOf = (...minutes: string[]) =>
    durableObjectResidencyVerdict({
      account: {
        newestMinute: [],
        previewNewestMinute: [],
        windowMinutes: windowMinutes(...minutes),
        runObjects: runObjects(507),
      },
      namespaces,
      window,
    });

  test("a pass names the window and the run's object count, with no table", () => {
    expect(renderDurableObjectResidency(verdictOf())).toBe(
      [
        "#### Residency gate: passed",
        "",
        "Window 10:05–10:10 UTC, five minutes after the suite ended · 507 Durable Objects touched by the suite (cap 2000) · 0 resident for at least 80 % of the window. The release step redeploys the preview after this reading; an object still resident in the next run's window survived it.",
      ].join("\n"),
    );
  });

  test("a failure tables name, class and seconds, capped at maxRows", () => {
    const rendered = renderDurableObjectResidency(
      verdictOf(
        "prj_a.iterate/ ns-context 60 60 60 60 60",
        "prj_b.iterate/ ns-context 60 60 60 60 60",
      ),
      { maxRows: 1 },
    );
    expect(rendered.split("\n")[0]).toBe(
      "#### Residency gate: FAILED — 2 Durable Objects resident for at least 80 % of the window with no client connected",
    );
    expect(rendered).toContain(
      "| Durable Object name | class | seconds resident of 300 | resident by design |",
    );
    expect(rendered).toContain(
      "| `prj_a.iterate/` | IterateContextDurableObject | 300 | no: a leak |",
    );
    expect(rendered).not.toContain("prj_b");
    expect(rendered).toContain("| … and 1 more in the job log | | | |");
  });
});

describe("the GraphQL answer", () => {
  test("parses Cloudflare's shape, and refuses an errors envelope", () => {
    const answer = {
      data: {
        viewer: {
          accounts: [
            {
              newestMinute: [{ dimensions: { datetimeMinute: "2026-09-23T10:09:00Z" } }],
              previewNewestMinute: [{ dimensions: { datetimeMinute: "2026-09-23T09:59:00Z" } }],
              windowMinutes: windowMinutes("prj_a.iterate/ ns-context 60"),
              runObjects: runObjects(1),
            },
          ],
        },
      },
    };
    expect(DurableObjectResidencyAnswer.safeParse(answer).success).toBe(true);
    expect(
      DurableObjectResidencyAnswer.safeParse({
        data: null,
        errors: [{ message: "not authorized for that account" }],
      }).success,
    ).toBe(false);
  });
});
