import { Navigate } from "react-router";

export default function AdminRedirect() {
  return <Navigate to="/admin/session-info" replace />;
}
