import { Outlet } from "react-router";
import { DashboardLayout } from "../../components/dashboard-layout.tsx";

export default function OrgLayout() {
  return (
    <DashboardLayout>
      <Outlet />
    </DashboardLayout>
  );
}
