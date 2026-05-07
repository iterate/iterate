import { useEffect, useState, type ChangeEvent } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod/v4";
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

const emailOtpEnabled = import.meta.env.VITE_ENABLE_EMAIL_OTP_SIGNIN === "true";

export const Route = createFileRoute("/login")({
  component: RouteComponent,
  validateSearch: z.looseObject({
    redirect: z.string().optional(),
  }),
  beforeLoad: async ({ search }) => {
    const session = await authClient.getSession().catch(() => null);
    if (session) throw redirect({ to: search.redirect ?? "/" });
  },
});

function RouteComponent() {
  const { redirect } = Route.useSearch();

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Sign in</CardTitle>
          <CardDescription>Sign in to your Iterate account</CardDescription>
        </CardHeader>
        <Separator />
        <CardContent className="pt-6">
          <LoginActions redirectTo={redirect ?? "/"} />
        </CardContent>
      </Card>
    </div>
  );
}

function LoginActions({ redirectTo }: { redirectTo: string }) {
  const [emailMode, setEmailMode] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const googleSignIn = useMutation({
    mutationFn: () =>
      authClient.signIn.social({
        provider: "google",
        callbackURL: redirectTo,
      }),
  });

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  return (
    <div className="space-y-4">
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
            disabled={googleSignIn.isPending || !isHydrated}
            data-testid="google-login-button"
            onClick={() => googleSignIn.mutate()}
          >
            <GoogleIcon />
            {googleSignIn.isPending ? "Redirecting..." : "Continue with Google"}
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
      {!showExpandedForm ? (
        <Button
          className="w-full border-border bg-background text-foreground shadow-sm transition-colors hover:bg-muted"
          variant="outline"
          size="lg"
          data-testid="email-login-button"
          aria-disabled={!isHydrated}
          disabled={!isHydrated}
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
    return fallbackRedirect;
  }

  const result = await authClient.oauth2.continue({
    postLogin: true,
  });

  if (!result.url) {
    throw new Error("Signed in, but couldn't finish the OAuth redirect");
  }

  return result.url;
}

function isOAuthProviderFlow() {
  const searchParams = new URLSearchParams(window.location.search);
  return searchParams.has("sig");
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
