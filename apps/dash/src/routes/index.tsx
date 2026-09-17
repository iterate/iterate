import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import { APPS } from "../apps.ts";

export const Route = createFileRoute("/")({
  component: () => (
    <main className="mx-auto flex min-h-svh w-full max-w-2xl flex-col justify-center gap-10 px-6 py-12">
      <div className="flex flex-col items-start gap-5">
        <IterateLogo className="size-12" />
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-balance">
            Your projects, organizations and sessions.
          </h1>
          <p className="max-w-md text-sm text-muted-foreground">
            Sign in, see everything your Iterate account reaches, and manage it from one place.
          </p>
        </div>
        <a
          href="/.auth/login?next=/projects&scope=iterate%20account%20organizations%3Awrite"
          className={buttonVariants({ size: "lg" })}
        >
          Log in with Iterate
        </a>
      </div>
      <section className="flex flex-col gap-3" aria-label="Apps">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Apps</h2>
        <ul className="grid gap-2 sm:grid-cols-3">
          {APPS.map((app) => (
            <li key={app.url}>
              <a
                href={app.url}
                className="flex h-full flex-col gap-1 rounded-lg border bg-card p-4 text-sm transition-colors hover:bg-accent"
              >
                <span className="flex items-center gap-1 font-medium">
                  {app.name}
                  <ArrowUpRight className="size-3.5 text-muted-foreground" />
                </span>
                <span className="text-muted-foreground">{app.blurb}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </main>
  ),
});
