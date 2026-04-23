import {
  a as __toESM,
  n as require_react,
  t as require_jsx_runtime,
} from "./jsx-runtime-B8ri5dzN.js";
import {
  S as desc,
  T as eq,
  _ as createNonReactiveReadonlyStore,
  a as Outlet,
  d as getAssetCrossOrigin,
  f as resolveManifestAssetLink,
  g as createNonReactiveMutableStore,
  n as thingsTable,
  p as RouterCore,
  r as WebSocketResponse,
  tt as sql,
} from "./schema-CqGeDXDz.js";
import {
  F as escapeHtml,
  N as deepEqual,
  l as useHydrated,
  o as useRouter,
  r as useStore,
} from "./__23tanstack-start-server-fn-resolver-CRZD-Up_.js";
import {
  a as Link,
  i as createRootRoute,
  n as lazyRouteComponent,
  r as createFileRoute,
  t as Route$8,
} from "./routes-CnTaS0pU.js";
import {
  B as matchQuery,
  C as Mutation,
  D as onlineManager,
  F as functionalUpdate,
  G as resolveStaleTime,
  H as partialMatchKey,
  I as hashKey,
  J as skipToken,
  L as hashQueryKeyByOptions,
  M as addToEnd,
  N as addToStart,
  O as notifyManager,
  P as ensureQueryFn,
  Q as Subscribable,
  T as Query,
  V as noop,
  Z as focusManager,
  _ as ValidationError,
  a as standardizeHTTPPath,
  b as validateORPCError,
  c as ZodFirstPartyTypeKind,
  d as getContractRouter,
  f as getEventIteratorSchemaDetails,
  g as mergeTags,
  h as mergeRoute,
  i as getDynamicParams,
  j as addConsumeAwareSignal,
  l as enhanceRoute,
  m as mergePrefix,
  o as StandardBracketNotationSerializer,
  p as mergeMeta,
  r as StandardOpenAPISerializer,
  s as appContract,
  t as StandardOpenAPIJsonSerializer,
  u as fallbackContractConfig,
  v as isContractProcedure,
  x as QueryClientProvider,
  y as mergeErrorMap,
  z as matchMutation,
} from "./openapi-client.B2Q9qU5m-VGP-ttS6.js";
import {
  $ as runWithSpan,
  C as HibernationEventIterator,
  F as ORPC_NAME,
  H as intercept,
  J as overlayProxy,
  K as onError,
  L as asyncIteratorWithSpan,
  P as NullProtoObj$1,
  R as clone,
  U as isAsyncIteratorObject,
  W as isObject,
  Y as parseEmptyableJSON,
  Z as resolveMaybeOptionalOptions,
  _ as fallbackORPCErrorMessage,
  a as StandardRPCSerializer,
  at as value,
  b as isORPCErrorStatus,
  d as toStandardLazyRequest,
  et as setSpanError,
  h as ORPCError,
  it as tryDecodeURIComponent,
  m as mapEventIterator,
  nt as stringifyJSON,
  q as once,
  r as StandardRPCJsonSerializer,
  rt as toArray,
  s as toHttpPath,
  u as toFetchResponse,
  v as fallbackORPCErrorStatus,
  w as flattenHeader,
  x as toORPCError,
  z as findDeepMatches,
} from "./client.DrB9nq_G-HI4B2Z7U.js";
import { n as ServerPeer } from "./dist-DD-ghk-D.js";
//#region node_modules/@tanstack/react-router/dist/esm/routerStores.js
var getStoreFactory = (opts) => {
  return {
    createMutableStore: createNonReactiveMutableStore,
    createReadonlyStore: createNonReactiveReadonlyStore,
    batch: (fn) => fn(),
  };
};
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/router.js
/**
 * Creates a new Router instance for React.
 *
 * Pass the returned router to `RouterProvider` to enable routing.
 * Notable options: `routeTree` (your route definitions) and `context`
 * (required if the root route was created with `createRootRouteWithContext`).
 *
 * @param options Router options used to configure the router.
 * @returns A Router instance to be provided to `RouterProvider`.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/createRouterFunction
 */
