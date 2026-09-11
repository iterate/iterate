// Public operational proof for a processor checkpoint refusal. This deliberately stays small:
// four ~1 MiB events cross the 2 MB checkpoint ceiling without using the 144 MiB memory fixture.

import { expect, test } from "vitest";
import { append, codeOf, freshCtx, openItx, subscriptions, until } from "./support/client.ts";

const MiB = 1024 * 1024;
const HOARDER_SOURCE = {
  "cap.js": `import { StreamProcessor, StreamProcessorDurableObject } from "./processor.js";
class Hoarder extends StreamProcessor {
  contract = { slug: "hoarder", version: "1", consumes: ["blob"], emits: [], initialState: () => ({ blobs: [] }) };
  reduce({ event, state }) { return { blobs: [...state.blobs, event.payload.blob] }; }
  projectLiveState(state) { return { count: state.blobs.length }; }
}
export class HoarderDurableObject extends StreamProcessorDurableObject { processor = new Hoarder(); }`,
};

type HaltedRow = {
  name: string;
  halted?: { afterOffset: number; attempts: number; error?: string };
};

const haltFor = async (itx: any): Promise<HaltedRow | undefined> =>
  (await subscriptions(itx)).find((row) => row.name === "hoarder" && row.halted) as
    | HaltedRow
    | undefined;

test(
  "public processor checkpoint refusal halts once, survives a fresh session, and leaves the stream writable",
  { timeout: 90_000 },
  async () => {
    const ctx = freshCtx("checkpoint-halt");
    const utc = new Date().toISOString();
    const itx = openItx(ctx);
    let enabled = false;
    process.stdout.write(
      `${JSON.stringify({ event: "e2e.processor-checkpoint-halt", ctx, utc })}\n`,
    );
    try {
      await itx.enableProcessor("hoarder", {
        source: HOARDER_SOURCE,
        className: "HoarderDurableObject",
        consumes: ["blob"],
      });
      enabled = true;
      let lastOffset = 0;
      for (let n = 0; n < 4; n++) {
        const [event] = await append(itx, {
          type: "blob",
          payload: { blob: `${n}:` + "x".repeat(MiB) },
        });
        lastOffset = event.offset as number;
      }

      const halted = await until("the public checkpoint halt", () => haltFor(itx), 45_000);
      expect(halted.halted).toMatchObject({
        attempts: 1,
        error: expect.stringMatching(/checkpoint "hoarder".*one storage cell/),
      });
      expect(halted.halted!.afterOffset).toBeLessThan(lastOffset);

      const snapshotError = await itx.invoke("itx.facets.get('hoarder').snapshot()").then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(codeOf(snapshotError)).toBe("REDUCE_CHECKPOINT_TOO_LARGE");

      const [later] = await append(itx, { type: "blob", payload: { blob: "later" } });
      const afterLater = await haltFor(itx);
      expect(afterLater?.halted).toEqual(halted.halted);
      expect(later.offset).toBeGreaterThan(lastOffset);

      const fresh = openItx(ctx);
      expect((await haltFor(fresh))?.halted).toEqual(halted.halted);
      const [parentWrite] = await append(fresh, { type: "parent-write", payload: { ok: true } });
      expect(parentWrite.offset).toBeGreaterThan(later.offset);
    } finally {
      // This test owns the synthetic facet. Cleanup is deliberately awaited: a failure to remove it
      // is operational evidence, never hidden by a best-effort catch.
      if (enabled) await itx.disableProcessor("hoarder");
    }
  },
);
