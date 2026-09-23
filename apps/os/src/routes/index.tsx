import { createFileRoute, Link } from "@tanstack/react-router";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import { IssuerPage } from "../components/issuer-page.tsx";
import { getLandingState } from "../issuer.functions.ts";
import { loginSearchOf } from "../login-search.ts";

export const Route = createFileRoute("/")({
  loader: () => getLandingState(),
  head: () => ({ meta: [{ title: "iterate platform" }] }),
  component: LandingPage,
});

function LandingPage() {
  const { issuer, dash } = Route.useLoaderData();
  return (
    <IssuerPage className="text-sm leading-relaxed">
      <IterateLogo alt="" className="size-12" />
      <h1 className="text-xl font-semibold">iterate platform</h1>
      <p>
        <strong>{new URL(issuer).host}</strong> is deliberately headless: the API (<code>/api</code>
        ), the OAuth issuer and the MCP server. Its only pages are{" "}
        <Link to="/login" search={loginSearchOf({})} className="underline underline-offset-4">
          sign-in
        </Link>{" "}
        and consent.
      </p>
      {dash ? (
        <div className="flex flex-col items-start gap-3">
          <p>Your projects, organizations and sessions are in the dash.</p>
          <a
            className={buttonVariants({ size: "lg" })}
            href={`${dash}/.auth/connect?${new URLSearchParams({ issuer })}`}
          >
            {new URL(dash).host}
          </a>
        </div>
      ) : null}
      <p className="text-muted-foreground">
        Setting this up with an agent? Point it at{" "}
        <a href="/setup-prompt.md" className="underline underline-offset-4">
          /setup-prompt.md
        </a>
        .
      </p>
    </IssuerPage>
  );
}
