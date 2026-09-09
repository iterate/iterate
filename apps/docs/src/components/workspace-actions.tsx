import { ButtonGroup } from "@iterate-com/ui/components/button-group";
import { isJamWorkspacePath } from "../lib/jam.ts";
import type { useWorkspaceCommit } from "../lib/use-workspace-commit.ts";
import { CommitControls } from "./commit-controls.tsx";
import { InviteAgentButton } from "./invite-agent-button.tsx";

/** Documents and jams share the Tasks commit dropdown and workspace actions. */
export function WorkspaceActions({
  commit,
  workspacePath,
  selectedPath,
  onDiscardAll,
}: {
  commit: ReturnType<typeof useWorkspaceCommit>;
  workspacePath: string;
  selectedPath: string | undefined;
  onDiscardAll: () => void;
}) {
  const jam = isJamWorkspacePath(workspacePath);
  if (!commit.canCommit && !jam) return null;
  return (
    <ButtonGroup aria-label="Workspace actions">
      {commit.canCommit ? <CommitControls {...commit} onDiscardAll={onDiscardAll} /> : null}
      {jam ? (
        <InviteAgentButton key={workspacePath} workspacePath={workspacePath} path={selectedPath} />
      ) : null}
    </ButtonGroup>
  );
}
