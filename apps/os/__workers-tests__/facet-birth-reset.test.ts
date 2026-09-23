// __workers-tests__/facet-birth-reset.test.ts — which facets a context's birth resets (FacetHost
// `resetUnclaimedLoadedFacets`): every LOADED facet that holds no claim on the context's alarm, and
// no other. A claimed facet's work outlives the call that started it on purpose; a first-party facet
// keeps no startup memo and is never reset. The reset is named on the incarnation's wake record.
//
// What the reset ENDS — a careless facet still running after its context was evicted, billed — is a
// deployed fact (workerd's harness cannot evict a context whose facet is live, workerd#6800): the
// careless rows of e2e/context-residency.e2e.test.ts read the facet's own start across incarnations.

import { evictDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import type { StreamEvent } from "iterate/next/stream/processor";
import { releasePins, stub } from "./support.ts";

test("a context's birth resets its loaded facets that hold no claim, names them on its wake record, and spares a claimed one", async () => {
  const ctx = "prj_facet_birth_reset";
  const s = stub(ctx);
  const spec = {
    source: {
      "cap.js": /* js */ `import { DurableObject } from "cloudflare:workers";
export class PlainDurableObject extends DurableObject { hello() { return "hello"; } }`,
    },
    className: "PlainDurableObject",
  };
  for (const name of ["idle", "busy"])
    expect(await s.invoke(["itx", "facets", ["get", name, spec], ["hello"]])).toBe("hello");
  // What `runInBackground` holds while an attempt is in flight: a claim on the context's alarm.
  await s.invoke(["itx", "processors", ["claim", "busy", Date.now() + 60_000]]);
  await releasePins(ctx); // workerd keeps a DO with a live facet resident; the edge does not
  await evictDurableObject(s);

  const { events } = (await s.invoke(["itx", ["readEvents", 0, 500]])) as { events: StreamEvent[] };
  const woken = events.filter((event) => event.type === "events.iterate.com/stream/woken");
  expect(woken.length).toBe(2);
  expect(woken[0]!.payload).not.toHaveProperty("facetsReset");
  expect(woken[1]!.payload).toMatchObject({ facetsReset: ["idle"] });
  // Both answer after the birth: the reset facet from its startup memo, the claimed one as it was.
  for (const name of ["idle", "busy"])
    expect(await s.invoke(["itx", "facets", ["get", name], ["hello"]])).toBe("hello");
  await s.invoke(["itx", "processors", ["claim", "busy", null]]);
});
