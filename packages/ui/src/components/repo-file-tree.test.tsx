// @vitest-environment jsdom
/** @jsxImportSource react */
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { FileTree as TreeModel } from "@pierre/trees";
import { expect, test, vi } from "vitest";
import { RepoFileTree } from "./repo-file-tree.tsx";

const tree = vi.hoisted(() => ({ model: null as TreeModel | null }));
vi.mock("@pierre/trees/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pierre/trees/react")>()),
  // Keep Pierre's actual model and callbacks; only omit its virtualized DOM.
  FileTree: ({ model }: { model: TreeModel }) => {
    tree.model = model;
    return null;
  },
}));

test("new-file placeholders are not opened before they appear in the host's file list", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onSelect = vi.fn();
  const actions = { createFile: vi.fn(), remove: vi.fn(), rename: vi.fn(), discard: vi.fn() };
  const render = (headPaths: string[]) =>
    root.render(
      <RepoFileTree
        headPaths={headPaths}
        changes={new Map()}
        selectedPath="notes.md"
        onSelect={onSelect}
        actions={actions}
        untitledExtension="md"
      />,
    );
  try {
    await act(async () => render(["notes.md"]));
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="New file"]')!.click(),
    );
    expect(tree.model!.getItem("untitled.md")).toBeDefined();
    expect(onSelect).not.toHaveBeenCalled();
    expect(actions.createFile).not.toHaveBeenCalled();
    await act(async () => tree.model!.move("untitled.md", "draft.md"));
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => render(["notes.md", "draft.md"]));
    await act(async () => tree.model!.getItem("draft.md")!.deselect());
    await act(async () => tree.model!.getItem("draft.md")!.select());
    expect(onSelect).toHaveBeenLastCalledWith("draft.md");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
