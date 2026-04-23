import {
  i as __toESM,
  n as require_react,
  t as require_jsx_runtime,
} from "./jsx-runtime-B9Euz7RS.js";
import {
  F as escapeHtml,
  N as deepEqual,
  l as useHydrated,
  o as useRouter,
  r as useStore,
} from "./__23tanstack-start-server-fn-resolver-CUyURu_5.js";
import {
  E as createNonReactiveReadonlyStore,
  S as RouterCore,
  T as createNonReactiveMutableStore,
  a as createContractedProcedure,
  b as getAssetCrossOrigin,
  c as isProcedure,
  d as unlazy,
  f as resolveFriendlyStandardHandleOptions,
  i as StandardRPCHandler,
  l as resolveContractProcedures,
  m as Outlet,
  n as CompositeStandardHandlerPlugin,
  o as getLazyMeta,
  r as StandardHandler,
  s as getRouter$1,
  t as appRouter,
  u as traverseContractProcedures,
  x as resolveManifestAssetLink,
} from "./router-ORs1rOzB.js";
import {
  a as Link,
  i as createRootRoute,
  n as lazyRouteComponent,
  r as createFileRoute,
  t as Route$5,
} from "./routes-D_CvTT9A.js";
import {
  H as intercept,
  K as onError,
  R as clone,
  W as isObject,
  Z as resolveMaybeOptionalOptions,
  _ as fallbackORPCErrorMessage,
  at as value,
  b as isORPCErrorStatus,
  d as toStandardLazyRequest,
  h as ORPCError,
  it as tryDecodeURIComponent,
  nt as stringifyJSON,
  q as once,
  rt as toArray,
  s as toHttpPath,
  u as toFetchResponse,
  v as fallbackORPCErrorStatus,
  w as flattenHeader,
  z as findDeepMatches,
} from "./client.DrB9nq_G-C5sxXqjr.js";
import {
  i as fallbackContractConfig,
  n as ZodFirstPartyTypeKind,
  o as getEventIteratorSchemaDetails,
} from "./contract-DV24D5zz.js";
import {
  C as hashQueryKeyByOptions,
  D as noop,
  E as matchQuery,
  L as focusManager,
  O as partialMatchKey,
  P as skipToken,
  R as Subscribable,
  S as hashKey,
  T as matchMutation,
  _ as addConsumeAwareSignal,
  a as standardizeHTTPPath,
  b as ensureQueryFn,
  d as Query,
  i as getDynamicParams,
  j as resolveStaleTime,
  l as Mutation,
  m as notifyManager,
  o as StandardBracketNotationSerializer,
  p as onlineManager,
  r as StandardOpenAPISerializer,
  s as QueryClientProvider,
  t as StandardOpenAPIJsonSerializer,
  v as addToEnd,
  x as functionalUpdate,
  y as addToStart,
} from "./openapi-client.B2Q9qU5m-BkcU_lpX.js";
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
var Route$4 = createRootRoute({
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
var $$splitComponentImporter$1 = () => import("./things-83rUVquJ.js");
var Route$3 = createFileRoute("/things")({
  component: lazyRouteComponent($$splitComponentImporter$1, "component"),
});
//#endregion
//#region src/routes/stream.tsx
var $$splitComponentImporter = () => import("./stream-DkjEab4_.js");
var Route$2 = createFileRoute("/stream")({
  component: lazyRouteComponent($$splitComponentImporter, "component"),
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
      ANY: async ({ request }) => {
        const { matched, response } = await handler$1.handle(request, {
          prefix: "/api",
          context: {},
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
      ANY: async ({ request }) => {
        const { response } = await handler.handle(request, {
          prefix: "/api/rpc",
          context: {},
        });
        return response ?? new Response("Not Found", { status: 404 });
      },
    },
  },
});
//#endregion
//#region src/routeTree.gen.ts
var ThingsRoute = Route$3.update({
  id: "/things",
  path: "/things",
  getParentRoute: () => Route$4,
});
var StreamRoute = Route$2.update({
  id: "/stream",
  path: "/stream",
  getParentRoute: () => Route$4,
});
var rootRouteChildren = {
  IndexRoute: Route$5.update({
    id: "/",
    path: "/",
    getParentRoute: () => Route$4,
  }),
  StreamRoute,
  ThingsRoute,
  ApiSplatRoute: Route$1.update({
    id: "/api/$",
    path: "/api/$",
    getParentRoute: () => Route$4,
  }),
  ApiRpcSplatRoute: Route.update({
    id: "/api/rpc/$",
    path: "/api/rpc/$",
    getParentRoute: () => Route$4,
  }),
};
var routeTree = Route$4._addFileChildren(rootRouteChildren)._addFileTypes();
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
