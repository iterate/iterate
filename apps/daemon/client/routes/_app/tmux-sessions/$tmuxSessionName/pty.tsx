import { createFileRoute } from "@tanstack/react-router";

import { GhosttyTerminal } from "@/components/ghostty-terminal.tsx";

export const Route = createFileRoute("/_app/tmux-sessions/$tmuxSessionName/pty")({
  component: TmuxSessionPtyPage,
});

function TmuxSessionPtyPage() {
  const { tmuxSessionName } = Route.useParams();

  return <GhosttyTerminal key={tmuxSessionName} tmuxSessionName={tmuxSessionName} />;
}
