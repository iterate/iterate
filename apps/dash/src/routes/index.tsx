import { createFileRoute } from "@tanstack/react-router";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";

/** The landing page, for a browser without a session (a signed-in one is sent to /home by the
 *  worker): the logo and the way in, nothing else — everything lives behind the sidebar. */
export const Route = createFileRoute("/")({
  component: () => (
    <main className="flex min-h-svh flex-col items-center justify-center gap-8 p-6">
      <IterateLogo className="size-14" />
      <a
        href="/.auth/login?next=/home&scope=iterate%20account%20organizations%3Awrite"
        className={buttonVariants({ size: "lg" })}
      >
        Log in with Iterate
      </a>
    </main>
  ),
});
