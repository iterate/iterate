import { createFileRoute } from "@tanstack/react-router";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";

export const Route = createFileRoute("/_app/")({
  component: HomePage,
});

function HomePage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Home</CardTitle>
          <CardDescription>Placeholder home page for the registry control plane.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Pick a service from the sidebar to inspect its routes, docs, or database.
        </CardContent>
      </Card>
    </div>
  );
}
