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
import { getDb, schema } from "../../../backend/db/client.ts";
import { getAuth } from "../../../backend/auth/auth.ts";
import { getUserOrganizations } from "../../../backend/trpc/trpc.ts";
import { type UserRole } from "../../../backend/db/schema.ts";
import { Button } from "../../components/ui/button.tsx";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../../components/ui/card.tsx";
import { authClient } from "../../lib/auth-client.ts";
import { useTRPCClient } from "../../lib/trpc.ts";
import { DashboardLayout } from "../../components/dashboard-layout.tsx";
import type { Route } from "./+types/loader.ts";

// Server-side loader that checks organization access
export async function loader({ request, params }: Route.LoaderArgs) {
  const { organizationId } = params;

  // No idea why params aren't correctly typed here...
  if (!organizationId) {
    throw new Error("Organization ID is required");
  }

  // Get the database and auth instances
  const db = getDb();
  const auth = getAuth(db);

  // Step 1: Check for session, redirect to login if no session
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user?.id) {
    throw redirect(`/login?redirectUrl=${encodeURIComponent(request.url)}`);
  }

  // Step 3: Load all organizations and check onboarding status in parallel
  // This is more efficient than separate queries since we need all orgs anyway
  const requestUrl = new URL(request.url);
  const onboardingPath = `/${organizationId}/onboarding`;
  const isOnboardingRoute = requestUrl.pathname.startsWith(onboardingPath);

  const [userOrganizations, isOnboarded] = await Promise.all([
    getUserOrganizations(db, session.user.id),
    isOnboardingRoute ? Promise.resolve(true) : isOrganizationOnboarded(db, organizationId),
  ]);

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
  const organizations = userOrganizations.map(({ organization: org, role }) => ({
    id: org.id,
    name: org.name,
    role: role as UserRole,
    stripeCustomerId: org.stripeCustomerId,
    createdAt: org.createdAt.toISOString(),
    updatedAt: org.updatedAt.toISOString(),
  }));

  const serializedOrganization = {
    id: organization.id,
    name: organization.name,
    stripeCustomerId: organization.stripeCustomerId,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
  };

  if (!isOnboardingRoute && !isOnboarded) {
    throw redirect(onboardingPath);
  }

  const responseHeaders = new Headers({ "Content-Type": "application/json" });

  return data(
    {
      organization: serializedOrganization,
      organizations,
    },
    {
      headers: responseHeaders,
    },
  );
}

export default function OrganizationLayout({ loaderData }: Route.ComponentProps) {
  return (
    <Outlet
      context={{
        organization: loaderData.organization,
        organizations: loaderData.organizations,
      }}
    />
  );
}

// Error boundary to display access errors nicely
// Error boundary to display access errors nicely
export function ErrorBoundary() {
  const error = useRouteError();
  const params = useParams();
  const { data: session } = authClient.useSession();
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

  const isAdmin = session?.user?.role === "admin";

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

async function isOrganizationOnboarded(db: ReturnType<typeof getDb>, organizationId: string) {
  const organization = await db.query.organization.findFirst({
    where: eq(schema.organization.id, organizationId),
    with: {
      estates: {
        with: {
          estateAccountsPermissions: {
            with: {
              account: true,
            },
          },
        },
      },
    },
  });

  // For now, assume that if the organization has a slack bot linked
  // TODO: This is a temporary hack, figure out what counts as onboarded
  const hasSlackLinked = organization?.estates.some((estate) =>
    estate.estateAccountsPermissions.some(
      (permission) => permission.account.providerId === "slack-bot",
    ),
  );

  return hasSlackLinked;
}