var createRouter$2 = (options) => {
  return new Router(options);
};
var Router = class extends RouterCore {
  constructor(options) {
    super(options, getStoreFactory);
  }
};
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/Asset.js
var import_react = /* @__PURE__ */ __toESM(require_react(), 1);
var import_jsx_runtime = require_jsx_runtime();
function Asset({ tag, attrs, children, nonce }) {
  switch (tag) {
    case "title":
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("title", {
        ...attrs,
        suppressHydrationWarning: true,
        children,
      });
    case "meta":
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("meta", {
        ...attrs,
        suppressHydrationWarning: true,
      });
    case "link":
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("link", {
        ...attrs,
        precedence: attrs?.precedence ?? (attrs?.rel === "stylesheet" ? "default" : void 0),
        nonce,
        suppressHydrationWarning: true,
      });
    case "style":
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", {
        ...attrs,
        dangerouslySetInnerHTML: { __html: children },
        nonce,
      });
    case "script":
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Script, {
        attrs,
        children,
      });
    default:
      return null;
  }
}
function Script({ attrs, children }) {
  useRouter();
  useHydrated();
  const dataScript =
    typeof attrs?.type === "string" &&
    attrs.type !== "" &&
    attrs.type !== "text/javascript" &&
    attrs.type !== "module";
  import_react.useEffect(() => {
    if (dataScript) return;
    if (attrs?.src) {
      const normSrc = (() => {
        try {
          const base = document.baseURI || window.location.href;
          return new URL(attrs.src, base).href;
        } catch {
          return attrs.src;
        }
      })();
      if (Array.from(document.querySelectorAll("script[src]")).find((el) => el.src === normSrc))
        return;
      const script = document.createElement("script");
      for (const [key, value] of Object.entries(attrs))
        if (key !== "suppressHydrationWarning" && value !== void 0 && value !== false)
          script.setAttribute(key, typeof value === "boolean" ? "" : String(value));
      document.head.appendChild(script);
      return () => {
        if (script.parentNode) script.parentNode.removeChild(script);
      };
    }
    if (typeof children === "string") {
      const typeAttr = typeof attrs?.type === "string" ? attrs.type : "text/javascript";
      const nonceAttr = typeof attrs?.nonce === "string" ? attrs.nonce : void 0;
      if (
        Array.from(document.querySelectorAll("script:not([src])")).find((el) => {
          if (!(el instanceof HTMLScriptElement)) return false;
          const sType = el.getAttribute("type") ?? "text/javascript";
          const sNonce = el.getAttribute("nonce") ?? void 0;
          return el.textContent === children && sType === typeAttr && sNonce === nonceAttr;
        })
      )
        return;
      const script = document.createElement("script");
      script.textContent = children;
      if (attrs) {
        for (const [key, value] of Object.entries(attrs))
          if (key !== "suppressHydrationWarning" && value !== void 0 && value !== false)
            script.setAttribute(key, typeof value === "boolean" ? "" : String(value));
      }
      document.head.appendChild(script);
      return () => {
        if (script.parentNode) script.parentNode.removeChild(script);
      };
    }
  }, [attrs, children, dataScript]);
  if (attrs?.src)
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("script", {
      ...attrs,
      suppressHydrationWarning: true,
    });
  if (typeof children === "string")
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("script", {
      ...attrs,
      dangerouslySetInnerHTML: { __html: children },
      suppressHydrationWarning: true,
    });
  return null;
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/headContentUtils.js
function buildTagsFromMatches(router, nonce, matches, assetCrossOrigin) {
  const routeMeta = matches.map((match) => match.meta).filter(Boolean);
  const resultMeta = [];
  const metaByAttribute = {};
  let title;
  for (let i = routeMeta.length - 1; i >= 0; i--) {
    const metas = routeMeta[i];
    for (let j = metas.length - 1; j >= 0; j--) {
      const m = metas[j];
      if (!m) continue;
      if (m.title) {
        if (!title)
          title = {
            tag: "title",
            children: m.title,
          };
      } else if ("script:ld+json" in m)
        try {
          const json = JSON.stringify(m["script:ld+json"]);
          resultMeta.push({
            tag: "script",
            attrs: { type: "application/ld+json" },
            children: escapeHtml(json),
          });
        } catch {}
      else {
        const attribute = m.name ?? m.property;
        if (attribute)
          if (metaByAttribute[attribute]) continue;
          else metaByAttribute[attribute] = true;
        resultMeta.push({
          tag: "meta",
          attrs: {
            ...m,
            nonce,
          },
        });
      }
    }
  }
  if (title) resultMeta.push(title);
  if (nonce)
    resultMeta.push({
      tag: "meta",
      attrs: {
        property: "csp-nonce",
        content: nonce,
      },
    });
  resultMeta.reverse();
  const constructedLinks = matches
    .map((match) => match.links)
    .filter(Boolean)
    .flat(1)
    .map((link) => ({
      tag: "link",
      attrs: {
        ...link,
        nonce,
      },
    }));
  const manifest = router.ssr?.manifest;
  const assetLinks = matches
    .map((match) => manifest?.routes[match.routeId]?.assets ?? [])
    .filter(Boolean)
    .flat(1)
    .filter((asset) => asset.tag === "link")
    .map((asset) => ({
      tag: "link",
      attrs: {
        ...asset.attrs,
        crossOrigin:
          getAssetCrossOrigin(assetCrossOrigin, "stylesheet") ?? asset.attrs?.crossOrigin,
        suppressHydrationWarning: true,
        nonce,
      },
    }));
  const preloadLinks = [];
  matches
    .map((match) => router.looseRoutesById[match.routeId])
    .forEach((route) =>
      router.ssr?.manifest?.routes[route.id]?.preloads?.filter(Boolean).forEach((preload) => {
        const preloadLink = resolveManifestAssetLink(preload);
        preloadLinks.push({
          tag: "link",
          attrs: {
            rel: "modulepreload",
            href: preloadLink.href,
            crossOrigin:
              getAssetCrossOrigin(assetCrossOrigin, "modulepreload") ?? preloadLink.crossOrigin,
            nonce,
          },
        });
      }),
    );
  const styles = matches
    .map((match) => match.styles)
    .flat(1)
    .filter(Boolean)
    .map(({ children, ...attrs }) => ({
      tag: "style",
      attrs: {
        ...attrs,
        nonce,
      },
      children,
    }));
  const headScripts = matches
    .map((match) => match.headScripts)
    .flat(1)
    .filter(Boolean)
    .map(({ children, ...script }) => ({
      tag: "script",
      attrs: {
        ...script,
        nonce,
      },
      children,
    }));
  return uniqBy(
    [...resultMeta, ...preloadLinks, ...constructedLinks, ...assetLinks, ...styles, ...headScripts],
    (d) => JSON.stringify(d),
  );
}
/**
 * Build the list of head/link/meta/script tags to render for active matches.
 * Used internally by `HeadContent`.
 */
var useTags = (assetCrossOrigin) => {
  const router = useRouter();
  const nonce = router.options.ssr?.nonce;
  return buildTagsFromMatches(router, nonce, router.stores.matches.get(), assetCrossOrigin);
};
function uniqBy(arr, fn) {
  const seen = /* @__PURE__ */ new Set();
  return arr.filter((item) => {
    const key = fn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/HeadContent.js
/**
 * Render route-managed head tags (title, meta, links, styles, head scripts).
 * Place inside the document head of your app shell.
 * @link https://tanstack.com/router/latest/docs/framework/react/guide/document-head-management
 */
function HeadContent(props) {
  const tags = useTags(props.assetCrossOrigin);
  const nonce = useRouter().options.ssr?.nonce;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, {
    children: tags.map((tag) =>
      /* @__PURE__ */ (0, import_react.createElement)(Asset, {
        ...tag,
        key: `tsr-meta-${JSON.stringify(tag)}`,
        nonce,
      }),
    ),
  });
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/Scripts.js
/**
 * Render body script tags collected from route matches and SSR manifests.
 * Should be placed near the end of the document body.
 */
var Scripts = () => {
  const router = useRouter();
  const nonce = router.options.ssr?.nonce;
  const getAssetScripts = (matches) => {
    const assetScripts = [];
    const manifest = router.ssr?.manifest;
    if (!manifest) return [];
    matches
      .map((match) => router.looseRoutesById[match.routeId])
      .forEach((route) =>
        manifest.routes[route.id]?.assets
          ?.filter((d) => d.tag === "script")
          .forEach((asset) => {
            assetScripts.push({
              tag: "script",
              attrs: {
                ...asset.attrs,
                nonce,
              },
              children: asset.children,
            });
          }),
      );
    return assetScripts;
  };
  const getScripts = (matches) =>
    matches
      .map((match) => match.scripts)
      .flat(1)
      .filter(Boolean)
      .map(({ children, ...script }) => ({
        tag: "script",
        attrs: {
          ...script,
          suppressHydrationWarning: true,
          nonce,
        },
        children,
      }));
  {
    const activeMatches = router.stores.matches.get();
    const assetScripts = getAssetScripts(activeMatches);
    return renderScripts(router, getScripts(activeMatches), assetScripts);
  }
  const assetScripts = useStore(router.stores.matches, getAssetScripts, deepEqual);
  return renderScripts(
    router,
    useStore(router.stores.matches, getScripts, deepEqual),
    assetScripts,
  );
};
function renderScripts(router, scripts, assetScripts) {
  let serverBufferedScript = void 0;
  if (router.serverSsr) serverBufferedScript = router.serverSsr.takeBufferedScripts();
  const allScripts = [...scripts, ...assetScripts];
  if (serverBufferedScript) allScripts.unshift(serverBufferedScript);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, {
    children: allScripts.map((asset, i) =>
      /* @__PURE__ */ (0, import_react.createElement)(Asset, {
        ...asset,
        key: `tsr-scripts-${asset.tag}-${i}`,
      }),
    ),
  });
}
//#endregion
//#region node_modules/@tanstack/query-core/build/modern/infiniteQueryBehavior.js
function infiniteQueryBehavior(pages) {
  return {
    onFetch: (context, query) => {
      const options = context.options;
      const direction = context.fetchOptions?.meta?.fetchMore?.direction;
      const oldPages = context.state.data?.pages || [];
      const oldPageParams = context.state.data?.pageParams || [];
      let result = {
        pages: [],
        pageParams: [],
      };
      let currentPage = 0;
      const fetchFn = async () => {
        let cancelled = false;
        const addSignalProperty = (object) => {
          addConsumeAwareSignal(
            object,
            () => context.signal,
            () => (cancelled = true),
          );
        };
        const queryFn = ensureQueryFn(context.options, context.fetchOptions);
        const fetchPage = async (data, param, previous) => {
          if (cancelled) return Promise.reject();
          if (param == null && data.pages.length) return Promise.resolve(data);
          const createQueryFnContext = () => {
            const queryFnContext2 = {
              client: context.client,
              queryKey: context.queryKey,
              pageParam: param,
              direction: previous ? "backward" : "forward",
              meta: context.options.meta,
            };
            addSignalProperty(queryFnContext2);
            return queryFnContext2;
          };
          const page = await queryFn(createQueryFnContext());
          const { maxPages } = context.options;
          const addTo = previous ? addToStart : addToEnd;
          return {
            pages: addTo(data.pages, page, maxPages),
            pageParams: addTo(data.pageParams, param, maxPages),
          };
        };
        if (direction && oldPages.length) {
          const previous = direction === "backward";
          const pageParamFn = previous ? getPreviousPageParam : getNextPageParam;
          const oldData = {
            pages: oldPages,
            pageParams: oldPageParams,
          };
          result = await fetchPage(oldData, pageParamFn(options, oldData), previous);
        } else {
          const remainingPages = pages ?? oldPages.length;
          do {
            const param =
              currentPage === 0
                ? (oldPageParams[0] ?? options.initialPageParam)
                : getNextPageParam(options, result);
            if (currentPage > 0 && param == null) break;
            result = await fetchPage(result, param);
            currentPage++;
          } while (currentPage < remainingPages);
        }
        return result;
      };
      if (context.options.persister)
        context.fetchFn = () => {
          return context.options.persister?.(
            fetchFn,
            {
              client: context.client,
              queryKey: context.queryKey,
              meta: context.options.meta,
              signal: context.signal,
            },
            query,
          );
        };
      else context.fetchFn = fetchFn;
    },
  };
}
function getNextPageParam(options, { pages, pageParams }) {
  const lastIndex = pages.length - 1;
  return pages.length > 0
    ? options.getNextPageParam(pages[lastIndex], pages, pageParams[lastIndex], pageParams)
    : void 0;
}
function getPreviousPageParam(options, { pages, pageParams }) {
  return pages.length > 0
    ? options.getPreviousPageParam?.(pages[0], pages, pageParams[0], pageParams)
    : void 0;
}
//#endregion
//#region node_modules/@tanstack/query-core/build/modern/mutationCache.js
var MutationCache = class extends Subscribable {
  constructor(config = {}) {
    super();
    this.config = config;
    this.#mutations = /* @__PURE__ */ new Set();
    this.#scopes = /* @__PURE__ */ new Map();
    this.#mutationId = 0;
  }
  #mutations;
  #scopes;
  #mutationId;
  build(client, options, state) {
    const mutation = new Mutation({
      client,
      mutationCache: this,
      mutationId: ++this.#mutationId,
      options: client.defaultMutationOptions(options),
      state,
    });
    this.add(mutation);
    return mutation;
  }
  add(mutation) {
    this.#mutations.add(mutation);
    const scope = scopeFor(mutation);
    if (typeof scope === "string") {
      const scopedMutations = this.#scopes.get(scope);
      if (scopedMutations) scopedMutations.push(mutation);
      else this.#scopes.set(scope, [mutation]);
    }
    this.notify({
      type: "added",
      mutation,
    });
  }
  remove(mutation) {
    if (this.#mutations.delete(mutation)) {
      const scope = scopeFor(mutation);
      if (typeof scope === "string") {
        const scopedMutations = this.#scopes.get(scope);
        if (scopedMutations) {
          if (scopedMutations.length > 1) {
            const index = scopedMutations.indexOf(mutation);
            if (index !== -1) scopedMutations.splice(index, 1);
          } else if (scopedMutations[0] === mutation) this.#scopes.delete(scope);
        }
      }
    }
    this.notify({
      type: "removed",
      mutation,
    });
  }
  canRun(mutation) {
    const scope = scopeFor(mutation);
    if (typeof scope === "string") {
      const firstPendingMutation = this.#scopes
        .get(scope)
        ?.find((m) => m.state.status === "pending");
      return !firstPendingMutation || firstPendingMutation === mutation;
    } else return true;
  }
  runNext(mutation) {
    const scope = scopeFor(mutation);
    if (typeof scope === "string")
      return (
        this.#scopes.get(scope)?.find((m) => m !== mutation && m.state.isPaused)?.continue() ??
        Promise.resolve()
      );
    else return Promise.resolve();
  }
  clear() {
    notifyManager.batch(() => {
      this.#mutations.forEach((mutation) => {
        this.notify({
          type: "removed",
          mutation,
        });
      });
      this.#mutations.clear();
      this.#scopes.clear();
    });
  }
  getAll() {
    return Array.from(this.#mutations);
  }
  find(filters) {
    const defaultedFilters = {
      exact: true,
      ...filters,
    };
    return this.getAll().find((mutation) => matchMutation(defaultedFilters, mutation));
  }
  findAll(filters = {}) {
    return this.getAll().filter((mutation) => matchMutation(filters, mutation));
  }
  notify(event) {
    notifyManager.batch(() => {
      this.listeners.forEach((listener) => {
        listener(event);
      });
    });
  }
  resumePausedMutations() {
    const pausedMutations = this.getAll().filter((x) => x.state.isPaused);
    return notifyManager.batch(() =>
      Promise.all(pausedMutations.map((mutation) => mutation.continue().catch(noop))),
    );
  }
};
function scopeFor(mutation) {
  return mutation.options.scope?.id;
}
//#endregion
//#region node_modules/@tanstack/query-core/build/modern/queryCache.js
var QueryCache = class extends Subscribable {
  constructor(config = {}) {
    super();
    this.config = config;
    this.#queries = /* @__PURE__ */ new Map();
  }
  #queries;
  build(client, options, state) {
    const queryKey = options.queryKey;
    const queryHash = options.queryHash ?? hashQueryKeyByOptions(queryKey, options);
    let query = this.get(queryHash);
    if (!query) {
      query = new Query({
        client,
        queryKey,
        queryHash,
        options: client.defaultQueryOptions(options),
        state,
        defaultOptions: client.getQueryDefaults(queryKey),
      });
      this.add(query);
    }
    return query;
  }
  add(query) {
    if (!this.#queries.has(query.queryHash)) {
      this.#queries.set(query.queryHash, query);
      this.notify({
        type: "added",
        query,
      });
    }
  }
  remove(query) {
    const queryInMap = this.#queries.get(query.queryHash);
    if (queryInMap) {
      query.destroy();
      if (queryInMap === query) this.#queries.delete(query.queryHash);
      this.notify({
        type: "removed",
        query,
      });
    }
  }
  clear() {
    notifyManager.batch(() => {
      this.getAll().forEach((query) => {
        this.remove(query);
      });
    });
  }
  get(queryHash) {
    return this.#queries.get(queryHash);
  }
  getAll() {
    return [...this.#queries.values()];
  }
  find(filters) {
    const defaultedFilters = {
      exact: true,
      ...filters,
    };
    return this.getAll().find((query) => matchQuery(defaultedFilters, query));
  }
  findAll(filters = {}) {
    const queries = this.getAll();
    return Object.keys(filters).length > 0
      ? queries.filter((query) => matchQuery(filters, query))
      : queries;
  }
  notify(event) {
    notifyManager.batch(() => {
      this.listeners.forEach((listener) => {
        listener(event);
      });
    });
  }
  onFocus() {
    notifyManager.batch(() => {
      this.getAll().forEach((query) => {
        query.onFocus();
      });
    });
  }
  onOnline() {
    notifyManager.batch(() => {
      this.getAll().forEach((query) => {
        query.onOnline();
      });
    });
  }
};
//#endregion
//#region node_modules/@tanstack/query-core/build/modern/queryClient.js
var QueryClient = class {
  #queryCache;
  #mutationCache;
  #defaultOptions;
  #queryDefaults;
  #mutationDefaults;
  #mountCount;
  #unsubscribeFocus;
  #unsubscribeOnline;
  constructor(config = {}) {
    this.#queryCache = config.queryCache || new QueryCache();
    this.#mutationCache = config.mutationCache || new MutationCache();
    this.#defaultOptions = config.defaultOptions || {};
    this.#queryDefaults = /* @__PURE__ */ new Map();
    this.#mutationDefaults = /* @__PURE__ */ new Map();
    this.#mountCount = 0;
  }
  mount() {
    this.#mountCount++;
    if (this.#mountCount !== 1) return;
    this.#unsubscribeFocus = focusManager.subscribe(async (focused) => {
      if (focused) {
        await this.resumePausedMutations();
        this.#queryCache.onFocus();
      }
    });
    this.#unsubscribeOnline = onlineManager.subscribe(async (online) => {
      if (online) {
        await this.resumePausedMutations();
        this.#queryCache.onOnline();
      }
    });
  }
  unmount() {
    this.#mountCount--;
    if (this.#mountCount !== 0) return;
    this.#unsubscribeFocus?.();
    this.#unsubscribeFocus = void 0;
    this.#unsubscribeOnline?.();
    this.#unsubscribeOnline = void 0;
  }
  isFetching(filters) {
    return this.#queryCache.findAll({
      ...filters,
      fetchStatus: "fetching",
    }).length;
  }
  isMutating(filters) {
    return this.#mutationCache.findAll({
      ...filters,
      status: "pending",
    }).length;
  }
  /**
   * Imperative (non-reactive) way to retrieve data for a QueryKey.
   * Should only be used in callbacks or functions where reading the latest data is necessary, e.g. for optimistic updates.
   *
   * Hint: Do not use this function inside a component, because it won't receive updates.
   * Use `useQuery` to create a `QueryObserver` that subscribes to changes.
   */
  getQueryData(queryKey) {
    const options = this.defaultQueryOptions({ queryKey });
    return this.#queryCache.get(options.queryHash)?.state.data;
  }
  ensureQueryData(options) {
    const defaultedOptions = this.defaultQueryOptions(options);
    const query = this.#queryCache.build(this, defaultedOptions);
    const cachedData = query.state.data;
    if (cachedData === void 0) return this.fetchQuery(options);
    if (
      options.revalidateIfStale &&
      query.isStaleByTime(resolveStaleTime(defaultedOptions.staleTime, query))
    )
      this.prefetchQuery(defaultedOptions);
    return Promise.resolve(cachedData);
  }
  getQueriesData(filters) {
    return this.#queryCache.findAll(filters).map(({ queryKey, state }) => {
      return [queryKey, state.data];
    });
  }
  setQueryData(queryKey, updater, options) {
    const defaultedOptions = this.defaultQueryOptions({ queryKey });
    const prevData = this.#queryCache.get(defaultedOptions.queryHash)?.state.data;
    const data = functionalUpdate(updater, prevData);
    if (data === void 0) return;
    return this.#queryCache.build(this, defaultedOptions).setData(data, {
      ...options,
      manual: true,
    });
  }
  setQueriesData(filters, updater, options) {
    return notifyManager.batch(() =>
      this.#queryCache
        .findAll(filters)
        .map(({ queryKey }) => [queryKey, this.setQueryData(queryKey, updater, options)]),
    );
  }
  getQueryState(queryKey) {
    const options = this.defaultQueryOptions({ queryKey });
    return this.#queryCache.get(options.queryHash)?.state;
  }
  removeQueries(filters) {
    const queryCache = this.#queryCache;
    notifyManager.batch(() => {
      queryCache.findAll(filters).forEach((query) => {
        queryCache.remove(query);
      });
    });
  }
  resetQueries(filters, options) {
    const queryCache = this.#queryCache;
    return notifyManager.batch(() => {
      queryCache.findAll(filters).forEach((query) => {
        query.reset();
      });
      return this.refetchQueries(
        {
          type: "active",
          ...filters,
        },
        options,
      );
    });
  }
  cancelQueries(filters, cancelOptions = {}) {
    const defaultedCancelOptions = {
      revert: true,
      ...cancelOptions,
    };
    const promises = notifyManager.batch(() =>
      this.#queryCache.findAll(filters).map((query) => query.cancel(defaultedCancelOptions)),
    );
    return Promise.all(promises).then(noop).catch(noop);
  }
  invalidateQueries(filters, options = {}) {
    return notifyManager.batch(() => {
      this.#queryCache.findAll(filters).forEach((query) => {
        query.invalidate();
      });
      if (filters?.refetchType === "none") return Promise.resolve();
      return this.refetchQueries(
        {
          ...filters,
          type: filters?.refetchType ?? filters?.type ?? "active",
        },
        options,
      );
    });
  }
  refetchQueries(filters, options = {}) {
    const fetchOptions = {
      ...options,
      cancelRefetch: options.cancelRefetch ?? true,
    };
    const promises = notifyManager.batch(() =>
      this.#queryCache
        .findAll(filters)
        .filter((query) => !query.isDisabled() && !query.isStatic())
        .map((query) => {
          let promise = query.fetch(void 0, fetchOptions);
          if (!fetchOptions.throwOnError) promise = promise.catch(noop);
          return query.state.fetchStatus === "paused" ? Promise.resolve() : promise;
        }),
    );
    return Promise.all(promises).then(noop);
  }
  fetchQuery(options) {
    const defaultedOptions = this.defaultQueryOptions(options);
    if (defaultedOptions.retry === void 0) defaultedOptions.retry = false;
    const query = this.#queryCache.build(this, defaultedOptions);
    return query.isStaleByTime(resolveStaleTime(defaultedOptions.staleTime, query))
      ? query.fetch(defaultedOptions)
      : Promise.resolve(query.state.data);
  }
  prefetchQuery(options) {
    return this.fetchQuery(options).then(noop).catch(noop);
  }
  fetchInfiniteQuery(options) {
    options.behavior = infiniteQueryBehavior(options.pages);
    return this.fetchQuery(options);
  }
  prefetchInfiniteQuery(options) {
    return this.fetchInfiniteQuery(options).then(noop).catch(noop);
  }
  ensureInfiniteQueryData(options) {
    options.behavior = infiniteQueryBehavior(options.pages);
    return this.ensureQueryData(options);
  }
  resumePausedMutations() {
    if (onlineManager.isOnline()) return this.#mutationCache.resumePausedMutations();
    return Promise.resolve();
  }
  getQueryCache() {
    return this.#queryCache;
  }
  getMutationCache() {
    return this.#mutationCache;
  }
  getDefaultOptions() {
    return this.#defaultOptions;
  }
  setDefaultOptions(options) {
    this.#defaultOptions = options;
  }
  setQueryDefaults(queryKey, options) {
    this.#queryDefaults.set(hashKey(queryKey), {
      queryKey,
      defaultOptions: options,
    });
  }
  getQueryDefaults(queryKey) {
    const defaults = [...this.#queryDefaults.values()];
    const result = {};
    defaults.forEach((queryDefault) => {
      if (partialMatchKey(queryKey, queryDefault.queryKey))
        Object.assign(result, queryDefault.defaultOptions);
    });
    return result;
  }
  setMutationDefaults(mutationKey, options) {
    this.#mutationDefaults.set(hashKey(mutationKey), {
      mutationKey,
      defaultOptions: options,
    });
  }
  getMutationDefaults(mutationKey) {
    const defaults = [...this.#mutationDefaults.values()];
    const result = {};
    defaults.forEach((queryDefault) => {
      if (partialMatchKey(mutationKey, queryDefault.mutationKey))
        Object.assign(result, queryDefault.defaultOptions);
    });
    return result;
  }
  defaultQueryOptions(options) {
    if (options._defaulted) return options;
    const defaultedOptions = {
      ...this.#defaultOptions.queries,
      ...this.getQueryDefaults(options.queryKey),
      ...options,
      _defaulted: true,
    };
    if (!defaultedOptions.queryHash)
      defaultedOptions.queryHash = hashQueryKeyByOptions(
        defaultedOptions.queryKey,
        defaultedOptions,
      );
    if (defaultedOptions.refetchOnReconnect === void 0)
      defaultedOptions.refetchOnReconnect = defaultedOptions.networkMode !== "always";
    if (defaultedOptions.throwOnError === void 0)
      defaultedOptions.throwOnError = !!defaultedOptions.suspense;
    if (!defaultedOptions.networkMode && defaultedOptions.persister)
      defaultedOptions.networkMode = "offlineFirst";
    if (defaultedOptions.queryFn === skipToken) defaultedOptions.enabled = false;
    return defaultedOptions;
  }
  defaultMutationOptions(options) {
    if (options?._defaulted) return options;
    return {
      ...this.#defaultOptions.mutations,
      ...(options?.mutationKey && this.getMutationDefaults(options.mutationKey)),
      ...options,
      _defaulted: true,
    };
  }
  clear() {
    this.#queryCache.clear();
    this.#mutationCache.clear();
  }
};
//#endregion
//#region src/routes/__root.tsx
var queryClient = new QueryClient();
var Route$7 = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      { title: "oRPC + TanStack Start on CF Workers" },
    ],
  }),
  component: () =>
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(QueryClientProvider, {
      client: queryClient,
      children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(RootDocument, {
        children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Outlet, {}),
      }),
    }),
});
function RootDocument({ children }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("html", {
    lang: "en",
    children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("head", {
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(HeadContent, {}),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", {
            dangerouslySetInnerHTML: {
              __html: `
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; }
          nav { padding: 0.75rem 1.5rem; border-bottom: 1px solid #222; display: flex; gap: 1rem; align-items: center; }
          nav a { color: #60a5fa; text-decoration: none; font-size: 0.9rem; }
          nav a:hover { text-decoration: underline; }
          nav a[data-status="active"] { color: #f59e0b; font-weight: bold; }
          main { padding: 2rem; max-width: 700px; margin: 0 auto; }
          h1 { font-size: 1.4rem; margin-bottom: 1rem; }
          p { line-height: 1.6; color: #aaa; margin-bottom: 1rem; }
          code { color: #f59e0b; font-size: 0.85em; }
          button { background: #1a1a1a; color: #e0e0e0; border: 1px solid #333; padding: 0.4rem 0.8rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
          button:hover { border-color: #555; }
          button:disabled { opacity: 0.5; cursor: default; }
          .btn-primary { background: #1e3a5f; border-color: #2563eb; color: #93c5fd; }
          .btn-danger { background: #7f1d1d; border-color: #991b1b; color: #fca5a5; }
          pre { background: #111; border: 1px solid #222; border-radius: 8px; padding: 1rem; font-size: 0.8rem; overflow: auto; color: #4ade80; line-height: 1.6; }
          input[type="text"], input[type="number"] { background: #1a1a1a; color: #e0e0e0; border: 1px solid #333; padding: 0.4rem 0.6rem; border-radius: 6px; font-size: 0.85rem; outline: none; }
          input:focus { border-color: #60a5fa; }
          .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; background: #166534; color: #4ade80; }
          .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 0.75rem 1rem; }
          .card:hover { border-color: #444; }
        `,
            },
          }),
        ],
      }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("body", {
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("nav", {
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", {
                style: {
                  color: "#fff",
                  fontSize: "0.95rem",
                },
                children: "Facet App",
              }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
                to: "/",
                children: "Home",
              }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
                to: "/things",
                children: "Things",
              }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
                to: "/stream",
                children: "Stream",
              }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
                to: "/terminal",
                children: "Terminal",
              }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
                href: "/api/docs",
                target: "_blank",
                style: { color: "#888" },
                children: "API Docs",
              }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
                className: "badge",
                children: "DO Facet",
              }),
            ],
          }),
          children,
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Scripts, {}),
        ],
      }),
    ],
  });
}
//#endregion
//#region src/routes/things.tsx
var $$splitComponentImporter$2 = () => import("./things-CHZFjpyD.js");
var Route$6 = createFileRoute("/things")({
  component: lazyRouteComponent($$splitComponentImporter$2, "component"),
});
//#endregion
//#region src/routes/terminal.tsx
var $$splitComponentImporter$1 = () => import("./terminal-CoLq5GJP.js");
var Route$5 = createFileRoute("/terminal")({
  component: lazyRouteComponent($$splitComponentImporter$1, "component"),
});
//#endregion
//#region src/routes/stream.tsx
var $$splitComponentImporter = () => import("./stream-Diukj_5s.js");
var Route$4 = createFileRoute("/stream")({
  component: lazyRouteComponent($$splitComponentImporter, "component"),
});
//#endregion
//#region node_modules/@orpc/server/dist/shared/server.DZ5BIITo.mjs
function resolveFriendlyStandardHandleOptions(options) {
  return {
    ...options,
    context: options.context ?? {},
  };
}
//#endregion
//#region node_modules/@orpc/server/dist/shared/server.UVMTOWrk.mjs
function createServerPeerHandleRequestFn(handler, options) {
  return async (request) => {
    const { response } = await handler.handle(
      {
        ...request,
        body: () => Promise.resolve(request.body),
      },
      resolveFriendlyStandardHandleOptions(options),
    );
    return (
      response ?? {
        status: 404,
        headers: {},
        body: "No procedure matched",
      }
    );
  };
}
//#endregion
//#region node_modules/@orpc/server/dist/shared/server.BOmqcs4W.mjs
var LAZY_SYMBOL = Symbol("ORPC_LAZY_SYMBOL");
function lazy(loader, meta = {}) {
  return {
    [LAZY_SYMBOL]: {
      loader,
      meta,
    },
  };
}
function isLazy(item) {
  return (
    (typeof item === "object" || typeof item === "function") && item !== null && LAZY_SYMBOL in item
  );
}
function getLazyMeta(lazied) {
  return lazied[LAZY_SYMBOL].meta;
}
function unlazy(lazied) {
  return isLazy(lazied) ? lazied[LAZY_SYMBOL].loader() : Promise.resolve({ default: lazied });
}
function isStartWithMiddlewares(middlewares, compare) {
  if (compare.length > middlewares.length) return false;
  for (let i = 0; i < middlewares.length; i++) {
    if (compare[i] === void 0) return true;
    if (middlewares[i] !== compare[i]) return false;
  }
  return true;
}
function mergeMiddlewares(first, second, options) {
  if (options.dedupeLeading && isStartWithMiddlewares(second, first)) return second;
  return [...first, ...second];
}
function addMiddleware(middlewares, addition) {
  return [...middlewares, addition];
}
var Procedure = class {
  /**
   * This property holds the defined options.
   */
  "~orpc";
  constructor(def) {
    this["~orpc"] = def;
  }
};
function isProcedure(item) {
  if (item instanceof Procedure) return true;
  return (
    isContractProcedure(item) &&
    "middlewares" in item["~orpc"] &&
    "inputValidationIndex" in item["~orpc"] &&
    "outputValidationIndex" in item["~orpc"] &&
    "handler" in item["~orpc"]
  );
}
function mergeCurrentContext(context, other) {
  return {
    ...context,
    ...other,
  };
}
function createORPCErrorConstructorMap(errors) {
  return new Proxy(errors, {
    get(target, code) {
      if (typeof code !== "string") return Reflect.get(target, code);
      const item = (...rest) => {
        const options = resolveMaybeOptionalOptions(rest);
        const config = errors[code];
        return new ORPCError(code, {
          defined: Boolean(config),
          status: config?.status,
          message: options.message ?? config?.message,
          data: options.data,
          cause: options.cause,
        });
      };
      return item;
    },
  });
}
function middlewareOutputFn(output) {
  return {
    output,
    context: {},
  };
}
function createProcedureClient(lazyableProcedure, ...rest) {
  const options = resolveMaybeOptionalOptions(rest);
  return async (...[input, callerOptions]) => {
    const path = toArray(options.path);
    const { default: procedure } = await unlazy(lazyableProcedure);
    const clientContext = callerOptions?.context ?? {};
    const context = await value(options.context ?? {}, clientContext);
    const errors = createORPCErrorConstructorMap(procedure["~orpc"].errorMap);
    const validateError = async (e) => {
      if (e instanceof ORPCError) return await validateORPCError(procedure["~orpc"].errorMap, e);
      return e;
    };
    try {
      const output = await runWithSpan(
        {
          name: "call_procedure",
          signal: callerOptions?.signal,
        },
        (span) => {
          span?.setAttribute("procedure.path", [...path]);
          return intercept(
            toArray(options.interceptors),
            {
              context,
              input,
              errors,
              path,
              procedure,
              signal: callerOptions?.signal,
              lastEventId: callerOptions?.lastEventId,
            },
            (interceptorOptions) =>
              executeProcedureInternal(interceptorOptions.procedure, interceptorOptions),
          );
        },
      );
      if (isAsyncIteratorObject(output)) {
        if (output instanceof HibernationEventIterator) return output;
        return overlayProxy(
          output,
          mapEventIterator(
            asyncIteratorWithSpan(
              {
                name: "consume_event_iterator_output",
                signal: callerOptions?.signal,
              },
              output,
            ),
            {
              value: (v) => v,
              error: (e) => validateError(e),
            },
          ),
        );
      }
      return output;
    } catch (e) {
      throw await validateError(e);
    }
  };
}
async function validateInput(procedure, input) {
  const schema = procedure["~orpc"].inputSchema;
  if (!schema) return input;
  return runWithSpan({ name: "validate_input" }, async () => {
    const result = await schema["~standard"].validate(input);
    if (result.issues)
      throw new ORPCError("BAD_REQUEST", {
        message: "Input validation failed",
        data: { issues: result.issues },
        cause: new ValidationError({
          message: "Input validation failed",
          issues: result.issues,
          data: input,
        }),
      });
    return result.value;
  });
}
async function validateOutput(procedure, output) {
  const schema = procedure["~orpc"].outputSchema;
  if (!schema) return output;
  return runWithSpan({ name: "validate_output" }, async () => {
    const result = await schema["~standard"].validate(output);
    if (result.issues)
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "Output validation failed",
        cause: new ValidationError({
          message: "Output validation failed",
          issues: result.issues,
          data: output,
        }),
      });
    return result.value;
  });
}
async function executeProcedureInternal(procedure, options) {
  const middlewares = procedure["~orpc"].middlewares;
  const inputValidationIndex = Math.min(
    Math.max(0, procedure["~orpc"].inputValidationIndex),
    middlewares.length,
  );
  const outputValidationIndex = Math.min(
    Math.max(0, procedure["~orpc"].outputValidationIndex),
    middlewares.length,
  );
  const next = async (index, context, input) => {
    let currentInput = input;
    if (index === inputValidationIndex) currentInput = await validateInput(procedure, currentInput);
    const mid = middlewares[index];
    const output = mid
      ? await runWithSpan(
          {
            name: `middleware.${mid.name}`,
            signal: options.signal,
          },
          async (span) => {
            span?.setAttribute("middleware.index", index);
            span?.setAttribute("middleware.name", mid.name);
            return (
              await mid(
                {
                  ...options,
                  context,
                  next: async (...[nextOptions]) => {
                    const nextContext = nextOptions?.context ?? {};
                    return {
                      output: await next(
                        index + 1,
                        mergeCurrentContext(context, nextContext),
                        currentInput,
                      ),
                      context: nextContext,
                    };
                  },
                },
                currentInput,
                middlewareOutputFn,
              )
            ).output;
          },
        )
      : await runWithSpan(
          {
            name: "handler",
            signal: options.signal,
          },
          () =>
            procedure["~orpc"].handler({
              ...options,
              context,
              input: currentInput,
            }),
        );
    if (index === outputValidationIndex) return await validateOutput(procedure, output);
    return output;
  };
  return next(0, options.context, options.input);
}
var HIDDEN_ROUTER_CONTRACT_SYMBOL = Symbol("ORPC_HIDDEN_ROUTER_CONTRACT");
function setHiddenRouterContract(router, contract) {
  return new Proxy(router, {
    get(target, key) {
      if (key === HIDDEN_ROUTER_CONTRACT_SYMBOL) return contract;
      return Reflect.get(target, key);
    },
  });
}
function getHiddenRouterContract(router) {
  return router[HIDDEN_ROUTER_CONTRACT_SYMBOL];
}
function getRouter$1(router, path) {
  let current = router;
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    if (!current) return;
    if (isProcedure(current)) return;
    if (typeof current !== "object") return;
    if (!isLazy(current)) {
      current = current[segment];
      continue;
    }
    const lazied = current;
    const rest = path.slice(i);
    return lazy(async () => {
      return unlazy(getRouter$1((await unlazy(lazied)).default, rest));
    }, getLazyMeta(lazied));
  }
  return current;
}
function createAccessibleLazyRouter(lazied) {
  return new Proxy(lazied, {
    get(target, key) {
      if (typeof key !== "string") return Reflect.get(target, key);
      return createAccessibleLazyRouter(getRouter$1(lazied, [key]));
    },
  });
}
function enhanceRouter(router, options) {
  if (isLazy(router)) {
    const laziedMeta = getLazyMeta(router);
    const enhancedPrefix = laziedMeta?.prefix
      ? mergePrefix(options.prefix, laziedMeta?.prefix)
      : options.prefix;
    return createAccessibleLazyRouter(
      lazy(
        async () => {
          const { default: unlaziedRouter } = await unlazy(router);
          return unlazy(enhanceRouter(unlaziedRouter, options));
        },
        {
          ...laziedMeta,
          prefix: enhancedPrefix,
        },
      ),
    );
  }
  if (isProcedure(router)) {
    const newMiddlewares = mergeMiddlewares(options.middlewares, router["~orpc"].middlewares, {
      dedupeLeading: options.dedupeLeadingMiddlewares,
    });
    const newMiddlewareAdded = newMiddlewares.length - router["~orpc"].middlewares.length;
    return new Procedure({
      ...router["~orpc"],
      route: enhanceRoute(router["~orpc"].route, options),
      errorMap: mergeErrorMap(options.errorMap, router["~orpc"].errorMap),
      middlewares: newMiddlewares,
      inputValidationIndex: router["~orpc"].inputValidationIndex + newMiddlewareAdded,
      outputValidationIndex: router["~orpc"].outputValidationIndex + newMiddlewareAdded,
    });
  }
  if (typeof router !== "object" || router === null) return router;
  const enhanced = {};
  for (const key in router) enhanced[key] = enhanceRouter(router[key], options);
  return enhanced;
}
function traverseContractProcedures(options, callback, lazyOptions = []) {
  if (typeof options.router !== "object" || options.router === null) return lazyOptions;
  let currentRouter = options.router;
  const hiddenContract = getHiddenRouterContract(options.router);
  if (hiddenContract !== void 0) currentRouter = hiddenContract;
  if (isLazy(currentRouter))
    lazyOptions.push({
      router: currentRouter,
      path: options.path,
    });
  else if (isContractProcedure(currentRouter))
    callback({
      contract: currentRouter,
      path: options.path,
    });
  else if (typeof currentRouter === "object" && currentRouter !== null)
    for (const key in currentRouter)
      traverseContractProcedures(
        {
          router: currentRouter[key],
          path: [...options.path, key],
        },
        callback,
        lazyOptions,
      );
  return lazyOptions;
}
async function resolveContractProcedures(options, callback) {
  const pending = [options];
  for (const options2 of pending) {
    const lazyOptions = traverseContractProcedures(options2, callback);
    for (const options3 of lazyOptions) {
      const { default: router } = await unlazy(options3.router);
      pending.push({
        router,
        path: options3.path,
      });
    }
  }
}
function createContractedProcedure(procedure, contract) {
  return new Procedure({
    ...procedure["~orpc"],
    errorMap: contract["~orpc"].errorMap,
    route: contract["~orpc"].route,
    meta: contract["~orpc"].meta,
  });
}
//#endregion
//#region node_modules/@orpc/server/dist/shared/server.Dz5G6M6M.mjs
var CompositeStandardHandlerPlugin = class {
  plugins;
  constructor(plugins = []) {
    this.plugins = [...plugins].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
  init(options, router) {
    for (const plugin of this.plugins) plugin.init?.(options, router);
  }
};
var StandardHandler = class {
  constructor(router, matcher, codec, options) {
    this.matcher = matcher;
    this.codec = codec;
    new CompositeStandardHandlerPlugin(options.plugins).init(options, router);
    this.interceptors = toArray(options.interceptors);
    this.clientInterceptors = toArray(options.clientInterceptors);
    this.rootInterceptors = toArray(options.rootInterceptors);
    this.matcher.init(router);
  }
  interceptors;
  clientInterceptors;
  rootInterceptors;
  async handle(request, options) {
    const prefix = options.prefix?.replace(/\/$/, "") || void 0;
    if (prefix && !request.url.pathname.startsWith(`${prefix}/`) && request.url.pathname !== prefix)
      return {
        matched: false,
        response: void 0,
      };
    return intercept(
      this.rootInterceptors,
      {
        ...options,
        request,
        prefix,
      },
      async (interceptorOptions) => {
        return runWithSpan({ name: `${request.method} ${request.url.pathname}` }, async (span) => {
          let step;
          try {
            return await intercept(
              this.interceptors,
              interceptorOptions,
              async ({ request: request2, context, prefix: prefix2 }) => {
                const method = request2.method;
                const url = request2.url;
                const pathname = prefix2 ? url.pathname.replace(prefix2, "") : url.pathname;
                const match = await runWithSpan({ name: "find_procedure" }, () =>
                  this.matcher.match(method, `/${pathname.replace(/^\/|\/$/g, "")}`),
                );
                if (!match)
                  return {
                    matched: false,
                    response: void 0,
                  };
                span?.updateName(`${ORPC_NAME}.${match.path.join("/")}`);
                span?.setAttribute("rpc.system", ORPC_NAME);
                span?.setAttribute("rpc.method", match.path.join("."));
                step = "decode_input";
                let input = await runWithSpan({ name: "decode_input" }, () =>
                  this.codec.decode(request2, match.params, match.procedure),
                );
                step = void 0;
                if (isAsyncIteratorObject(input))
                  input = asyncIteratorWithSpan(
                    {
                      name: "consume_event_iterator_input",
                      signal: request2.signal,
                    },
                    input,
                  );
                const client = createProcedureClient(match.procedure, {
                  context,
                  path: match.path,
                  interceptors: this.clientInterceptors,
                });
                step = "call_procedure";
                const output = await client(input, {
                  signal: request2.signal,
                  lastEventId: flattenHeader(request2.headers["last-event-id"]),
                });
                step = void 0;
                return {
                  matched: true,
                  response: this.codec.encode(output, match.procedure),
                };
              },
            );
          } catch (e) {
            if (step !== "call_procedure") setSpanError(span, e);
            const error =
              step === "decode_input" && !(e instanceof ORPCError)
                ? new ORPCError("BAD_REQUEST", {
                    message: `Malformed request. Ensure the request body is properly formatted and the 'Content-Type' header is set correctly.`,
                    cause: e,
                  })
                : toORPCError(e);
            return {
              matched: true,
              response: this.codec.encodeError(error),
            };
          }
        });
      },
    );
  }
};
var StandardRPCCodec = class {
  constructor(serializer) {
    this.serializer = serializer;
  }
  async decode(request, _params, _procedure) {
    const serialized =
      request.method === "GET"
        ? parseEmptyableJSON(request.url.searchParams.getAll("data").at(-1))
        : await request.body();
    return this.serializer.deserialize(serialized);
  }
  encode(output, _procedure) {
    if (output instanceof ReadableStream)
      return {
        status: 200,
        headers: {},
        body: output,
      };
    return {
      status: 200,
      headers: {},
      body: this.serializer.serialize(output),
    };
  }
  encodeError(error) {
    return {
      status: error.status,
      headers: {},
      body: this.serializer.serialize(error.toJSON()),
    };
  }
};
var StandardRPCMatcher = class {
  filter;
  tree = new NullProtoObj$1();
  pendingRouters = [];
  constructor(options = {}) {
    this.filter = options.filter ?? true;
  }
  init(router, path = []) {
    const laziedOptions = traverseContractProcedures(
      {
        router,
        path,
      },
      (traverseOptions) => {
        if (!value(this.filter, traverseOptions)) return;
        const { path: path2, contract } = traverseOptions;
        const httpPath = toHttpPath(path2);
        if (isProcedure(contract))
          this.tree[httpPath] = {
            path: path2,
            contract,
            procedure: contract,
            router,
          };
        else
          this.tree[httpPath] = {
            path: path2,
            contract,
            procedure: void 0,
            router,
          };
      },
    );
    this.pendingRouters.push(
      ...laziedOptions.map((option) => ({
        ...option,
        httpPathPrefix: toHttpPath(option.path),
      })),
    );
  }
  async match(_method, pathname) {
    if (this.pendingRouters.length) {
      const newPendingRouters = [];
      for (const pendingRouter of this.pendingRouters)
        if (pathname.startsWith(pendingRouter.httpPathPrefix)) {
          const { default: router } = await unlazy(pendingRouter.router);
          this.init(router, pendingRouter.path);
        } else newPendingRouters.push(pendingRouter);
      this.pendingRouters = newPendingRouters;
    }
    const match = this.tree[pathname];
    if (!match) return;
    if (!match.procedure) {
      const { default: maybeProcedure } = await unlazy(getRouter$1(match.router, match.path));
      if (!isProcedure(maybeProcedure))
        throw new Error(`
          [Contract-First] Missing or invalid implementation for procedure at path: ${toHttpPath(match.path)}.
          Ensure that the procedure is correctly defined and matches the expected contract.
        `);
      match.procedure = createContractedProcedure(maybeProcedure, match.contract);
    }
    return {
      path: match.path,
      procedure: match.procedure,
    };
  }
};
var StandardRPCHandler = class extends StandardHandler {
  constructor(router, options = {}) {
    const serializer = new StandardRPCSerializer(new StandardRPCJsonSerializer(options));
    const matcher = new StandardRPCMatcher(options);
    const codec = new StandardRPCCodec(serializer);
    super(router, matcher, codec, options);
  }
};
//#endregion
//#region node_modules/@orpc/server/dist/adapters/crossws/index.mjs
var experimental_CrosswsHandler = class {
  constructor(standardHandler) {
    this.standardHandler = standardHandler;
  }
  peers = /* @__PURE__ */ new WeakMap();
  async message(ws, message, ...rest) {
    let peer = this.peers.get(ws);
    if (!peer)
      this.peers.set(
        ws,
        (peer = new ServerPeer((message2) => {
          ws.send(message2);
        })),
      );
    const encodedMessage =
      typeof message.rawData === "string" ? message.rawData : message.uint8Array();
    await peer.message(
      encodedMessage,
      createServerPeerHandleRequestFn(this.standardHandler, resolveMaybeOptionalOptions(rest)),
    );
  }
  close(ws) {
    const server = this.peers.get(ws);
    if (server) {
      server.close();
      this.peers.delete(ws);
    }
  }
};
var experimental_RPCHandler = class extends experimental_CrosswsHandler {
  constructor(router, options = {}) {
    super(new StandardRPCHandler(router, options));
  }
};
//#endregion
//#region node_modules/@orpc/server/dist/index.mjs
var DEFAULT_CONFIG = {
  initialInputValidationIndex: 0,
  initialOutputValidationIndex: 0,
  dedupeLeadingMiddlewares: true,
};
function fallbackConfig(key, value) {
  if (value === void 0) return DEFAULT_CONFIG[key];
  return value;
}
function decorateMiddleware(middleware) {
  const decorated = (...args) => middleware(...args);
  decorated.mapInput = (mapInput) => {
    return decorateMiddleware((options, input, ...rest) =>
      middleware(options, mapInput(input), ...rest),
    );
  };
  decorated.concat = (concatMiddleware, mapInput) => {
    const mapped = mapInput
      ? decorateMiddleware(concatMiddleware).mapInput(mapInput)
      : concatMiddleware;
    return decorateMiddleware((options, input, output, ...rest) => {
      return middleware(
        {
          ...options,
          next: (...[nextOptions1]) =>
            mapped(
              {
                ...options,
                context: {
                  ...options.context,
                  ...nextOptions1?.context,
                },
                next: (...[nextOptions2]) =>
                  options.next({
                    context: {
                      ...nextOptions1?.context,
                      ...nextOptions2?.context,
                    },
                  }),
              },
              input,
              output,
              ...rest,
            ),
        },
        input,
        output,
        ...rest,
      );
    });
  };
  return decorated;
}
function createActionableClient(client) {
  const action = async (input) => {
    try {
      return [null, await client(input)];
    } catch (error) {
      if (
        error instanceof Error &&
        "digest" in error &&
        typeof error.digest === "string" &&
        error.digest.startsWith("NEXT_")
      )
        throw error;
      if (
        (error instanceof Response && "options" in error && isObject(error.options)) ||
        (isObject(error) && error.isNotFound === true)
      )
        throw error;
      return [toORPCError(error).toJSON(), void 0];
    }
  };
  return action;
}
var DecoratedProcedure = class DecoratedProcedure extends Procedure {
  /**
   * Adds type-safe custom errors.
   * The provided errors are spared-merged with any existing errors.
   *
   * @see {@link https://orpc.dev/docs/error-handling#type%E2%80%90safe-error-handling Type-Safe Error Handling Docs}
   */
  errors(errors) {
    return new DecoratedProcedure({
      ...this["~orpc"],
      errorMap: mergeErrorMap(this["~orpc"].errorMap, errors),
    });
  }
  /**
   * Sets or updates the metadata.
   * The provided metadata is spared-merged with any existing metadata.
   *
   * @see {@link https://orpc.dev/docs/metadata Metadata Docs}
   */
  meta(meta) {
    return new DecoratedProcedure({
      ...this["~orpc"],
      meta: mergeMeta(this["~orpc"].meta, meta),
    });
  }
  /**
   * Sets or updates the route definition.
   * The provided route is spared-merged with any existing route.
   * This option is typically relevant when integrating with OpenAPI.
   *
   * @see {@link https://orpc.dev/docs/openapi/routing OpenAPI Routing Docs}
   * @see {@link https://orpc.dev/docs/openapi/input-output-structure OpenAPI Input/Output Structure Docs}
   */
  route(route) {
    return new DecoratedProcedure({
      ...this["~orpc"],
      route: mergeRoute(this["~orpc"].route, route),
    });
  }
  use(middleware, mapInput) {
    const mapped = mapInput ? decorateMiddleware(middleware).mapInput(mapInput) : middleware;
    return new DecoratedProcedure({
      ...this["~orpc"],
      middlewares: addMiddleware(this["~orpc"].middlewares, mapped),
    });
  }
  /**
   * Make this procedure callable (works like a function while still being a procedure).
   *
   * @see {@link https://orpc.dev/docs/client/server-side Server-side Client Docs}
   */
  callable(...rest) {
    const client = createProcedureClient(this, ...rest);
    return new Proxy(client, {
      get: (target, key) => {
        return Reflect.has(this, key) ? Reflect.get(this, key) : Reflect.get(target, key);
      },
      has: (target, key) => {
        return Reflect.has(this, key) || Reflect.has(target, key);
      },
    });
  }
  /**
   * Make this procedure compatible with server action.
   *
   * @see {@link https://orpc.dev/docs/server-action Server Action Docs}
   */
  actionable(...rest) {
    const action = createActionableClient(createProcedureClient(this, ...rest));
    return new Proxy(action, {
      get: (target, key) => {
        return Reflect.has(this, key) ? Reflect.get(this, key) : Reflect.get(target, key);
      },
      has: (target, key) => {
        return Reflect.has(this, key) || Reflect.has(target, key);
      },
    });
  }
};
var Builder = class Builder {
  /**
   * This property holds the defined options.
   */
  "~orpc";
  constructor(def) {
    this["~orpc"] = def;
  }
  /**
   * Sets or overrides the config.
   *
   * @see {@link https://orpc.dev/docs/client/server-side#middlewares-order Middlewares Order Docs}
   * @see {@link https://orpc.dev/docs/best-practices/dedupe-middleware#configuration Dedupe Middleware Docs}
   */
  $config(config) {
    const inputValidationCount =
      this["~orpc"].inputValidationIndex -
      fallbackConfig(
        "initialInputValidationIndex",
        this["~orpc"].config.initialInputValidationIndex,
      );
    const outputValidationCount =
      this["~orpc"].outputValidationIndex -
      fallbackConfig(
        "initialOutputValidationIndex",
        this["~orpc"].config.initialOutputValidationIndex,
      );
    return new Builder({
      ...this["~orpc"],
      config,
      dedupeLeadingMiddlewares: fallbackConfig(
        "dedupeLeadingMiddlewares",
        config.dedupeLeadingMiddlewares,
      ),
      inputValidationIndex:
        fallbackConfig("initialInputValidationIndex", config.initialInputValidationIndex) +
        inputValidationCount,
      outputValidationIndex:
        fallbackConfig("initialOutputValidationIndex", config.initialOutputValidationIndex) +
        outputValidationCount,
    });
  }
  /**
   * Set or override the initial context.
   *
   * @see {@link https://orpc.dev/docs/context Context Docs}
   */
  $context() {
    return new Builder({
      ...this["~orpc"],
      middlewares: [],
      inputValidationIndex: fallbackConfig(
        "initialInputValidationIndex",
        this["~orpc"].config.initialInputValidationIndex,
      ),
      outputValidationIndex: fallbackConfig(
        "initialOutputValidationIndex",
        this["~orpc"].config.initialOutputValidationIndex,
      ),
    });
  }
  /**
   * Sets or overrides the initial meta.
   *
   * @see {@link https://orpc.dev/docs/metadata Metadata Docs}
   */
  $meta(initialMeta) {
    return new Builder({
      ...this["~orpc"],
      meta: initialMeta,
    });
  }
  /**
   * Sets or overrides the initial route.
   * This option is typically relevant when integrating with OpenAPI.
   *
   * @see {@link https://orpc.dev/docs/openapi/routing OpenAPI Routing Docs}
   * @see {@link https://orpc.dev/docs/openapi/input-output-structure OpenAPI Input/Output Structure Docs}
   */
  $route(initialRoute) {
    return new Builder({
      ...this["~orpc"],
      route: initialRoute,
    });
  }
  /**
   * Sets or overrides the initial input schema.
   *
   * @see {@link https://orpc.dev/docs/procedure#initial-configuration Initial Procedure Configuration Docs}
   */
  $input(initialInputSchema) {
    return new Builder({
      ...this["~orpc"],
      inputSchema: initialInputSchema,
    });
  }
  /**
   * Creates a middleware.
   *
   * @see {@link https://orpc.dev/docs/middleware Middleware Docs}
   */
  middleware(middleware) {
    return decorateMiddleware(middleware);
  }
  /**
   * Adds type-safe custom errors.
   * The provided errors are spared-merged with any existing errors.
   *
   * @see {@link https://orpc.dev/docs/error-handling#type%E2%80%90safe-error-handling Type-Safe Error Handling Docs}
   */
  errors(errors) {
    return new Builder({
      ...this["~orpc"],
      errorMap: mergeErrorMap(this["~orpc"].errorMap, errors),
    });
  }
  use(middleware, mapInput) {
    const mapped = mapInput ? decorateMiddleware(middleware).mapInput(mapInput) : middleware;
    return new Builder({
      ...this["~orpc"],
      middlewares: addMiddleware(this["~orpc"].middlewares, mapped),
    });
  }
  /**
   * Sets or updates the metadata.
   * The provided metadata is spared-merged with any existing metadata.
   *
   * @see {@link https://orpc.dev/docs/metadata Metadata Docs}
   */
  meta(meta) {
    return new Builder({
      ...this["~orpc"],
      meta: mergeMeta(this["~orpc"].meta, meta),
    });
  }
  /**
   * Sets or updates the route definition.
   * The provided route is spared-merged with any existing route.
   * This option is typically relevant when integrating with OpenAPI.
   *
   * @see {@link https://orpc.dev/docs/openapi/routing OpenAPI Routing Docs}
   * @see {@link https://orpc.dev/docs/openapi/input-output-structure OpenAPI Input/Output Structure Docs}
   */
  route(route) {
    return new Builder({
      ...this["~orpc"],
      route: mergeRoute(this["~orpc"].route, route),
    });
  }
  /**
   * Defines the input validation schema.
   *
   * @see {@link https://orpc.dev/docs/procedure#input-output-validation Input Validation Docs}
   */
  input(schema) {
    return new Builder({
      ...this["~orpc"],
      inputSchema: schema,
      inputValidationIndex:
        fallbackConfig(
          "initialInputValidationIndex",
          this["~orpc"].config.initialInputValidationIndex,
        ) + this["~orpc"].middlewares.length,
    });
  }
  /**
   * Defines the output validation schema.
   *
   * @see {@link https://orpc.dev/docs/procedure#input-output-validation Output Validation Docs}
   */
  output(schema) {
    return new Builder({
      ...this["~orpc"],
      outputSchema: schema,
      outputValidationIndex:
        fallbackConfig(
          "initialOutputValidationIndex",
          this["~orpc"].config.initialOutputValidationIndex,
        ) + this["~orpc"].middlewares.length,
    });
  }
  /**
   * Defines the handler of the procedure.
   *
   * @see {@link https://orpc.dev/docs/procedure Procedure Docs}
   */
  handler(handler) {
    return new DecoratedProcedure({
      ...this["~orpc"],
      handler,
    });
  }
  /**
   * Prefixes all procedures in the router.
   * The provided prefix is post-appended to any existing router prefix.
   *
   * @note This option does not affect procedures that do not define a path in their route definition.
   *
   * @see {@link https://orpc.dev/docs/openapi/routing#route-prefixes OpenAPI Route Prefixes Docs}
   */
  prefix(prefix) {
    return new Builder({
      ...this["~orpc"],
      prefix: mergePrefix(this["~orpc"].prefix, prefix),
    });
  }
  /**
   * Adds tags to all procedures in the router.
   * This helpful when you want to group procedures together in the OpenAPI specification.
   *
   * @see {@link https://orpc.dev/docs/openapi/openapi-specification#operation-metadata OpenAPI Operation Metadata Docs}
   */
  tag(...tags) {
    return new Builder({
      ...this["~orpc"],
      tags: mergeTags(this["~orpc"].tags, tags),
    });
  }
  /**
   * Applies all of the previously defined options to the specified router.
   *
   * @see {@link https://orpc.dev/docs/router#extending-router Extending Router Docs}
   */
  router(router) {
    return enhanceRouter(router, this["~orpc"]);
  }
  /**
   * Create a lazy router
   * And applies all of the previously defined options to the specified router.
   *
   * @see {@link https://orpc.dev/docs/router#extending-router Extending Router Docs}
   */
  lazy(loader) {
    return enhanceRouter(lazy(loader), this["~orpc"]);
  }
};
new Builder({
  config: {},
  route: {},
  meta: {},
  errorMap: {},
  inputValidationIndex: fallbackConfig("initialInputValidationIndex"),
  outputValidationIndex: fallbackConfig("initialOutputValidationIndex"),
  middlewares: [],
  dedupeLeadingMiddlewares: true,
});
function implementerInternal(contract, config, middlewares) {
  if (isContractProcedure(contract))
    return new Builder({
      ...contract["~orpc"],
      config,
      middlewares,
      inputValidationIndex:
        fallbackConfig("initialInputValidationIndex", config?.initialInputValidationIndex) +
        middlewares.length,
      outputValidationIndex:
        fallbackConfig("initialOutputValidationIndex", config?.initialOutputValidationIndex) +
        middlewares.length,
      dedupeLeadingMiddlewares: fallbackConfig(
        "dedupeLeadingMiddlewares",
        config.dedupeLeadingMiddlewares,
      ),
    });
  return new Proxy(contract, {
    get: (target, key) => {
      if (typeof key !== "string") return Reflect.get(target, key);
      let method;
      if (key === "middleware") method = (mid) => decorateMiddleware(mid);
      else if (key === "use")
        method = (mid) => {
          return implementerInternal(contract, config, addMiddleware(middlewares, mid));
        };
      else if (key === "router")
        method = (router) => {
          return setHiddenRouterContract(
            enhanceRouter(router, {
              middlewares,
              errorMap: {},
              prefix: void 0,
              tags: void 0,
              dedupeLeadingMiddlewares: fallbackConfig(
                "dedupeLeadingMiddlewares",
                config.dedupeLeadingMiddlewares,
              ),
            }),
            contract,
          );
        };
      else if (key === "lazy")
        method = (loader) => {
          return setHiddenRouterContract(
            enhanceRouter(lazy(loader), {
              middlewares,
              errorMap: {},
              prefix: void 0,
              tags: void 0,
              dedupeLeadingMiddlewares: fallbackConfig(
                "dedupeLeadingMiddlewares",
                config.dedupeLeadingMiddlewares,
              ),
            }),
            contract,
          );
        };
      const next = getContractRouter(target, [key]);
      if (!next) return method ?? next;
      const nextImpl = implementerInternal(next, config, middlewares);
      if (method)
        return new Proxy(method, {
          get(_, key2) {
            return Reflect.get(nextImpl, key2);
          },
        });
      return nextImpl;
    },
  });
}
function implement(contract, config = {}) {
  const implInternal = implementerInternal(contract, config, []);
  const impl = new Proxy(implInternal, {
    get: (target, key) => {
      let method;
      if (key === "$context") method = () => impl;
      else if (key === "$config") method = (config2) => implement(contract, config2);
      const next = Reflect.get(target, key);
      if (!method || !next || (typeof next !== "function" && typeof next !== "object"))
        return method || next;
      return new Proxy(method, {
        get(_, key2) {
          return Reflect.get(next, key2);
        },
      });
    },
  });
  return impl;
}
//#endregion
//#region src/orpc/router.ts
var os = implement(appContract).$context();
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
var appRouter = os.router({
  ping: os.ping.handler(async () => ({
    message: "pong",
    time: /* @__PURE__ */ new Date().toISOString(),
  })),
  things: {
    list: os.things.list.handler(async ({ context }) => {
      console.log("[oRPC] things.list called");
      const [countRow] = await context.db.select({ value: sql`count(*)` }).from(thingsTable);
      return {
        items: await context.db.select().from(thingsTable).orderBy(desc(thingsTable.createdAt)),
        total: countRow?.value ?? 0,
      };
    }),
    create: os.things.create.handler(async ({ context, input }) => {
      console.log("[oRPC] things.create called:", input.name);
      const id = "thing_" + crypto.randomUUID().slice(0, 8);
      const createdAt = /* @__PURE__ */ new Date().toISOString();
      await context.db.insert(thingsTable).values({
        id,
        name: input.name,
        createdAt,
      });
      return {
        id,
        name: input.name,
        createdAt,
      };
    }),
    remove: os.things.remove.handler(async ({ context, input }) => {
      const [existing] = await context.db
        .select()
        .from(thingsTable)
        .where(eq(thingsTable.id, input.id))
        .limit(1);
      if (!existing)
        return {
          ok: true,
          id: input.id,
          deleted: false,
        };
      await context.db.delete(thingsTable).where(eq(thingsTable.id, input.id));
      return {
        ok: true,
        id: input.id,
        deleted: true,
      };
    }),
  },
  test: {
    randomLogStream: os.test.randomLogStream.handler(async function* ({ input, signal }) {
      for (let i = 0; i < input.count; i++) {
        if (signal?.aborted) return;
        const delay = randomInt(input.minDelayMs, input.maxDelayMs);
        await sleep(delay, signal);
        if (signal?.aborted) return;
        yield `${/* @__PURE__ */ new Date().toISOString()} random[${i + 1}/${input.count}] delay=${delay}ms value=${Math.random().toFixed(6)}`;
      }
    }),
  },
});
//#endregion
//#region src/orpc/ws-handler.ts
var wsRpcHandler = new experimental_RPCHandler(appRouter, {});
//#endregion
//#region src/routes/api/rpc-ws.ts
var Route$3 = createFileRoute("/api/rpc-ws")({
  server: {
    handlers: {
      GET: () =>
        new WebSocketResponse({
          message(peer, message) {
            return wsRpcHandler.message(peer, message, { context: {} });
          },
          close(peer) {
            wsRpcHandler.close(peer);
          },
          error(peer) {
            wsRpcHandler.close(peer);
          },
        }),
    },
  },
});
//#endregion
//#region src/routes/api/pty.ts
var Route$2 = createFileRoute("/api/pty")({
  server: { handlers: { GET: ({ context }) => new WebSocketResponse(context.pty()) } },
});
//#endregion
//#region node_modules/@orpc/server/dist/shared/server.TEVCLCFC.mjs
var STRICT_GET_METHOD_PLUGIN_IS_GET_METHOD_CONTEXT_SYMBOL = Symbol(
  "STRICT_GET_METHOD_PLUGIN_IS_GET_METHOD_CONTEXT",
);
var StrictGetMethodPlugin = class {
  error;
  /**
   * make sure execute before batch plugin to get real method
   */
  order = 7e6;
  constructor(options = {}) {
    this.error = options.error ?? new ORPCError("METHOD_NOT_SUPPORTED");
  }
  init(options) {
    options.rootInterceptors ??= [];
    options.clientInterceptors ??= [];
    options.rootInterceptors.unshift((options2) => {
      const isGetMethod = options2.request.method === "GET";
      return options2.next({
        ...options2,
        context: {
          ...options2.context,
          [STRICT_GET_METHOD_PLUGIN_IS_GET_METHOD_CONTEXT_SYMBOL]: isGetMethod,
        },
      });
    });
    options.clientInterceptors.unshift((options2) => {
      if (
        typeof options2.context[STRICT_GET_METHOD_PLUGIN_IS_GET_METHOD_CONTEXT_SYMBOL] !== "boolean"
      )
        throw new TypeError(
          "[StrictGetMethodPlugin] strict GET method context has been corrupted or modified by another plugin or interceptor",
        );
      const procedureMethod = fallbackContractConfig(
        "defaultMethod",
        options2.procedure["~orpc"].route.method,
      );
      if (
        options2.context[STRICT_GET_METHOD_PLUGIN_IS_GET_METHOD_CONTEXT_SYMBOL] &&
        procedureMethod !== "GET"
      )
        throw this.error;
      return options2.next();
    });
  }
};
//#endregion
//#region node_modules/@orpc/server/dist/adapters/fetch/index.mjs
var CompositeFetchHandlerPlugin = class extends CompositeStandardHandlerPlugin {
  initRuntimeAdapter(options) {
    for (const plugin of this.plugins) plugin.initRuntimeAdapter?.(options);
  }
};
var FetchHandler = class {
  constructor(standardHandler, options = {}) {
    this.standardHandler = standardHandler;
    new CompositeFetchHandlerPlugin(options.plugins).initRuntimeAdapter(options);
    this.adapterInterceptors = toArray(options.adapterInterceptors);
    this.toFetchResponseOptions = options;
  }
  toFetchResponseOptions;
  adapterInterceptors;
  async handle(request, ...rest) {
    return intercept(
      this.adapterInterceptors,
      {
        ...resolveFriendlyStandardHandleOptions(resolveMaybeOptionalOptions(rest)),
        request,
        toFetchResponseOptions: this.toFetchResponseOptions,
      },
      async ({ request: request2, toFetchResponseOptions, ...options }) => {
        const standardRequest = toStandardLazyRequest(request2);
        const result = await this.standardHandler.handle(standardRequest, options);
        if (!result.matched) return result;
        return {
          matched: true,
          response: toFetchResponse(result.response, toFetchResponseOptions),
        };
      },
    );
  }
};
var RPCHandler = class extends FetchHandler {
  constructor(router, options = {}) {
    if (options.strictGetMethodPluginEnabled ?? true) {
      options.plugins ??= [];
      options.plugins.push(new StrictGetMethodPlugin());
    }
    super(new StandardRPCHandler(router, options), options);
  }
};
//#endregion
//#region node_modules/@orpc/openapi/node_modules/rou3/dist/index.mjs
var NullProtoObj = /* @__PURE__ */ (() => {
  const e = function () {};
  return ((e.prototype = Object.create(null)), Object.freeze(e.prototype), e);
})();
/**
 * Create a new router context.
 */
function createRouter$1() {
  return {
    root: { key: "" },
    static: new NullProtoObj(),
  };
}
function splitPath(path) {
  const [_, ...s] = path.split("/");
  return s[s.length - 1] === "" ? s.slice(0, -1) : s;
}
function getMatchParams(segments, paramsMap) {
  const params = new NullProtoObj();
  for (const [index, name] of paramsMap) {
    const segment = index < 0 ? segments.slice(-(index + 1)).join("/") : segments[index];
    if (typeof name === "string") params[name] = segment;
    else {
      const match = segment.match(name);
      if (match) for (const key in match.groups) params[key] = match.groups[key];
    }
  }
  return params;
}
/**
 * Add a route to the router context.
 */
function addRoute(ctx, method = "", path, data) {
  method = method.toUpperCase();
  if (path.charCodeAt(0) !== 47) path = `/${path}`;
  path = path.replace(/\\:/g, "%3A");
  const segments = splitPath(path);
  let node = ctx.root;
  let _unnamedParamIndex = 0;
  const paramsMap = [];
  const paramsRegexp = [];
  for (let i = 0; i < segments.length; i++) {
    let segment = segments[i];
    if (segment.startsWith("**")) {
      if (!node.wildcard) node.wildcard = { key: "**" };
      node = node.wildcard;
      paramsMap.push([-(i + 1), segment.split(":")[1] || "_", segment.length === 2]);
      break;
    }
    if (segment === "*" || segment.includes(":")) {
      if (!node.param) node.param = { key: "*" };
      node = node.param;
      if (segment === "*") paramsMap.push([i, `_${_unnamedParamIndex++}`, true]);
      else if (segment.includes(":", 1)) {
        const regexp = getParamRegexp(segment);
        paramsRegexp[i] = regexp;
        node.hasRegexParam = true;
        paramsMap.push([i, regexp, false]);
      } else paramsMap.push([i, segment.slice(1), false]);
      continue;
    }
    if (segment === "\\*") segment = segments[i] = "*";
    else if (segment === "\\*\\*") segment = segments[i] = "**";
    const child = node.static?.[segment];
    if (child) node = child;
    else {
      const staticNode = { key: segment };
      if (!node.static) node.static = new NullProtoObj();
      node.static[segment] = staticNode;
      node = staticNode;
    }
  }
  const hasParams = paramsMap.length > 0;
  if (!node.methods) node.methods = new NullProtoObj();
  node.methods[method] ??= [];
  node.methods[method].push({
    data: data || null,
    paramsRegexp,
    paramsMap: hasParams ? paramsMap : void 0,
  });
  if (!hasParams) ctx.static["/" + segments.join("/")] = node;
}
function getParamRegexp(segment) {
  const regex = segment.replace(/:(\w+)/g, (_, id) => `(?<${id}>[^/]+)`).replace(/\./g, "\\.");
  return /* @__PURE__ */ new RegExp(`^${regex}$`);
}
/**
 * Find a route by path.
 */
function findRoute(ctx, method = "", path, opts) {
  if (path.charCodeAt(path.length - 1) === 47) path = path.slice(0, -1);
  const staticNode = ctx.static[path];
  if (staticNode && staticNode.methods) {
    const staticMatch = staticNode.methods[method] || staticNode.methods[""];
    if (staticMatch !== void 0) return staticMatch[0];
  }
  const segments = splitPath(path);
  const match = _lookupTree(ctx, ctx.root, method, segments, 0)?.[0];
  if (match === void 0) return;
  if (opts?.params === false) return match;
  return {
    data: match.data,
    params: match.paramsMap ? getMatchParams(segments, match.paramsMap) : void 0,
  };
}
function _lookupTree(ctx, node, method, segments, index) {
  if (index === segments.length) {
    if (node.methods) {
      const match = node.methods[method] || node.methods[""];
      if (match) return match;
    }
    if (node.param && node.param.methods) {
      const match = node.param.methods[method] || node.param.methods[""];
      if (match) {
        const pMap = match[0].paramsMap;
        if (pMap?.[pMap?.length - 1]?.[2]) return match;
      }
    }
    if (node.wildcard && node.wildcard.methods) {
      const match = node.wildcard.methods[method] || node.wildcard.methods[""];
      if (match) {
        const pMap = match[0].paramsMap;
        if (pMap?.[pMap?.length - 1]?.[2]) return match;
      }
    }
    return;
  }
  const segment = segments[index];
  if (node.static) {
    const staticChild = node.static[segment];
    if (staticChild) {
      const match = _lookupTree(ctx, staticChild, method, segments, index + 1);
      if (match) return match;
    }
  }
  if (node.param) {
    const match = _lookupTree(ctx, node.param, method, segments, index + 1);
    if (match) {
      if (node.param.hasRegexParam) {
        const exactMatch =
          match.find((m) => m.paramsRegexp[index]?.test(segment)) ||
          match.find((m) => !m.paramsRegexp[index]);
        return exactMatch ? [exactMatch] : void 0;
      }
      return match;
    }
  }
  if (node.wildcard && node.wildcard.methods)
    return node.wildcard.methods[method] || node.wildcard.methods[""];
}
//#endregion
//#region node_modules/@orpc/openapi/dist/shared/openapi.BB-W-NKv.mjs
var StandardOpenAPICodec = class {
  constructor(serializer, options = {}) {
    this.serializer = serializer;
    this.customErrorResponseBodyEncoder = options.customErrorResponseBodyEncoder;
  }
  customErrorResponseBodyEncoder;
  async decode(request, params, procedure) {
    if (
      fallbackContractConfig("defaultInputStructure", procedure["~orpc"].route.inputStructure) ===
      "compact"
    ) {
      const data =
        request.method === "GET"
          ? this.serializer.deserialize(request.url.searchParams)
          : this.serializer.deserialize(await request.body());
      if (data === void 0) return params;
      if (isObject(data))
        return {
          ...params,
          ...data,
        };
      return data;
    }
    const deserializeSearchParams = () => {
      return this.serializer.deserialize(request.url.searchParams);
    };
    return {
      params,
      get query() {
        const value = deserializeSearchParams();
        Object.defineProperty(this, "query", {
          value,
          writable: true,
        });
        return value;
      },
      set query(value) {
        Object.defineProperty(this, "query", {
          value,
          writable: true,
        });
      },
      headers: request.headers,
      body: this.serializer.deserialize(await request.body()),
    };
  }
  encode(output, procedure) {
    const successStatus = fallbackContractConfig(
      "defaultSuccessStatus",
      procedure["~orpc"].route.successStatus,
    );
    if (
      fallbackContractConfig("defaultOutputStructure", procedure["~orpc"].route.outputStructure) ===
      "compact"
    ) {
      if (output instanceof ReadableStream)
        return {
          status: successStatus,
          headers: {},
          body: output,
        };
      return {
        status: successStatus,
        headers: {},
        body: this.serializer.serialize(output),
      };
    }
    if (!this.#isDetailedOutput(output))
      throw new Error(`
        Invalid "detailed" output structure:
        \u2022 Expected an object with optional properties:
          - status (number 200-399)
          - headers (Record<string, string | string[]>)
          - body (any)
        \u2022 No extra keys allowed.

        Actual value:
          ${stringifyJSON(output)}
      `);
    if (output.body instanceof ReadableStream)
      return {
        status: output.status ?? successStatus,
        headers: output.headers ?? {},
        body: output.body,
      };
    return {
      status: output.status ?? successStatus,
      headers: output.headers ?? {},
      body: this.serializer.serialize(output.body),
    };
  }
  encodeError(error) {
    const body = this.customErrorResponseBodyEncoder?.(error) ?? error.toJSON();
    return {
      status: error.status,
      headers: {},
      body: this.serializer.serialize(body, { outputFormat: "plain" }),
    };
  }
  #isDetailedOutput(output) {
    if (!isObject(output)) return false;
    if (output.headers && !isObject(output.headers)) return false;
    if (
      output.status !== void 0 &&
      (typeof output.status !== "number" ||
        !Number.isInteger(output.status) ||
        isORPCErrorStatus(output.status))
    )
      return false;
    return true;
  }
};
function toRou3Pattern(path) {
  return standardizeHTTPPath(path)
    .replace(/\/\{\+([^}]+)\}/g, "/**:$1")
    .replace(/\/\{([^}]+)\}/g, "/:$1");
}
function decodeParams(params) {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key, tryDecodeURIComponent(value)]),
  );
}
var StandardOpenAPIMatcher = class {
  filter;
  tree = createRouter$1();
  pendingRouters = [];
  constructor(options = {}) {
    this.filter = options.filter ?? true;
  }
  init(router, path = []) {
    const laziedOptions = traverseContractProcedures(
      {
        router,
        path,
      },
      (traverseOptions) => {
        if (!value(this.filter, traverseOptions)) return;
        const { path: path2, contract } = traverseOptions;
        const method = fallbackContractConfig("defaultMethod", contract["~orpc"].route.method);
        const httpPath = toRou3Pattern(contract["~orpc"].route.path ?? toHttpPath(path2));
        if (isProcedure(contract))
          addRoute(this.tree, method, httpPath, {
            path: path2,
            contract,
            procedure: contract,
            router,
          });
        else
          addRoute(this.tree, method, httpPath, {
            path: path2,
            contract,
            procedure: void 0,
            router,
          });
      },
    );
    this.pendingRouters.push(
      ...laziedOptions.map((option) => ({
        ...option,
        httpPathPrefix: toHttpPath(option.path),
        laziedPrefix: getLazyMeta(option.router).prefix,
      })),
    );
  }
  async match(method, pathname) {
    if (this.pendingRouters.length) {
      const newPendingRouters = [];
      for (const pendingRouter of this.pendingRouters)
        if (
          !pendingRouter.laziedPrefix ||
          pathname.startsWith(pendingRouter.laziedPrefix) ||
          pathname.startsWith(pendingRouter.httpPathPrefix)
        ) {
          const { default: router } = await unlazy(pendingRouter.router);
          this.init(router, pendingRouter.path);
        } else newPendingRouters.push(pendingRouter);
      this.pendingRouters = newPendingRouters;
    }
    const match = findRoute(this.tree, method, pathname);
    if (!match) return;
    if (!match.data.procedure) {
      const { default: maybeProcedure } = await unlazy(
        getRouter$1(match.data.router, match.data.path),
      );
      if (!isProcedure(maybeProcedure))
        throw new Error(`
          [Contract-First] Missing or invalid implementation for procedure at path: ${toHttpPath(match.data.path)}.
          Ensure that the procedure is correctly defined and matches the expected contract.
        `);
      match.data.procedure = createContractedProcedure(maybeProcedure, match.data.contract);
    }
    return {
      path: match.data.path,
      procedure: match.data.procedure,
      params: match.params ? decodeParams(match.params) : void 0,
    };
  }
};
var StandardOpenAPIHandler = class extends StandardHandler {
  constructor(router, options) {
    const serializer = new StandardOpenAPISerializer(
      new StandardOpenAPIJsonSerializer(options),
      new StandardBracketNotationSerializer(options),
    );
    const matcher = new StandardOpenAPIMatcher(options);
    const codec = new StandardOpenAPICodec(serializer, options);
    super(router, matcher, codec, options);
  }
};
//#endregion
//#region node_modules/@orpc/openapi/dist/adapters/fetch/index.mjs
var OpenAPIHandler = class extends FetchHandler {
  constructor(router, options = {}) {
    super(new StandardOpenAPIHandler(router, options), options);
  }
};
//#endregion
//#region node_modules/json-schema-typed/draft_2020_12.js
/**
 * Content encoding strategy enum.
 *
 * - [Content-Transfer-Encoding Syntax](https://datatracker.ietf.org/doc/html/rfc2045#section-6.1)
 * - [7bit vs 8bit encoding](https://stackoverflow.com/questions/25710599/content-transfer-encoding-7bit-or-8-bit/28531705#28531705)
 */
