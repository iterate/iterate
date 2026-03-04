import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth/admin/api-tools")({
  component: ApiToolsPage,
});

function ApiToolsPage() {
  return (
    <div className="p-8 space-y-4">
      <h1 className="text-2xl font-bold">API Tools</h1>
      <p className="text-muted-foreground">
        API tools interface coming soon. Use browser devtools to inspect API calls.
      </p>
      <div className="space-y-2">
        <div className="text-sm font-medium">Routers</div>
        <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
          <li>user - User operations</li>
          <li>organization - Organization CRUD</li>
          <li>project - Project management</li>
          <li>machine - Machine CRUD</li>
          <li>admin - Admin operations</li>
          <li>testing - Test helpers</li>
        </ul>
      </div>
    </div>
  );
}
