import { createFileRoute } from "@tanstack/react-router";
import { environmentFaviconHref, type DeploymentEnvironment } from "iterate/lib";
import { FieldSeparator } from "../components/ui/field.tsx";
import { IterateLogo } from "../components/iterate-logo.tsx";
import { ErrorMessage, StandaloneCard, StandalonePage } from "../components/standalone-page.tsx";
import { CodeSignInForm } from "../components/login/code-sign-in-form.tsx";
import { EmailSignInForm } from "../components/login/email-sign-in-form.tsx";
import { signInProvidersOf } from "../components/login/providers.ts";
import { RecommendedSignIn, SignInProviders } from "../components/login/sign-in-providers.tsx";
import { SignedIn } from "../components/login/signed-in.tsx";
import { getLoginState } from "../issuer.functions.ts";
import { issuerRequestContext } from "../issuer-request-context.server.ts";
import { loginSearchOf } from "../login-search.ts";
import { loginFormResponse } from "../login.server.ts";

export const Route = createFileRoute("/login")({
  validateSearch: loginSearchOf,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getLoginState({ data: deps }),
  head: ({ loaderData }) => ({
    meta: [
      { title: `Sign in to ${loaderData ? deploymentNameOf(loaderData.environment) : "iterate"}` },
    ],
  }),
  server: {
    handlers: {
      POST: ({ request }) => loginFormResponse(request, issuerRequestContext().env),
    },
  },
  component: LoginPage,
});

function LoginPage() {
  const state = Route.useLoaderData();
  const title = state.signedInAs
    ? "You’re signed in"
    : state.codeSentTo
      ? "Check your inbox"
      : `Sign in to ${deploymentNameOf(state.environment)}`;
  return (
    <StandalonePage className="max-w-100">
      <StandaloneCard>
        <header className="flex items-center gap-3">
          <DeploymentIcon environment={state.environment} />
          <div className="flex min-w-0 flex-col">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {state.environment.kind === "preview" ? (
              <p className="font-mono text-xs text-muted-foreground">
                {state.environment.deployment}
              </p>
            ) : null}
          </div>
        </header>
        {state.error ? <ErrorMessage>{state.error}</ErrorMessage> : null}
        {state.signedInAs ? (
          <SignedIn
            email={state.signedInAs}
            next={state.next}
            dash={state.dash}
            switchAccount={state.switchAccount}
          />
        ) : (
          <SignInOptions state={state} />
        )}
      </StandaloneCard>
    </StandalonePage>
  );
}

/** What the page calls this deployment: production is iterate; a preview and local dev say which,
 *  since someone signing in to a preview does it with their os.iterate.com account, and the page
 *  should not read as that. */
function deploymentNameOf(environment: DeploymentEnvironment) {
  if (environment.kind === "preview") return `PR ${environment.pr}’s preview`;
  if (environment.kind === "dev") return "local dev";
  return "iterate";
}

/** The deployment's mark: production's logo, else the same purple PR-number or teal dev square the
 *  tab shows (`/favicon.svg`, issuer-pages.ts). */
function DeploymentIcon({ environment }: { environment: DeploymentEnvironment }) {
  if (environment.kind === "production") return <IterateLogo alt="" className="size-8" />;
  return (
    <img
      src={environmentFaviconHref(environment, "/iterate-logo.svg")}
      alt=""
      width={32}
      height={32}
      className="size-8 shrink-0 rounded-lg"
    />
  );
}

/** Every sign-in this deployment offers: the email form (or, once a code is sent, its entry) and
 *  the OAuth providers — or, when the link suggested one of them (`provider_hint`), that one alone
 *  and the way back to the rest. */
function SignInOptions({ state }: { state: Awaited<ReturnType<typeof getLoginState>> }) {
  const providers = signInProvidersOf(state);
  const recommended = state.codeSentTo
    ? undefined
    : providers.find((provider) => provider.key === state.providerHint);
  if (recommended) return <RecommendedSignIn provider={recommended} everyWay={state.everyWay} />;
  const formEnabled = state.password || state.emailSignIn;
  const providersEnabled = providers.length > 0;
  if (!formEnabled && !providersEnabled)
    return <p className="text-sm">Sign-in is not configured for this deployment.</p>;
  return (
    <>
      {state.codeSentTo ? (
        <CodeSignInForm next={state.next} codeSentTo={state.codeSentTo} />
      ) : formEnabled ? (
        <EmailSignInForm
          next={state.next}
          email={state.email}
          passwordEnabled={state.password}
          codeEnabled={state.emailSignIn}
          passwordSelected={state.passwordSelected}
        />
      ) : null}
      {providersEnabled && (formEnabled || state.codeSentTo) ? (
        <FieldSeparator className="text-xs *:data-[slot=field-separator-content]:bg-card">
          or continue with
        </FieldSeparator>
      ) : null}
      {providersEnabled ? <SignInProviders providers={providers} /> : null}
    </>
  );
}