var ContentEncoding;
(function (ContentEncoding) {
  /**
   * Only US-ASCII characters, which use the lower 7 bits for each character.
   *
   * Each line must be less than 1,000 characters.
   */
  ContentEncoding["7bit"] = "7bit";
  /**
   * Allow extended ASCII characters which can use the 8th (highest) bit to
   * indicate special characters not available in 7bit.
   *
   * Each line must be less than 1,000 characters.
   */
  ContentEncoding["8bit"] = "8bit";
  /**
   * Useful for data that is mostly non-text.
   */
  ContentEncoding["Base64"] = "base64";
  /**
   * Same character set as 8bit, with no line length restriction.
   */
  ContentEncoding["Binary"] = "binary";
  /**
   * An extension token defined by a standards-track RFC and registered with
   * IANA.
   */
  ContentEncoding["IETFToken"] = "ietf-token";
  /**
   * Lines are limited to 76 characters, and line breaks are represented using
   * special characters that are escaped.
   */
  ContentEncoding["QuotedPrintable"] = "quoted-printable";
  /**
   * The two characters "X-" or "x-" followed, with no intervening white space,
   * by any token.
   */
  ContentEncoding["XToken"] = "x-token";
})(ContentEncoding || (ContentEncoding = {}));
/**
 * This enum provides well-known formats that apply to strings.
 */
