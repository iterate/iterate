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
      { title: "oRPC + TanStack Start on CF Workers" },
    ],
  }),
  component: () => (
    <QueryClientProvider client={queryClient}>
      <RootDocument>
        <Outlet />
      </RootDocument>
    </QueryClientProvider>
  ),
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <style
          dangerouslySetInnerHTML={{
            __html: `
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; }
          nav { padding: 0.75rem 1.5rem; border-bottom: 1px solid #222; display: flex; gap: 1rem; align-items: center; }
          nav a { color: #60a5fa; text-decoration: none; font-size: 0.9rem; }
          nav a:hover { text-decoration: underline; }
          nav a[data-status="active"] { color: #f59e0b; font-weight: bold; }
          main { padding: 2rem; max-width: 700px; margin: 0 auto; }
          h1 { font-size: 1.4rem; margin-bottom: 1rem; }
          p { line-height: 1.6; color: #aaa; margin-bottom: 1rem; }
          code { color: #f59e0b; font-size: 0.85em; }
          button { background: #1a1a1a; color: #e0e0e0; border: 1px solid #333; padding: 0.4rem 0.8rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
          button:hover { border-color: #555; }
          button:disabled { opacity: 0.5; cursor: default; }
          .btn-primary { background: #1e3a5f; border-color: #2563eb; color: #93c5fd; }
          .btn-danger { background: #7f1d1d; border-color: #991b1b; color: #fca5a5; }
          pre { background: #111; border: 1px solid #222; border-radius: 8px; padding: 1rem; font-size: 0.8rem; overflow: auto; color: #4ade80; line-height: 1.6; }
          input[type="text"], input[type="number"] { background: #1a1a1a; color: #e0e0e0; border: 1px solid #333; padding: 0.4rem 0.6rem; border-radius: 6px; font-size: 0.85rem; outline: none; }
          input:focus { border-color: #60a5fa; }
          .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; background: #166534; color: #4ade80; }
          .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 0.75rem 1rem; }
          .card:hover { border-color: #444; }
        `,
          }}
        />
      </head>
      <body>
        <nav>
          <strong style={{ color: "#fff", fontSize: "0.95rem" }}>Facet App</strong>
          <Link to="/">Home</Link>
          <Link to="/things">Things</Link>
          <Link to="/stream">Stream</Link>
          <Link to="/terminal">Terminal</Link>
          <a href="/api/docs" target="_blank" style={{ color: "#888" }}>
            API Docs
          </a>
          <span className="badge">DO Facet</span>
        </nav>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
