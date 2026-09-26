// e2e/facet-abort-storage-reset.e2e.test.ts — A CLOUDFLARE FAULT, PINNED, AND THE PLATFORM'S
// WORKAROUND (context/facet-host.ts FACET_START_WATCHDOG_MS).
//
// A facet whose SQLite database took a few dozen pages of writes (40 rows of 2 KB) and then STOPS —
// `ctx.facets.abort(name)`, or an eviction with its context — makes one of the context's next
// storage commits fail with "Internal error in Durable Object storage caused object to be reset;
// reference = …": the whole object resets, and every call in flight on it fails. The facet started
// again before the context commits anything more avoids it. So the platform never stops a facet
// without starting it again, and a birth starts every facet the last incarnation ran before its
// first write.
//
// THE PIN: the raw fault, with no platform code between the abort and the fault (a loaded facet
// aborts its OWN child facet), as a createFailing. It resets the context it runs on, so it is tagged
// `slow` (docs/testing.md#slow-rows): every main push runs it, and a PR runs it when it turns the
// slow rows on or edits this file. When it goes red because it passed, Cloudflare fixed the fault:
// remove the workaround (FACET_START_WATCHDOG_MS names every piece) and keep the pin's body as a
// plain row.
import { expect } from "vitest";
import { E2E_CI_RETRIES } from "@iterate-com/shared/test-support/e2e-policy";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { freshCtx, openItx, sleep } from "./support/client.ts";
import { deployedOnly } from "./support/project-host.ts";

createFailing(deployedOnly, /Internal error in Durable Object storage caused object to be reset/, {
  timeoutMs: 60_000,
  retries: process.env.CI ? E2E_CI_RETRIES : 0,
})(
  "a loaded facet aborting its own child facet right after 40 rows of 2 KB should not reset its context",
  { tags: ["slow"] },
  async () => {
    const itx = openItx(freshCtx("facet_abort_reset"));
    expect(await call(itx, "childWrite", 40)).toBe(40);
    await call(itx, "childAbort");
    // The context's next five commits, 200 ms apart: the fault lands on one of them.
    for (let k = 0; k < 5; k++) {
      await itx.append({ type: "facet-abort-reset/probe", payload: { k } });
      await sleep(200);
    }
  },
);

/** A loaded facet with a child facet of ITS OWN (`ctx.facets` inside the facet): `childWrite(n)`
 *  writes n rows of 2 KB there, one commit each — a table of many pages; `childAbort()` aborts it. */
const WRITER_SOURCE = {
  "worker.js": `import { DurableObject } from "cloudflare:workers";
import { FacetDurableObject } from "iterate/sdk";
const put = (storage, key, i) => storage.kv.put(key, "x".repeat(2048) + i);
const pause = () => new Promise((resolve) => setTimeout(resolve, 1));
export class ChildDurableObject extends DurableObject {
  async write(n) {
    for (let i = 0; i < n; i++) { put(this.ctx.storage, "row" + i, i); await pause(); }
    return n;
  }
}
export class WriterDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "childWrite", "childAbort"];
  #child() {
    return this.ctx.facets.get("child", () => ({ class: this.ctx.exports.ChildDurableObject }));
  }
  childWrite(n) { return this.#child().write(n); }
  childAbort() { this.ctx.facets.abort("child", new Error("aborted by its parent facet")); return true; }
}`,
};

function call(itx: any, method: string, ...args: unknown[]) {
  return itx.invoke([
    "itx",
    "facets",
    ["get", "writer", { source: WRITER_SOURCE, className: "WriterDurableObject" }],
    [method, ...args],
  ]);
}
