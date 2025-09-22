import { useEffect, type PropsWithChildren } from "react";
import { useNavigate, useLocation } from "react-router";
import { authClient } from "../lib/auth-client.ts";
import { GlobalLoading } from "./global-loading.tsx";

export function AuthGuard({ children }: PropsWithChildren) {
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
    return <GlobalLoading />;
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