var Format;
(function (Format) {
  /**
   * A string instance is valid against this attribute if it is a valid
   * representation according to the "full-date" production in
   * [RFC 3339][RFC3339].
   *
   * [RFC3339]: https://datatracker.ietf.org/doc/html/rfc3339
   */
  Format["Date"] = "date";
  /**
   * A string instance is valid against this attribute if it is a valid
   * representation according to the "date-time" production in
   * [RFC 3339][RFC3339].
   *
   * [RFC3339]: https://datatracker.ietf.org/doc/html/rfc3339
   */
  Format["DateTime"] = "date-time";
  /**
   * A string instance is valid against this attribute if it is a valid
   * representation according to the "duration" production.
   */
  Format["Duration"] = "duration";
  /**
   * A string instance is valid against this attribute if it is a valid Internet
   * email address as defined by by the "Mailbox" ABNF rule in [RFC
   * 5321][RFC5322], section 4.1.2.
   *
   * [RFC5321]: https://datatracker.ietf.org/doc/html/rfc5321
   */
  Format["Email"] = "email";
  /**
   * As defined by [RFC 1123, section 2.1][RFC1123], including host names
   * produced using the Punycode algorithm specified in
   * [RFC 5891, section 4.4][RFC5891].
   *
   * [RFC1123]: https://datatracker.ietf.org/doc/html/rfc1123
   * [RFC5891]: https://datatracker.ietf.org/doc/html/rfc5891
   */
  Format["Hostname"] = "hostname";
  /**
   * A string instance is valid against this attribute if it is a valid Internet
   * email address as defined by the extended "Mailbox" ABNF rule in
   * [RFC 6531][RFC6531], section 3.3.
   *
   * [RFC6531]: https://datatracker.ietf.org/doc/html/rfc6531
   */
  Format["IDNEmail"] = "idn-email";
  /**
   * As defined by either [RFC 1123, section 2.1][RFC1123] as for hostname, or
   * an internationalized hostname as defined by
   * [RFC 5890, section 2.3.2.3][RFC5890].
   *
   * [RFC1123]: https://datatracker.ietf.org/doc/html/rfc1123
   * [RFC5890]: https://datatracker.ietf.org/doc/html/rfc5890
   */
  Format["IDNHostname"] = "idn-hostname";
  /**
   * An IPv4 address according to the "dotted-quad" ABNF syntax as defined in
   * [RFC 2673, section 3.2][RFC2673].
   *
   * [RFC2673]: https://datatracker.ietf.org/doc/html/rfc2673
   */
  Format["IPv4"] = "ipv4";
  /**
   * An IPv6 address as defined in [RFC 4291, section 2.2][RFC4291].
   *
   * [RFC4291]: https://datatracker.ietf.org/doc/html/rfc4291
   */
  Format["IPv6"] = "ipv6";
  /**
   * A string instance is valid against this attribute if it is a valid IRI,
   * according to [RFC 3987][RFC3987].
   *
   * [RFC3987]: https://datatracker.ietf.org/doc/html/rfc3987
   */
  Format["IRI"] = "iri";
  /**
   * A string instance is valid against this attribute if it is a valid IRI
   * Reference (either an IRI or a relative-reference), according to
   * [RFC 3987][RFC3987].
   *
   * [RFC3987]: https://datatracker.ietf.org/doc/html/rfc3987
   */
  Format["IRIReference"] = "iri-reference";
  /**
   * A string instance is valid against this attribute if it is a valid JSON
   * string representation of a JSON Pointer, according to
   * [RFC 6901, section 5][RFC6901].
   *
   * [RFC6901]: https://datatracker.ietf.org/doc/html/rfc6901
   */
  Format["JSONPointer"] = "json-pointer";
  /**
   * A string instance is valid against this attribute if it is a valid JSON
   * string representation of a JSON Pointer fragment, according to
   * [RFC 6901, section 5][RFC6901].
   *
   * [RFC6901]: https://datatracker.ietf.org/doc/html/rfc6901
   */
  Format["JSONPointerURIFragment"] = "json-pointer-uri-fragment";
  /**
   * This attribute applies to string instances.
   *
   * A regular expression, which SHOULD be valid according to the
   * [ECMA-262][ecma262] regular expression dialect.
   *
   * Implementations that validate formats MUST accept at least the subset of
   * [ECMA-262][ecma262] defined in the [Regular Expressions][regexInterop]
   * section of this specification, and SHOULD accept all valid
   * [ECMA-262][ecma262] expressions.
   *
   * [ecma262]: https://www.ecma-international.org/publications-and-standards/standards/ecma-262/
   * [regexInterop]: https://json-schema.org/draft/2020-12/json-schema-validation.html#regexInterop
   */
  Format["RegEx"] = "regex";
  /**
   * A string instance is valid against this attribute if it is a valid
   * [Relative JSON Pointer][relative-json-pointer].
   *
   * [relative-json-pointer]: https://datatracker.ietf.org/doc/html/draft-handrews-relative-json-pointer-01
   */
  Format["RelativeJSONPointer"] = "relative-json-pointer";
  /**
   * A string instance is valid against this attribute if it is a valid
   * representation according to the "time" production in [RFC 3339][RFC3339].
   *
   * [RFC3339]: https://datatracker.ietf.org/doc/html/rfc3339
   */
  Format["Time"] = "time";
  /**
   * A string instance is valid against this attribute if it is a valid URI,
   * according to [RFC3986][RFC3986].
   *
   * [RFC3986]: https://datatracker.ietf.org/doc/html/rfc3986
   */
  Format["URI"] = "uri";
  /**
   * A string instance is valid against this attribute if it is a valid URI
   * Reference (either a URI or a relative-reference), according to
   * [RFC3986][RFC3986].
   *
   * [RFC3986]: https://datatracker.ietf.org/doc/html/rfc3986
   */
  Format["URIReference"] = "uri-reference";
  /**
   * A string instance is valid against this attribute if it is a valid URI
   * Template (of any level), according to [RFC 6570][RFC6570].
   *
   * Note that URI Templates may be used for IRIs; there is no separate IRI
   * Template specification.
   *
   * [RFC6570]: https://datatracker.ietf.org/doc/html/rfc6570
   */
  Format["URITemplate"] = "uri-template";
  /**
   * A string instance is valid against this attribute if it is a valid string
   * representation of a UUID, according to [RFC 4122][RFC4122].
   *
   * [RFC4122]: https://datatracker.ietf.org/doc/html/rfc4122
   */
  Format["UUID"] = "uuid";
})(Format || (Format = {}));
/**
 * Enum consisting of simple type names for the `type` keyword
 */
