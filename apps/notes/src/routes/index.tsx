import { createFileRoute } from "@tanstack/react-router";
import { LogInWithIterate } from "@iterate-com/ui/components/log-in-with-iterate";

/** The landing page, for a browser without a session (a signed-in one is sent to /notes by the
 *  worker): the one recognisable button, centred. */
export const Route = createFileRoute("/")({
  component: () => (
    <main className="flex min-h-svh items-center justify-center p-6">
      <LogInWithIterate next="/notes" />
    </main>
  ),
});
