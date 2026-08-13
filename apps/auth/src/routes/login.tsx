import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod/v4";
import { Button } from "@iterate-com/ui/components/button";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import { Input } from "@iterate-com/ui/components/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@iterate-com/ui/components/input-otp";
import { Label } from "@iterate-com/ui/components/label";
import { Separator } from "@iterate-com/ui/components/separator";
import { toast } from "@iterate-com/ui/components/sonner";
import { AuthRedirectError } from "../components/auth-redirect-error.tsx";
import { parseConfig } from "../config.ts";
import { getLoginRedirectSearch } from "../utils/auth-redirect-error.ts";
// Pure, unit-tested hint semantics (utils/login-hint.test.ts): Continue-as
// shortcut, OTP guess for test addresses, mode hints.
import { deriveLoginHintPresentation } from "../utils/login-hint.ts";
import { authClient } from "../utils/auth-client.ts";
import { AccountChooser } from "./-login-account-chooser.tsx";

// Runs on the server for both SSR and client navigations; the session comes
// from the request cookie (utils/hono.ts). Only display fields are returned —
// never the raw better-auth session (its `token` would end up in the
// dehydrated loader payload in the HTML).
const getLoginState = createServerFn({ method: "GET" }).handler(({ context }) => {
  const user = context.variables.session?.user;
  const config = parseConfig(context.cloudflare.env);
  return {
    emailOtpEnabled: config.emailOtpEnabled,
    // Not a secret (anyone can discover it empirically): lets the page
    // auto-drive the fixed test OTP for a `*+test@nustom.com` login_hint
    // instead of making automation type 424242 by hand.
    fixedTestOtpEnabled: config.fixedTestOtpEnabled,
    user: user
      ? { id: user.id, name: user.name ?? null, email: user.email, image: user.image ?? null }
      : null,
  };
});

// The login page serves two flows, distinguished by the `sig` search param
// (better-auth's oauth-provider signs its login redirects):
//  - plain sign-in to the auth app itself (`redirect` = in-app return path);
//  - the OAuth provider flow, where after sign-in we re-enter
//    /api/auth/oauth2/authorize with the original query so the authorization
//    request continues (consent, project access, redirect back to the client).
export const Route = createFileRoute("/login")({
  validateSearch: z.looseObject({
    redirect: z.string().optional(),
    // `login_hint=email` doubles as the deep-linkable "email code" mode of
    // this page; `login_hint=google` auto-starts the Google flow once. An
    // email ADDRESS (the standard OIDC meaning, forwarded by the
    // oauth-provider's signed login redirect) offers a "Continue as <email>"
    // shortcut and prefills the email form — for `*+test@nustom.com` on
    // deployments with the fixed test OTP, the code field prefills too
    // (mobile preview deep links). Never signs in by itself.
    login_hint: z
      .union([z.enum(["email", "google"]), z.string().email()])
      .optional()
      .catch(undefined),
    account_chooser_method: z.literal("email").optional().catch(undefined),
    sig: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  }),
  beforeLoad: async ({ search }) => {
    const normalizedRedirect = search.redirect
      ? getLoginRedirectSearch(search.redirect)
      : undefined;
    if (normalizedRedirect?.error && !isOAuthProviderFlowSearch(search)) {
      throw redirect({
        to: "/login",
        replace: true,
        search: {
          ...search,
          ...normalizedRedirect,
          error: search.error || normalizedRedirect.error,
          error_description: search.error_description || normalizedRedirect.error_description,
        },
      });
    }

    const loginState = await getLoginState();
    // Already signed in and not inside an OAuth authorization flow: nothing
    // to do here, go where the caller wanted. (In the OAuth flow we stay and
    // render "continue as this account" instead.)
    if (loginState.user && !isOAuthProviderFlowSearch(search)) {
      if (search.error) {
        throw redirect({
          to: "/",
          search: {
            error: search.error,
            error_description: search.error_description,
          },
        });
      }
      // `href`, not `to`: the target is a runtime-arbitrary same-origin path
      // (already sanitized by safeRedirectPath), while `to` is typed against
      // the route tree. A path-only href stays a client-side navigation:
      // https://tanstack.com/router/latest/docs/framework/react/api/router/redirectFunction
      throw redirect({ href: safeRedirectPath(search.redirect) });
    }
    return { loginState };
  },
  loader: ({ context }) => context.loginState,
  component: RouteComponent,
});

