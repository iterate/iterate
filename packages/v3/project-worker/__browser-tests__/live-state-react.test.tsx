// live-state-react.test.tsx — the React `useLiveState` hook rendered in a REAL browser (Chromium via
// Playwright, the `browser` project in vitest.config.ts). It is fed the EXACT wire the server sends —
// a seed `{rev, state}` through the door, and `{key, from, to, patch}` deltas (RFC-6902 via
// core/patch.ts) through the subscription target — so this proves the client half (the hook, the
// store, applyPatch) reassembles reduced ⊕ runtime live state and re-renders, in a browser, without a
// worker in the loop. The end-to-end against a live worker is the hosted demo page (client/demo.html).

import { expect, test } from "vitest";
import { diff, type PatchOp } from "../src/core/patch.ts";
import { useLiveState } from "../src/client/react.tsx";
import { createRoot } from "react-dom/client";

type PresenceLive = { ticks: number; lastPokeMs: number };

/** A faithful in-browser producer: emits the same door + deltas the DO emits. `set` diffs old→new
 *  with the SAME diff the server uses and pushes the patch to the subscribed target. */
function makeMockProducer(key: string, initial: PresenceLive) {
  let rev = 1000; // a per-"incarnation" epoch, like the real holder
  let state = initial;
  let target: ((delta: unknown) => void) | undefined;
  return {
    itx: {
      subscribe: async (input: {
        liveState: { key: string };
        target: (delta: unknown) => void;
      }) => {
        if (input.liveState.key === key) target = input.target;
        return { name: "watch", providedAtOffset: 0 };
      },
    },
    door: async () => ({ rev, state }),
    set(next: PresenceLive) {
      const patch = diff(state, next) as PatchOp[] | undefined;
      state = next;
      if (!patch) return;
      const from = rev;
      rev += 1;
      target?.({ key, from, to: rev, patch });
    },
  };
}

function Widget({ producer }: { producer: ReturnType<typeof makeMockProducer> }) {
  const { value, status } = useLiveState<PresenceLive>(producer.itx, {
    key: "presence",
    door: producer.door,
  });
  return (
    <div data-testid="out">
      {status}:{value ? `${value.ticks}/${value.lastPokeMs}` : "…"}
    </div>
  );
}

const until = async (fn: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("useLiveState renders reduced ⊕ runtime and re-renders on each delta, in a real browser", async () => {
  const producer = makeMockProducer("presence", { ticks: 0, lastPokeMs: 0 });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(<Widget producer={producer} />);

  const out = () => container.querySelector('[data-testid="out"]')?.textContent ?? "";

  // Seeded through the door: reduced 0 ticks, runtime lastPokeMs 0.
  await until(() => out() === "live:0/0");

  // REDUCED change → one delta → the DOM re-renders `ticks`, runtime untouched.
  producer.set({ ticks: 1, lastPokeMs: 0 });
  await until(() => out() === "live:1/0");

  // RUNTIME change → one delta → the DOM re-renders `lastPokeMs`, reduced preserved.
  producer.set({ ticks: 1, lastPokeMs: 42 });
  await until(() => out() === "live:1/42");

  // Both fields moved through ONE projection + chain, rendered live in the browser.
  expect(out()).toBe("live:1/42");

  root.unmount();
  container.remove();
});
