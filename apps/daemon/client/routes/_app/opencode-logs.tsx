import { createFileRoute } from "@tanstack/react-router";

import { GhosttyTerminal } from "@/components/ghostty-terminal.tsx";
import { useEnsureTmuxSession } from "@/hooks/use-ensure-tmux-session.ts";

export const Route = createFileRoute("/_app/opencode-logs")({
  component: OpenCodeLogsPage,
});

function OpenCodeLogsPage() {
  useEnsureTmuxSession({
    sessionName: "opencode-logs",
    command: "tail -f /var/log/opencode/current",
  });

  return <GhosttyTerminal key="opencode-logs" tmuxSessionName="opencode-logs" />;
}
