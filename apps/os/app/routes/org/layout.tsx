import {
  Outlet,
  redirect,
  data,
  isRouteErrorResponse,
  useRouteError,
  useParams,
} from "react-router";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle, Home } from "lucide-react";
import { eq } from "drizzle-orm";
import { schema } from "../../../backend/db/client.ts";
import { getUserOrganizations } from "../../../backend/trpc/trpc.ts";
import { Button } from "../../components/ui/button.tsx";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../../components/ui/card.tsx";
import { authClient } from "../../lib/auth-client.ts";
import { serializeIntoTrpcCompatible, useTRPCClient } from "../../lib/trpc.ts";
import { DashboardLayout } from "../../components/dashboard-layout.tsx";
import { ReactRouterServerContext } from "../../context.ts";
import { useSessionUser } from "../../hooks/use-session-user.ts";
import type { Route } from "./+types/layout.ts";

// Server-side loader that checks organization access
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { organizationId } = params;
  const { session, db } = context.get(ReactRouterServerContext).variables;

  if (!session?.user?.id) {
    throw redirect(`/login?redirectUrl=${encodeURIComponent(request.url)}`);
  }

  const firstEstate = await db.query.estate.findFirst({
    where: eq(schema.estate.organizationId, organizationId),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });

  if (!firstEstate) {
    // No estate for this org; redirect to home
    throw redirect("/");
  }

  const userOrganizations = await getUserOrganizations(db, session.user.id);

  // Check if user has access to the requested organization
  // Note: External users are already filtered out at query level
  const currentOrgMembership = userOrganizations.find((m) => m.organization.id === organizationId);

  if (!currentOrgMembership) {
    throw new Response("You don't have access to this organization", {
      status: 403,
      statusText: "Forbidden",
    });
  }

  const organization = currentOrgMembership.organization;

  // Serialize dates to match TRPC output format
  // External orgs already filtered at query level
  const organizations = userOrganizations.map(({ organization: org, role }) =>
    serializeIntoTrpcCompatible({
      ...org,
      role,
    }),
  );

  const serializedOrganization = serializeIntoTrpcCompatible(organization);

  return data({
    organization: serializedOrganization,
    organizations,
  });
}

export default function OrganizationLayout() {
  return (
    <DashboardLayout>
      <Outlet />
    </DashboardLayout>
  );
}

// Error boundary to display access errors nicely
export function ErrorBoundary() {
  const error = useRouteError();
  const params = useParams();
  const user = useSessionUser();
  const trpcClient = useTRPCClient();
  const estateId = params.estateId;

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

  const impersonateOwner = useMutation({
    mutationFn: async () => {
      if (!estateId) {
        throw new Error("Missing estate identifier");
      }

      const owner = await trpcClient.admin.getEstateOwner.query({ estateId });
      await authClient.admin.impersonateUser({ userId: owner.userId });

      return owner;
    },
    onSuccess: () => {
      window.location.href = "/";
    },
  });

  const isAdmin = user.role === "admin";

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
              <a href="/">
                <Home className="mr-2 h-4 w-4" />
                Go to Home
              </a>
            </Button>
            {isAdmin && estateId && (
              <Button
                variant="outline"
                onClick={() => impersonateOwner.mutate()}
                disabled={impersonateOwner.isPending}
              >
                {impersonateOwner.isPending ? "Impersonating..." : "Impersonate Estate Owner"}
              </Button>
            )}
          </CardFooter>
        </Card>
      </div>
    </DashboardLayout>
  );
}
