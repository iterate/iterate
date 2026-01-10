import { createFileRoute, Link } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";

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
      <p className="text-muted-foreground mb-6">Local agent orchestration</p>
      <Button asChild>
        <Link to="/agents">
          <BotIcon className="size-4 mr-2" />
          View Agents
        </Link>
      </Button>
    </div>
  );
}
