// A context's path, once, each segment a link up: `/ repos / config`, the last segment the page's
// own. The link target is the caller's (`ContextPathLinks`): the UI kit knows no routes, so an app
// says what URL a path opens and, with a client router, takes the plain click itself — the way
// AppShell's `projectHref` and `onNavigate` work.
import { createContext, useContext, type ReactNode, type SyntheticEvent } from "react";
import { cn } from "cn";
import { plainLeftClick } from "../app-shell-palette-entries.ts";

/** Where a context path links to, the app's: `hrefOf("/repos")` is its URL; `onNavigate`, when the
 *  app has a client router, takes a plain click or an Enter (it prevents the default and navigates).
 *  Without it a link is a page load. */
export type ContextPathLinks = {
  hrefOf: (path: string) => string;
  onNavigate?: (href: string, event: SyntheticEvent) => void;
};

/** The links a context view's rows use for the paths they name (a child context's): provided by
 *  `ContextView` from its `pathLinks`, absent where the app gave none. */
export const ContextPathLinksContext = createContext<ContextPathLinks | undefined>(undefined);

/** Go to `path` as the app does it: its router, else a page load. */
export function navigateToPath(links: ContextPathLinks, path: string, event: SyntheticEvent) {
  const href = links.hrefOf(path);
  if (links.onNavigate) links.onNavigate(href, event);
  else window.location.assign(href);
}

/** An anchor to a context path: a plain click goes through the app's router, a modified or middle
 *  click is the browser's. */
export function PathLink({
  path,
  links,
  className,
  children,
  ...rest
}: {
  path: string;
  links: ContextPathLinks;
  className?: string;
  children: ReactNode;
  "aria-current"?: "page";
  "aria-label"?: string;
}) {
  const href = links.hrefOf(path);
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        // a link inside an inspectable row opens the path, not the inspector
        event.stopPropagation();
        if (links.onNavigate && plainLeftClick(event)) links.onNavigate(href, event);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

/** A path a row names (`Child context /repos/config created`): a link when the view has
 *  `pathLinks`, else the path as text. The path is the children too, so a sentence's text (the
 *  fold's fact, folds.tsx `sentenceText`) still carries it. */
export function ContextPathText({ path }: { path: string }) {
  const links = useContext(ContextPathLinksContext);
  if (!links) return <span className="font-mono">{path}</span>;
  return (
    <PathLink
      path={path}
      links={links}
      className="font-mono underline decoration-border underline-offset-2 hover:decoration-foreground"
    >
      {path}
    </PathLink>
  );
}

/** `/ repos / config`: the root and each segment up a muted link, the last segment the page's. */
export function ContextPath({
  path,
  links,
  className,
}: {
  path: string;
  links: ContextPathLinks;
  className?: string;
}) {
  const segments = path.split("/").filter(Boolean);
  const up = "text-muted-foreground hover:text-foreground";
  return (
    <nav
      aria-label="Context path"
      className={cn("flex min-w-0 items-baseline gap-1 font-mono text-sm", className)}
    >
      {segments.length === 0 ? (
        <span aria-current="page" className="font-semibold">
          /
        </span>
      ) : (
        <PathLink path="/" links={links} className={up} aria-label="/">
          /
        </PathLink>
      )}
      {segments.map((segment, index) => {
        const last = index === segments.length - 1;
        const to = `/${segments.slice(0, index + 1).join("/")}`;
        return (
          <span key={to} className="flex min-w-0 items-baseline gap-1">
            {index ? <span className="text-muted-foreground">/</span> : null}
            {last ? (
              <span aria-current="page" className="truncate font-semibold">
                {segment}
              </span>
            ) : (
              <PathLink path={to} links={links} className={up}>
                {segment}
              </PathLink>
            )}
          </span>
        );
      })}
    </nav>
  );
}
