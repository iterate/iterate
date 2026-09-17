// console/main.tsx — THE CONSOLE'S ENTRY (dist/client/console.js, scripts/build.ts): the platform
// host's React pages in one bundle, mounted into the shell control-plane.ts serves for every console
// path. No router — the path picks the page. Every page behind sign-in reads the `/api` capnweb
// session opened ONCE here: `createIterateClient` (iterate/next/app) probes /api and, on a 401, sends
// the browser through /.auth/login → /login and back to this very URL. `/demo` dials /api itself.
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createIterateClient, type AuthenticatedApp } from "iterate/next/app";
import { AccountPage } from "./account.tsx";
import { AuthorizePage } from "./authorize.tsx";
import { DashboardPage } from "./dashboard.tsx";
import { Demo } from "./demo.tsx";
import { SessionsPage } from "./sessions.tsx";

/** The pages behind sign-in, by path — the set control-plane.ts serves the shell for, minus /demo. */
const PAGES: Record<string, (app: AuthenticatedApp) => ReactNode> = {
  "/": (app) => <DashboardPage app={app} />,
  "/authorize": (app) => <AuthorizePage app={app} />,
  "/sessions": (app) => <SessionsPage app={app} />,
  "/account": (app) => <AccountPage app={app} />,
};

const root = createRoot(document.getElementById("root")!);
const page = PAGES[window.location.pathname];
if (window.location.pathname === "/demo") root.render(<Demo />);
else if (!page)
  root.render(
    <main>
      <p>Not found</p>
    </main>,
  );
else
  createIterateClient({ scopes: ["iterate", "account"] })
    .authenticate(window.location.pathname + window.location.search)
    .then(
      (app) => root.render(page(app)),
      (error: unknown) =>
        root.render(
          <main>
            <h1>Iterate is unavailable</h1>
            <p role="alert">{error instanceof Error ? error.message : String(error)}</p>
          </main>,
        ),
    );
