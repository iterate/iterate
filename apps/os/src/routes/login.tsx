import { createFileRoute } from "@tanstack/react-router";
import { FieldSeparator } from "@iterate-com/ui/components/field";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import {
  ErrorMessage,
  StandaloneCard,
  StandalonePage,
} from "@iterate-com/ui/components/standalone-page";
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
  head: () => ({ meta: [{ title: "Sign in to iterate" }] }),
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
      : "Sign in to iterate";
  return (
    <StandalonePage className="max-w-100">
      <StandaloneCard>
        <header className="flex items-center gap-3">
          <IterateLogo alt="" className="size-8" />
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
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
