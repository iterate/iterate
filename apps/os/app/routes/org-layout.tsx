import { Outlet, redirect, isRouteErrorResponse, useRouteError, useParams, Link } from "react-router";
import { AlertCircle } from "lucide-react";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../backend/db/client.ts";
import { getAuth } from "../../backend/auth/auth.ts";
import { organizationUserMembership } from "../../backend/db/schema.ts";
import { DashboardLayout } from "../components/dashboard-layout.tsx";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { Button } from "../components/ui/button.tsx";
import type { Route } from "./+types/org-layout";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { organizationId } = params;

  const db = getDb();
  const auth = getAuth(db);

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    throw redirect(`/login?redirectUrl=${encodeURIComponent(request.url)}`);
  }

  if (!organizationId) {
    throw redirect("/");
  }

  const membership = await db.query.organizationUserMembership.findFirst({
    where: and(
      eq(organizationUserMembership.userId, session.user.id),
      eq(organizationUserMembership.organizationId, organizationId),
    ),
  });

  if (!membership) {
    throw new Response("You don't have access to this organization", {
      status: 403,
      statusText: "Forbidden",
    });
  }

  return null;
}

export default function OrgLayout() {
  return (
    <DashboardLayout>
      <Outlet />
    </DashboardLayout>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const params = useParams();

  let title: string;
  let message: string;

  if (isRouteErrorResponse(error)) {
    title = error.statusText;
    message = (error.data as string) || "An unexpected error occurred";
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
          <CardFooter className="flex flex-wrap justify-center gap-2">
            <Button asChild>
              <Link to="/">Go to Home</Link>
            </Button>
            {params.organizationId && (
              <Button asChild variant="outline">
                <Link to={`/${params.organizationId}`}>Back to Organization</Link>
              </Button>
            )}
          </CardFooter>
        </Card>
      </div>
    </DashboardLayout>
  );
}

