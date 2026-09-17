import { createFileRoute } from "@tanstack/react-router";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
export const Route = createFileRoute("/")({
  component: () => (
    <main className="flex min-h-svh items-center justify-center p-6">
      <a
        href="/.auth/login?next=/agents"
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
