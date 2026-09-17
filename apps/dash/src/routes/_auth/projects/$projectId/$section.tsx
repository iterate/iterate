// /projects/<project>/<section> — ONE route for every section of the registry. Each is a frame
// waiting for its content; until then the page says what it will hold and where that lives today.
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { buttonVariants } from "@iterate-com/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@iterate-com/ui/components/empty";
import { sectionById } from "../../../../sections.ts";

export const Route = createFileRoute("/_auth/projects/$projectId/$section")({
  beforeLoad: ({ params }) => {
    const section = sectionById(params.section);
    if (!section) throw notFound();
    return { section };
  },
  component: SectionPage,
});

function SectionPage() {
  const { project, section } = Route.useRouteContext();
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col p-4 md:p-8">
      <div className="mb-6 flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{section.label}</h1>
        <p className="text-sm text-muted-foreground">{section.blurb}</p>
      </div>
      <Empty className="flex-1 border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <section.icon />
          </EmptyMedia>
          <EmptyTitle>Not in the dash yet</EmptyTitle>
          <EmptyDescription>
            {section.label} for <span className="font-mono">{project.id}</span> will live here.
            {section.today
              ? ` Today it is in ${section.today.label}.`
              : " Today it is in apps/os; this page fills in when it moves."}
          </EmptyDescription>
        </EmptyHeader>
        {section.today ? (
          <EmptyContent>
            <a
              href={section.today.href}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Open {section.today.label}
              <ArrowUpRight />
            </a>
          </EmptyContent>
        ) : null}
      </Empty>
    </div>
  );
}
