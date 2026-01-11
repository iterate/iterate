import { createFileRoute } from "@tanstack/react-router";
import { TerminalIcon } from "lucide-react";

export const Route = createFileRoute("/_app/")({
  component: HomePage,
});

function HomePage() {
  return (
    <div className="flex flex-col items-center justify-center h-full p-6 text-center">
      <div className="flex aspect-square size-16 items-center justify-center rounded-xl bg-black mb-4">
        <img src="/logo.svg" alt="iterate" className="size-10" />
      </div>
      <h1 className="text-2xl font-semibold mb-2">iterate daemon</h1>
      <p className="text-muted-foreground mb-6">Tmux session manager</p>
      <div className="flex items-center gap-2 text-muted-foreground">
        <TerminalIcon className="size-4" />
        <span>Select a tmux session from the sidebar</span>
      </div>
    </div>
  );
}
