import { createFileRoute } from "@tanstack/react-router";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
export const Route = createFileRoute("/")({
  component: () => (
    <main className="flex min-h-svh flex-col items-center justify-center gap-8 p-6">
      <IterateLogo className="size-14" />
      <a href="/.auth/login?next=/agents" className={buttonVariants({ size: "lg" })}>
        Log in with Iterate
      </a>
    </main>
  ),
});
