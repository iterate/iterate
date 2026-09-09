/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { useCollabEditor } from "@iterate-com/workspace-documents/collab";
import type { CollabEditorApi } from "@iterate-com/workspace-documents/editor-api";
import type {
  CollabWaitResult,
  WorkspaceCollabSurface,
  WorkspaceTransport,
  WorkspaceSurface,
} from "@iterate-com/workspace-documents/types";
import { expect, test, vi } from "vitest";

/** The four collab methods the editor drives, as the only member of a fake workspace. */
type FakeDocumentSession = Pick<WorkspaceCollabSurface, "open" | "present" | "push" | "wait">;

/** A transport over one fake session: the editor never touches fs or git
 * here, so a workspace holding only `collab` is the whole surface these
 * tests exercise — the assertion widens that partial fake to the full type. */
function transportFor(documentSession: FakeDocumentSession): WorkspaceTransport {
  const workspace = { collab: documentSession } as unknown as WorkspaceSurface;
  return {
    run: async (operation) => await operation(workspace),
    runOnce: async (operation) => await operation(workspace),
  };
}

test("a recovery snapshot updates the preview and cancels stale debounced text", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const delivery = Promise.withResolvers<CollabWaitResult>();
  const documentSession: FakeDocumentSession = {
    open: async () => ({ content: "# Before", epoch: "first", version: 0 }),
    wait: vi
      .fn()
      .mockReturnValueOnce(delivery.promise)
      .mockImplementation(() => new Promise(() => {})),
    push: async () => ({ status: "history-miss" }),
    present: async () => {},
  };
  const transport = transportFor(documentSession);
  const apiRef: { current: CollabEditorApi | null } = { current: null };
  const onLiveContent = vi.fn();
  const extensions: Extension[] = [];
  function Editor() {
    const { host } = useCollabEditor({
      transport,
      path: "/notes.md",
      extensions,
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

test("presentation changes preserve the live session and selection; an ended session refuses edits", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const delivery = Promise.withResolvers<CollabWaitResult>();
  const documentSession: FakeDocumentSession = {
    open: vi.fn(async () => ({ content: "# Shared", epoch: "first", version: 0 })),
    wait: () => delivery.promise,
    push: async () => ({ status: "accepted", version: 1 }),
    present: async () => {},
  };
  const transport = transportFor(documentSession);
  const apiRef: { current: CollabEditorApi | null } = { current: null };
  const extensions: Extension = [];
  const rich = EditorView.editorAttributes.of({ class: "rich-presentation" });
  const source: Extension = [];
  function Editor({ presentation }: { presentation: Extension }) {
    const { host } = useCollabEditor({
      transport,
      path: "/notes.md",
      extensions,
      presentation,
      apiRef,
    });
    return <div ref={host} />;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Editor presentation={rich} />));
    const view = EditorView.findFromDOM(host.querySelector(".cm-content")!)!;
    await act(async () =>
      view.dispatch({
        changes: { from: 8, insert: " edit" },
        selection: { anchor: 12 },
        userEvent: "input.type",
      }),
    );
    const selection = view.state.selection;
    await act(async () => root.render(<Editor presentation={source} />));
    expect(EditorView.findFromDOM(host.querySelector(".cm-content")!)).toBe(view);
    expect(documentSession.open).toHaveBeenCalledTimes(1);
    expect(view.state.selection).toBe(selection);
    expect(view.state.doc.toString()).toBe("# Shared edit");
    await act(async () => delivery.resolve({ status: "ended" }));
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
    expect(apiRef.current?.isLive()).toBe(false);
    expect(() => apiRef.current?.applyTransform((text) => text + " lost")).toThrow("Reconnect");
    expect(view.state.doc.toString()).toBe("# Shared edit");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
