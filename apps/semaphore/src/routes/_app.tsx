import { Fragment } from "react";
import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useMatchRoute,
  useMatches,
  type RegisteredRouter,
} from "@tanstack/react-router";
import { fetchAuthSnapshot } from "~/lib/auth-snapshot.ts";

export const Route = createFileRoute("/_app")({
  // The whole dashboard requires a signed-in iterate admin — the same
  // apps/auth identity the API lanes verify. Unauthenticated visitors go
  // through the relying-party login handler (served by the request
  // middleware, outside the route tree — hence redirect by href).
  beforeLoad: async ({ location }) => {
    const auth = await fetchAuthSnapshot();
    if (!auth.authenticated) {
      // The explicit "./" type parameter keeps `to` optional under this
      // router's trailingSlash: "always" typing — href alone is the intent.
      throw redirect<RegisteredRouter, "./">({
        href: `/api/iterate-auth/login?${new URLSearchParams({ return_to: location.href })}`,
      });
    }
    if (!auth.isAdmin) {
      throw new Error(
        `Signed in${auth.email ? ` as ${auth.email}` : ""}, but semaphore is operator tooling and requires an iterate admin. Sign out at /api/iterate-auth/logout.`,
      );
    }
    return { auth };
  },
  component: AppLayout,
});

function AppLayout() {
  const { auth } = Route.useRouteContext();

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 p-4">
          <Link to="/resources/" className="font-medium tracking-tight">
            semaphore
          </Link>
          <nav className="flex items-center gap-3 text-sm text-muted-foreground">
            <NavLink to="/resources/">Resources</NavLink>
            <a href="/api/docs" className="hover:text-foreground">
              API
            </a>
            <a
              href="/api/iterate-auth/logout"
              className="hover:text-foreground"
              title={auth.email ?? undefined}
            >
              Sign out
            </a>
          </nav>
        </div>
        <div className="mx-auto max-w-6xl px-4 pb-3 text-sm text-muted-foreground">
          <Breadcrumbs />
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col p-4 pt-6">
        <Outlet />
      </main>
    </div>
  );
}

function NavLink(props: { to: "/resources/"; children: string }) {
  const matchRoute = useMatchRoute();

  return (
    <Link
      to={props.to}
      className={
        matchRoute({ to: props.to, fuzzy: true }) ? "text-foreground" : "hover:text-foreground"
      }
    >
      {props.children}
    </Link>
  );
}

type BreadcrumbLoaderData = {
  breadcrumb?: string;
};

function Breadcrumbs() {
  const matches = useMatches();
  const crumbs = matches.flatMap((match) => {
    const staticBreadcrumb = (match.staticData as { breadcrumb?: string } | undefined)?.breadcrumb;
    const dynamicBreadcrumb = (match.loaderData as BreadcrumbLoaderData | undefined)?.breadcrumb;
    const label = dynamicBreadcrumb ?? staticBreadcrumb;

    if (!label) {
      return [];
    }

    return [
      {
        id: match.id,
        label,
        to: match.pathname,
      },
    ];
  });

  if (crumbs.length === 0) {
    return null;
  }

  return (
    <>
      {crumbs.map((crumb, index) => (
        <Fragment key={crumb.id}>
          {index > 0 ? <span className="px-2">/</span> : null}
          {index === crumbs.length - 1 ? (
            <span>{crumb.label}</span>
          ) : (
            <Link to={crumb.to} className="hover:text-foreground">
              {crumb.label}
            </Link>
          )}
        </Fragment>
      ))}
    </>
  );
}
