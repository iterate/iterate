import { createFileRoute } from "@tanstack/react-router";

import { XtermTerminal } from "@/components/xterm-terminal.tsx";

export const Route = createFileRoute("/_app/terminal")({
  component: TerminalPage,
});

function TerminalPage() {
  return <XtermTerminal key="default-shell" />;
}
