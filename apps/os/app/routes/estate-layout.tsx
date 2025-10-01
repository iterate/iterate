import { Outlet, redirect, isRouteErrorResponse, useRouteError } from "react-router";
import { AlertCircle, Home } from "lucide-react";
import { getDb } from "../../backend/db/client.ts";
import { getAuth } from "../../backend/auth/auth.ts";
import { getUserEstateAccess } from "../../backend/trpc/trpc.ts";
import { DashboardLayout } from "../components/dashboard-layout.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../components/ui/card.tsx";
import type { Route } from "./+types/estate-layout";

// Server-side loader that checks estate access
export async function loader({ request, params }: Route.LoaderArgs) {
  const { organizationId, estateId } = params;

  // Get the database and auth instances
  const db = getDb();
  const auth = getAuth(db);

  // Get session using Better Auth
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  // If no session, redirect to login
  if (!session?.user?.id) {
    throw redirect(`/login?redirectUrl=${encodeURIComponent(request.url)}`);
  }

  // Validate params exist
  if (!organizationId || !estateId) {
    throw redirect("/");
  }

  // Check if user has access to this estate
  const { hasAccess } = await getUserEstateAccess(db, session.user.id, estateId, organizationId);

  if (!hasAccess) {
    // Clear the invalid estate cookie by setting an expired cookie
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      "iterate-selected-estate=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );

    // Throw a 403 error instead of redirecting
    throw new Response("You don't have access to this estate", {
      status: 403,
      statusText: "Forbidden",
      headers,
    });
  }

  // User has access, set the estate cookie for future use
  const estateData = JSON.stringify({ organizationId, estateId });
  const encodedData = encodeURIComponent(estateData);
  const expires = new Date();
  expires.setDate(expires.getDate() + 30);

  return new Response(null, {
    headers: {
      "Set-Cookie": `iterate-selected-estate=${encodedData}; Path=/; Expires=${expires.toUTCString()}; SameSite=Lax`,
    },
  });
}

// The component just renders the outlet since access is already checked
export default function EstateLayout() {
  return (
    <DashboardLayout>
      <Outlet />
    </DashboardLayout>
  );
}

// Error boundary to display access errors nicely
export function ErrorBoundary() {
  const error = useRouteError();

  let title: string;
  let message: string;

  if (isRouteErrorResponse(error)) {
    title = error.statusText;
    message = error.data || "An unexpected error occurred";
  } else if (error instanceof Error) {
    title = "Error";
    message = error.message;
  } else {
    title = "Error";
    message = "Unknown error";
  }

  return (
    <DashboardLayout>
      <div className="flex items-center justify-center min-h-[calc(100vh-8rem)] p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <AlertCircle className="h-12 w-12 text-destructive" />
            </div>
            <CardTitle className="text-2xl">{title}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground text-center">{message}</p>
          </CardContent>
          <CardFooter className="flex justify-center">
            <Button asChild>
              <a href="/">
                <Home className="mr-2 h-4 w-4" />
                Go to Home
              </a>
            </Button>
          </CardFooter>
        </Card>
      </div>
    </DashboardLayout>
  );
}
