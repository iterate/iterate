import { useEffect } from "react";
import { useNavigate, useLocation } from "react-router";
import { authClient } from "../lib/auth-client.ts";

interface AuthGuardProps {
  children: React.ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    // Don't redirect if we're still loading the session
    if (isPending) {
      return;
    }

    // Don't redirect if we're already on the login page
    if (location.pathname === "/login") {
      return;
    }

    // If no session and not on login page, redirect to login
    if (!session) {
      navigate("/login", { replace: true });
      return;
    }
  }, [session, isPending, navigate, location.pathname]);

  // Show loading spinner while checking session
  if (isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
      </div>
    );
  }

  // If on login page, always show children (login form)
  if (location.pathname === "/login") {
    return <>{children}</>;
  }

  // If no session and not on login page, don't render anything
  // (we're redirecting to login)
  if (!session) {
    return null;
  }

  // User is authenticated, show the protected content
  return <>{children}</>;
}
