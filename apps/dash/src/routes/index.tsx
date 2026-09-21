import { createFileRoute } from "@tanstack/react-router";
import { LogInWithIterate } from "@iterate-com/ui/components/log-in-with-iterate";

/** The landing page, for a browser without a session (a signed-in one is sent to /home by the
 *  worker): the one recognisable button, centred. Everything else lives behind the sidebar. */
export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Sign in · Dash" }] }),
  component: () => (
    <main className="flex min-h-svh items-center justify-center p-6">
      <LogInWithIterate next="/home" scopes={["iterate", "account", "organizations:write"]} />
    </main>
  ),
});
