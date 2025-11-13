import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth.layout/admin/")({
  component: AdminRedirect,
});

export default function AdminRedirect() {
  return <Navigate to="/admin/session-info" replace />;
}
