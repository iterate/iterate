// The platform's own events as sentences: a wake names what woke it and what began that chain.
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { coreEventRenderers } from "./core-renderers.tsx";

const woken = coreEventRenderers["events.iterate.com/itx/woken"]!;

test("a wake names its call, its caller and what began the chain that woke it", () => {
  const row = woken({
    offset: 9,
    type: "events.iterate.com/itx/woken",
    createdAt: "2026-09-29T12:00:00.000Z",
    payload: { incarnation: 3, cause: "call", caller: "loaded", call: "itx.repos.get.modules" },
    source: {
      cause: {
        chain: "2026-09-29T12:00:00.000Z with a request to acme.com (ray 8f1c-LHR) ~k3j2d",
        depth: 1,
      },
    },
  });
  expect(renderToStaticMarkup(<>{row}</>).replace(/<[^>]+>/g, "")).toBe(
    "Woke · call itx.repos.get.modules (loaded) · incarnation 3 · began with a request to acme.com (ray 8f1c-LHR)",
  );
});

test("an alarm's wake names what it came back for, and a wake with no cause names no chain", () => {
  const row = woken({
    offset: 2,
    type: "events.iterate.com/itx/woken",
    createdAt: "2026-09-29T12:00:00.000Z",
    payload: { incarnation: 2, cause: "alarm", due: ["schedule"] },
  });
  expect(renderToStaticMarkup(<>{row}</>).replace(/<[^>]+>/g, "")).toBe(
    "Woke · alarm (schedule) · incarnation 2",
  );
});
