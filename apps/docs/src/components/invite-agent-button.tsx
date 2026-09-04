import { useState } from "react";
import { BotIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
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
      .then((result) => setState({ kind: "invited", agentPath: result.agentPath }))
      .catch((cause: unknown) =>
        setState({
          kind: "failed",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      );
  };
  return (
    <div className="shrink-0 border-t p-2 text-xs">
      {state.kind === "invited" ? (
        <p className="text-muted-foreground">
          AI joined as <code className="font-mono">{state.agentPath}</code>
        </p>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={state.kind === "inviting"}
          onClick={invite}
        >
          <BotIcon aria-hidden className="size-3.5" />
          {state.kind === "inviting" ? "Inviting…" : "Invite AI"}
        </Button>
      )}
      {state.kind === "failed" ? <p className="pt-1 text-red-700">{state.message}</p> : null}
    </div>
  );
}