var TypeName;
(function (TypeName) {
  /**
   * Value MUST be an array.
   */
  TypeName["Array"] = "array";
  /**
   * Value MUST be a boolean.
   */
  TypeName["Boolean"] = "boolean";
  /**
   * Value MUST be an integer, no floating point numbers are allowed. This is a
   * subset of the number type.
   */
  TypeName["Integer"] = "integer";
  /**
   * Value MUST be null. Note this is mainly for purpose of being able use union
   * types to define nullability. If this type is not included in a union, null
   * values are not allowed (the primitives listed above do not allow nulls on
   * their own).
   */
  TypeName["Null"] = "null";
  /**
   * Value MUST be a number, floating point numbers are allowed.
   */
  TypeName["Number"] = "number";
  /**
   * Value MUST be an object.
   */
  TypeName["Object"] = "object";
  /**
   * Value MUST be a string.
   */
  TypeName["String"] = "string";
})(TypeName || (TypeName = {}));
//#endregion
//#region node_modules/@orpc/openapi/dist/shared/openapi.BwdtJjDu.mjs
var OPERATION_EXTENDER_SYMBOL = Symbol("ORPC_OPERATION_EXTENDER");
function getCustomOpenAPIOperation(o) {
  return o[OPERATION_EXTENDER_SYMBOL];
}
function applyCustomOpenAPIOperation(operation, contract) {
  const operationCustoms = [];
  for (const errorItem of Object.values(contract["~orpc"].errorMap)) {
    const maybeExtender = errorItem ? getCustomOpenAPIOperation(errorItem) : void 0;
    if (maybeExtender) operationCustoms.push(maybeExtender);
  }
  if (isProcedure(contract))
    for (const middleware of contract["~orpc"].middlewares) {
      const maybeExtender = getCustomOpenAPIOperation(middleware);
      if (maybeExtender) operationCustoms.push(maybeExtender);
    }
  let currentOperation = operation;
  for (const custom of operationCustoms)
    if (typeof custom === "function") currentOperation = custom(currentOperation, contract);
    else
      currentOperation = {
        ...currentOperation,
        ...custom,
      };
  return currentOperation;
}
var LOGIC_KEYWORDS = [
  "$dynamicRef",
  "$ref",
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "else",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "if",
  "items",
  "maxContains",
  "maximum",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minContains",
  "minimum",
  "minItems",
  "minLength",
  "minProperties",
  "multipleOf",
  "not",
  "oneOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "properties",
  "propertyNames",
  "required",
  "then",
  "type",
  "unevaluatedItems",
  "unevaluatedProperties",
  "uniqueItems",
];
function isFileSchema(schema) {
  return (
    isObject(schema) && schema.type === "string" && typeof schema.contentMediaType === "string"
  );
}
function isObjectSchema(schema) {
  return isObject(schema) && schema.type === "object";
}
function isAnySchema(schema) {
  if (schema === true) return true;
  if (
    Object.keys(schema)
      .filter((v) => schema[v] !== void 0)
      .every((k) => !LOGIC_KEYWORDS.includes(k))
  )
    return true;
  return false;
}
function isNeverSchema(schema) {
  if (schema === false) return true;
  if (typeof schema === "object" && schema.not !== void 0) {
    if (schema.not === true) return true;
    if (typeof schema.not === "object" && Object.keys(schema.not).length === 0) return true;
  }
  return false;
}
function separateObjectSchema(schema, separatedProperties) {
  if (
    Object.keys(schema).some(
      (k) =>
        !["type", "properties", "required", "additionalProperties"].includes(k) &&
        LOGIC_KEYWORDS.includes(k) &&
        schema[k] !== void 0,
    )
  )
    return [{ type: "object" }, schema];
  const matched = { ...schema };
  const rest = { ...schema };
  matched.properties = separatedProperties.reduce((acc, key) => {
    const keySchema = schema.properties?.[key] ?? schema.additionalProperties;
    if (keySchema !== void 0) acc[key] = keySchema;
    return acc;
  }, {});
  if (Object.keys(matched.properties).length === 0) matched.properties = void 0;
  matched.required = schema.required?.filter((key) => separatedProperties.includes(key));
  if (matched.required?.length === 0) matched.required = void 0;
  matched.examples = schema.examples?.map((example) => {
    if (!isObject(example)) return example;
    return Object.entries(example).reduce((acc, [key, value]) => {
      if (separatedProperties.includes(key)) acc[key] = value;
      return acc;
    }, {});
  });
  rest.properties =
    schema.properties &&
    Object.entries(schema.properties)
      .filter(([key]) => !separatedProperties.includes(key))
      .reduce(
        (acc = {}, [key, value]) => {
          acc[key] = value;
          return acc;
        },
        void 0,
      );
  rest.required = schema.required?.filter((key) => !separatedProperties.includes(key));
  if (rest.required?.length === 0) rest.required = void 0;
  rest.examples = schema.examples?.map((example) => {
    if (!isObject(example)) return example;
    return Object.entries(example).reduce((acc, [key, value]) => {
      if (!separatedProperties.includes(key)) acc[key] = value;
      return acc;
    }, {});
  });
  return [matched, rest];
}
function filterSchemaBranches(schema, check, matches = []) {
  if (check(schema)) {
    matches.push(schema);
    return [matches, void 0];
  }
  if (isObject(schema)) {
    for (const keyword of ["anyOf", "oneOf"])
      if (
        schema[keyword] &&
        Object.keys(schema).every((k) => k === keyword || !LOGIC_KEYWORDS.includes(k))
      ) {
        const rest = schema[keyword]
          .map((s) => filterSchemaBranches(s, check, matches)[1])
          .filter((v) => !!v);
        if (rest.length === 1 && typeof rest[0] === "object")
          return [
            matches,
            {
              ...schema,
              [keyword]: void 0,
              ...rest[0],
            },
          ];
        return [
          matches,
          {
            ...schema,
            [keyword]: rest,
          },
        ];
      }
  }
  return [matches, schema];
}
function applySchemaOptionality(required, schema) {
  if (required) return schema;
  return { anyOf: [schema, { not: {} }] };
}
function expandUnionSchema(schema) {
  if (typeof schema === "object") {
    for (const keyword of ["anyOf", "oneOf"])
      if (
        schema[keyword] &&
        Object.keys(schema).every((k) => k === keyword || !LOGIC_KEYWORDS.includes(k))
      )
        return schema[keyword].flatMap((s) => expandUnionSchema(s));
  }
  return [schema];
}
function expandArrayableSchema(schema) {
  const schemas = expandUnionSchema(schema);
  if (schemas.length !== 2) return;
  const arraySchema = schemas.find(
    (s) =>
      typeof s === "object" &&
      s.type === "array" &&
      Object.keys(s)
        .filter((k) => LOGIC_KEYWORDS.includes(k))
        .every((k) => k === "type" || k === "items"),
  );
  if (arraySchema === void 0) return;
  const items1 = arraySchema.items;
  const items2 = schemas.find((s) => s !== arraySchema);
  if (stringifyJSON(items1) !== stringifyJSON(items2)) return;
  return [items2, arraySchema];
}
var PRIMITIVE_SCHEMA_TYPES = /* @__PURE__ */ new Set([
  TypeName.String,
  TypeName.Number,
  TypeName.Integer,
  TypeName.Boolean,
  TypeName.Null,
]);
function isPrimitiveSchema(schema) {
  return expandUnionSchema(schema).every((s) => {
    if (typeof s === "boolean") return false;
    if (typeof s.type === "string" && PRIMITIVE_SCHEMA_TYPES.has(s.type)) return true;
    if (s.const !== void 0) return true;
    return false;
  });
}
function toOpenAPIPath(path) {
  return standardizeHTTPPath(path).replace(/\/\{\+([^}]+)\}/g, "/{$1}");
}
function toOpenAPIMethod(method) {
  return method.toLocaleLowerCase();
}
function toOpenAPIContent(schema) {
  const content = {};
  const [matches, restSchema] = filterSchemaBranches(schema, isFileSchema);
  for (const file of matches) content[file.contentMediaType] = { schema: toOpenAPISchema(file) };
  if (restSchema !== void 0 && !isAnySchema(restSchema) && !isNeverSchema(restSchema)) {
    content["application/json"] = { schema: toOpenAPISchema(restSchema) };
    if (findDeepMatches((v) => isObject(v) && isFileSchema(v), restSchema).values.length > 0)
      content["multipart/form-data"] = { schema: toOpenAPISchema(restSchema) };
  }
  return content;
}
function toOpenAPIEventIteratorContent(
  [yieldsRequired, yieldsSchema],
  [returnsRequired, returnsSchema],
) {
  return {
    "text/event-stream": {
      schema: toOpenAPISchema({
        oneOf: [
          {
            type: "object",
            properties: {
              event: { const: "message" },
              data: yieldsSchema,
              id: { type: "string" },
              retry: { type: "number" },
            },
            required: yieldsRequired ? ["event", "data"] : ["event"],
          },
          {
            type: "object",
            properties: {
              event: { const: "done" },
              data: returnsSchema,
              id: { type: "string" },
              retry: { type: "number" },
            },
            required: returnsRequired ? ["event", "data"] : ["event"],
          },
          {
            type: "object",
            properties: {
              event: { const: "error" },
              data: {},
              id: { type: "string" },
              retry: { type: "number" },
            },
            required: ["event"],
          },
        ],
      }),
    },
  };
}
function toOpenAPIParameters(schema, parameterIn) {
  const parameters = [];
  for (const key in schema.properties) {
    const keySchema = schema.properties[key];
    let isDeepObjectStyle = true;
    if (parameterIn !== "query") isDeepObjectStyle = false;
    else if (isPrimitiveSchema(keySchema)) isDeepObjectStyle = false;
    else {
      const [item] = expandArrayableSchema(keySchema) ?? [];
      if (item !== void 0 && isPrimitiveSchema(item)) isDeepObjectStyle = false;
    }
    parameters.push({
      name: key,
      in: parameterIn,
      required: schema.required?.includes(key),
      schema: toOpenAPISchema(keySchema),
      style: isDeepObjectStyle ? "deepObject" : void 0,
      explode: isDeepObjectStyle ? true : void 0,
      allowEmptyValue: parameterIn === "query" ? true : void 0,
      allowReserved: parameterIn === "query" ? true : void 0,
    });
  }
  return parameters;
}
function checkParamsSchema(schema, params) {
  const properties = Object.keys(schema.properties ?? {});
  const required = schema.required ?? [];
  if (properties.length !== params.length || properties.some((v) => !params.includes(v)))
    return false;
  if (required.length !== params.length || required.some((v) => !params.includes(v))) return false;
  return true;
}
function toOpenAPISchema(schema) {
  return schema === true ? {} : schema === false ? { not: {} } : schema;
}
var OPENAPI_JSON_SCHEMA_REF_PREFIX = "#/components/schemas/";
function resolveOpenAPIJsonSchemaRef(doc, schema) {
  if (typeof schema !== "object" || !schema.$ref?.startsWith(OPENAPI_JSON_SCHEMA_REF_PREFIX))
    return schema;
  const name = schema.$ref.slice(21);
  return doc.components?.schemas?.[name] ?? schema;
}
function simplifyComposedObjectJsonSchemasAndRefs(schema, doc) {
  if (doc) schema = resolveOpenAPIJsonSchemaRef(doc, schema);
  if (typeof schema !== "object" || (!schema.anyOf && !schema.oneOf && !schema.allOf))
    return schema;
  const unionSchemas = [
    ...toArray(schema.anyOf?.map((s) => simplifyComposedObjectJsonSchemasAndRefs(s, doc))),
    ...toArray(schema.oneOf?.map((s) => simplifyComposedObjectJsonSchemasAndRefs(s, doc))),
  ];
  const objectUnionSchemas = [];
  for (const u of unionSchemas) {
    if (!isObjectSchema(u)) return schema;
    objectUnionSchemas.push(u);
  }
  const mergedUnionPropertyMap = /* @__PURE__ */ new Map();
  for (const u of objectUnionSchemas)
    if (u.properties)
      for (const [key, value] of Object.entries(u.properties)) {
        let entry = mergedUnionPropertyMap.get(key);
        if (!entry) {
          entry = {
            required: objectUnionSchemas.every((s) => s.required?.includes(key)),
            schemas: [],
          };
          mergedUnionPropertyMap.set(key, entry);
        }
        entry.schemas.push(value);
      }
  const intersectionSchemas = toArray(
    schema.allOf?.map((s) => simplifyComposedObjectJsonSchemasAndRefs(s, doc)),
  );
  const objectIntersectionSchemas = [];
  for (const u of intersectionSchemas) {
    if (!isObjectSchema(u)) return schema;
    objectIntersectionSchemas.push(u);
  }
  if (isObjectSchema(schema)) objectIntersectionSchemas.push(schema);
  const mergedInteractionPropertyMap = /* @__PURE__ */ new Map();
  for (const u of objectIntersectionSchemas)
    if (u.properties)
      for (const [key, value] of Object.entries(u.properties)) {
        let entry = mergedInteractionPropertyMap.get(key);
        if (!entry) {
          entry = {
            required: objectIntersectionSchemas.some((s) => s.required?.includes(key)),
            schemas: [],
          };
          mergedInteractionPropertyMap.set(key, entry);
        }
        entry.schemas.push(value);
      }
  const resultObjectSchema = {
    type: "object",
    properties: {},
    required: [],
  };
  const keys = /* @__PURE__ */ new Set([
    ...mergedUnionPropertyMap.keys(),
    ...mergedInteractionPropertyMap.keys(),
  ]);
  if (keys.size === 0) return schema;
  const deduplicateSchemas = (schemas) => {
    const seen = /* @__PURE__ */ new Set();
    const result = [];
    for (const schema2 of schemas) {
      const key = stringifyJSON(schema2);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(schema2);
      }
    }
    return result;
  };
  for (const key of keys) {
    const unionEntry = mergedUnionPropertyMap.get(key);
    const intersectionEntry = mergedInteractionPropertyMap.get(key);
    resultObjectSchema.properties[key] = (() => {
      const dedupedUnionSchemas = unionEntry ? deduplicateSchemas(unionEntry.schemas) : [];
      const dedupedIntersectionSchemas = intersectionEntry
        ? deduplicateSchemas(intersectionEntry.schemas)
        : [];
      if (!dedupedUnionSchemas.length)
        return dedupedIntersectionSchemas.length === 1
          ? dedupedIntersectionSchemas[0]
          : { allOf: dedupedIntersectionSchemas };
      if (!dedupedIntersectionSchemas.length)
        return dedupedUnionSchemas.length === 1
          ? dedupedUnionSchemas[0]
          : { anyOf: dedupedUnionSchemas };
      const allOf = deduplicateSchemas([
        ...dedupedIntersectionSchemas,
        dedupedUnionSchemas.length === 1 ? dedupedUnionSchemas[0] : { anyOf: dedupedUnionSchemas },
      ]);
      return allOf.length === 1 ? allOf[0] : { allOf };
    })();
    if (unionEntry?.required || intersectionEntry?.required) resultObjectSchema.required.push(key);
  }
  return resultObjectSchema;
}
var CompositeSchemaConverter = class {
  converters;
  constructor(converters) {
    this.converters = converters;
  }
  async convert(schema, options) {
    for (const converter of this.converters)
      if (await converter.condition(schema, options)) return converter.convert(schema, options);
    return [false, {}];
  }
};
var OpenAPIGeneratorError = class extends Error {};
var OpenAPIGenerator = class {
  serializer;
  converter;
  constructor(options = {}) {
    this.serializer = new StandardOpenAPIJsonSerializer(options);
    this.converter = new CompositeSchemaConverter(toArray(options.schemaConverters));
  }
  /**
   * Generates OpenAPI specifications from oRPC routers/contracts.
   *
   * @see {@link https://orpc.dev/docs/openapi/openapi-specification OpenAPI Specification Docs}
   */
  async generate(
    router,
    { customErrorResponseBodySchema, commonSchemas, filter: baseFilter, exclude, ...baseDoc } = {},
  ) {
    const filter =
      baseFilter ??
      (({ contract, path }) => {
        return !(exclude?.(contract, path) ?? false);
      });
    const doc = {
      ...clone(baseDoc),
      info: baseDoc.info ?? {
        title: "API Reference",
        version: "0.0.0",
      },
      openapi: "3.1.1",
    };
    const { baseSchemaConvertOptions, undefinedErrorJsonSchema } = await this.#resolveCommonSchemas(
      doc,
      commonSchemas,
    );
    const contracts = [];
    await resolveContractProcedures(
      {
        path: [],
        router,
      },
      (traverseOptions) => {
        if (!value(filter, traverseOptions)) return;
        contracts.push(traverseOptions);
      },
    );
    const errors = [];
    for (const { contract, path } of contracts) {
      const stringPath = path.join(".");
      try {
        const def = contract["~orpc"];
        const method = toOpenAPIMethod(fallbackContractConfig("defaultMethod", def.route.method));
        const httpPath = toOpenAPIPath(def.route.path ?? toHttpPath(path));
        let operationObjectRef;
        if (def.route.spec !== void 0 && typeof def.route.spec !== "function")
          operationObjectRef = def.route.spec;
        else {
          operationObjectRef = {
            operationId: def.route.operationId ?? stringPath,
            summary: def.route.summary,
            description: def.route.description,
            deprecated: def.route.deprecated,
            tags: def.route.tags?.map((tag) => tag),
          };
          await this.#request(doc, operationObjectRef, def, baseSchemaConvertOptions);
          await this.#successResponse(doc, operationObjectRef, def, baseSchemaConvertOptions);
          await this.#errorResponse(
            operationObjectRef,
            def,
            baseSchemaConvertOptions,
            undefinedErrorJsonSchema,
            customErrorResponseBodySchema,
          );
        }
        if (typeof def.route.spec === "function")
          operationObjectRef = def.route.spec(operationObjectRef);
        doc.paths ??= {};
        doc.paths[httpPath] ??= {};
        doc.paths[httpPath][method] = applyCustomOpenAPIOperation(operationObjectRef, contract);
      } catch (e) {
        if (!(e instanceof OpenAPIGeneratorError)) throw e;
        errors.push(`[OpenAPIGenerator] Error occurred while generating OpenAPI for procedure at path: ${stringPath}
${e.message}`);
      }
    }
    if (errors.length)
      throw new OpenAPIGeneratorError(`Some error occurred during OpenAPI generation:

${errors.join("\n\n")}`);
    return this.serializer.serialize(doc)[0];
  }
  async #resolveCommonSchemas(doc, commonSchemas) {
    let undefinedErrorJsonSchema = {
      type: "object",
      properties: {
        defined: { const: false },
        code: { type: "string" },
        status: { type: "number" },
        message: { type: "string" },
        data: {},
      },
      required: ["defined", "code", "status", "message"],
    };
    const baseSchemaConvertOptions = {};
    if (commonSchemas) {
      baseSchemaConvertOptions.components = [];
      for (const key in commonSchemas) {
        const options = commonSchemas[key];
        if (options.schema === void 0) continue;
        const { schema, strategy = "input" } = options;
        const [required, json] = await this.converter.convert(schema, { strategy });
        const allowedStrategies = [strategy];
        if (strategy === "input") {
          const [outputRequired, outputJson] = await this.converter.convert(schema, {
            strategy: "output",
          });
          if (outputRequired === required && stringifyJSON(outputJson) === stringifyJSON(json))
            allowedStrategies.push("output");
        } else if (strategy === "output") {
          const [inputRequired, inputJson] = await this.converter.convert(schema, {
            strategy: "input",
          });
          if (inputRequired === required && stringifyJSON(inputJson) === stringifyJSON(json))
            allowedStrategies.push("input");
        }
        baseSchemaConvertOptions.components.push({
          schema,
          required,
          ref: `#/components/schemas/${key}`,
          allowedStrategies,
        });
      }
      doc.components ??= {};
      doc.components.schemas ??= {};
      for (const key in commonSchemas) {
        const options = commonSchemas[key];
        if (options.schema === void 0) {
          if (options.error === "UndefinedError") {
            doc.components.schemas[key] = toOpenAPISchema(undefinedErrorJsonSchema);
            undefinedErrorJsonSchema = { $ref: `#/components/schemas/${key}` };
          }
          continue;
        }
        const { schema, strategy = "input" } = options;
        const [, json] = await this.converter.convert(schema, {
          ...baseSchemaConvertOptions,
          strategy,
          minStructureDepthForRef: 1,
        });
        doc.components.schemas[key] = toOpenAPISchema(json);
      }
    }
    return {
      baseSchemaConvertOptions,
      undefinedErrorJsonSchema,
    };
  }
  async #request(doc, ref, def, baseSchemaConvertOptions) {
    const method = fallbackContractConfig("defaultMethod", def.route.method);
    const details = getEventIteratorSchemaDetails(def.inputSchema);
    if (details) {
      ref.requestBody = {
        required: true,
        content: toOpenAPIEventIteratorContent(
          await this.converter.convert(details.yields, {
            ...baseSchemaConvertOptions,
            strategy: "input",
          }),
          await this.converter.convert(details.returns, {
            ...baseSchemaConvertOptions,
            strategy: "input",
          }),
        ),
      };
      return;
    }
    const dynamicParams = getDynamicParams(def.route.path)?.map((v) => v.name);
    const inputStructure = fallbackContractConfig(
      "defaultInputStructure",
      def.route.inputStructure,
    );
    let [required, schema] = await this.converter.convert(def.inputSchema, {
      ...baseSchemaConvertOptions,
      strategy: "input",
    });
    let omitResponseBody = false;
    if (isAnySchema(schema) && !dynamicParams?.length) return;
    if (
      inputStructure === "detailed" ||
      (inputStructure === "compact" && (dynamicParams?.length || method === "GET"))
    )
      schema = simplifyComposedObjectJsonSchemasAndRefs(schema, doc);
    if (inputStructure === "compact") {
      if (dynamicParams?.length) {
        const error2 = new OpenAPIGeneratorError(
          'When input structure is "compact", and path has dynamic params, input schema must be an object with all dynamic params as required.',
        );
        if (!isObjectSchema(schema)) throw error2;
        const [paramsSchema, rest] = separateObjectSchema(schema, dynamicParams);
        schema = rest;
        required = rest.required ? rest.required.length !== 0 : false;
        omitResponseBody = !required && !rest.properties;
        if (!checkParamsSchema(paramsSchema, dynamicParams)) throw error2;
        ref.parameters ??= [];
        ref.parameters.push(...toOpenAPIParameters(paramsSchema, "path"));
      }
      if (method === "GET") {
        if (!isObjectSchema(schema))
          throw new OpenAPIGeneratorError(
            'When method is "GET", input schema must satisfy: object | any | unknown',
          );
        ref.parameters ??= [];
        ref.parameters.push(...toOpenAPIParameters(schema, "query"));
      } else if (!omitResponseBody)
        ref.requestBody = {
          required,
          content: toOpenAPIContent(schema),
        };
      return;
    }
    const error = new OpenAPIGeneratorError(
      'When input structure is "detailed", input schema must satisfy: { params?: Record<string, unknown>, query?: Record<string, unknown>, headers?: Record<string, unknown>, body?: unknown }',
    );
    if (!isObjectSchema(schema)) throw error;
    const resolvedParamSchema =
      schema.properties?.params !== void 0
        ? simplifyComposedObjectJsonSchemasAndRefs(schema.properties.params, doc)
        : void 0;
    if (
      dynamicParams?.length &&
      (resolvedParamSchema === void 0 ||
        !isObjectSchema(resolvedParamSchema) ||
        !checkParamsSchema(resolvedParamSchema, dynamicParams))
    )
      throw new OpenAPIGeneratorError(
        'When input structure is "detailed" and path has dynamic params, the "params" schema must be an object with all dynamic params as required.',
      );
    for (const from of ["params", "query", "headers"]) {
      const fromSchema = schema.properties?.[from];
      if (fromSchema !== void 0) {
        const resolvedSchema = simplifyComposedObjectJsonSchemasAndRefs(fromSchema, doc);
        if (!isObjectSchema(resolvedSchema)) throw error;
        const parameterIn = from === "params" ? "path" : from === "headers" ? "header" : "query";
        ref.parameters ??= [];
        ref.parameters.push(...toOpenAPIParameters(resolvedSchema, parameterIn));
      }
    }
    if (schema.properties?.body !== void 0)
      ref.requestBody = {
        required: schema.required?.includes("body"),
        content: toOpenAPIContent(schema.properties.body),
      };
  }
  async #successResponse(doc, ref, def, baseSchemaConvertOptions) {
    const outputSchema = def.outputSchema;
    const status = fallbackContractConfig("defaultSuccessStatus", def.route.successStatus);
    const description = fallbackContractConfig(
      "defaultSuccessDescription",
      def.route?.successDescription,
    );
    const eventIteratorSchemaDetails = getEventIteratorSchemaDetails(outputSchema);
    const outputStructure = fallbackContractConfig(
      "defaultOutputStructure",
      def.route.outputStructure,
    );
    if (eventIteratorSchemaDetails) {
      ref.responses ??= {};
      ref.responses[status] = {
        description,
        content: toOpenAPIEventIteratorContent(
          await this.converter.convert(eventIteratorSchemaDetails.yields, {
            ...baseSchemaConvertOptions,
            strategy: "output",
          }),
          await this.converter.convert(eventIteratorSchemaDetails.returns, {
            ...baseSchemaConvertOptions,
            strategy: "output",
          }),
        ),
      };
      return;
    }
    const [required, json] = await this.converter.convert(outputSchema, {
      ...baseSchemaConvertOptions,
      strategy: "output",
      minStructureDepthForRef: outputStructure === "detailed" ? 1 : 0,
    });
    if (outputStructure === "compact") {
      ref.responses ??= {};
      ref.responses[status] = { description };
      ref.responses[status].content = toOpenAPIContent(applySchemaOptionality(required, json));
      return;
    }
    const handledStatuses = /* @__PURE__ */ new Set();
    for (const item of expandUnionSchema(json)) {
      const error = new OpenAPIGeneratorError(`
        When output structure is "detailed", output schema must satisfy:
        { 
          status?: number, // must be a literal number and in the range of 200-399
          headers?: Record<string, unknown>, 
          body?: unknown 
        }
        
        But got: ${stringifyJSON(item)}
      `);
      const simplifiedItem = simplifyComposedObjectJsonSchemasAndRefs(item, doc);
      if (!isObjectSchema(simplifiedItem)) throw error;
      let schemaStatus;
      let schemaDescription;
      if (simplifiedItem.properties?.status !== void 0) {
        const statusSchema = resolveOpenAPIJsonSchemaRef(doc, simplifiedItem.properties.status);
        if (
          typeof statusSchema !== "object" ||
          statusSchema.const === void 0 ||
          typeof statusSchema.const !== "number" ||
          !Number.isInteger(statusSchema.const) ||
          isORPCErrorStatus(statusSchema.const)
        )
          throw error;
        schemaStatus = statusSchema.const;
        schemaDescription = statusSchema.description;
      }
      const itemStatus = schemaStatus ?? status;
      const itemDescription = schemaDescription ?? description;
      if (handledStatuses.has(itemStatus))
        throw new OpenAPIGeneratorError(`
          When output structure is "detailed", each success status must be unique.
          But got status: ${itemStatus} used more than once.
        `);
      handledStatuses.add(itemStatus);
      ref.responses ??= {};
      ref.responses[itemStatus] = { description: itemDescription };
      if (simplifiedItem.properties?.headers !== void 0) {
        const headersSchema = simplifyComposedObjectJsonSchemasAndRefs(
          simplifiedItem.properties.headers,
          doc,
        );
        if (!isObjectSchema(headersSchema)) throw error;
        for (const key in headersSchema.properties) {
          const headerSchema = headersSchema.properties[key];
          if (headerSchema !== void 0) {
            ref.responses[itemStatus].headers ??= {};
            ref.responses[itemStatus].headers[key] = {
              schema: toOpenAPISchema(headerSchema),
              required:
                simplifiedItem.required?.includes("headers") &&
                headersSchema.required?.includes(key),
            };
          }
        }
      }
      if (simplifiedItem.properties?.body !== void 0)
        ref.responses[itemStatus].content = toOpenAPIContent(
          applySchemaOptionality(
            simplifiedItem.required?.includes("body") ?? false,
            simplifiedItem.properties.body,
          ),
        );
    }
  }
  async #errorResponse(
    ref,
    def,
    baseSchemaConvertOptions,
    undefinedErrorSchema,
    customErrorResponseBodySchema,
  ) {
    const errorMap = def.errorMap;
    const errorResponsesByStatus = {};
    for (const code in errorMap) {
      const config = errorMap[code];
      if (!config) continue;
      const status = fallbackORPCErrorStatus(code, config.status);
      const defaultMessage = fallbackORPCErrorMessage(code, config.message);
      errorResponsesByStatus[status] ??= {
        status,
        definedErrorDefinitions: [],
        errorSchemaVariants: [],
      };
      const [dataRequired, dataSchema] = await this.converter.convert(config.data, {
        ...baseSchemaConvertOptions,
        strategy: "output",
      });
      errorResponsesByStatus[status].definedErrorDefinitions.push([
        code,
        defaultMessage,
        dataRequired,
        dataSchema,
      ]);
      errorResponsesByStatus[status].errorSchemaVariants.push({
        type: "object",
        properties: {
          defined: { const: true },
          code: { const: code },
          status: { const: status },
          message: {
            type: "string",
            default: defaultMessage,
          },
          data: dataSchema,
        },
        required: dataRequired
          ? ["defined", "code", "status", "message", "data"]
          : ["defined", "code", "status", "message"],
      });
    }
    ref.responses ??= {};
    for (const statusString in errorResponsesByStatus) {
      const errorResponse = errorResponsesByStatus[statusString];
      const customBodySchema = value(
        customErrorResponseBodySchema,
        errorResponse.definedErrorDefinitions,
        errorResponse.status,
      );
      ref.responses[statusString] = {
        description: statusString,
        content: toOpenAPIContent(
          customBodySchema ?? {
            oneOf: [...errorResponse.errorSchemaVariants, undefinedErrorSchema],
          },
        ),
      };
    }
  }
};
//#endregion
//#region node_modules/@orpc/openapi/dist/plugins/index.mjs
var OpenAPIReferencePlugin = class {
  generator;
  specGenerateOptions;
  specPath;
  docsPath;
  docsTitle;
  docsHead;
  docsProvider;
  docsScriptUrl;
  docsCssUrl;
  docsConfig;
  renderDocsHtml;
  constructor(options = {}) {
    this.specGenerateOptions = options.specGenerateOptions;
    this.docsPath = options.docsPath ?? "/";
    this.docsTitle = options.docsTitle ?? "API Reference";
    this.docsConfig = options.docsConfig ?? void 0;
    this.docsProvider = options.docsProvider ?? "scalar";
    this.docsScriptUrl =
      options.docsScriptUrl ??
      (this.docsProvider === "swagger"
        ? "https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"
        : "https://cdn.jsdelivr.net/npm/@scalar/api-reference");
    this.docsCssUrl =
      options.docsCssUrl ??
      (this.docsProvider === "swagger"
        ? "https://unpkg.com/swagger-ui-dist/swagger-ui.css"
        : void 0);
    this.docsHead = options.docsHead ?? "";
    this.specPath = options.specPath ?? "/spec.json";
    this.generator = new OpenAPIGenerator(options);
    const escapeHtmlEntities = (s) =>
      s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const escapeJsonForHtml = (obj) =>
      stringifyJSON(obj)
        .replace(/&/g, "\\u0026")
        .replace(/'/g, "\\u0027")
        .replace(/</g, "\\u003C")
        .replace(/>/g, "\\u003E")
        .replace(/\//g, "\\u002F");
    this.renderDocsHtml =
      options.renderDocsHtml ??
      ((specUrl, title, head, scriptUrl, config, spec, docsProvider, cssUrl) => {
        let body;
        if (docsProvider === "swagger") {
          const swaggerConfig = {
            dom_id: "#app",
            spec,
            deepLinking: true,
            presets: ["SwaggerUIBundle.presets.apis", "SwaggerUIBundle.presets.standalone"],
            plugins: ["SwaggerUIBundle.plugins.DownloadUrl"],
            ...config,
          };
          body = `
        <body>
          <div id="app"></div>

          <script src="${escapeHtmlEntities(scriptUrl)}"><\/script>

          <!-- IMPORTANT: assign to a variable first to prevent ), ( in values breaking the call expression. -->
          <!-- IMPORTANT: escapeJsonForHtml ensures <, > cannot terminate the <\/script> tag prematurely. -->
          <script>
            const swaggerConfig = ${escapeJsonForHtml(swaggerConfig).replace(/"(SwaggerUIBundle\.[^"]+)"/g, "$1")}

            window.onload = () => {
              window.ui = SwaggerUIBundle(swaggerConfig)
            }
          <\/script>
        </body>
        `;
        } else {
          const scalarConfig = {
            content: stringifyJSON(spec),
            ...config,
          };
          body = `
        <body>
          <div id="app"></div>
 
          <script src="${escapeHtmlEntities(scriptUrl)}"><\/script>
 
          <!-- IMPORTANT: assign to a variable first to prevent ), ( in values breaking the call expression. -->
          <!-- IMPORTANT: escapeJsonForHtml ensures <, > cannot terminate the <\/script> tag prematurely. -->
          <script>
            const scalarConfig = ${escapeJsonForHtml(scalarConfig)}

            Scalar.createApiReference('#app', scalarConfig)
          <\/script>
        </body>
        `;
        }
        return `
        <!doctype html>
        <html>
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>${escapeHtmlEntities(title)}</title>
            ${cssUrl ? `<link rel="stylesheet" type="text/css" href="${escapeHtmlEntities(cssUrl)}" />` : ""}
            ${head}
          </head>
          ${body}
        </html>
        `;
      });
  }
  init(options, router) {
    options.interceptors ??= [];
    options.interceptors.push(async (options2) => {
      const res = await options2.next();
      if (res.matched || options2.request.method !== "GET") return res;
      const prefix = options2.prefix ?? "";
      const requestPathname = options2.request.url.pathname.replace(/\/$/, "") || "/";
      const docsUrl = new URL(
        `${prefix}${this.docsPath}`.replace(/\/$/, ""),
        options2.request.url.origin,
      );
      const specUrl = new URL(
        `${prefix}${this.specPath}`.replace(/\/$/, ""),
        options2.request.url.origin,
      );
      const generateSpec = once(async () => {
        return await this.generator.generate(router, {
          servers: [{ url: new URL(prefix, options2.request.url.origin).toString() }],
          ...(await value(this.specGenerateOptions, options2)),
        });
      });
      if (requestPathname === specUrl.pathname) {
        const spec = await generateSpec();
        return {
          matched: true,
          response: {
            status: 200,
            headers: {},
            body: new File([stringifyJSON(spec)], "spec.json", { type: "application/json" }),
          },
        };
      }
      if (requestPathname === docsUrl.pathname) {
        const html = this.renderDocsHtml(
          specUrl.toString(),
          await value(this.docsTitle, options2),
          await value(this.docsHead, options2),
          await value(this.docsScriptUrl, options2),
          await value(this.docsConfig, options2),
          await generateSpec(),
          this.docsProvider,
          await value(this.docsCssUrl, options2),
        );
        return {
          matched: true,
          response: {
            status: 200,
            headers: {},
            body: new File([html], "api-reference.html", { type: "text/html" }),
          },
        };
      }
      return res;
    });
  }
};
//#endregion
//#region node_modules/@orpc/json-schema/dist/index.mjs
var JsonSchemaXNativeType = /* @__PURE__ */ ((JsonSchemaXNativeType2) => {
  JsonSchemaXNativeType2["BigInt"] = "bigint";
  JsonSchemaXNativeType2["RegExp"] = "regexp";
  JsonSchemaXNativeType2["Date"] = "date";
  JsonSchemaXNativeType2["Url"] = "url";
  JsonSchemaXNativeType2["Set"] = "set";
  JsonSchemaXNativeType2["Map"] = "map";
  return JsonSchemaXNativeType2;
})(JsonSchemaXNativeType || {});
//#endregion
//#region node_modules/escape-string-regexp/index.js
function escapeStringRegexp(string) {
  if (typeof string !== "string") throw new TypeError("Expected a string");
  return string.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&").replace(/-/g, "\\x2d");
}
//#endregion
//#region node_modules/@orpc/zod/dist/index.mjs
var CUSTOM_JSON_SCHEMA_SYMBOL = Symbol("ORPC_CUSTOM_JSON_SCHEMA");
var CUSTOM_JSON_SCHEMA_INPUT_SYMBOL = Symbol("ORPC_CUSTOM_JSON_SCHEMA_INPUT");
var CUSTOM_JSON_SCHEMA_OUTPUT_SYMBOL = Symbol("ORPC_CUSTOM_JSON_SCHEMA_OUTPUT");
function getCustomJsonSchema(def, options) {
  if (options.strategy === "input" && CUSTOM_JSON_SCHEMA_INPUT_SYMBOL in def)
    return def[CUSTOM_JSON_SCHEMA_INPUT_SYMBOL];
  if (options.strategy === "output" && CUSTOM_JSON_SCHEMA_OUTPUT_SYMBOL in def)
    return def[CUSTOM_JSON_SCHEMA_OUTPUT_SYMBOL];
  if (CUSTOM_JSON_SCHEMA_SYMBOL in def) return def[CUSTOM_JSON_SCHEMA_SYMBOL];
}
var CUSTOM_ZOD_DEF_SYMBOL = Symbol("ORPC_CUSTOM_ZOD_DEF");
function getCustomZodDef(def) {
  return def[CUSTOM_ZOD_DEF_SYMBOL];
}
var ZodToJsonSchemaConverter = class {
  maxLazyDepth;
  maxStructureDepth;
  unsupportedJsonSchema;
  anyJsonSchema;
  constructor(options = {}) {
    this.maxLazyDepth = options.maxLazyDepth ?? 3;
    this.maxStructureDepth = options.maxStructureDepth ?? 10;
    this.unsupportedJsonSchema = options.unsupportedJsonSchema ?? { not: {} };
    this.anyJsonSchema = options.anyJsonSchema ?? {};
  }
  condition(schema) {
    return schema !== void 0 && schema["~standard"].vendor === "zod" && !("_zod" in schema);
  }
  convert(
    schema,
    options,
    lazyDepth = 0,
    isHandledCustomJSONSchema = false,
    isHandledZodDescription = false,
    structureDepth = 0,
  ) {
    const def = schema._def;
    if (structureDepth > this.maxStructureDepth) return [false, this.anyJsonSchema];
    if (!options.minStructureDepthForRef || options.minStructureDepthForRef <= structureDepth) {
      const components = toArray(options.components);
      for (const component of components)
        if (component.schema === schema && component.allowedStrategies.includes(options.strategy))
          return [component.required, { $ref: component.ref }];
    }
    if (!isHandledZodDescription && "description" in def && typeof def.description === "string") {
      const [required, json] = this.convert(
        schema,
        options,
        lazyDepth,
        isHandledCustomJSONSchema,
        true,
        structureDepth,
      );
      return [
        required,
        {
          ...json,
          description: def.description,
        },
      ];
    }
    if (!isHandledCustomJSONSchema) {
      const customJSONSchema = getCustomJsonSchema(def, options);
      if (customJSONSchema) {
        const [required, json] = this.convert(
          schema,
          options,
          lazyDepth,
          true,
          isHandledZodDescription,
          structureDepth,
        );
        return [
          required,
          {
            ...json,
            ...customJSONSchema,
          },
        ];
      }
    }
    const customSchema = this.#handleCustomZodDef(def);
    if (customSchema) return [true, customSchema];
    switch (this.#getZodTypeName(def)) {
      case ZodFirstPartyTypeKind.ZodString: {
        const schema_ = schema;
        const json = { type: "string" };
        for (const check of schema_._def.checks)
          switch (check.kind) {
            case "base64":
              json.contentEncoding = "base64";
              break;
            case "cuid":
              json.pattern = "^[0-9A-HJKMNP-TV-Z]{26}$";
              break;
            case "email":
              json.format = Format.Email;
              break;
            case "url":
              json.format = Format.URI;
              break;
            case "uuid":
              json.format = Format.UUID;
              break;
            case "regex":
              json.pattern = check.regex.source;
              break;
            case "min":
              json.minLength = check.value;
              break;
            case "max":
              json.maxLength = check.value;
              break;
            case "length":
              json.minLength = check.value;
              json.maxLength = check.value;
              break;
            case "includes":
              json.pattern = escapeStringRegexp(check.value);
              break;
            case "startsWith":
              json.pattern = `^${escapeStringRegexp(check.value)}`;
              break;
            case "endsWith":
              json.pattern = `${escapeStringRegexp(check.value)}$`;
              break;
            case "emoji":
              json.pattern = "^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$";
              break;
            case "nanoid":
              json.pattern = "^[a-zA-Z0-9_-]{21}$";
              break;
            case "cuid2":
              json.pattern = "^[0-9a-z]+$";
              break;
            case "ulid":
              json.pattern = "^[0-9A-HJKMNP-TV-Z]{26}$";
              break;
            case "datetime":
              json.format = Format.DateTime;
              break;
            case "date":
              json.format = Format.Date;
              break;
            case "time":
              json.format = Format.Time;
              break;
            case "duration":
              json.format = Format.Duration;
              break;
            case "ip":
              if (check.version === "v4") json.format = Format.IPv4;
              else if (check.version === "v6") json.format = Format.IPv6;
              else json.anyOf = [{ format: Format.IPv4 }, { format: Format.IPv6 }];
              break;
            case "jwt":
              json.pattern = "^[A-Za-z0-9-_]+\\.[A-Za-z0-9-_]+\\.[A-Za-z0-9-_]*$";
              break;
            case "base64url":
              json.pattern =
                "^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$";
              break;
            default:
              check.kind;
          }
        return [true, json];
      }
      case ZodFirstPartyTypeKind.ZodNumber: {
        const schema_ = schema;
        const json = { type: "number" };
        for (const check of schema_._def.checks)
          switch (check.kind) {
            case "int":
              json.type = "integer";
              break;
            case "min":
              json.minimum = check.value;
              break;
            case "max":
              json.maximum = check.value;
              break;
            case "multipleOf":
              json.multipleOf = check.value;
              break;
            default:
              check.kind;
          }
        return [true, json];
      }
      case ZodFirstPartyTypeKind.ZodBigInt:
        return [
          true,
          {
            type: "string",
            pattern: "^-?[0-9]+$",
            "x-native-type": JsonSchemaXNativeType.BigInt,
          },
        ];
      case ZodFirstPartyTypeKind.ZodNaN:
        return options.strategy === "input"
          ? [true, this.unsupportedJsonSchema]
          : [true, { type: "null" }];
      case ZodFirstPartyTypeKind.ZodBoolean:
        return [true, { type: "boolean" }];
      case ZodFirstPartyTypeKind.ZodDate:
        return [
          true,
          {
            type: "string",
            format: Format.DateTime,
            "x-native-type": JsonSchemaXNativeType.Date,
          },
        ];
      case ZodFirstPartyTypeKind.ZodNull:
        return [true, { type: "null" }];
      case ZodFirstPartyTypeKind.ZodLiteral: {
        const schema_ = schema;
        if (schema_._def.value === void 0) return [false, this.unsupportedJsonSchema];
        return [true, { const: schema_._def.value }];
      }
      case ZodFirstPartyTypeKind.ZodVoid:
      case ZodFirstPartyTypeKind.ZodUndefined:
        return [false, this.unsupportedJsonSchema];
      case ZodFirstPartyTypeKind.ZodUnknown:
      case ZodFirstPartyTypeKind.ZodAny:
        return [false, this.anyJsonSchema];
      case ZodFirstPartyTypeKind.ZodEnum:
        return [
          true,
          {
            enum: schema._def.values,
            type: "string",
          },
        ];
      case ZodFirstPartyTypeKind.ZodNativeEnum: {
        const values = getEnumValues(schema._def.values);
        const json = { enum: values };
        if (values.every((v) => typeof v === "string")) json.type = "string";
        else if (values.every((v) => Number.isFinite(v))) json.type = "number";
        return [true, json];
      }
      case ZodFirstPartyTypeKind.ZodArray: {
        const def2 = schema._def;
        const json = { type: "array" };
        const [itemRequired, itemJson] = this.convert(
          def2.type,
          options,
          lazyDepth,
          false,
          false,
          structureDepth + 1,
        );
        json.items = this.#toArrayItemJsonSchema(itemRequired, itemJson, options.strategy);
        if (def2.exactLength) {
          json.maxItems = def2.exactLength.value;
          json.minItems = def2.exactLength.value;
        }
        if (def2.minLength) json.minItems = def2.minLength.value;
        if (def2.maxLength) json.maxItems = def2.maxLength.value;
        return [true, json];
      }
      case ZodFirstPartyTypeKind.ZodTuple: {
        const schema_ = schema;
        const prefixItems = [];
        const json = { type: "array" };
        for (const item of schema_._def.items) {
          const [itemRequired, itemJson] = this.convert(
            item,
            options,
            lazyDepth,
            false,
            false,
            structureDepth + 1,
          );
          prefixItems.push(this.#toArrayItemJsonSchema(itemRequired, itemJson, options.strategy));
        }
        if (prefixItems?.length) json.prefixItems = prefixItems;
        if (schema_._def.rest) {
          const [itemRequired, itemJson] = this.convert(
            schema_._def.rest,
            options,
            lazyDepth,
            false,
            false,
            structureDepth + 1,
          );
          json.items = this.#toArrayItemJsonSchema(itemRequired, itemJson, options.strategy);
        }
        return [true, json];
      }
      case ZodFirstPartyTypeKind.ZodObject: {
        const schema_ = schema;
        const json = { type: "object" };
        const properties = {};
        const required = [];
        for (const [key, value] of Object.entries(schema_.shape)) {
          const [itemRequired, itemJson] = this.convert(
            value,
            options,
            lazyDepth,
            false,
            false,
            structureDepth + 1,
          );
          properties[key] = itemJson;
          if (itemRequired) required.push(key);
        }
        if (Object.keys(properties).length) json.properties = properties;
        if (required.length) json.required = required;
        if (this.#getZodTypeName(schema_._def.catchall._def) === ZodFirstPartyTypeKind.ZodNever) {
          if (schema_._def.unknownKeys === "strict") json.additionalProperties = false;
        } else {
          const [_, addJson] = this.convert(
            schema_._def.catchall,
            options,
            lazyDepth,
            false,
            false,
            structureDepth + 1,
          );
          json.additionalProperties = addJson;
        }
        return [true, json];
      }
      case ZodFirstPartyTypeKind.ZodRecord: {
        const schema_ = schema;
        const json = { type: "object" };
        const [__, keyJson] = this.convert(
          schema_._def.keyType,
          options,
          lazyDepth,
          false,
          false,
          structureDepth + 1,
        );
        if (Object.entries(keyJson).some(([k, v]) => k !== "type" || v !== "string"))
          json.propertyNames = keyJson;
        const [_, itemJson] = this.convert(
          schema_._def.valueType,
          options,
          lazyDepth,
          false,
          false,
          structureDepth + 1,
        );
        json.additionalProperties = itemJson;
        return [true, json];
      }
      case ZodFirstPartyTypeKind.ZodSet: {
        const schema_ = schema;
        const json = {
          type: "array",
          uniqueItems: true,
          "x-native-type": JsonSchemaXNativeType.Set,
        };
        const [itemRequired, itemJson] = this.convert(
          schema_._def.valueType,
          options,
          lazyDepth,
          false,
          false,
          structureDepth + 1,
        );
        json.items = this.#toArrayItemJsonSchema(itemRequired, itemJson, options.strategy);
        return [true, json];
      }
      case ZodFirstPartyTypeKind.ZodMap: {
        const schema_ = schema;
        const [keyRequired, keyJson] = this.convert(
          schema_._def.keyType,
          options,
          lazyDepth,
          false,
          false,
          structureDepth + 1,
        );
        const [valueRequired, valueJson] = this.convert(
          schema_._def.valueType,
          options,
          lazyDepth,
          false,
          false,
          structureDepth + 1,
        );
        return [
          true,
          {
            type: "array",
            items: {
              type: "array",
              prefixItems: [
                this.#toArrayItemJsonSchema(keyRequired, keyJson, options.strategy),
                this.#toArrayItemJsonSchema(valueRequired, valueJson, options.strategy),
              ],
              maxItems: 2,
              minItems: 2,
            },
            "x-native-type": JsonSchemaXNativeType.Map,
          },
        ];
      }
      case ZodFirstPartyTypeKind.ZodUnion:
      case ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
        const schema_ = schema;
        const anyOf = [];
        let required = true;
        for (const item of schema_._def.options) {
          const [itemRequired, itemJson] = this.convert(
            item,
            options,
            lazyDepth,
            false,
            false,
            structureDepth + 1,
          );
          if (!itemRequired) {
            required = false;
            if (itemJson !== this.unsupportedJsonSchema) anyOf.push(itemJson);
          } else anyOf.push(itemJson);
        }
        return [required, { anyOf }];
      }
      case ZodFirstPartyTypeKind.ZodIntersection: {
        const schema_ = schema;
        const allOf = [];
        let required = false;
        for (const item of [schema_._def.left, schema_._def.right]) {
          const [itemRequired, itemJson] = this.convert(
            item,
            options,
            lazyDepth,
            false,
            false,
            structureDepth + 1,
          );
          allOf.push(itemJson);
          if (itemRequired) required = true;
        }
        return [required, { allOf }];
      }
      case ZodFirstPartyTypeKind.ZodLazy: {
        const currentLazyDepth = lazyDepth + 1;
        if (currentLazyDepth > this.maxLazyDepth) return [false, this.anyJsonSchema];
        const schema_ = schema;
        return this.convert(
          schema_._def.getter(),
          options,
          currentLazyDepth,
          false,
          false,
          structureDepth,
        );
      }
      case ZodFirstPartyTypeKind.ZodOptional: {
        const schema_ = schema;
        const [_, inner] = this.convert(
          schema_._def.innerType,
          options,
          lazyDepth,
          false,
          false,
          structureDepth,
        );
        return [false, inner];
      }
      case ZodFirstPartyTypeKind.ZodReadonly: {
        const schema_ = schema;
        const [required, json] = this.convert(
          schema_._def.innerType,
          options,
          lazyDepth,
          false,
          false,
          structureDepth,
        );
        return [
          required,
          {
            ...json,
            readOnly: true,
          },
        ];
      }
      case ZodFirstPartyTypeKind.ZodDefault: {
        const schema_ = schema;
        const [_, json] = this.convert(
          schema_._def.innerType,
          options,
          lazyDepth,
          false,
          false,
          structureDepth,
        );
        return [
          false,
          {
            default: schema_._def.defaultValue(),
            ...json,
          },
        ];
      }
      case ZodFirstPartyTypeKind.ZodEffects: {
        const schema_ = schema;
        if (schema_._def.effect.type === "transform" && options.strategy === "output")
          return [false, this.anyJsonSchema];
        return this.convert(schema_._def.schema, options, lazyDepth, false, false, structureDepth);
      }
      case ZodFirstPartyTypeKind.ZodCatch: {
        const schema_ = schema;
        return this.convert(
          schema_._def.innerType,
          options,
          lazyDepth,
          false,
          false,
          structureDepth,
        );
      }
      case ZodFirstPartyTypeKind.ZodBranded: {
        const schema_ = schema;
        return this.convert(schema_._def.type, options, lazyDepth, false, false, structureDepth);
      }
      case ZodFirstPartyTypeKind.ZodPipeline: {
        const schema_ = schema;
        return this.convert(
          options.strategy === "input" ? schema_._def.in : schema_._def.out,
          options,
          lazyDepth,
          false,
          false,
          structureDepth,
        );
      }
      case ZodFirstPartyTypeKind.ZodNullable: {
        const schema_ = schema;
        const [required, json] = this.convert(
          schema_._def.innerType,
          options,
          lazyDepth,
          false,
          false,
          structureDepth,
        );
        return [required, { anyOf: [json, { type: "null" }] }];
      }
    }
    return [true, this.unsupportedJsonSchema];
  }
  #handleCustomZodDef(def) {
    const customZodDef = getCustomZodDef(def);
    if (!customZodDef) return;
    switch (customZodDef.type) {
      case "blob":
        return {
          type: "string",
          contentMediaType: "*/*",
        };
      case "file":
        return {
          type: "string",
          contentMediaType: customZodDef.mimeType ?? "*/*",
        };
      case "regexp":
        return {
          type: "string",
          pattern: "^\\/(.*)\\/([a-z]*)$",
          "x-native-type": JsonSchemaXNativeType.RegExp,
        };
      case "url":
        return {
          type: "string",
          format: Format.URI,
          "x-native-type": JsonSchemaXNativeType.Url,
        };
    }
  }
  #getZodTypeName(def) {
    return def.typeName;
  }
  #toArrayItemJsonSchema(required, schema, strategy) {
    if (required) return schema;
    return strategy === "input"
      ? { anyOf: [schema, this.unsupportedJsonSchema] }
      : { anyOf: [schema, { type: "null" }] };
  }
};
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  return Object.entries(entries)
    .filter(([k, _]) => !numericValues.includes(+k))
    .map(([_, v]) => v);
}
//#endregion
//#region node_modules/@orpc/server/dist/plugins/index.mjs
var CORSPlugin = class {
  options;
  order = 9e6;
  constructor(options = {}) {
    const defaults = {
      origin: (origin) => origin,
      allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"],
    };
    this.options = {
      ...defaults,
      ...options,
    };
  }
  init(options) {
    options.rootInterceptors ??= [];
    options.rootInterceptors.unshift(async (interceptorOptions) => {
      if (interceptorOptions.request.method === "OPTIONS") {
        const resHeaders = {};
        if (this.options.maxAge !== void 0)
          resHeaders["access-control-max-age"] = this.options.maxAge.toString();
        if (this.options.allowMethods?.length)
          resHeaders["access-control-allow-methods"] = flattenHeader(this.options.allowMethods);
        const allowHeaders =
          this.options.allowHeaders ??
          interceptorOptions.request.headers["access-control-request-headers"];
        if (typeof allowHeaders === "string" || allowHeaders?.length)
          resHeaders["access-control-allow-headers"] = flattenHeader(allowHeaders);
        return {
          matched: true,
          response: {
            status: 204,
            headers: resHeaders,
            body: void 0,
          },
        };
      }
      return interceptorOptions.next();
    });
    options.rootInterceptors.unshift(async (interceptorOptions) => {
      const result = await interceptorOptions.next();
      if (!result.matched) return result;
      const origin = flattenHeader(interceptorOptions.request.headers.origin) ?? "";
      const allowedOrigin = await value(this.options.origin, origin, interceptorOptions);
      const allowedOriginArr = Array.isArray(allowedOrigin) ? allowedOrigin : [allowedOrigin];
      if (allowedOriginArr.includes("*"))
        result.response.headers["access-control-allow-origin"] = "*";
      else {
        if (allowedOriginArr.includes(origin))
          result.response.headers["access-control-allow-origin"] = origin;
        result.response.headers.vary = interceptorOptions.request.headers.vary ?? "origin";
      }
      const allowedTimingOrigin = await value(
        this.options.timingOrigin,
        origin,
        interceptorOptions,
      );
      const allowedTimingOriginArr = Array.isArray(allowedTimingOrigin)
        ? allowedTimingOrigin
        : [allowedTimingOrigin];
      if (allowedTimingOriginArr.includes("*"))
        result.response.headers["timing-allow-origin"] = "*";
      else if (allowedTimingOriginArr.includes(origin))
        result.response.headers["timing-allow-origin"] = origin;
      if (this.options.credentials)
        result.response.headers["access-control-allow-credentials"] = "true";
      if (this.options.exposeHeaders?.length)
        result.response.headers["access-control-expose-headers"] = flattenHeader(
          this.options.exposeHeaders,
        );
      return result;
    });
  }
};
//#endregion
//#region src/routes/api/$.ts
var handler$1 = new OpenAPIHandler(appRouter, {
  plugins: [
    new CORSPlugin({ origin: "*" }),
    new OpenAPIReferencePlugin({
      docsProvider: "scalar",
      docsPath: "/docs",
      specPath: "/openapi.json",
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specGenerateOptions: {
        info: {
          title: "Things API",
          version: "1.0.0",
          description:
            "oRPC + TanStack Start on Cloudflare Workers. CRUD, streaming, and OpenAPI — all inside a dynamic worker facet.",
        },
      },
    }),
  ],
  interceptors: [onError((error) => console.error("[OpenAPI]", error))],
});
var Route$1 = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: async ({ request, context }) => {
        const { matched, response } = await handler$1.handle(request, {
          prefix: "/api",
          context,
        });
        if (matched && response) return response;
        return new Response("Not Found", { status: 404 });
      },
    },
  },
});
//#endregion
//#region src/routes/api/rpc.$.ts
var handler = new RPCHandler(appRouter, {
  interceptors: [onError((error) => console.error("[RPC]", error))],
});
var Route = createFileRoute("/api/rpc/$")({
  server: {
    handlers: {
      ANY: async ({ request, context }) => {
        const { response } = await handler.handle(request, {
          prefix: "/api/rpc",
          context,
        });
        return response ?? new Response("Not Found", { status: 404 });
      },
    },
  },
});
//#endregion
//#region src/routeTree.gen.ts
var ThingsRoute = Route$6.update({
  id: "/things",
  path: "/things",
  getParentRoute: () => Route$7,
});
var TerminalRoute = Route$5.update({
  id: "/terminal",
  path: "/terminal",
  getParentRoute: () => Route$7,
});
var StreamRoute = Route$4.update({
  id: "/stream",
  path: "/stream",
  getParentRoute: () => Route$7,
});
var IndexRoute = Route$8.update({
  id: "/",
  path: "/",
  getParentRoute: () => Route$7,
});
var ApiRpcWsRoute = Route$3.update({
  id: "/api/rpc-ws",
  path: "/api/rpc-ws",
  getParentRoute: () => Route$7,
});
var ApiPtyRoute = Route$2.update({
  id: "/api/pty",
  path: "/api/pty",
  getParentRoute: () => Route$7,
});
var rootRouteChildren = {
  IndexRoute,
  StreamRoute,
  TerminalRoute,
  ThingsRoute,
  ApiSplatRoute: Route$1.update({
    id: "/api/$",
    path: "/api/$",
    getParentRoute: () => Route$7,
  }),
  ApiPtyRoute,
  ApiRpcWsRoute,
  ApiRpcSplatRoute: Route.update({
    id: "/api/rpc/$",
    path: "/api/rpc/$",
    getParentRoute: () => Route$7,
  }),
};
var routeTree = Route$7._addFileChildren(rootRouteChildren)._addFileTypes();
//#endregion
//#region src/router.tsx
function createRouter() {
  return createRouter$2({
    routeTree,
    scrollRestoration: true,
  });
}
var getRouter = createRouter;
//#endregion
export { createRouter, getRouter };
