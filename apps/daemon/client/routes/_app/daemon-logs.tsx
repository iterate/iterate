import { createFileRoute } from "@tanstack/react-router";

import { GhosttyTerminal } from "@/components/ghostty-terminal.tsx";
import { useEnsureTmuxSession } from "@/hooks/use-ensure-tmux-session.ts";

export const Route = createFileRoute("/_app/daemon-logs")({
  component: DaemonLogsPage,
});

function DaemonLogsPage() {
  useEnsureTmuxSession({
    sessionName: "daemon-logs",
    command: "tail -f /var/log/iterate-daemon/current",
  });

  return <GhosttyTerminal key="daemon-logs" tmuxSessionName="daemon-logs" />;
}
