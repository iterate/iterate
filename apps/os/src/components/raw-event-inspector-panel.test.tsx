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
        status: "success",
      };
    }
    if (sql.includes("offset < ?")) {
      return { data: [{ offset: 1, created_at: "2026-07-16T12:00:00.000Z" }], status: "success" };
    }
    if (sql.includes("offset > ?")) {
      return { data: [{ offset: 3, created_at: "2026-07-16T12:00:02.000Z" }], status: "success" };
    }
    return { data: [{ total: 3 }], status: "success" };
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
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
  expect(onNavigate).toHaveBeenCalledWith(3);

  onNavigate.mockClear();
  await render(false);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
  host.querySelectorAll("button")[1]?.click();
  expect(onNavigate).not.toHaveBeenCalled();
  expect([...host.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
});
