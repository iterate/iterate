import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [loading, setLoading] = useState(false);

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

  const handleSendOtp = async () => {
    if (!email) return;
    setLoading(true);
    await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
    setOtpSent(true);
    setLoading(false);
  };

  const handleVerifyOtp = async () => {
    if (!email || !otp) return;
    setLoading(true);
    const result = await authClient.signIn.emailOtp({ email, otp });
    if (result) {
      navigate({ to: "/" });
    }
    setLoading(false);
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
              <Button onClick={handleGoogleLogin} className="w-full" variant="outline">
                Continue with Google
              </Button>
              <Button onClick={handleSlackLogin} className="w-full" variant="outline">
                Continue with Slack
              </Button>
              <Button onClick={() => setShowEmailForm(true)} className="w-full" variant="outline">
                Continue with Email
              </Button>
            </>
          ) : !otpSent ? (
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
              <Button onClick={handleSendOtp} className="w-full" disabled={loading || !email}>
                {loading ? "Sending..." : "Send OTP"}
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
              <Button onClick={handleVerifyOtp} className="w-full" disabled={loading || !otp}>
                {loading ? "Verifying..." : "Verify OTP"}
              </Button>
              <Button
                onClick={() => {
                  setOtpSent(false);
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
