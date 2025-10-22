import { toast } from "sonner";
import { useSearchParams } from "react-router";
import { authClient } from "../lib/auth-client.ts";
import { parseCredentials, testAdminUser } from "../../backend/auth/test-admin.ts";
import { Button } from "./ui/button.tsx";

export function LoginProviders() {
  const [searchParams] = useSearchParams();
  const redirectUrl = searchParams.get("redirectUrl");

  const handleGoogleSignIn = async () => {
    try {
      console.log("🚀 Attempting Google sign-in...");

      await authClient.signIn.social({
        provider: "google",
        callbackURL: redirectUrl || "/", // Redirect to home after login
      });
    } catch (error) {
      console.error("❌ Google sign-in error:", error);
    }
  };

  const handleSlackSignIn = async () => {
    try {
      console.log("🚀 Attempting Slack sign-in...");
      const result = await authClient.integrations.directLoginWithSlack({
        query: {
          callbackURL: redirectUrl || "/",
        },
      });

      if (!result || !("url" in result)) {
        toast.error("Failed to sign in with Slack");
        return;
      }

      window.location.href = result.url.toString();
    } catch (error) {
      console.error("❌ Slack sign-in error:", error);
    }
  };

  const handleTestAdminUserSignIn = async () => {
    const credentials = prompt(
      "Enter email and password (colon separated)",
      testAdminUser.credentials || "",
    );
    if (!credentials) return;
    const { email, password } = parseCredentials(credentials);
    const result = await authClient.signIn.email({ email, password });
    window.location.href = result?.url ?? "/";
  };

  return (
    <div className="w-full space-y-4">
      <Button
        onClick={handleGoogleSignIn}
        variant="outline"
        size="lg"
        className="w-full h-14 text-base font-semibold shadow-sm hover:shadow-md transition-shadow"
      >
        <svg className="mr-3 h-6 w-6" viewBox="0 0 24 24" fill="currentColor">
          <path
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
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
        Continue with Google
      </Button>
      <Button
        onClick={handleSlackSignIn}
        variant="outline"
        size="lg"
        className="w-full h-14 text-base font-semibold shadow-sm hover:shadow-md transition-shadow"
      >
        <img src="/slack.svg" alt="Slack" className="mr-3 h-6 w-6" />
        Continue with Slack
      </Button>
      {import.meta.env.VITE_ENABLE_TEST_ADMIN_USER && (
        <Button
          onClick={handleTestAdminUserSignIn}
          variant="outline"
          size="lg"
          className="w-full h-14 text-base font-semibold shadow-sm hover:shadow-md transition-shadow"
        >
          Continue as test admin user
        </Button>
      )}
    </div>
  );
}
