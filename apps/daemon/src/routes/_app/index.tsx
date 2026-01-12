import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/")({
  component: HomePage,
});

function HomePage() {
  return (
    <div className="p-6">
      <p className="text-muted-foreground">
        This app lets you control all the agents on this machine.
      </p>
    </div>
  );
}
