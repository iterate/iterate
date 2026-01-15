import { createFileRoute } from "@tanstack/react-router";

import { XtermTerminal } from "@/components/xterm-terminal.tsx";
import { useEnsureTmuxSession } from "@/hooks/use-ensure-tmux-session.ts";

export const Route = createFileRoute("/_app/daemon-logs")({
  component: DaemonLogsPage,
});

function DaemonLogsPage() {
  useEnsureTmuxSession({
    sessionName: "daemon-logs",
    command: "tail -f /var/log/iterate-daemon/current",
  });

  return <XtermTerminal key="daemon-logs" tmuxSessionName="daemon-logs" />;
}
