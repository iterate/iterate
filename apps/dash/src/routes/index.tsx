import { createFileRoute } from "@tanstack/react-router";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";

/** The landing page, for a browser without a session (a signed-in one is sent to /home by the
 *  worker): one button, centred — the way in. Everything else lives behind the sidebar. */
export const Route = createFileRoute("/")({
  component: () => (
    <main className="flex min-h-svh items-center justify-center p-6">
      <a
        href="/.auth/login?next=/home&scope=iterate%20account%20organizations%3Awrite"
        className={buttonVariants({
          variant: "outline",
          size: "lg",
          className: "h-12 gap-3 px-6 text-base",
        })}
      >
        <IterateLogo className="size-6" />
        Sign in
      </a>
    </main>
  ),
});
