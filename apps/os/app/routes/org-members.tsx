import { useParams } from "react-router";

export function meta() {
  return [{ title: "Organization Members" }];
}

export default function OrgMembers() {
  const params = useParams();
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-2">Members & Invites</h1>
      <p className="text-muted-foreground">Organization: {params.organizationId}</p>
      {/* TODO: Implement members management UI */}
    </div>
  );
}

