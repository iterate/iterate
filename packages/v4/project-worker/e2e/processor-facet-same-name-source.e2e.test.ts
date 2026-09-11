// Public explicit source replacement proof. It deliberately uses no processor state: this is about
// which facet implementation a caller reaches, not whether a prior checkpoint can be replayed.
// Direct same-name re-enable is intentionally not specified here: current M1 source elision leaves
// a warm facet on its old memo. Changing that requires a separately designed hot-reload contract.

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

const source = (version: string) => ({
  "cap.js": `import { DurableObject } from "cloudflare:workers";
export class VersionDurableObject extends DurableObject {
  snapshot() { return { version: ${JSON.stringify(version)} }; }
  processEventBatch() {}
  catchUpFromLog() {}
}`,
});

test("disabling then enabling a processor name reaches its replacement source", async () => {
  const itx = openItx(freshCtx("same-name-source"));
  const name = "version";
  let enabled = false;
  try {
    await itx.enableProcessor(name, {
      source: source("A"),
      className: "VersionDurableObject",
    });
    enabled = true;
    expect(await itx.invoke(`itx.facets.get('${name}').snapshot()`)).toEqual({ version: "A" });

    await itx.disableProcessor(name);
    enabled = false;
    await itx.enableProcessor(name, {
      source: source("B"),
      className: "VersionDurableObject",
    });
    enabled = true;
    expect(await itx.invoke(`itx.facets.get('${name}').snapshot()`)).toEqual({ version: "B" });
  } finally {
    if (enabled) await itx.disableProcessor(name);
  }
});
