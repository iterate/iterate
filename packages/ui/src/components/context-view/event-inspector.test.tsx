// @vitest-environment jsdom
// The inspector's paging: ← → move through the loaded log from anywhere on the page — even under a
// popup that stops arrow keys on bubble, as Base UI's does — but never out of a field, never with a
// modifier, and ← on the oldest loaded event reads the page below and steps onto it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { EventInspector } from "./event-inspector.tsx";
import type { ContextViewEvent } from "./types.tsx";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test("← → page the loaded log, even when the popup stops arrow keys on bubble", async () => {
  const onNavigate = vi.fn();
  using _inspector = await mount({ events: log(3, 4, 7), offset: 4, onNavigate });
  document.body.addEventListener("keydown", (key) => key.stopPropagation());
  press("ArrowRight");
  press("ArrowLeft");
  expect(onNavigate.mock).toMatchObject({ calls: [[7], [3]] });
});

test("a field keeps its arrows, and a modifier is never a page", async () => {
  const onNavigate = vi.fn();
  using _inspector = await mount({ events: log(3, 4, 7), offset: 4, onNavigate });
  const field = document.body.appendChild(document.createElement("input"));
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  press("ArrowRight", { metaKey: true });
  press("ArrowLeft", { shiftKey: true });
  expect(onNavigate).not.toHaveBeenCalled();
});

test("← on the oldest loaded event reads the page below, then steps onto its newest event", async () => {
  const onNavigate = vi.fn();
  const older = { loadOlder: vi.fn(), loading: false, exhausted: false };
  using inspector = await mount({ events: log(10, 11), offset: 10, onNavigate, older });
  press("ArrowLeft");
  expect(older.loadOlder).toHaveBeenCalledOnce();
  expect(onNavigate).not.toHaveBeenCalled();
  await inspector.rerender({ events: log(6, 8, 10, 11), offset: 10, onNavigate, older });
  expect(onNavigate.mock).toMatchObject({ calls: [[8]] });
});

test("a link to an event below the loaded pages reads older pages until it is loaded", async () => {
  const older = { loadOlder: vi.fn(), loading: false, exhausted: false };
  using _inspector = await mount({ events: log(900, 901), offset: 5, onNavigate: vi.fn(), older });
  expect(older.loadOlder).toHaveBeenCalled();
  expect(document.body.textContent).toContain("Reading older events to reach #5");
});

type Props = Parameters<typeof EventInspector>[0];

/** The inspector mounted in the document; disposing unmounts it and clears the page. */
async function mount(props: Omit<Props, "onClose" | "older"> & { older?: Props["older"] }) {
  const root: Root = createRoot(document.body.appendChild(document.createElement("div")));
  const rerender = (next: typeof props) =>
    act(() =>
      root.render(
        <EventInspector
          older={{ loadOlder: () => {}, loading: false, exhausted: true }}
          onClose={() => {}}
          {...next}
        />,
      ),
    );
  await rerender(props);
  return {
    rerender,
    [Symbol.dispose]() {
      act(() => root.unmount());
      document.body.replaceChildren();
    },
  };
}

function press(key: string, modifiers: KeyboardEventInit = {}) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...modifiers }));
  });
}

function log(...offsets: number[]): ContextViewEvent[] {
  return offsets.map((offset) => ({
    offset,
    type: "manual/thing-happened",
    createdAt: new Date(Date.UTC(2026, 8, 25, 0, 0, offset)).toISOString(),
  }));
}
