import { createFileRoute } from "@tanstack/react-router";

import { XtermTerminal } from "@/components/xterm-terminal.tsx";

export const Route = createFileRoute("/_app/tmux-sessions/$tmuxSessionName/pty")({
  component: TmuxSessionPtyPage,
});

function TmuxSessionPtyPage() {
  const { tmuxSessionName } = Route.useParams();

  return <XtermTerminal key={tmuxSessionName} tmuxSessionName={tmuxSessionName} />;
}
