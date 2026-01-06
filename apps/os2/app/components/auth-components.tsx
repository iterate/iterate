import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { authClient, signIn } from "../lib/auth-client.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { InputOTP } from "./ui/input-otp.tsx";

type LoginStep = "email" | "otp";

export function LoginCard() {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [step, setStep] = useState<LoginStep>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    try {
      await signIn.social({
        provider: "google",
        callbackURL: "/",
      });
    } catch (err) {
      console.error("Google sign in failed:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleEmailSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    setIsLoading(true);
    setError(null);
    try {
      await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
      setStep("otp");
      toast.success("Code sent to your email");
    } catch (err) {
      console.error("Failed to send OTP:", err);
      setError("Failed to send verification code");
    } finally {
      setIsLoading(false);
    }
  };

  const handleOTPSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (otp.length !== 6) return;

    setIsLoading(true);
    setError(null);
    try {
      await signIn.emailOtp({ email, otp });
      toast.success("Signed in successfully");
      navigate({ to: "/" });
    } catch (err) {
      console.error("Failed to verify OTP:", err);
      setError("Invalid verification code");
      setOtp("");
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendOTP = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
      toast.success("New code sent");
    } catch (err) {
      console.error("Failed to resend OTP:", err);
      setError("Failed to resend code");
    } finally {
      setIsLoading(false);
    }
  };

  const handleBack = () => {
    setStep("email");
    setOtp("");
    setError(null);
  };

  if (step === "otp") {
    return (
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-semibold">Enter verification code</h1>
          <p className="text-sm text-muted-foreground">
            We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>
          </p>
        </div>
        <form onSubmit={handleOTPSubmit} className="space-y-4">
          <InputOTP value={otp} onChange={setOtp} disabled={isLoading} autoFocus />
          {error && <p className="text-sm text-destructive text-center">{error}</p>}
          <Button type="submit" className="w-full" disabled={isLoading || otp.length !== 6}>
            {isLoading ? "Verifying..." : "Verify"}
          </Button>
          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={handleBack}
              className="text-muted-foreground hover:text-foreground"
              disabled={isLoading}
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={handleResendOTP}
              className="text-muted-foreground hover:text-foreground"
              disabled={isLoading}
            >
              Resend code
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md space-y-6">
      <div className="text-center space-y-1">
        <h1 className="text-2xl font-semibold">Welcome to OS2</h1>
      </div>
      <form onSubmit={handleEmailSubmit} className="space-y-3">
        <Input
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={isLoading}
          required
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={isLoading || !email.trim()}>
          {isLoading ? "Sending code..." : "Continue with Email"}
        </Button>
      </form>

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">Or continue with</span>
        </div>
      </div>

      <Button
        variant="outline"
        className="w-full"
        onClick={handleGoogleSignIn}
        disabled={isLoading}
      >
        <svg className="h-4 w-4 mr-2" viewBox="0 0 24 24">
          <path
            fill="currentColor"
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
          />
          <path
            fill="currentColor"
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
          />
          <path
            fill="currentColor"
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
          />
          <path
            fill="currentColor"
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
          />
        </svg>
        Continue with Google
      </Button>
    </div>
  );
}
