/// <reference types="vite/client" />
import type { ReactNode } from "react";
import { Outlet, createRootRoute, HeadContent, Scripts, Link } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient();

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "TanStack Start in a Durable Facet" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <QueryClientProvider client={queryClient}>
      <RootDocument>
        <Outlet />
      </RootDocument>
    </QueryClientProvider>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <style
          dangerouslySetInnerHTML={{
            __html: `
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; }
          nav { padding: 1rem; border-bottom: 1px solid #222; display: flex; gap: 1rem; align-items: center; }
          nav a { color: #60a5fa; text-decoration: none; }
          nav a:hover { text-decoration: underline; }
          nav a[data-status="active"] { color: #f59e0b; font-weight: bold; }
          main { padding: 2rem; max-width: 600px; margin: 0 auto; }
          h1 { font-size: 1.5rem; margin-bottom: 1rem; }
          p { line-height: 1.6; color: #aaa; margin-bottom: 1rem; }
          .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; background: #166534; color: #4ade80; }
          button { background: #1a1a1a; color: #e0e0e0; border: 1px solid #333; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; }
          button:hover { border-color: #555; }
          .counter { font-size: 3rem; font-weight: bold; color: #f59e0b; font-family: monospace; text-align: center; margin: 1rem 0; }
          input[type="text"] { background: #1a1a1a; color: #e0e0e0; border: 1px solid #333; padding: 0.5rem 0.75rem; border-radius: 6px; font-size: 0.9rem; outline: none; }
          input[type="text"]:focus { border-color: #60a5fa; }
          .thing-item { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 1rem; background: #1a1a1a; border: 1px solid #333; border-radius: 8px; }
          .thing-item:hover { border-color: #444; }
          .btn-danger { background: #7f1d1d; border-color: #991b1b; color: #fca5a5; }
          .btn-danger:hover { background: #991b1b; border-color: #b91c1c; }
          .btn-primary { background: #1e3a5f; border-color: #2563eb; color: #93c5fd; }
          .btn-primary:hover { background: #1e40af; border-color: #3b82f6; }
          .error-box { background: #450a0a; border: 1px solid #7f1d1d; border-radius: 8px; padding: 0.75rem 1rem; color: #fca5a5; font-size: 0.85rem; }
          .empty-state { text-align: center; padding: 2rem; color: #555; font-style: italic; }
        `,
          }}
        />
      </head>
      <body>
        <nav>
          <span style={{ fontWeight: "bold", color: "#fff" }}>Facet App</span>
          <Link to="/">Home</Link>
          <Link to="/about">About</Link>
          <Link to="/counter">Counter</Link>
          <Link to="/server-fns">Server Fns</Link>
          <Link to="/things">Things</Link>
          <span className="badge">DO Facet</span>
        </nav>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
