import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings")({ component: Settings });

function Settings() {
  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-4">Settings</h1>
      <p className="text-muted-foreground">This is the settings page.</p>
    </div>
  );
}
