import { createFileRoute } from "@tanstack/react-router";

import { GhosttyTerminal } from "@/components/ghostty-terminal.tsx";

export const Route = createFileRoute("/_app/terminal")({
  component: TerminalPage,
});

function TerminalPage() {
  // Use a stable key "default-shell" to ensure the component remounts when
  // navigating here from an agent page (which uses tmuxSessionName as key)
  return <GhosttyTerminal key="default-shell" />;
}