function RouteComponent() {
  const search = Route.useSearch();
  const redirectTo = safeRedirectPath(search.redirect);
  const { emailOtpEnabled, fixedTestOtpEnabled, user } = Route.useLoaderData();
  const signedInUser = user && isOAuthProviderFlowSearch(search) ? user : null;
  // Hint semantics (Continue-as shortcut, OTP guess, mode hints) live in the
  // pure, unit-tested helper — the route only renders what it derives.
  const {
    hintedEmail,
    otpGuess,
    mode: loginHint,
  } = deriveLoginHintPresentation({
    loginHint: search.login_hint,
    emailOtpEnabled,
    fixedTestOtpEnabled,
    signedIn: !!signedInUser,
  });

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <main className={signedInUser ? "w-full max-w-md" : "w-full max-w-xs"}>
        <div className="mb-8 flex items-center gap-4">
          <IterateLogo className="size-12 shadow-sm" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">
              {signedInUser ? "Choose an account" : "Sign in"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {signedInUser
                ? "Continue with an iterate account or use another sign-in method."
                : "Sign in to your iterate account"}
            </p>
          </div>
        </div>
        {search.error ? (
          <div className="mb-4">
            <AuthRedirectError error={search.error} errorDescription={search.error_description} />
          </div>
        ) : null}
        {signedInUser ? (
          <AccountChooser
            currentUser={signedInUser}
            continueWithAccount={() => window.location.assign(getPostLoginRedirectUrl(redirectTo))}
            refreshCurrentPage={() => {
              window.location.assign(window.location.pathname + window.location.search);
            }}
          >
            <LoginActions
              redirectTo={redirectTo}
              emailOtpEnabled={emailOtpEnabled}
              loginHint={search.account_chooser_method}
              hintedEmail={undefined}
              otpGuess={undefined}
              emailModeSearchKey="account_chooser_method"
              methodDivider="before"
            />
          </AccountChooser>
        ) : (
          <LoginActions
            redirectTo={redirectTo}
            emailOtpEnabled={emailOtpEnabled}
            loginHint={loginHint}
            hintedEmail={hintedEmail}
            otpGuess={otpGuess}
            emailModeSearchKey="login_hint"
            methodDivider="between"
          />
        )}
      </main>
    </div>
  );
}

function LoginActions({
  redirectTo,
  emailOtpEnabled,
  loginHint,
  hintedEmail,
  otpGuess,
  emailModeSearchKey,
  methodDivider,
}: {
  redirectTo: string;
  emailOtpEnabled: boolean;
  loginHint?: "email" | "google";
  /** Email address from a `login_hint`: offered as a "Continue as" shortcut
   * and prefilled into the email form. */
  hintedEmail: string | undefined;
  /** Known-in-advance OTP for the hinted email (fixed test OTP deployments
   * only): prefills the code field after "Continue as" sends it. */
  otpGuess: string | undefined;
  emailModeSearchKey: "login_hint" | "account_chooser_method";
  methodDivider: "before" | "between";
}) {
  const navigate = Route.useNavigate();
  // The email step is part of the URL (login_hint=email) so a refresh or a
  // shared link lands back in the same mode; only the typed email/code stay
  // in component state.
  const emailMode = loginHint === "email" && emailOtpEnabled;
  const [isHydrated, setIsHydrated] = useState(false);
  const consumedGoogleHint = useRef(false);
  const { isPending: googleSignInPending, mutate: signInWithGoogle } = useMutation({
    mutationFn: async () => {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: getPostLoginRedirectUrl(redirectTo),
      });
      // The auth client's auto-redirect plugin is disabled (see
      // utils/auth-client.ts), so drive the provider redirect explicitly.
      if (!result?.url) {
        throw new Error("Google sign-in did not return a redirect URL");
      }
      window.location.assign(result.url);
      return result;
    },
  });

  // Captured on first render: expanding rewrites `login_hint` to "email", so
  // an address hint would otherwise be unrecoverable when the user presses
  // Back. Restoring it on collapse keeps the "Continue as <email>" shortcut
  // alive across an expand/Back round trip.
  const initialHintedEmail = useRef(hintedEmail).current;

  const setEmailMode = (expanded: boolean) => {
    return navigate({
      search: (previous) =>
        emailModeSearchKey === "account_chooser_method"
          ? { ...previous, account_chooser_method: expanded ? "email" : undefined }
          : { ...previous, login_hint: expanded ? "email" : initialHintedEmail },
      replace: true,
    });
  };

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    // login_hint=google auto-starts the Google redirect exactly once per URL:
    // sessionStorage survives the round-trip back to this page (e.g. the user
    // pressed Back on Google's screen), the ref guards same-mount re-renders.
    let googleHintAlreadyConsumed = false;
    try {
      googleHintAlreadyConsumed =
        sessionStorage.getItem("iterate-auth-google-login-hint") === window.location.href;
    } catch {
      googleHintAlreadyConsumed = false;
    }

    if (
      isHydrated &&
      loginHint === "google" &&
      !consumedGoogleHint.current &&
      !googleHintAlreadyConsumed &&
      !googleSignInPending
    ) {
      consumedGoogleHint.current = true;
      try {
        sessionStorage.setItem("iterate-auth-google-login-hint", window.location.href);
      } catch {
        // Ignore storage failures; the in-memory ref still prevents same-mount retries.
      }
      signInWithGoogle();
    }
  }, [googleSignInPending, isHydrated, loginHint, signInWithGoogle]);

  return (
    <div className="space-y-4" data-hydrated={isHydrated}>
      {methodDivider === "before" ? <LoginMethodDivider /> : null}

      {emailOtpEnabled ? (
        <EmailOtpSignIn
          redirectTo={redirectTo}
          isExpanded={emailMode}
          isHydrated={isHydrated}
          onExpandedChange={setEmailMode}
          hintedEmail={hintedEmail}
          otpGuess={otpGuess}
        />
      ) : null}

      {!emailMode ? (
        <>
          {emailOtpEnabled && methodDivider === "between" ? <LoginMethodDivider /> : null}
          <Button
            className="w-full"
            variant="outline"
            size="lg"
            disabled={googleSignInPending || !isHydrated}
            data-testid="google-login-button"
            onClick={() => signInWithGoogle()}
          >
            <GoogleIcon />
            {googleSignInPending ? "Redirecting..." : "Continue with Google"}
          </Button>
        </>
      ) : null}
    </div>
  );
}

