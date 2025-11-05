import { Outlet, redirect } from "react-router";
import { ReactRouterServerContext } from "../context.ts";
import type { Route } from "./+types/auth-required.layout.ts";

export default function AuthRequiredLayout() {
  return <Outlet />;
}

export const middleware: Route.MiddlewareFunction[] = [
  ({ request, context }) => {
    const url = new URL(request.url);
    const session = context.get(ReactRouterServerContext).variables.session;
    if (!session)
      throw redirect(`/login?redirectUrl=${encodeURIComponent(url.pathname + url.search)}`);
  },
];
