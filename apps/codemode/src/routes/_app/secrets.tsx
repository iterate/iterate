import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/secrets")({
  staticData: {
    breadcrumb: "Secrets",
  },
  component: SecretsLayout,
});

function SecretsLayout() {
  return <Outlet />;
}
