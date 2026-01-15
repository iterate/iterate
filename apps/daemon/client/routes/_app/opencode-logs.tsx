import { createFileRoute } from "@tanstack/react-router";

import { XtermTerminal } from "@/components/xterm-terminal.tsx";
import { useEnsureTmuxSession } from "@/hooks/use-ensure-tmux-session.ts";

export const Route = createFileRoute("/_app/opencode-logs")({
  component: OpenCodeLogsPage,
});

function OpenCodeLogsPage() {
  useEnsureTmuxSession({
    sessionName: "opencode-logs",
    command: "tail -f /var/log/opencode/current",
  });

  return <XtermTerminal key="opencode-logs" tmuxSessionName="opencode-logs" />;
}
