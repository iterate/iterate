import { ButtonGroup } from "@iterate-com/ui/components/button-group";
import { WorkspaceChanges } from "@iterate-com/workspace-documents/workspace-changes";
import type { useWorkspaceFiles } from "@iterate-com/workspace-documents/workspace-files";
import { isGuestWorkspacePath } from "../lib/board-shared.ts";
import { isJamWorkspacePath } from "../lib/jam.ts";
import { InviteAgentButton } from "./invite-agent-button.tsx";

/**
 * The header's workspace actions: the shared per-mount Commit controls, and
 * Invite AI on a jam. Publishing is the workspace OWNER's act: on someone
 * else's workspace — an agent's, mid-thought — the whole commit surface is
 * withheld, discard-all and the auto-commit timers included.
 */
export function WorkspaceActions({
  files,
  workspacePath,
  selectedPath,
  onDiscarded,
}: {
  files: ReturnType<typeof useWorkspaceFiles>;
  workspacePath: string;
  selectedPath: string | undefined;
  /** Every change under one mount was reverted (null: the own directory). */
  onDiscarded: (scope: string | null) => void;
}) {
  const guest = isGuestWorkspacePath(workspacePath);
  const jam = isJamWorkspacePath(workspacePath);
  return (
    <ButtonGroup aria-label="Workspace actions">
      <WorkspaceChanges files={files} canCommit={!guest} onDiscarded={onDiscarded} />
      {jam ? (
        <InviteAgentButton key={workspacePath} workspacePath={workspacePath} path={selectedPath} />
      ) : null}
    </ButtonGroup>
  );
}
