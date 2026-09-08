/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { collab } from "@codemirror/collab";
import type { Extension } from "@codemirror/state";
import {
  CollabConnection,
  redlineExtension,
  useCollabEditor,
} from "@iterate-com/workspace-documents/collab";
import type { CollabEditorApi } from "@iterate-com/workspace-documents/editor-api";
import type {
  CollabWaitResult,
  CollabChanges,
  WorkspaceDocumentLane,
  WorkspaceDocumentTransport,
} from "@iterate-com/workspace-documents/types";
import { expect, test, vi } from "vitest";

test.for(["loaded", "failed"])("redlines expose their loading and %s state", async (outcome) => {
  const response = Promise.withResolvers<CollabChanges>();
  const connection = new CollabConnection({ run: vi.fn(), runOnce: vi.fn() }, "/notes.md");
  vi.spyOn(connection, "changes").mockReturnValue(response.promise);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    parent: host,
    doc: "Reviewed in Docs.",
    extensions: [collab({ startVersion: 1 }), redlineExtension(connection)],
  });
  try {
    expect(host.querySelector('[data-spinner="true"]')?.textContent).toBe("Loading changes…");
    if (outcome === "loaded") {
      response.resolve({
        baseContent: "",
        baseVersion: 0,
        headVersion: 1,
        deleted: [],
        inserted: [{ from: 0, to: 17, clientId: "reviewer" }],
      });
    } else {
      response.reject(new Error("Attribution unavailable"));
    }
    await response.promise.catch(() => {});
    await Promise.resolve();
    expect(host.querySelector('[data-spinner="true"]')).toBeNull();
    if (outcome === "loaded") {
      expect(host.querySelector(".cm-redline-ins")?.textContent).toBe("Reviewed in Docs.");
      expect(host.querySelector<HTMLElement>('[role="status"]')?.hidden).toBe(true);
    } else {
      expect(host.querySelector('[role="status"]')?.textContent).toBe(
        "Could not load changes: Attribution unavailable",
      );
    }
  } finally {
    view.destroy();
    host.remove();
    vi.restoreAllMocks();
  }
});

test("a recovery snapshot updates the preview and cancels stale debounced text", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const delivery = Promise.withResolvers<CollabWaitResult>();
  const documentSession: WorkspaceDocumentLane = {
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
    run: async (operation) => await operation(documentSession),
    runOnce: async (operation) => await operation(documentSession),
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
