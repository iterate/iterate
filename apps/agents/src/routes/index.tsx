import { createFileRoute } from "@tanstack/react-router";
import { LogInWithIterate } from "@iterate-com/ui/components/log-in-with-iterate";
export const Route = createFileRoute("/")({
  component: () => (
    <main className="flex min-h-svh items-center justify-center p-6">
      <LogInWithIterate next="/agents" />
    </main>
  ),
});
