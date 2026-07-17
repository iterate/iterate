import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { CreateProjectForm } from "~/components/create-project-form.tsx";
import { breadcrumbStaticData } from "~/lib/route-breadcrumbs.ts";

export const Route = createFileRoute("/_app/new-project")({
  staticData: breadcrumbStaticData("New project"),
  component: NewProjectPage,
});

/**
 * Deep-linkable create-project form (`/new-project`). Opens as a right-edge
 * sheet so the same entry works from the sidebar switcher, the projects list,
 * and a shared URL. Closing returns to the projects list (create itself
 * navigates into the new project home).
 */
function NewProjectPage() {
  const navigate = useNavigate();

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) {
          void navigate({ to: "/projects" });
        }
      }}
    >
      <SheetContent side="right" className="overflow-y-auto data-[side=right]:sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Create project</SheetTitle>
          <SheetDescription>
            Pick a slug for your project. You can configure hostnames later.
          </SheetDescription>
        </SheetHeader>
        <div className="p-4">
          <CreateProjectForm />
        </div>
      </SheetContent>
    </Sheet>
  );
}
