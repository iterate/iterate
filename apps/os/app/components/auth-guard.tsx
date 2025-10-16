import { useEffect, type PropsWithChildren } from "react";
import { useNavigate, useLocation } from "react-router";
import { authClient } from "../lib/auth-client.ts";
import { GlobalLoading } from "./global-loading.tsx";

// Routes that don't require authentication
const PUBLIC_ROUTES = ["/login", "/get-started", "/no-access"];

export function AuthGuard({ children }: PropsWithChildren) {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: session, isPending } = authClient.useSession();

  const isPublicRoute = PUBLIC_ROUTES.includes(location.pathname);

  useEffect(() => {
    // Don't redirect if we're still loading the session
    if (isPending) {
      return;
    }

    // Don't redirect if we're on a public route
    if (isPublicRoute) {
      return;
    }

    // If no session and not on a public route, redirect to login
    if (!session) {
      navigate("/login", { replace: true });
      return;
    }
  }, [session, isPending, navigate, isPublicRoute]);

  // Show loading spinner while checking session
  if (isPending) {
    return <GlobalLoading />;
  }

  // If on a public route, always show children
  if (isPublicRoute) {
    return <>{children}</>;
  }

  // If no session and not on a public route, don't render anything
  // (we're redirecting to login)
  if (!session) {
    return null;
  }

  // User is authenticated, show the protected content
  return <>{children}</>;
}
