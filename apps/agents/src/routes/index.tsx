import { createFileRoute } from "@tanstack/react-router";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
export const Route = createFileRoute("/")({
  component: () => (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 p-4 text-center md:p-8">
      <IterateLogo className="size-14" />
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Talk to your project's agents.</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Every agent is a conversation on its own path. This page is a window onto it: the chat,
          the code it ran, and the trace of every request.
        </p>
      </div>
      <a href="/.auth/login?next=/agents&scope=iterate%20account" className={buttonVariants()}>
        Log in with Iterate
      </a>
    </main>
  ),
});
