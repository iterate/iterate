import { useMemo } from "react";
import { WorkspaceDocumentEditor } from "@iterate-com/workspace-documents/editor";
import type { CollabEditorApi } from "@iterate-com/workspace-documents/editor-api";
import type { WorkspaceDocumentTransport } from "@iterate-com/workspace-documents/types";
import { withProject, withProjectOnce } from "../lib/use-checkout.ts";

export function WorkspaceTaskEditor({
  checkoutId,
  repoPath,
  displayName,
  path,
  redline,
  focusHeadline,
  onLiveContent,
  onStatus,
  onRequestClose,
  apiRef,
}: {
  checkoutId: string;
  repoPath: string;
  displayName?: string;
  path: string;
  redline: boolean;
  focusHeadline?: "select" | "end" | { caret: number };
  apiRef?: { current: CollabEditorApi | null };
  onLiveContent: (path: string, content: string) => void;
  onStatus?: (status: string) => void;
  onRequestClose?: () => void;
}) {
  const transport = useMemo<WorkspaceDocumentTransport>(
    () => ({
      run: (operation) =>
        withProject((project) => operation(project.workspace(checkoutId, repoPath))),
      runOnce: (operation) =>
        withProjectOnce((project) => operation(project.workspace(checkoutId, repoPath))),
    }),
    [checkoutId, repoPath],
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
