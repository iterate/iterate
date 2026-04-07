import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/secrets")({
  staticData: {
    breadcrumb: "Env vars",
  },
  component: SecretsLayout,
});

function SecretsLayout() {
  return <Outlet />;
}
