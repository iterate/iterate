import { Link } from "@tanstack/react-router";
import { STREAM_VIEWS } from "./-stream-views.ts";

/** Links between the three sibling views of one stream, preserving the path. */
export function ViewSwitcher({ streamPath, current }: { streamPath: string; current: string }) {
  const splat = streamPath.replace(/^\//, "");
  return (
    <nav
      aria-label="Stream view"
      data-testid="view-switcher"
      className="flex flex-wrap gap-1 text-xs"
    >
      {STREAM_VIEWS.map(({ slug, label }) =>
        streamPath === "/" ? (
          <Link
            key={slug}
            to="/streams"
            search={{ view: slug }}
            aria-current={slug === current ? "page" : undefined}
            data-testid={`view-link-${slug}`}
            className={
              slug === current
                ? "rounded-md bg-slate-900 px-2 py-1 font-medium text-white"
                : "rounded-md px-2 py-1 text-slate-600 hover:bg-slate-100"
            }
          >
            {label}
          </Link>
        ) : (
          <Link
            key={slug}
            to="/streams/$"
            params={{ _splat: splat }}
            search={{ view: slug }}
            aria-current={slug === current ? "page" : undefined}
            data-testid={`view-link-${slug}`}
            className={
              slug === current
                ? "rounded-md bg-slate-900 px-2 py-1 font-medium text-white"
                : "rounded-md px-2 py-1 text-slate-600 hover:bg-slate-100"
            }
          >
            {label}
          </Link>
        ),
      )}
    </nav>
  );
}
