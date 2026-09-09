import { useState } from "react";
import { BotIcon, CheckIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { toast } from "@iterate-com/ui/components/sonner";
import { withDocsProject } from "../lib/docs-client.ts";

type InviteState =
  | { kind: "idle" }
  | { kind: "inviting" }
  | { kind: "invited"; agentPath: string }
  | { kind: "failed"; message: string };

/**
 * One button that puts an agent into the jam: the vessel births (or
 * re-briefs) the jam's agent and tells it the workspace and the open file.
 * From then on it edits through the same workspace the people do.
 */
export function InviteAgentButton({
  workspacePath,
  path,
}: {
  workspacePath: string;
  path: string | undefined;
}) {
  const [state, setState] = useState<InviteState>({ kind: "idle" });
  const invite = () => {
    setState({ kind: "inviting" });
    void withDocsProject((project) => project.inviteAgent(workspacePath, path))
      .then((result) => {
        setState({ kind: "invited", agentPath: result.agentPath });
        toast.success("AI joined", { description: result.agentPath });
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        setState({ kind: "failed", message });
        toast.error("Could not invite AI", { description: message });
      });
  };
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={state.kind === "inviting" || state.kind === "invited"}
      onClick={invite}
    >
      {state.kind === "invited" ? (
        <CheckIcon aria-hidden data-icon="inline-start" />
      ) : (
        <BotIcon aria-hidden data-icon="inline-start" />
      )}
      {state.kind === "invited"
        ? "AI joined"
        : state.kind === "inviting"
          ? "Inviting…"
          : "Invite AI"}
    </Button>
  );
}
