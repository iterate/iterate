import { createFileRoute, useNavigate, useHydrated } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { authClient } from "../lib/auth-client.ts";
import { Button } from "../components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";
import { Input } from "../components/ui/input.tsx";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const hydrated = useHydrated();
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");

  const sendOtpMutation = useMutation({
    mutationFn: (email: string) =>
      authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" }),
  });

  const verifyOtpMutation = useMutation({
    mutationFn: ({ email, otp }: { email: string; otp: string }) =>
      authClient.signIn.emailOtp({ email, otp }),
    onSuccess: () => {
      navigate({ to: "/" });
    },
  });

  const handleGoogleLogin = async () => {
    await authClient.signIn.social({
      provider: "google",
      callbackURL: "/",
    });
  };

  const handleSlackLogin = async () => {
    await authClient.signIn.social({
      provider: "slack",
      callbackURL: "/",
    });
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Welcome to OS2</CardTitle>
          <CardDescription>Sign in to continue</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!showEmailForm ? (
            <>
              <Button
                onClick={handleGoogleLogin}
                className="w-full"
                variant="outline"
                disabled={!hydrated}
              >
                Continue with Google
              </Button>
              <Button
                onClick={handleSlackLogin}
                className="w-full"
                variant="outline"
                disabled={!hydrated}
              >
                Continue with Slack
              </Button>
              <Button
                onClick={() => setShowEmailForm(true)}
                className="w-full"
                variant="outline"
                disabled={!hydrated}
              >
                Continue with Email
              </Button>
            </>
          ) : !sendOtpMutation.isSuccess ? (
            <>
              <div className="space-y-2">
                <label htmlFor="email" className="text-sm font-medium">
                  Email
                </label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              <Button
                onClick={() => sendOtpMutation.mutate(email)}
                className="w-full"
                disabled={sendOtpMutation.isPending || !email}
              >
                {sendOtpMutation.isPending ? "Sending..." : "Send OTP"}
              </Button>
              <Button onClick={() => setShowEmailForm(false)} className="w-full" variant="ghost">
                Back
              </Button>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <label htmlFor="otp" className="text-sm font-medium">
                  Enter OTP sent to {email}
                </label>
                <Input
                  id="otp"
                  type="text"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  placeholder="123456"
                />
              </div>
              <Button
                onClick={() => verifyOtpMutation.mutate({ email, otp })}
                className="w-full"
                disabled={verifyOtpMutation.isPending || !otp}
              >
                {verifyOtpMutation.isPending ? "Verifying..." : "Verify OTP"}
              </Button>
              <Button
                onClick={() => {
                  sendOtpMutation.reset();
                  setOtp("");
                }}
                className="w-full"
                variant="ghost"
              >
                Back
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
