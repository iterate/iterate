// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@iterate-com/ui/components/serialized-object-code-block", () => ({
  SerializedObjectCodeBlock: () => <div>event payload</div>,
}));

vi.mock("@iterate-com/ui/components/sheet", () => ({
  SheetDescription: (props: ComponentProps<"p">) => <p {...props} />,
  SheetHeader: (props: ComponentProps<"header">) => <header {...props} />,
  SheetTitle: (props: ComponentProps<"div">) => <div {...props} />,
}));

vi.mock("~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts", () => ({
  useStreamQuery: (_database: unknown, sql: string) => {
    if (sql.includes("WHERE offset = ?")) {
      return {
        data: [
          {
            offset: 2,
            type: "agents/test",
            created_at: "2026-07-16T12:00:01.000Z",
            raw_json: "{}",
          },
        ],
        status: "ok",
      };
    }
    if (sql.includes("offset < ?")) {
      return { data: [{ offset: 1, created_at: "2026-07-16T12:00:00.000Z" }], status: "ok" };
    }
    if (sql.includes("offset > ?")) {
      return { data: [{ offset: 3, created_at: "2026-07-16T12:00:02.000Z" }], status: "ok" };
    }
    return { data: [{ total: 3 }], status: "ok" };
  },
}));

import { RawEventInspectorContent } from "./raw-event-inspector-panel.tsx";

const mountedRoots: Array<ReturnType<typeof createRoot>> = [];

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
});

test("retained exit content cannot navigate and reopen the raw-event inspector", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  mountedRoots.push(root);
  const onNavigate = vi.fn();

  const render = async (navigationEnabled: boolean) => {
    await act(async () => {
      root.render(
        <RawEventInspectorContent
          database={{} as never}
          navigationEnabled={navigationEnabled}
          offset={2}
          onNavigate={onNavigate}
        />,
      );
    });
  };

  await render(true);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  expect(onNavigate).toHaveBeenCalledWith(3);

  onNavigate.mockClear();
  await render(false);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  host.querySelectorAll("button")[1]?.click();
  expect(onNavigate).not.toHaveBeenCalled();
  expect([...host.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
});

test("arrow keys still page when a Base UI sheet would stopPropagation on bubble", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  const onNavigate = vi.fn();

  await act(async () => {
    root.render(
      <RawEventInspectorContent
        database={{} as never}
        navigationEnabled
        offset={2}
        onNavigate={onNavigate}
      />,
    );
  });

  // Mimic @base-ui/react DialogPopup: composite keys are stopPropagated on the
  // popup so nested composites do not leak. A bubble-only window listener never
  // sees the event; capture-phase is required.
  const stopCompositeKeys = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") event.stopPropagation();
  };
  host.addEventListener("keydown", stopCompositeKeys);

  const nextButton = host.querySelectorAll("button")[1];
  expect(nextButton).toBeTruthy();
  nextButton?.focus();
  nextButton?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
  );
  expect(onNavigate).toHaveBeenCalledWith(3);

  onNavigate.mockClear();
  const prevButton = host.querySelectorAll("button")[0];
  prevButton?.focus();
  prevButton?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
  );
  expect(onNavigate).toHaveBeenCalledWith(1);

  host.removeEventListener("keydown", stopCompositeKeys);
  host.remove();
});
