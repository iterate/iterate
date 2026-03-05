import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: () => (
    <main className="p-4">
      <h1 className="text-2xl font-bold">Home</h1>
    </main>
  ),
});
