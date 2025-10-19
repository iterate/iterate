import { useNavigate } from "react-router";
import { LoginProviders } from "./auth-components.tsx";

export function LoginPrompt() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-3xl font-semibold">
            Log in to{" "}
            <span
              className="px-1.5 py-0.5 rounded"
              style={{ backgroundColor: "#4A154B1A", color: "#4A154B" }}
            >
              @iterate
            </span>
          </h1>
        </div>

        <LoginProviders />

        <div className="text-center text-sm text-muted-foreground">
          Don't have an account?{" "}
          <button
            onClick={() => navigate("/signup")}
            className="underline underline-offset-4 hover:text-foreground"
          >
            Sign up
          </button>
        </div>
      </div>
    </div>
  );
}
