import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { CreateProjectForm } from "~/components/create-project-form.tsx";
import { getConfigRepoTemplateOptions } from "~/lib/config-repo-template-options.ts";
import { breadcrumbStaticData } from "~/lib/route-breadcrumbs.ts";

export const Route = createFileRoute("/_app/new-project")({
  staticData: breadcrumbStaticData("New project"),
  loader: async () => ({
    configRepoTemplates: await getConfigRepoTemplateOptions(),
  }),
  component: NewProjectPage,
});

/**
 * Deep-linkable create-project form (`/new-project`). Opens as a right-edge
 * sheet so the same entry works from the sidebar switcher, the projects list,
 * and a shared URL. Closing returns to the projects list (create itself
 * navigates into the new project home). While create is in flight the sheet
 * refuses dismiss so Escape/overlay cannot race the success navigation.
 */
function NewProjectPage() {
  const { configRepoTemplates } = Route.useLoaderData();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) {
          // Controlled open stays true when we ignore dismiss, so the sheet
          // remains visible until create finishes and navigates away.
          if (creating) return;
          void navigate({ to: "/projects" });
        }
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={!creating}
        className="overflow-y-auto data-[side=right]:sm:max-w-md"
      >
        <SheetHeader className="border-b">
          <SheetTitle>Create project</SheetTitle>
          <SheetDescription>
            Pick a slug and project template. You can configure hostnames later.
          </SheetDescription>
        </SheetHeader>
        <div className="p-4">
          <CreateProjectForm
            configRepoTemplates={configRepoTemplates}
            onPendingChange={setCreating}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
