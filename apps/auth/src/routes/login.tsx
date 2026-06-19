import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod/v4";
import { Avatar, AvatarFallback, AvatarImage } from "@iterate-com/ui/components/avatar";
import { Button } from "@iterate-com/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Input } from "@iterate-com/ui/components/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@iterate-com/ui/components/input-otp";
import { Label } from "@iterate-com/ui/components/label";
import { Separator } from "@iterate-com/ui/components/separator";
import { toast } from "sonner";
import { authClient } from "../utils/auth-client.ts";
import { getInitials } from "../utils/initials.ts";

const getLoginState = createServerFn({ method: "GET" }).handler(({ context }) => ({
  emailOtpEnabled: context.cloudflare.env.VITE_ENABLE_EMAIL_OTP_SIGNIN === "true",
  session: context.variables.session,
}));

export const Route = createFileRoute("/login")({
  validateSearch: z.looseObject({
    redirect: z.string().optional(),
    login_hint: z.enum(["email", "google"]).optional().catch(undefined),
    sig: z.string().optional(),
  }),
  beforeLoad: async ({ search }) => {
    const session = await authClient.getSession().catch(() => null);
    if (session && !isOAuthProviderFlowSearch(search)) {
      throw redirect({ to: safeRedirectPath(search.redirect) });
    }
  },
  loader: () => getLoginState(),
  component: RouteComponent,
});

function RouteComponent() {
  const search = Route.useSearch();
  const redirectTo = safeRedirectPath(search.redirect);
  const { emailOtpEnabled, session } = Route.useLoaderData();
  const signedInSession = session && isOAuthProviderFlowSearch(search) ? session : null;
  const loginHint =
    !signedInSession && search.login_hint === "email" && emailOtpEnabled
      ? search.login_hint
      : !signedInSession && search.login_hint === "google"
        ? search.login_hint
        : undefined;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">
            {signedInSession ? "Continue as this account" : "Sign in"}
          </CardTitle>
          <CardDescription>
            {signedInSession
              ? "You're already signed in. Continue with this account or switch before authorizing the app."
              : "Sign in to your Iterate account"}
          </CardDescription>
        </CardHeader>
        <Separator />
        <CardContent className="pt-6">
          {signedInSession ? (
            <SignedInAccountCard redirectTo={redirectTo} session={signedInSession} />
          ) : (
            <LoginActions
              redirectTo={redirectTo}
              emailOtpEnabled={emailOtpEnabled}
              loginHint={loginHint}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SignedInAccountCard({
  redirectTo,
  session,
}: {
  redirectTo: string;
  session: {
    user: {
      name: string | null;
      email: string;
      image?: string | null;
    };
  };
}) {
  const user = session.user;
  const initials = getInitials(user.name ?? user.email);
  const continueWithAccount = useMutation({
    mutationFn: () => getPostLoginRedirectUrl(redirectTo),
    onSuccess: (nextUrl) => {
      window.location.assign(nextUrl);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to continue");
    },
  });
  const switchAccount = useMutation({
    mutationFn: () => authClient.signOut(),
    onSuccess: () => {
      window.location.assign(window.location.pathname + window.location.search);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to switch account");
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-xl border bg-muted/30 p-4">
        <Avatar>
          {user.image && <AvatarImage src={user.image} alt={user.name ?? user.email} />}
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{user.name ?? "User"}</p>
          <p className="truncate text-xs text-muted-foreground">{user.email}</p>
        </div>
      </div>

      <div className="space-y-2">
        <Button
          className="w-full"
          size="lg"
          disabled={continueWithAccount.isPending || switchAccount.isPending}
          onClick={() => continueWithAccount.mutate()}
        >
          {continueWithAccount.isPending ? "Continuing..." : "Continue with this account"}
        </Button>
        <Button
          className="w-full"
          variant="outline"
          disabled={continueWithAccount.isPending || switchAccount.isPending}
          onClick={() => switchAccount.mutate()}
        >
          {switchAccount.isPending ? "Switching..." : "Use another account"}
        </Button>
      </div>
    </div>
  );
}

function LoginActions({
  redirectTo,
  emailOtpEnabled,
  loginHint,
}: {
  redirectTo: string;
  emailOtpEnabled: boolean;
  loginHint?: "email" | "google";
}) {
  const [emailMode, setEmailMode] = useState(loginHint === "email" && emailOtpEnabled);
  const [isHydrated, setIsHydrated] = useState(false);
  const consumedGoogleHint = useRef(false);
  const { isPending: googleSignInPending, mutate: signInWithGoogle } = useMutation({
    mutationFn: async () =>
      authClient.signIn.social({
        provider: "google",
        callbackURL: await getPostLoginRedirectUrl(redirectTo),
      }),
  });

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (
      isHydrated &&
      loginHint === "google" &&
      !consumedGoogleHint.current &&
      !googleSignInPending
    ) {
      consumedGoogleHint.current = true;
      signInWithGoogle();
    }
  }, [googleSignInPending, isHydrated, loginHint, signInWithGoogle]);

  return (
    <div className="space-y-4" data-hydrated={isHydrated}>
      {emailOtpEnabled ? (
        <EmailOtpSignIn
          redirectTo={redirectTo}
          isExpanded={emailMode}
          isHydrated={isHydrated}
          onExpandedChange={setEmailMode}
        />
      ) : null}

      {!emailMode ? (
        <>
          {emailOtpEnabled ? (
            <div className="relative">
              <Separator />
              <span className="bg-card text-muted-foreground absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 px-2 text-xs uppercase tracking-[0.2em]">
                Or
              </span>
            </div>
          ) : null}
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

function EmailOtpSignIn({
  redirectTo,
  isExpanded,
  isHydrated,
  onExpandedChange,
}: {
  redirectTo: string;
  isExpanded: boolean;
  isHydrated: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const [email, setEmail] = useState("");
  const [submittedEmail, setSubmittedEmail] = useState("");
  const [otp, setOtp] = useState("");

  const sendOtp = useMutation({
    mutationFn: (address: string) =>
      authClient.emailOtp.sendVerificationOtp({
        email: address,
        type: "sign-in",
      }),
    onSuccess: (_, address) => {
      setSubmittedEmail(address);
      setOtp("");
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
        <Button
          className="w-full border-border bg-background text-foreground shadow-sm transition-colors hover:bg-muted"
          variant="outline"
          size="lg"
          data-testid="email-login-button"
          onClick={() => onExpandedChange(true)}
        >
          Continue with email
        </Button>
      ) : (
        <div className="space-y-4 rounded-xl border bg-muted/30 p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">Continue with email</p>
            <p className="text-xs text-muted-foreground">
              We&apos;ll send a one-time code to your email.
            </p>
          </div>

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
              onClick={() => sendOtp.mutate(normalizedEmail)}
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

async function getPostLoginRedirectUrl(fallbackRedirect: string) {
  if (!isOAuthProviderFlow()) {
    return safeRedirectPath(fallbackRedirect);
  }

  const redirectUrl = new URL("/api/auth/oauth2/authorize", window.location.origin);
  const searchParams = new URLSearchParams(window.location.search);
  searchParams.delete("exp");
  searchParams.delete("sig");
  redirectUrl.search = searchParams.toString();
  return redirectUrl.toString();
}

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

function isOAuthProviderFlow() {
  const searchParams = new URLSearchParams(window.location.search);
  return searchParams.has("sig");
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
