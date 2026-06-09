import { Link } from "@tanstack/react-router";
import { streamViewSearch, type StreamViewSearch } from "../lib/stream-view-search.ts";
import { STREAM_VIEWS } from "./-stream-views.ts";

/** Links between the three sibling views of one stream, preserving path and namespace. */
export function ViewSwitcher({ streamView }: { streamView: StreamViewSearch }) {
  return (
    <nav
      aria-label="Stream view"
      data-testid="view-switcher"
      className="flex flex-wrap gap-1 text-xs"
    >
      {STREAM_VIEWS.map(({ slug, label }) => (
        <Link
          key={slug}
          to="/streams"
          search={streamViewSearch({
            path: streamView.path,
            namespace: streamView.namespace,
            view: slug,
          })}
          aria-current={slug === streamView.view ? "page" : undefined}
          data-testid={`view-link-${slug}`}
          className={
            slug === streamView.view
              ? "rounded-md bg-slate-900 px-2 py-1 font-medium text-white"
              : "rounded-md px-2 py-1 text-slate-600 hover:bg-slate-100"
          }
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
