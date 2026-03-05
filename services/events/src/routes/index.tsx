import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function IndexPage() {
  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold">Events Service</h1>
    </div>
  );
}
