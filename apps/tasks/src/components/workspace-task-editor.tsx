import { useMemo } from "react";
import { WorkspaceDocumentEditor } from "@iterate-com/workspace-documents/editor";
import type { CollabEditorApi } from "@iterate-com/workspace-documents/editor-api";
import type { WorkspaceDocumentTransport } from "@iterate-com/workspace-documents/types";
import { withProject, withProjectOnce, workspaceFor } from "../lib/project-rpc.ts";
import type { BoardAddress } from "../lib/checkout-shared.ts";

export function WorkspaceTaskEditor({
  address,
  displayName,
  path,
  redline,
  focusHeadline,
  onLiveContent,
  onStatus,
  onRequestClose,
  apiRef,
}: {
  address: BoardAddress;
  displayName?: string;
  path: string;
  redline: boolean;
  focusHeadline?: "select" | "end" | { caret: number };
  apiRef?: { current: CollabEditorApi | null };
  onLiveContent: (path: string, content: string) => void;
  onStatus?: (status: string) => void;
  onRequestClose?: () => void;
}) {
  const { checkoutId, workspacePath, repoPath } = address;
  const transport = useMemo<WorkspaceDocumentTransport>(
    () => ({
      run: (operation) =>
        withProject((project) =>
          operation(workspaceFor(project, { checkoutId, workspacePath, repoPath })),
        ),
      runOnce: (operation) =>
        withProjectOnce((project) =>
          operation(workspaceFor(project, { checkoutId, workspacePath, repoPath })),
        ),
    }),
    [checkoutId, workspacePath, repoPath],
  );

  return (
    <WorkspaceDocumentEditor
      transport={transport}
      displayName={displayName}
      path={path}
      workspacePath={`${repoPath}/${path}`}
      redline={redline}
      emptyPlaceholder="Write the task as Markdown…"
      focusHeadline={focusHeadline}
      apiRef={apiRef}
      onLiveContent={onLiveContent}
      onStatus={onStatus}
      onRequestClose={onRequestClose}
    />
  );
}
