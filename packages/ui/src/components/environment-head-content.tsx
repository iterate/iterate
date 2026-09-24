import { Asset, useRouter, useTags } from "@tanstack/react-router";
import {
  deploymentEnvironment,
  environmentFaviconHref,
  environmentTitle,
} from "../lib/environment-favicon.ts";

/**
 * Every client's `<HeadContent />`, with the deployment named in the browser tab: off production,
 * the title is prefixed (`[pr2990] Dash`, `[dev] Dash`) and the icon badged
 * (lib/environment-favicon.ts); in production both are the app's own. `productionIcon` is the
 * app's icon file in production.
 *
 * TanStack's own HeadContent, re-assembled from its public parts (`useTags`, `Asset`; react-router
 * 1.168 src/HeadContent.tsx) so the title can be rewritten: the deepest route that names a title
 * wins (router-core `buildTagsFromMatches`), so a prefix in the root route's `head()` would vanish
 * on every page that names itself.
 *
 * `router.origin` is the request's origin in the server render (start-server-core
 * `createStartHandler` updates the router with `getOrigin(request)`) and `window.origin` in the
 * browser, so the server's HTML and the hydrated head agree.
 */
export function EnvironmentHeadContent(props: { productionIcon: string }) {
  const router = useRouter();
  const tags = useTags();
  const nonce = router.options.ssr?.nonce;
  if (!router.origin) throw new Error("The router has no origin to tell its deployment from");
  const environment = deploymentEnvironment(new URL(router.origin).hostname);
  return (
    <>
      {tags.map((tag) => (
        <Asset
          {...(tag.tag === "title"
            ? { ...tag, children: environmentTitle(environment, tag.children) }
            : tag)}
          key={`tsr-meta-${JSON.stringify(tag)}`}
          nonce={nonce}
        />
      ))}
      <link
        rel="icon"
        href={environmentFaviconHref(environment, props.productionIcon)}
        type="image/svg+xml"
      />
    </>
  );
}
