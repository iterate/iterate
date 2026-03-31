import { Fragment } from "react";
import { Link, Outlet, createFileRoute, useMatchRoute, useMatches } from "@tanstack/react-router";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-md items-center justify-between gap-4 p-4">
          <Link to="/routes/" className="font-medium tracking-tight">
            ingress-proxy
          </Link>
          <nav className="flex items-center gap-3 text-sm text-muted-foreground">
            <NavLink to="/routes/">Routes</NavLink>
            <a href="/api/docs" className="hover:text-foreground">
              API
            </a>
          </nav>
        </div>
        <div className="mx-auto max-w-md px-4 pb-3 text-sm text-muted-foreground">
          <Breadcrumbs />
        </div>
      </header>

      <main className="mx-auto flex max-w-md flex-col p-4 pt-6">
        <Outlet />
      </main>
    </div>
  );
}

function NavLink(props: { to: "/routes/"; children: string }) {
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

function Breadcrumbs() {
  const matches = useMatches();
  const crumbs = matches.flatMap((match) => {
    const staticBreadcrumb = (match.staticData as { breadcrumb?: string } | undefined)?.breadcrumb;
    const dynamicBreadcrumb = (match.loaderData as { breadcrumb?: string } | undefined)?.breadcrumb;
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
