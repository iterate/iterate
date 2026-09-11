// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { StreamEvent } from "iterate/processors";
import type { AgentPillComposer } from "./agent-pill-composer.tsx";
import { StreamViewComposer } from "./stream-view-composer.tsx";
import type { StreamBrowserStore } from "~/domains/streams/client-libraries/browser/stream-browser-store.ts";

const view = vi.hoisted(() => ({ props: null as ComponentProps<typeof AgentPillComposer> | null }));
vi.mock("./agent-pill-composer.tsx", () => ({
  AgentPillComposer: (props: ComponentProps<typeof AgentPillComposer>) => {
    view.props = props;
    return <output>{props.isSubmitting ? "pending" : "ready"}</output>;
  },
}));
vi.mock("./example-events-panel.tsx", () => ({ ExampleEventsPanel: () => null }));

test("keeps submission pending between append response and server acknowledgement, including a no-op result", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  const root = createRoot(host);
  let committed = StreamEvent.parse({
    path: "/agents/test",
    offset: 10,
    createdAt: new Date(0).toISOString(),
    type: "events.iterate.com/agents/context-added",
    payload: { role: "user", content: "Hello" },
  });
  const noteExternalAppend = vi.fn();
  const store = { noteExternalAppend } as unknown as StreamBrowserStore;
  async function render(acknowledgedThroughOffset: number) {
    await act(async () =>
      root.render(
        <StreamViewComposer
          autoFocusMessage={false}
          disabled={false}
          interrupt={null}
          onNudgeDeliveries={() => {}}
          presence={[]}
          store={store}
          messageComposer={{ acknowledgedThroughOffset, onSubmit: async () => committed }}
        />,
      ),
    );
  }
  try {
    await render(9);
    await act(async () => view.props!.message!.onValueChange({ content: "Hello" }));
    await act(async () => {
      await view.props!.message!.onSubmit();
    });
    expect(noteExternalAppend).toHaveBeenCalledWith({
      maxCommittedOffset: 10,
      t0: expect.any(Number),
    });
    expect(host.textContent).toBe("pending");
    // Intermediate live updates (including an unresolved mention) cannot clear it.
    await render(9);
    expect(host.textContent).toBe("pending");
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(host.textContent).toBe("ready");
    expect(view.props!.error).toContain("Message saved");
    // The acknowledgement can describe no work; no busy transition is required.
    await render(10);
    expect(host.textContent).toBe("ready");
    expect(view.props!.error).toBeUndefined();
    // If the next acknowledgement arrives before the RPC result, there is no extra wait.
    await act(async () => view.props!.message!.onValueChange({ content: "Again" }));
    await act(async () => {
      await view.props!.message!.onSubmit();
    });
    expect(host.textContent).toBe("ready");
    // A later agent-ahead/feed-behind interval must not re-open an acknowledged send.
    await render(0);
    expect(host.textContent).toBe("ready");
    expect(view.props!.error).toBeUndefined();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(host.textContent).toBe("ready");
    expect(view.props!.error).toBeUndefined();
    // Retiring that send must not prematurely release a later submission.
    committed = { ...committed, offset: 20 };
    await act(async () => view.props!.message!.onValueChange({ content: "New message" }));
    await act(async () => {
      await view.props!.message!.onSubmit();
    });
    expect(host.textContent).toBe("pending");
    await render(20);
    expect(host.textContent).toBe("ready");
    await render(0);
    expect(host.textContent).toBe("ready");
    expect(view.props!.error).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
