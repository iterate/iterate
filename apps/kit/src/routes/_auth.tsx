import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { createIterateClient } from "iterate/next/app";

// Minting the device's access token needs the account scope on top of project access.
const iterate = createIterateClient({ scopes: ["account"] });
export const Route = createFileRoute("/_auth")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const response = await fetch("/device-session.json", { cache: "no-store" });
    const model = /^\/devices\/([^/]+)\//.exec(location.pathname)?.[1];
    if (response.status === 401) throw redirect({ to: "/", search: { device: model } });
    if (!response.ok) throw new Error("Could not check device sign-in. Please reload.");
    const deviceSession = z
      .object({ deviceId: z.string(), clientId: z.url() })
      .parse(await response.json());
    if (deviceSession.deviceId !== model) throw redirect({ to: "/", search: { device: model } });
    return { ...(await iterate.authenticate(location.href)), deviceSession };
  },
  component: () => (
    <div className="mx-auto flex min-h-svh w-full max-w-5xl px-5 py-10 sm:px-8 sm:py-16">
      <main className="flex w-full items-start lg:items-center">
        <Outlet />
      </main>
    </div>
  ),
});