function LoginMethodDivider() {
  return (
    <div className="flex items-center gap-3">
      <Separator className="flex-1" />
      <span className="text-xs tracking-[0.2em] text-muted-foreground uppercase">or</span>
      <Separator className="flex-1" />
    </div>
  );
}

function EmailOtpSignIn({
  redirectTo,
  isExpanded,
  isHydrated,
  onExpandedChange,
  hintedEmail,
  otpGuess,
}: {
  redirectTo: string;
  isExpanded: boolean;
  isHydrated: boolean;
  onExpandedChange: (expanded: boolean) => void;
  hintedEmail: string | undefined;
  otpGuess: string | undefined;
}) {
  const [email, setEmail] = useState(hintedEmail || "");
  const [submittedEmail, setSubmittedEmail] = useState("");
  const [otp, setOtp] = useState("");

  const sendOtp = useMutation({
    // `prefillOtp` is the known-in-advance code for the hinted test address
    // ("Continue as" lane): the code field prefills once the send succeeds,
    // and the user presses the verify button — the normal OTP screen, one
    // typing step saved. Manual sends prefill nothing.
    mutationFn: async ({ address }: { address: string; prefillOtp?: string }) =>
      authClient.emailOtp.sendVerificationOtp({
        email: address,
        type: "sign-in",
      }),
    onSuccess: (_, { address, prefillOtp }) => {
      setSubmittedEmail(address);
      setOtp(prefillOtp || "");
      toast.success(`Verification code sent to ${address}`);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to send verification code");
    },
  });

  const signInWithOtp = useMutation({
    mutationFn: async ({ address, code }: { address: string; code: string }) => {
      await authClient.signIn.emailOtp({
        email: address,
        otp: code,
      });

      return getPostLoginRedirectUrl(redirectTo);
    },
    onSuccess: (nextUrl) => {
      window.location.assign(nextUrl);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to sign in with email");
    },
  });

  const normalizedEmail = email.trim().toLowerCase();
  const canSendOtp = normalizedEmail.length > 0;
  const canSignIn = otp.length === 6 && submittedEmail.length > 0;
  const showExpandedForm = isExpanded || submittedEmail.length > 0;

  return (
    <div className="space-y-3">
      {!showExpandedForm && !isHydrated ? (
        <Button
          className="w-full border-border bg-background text-foreground shadow-sm transition-colors"
          variant="outline"
          size="lg"
          data-spinner="true"
          disabled
        >
          Loading...
        </Button>
      ) : !showExpandedForm ? (
        <>
          {hintedEmail ? (
            // The deep link's suggested identity, one press: sends the code
            // and opens the normal OTP screen (prefilled when the code is
            // knowable — fixed-test-OTP deployments). Sits above the generic
            // methods; those stay for signing in as anyone else.
            <Button
              className="w-full bg-foreground text-background hover:bg-foreground/90"
              size="lg"
              data-testid="continue-as-hinted-email-button"
              disabled={sendOtp.isPending}
              onClick={() => sendOtp.mutate({ address: hintedEmail, prefillOtp: otpGuess })}
            >
              {sendOtp.isPending ? "Sending code..." : `Continue as ${hintedEmail}`}
            </Button>
          ) : null}
          <Button
            className="w-full border-border bg-background text-foreground shadow-sm transition-colors hover:bg-muted"
            variant="outline"
            size="lg"
            data-testid="email-login-button"
            onClick={() => onExpandedChange(true)}
          >
            Continue with email
          </Button>
        </>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            We&apos;ll send a one-time code to your email.
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              data-testid="email-input"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setEmail(event.target.value)}
              disabled={sendOtp.isPending || signInWithOtp.isPending}
            />
          </div>

          {submittedEmail ? (
            <div className="space-y-1.5">
              <Label htmlFor="email-otp">Verification code</Label>
              <div className="space-y-2">
                <InputOTP
                  id="email-otp"
                  data-testid="email-otp-input"
                  maxLength={6}
                  value={otp}
                  onChange={setOtp}
                  disabled={signInWithOtp.isPending}
                  containerClassName="justify-center"
                >
                  <InputOTPGroup>
                    <InputOTPSlot index={0} />
                    <InputOTPSlot index={1} />
                    <InputOTPSlot index={2} />
                    <InputOTPSlot index={3} />
                    <InputOTPSlot index={4} />
                    <InputOTPSlot index={5} />
                  </InputOTPGroup>
                </InputOTP>
                <p className="text-center text-xs text-muted-foreground">
                  Enter the 6-digit code sent to {submittedEmail}
                </p>
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            {submittedEmail ? (
              <Button
                className="w-full bg-foreground text-background hover:bg-foreground/90"
                data-testid="email-verify-button"
                disabled={signInWithOtp.isPending || !canSignIn}
                onClick={() => signInWithOtp.mutate({ address: submittedEmail, code: otp })}
              >
                {signInWithOtp.isPending ? "Signing in..." : "Continue with email"}
              </Button>
            ) : null}

            <Button
              className="w-full bg-foreground text-background hover:bg-foreground/90"
              data-testid="email-submit-button"
              disabled={sendOtp.isPending || signInWithOtp.isPending || !canSendOtp}
              onClick={() => sendOtp.mutate({ address: normalizedEmail })}
            >
              {sendOtp.isPending
                ? "Sending code..."
                : submittedEmail
                  ? "Resend code"
                  : "Send verification code"}
            </Button>

            {!submittedEmail ? (
              <Button
                className="w-full"
                variant="ghost"
                disabled={sendOtp.isPending || signInWithOtp.isPending}
                onClick={() => onExpandedChange(false)}
              >
                Back
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

// In the OAuth provider flow (marked by the `sig` param), the post-login
// destination is the authorization endpoint with the ORIGINAL query
// re-attached (minus the one-time exp/sig signature params) so better-auth
// resumes the interrupted authorize request — verbatim off window.location so
// the query survives without a round-trip through the router's parsed search.
function getPostLoginRedirectUrl(fallbackRedirect: string) {
  const searchParams = new URLSearchParams(window.location.search);
  if (!searchParams.has("sig")) {
    return safeRedirectPath(fallbackRedirect);
  }

  const redirectUrl = new URL("/api/auth/oauth2/authorize", window.location.origin);
  searchParams.delete("exp");
  searchParams.delete("sig");
  searchParams.delete("account_chooser_method");
  searchParams.delete("error");
  searchParams.delete("error_description");
  const remainingPrompts = searchParams
    .get("prompt")
    ?.split(" ")
    .filter((prompt) => prompt && prompt !== "select_account");
  if (remainingPrompts?.length) {
    searchParams.set("prompt", remainingPrompts.join(" "));
  } else {
    searchParams.delete("prompt");
  }
  redirectUrl.search = searchParams.toString();
  return redirectUrl.toString();
}

// Open-redirect guard: `redirect` must stay a same-origin absolute path.
function safeRedirectPath(rawRedirect: string | null | undefined) {
  const fallback = "/";
  const trimmed = rawRedirect?.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return fallback;
  }

  try {
    const parsed = new URL(trimmed, "https://iterate-auth.local");
    if (parsed.origin !== "https://iterate-auth.local") return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

function isOAuthProviderFlowSearch(search: { sig?: string }) {
  return Boolean(search.sig);
}

function GoogleIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}
