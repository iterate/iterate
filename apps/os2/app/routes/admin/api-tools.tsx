import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth-required/_/admin/api-tools")({
  component: ApiToolsPage,
});

function ApiToolsPage() {
  return (
    <div className="p-8 space-y-4">
      <h1 className="text-2xl font-bold">API Tools</h1>
      <p className="text-muted-foreground">
        Use browser devtools to inspect API calls at <code className="bg-muted px-1 py-0.5 rounded">/api/orpc/*</code>.
      </p>
      <div className="space-y-2">
        <div className="text-sm font-medium">Routers</div>
        <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
          <li>user - User operations</li>
          <li>organization - Organization CRUD</li>
          <li>project - Project management</li>
          <li>machine - Machine CRUD</li>
          <li>accessToken - Project access tokens</li>
          <li>envVar - Environment variables</li>
          <li>admin - Admin operations</li>
          <li>testing - Test helpers</li>
        </ul>
      </div>
    </div>
  );
}
