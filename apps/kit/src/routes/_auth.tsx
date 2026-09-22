import { createFileRoute, Outlet } from "@tanstack/react-router";
import { createIterateClient } from "iterate/next/app";

// Minting the device's access token needs the account scope on top of project access.
const iterate = createIterateClient({ scopes: ["account"] });
export const Route = createFileRoute("/_auth")({
  ssr: false,
  beforeLoad: ({ location }) => iterate.authenticate(location.href),
  component: () => (
    <div className="mx-auto flex min-h-svh w-full max-w-5xl px-5 py-10 sm:px-8 sm:py-16">
      <main className="flex w-full items-start lg:items-center">
        <Outlet />
      </main>
    </div>
  ),
});
