/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { useCollabEditor } from "@iterate-com/workspace-documents/collab";
import type { CollabEditorApi } from "@iterate-com/workspace-documents/editor-api";
import type {
  CollabWaitResult,
  WorkspaceDocumentLane,
  WorkspaceDocumentTransport,
} from "@iterate-com/workspace-documents/types";
import { expect, test, vi } from "vitest";

test("a recovery snapshot updates the preview and cancels stale debounced text", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const delivery = Promise.withResolvers<CollabWaitResult>();
  const lane: WorkspaceDocumentLane = {
    open: async () => ({ content: "# Before", epoch: "first", version: 0 }),
    wait: vi
      .fn()
      .mockReturnValueOnce(delivery.promise)
      .mockImplementation(() => new Promise(() => {})),
    push: async () => ({ status: "history-miss" }),
    present: async () => {},
    changes: async () => ({
      baseContent: "# Before",
      baseVersion: 0,
      headVersion: 0,
      inserted: [],
      deleted: [],
    }),
  };
  const transport: WorkspaceDocumentTransport = {
    run: async (operation) => await operation(lane),
    runOnce: async (operation) => await operation(lane),
  };
  const apiRef: { current: CollabEditorApi | null } = { current: null };
  const onLiveContent = vi.fn();
  const extensions: Extension[] = [];
  function Editor() {
    const { host } = useCollabEditor({
      transport,
      path: "/notes.md",
      extensions,
      redline: false,
      apiRef,
      onLiveContent,
    });
    return <div ref={host} />;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Editor />));
    const view = EditorView.findFromDOM(host.querySelector(".cm-content")!)!;
    await act(async () => view.dispatch({ changes: { from: 8, insert: " typing" } }));
    await act(async () =>
      delivery.resolve({
        status: "snapshot",
        snapshot: { content: "# After", epoch: "second", version: 7, ackedSeq: -1 },
      }),
    );
    expect(apiRef.current?.source()).toBe("# After");
    expect(onLiveContent).toHaveBeenLastCalledWith("/notes.md", "# After");
    await act(async () => vi.advanceTimersByTime(200));
    expect(onLiveContent).toHaveBeenLastCalledWith("/notes.md", "# After");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
