import { useParams } from "react-router";
import type { Route } from "./+types/org-settings";

export function meta() {
  return [{ title: "Organization Settings" }];
}

export default function OrgSettings() {
  const params = useParams();
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-2">Organization Settings</h1>
      <p className="text-muted-foreground">Organization: {params.organizationId}</p>
      {/* TODO: Implement settings form */}
    </div>
  );
}

