import { createFileRoute } from "@tanstack/react-router";
import { CreateProjectForm } from "~/components/create-project-form.tsx";
import { breadcrumbStaticData } from "~/lib/route-breadcrumbs.ts";

export const Route = createFileRoute("/_app/projects/_new")({
  staticData: breadcrumbStaticData("New project"),
  component: NewProjectPage,
});

function NewProjectPage() {
  return (
    <section className="space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">New project</h2>
        <p className="text-sm text-muted-foreground">
          Pick a slug for your project. You can configure hostnames later.
        </p>
      </div>
      <CreateProjectForm />
    </section>
  );
}
