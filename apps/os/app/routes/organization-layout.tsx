import { Outlet, redirect, isRouteErrorResponse, useRouteError, useParams, Link } from "react-router";
import { getDb } from "../../backend/db/client.ts";
import { getAuth } from "../../backend/auth/auth.ts";
import { DashboardLayout } from "../components/dashboard-layout.tsx";
import type { Route } from "./+types/organization-layout";

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

  return null;
}

export default function OrganizationLayout() {
  return (
    <DashboardLayout>
      <Outlet />
    </DashboardLayout>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error)) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold">{error.status} {error.statusText}</h1>
        <p className="text-muted-foreground mt-2">{error.data as string}</p>
        <div className="mt-4">
          <Link to="/" className="underline">Go home</Link>
        </div>
      </div>
    );
  }
  return <pre className="p-6">{String(error)}</pre>;
}

