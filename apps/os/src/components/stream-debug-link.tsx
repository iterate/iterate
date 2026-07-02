import { ExternalLink } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { cn } from "@iterate-com/ui/lib/utils";
import type { StreamPath } from "~/lib/stream-links.ts";

export function StreamDebugLink({
  className,
  label = "Open stream",
  projectSlug,
  streamPath,
}: {
  className?: string;
  label?: string;
  projectSlug: string;
  streamPath: StreamPath;
}) {
  return (
    <Link
      className={cn(buttonVariants({ variant: "outline", size: "sm" }), className)}
      to="/projects/$projectSlug/streams/$"
      params={{ projectSlug, _splat: streamPath }}
      target="_blank"
      rel="noreferrer"
    >
      <ExternalLink data-icon="inline-start" />
      {label}
    </Link>
  );
}
