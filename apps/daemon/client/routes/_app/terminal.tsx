import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod/v4";

import { GhosttyTerminal } from "@/components/ghostty-terminal.tsx";

const Search = z.object({
  command: z.string().optional(),
});

export const Route = createFileRoute("/_app/terminal")({
  validateSearch: Search,
  component: TerminalPage,
});

function TerminalPage() {
  const { command } = Route.useSearch();

  // Use a stable key "default-shell" to ensure the component remounts when
  // navigating here from an agent page (which uses tmuxSessionName as key)
  // Include command in key so terminal remounts if command changes
  return <GhosttyTerminal key={`default-shell-${command ?? ""}`} initialCommand={command} />;
}
