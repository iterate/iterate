import { createFileRoute } from "@tanstack/react-router";

import { GhosttyTerminal } from "@/components/ghostty-terminal.tsx";
import { useEnsureTmuxSession } from "@/hooks/use-ensure-tmux-session.ts";

export const Route = createFileRoute("/_app/btop")({
  component: BtopPage,
});

function BtopPage() {
  useEnsureTmuxSession({ sessionName: "btop", command: "btop --utf-force" });

  return <GhosttyTerminal key="btop" tmuxSessionName="btop" />;
}
