import { createFileRoute } from "@tanstack/react-router";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";

export const Route = createFileRoute("/_app/")({
  staticData: {
    breadcrumb: "Home",
  },
  component: HomePage,
});

function HomePage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Daemon V2</CardTitle>
          <CardDescription>
            Registry-style control plane running on the example app scaffold.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Pick an app from the sidebar to inspect its routes, docs, or database.
        </CardContent>
      </Card>
    </div>
  );
}
