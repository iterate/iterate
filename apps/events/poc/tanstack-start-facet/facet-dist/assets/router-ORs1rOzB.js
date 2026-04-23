import {
  i as __toESM,
  n as require_react,
  t as require_jsx_runtime,
} from "./jsx-runtime-B9Euz7RS.js";
import {
  A as arraysEqual,
  B as isPromise,
  C as findRouteMatch,
  D as createLRUCache,
  E as processRouteTree,
  H as nullReplaceEqualDeep,
  I as functionalUpdate,
  L as isDangerousProtocol,
  M as decodePath,
  N as deepEqual,
  O as invariant,
  P as encodePathLikeUrl,
  S as findFlatMatch,
  T as processRouteMasks,
  U as replaceEqualDeep,
  V as last,
  a as matchContext,
  c as ClientOnly,
  d as isNotFound,
  f as cleanPath,
  g as joinPaths,
  h as interpolatePath,
  j as createControlledPromise,
  k as DEFAULT_PROTOCOL_ALLOWLIST,
  o as useRouter,
  p as compileDecodeCharMap,
  r as useStore,
  u as rootRouteId,
  v as resolvePath,
  w as findSingleMatch,
  x as trimPathRight,
  y as trimPath,
  z as isPlainObject,
} from "./__23tanstack-start-server-fn-resolver-CUyURu_5.js";
import { _ as redirect, h as isRedirect } from "./createServerFn-Df2o8xb7.js";
import {
  $ as runWithSpan,
  C as HibernationEventIterator,
  F as ORPC_NAME,
  H as intercept,
  J as overlayProxy,
  L as asyncIteratorWithSpan,
  P as NullProtoObj,
  U as isAsyncIteratorObject,
  W as isObject,
  Y as parseEmptyableJSON,
  Z as resolveMaybeOptionalOptions,
  a as StandardRPCSerializer,
  at as value,
  et as setSpanError,
  h as ORPCError,
  m as mapEventIterator,
  r as StandardRPCJsonSerializer,
  rt as toArray,
  s as toHttpPath,
  w as flattenHeader,
  x as toORPCError,
} from "./client.DrB9nq_G-C5sxXqjr.js";
import {
  a as getContractRouter,
  c as mergePrefix,
  d as ValidationError,
  f as isContractProcedure,
  l as mergeRoute,
  m as validateORPCError,
  p as mergeErrorMap,
  r as enhanceRoute,
  s as mergeMeta,
  t as appContract,
  u as mergeTags,
} from "./contract-DV24D5zz.js";
//#region node_modules/@tanstack/router-core/dist/esm/scroll-restoration.js
function getSafeSessionStorage() {
  try {
    return typeof window !== "undefined" && typeof window.sessionStorage === "object"
      ? window.sessionStorage
      : void 0;
  } catch {
    return;
  }
}
var storageKey = "tsr-scroll-restoration-v1_3";
function createScrollRestorationCache() {
  const safeSessionStorage = getSafeSessionStorage();
  if (!safeSessionStorage) return null;
  let state = {};
  try {
    const parsed = JSON.parse(safeSessionStorage.getItem("tsr-scroll-restoration-v1_3") || "{}");
    if (isPlainObject(parsed)) state = parsed;
  } catch {}
  const persist = () => {
    try {
      safeSessionStorage.setItem(storageKey, JSON.stringify(state));
    } catch {}
  };
  return {
    get state() {
      return state;
    },
    set: (updater) => {
      state = functionalUpdate(updater, state) || state;
    },
    persist,
  };
}
createScrollRestorationCache();
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/qss.js
/**
 * Program is a reimplementation of the `qss` package:
 * Copyright (c) Luke Edwards luke.edwards05@gmail.com, MIT License
 * https://github.com/lukeed/qss/blob/master/license.md
 *
 * This reimplementation uses modern browser APIs
 * (namely URLSearchParams) and TypeScript while still
 * maintaining the original functionality and interface.
 *
 * Update: this implementation has also been mangled to
 * fit exactly our use-case (single value per key in encoding).
 */
/**
 * Encodes an object into a query string.
 * @param obj - The object to encode into a query string.
 * @param stringify - An optional custom stringify function.
 * @returns The encoded query string.
 * @example
 * ```
 * // Example input: encode({ token: 'foo', key: 'value' })
 * // Expected output: "token=foo&key=value"
 * ```
 */
function encode(obj, stringify = String) {
  const result = new URLSearchParams();
  for (const key in obj) {
    const val = obj[key];
    if (val !== void 0) result.set(key, stringify(val));
  }
  return result.toString();
}
/**
 * Converts a string value to its appropriate type (string, number, boolean).
 * @param mix - The string value to convert.
 * @returns The converted value.
 * @example
 * // Example input: toValue("123")
 * // Expected output: 123
 */
function toValue(str) {
  if (!str) return "";
  if (str === "false") return false;
  if (str === "true") return true;
  return +str * 0 === 0 && +str + "" === str ? +str : str;
}
/**
 * Decodes a query string into an object.
 * @param str - The query string to decode.
 * @returns The decoded key-value pairs in an object format.
 * @example
 * // Example input: decode("token=foo&key=value")
 * // Expected output: { "token": "foo", "key": "value" }
 */
function decode(str) {
  const searchParams = new URLSearchParams(str);
  const result = Object.create(null);
  for (const [key, value] of searchParams.entries()) {
    const previousValue = result[key];
    if (previousValue == null) result[key] = toValue(value);
    else if (Array.isArray(previousValue)) previousValue.push(toValue(value));
    else result[key] = [previousValue, toValue(value)];
  }
  return result;
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/searchParams.js
/** Default `parseSearch` that strips leading '?' and JSON-parses values. */
var defaultParseSearch = parseSearchWith(JSON.parse);
/** Default `stringifySearch` using JSON.stringify for complex values. */
var defaultStringifySearch = stringifySearchWith(JSON.stringify, JSON.parse);
/**
 * Build a `parseSearch` function using a provided JSON-like parser.
 *
 * The returned function strips a leading `?`, decodes values, and attempts to
 * JSON-parse string values using the given `parser`.
 *
 * @param parser Function to parse a string value (e.g. `JSON.parse`).
 * @returns A `parseSearch` function compatible with `Router` options.
 * @link https://tanstack.com/router/latest/docs/framework/react/guide/custom-search-param-serialization
 */
function parseSearchWith(parser) {
  return (searchStr) => {
    if (searchStr[0] === "?") searchStr = searchStr.substring(1);
    const query = decode(searchStr);
    for (const key in query) {
      const value = query[key];
      if (typeof value === "string")
        try {
          query[key] = parser(value);
        } catch (_err) {}
    }
    return query;
  };
}
/**
 * Build a `stringifySearch` function using a provided serializer.
 *
 * Non-primitive values are serialized with `stringify`. If a `parser` is
 * supplied, string values that are parseable are re-serialized to ensure
 * symmetry with `parseSearch`.
 *
 * @param stringify Function to serialize a value (e.g. `JSON.stringify`).
 * @param parser Optional parser to detect parseable strings.
 * @returns A `stringifySearch` function compatible with `Router` options.
 * @link https://tanstack.com/router/latest/docs/framework/react/guide/custom-search-param-serialization
 */
function stringifySearchWith(stringify, parser) {
  const hasParser = typeof parser === "function";
  function stringifyValue(val) {
    if (typeof val === "object" && val !== null)
      try {
        return stringify(val);
      } catch (_err) {}
    else if (hasParser && typeof val === "string")
      try {
        parser(val);
        return stringify(val);
      } catch (_err) {}
    return val;
  }
  return (search) => {
    const searchStr = encode(search, stringifyValue);
    return searchStr ? `?${searchStr}` : "";
  };
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/rewrite.js
/** Compose multiple rewrite pairs into a single in/out rewrite. */
/** Compose multiple rewrite pairs into a single in/out rewrite. */
function composeRewrites(rewrites) {
  return {
    input: ({ url }) => {
      for (const rewrite of rewrites) url = executeRewriteInput(rewrite, url);
      return url;
    },
    output: ({ url }) => {
      for (let i = rewrites.length - 1; i >= 0; i--) url = executeRewriteOutput(rewrites[i], url);
      return url;
    },
  };
}
/** Create a rewrite pair that strips/adds a basepath on input/output. */
/** Create a rewrite pair that strips/adds a basepath on input/output. */
function rewriteBasepath(opts) {
  const trimmedBasepath = trimPath(opts.basepath);
  const normalizedBasepath = `/${trimmedBasepath}`;
  const normalizedBasepathWithSlash = `${normalizedBasepath}/`;
  const checkBasepath = opts.caseSensitive ? normalizedBasepath : normalizedBasepath.toLowerCase();
  const checkBasepathWithSlash = opts.caseSensitive
    ? normalizedBasepathWithSlash
    : normalizedBasepathWithSlash.toLowerCase();
  return {
    input: ({ url }) => {
      const pathname = opts.caseSensitive ? url.pathname : url.pathname.toLowerCase();
      if (pathname === checkBasepath) url.pathname = "/";
      else if (pathname.startsWith(checkBasepathWithSlash))
        url.pathname = url.pathname.slice(normalizedBasepath.length);
      return url;
    },
    output: ({ url }) => {
      url.pathname = joinPaths(["/", trimmedBasepath, url.pathname]);
      return url;
    },
  };
}
/** Execute a location input rewrite if provided. */
/** Execute a location input rewrite if provided. */
function executeRewriteInput(rewrite, url) {
  const res = rewrite?.input?.({ url });
  if (res) {
    if (typeof res === "string") return new URL(res);
    else if (res instanceof URL) return res;
  }
  return url;
}
/** Execute a location output rewrite if provided. */
/** Execute a location output rewrite if provided. */
function executeRewriteOutput(rewrite, url) {
  const res = rewrite?.output?.({ url });
  if (res) {
    if (typeof res === "string") return new URL(res);
    else if (res instanceof URL) return res;
  }
  return url;
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/stores.js
/** SSR non-reactive createMutableStore */
function createNonReactiveMutableStore(initialValue) {
  let value = initialValue;
  return {
    get() {
      return value;
    },
    set(nextOrUpdater) {
      value = functionalUpdate(nextOrUpdater, value);
    },
  };
}
/** SSR non-reactive createReadonlyStore */
function createNonReactiveReadonlyStore(read) {
  return {
    get() {
      return read();
    },
  };
}
function createRouterStores(initialState, config) {
  const { createMutableStore, createReadonlyStore, batch, init } = config;
  const matchStores = /* @__PURE__ */ new Map();
  const pendingMatchStores = /* @__PURE__ */ new Map();
  const cachedMatchStores = /* @__PURE__ */ new Map();
  const status = createMutableStore(initialState.status);
  const loadedAt = createMutableStore(initialState.loadedAt);
  const isLoading = createMutableStore(initialState.isLoading);
  const isTransitioning = createMutableStore(initialState.isTransitioning);
  const location = createMutableStore(initialState.location);
  const resolvedLocation = createMutableStore(initialState.resolvedLocation);
  const statusCode = createMutableStore(initialState.statusCode);
  const redirect = createMutableStore(initialState.redirect);
  const matchesId = createMutableStore([]);
  const pendingIds = createMutableStore([]);
  const cachedIds = createMutableStore([]);
  const matches = createReadonlyStore(() => readPoolMatches(matchStores, matchesId.get()));
  const pendingMatches = createReadonlyStore(() =>
    readPoolMatches(pendingMatchStores, pendingIds.get()),
  );
  const cachedMatches = createReadonlyStore(() =>
    readPoolMatches(cachedMatchStores, cachedIds.get()),
  );
  const firstId = createReadonlyStore(() => matchesId.get()[0]);
  const hasPending = createReadonlyStore(() =>
    matchesId.get().some((matchId) => {
      return matchStores.get(matchId)?.get().status === "pending";
    }),
  );
  const matchRouteDeps = createReadonlyStore(() => ({
    locationHref: location.get().href,
    resolvedLocationHref: resolvedLocation.get()?.href,
    status: status.get(),
  }));
  const __store = createReadonlyStore(() => ({
    status: status.get(),
    loadedAt: loadedAt.get(),
    isLoading: isLoading.get(),
    isTransitioning: isTransitioning.get(),
    matches: matches.get(),
    location: location.get(),
    resolvedLocation: resolvedLocation.get(),
    statusCode: statusCode.get(),
    redirect: redirect.get(),
  }));
  const matchStoreByRouteIdCache = createLRUCache(64);
  function getRouteMatchStore(routeId) {
    let cached = matchStoreByRouteIdCache.get(routeId);
    if (!cached) {
      cached = createReadonlyStore(() => {
        const ids = matchesId.get();
        for (const id of ids) {
          const matchStore = matchStores.get(id);
          if (matchStore && matchStore.routeId === routeId) return matchStore.get();
        }
      });
      matchStoreByRouteIdCache.set(routeId, cached);
    }
    return cached;
  }
  const store = {
    status,
    loadedAt,
    isLoading,
    isTransitioning,
    location,
    resolvedLocation,
    statusCode,
    redirect,
    matchesId,
    pendingIds,
    cachedIds,
    matches,
    pendingMatches,
    cachedMatches,
    firstId,
    hasPending,
    matchRouteDeps,
    matchStores,
    pendingMatchStores,
    cachedMatchStores,
    __store,
    getRouteMatchStore,
    setMatches,
    setPending,
    setCached,
  };
  setMatches(initialState.matches);
  init?.(store);
  function setMatches(nextMatches) {
    reconcileMatchPool(nextMatches, matchStores, matchesId, createMutableStore, batch);
  }
  function setPending(nextMatches) {
    reconcileMatchPool(nextMatches, pendingMatchStores, pendingIds, createMutableStore, batch);
  }
  function setCached(nextMatches) {
    reconcileMatchPool(nextMatches, cachedMatchStores, cachedIds, createMutableStore, batch);
  }
  return store;
}
function readPoolMatches(pool, ids) {
  const matches = [];
  for (const id of ids) {
    const matchStore = pool.get(id);
    if (matchStore) matches.push(matchStore.get());
  }
  return matches;
}
function reconcileMatchPool(nextMatches, pool, idStore, createMutableStore, batch) {
  const nextIds = nextMatches.map((d) => d.id);
  const nextIdSet = new Set(nextIds);
  batch(() => {
    for (const id of pool.keys()) if (!nextIdSet.has(id)) pool.delete(id);
    for (const nextMatch of nextMatches) {
      const existing = pool.get(nextMatch.id);
      if (!existing) {
        const matchStore = createMutableStore(nextMatch);
        matchStore.routeId = nextMatch.routeId;
        pool.set(nextMatch.id, matchStore);
        continue;
      }
      existing.routeId = nextMatch.routeId;
      if (existing.get() !== nextMatch) existing.set(nextMatch);
    }
    if (!arraysEqual(idStore.get(), nextIds)) idStore.set(nextIds);
  });
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/load-matches.js
var triggerOnReady = (inner) => {
  if (!inner.rendered) {
    inner.rendered = true;
    return inner.onReady?.();
  }
};
var resolvePreload = (inner, matchId) => {
  return !!(inner.preload && !inner.router.stores.matchStores.has(matchId));
};
/**
 * Builds the accumulated context from router options and all matches up to (and optionally including) the given index.
 * Merges __routeContext and __beforeLoadContext from each match.
 */
var buildMatchContext = (inner, index, includeCurrentMatch = true) => {
  const context = { ...(inner.router.options.context ?? {}) };
  const end = includeCurrentMatch ? index : index - 1;
  for (let i = 0; i <= end; i++) {
    const innerMatch = inner.matches[i];
    if (!innerMatch) continue;
    const m = inner.router.getMatch(innerMatch.id);
    if (!m) continue;
    Object.assign(context, m.__routeContext, m.__beforeLoadContext);
  }
  return context;
};
var getNotFoundBoundaryIndex = (inner, err) => {
  if (!inner.matches.length) return;
  const requestedRouteId = err.routeId;
  const matchedRootIndex = inner.matches.findIndex((m) => m.routeId === inner.router.routeTree.id);
  const rootIndex = matchedRootIndex >= 0 ? matchedRootIndex : 0;
  let startIndex = requestedRouteId
    ? inner.matches.findIndex((match) => match.routeId === requestedRouteId)
    : (inner.firstBadMatchIndex ?? inner.matches.length - 1);
  if (startIndex < 0) startIndex = rootIndex;
  for (let i = startIndex; i >= 0; i--) {
    const match = inner.matches[i];
    if (inner.router.looseRoutesById[match.routeId].options.notFoundComponent) return i;
  }
  return requestedRouteId ? startIndex : rootIndex;
};
var handleRedirectAndNotFound = (inner, match, err) => {
  if (!isRedirect(err) && !isNotFound(err)) return;
  if (isRedirect(err) && err.redirectHandled && !err.options.reloadDocument) throw err;
  if (match) {
    match._nonReactive.beforeLoadPromise?.resolve();
    match._nonReactive.loaderPromise?.resolve();
    match._nonReactive.beforeLoadPromise = void 0;
    match._nonReactive.loaderPromise = void 0;
    match._nonReactive.error = err;
    inner.updateMatch(match.id, (prev) => ({
      ...prev,
      status: isRedirect(err)
        ? "redirected"
        : isNotFound(err)
          ? "notFound"
          : prev.status === "pending"
            ? "success"
            : prev.status,
      context: buildMatchContext(inner, match.index),
      isFetching: false,
      error: err,
    }));
    if (isNotFound(err) && !err.routeId) err.routeId = match.routeId;
    match._nonReactive.loadPromise?.resolve();
  }
  if (isRedirect(err)) {
    inner.rendered = true;
    err.options._fromLocation = inner.location;
    err.redirectHandled = true;
    err = inner.router.resolveRedirect(err);
  }
  throw err;
};
var shouldSkipLoader = (inner, matchId) => {
  const match = inner.router.getMatch(matchId);
  if (!match) return true;
  if (match.ssr === false) return true;
  return false;
};
var syncMatchContext = (inner, matchId, index) => {
  const nextContext = buildMatchContext(inner, index);
  inner.updateMatch(matchId, (prev) => {
    return {
      ...prev,
      context: nextContext,
    };
  });
};
var handleSerialError = (inner, index, err, routerCode) => {
  const { id: matchId, routeId } = inner.matches[index];
  const route = inner.router.looseRoutesById[routeId];
  if (err instanceof Promise) throw err;
  err.routerCode = routerCode;
  inner.firstBadMatchIndex ??= index;
  handleRedirectAndNotFound(inner, inner.router.getMatch(matchId), err);
  try {
    route.options.onError?.(err);
  } catch (errorHandlerErr) {
    err = errorHandlerErr;
    handleRedirectAndNotFound(inner, inner.router.getMatch(matchId), err);
  }
  inner.updateMatch(matchId, (prev) => {
    prev._nonReactive.beforeLoadPromise?.resolve();
    prev._nonReactive.beforeLoadPromise = void 0;
    prev._nonReactive.loadPromise?.resolve();
    return {
      ...prev,
      error: err,
      status: "error",
      isFetching: false,
      updatedAt: Date.now(),
      abortController: new AbortController(),
    };
  });
  if (!inner.preload && !isRedirect(err) && !isNotFound(err)) inner.serialError ??= err;
};
var isBeforeLoadSsr = (inner, matchId, index, route) => {
  const existingMatch = inner.router.getMatch(matchId);
  const parentMatchId = inner.matches[index - 1]?.id;
  const parentMatch = parentMatchId ? inner.router.getMatch(parentMatchId) : void 0;
  if (inner.router.isShell()) {
    existingMatch.ssr = route.id === rootRouteId;
    return;
  }
  if (parentMatch?.ssr === false) {
    existingMatch.ssr = false;
    return;
  }
  const parentOverride = (tempSsr) => {
    if (tempSsr === true && parentMatch?.ssr === "data-only") return "data-only";
    return tempSsr;
  };
  const defaultSsr = inner.router.options.defaultSsr ?? true;
  if (route.options.ssr === void 0) {
    existingMatch.ssr = parentOverride(defaultSsr);
    return;
  }
  if (typeof route.options.ssr !== "function") {
    existingMatch.ssr = parentOverride(route.options.ssr);
    return;
  }
  const { search, params } = existingMatch;
  const ssrFnContext = {
    search: makeMaybe(search, existingMatch.searchError),
    params: makeMaybe(params, existingMatch.paramsError),
    location: inner.location,
    matches: inner.matches.map((match) => ({
      index: match.index,
      pathname: match.pathname,
      fullPath: match.fullPath,
      staticData: match.staticData,
      id: match.id,
      routeId: match.routeId,
      search: makeMaybe(match.search, match.searchError),
      params: makeMaybe(match.params, match.paramsError),
      ssr: match.ssr,
    })),
  };
  const tempSsr = route.options.ssr(ssrFnContext);
  if (isPromise(tempSsr))
    return tempSsr.then((ssr) => {
      existingMatch.ssr = parentOverride(ssr ?? defaultSsr);
    });
  existingMatch.ssr = parentOverride(tempSsr ?? defaultSsr);
};
var setupPendingTimeout = (inner, matchId, route, match) => {
  if (match._nonReactive.pendingTimeout !== void 0) return;
  route.options.pendingMs ?? inner.router.options.defaultPendingMs;
  if (!!(inner.onReady && false));
};
var preBeforeLoadSetup = (inner, matchId, route) => {
  const existingMatch = inner.router.getMatch(matchId);
  if (!existingMatch._nonReactive.beforeLoadPromise && !existingMatch._nonReactive.loaderPromise)
    return;
  setupPendingTimeout(inner, matchId, route, existingMatch);
  const then = () => {
    const match = inner.router.getMatch(matchId);
    if (match.preload && (match.status === "redirected" || match.status === "notFound"))
      handleRedirectAndNotFound(inner, match, match.error);
  };
  return existingMatch._nonReactive.beforeLoadPromise
    ? existingMatch._nonReactive.beforeLoadPromise.then(then)
    : then();
};
var executeBeforeLoad = (inner, matchId, index, route) => {
  const match = inner.router.getMatch(matchId);
  let prevLoadPromise = match._nonReactive.loadPromise;
  match._nonReactive.loadPromise = createControlledPromise(() => {
    prevLoadPromise?.resolve();
    prevLoadPromise = void 0;
  });
  const { paramsError, searchError } = match;
  if (paramsError) handleSerialError(inner, index, paramsError, "PARSE_PARAMS");
  if (searchError) handleSerialError(inner, index, searchError, "VALIDATE_SEARCH");
  setupPendingTimeout(inner, matchId, route, match);
  const abortController = new AbortController();
  let isPending = false;
  const pending = () => {
    if (isPending) return;
    isPending = true;
    inner.updateMatch(matchId, (prev) => ({
      ...prev,
      isFetching: "beforeLoad",
      fetchCount: prev.fetchCount + 1,
      abortController,
    }));
  };
  const resolve = () => {
    match._nonReactive.beforeLoadPromise?.resolve();
    match._nonReactive.beforeLoadPromise = void 0;
    inner.updateMatch(matchId, (prev) => ({
      ...prev,
      isFetching: false,
    }));
  };
  if (!route.options.beforeLoad) {
    inner.router.batch(() => {
      pending();
      resolve();
    });
    return;
  }
  match._nonReactive.beforeLoadPromise = createControlledPromise();
  const context = {
    ...buildMatchContext(inner, index, false),
    ...match.__routeContext,
  };
  const { search, params, cause } = match;
  const preload = resolvePreload(inner, matchId);
  const beforeLoadFnContext = {
    search,
    abortController,
    params,
    preload,
    context,
    location: inner.location,
    navigate: (opts) =>
      inner.router.navigate({
        ...opts,
        _fromLocation: inner.location,
      }),
    buildLocation: inner.router.buildLocation,
    cause: preload ? "preload" : cause,
    matches: inner.matches,
    routeId: route.id,
    ...inner.router.options.additionalContext,
  };
  const updateContext = (beforeLoadContext) => {
    if (beforeLoadContext === void 0) {
      inner.router.batch(() => {
        pending();
        resolve();
      });
      return;
    }
    if (isRedirect(beforeLoadContext) || isNotFound(beforeLoadContext)) {
      pending();
      handleSerialError(inner, index, beforeLoadContext, "BEFORE_LOAD");
    }
    inner.router.batch(() => {
      pending();
      inner.updateMatch(matchId, (prev) => ({
        ...prev,
        __beforeLoadContext: beforeLoadContext,
      }));
      resolve();
    });
  };
  let beforeLoadContext;
  try {
    beforeLoadContext = route.options.beforeLoad(beforeLoadFnContext);
    if (isPromise(beforeLoadContext)) {
      pending();
      return beforeLoadContext
        .catch((err) => {
          handleSerialError(inner, index, err, "BEFORE_LOAD");
        })
        .then(updateContext);
    }
  } catch (err) {
    pending();
    handleSerialError(inner, index, err, "BEFORE_LOAD");
  }
  updateContext(beforeLoadContext);
};
var handleBeforeLoad = (inner, index) => {
  const { id: matchId, routeId } = inner.matches[index];
  const route = inner.router.looseRoutesById[routeId];
  const serverSsr = () => {
    {
      const maybePromise = isBeforeLoadSsr(inner, matchId, index, route);
      if (isPromise(maybePromise)) return maybePromise.then(queueExecution);
    }
    return queueExecution();
  };
  const execute = () => executeBeforeLoad(inner, matchId, index, route);
  const queueExecution = () => {
    if (shouldSkipLoader(inner, matchId)) return;
    const result = preBeforeLoadSetup(inner, matchId, route);
    return isPromise(result) ? result.then(execute) : execute();
  };
  return serverSsr();
};
var executeHead = (inner, matchId, route) => {
  const match = inner.router.getMatch(matchId);
  if (!match) return;
  if (!route.options.head && !route.options.scripts && !route.options.headers) return;
  const assetContext = {
    ssr: inner.router.options.ssr,
    matches: inner.matches,
    match,
    params: match.params,
    loaderData: match.loaderData,
  };
  return Promise.all([
    route.options.head?.(assetContext),
    route.options.scripts?.(assetContext),
    route.options.headers?.(assetContext),
  ]).then(([headFnContent, scripts, headers]) => {
    return {
      meta: headFnContent?.meta,
      links: headFnContent?.links,
      headScripts: headFnContent?.scripts,
      headers,
      scripts,
      styles: headFnContent?.styles,
    };
  });
};
var getLoaderContext = (inner, matchPromises, matchId, index, route) => {
  const parentMatchPromise = matchPromises[index - 1];
  const { params, loaderDeps, abortController, cause } = inner.router.getMatch(matchId);
  const context = buildMatchContext(inner, index);
  const preload = resolvePreload(inner, matchId);
  return {
    params,
    deps: loaderDeps,
    preload: !!preload,
    parentMatchPromise,
    abortController,
    context,
    location: inner.location,
    navigate: (opts) =>
      inner.router.navigate({
        ...opts,
        _fromLocation: inner.location,
      }),
    cause: preload ? "preload" : cause,
    route,
    ...inner.router.options.additionalContext,
  };
};
var runLoader = async (inner, matchPromises, matchId, index, route) => {
  try {
    const match = inner.router.getMatch(matchId);
    try {
      if (match.ssr === true) loadRouteChunk(route);
      const routeLoader = route.options.loader;
      const loader = typeof routeLoader === "function" ? routeLoader : routeLoader?.handler;
      const loaderResult = loader?.(getLoaderContext(inner, matchPromises, matchId, index, route));
      const loaderResultIsPromise = !!loader && isPromise(loaderResult);
      if (
        !!(
          loaderResultIsPromise ||
          route._lazyPromise ||
          route._componentsPromise ||
          route.options.head ||
          route.options.scripts ||
          route.options.headers ||
          match._nonReactive.minPendingPromise
        )
      )
        inner.updateMatch(matchId, (prev) => ({
          ...prev,
          isFetching: "loader",
        }));
      if (loader) {
        const loaderData = loaderResultIsPromise ? await loaderResult : loaderResult;
        handleRedirectAndNotFound(inner, inner.router.getMatch(matchId), loaderData);
        if (loaderData !== void 0)
          inner.updateMatch(matchId, (prev) => ({
            ...prev,
            loaderData,
          }));
      }
      if (route._lazyPromise) await route._lazyPromise;
      const pendingPromise = match._nonReactive.minPendingPromise;
      if (pendingPromise) await pendingPromise;
      if (route._componentsPromise) await route._componentsPromise;
      inner.updateMatch(matchId, (prev) => ({
        ...prev,
        error: void 0,
        context: buildMatchContext(inner, index),
        status: "success",
        isFetching: false,
        updatedAt: Date.now(),
      }));
    } catch (e) {
      let error = e;
      if (error?.name === "AbortError") {
        if (match.abortController.signal.aborted) {
          match._nonReactive.loaderPromise?.resolve();
          match._nonReactive.loaderPromise = void 0;
          return;
        }
        inner.updateMatch(matchId, (prev) => ({
          ...prev,
          status: prev.status === "pending" ? "success" : prev.status,
          isFetching: false,
          context: buildMatchContext(inner, index),
        }));
        return;
      }
      const pendingPromise = match._nonReactive.minPendingPromise;
      if (pendingPromise) await pendingPromise;
      if (isNotFound(e)) await route.options.notFoundComponent?.preload?.();
      handleRedirectAndNotFound(inner, inner.router.getMatch(matchId), e);
      try {
        route.options.onError?.(e);
      } catch (onErrorError) {
        error = onErrorError;
        handleRedirectAndNotFound(inner, inner.router.getMatch(matchId), onErrorError);
      }
      if (!isRedirect(error) && !isNotFound(error)) await loadRouteChunk(route, ["errorComponent"]);
      inner.updateMatch(matchId, (prev) => ({
        ...prev,
        error,
        context: buildMatchContext(inner, index),
        status: "error",
        isFetching: false,
      }));
    }
  } catch (err) {
    const match = inner.router.getMatch(matchId);
    if (match) match._nonReactive.loaderPromise = void 0;
    handleRedirectAndNotFound(inner, match, err);
  }
};
var loadRouteMatch = async (inner, matchPromises, index) => {
  async function handleLoader(preload, prevMatch, previousRouteMatchId, match, route) {
    const age = Date.now() - prevMatch.updatedAt;
    const staleAge = preload
      ? (route.options.preloadStaleTime ?? inner.router.options.defaultPreloadStaleTime ?? 3e4)
      : (route.options.staleTime ?? inner.router.options.defaultStaleTime ?? 0);
    const shouldReloadOption = route.options.shouldReload;
    const shouldReload =
      typeof shouldReloadOption === "function"
        ? shouldReloadOption(getLoaderContext(inner, matchPromises, matchId, index, route))
        : shouldReloadOption;
    const { status, invalid } = match;
    const staleMatchShouldReload =
      age >= staleAge &&
      (!!inner.forceStaleReload ||
        match.cause === "enter" ||
        (previousRouteMatchId !== void 0 && previousRouteMatchId !== match.id));
    loaderShouldRunAsync =
      status === "success" && (invalid || (shouldReload ?? staleMatchShouldReload));
    if (preload && route.options.preload === false) {
    } else if (loaderShouldRunAsync && !inner.sync && shouldReloadInBackground) {
      loaderIsRunningAsync = true;
      (async () => {
        try {
          await runLoader(inner, matchPromises, matchId, index, route);
          const match = inner.router.getMatch(matchId);
          match._nonReactive.loaderPromise?.resolve();
          match._nonReactive.loadPromise?.resolve();
          match._nonReactive.loaderPromise = void 0;
          match._nonReactive.loadPromise = void 0;
        } catch (err) {
          if (isRedirect(err)) await inner.router.navigate(err.options);
        }
      })();
    } else if (status !== "success" || loaderShouldRunAsync)
      await runLoader(inner, matchPromises, matchId, index, route);
    else syncMatchContext(inner, matchId, index);
  }
  const { id: matchId, routeId } = inner.matches[index];
  let loaderShouldRunAsync = false;
  let loaderIsRunningAsync = false;
  const route = inner.router.looseRoutesById[routeId];
  const routeLoader = route.options.loader;
  const shouldReloadInBackground =
    ((typeof routeLoader === "function" ? void 0 : routeLoader?.staleReloadMode) ??
      inner.router.options.defaultStaleReloadMode) !== "blocking";
  if (shouldSkipLoader(inner, matchId)) {
    if (!inner.router.getMatch(matchId)) return inner.matches[index];
    syncMatchContext(inner, matchId, index);
    return inner.router.getMatch(matchId);
  } else {
    const prevMatch = inner.router.getMatch(matchId);
    const activeIdAtIndex = inner.router.stores.matchesId.get()[index];
    const previousRouteMatchId =
      ((activeIdAtIndex && inner.router.stores.matchStores.get(activeIdAtIndex)) || null)
        ?.routeId === routeId
        ? activeIdAtIndex
        : inner.router.stores.matches.get().find((d) => d.routeId === routeId)?.id;
    const preload = resolvePreload(inner, matchId);
    if (prevMatch._nonReactive.loaderPromise) {
      if (
        prevMatch.status === "success" &&
        !inner.sync &&
        !prevMatch.preload &&
        shouldReloadInBackground
      )
        return prevMatch;
      await prevMatch._nonReactive.loaderPromise;
      const match = inner.router.getMatch(matchId);
      const error = match._nonReactive.error || match.error;
      if (error) handleRedirectAndNotFound(inner, match, error);
      if (match.status === "pending")
        await handleLoader(preload, prevMatch, previousRouteMatchId, match, route);
    } else {
      const nextPreload = preload && !inner.router.stores.matchStores.has(matchId);
      const match = inner.router.getMatch(matchId);
      match._nonReactive.loaderPromise = createControlledPromise();
      if (nextPreload !== match.preload)
        inner.updateMatch(matchId, (prev) => ({
          ...prev,
          preload: nextPreload,
        }));
      await handleLoader(preload, prevMatch, previousRouteMatchId, match, route);
    }
  }
  const match = inner.router.getMatch(matchId);
  if (!loaderIsRunningAsync) {
    match._nonReactive.loaderPromise?.resolve();
    match._nonReactive.loadPromise?.resolve();
    match._nonReactive.loadPromise = void 0;
  }
  clearTimeout(match._nonReactive.pendingTimeout);
  match._nonReactive.pendingTimeout = void 0;
  if (!loaderIsRunningAsync) match._nonReactive.loaderPromise = void 0;
  match._nonReactive.dehydrated = void 0;
  const nextIsFetching = loaderIsRunningAsync ? match.isFetching : false;
  if (nextIsFetching !== match.isFetching || match.invalid !== false) {
    inner.updateMatch(matchId, (prev) => ({
      ...prev,
      isFetching: nextIsFetching,
      invalid: false,
    }));
    return inner.router.getMatch(matchId);
  } else return match;
};
async function loadMatches(arg) {
  const inner = arg;
  const matchPromises = [];
  let beforeLoadNotFound;
  for (let i = 0; i < inner.matches.length; i++) {
    try {
      const beforeLoad = handleBeforeLoad(inner, i);
      if (isPromise(beforeLoad)) await beforeLoad;
    } catch (err) {
      if (isRedirect(err)) throw err;
      if (isNotFound(err)) beforeLoadNotFound = err;
      else if (!inner.preload) throw err;
      break;
    }
    if (inner.serialError || inner.firstBadMatchIndex != null) break;
  }
  const baseMaxIndexExclusive = inner.firstBadMatchIndex ?? inner.matches.length;
  const boundaryIndex =
    beforeLoadNotFound && !inner.preload
      ? getNotFoundBoundaryIndex(inner, beforeLoadNotFound)
      : void 0;
  const maxIndexExclusive =
    beforeLoadNotFound && inner.preload
      ? 0
      : boundaryIndex !== void 0
        ? Math.min(boundaryIndex + 1, baseMaxIndexExclusive)
        : baseMaxIndexExclusive;
  let firstNotFound;
  let firstUnhandledRejection;
  for (let i = 0; i < maxIndexExclusive; i++)
    matchPromises.push(loadRouteMatch(inner, matchPromises, i));
  try {
    await Promise.all(matchPromises);
  } catch {
    const settled = await Promise.allSettled(matchPromises);
    for (const result of settled) {
      if (result.status !== "rejected") continue;
      const reason = result.reason;
      if (isRedirect(reason)) throw reason;
      if (isNotFound(reason)) firstNotFound ??= reason;
      else firstUnhandledRejection ??= reason;
    }
    if (firstUnhandledRejection !== void 0) throw firstUnhandledRejection;
  }
  const notFoundToThrow =
    firstNotFound ?? (beforeLoadNotFound && !inner.preload ? beforeLoadNotFound : void 0);
  let headMaxIndex =
    inner.firstBadMatchIndex !== void 0 ? inner.firstBadMatchIndex : inner.matches.length - 1;
  if (!notFoundToThrow && beforeLoadNotFound && inner.preload) return inner.matches;
  if (notFoundToThrow) {
    const renderedBoundaryIndex = getNotFoundBoundaryIndex(inner, notFoundToThrow);
    if (renderedBoundaryIndex === void 0) invariant();
    const boundaryMatch = inner.matches[renderedBoundaryIndex];
    const boundaryRoute = inner.router.looseRoutesById[boundaryMatch.routeId];
    const defaultNotFoundComponent = inner.router.options?.defaultNotFoundComponent;
    if (!boundaryRoute.options.notFoundComponent && defaultNotFoundComponent)
      boundaryRoute.options.notFoundComponent = defaultNotFoundComponent;
    notFoundToThrow.routeId = boundaryMatch.routeId;
    const boundaryIsRoot = boundaryMatch.routeId === inner.router.routeTree.id;
    inner.updateMatch(boundaryMatch.id, (prev) => ({
      ...prev,
      ...(boundaryIsRoot
        ? {
            status: "success",
            globalNotFound: true,
            error: void 0,
          }
        : {
            status: "notFound",
            error: notFoundToThrow,
          }),
      isFetching: false,
    }));
    headMaxIndex = renderedBoundaryIndex;
    await loadRouteChunk(boundaryRoute, ["notFoundComponent"]);
  } else if (!inner.preload) {
    const rootMatch = inner.matches[0];
    if (!rootMatch.globalNotFound) {
      if (inner.router.getMatch(rootMatch.id)?.globalNotFound)
        inner.updateMatch(rootMatch.id, (prev) => ({
          ...prev,
          globalNotFound: false,
          error: void 0,
        }));
    }
  }
  if (inner.serialError && inner.firstBadMatchIndex !== void 0) {
    const errorRoute =
      inner.router.looseRoutesById[inner.matches[inner.firstBadMatchIndex].routeId];
    await loadRouteChunk(errorRoute, ["errorComponent"]);
  }
  for (let i = 0; i <= headMaxIndex; i++) {
    const { id: matchId, routeId } = inner.matches[i];
    const route = inner.router.looseRoutesById[routeId];
    try {
      const headResult = executeHead(inner, matchId, route);
      if (headResult) {
        const head = await headResult;
        inner.updateMatch(matchId, (prev) => ({
          ...prev,
          ...head,
        }));
      }
    } catch (err) {
      console.error(`Error executing head for route ${routeId}:`, err);
    }
  }
  const readyPromise = triggerOnReady(inner);
  if (isPromise(readyPromise)) await readyPromise;
  if (notFoundToThrow) throw notFoundToThrow;
  if (inner.serialError && !inner.preload && !inner.onReady) throw inner.serialError;
  return inner.matches;
}
function preloadRouteComponents(route, componentTypesToLoad) {
  const preloads = componentTypesToLoad
    .map((type) => route.options[type]?.preload?.())
    .filter(Boolean);
  if (preloads.length === 0) return void 0;
  return Promise.all(preloads);
}
function loadRouteChunk(route, componentTypesToLoad = componentTypes) {
  if (!route._lazyLoaded && route._lazyPromise === void 0)
    if (route.lazyFn)
      route._lazyPromise = route.lazyFn().then((lazyRoute) => {
        const { id: _id, ...options } = lazyRoute.options;
        Object.assign(route.options, options);
        route._lazyLoaded = true;
        route._lazyPromise = void 0;
      });
    else route._lazyLoaded = true;
  const runAfterLazy = () =>
    route._componentsLoaded
      ? void 0
      : componentTypesToLoad === componentTypes
        ? (() => {
            if (route._componentsPromise === void 0) {
              const componentsPromise = preloadRouteComponents(route, componentTypes);
              if (componentsPromise)
                route._componentsPromise = componentsPromise.then(() => {
                  route._componentsLoaded = true;
                  route._componentsPromise = void 0;
                });
              else route._componentsLoaded = true;
            }
            return route._componentsPromise;
          })()
        : preloadRouteComponents(route, componentTypesToLoad);
  return route._lazyPromise ? route._lazyPromise.then(runAfterLazy) : runAfterLazy();
}
function makeMaybe(value, error) {
  if (error)
    return {
      status: "error",
      error,
    };
  return {
    status: "success",
    value,
  };
}
function routeNeedsPreload(route) {
  for (const componentType of componentTypes)
    if (route.options[componentType]?.preload) return true;
  return false;
}
var componentTypes = ["component", "errorComponent", "pendingComponent", "notFoundComponent"];
//#endregion
//#region node_modules/@tanstack/history/dist/esm/index.js
var stateIndexKey = "__TSR_index";
function createHistory(opts) {
  let location = opts.getLocation();
  const subscribers = /* @__PURE__ */ new Set();
  const notify = (action) => {
    location = opts.getLocation();
    subscribers.forEach((subscriber) =>
      subscriber({
        location,
        action,
      }),
    );
  };
  const handleIndexChange = (action) => {
    if (opts.notifyOnIndexChange ?? true) notify(action);
    else location = opts.getLocation();
  };
  const tryNavigation = async ({ task, navigateOpts, ...actionInfo }) => {
    if (navigateOpts?.ignoreBlocker ?? false) {
      task();
      return;
    }
    const blockers = opts.getBlockers?.() ?? [];
    const isPushOrReplace = actionInfo.type === "PUSH" || actionInfo.type === "REPLACE";
    if (typeof document !== "undefined" && blockers.length && isPushOrReplace)
      for (const blocker of blockers) {
        const nextLocation = parseHref(actionInfo.path, actionInfo.state);
        if (
          await blocker.blockerFn({
            currentLocation: location,
            nextLocation,
            action: actionInfo.type,
          })
        ) {
          opts.onBlocked?.();
          return;
        }
      }
    task();
  };
  return {
    get location() {
      return location;
    },
    get length() {
      return opts.getLength();
    },
    subscribers,
    subscribe: (cb) => {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    push: (path, state, navigateOpts) => {
      const currentIndex = location.state[stateIndexKey];
      state = assignKeyAndIndex(currentIndex + 1, state);
      tryNavigation({
        task: () => {
          opts.pushState(path, state);
          notify({ type: "PUSH" });
        },
        navigateOpts,
        type: "PUSH",
        path,
        state,
      });
    },
    replace: (path, state, navigateOpts) => {
      const currentIndex = location.state[stateIndexKey];
      state = assignKeyAndIndex(currentIndex, state);
      tryNavigation({
        task: () => {
          opts.replaceState(path, state);
          notify({ type: "REPLACE" });
        },
        navigateOpts,
        type: "REPLACE",
        path,
        state,
      });
    },
    go: (index, navigateOpts) => {
      tryNavigation({
        task: () => {
          opts.go(index);
          handleIndexChange({
            type: "GO",
            index,
          });
        },
        navigateOpts,
        type: "GO",
      });
    },
    back: (navigateOpts) => {
      tryNavigation({
        task: () => {
          opts.back(navigateOpts?.ignoreBlocker ?? false);
          handleIndexChange({ type: "BACK" });
        },
        navigateOpts,
        type: "BACK",
      });
    },
    forward: (navigateOpts) => {
      tryNavigation({
        task: () => {
          opts.forward(navigateOpts?.ignoreBlocker ?? false);
          handleIndexChange({ type: "FORWARD" });
        },
        navigateOpts,
        type: "FORWARD",
      });
    },
    canGoBack: () => location.state[stateIndexKey] !== 0,
    createHref: (str) => opts.createHref(str),
    block: (blocker) => {
      if (!opts.setBlockers) return () => {};
      const blockers = opts.getBlockers?.() ?? [];
      opts.setBlockers([...blockers, blocker]);
      return () => {
        const blockers = opts.getBlockers?.() ?? [];
        opts.setBlockers?.(blockers.filter((b) => b !== blocker));
      };
    },
    flush: () => opts.flush?.(),
    destroy: () => opts.destroy?.(),
    notify,
  };
}
function assignKeyAndIndex(index, state) {
  if (!state) state = {};
  const key = createRandomKey();
  return {
    ...state,
    key,
    __TSR_key: key,
    [stateIndexKey]: index,
  };
}
/**
 * Create an in-memory history implementation.
 * Ideal for server rendering, tests, and non-DOM environments.
 * @link https://tanstack.com/router/latest/docs/framework/react/guide/history-types
 */
function createMemoryHistory(opts = { initialEntries: ["/"] }) {
  const entries = opts.initialEntries;
  let index = opts.initialIndex
    ? Math.min(Math.max(opts.initialIndex, 0), entries.length - 1)
    : entries.length - 1;
  const states = entries.map((_entry, index) => assignKeyAndIndex(index, void 0));
  const getLocation = () => parseHref(entries[index], states[index]);
  let blockers = [];
  const _getBlockers = () => blockers;
  const _setBlockers = (newBlockers) => (blockers = newBlockers);
  return createHistory({
    getLocation,
    getLength: () => entries.length,
    pushState: (path, state) => {
      if (index < entries.length - 1) {
        entries.splice(index + 1);
        states.splice(index + 1);
      }
      states.push(state);
      entries.push(path);
      index = Math.max(entries.length - 1, 0);
    },
    replaceState: (path, state) => {
      states[index] = state;
      entries[index] = path;
    },
    back: () => {
      index = Math.max(index - 1, 0);
    },
    forward: () => {
      index = Math.min(index + 1, entries.length - 1);
    },
    go: (n) => {
      index = Math.min(Math.max(index + n, 0), entries.length - 1);
    },
    createHref: (path) => path,
    getBlockers: _getBlockers,
    setBlockers: _setBlockers,
  });
}
/**
 * Sanitize a path to prevent open redirect vulnerabilities.
 * Removes control characters and collapses leading double slashes.
 */
function sanitizePath(path) {
  let sanitized = path.replace(/[\x00-\x1f\x7f]/g, "");
  if (sanitized.startsWith("//")) sanitized = "/" + sanitized.replace(/^\/+/, "");
  return sanitized;
}
function parseHref(href, state) {
  const sanitizedHref = sanitizePath(href);
  const hashIndex = sanitizedHref.indexOf("#");
  const searchIndex = sanitizedHref.indexOf("?");
  const addedKey = createRandomKey();
  return {
    href: sanitizedHref,
    pathname: sanitizedHref.substring(
      0,
      hashIndex > 0
        ? searchIndex > 0
          ? Math.min(hashIndex, searchIndex)
          : hashIndex
        : searchIndex > 0
          ? searchIndex
          : sanitizedHref.length,
    ),
    hash: hashIndex > -1 ? sanitizedHref.substring(hashIndex) : "",
    search:
      searchIndex > -1
        ? sanitizedHref.slice(searchIndex, hashIndex === -1 ? void 0 : hashIndex)
        : "",
    state: state || {
      [stateIndexKey]: 0,
      key: addedKey,
      __TSR_key: addedKey,
    },
  };
}
function createRandomKey() {
  return (Math.random() + 1).toString(36).substring(7);
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/router.js
/**
 * Compute whether path, href or hash changed between previous and current
 * resolved locations.
 */
function getLocationChangeInfo(location, resolvedLocation) {
  const fromLocation = resolvedLocation;
  const toLocation = location;
  return {
    fromLocation,
    toLocation,
    pathChanged: fromLocation?.pathname !== toLocation.pathname,
    hrefChanged: fromLocation?.href !== toLocation.href,
    hashChanged: fromLocation?.hash !== toLocation.hash,
  };
}
/**
 * Core, framework-agnostic router engine that powers TanStack Router.
 *
 * Provides navigation, matching, loading, preloading, caching and event APIs
 * used by framework adapters (React/Solid). Prefer framework helpers like
 * `createRouter` in app code.
 *
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/RouterType
 */
var RouterCore = class {
  /**
   * @deprecated Use the `createRouter` function instead
   */
  constructor(options, getStoreConfig) {
    this.tempLocationKey = `${Math.round(Math.random() * 1e7)}`;
    this.resetNextScroll = true;
    this.shouldViewTransition = void 0;
    this.isViewTransitionTypesSupported = void 0;
    this.subscribers = /* @__PURE__ */ new Set();
    this.isScrollRestoring = false;
    this.isScrollRestorationSetup = false;
    this.startTransition = (fn) => fn();
    this.update = (newOptions) => {
      const prevOptions = this.options;
      const prevBasepath = this.basepath ?? prevOptions?.basepath ?? "/";
      const basepathWasUnset = this.basepath === void 0;
      const prevRewriteOption = prevOptions?.rewrite;
      this.options = {
        ...prevOptions,
        ...newOptions,
      };
      this.isServer = this.options.isServer ?? typeof document === "undefined";
      this.protocolAllowlist = new Set(this.options.protocolAllowlist);
      if (this.options.pathParamsAllowedCharacters)
        this.pathParamsDecoder = compileDecodeCharMap(this.options.pathParamsAllowedCharacters);
      if (!this.history || (this.options.history && this.options.history !== this.history))
        if (!this.options.history) {
        } else this.history = this.options.history;
      this.origin = this.options.origin;
      if (!this.origin) this.origin = "http://localhost";
      if (this.history) this.updateLatestLocation();
      if (this.options.routeTree !== this.routeTree) {
        this.routeTree = this.options.routeTree;
        let processRouteTreeResult;
        if (globalThis.__TSR_CACHE__ && globalThis.__TSR_CACHE__.routeTree === this.routeTree) {
          const cached = globalThis.__TSR_CACHE__;
          this.resolvePathCache = cached.resolvePathCache;
          processRouteTreeResult = cached.processRouteTreeResult;
        } else {
          this.resolvePathCache = createLRUCache(1e3);
          processRouteTreeResult = this.buildRouteTree();
          if (globalThis.__TSR_CACHE__ === void 0)
            globalThis.__TSR_CACHE__ = {
              routeTree: this.routeTree,
              processRouteTreeResult,
              resolvePathCache: this.resolvePathCache,
            };
        }
        this.setRoutes(processRouteTreeResult);
      }
      if (!this.stores && this.latestLocation) {
        const config = this.getStoreConfig(this);
        this.batch = config.batch;
        this.stores = createRouterStores(getInitialRouterState(this.latestLocation), config);
      }
      let needsLocationUpdate = false;
      const nextBasepath = this.options.basepath ?? "/";
      const nextRewriteOption = this.options.rewrite;
      if (
        basepathWasUnset ||
        prevBasepath !== nextBasepath ||
        prevRewriteOption !== nextRewriteOption
      ) {
        this.basepath = nextBasepath;
        const rewrites = [];
        const trimmed = trimPath(nextBasepath);
        if (trimmed && trimmed !== "/") rewrites.push(rewriteBasepath({ basepath: nextBasepath }));
        if (nextRewriteOption) rewrites.push(nextRewriteOption);
        this.rewrite =
          rewrites.length === 0
            ? void 0
            : rewrites.length === 1
              ? rewrites[0]
              : composeRewrites(rewrites);
        if (this.history) this.updateLatestLocation();
        needsLocationUpdate = true;
      }
      if (needsLocationUpdate && this.stores) this.stores.location.set(this.latestLocation);
      if (
        typeof window !== "undefined" &&
        "CSS" in window &&
        typeof window.CSS?.supports === "function"
      )
        this.isViewTransitionTypesSupported = window.CSS.supports(
          "selector(:active-view-transition-type(a)",
        );
    };
    this.updateLatestLocation = () => {
      this.latestLocation = this.parseLocation(this.history.location, this.latestLocation);
    };
    this.buildRouteTree = () => {
      const result = processRouteTree(this.routeTree, this.options.caseSensitive, (route, i) => {
        route.init({ originalIndex: i });
      });
      if (this.options.routeMasks) processRouteMasks(this.options.routeMasks, result.processedTree);
      return result;
    };
    this.subscribe = (eventType, fn) => {
      const listener = {
        eventType,
        fn,
      };
      this.subscribers.add(listener);
      return () => {
        this.subscribers.delete(listener);
      };
    };
    this.emit = (routerEvent) => {
      this.subscribers.forEach((listener) => {
        if (listener.eventType === routerEvent.type) listener.fn(routerEvent);
      });
    };
    this.parseLocation = (locationToParse, previousLocation) => {
      const parse = ({ pathname, search, hash, href, state }) => {
        if (!this.rewrite && !/[ \x00-\x1f\x7f\u0080-\uffff]/.test(pathname)) {
          const parsedSearch = this.options.parseSearch(search);
          const searchStr = this.options.stringifySearch(parsedSearch);
          return {
            href: pathname + searchStr + hash,
            publicHref: pathname + searchStr + hash,
            pathname: decodePath(pathname).path,
            external: false,
            searchStr,
            search: nullReplaceEqualDeep(previousLocation?.search, parsedSearch),
            hash: decodePath(hash.slice(1)).path,
            state: replaceEqualDeep(previousLocation?.state, state),
          };
        }
        const fullUrl = new URL(href, this.origin);
        const url = executeRewriteInput(this.rewrite, fullUrl);
        const parsedSearch = this.options.parseSearch(url.search);
        const searchStr = this.options.stringifySearch(parsedSearch);
        url.search = searchStr;
        return {
          href: url.href.replace(url.origin, ""),
          publicHref: href,
          pathname: decodePath(url.pathname).path,
          external: !!this.rewrite && url.origin !== this.origin,
          searchStr,
          search: nullReplaceEqualDeep(previousLocation?.search, parsedSearch),
          hash: decodePath(url.hash.slice(1)).path,
          state: replaceEqualDeep(previousLocation?.state, state),
        };
      };
      const location = parse(locationToParse);
      const { __tempLocation, __tempKey } = location.state;
      if (__tempLocation && (!__tempKey || __tempKey === this.tempLocationKey)) {
        const parsedTempLocation = parse(__tempLocation);
        parsedTempLocation.state.key = location.state.key;
        parsedTempLocation.state.__TSR_key = location.state.__TSR_key;
        delete parsedTempLocation.state.__tempLocation;
        return {
          ...parsedTempLocation,
          maskedLocation: location,
        };
      }
      return location;
    };
    this.resolvePathWithBase = (from, path) => {
      return resolvePath({
        base: from,
        to: cleanPath(path),
        trailingSlash: this.options.trailingSlash,
        cache: this.resolvePathCache,
      });
    };
    this.matchRoutes = (pathnameOrNext, locationSearchOrOpts, opts) => {
      if (typeof pathnameOrNext === "string")
        return this.matchRoutesInternal(
          {
            pathname: pathnameOrNext,
            search: locationSearchOrOpts,
          },
          opts,
        );
      return this.matchRoutesInternal(pathnameOrNext, locationSearchOrOpts);
    };
    this.getMatchedRoutes = (pathname) => {
      return getMatchedRoutes({
        pathname,
        routesById: this.routesById,
        processedTree: this.processedTree,
      });
    };
    this.cancelMatch = (id) => {
      const match = this.getMatch(id);
      if (!match) return;
      match.abortController.abort();
      clearTimeout(match._nonReactive.pendingTimeout);
      match._nonReactive.pendingTimeout = void 0;
    };
    this.cancelMatches = () => {
      this.stores.pendingIds.get().forEach((matchId) => {
        this.cancelMatch(matchId);
      });
      this.stores.matchesId.get().forEach((matchId) => {
        if (this.stores.pendingMatchStores.has(matchId)) return;
        const match = this.stores.matchStores.get(matchId)?.get();
        if (!match) return;
        if (match.status === "pending" || match.isFetching === "loader") this.cancelMatch(matchId);
      });
    };
    this.buildLocation = (opts) => {
      const build = (dest = {}) => {
        const currentLocation =
          dest._fromLocation || this.pendingBuiltLocation || this.latestLocation;
        const lightweightResult = this.matchRoutesLightweight(currentLocation);
        if (dest.from && false);
        const defaultedFromPath =
          dest.unsafeRelative === "path"
            ? currentLocation.pathname
            : (dest.from ?? lightweightResult.fullPath);
        const fromPath = this.resolvePathWithBase(defaultedFromPath, ".");
        const fromSearch = lightweightResult.search;
        const fromParams = Object.assign(Object.create(null), lightweightResult.params);
        const nextTo = dest.to
          ? this.resolvePathWithBase(fromPath, `${dest.to}`)
          : this.resolvePathWithBase(fromPath, ".");
        const nextParams =
          dest.params === false || dest.params === null
            ? Object.create(null)
            : (dest.params ?? true) === true
              ? fromParams
              : Object.assign(fromParams, functionalUpdate(dest.params, fromParams));
        const destMatchResult = this.getMatchedRoutes(nextTo);
        let destRoutes = destMatchResult.matchedRoutes;
        if (
          (!destMatchResult.foundRoute ||
            (destMatchResult.foundRoute.path !== "/" && destMatchResult.routeParams["**"])) &&
          this.options.notFoundRoute
        )
          destRoutes = [...destRoutes, this.options.notFoundRoute];
        if (Object.keys(nextParams).length > 0)
          for (const route of destRoutes) {
            const fn = route.options.params?.stringify ?? route.options.stringifyParams;
            if (fn)
              try {
                Object.assign(nextParams, fn(nextParams));
              } catch {}
          }
        const nextPathname = opts.leaveParams
          ? nextTo
          : decodePath(
              interpolatePath({
                path: nextTo,
                params: nextParams,
                decoder: this.pathParamsDecoder,
                server: this.isServer,
              }).interpolatedPath,
            ).path;
        let nextSearch = fromSearch;
        if (opts._includeValidateSearch && this.options.search?.strict) {
          const validatedSearch = {};
          destRoutes.forEach((route) => {
            if (route.options.validateSearch)
              try {
                Object.assign(
                  validatedSearch,
                  validateSearch(route.options.validateSearch, {
                    ...validatedSearch,
                    ...nextSearch,
                  }),
                );
              } catch {}
          });
          nextSearch = validatedSearch;
        }
        nextSearch = applySearchMiddleware({
          search: nextSearch,
          dest,
          destRoutes,
          _includeValidateSearch: opts._includeValidateSearch,
        });
        nextSearch = nullReplaceEqualDeep(fromSearch, nextSearch);
        const searchStr = this.options.stringifySearch(nextSearch);
        const hash =
          dest.hash === true
            ? currentLocation.hash
            : dest.hash
              ? functionalUpdate(dest.hash, currentLocation.hash)
              : void 0;
        const hashStr = hash ? `#${hash}` : "";
        let nextState =
          dest.state === true
            ? currentLocation.state
            : dest.state
              ? functionalUpdate(dest.state, currentLocation.state)
              : {};
        nextState = replaceEqualDeep(currentLocation.state, nextState);
        const fullPath = `${nextPathname}${searchStr}${hashStr}`;
        let href;
        let publicHref;
        let external = false;
        if (this.rewrite) {
          const url = new URL(fullPath, this.origin);
          const rewrittenUrl = executeRewriteOutput(this.rewrite, url);
          href = url.href.replace(url.origin, "");
          if (rewrittenUrl.origin !== this.origin) {
            publicHref = rewrittenUrl.href;
            external = true;
          } else publicHref = rewrittenUrl.pathname + rewrittenUrl.search + rewrittenUrl.hash;
        } else {
          href = encodePathLikeUrl(fullPath);
          publicHref = href;
        }
        return {
          publicHref,
          href,
          pathname: nextPathname,
          search: nextSearch,
          searchStr,
          state: nextState,
          hash: hash ?? "",
          external,
          unmaskOnReload: dest.unmaskOnReload,
        };
      };
      const buildWithMatches = (dest = {}, maskedDest) => {
        const next = build(dest);
        let maskedNext = maskedDest ? build(maskedDest) : void 0;
        if (!maskedNext) {
          const params = Object.create(null);
          if (this.options.routeMasks) {
            const match = findFlatMatch(next.pathname, this.processedTree);
            if (match) {
              Object.assign(params, match.rawParams);
              const { from: _from, params: maskParams, ...maskProps } = match.route;
              const nextParams =
                maskParams === false || maskParams === null
                  ? Object.create(null)
                  : (maskParams ?? true) === true
                    ? params
                    : Object.assign(params, functionalUpdate(maskParams, params));
              maskedDest = {
                from: opts.from,
                ...maskProps,
                params: nextParams,
              };
              maskedNext = build(maskedDest);
            }
          }
        }
        if (maskedNext) next.maskedLocation = maskedNext;
        return next;
      };
      if (opts.mask)
        return buildWithMatches(opts, {
          from: opts.from,
          ...opts.mask,
        });
      return buildWithMatches(opts);
    };
    this.commitLocation = async ({ viewTransition, ignoreBlocker, ...next }) => {
      const isSameState = () => {
        const ignoredProps = ["key", "__TSR_key", "__TSR_index", "__hashScrollIntoViewOptions"];
        ignoredProps.forEach((prop) => {
          next.state[prop] = this.latestLocation.state[prop];
        });
        const isEqual = deepEqual(next.state, this.latestLocation.state);
        ignoredProps.forEach((prop) => {
          delete next.state[prop];
        });
        return isEqual;
      };
      const isSameUrl = trimPathRight(this.latestLocation.href) === trimPathRight(next.href);
      let previousCommitPromise = this.commitLocationPromise;
      this.commitLocationPromise = createControlledPromise(() => {
        previousCommitPromise?.resolve();
        previousCommitPromise = void 0;
      });
      if (isSameUrl && isSameState()) this.load();
      else {
        let { maskedLocation, hashScrollIntoView, ...nextHistory } = next;
        if (maskedLocation) {
          nextHistory = {
            ...maskedLocation,
            state: {
              ...maskedLocation.state,
              __tempKey: void 0,
              __tempLocation: {
                ...nextHistory,
                search: nextHistory.searchStr,
                state: {
                  ...nextHistory.state,
                  __tempKey: void 0,
                  __tempLocation: void 0,
                  __TSR_key: void 0,
                  key: void 0,
                },
              },
            },
          };
          if (nextHistory.unmaskOnReload ?? this.options.unmaskOnReload ?? false)
            nextHistory.state.__tempKey = this.tempLocationKey;
        }
        nextHistory.state.__hashScrollIntoViewOptions =
          hashScrollIntoView ?? this.options.defaultHashScrollIntoView ?? true;
        this.shouldViewTransition = viewTransition;
        this.history[next.replace ? "replace" : "push"](nextHistory.publicHref, nextHistory.state, {
          ignoreBlocker,
        });
      }
      this.resetNextScroll = next.resetScroll ?? true;
      if (!this.history.subscribers.size) this.load();
      return this.commitLocationPromise;
    };
    this.buildAndCommitLocation = ({
      replace,
      resetScroll,
      hashScrollIntoView,
      viewTransition,
      ignoreBlocker,
      href,
      ...rest
    } = {}) => {
      if (href) {
        const currentIndex = this.history.location.state.__TSR_index;
        const parsed = parseHref(href, { __TSR_index: replace ? currentIndex : currentIndex + 1 });
        const hrefUrl = new URL(parsed.pathname, this.origin);
        rest.to = executeRewriteInput(this.rewrite, hrefUrl).pathname;
        rest.search = this.options.parseSearch(parsed.search);
        rest.hash = parsed.hash.slice(1);
      }
      const location = this.buildLocation({
        ...rest,
        _includeValidateSearch: true,
      });
      this.pendingBuiltLocation = location;
      const commitPromise = this.commitLocation({
        ...location,
        viewTransition,
        replace,
        resetScroll,
        hashScrollIntoView,
        ignoreBlocker,
      });
      Promise.resolve().then(() => {
        if (this.pendingBuiltLocation === location) this.pendingBuiltLocation = void 0;
      });
      return commitPromise;
    };
    this.navigate = async ({ to, reloadDocument, href, publicHref, ...rest }) => {
      let hrefIsUrl = false;
      if (href)
        try {
          new URL(`${href}`);
          hrefIsUrl = true;
        } catch {}
      if (hrefIsUrl && !reloadDocument) reloadDocument = true;
      if (reloadDocument) {
        if (to !== void 0 || !href) {
          const location = this.buildLocation({
            to,
            ...rest,
          });
          href = href ?? location.publicHref;
          publicHref = publicHref ?? location.publicHref;
        }
        const reloadHref = !hrefIsUrl && publicHref ? publicHref : href;
        if (isDangerousProtocol(reloadHref, this.protocolAllowlist)) return Promise.resolve();
        if (!rest.ignoreBlocker) {
          const blockers = this.history.getBlockers?.() ?? [];
          for (const blocker of blockers)
            if (blocker?.blockerFn) {
              if (
                await blocker.blockerFn({
                  currentLocation: this.latestLocation,
                  nextLocation: this.latestLocation,
                  action: "PUSH",
                })
              )
                return Promise.resolve();
            }
        }
        if (rest.replace) window.location.replace(reloadHref);
        else window.location.href = reloadHref;
        return Promise.resolve();
      }
      return this.buildAndCommitLocation({
        ...rest,
        href,
        to,
        _isNavigate: true,
      });
    };
    this.beforeLoad = () => {
      this.cancelMatches();
      this.updateLatestLocation();
      {
        const nextLocation = this.buildLocation({
          to: this.latestLocation.pathname,
          search: true,
          params: true,
          hash: true,
          state: true,
          _includeValidateSearch: true,
        });
        if (this.latestLocation.publicHref !== nextLocation.publicHref) {
          const href = this.getParsedLocationHref(nextLocation);
          if (nextLocation.external) throw redirect({ href });
          else
            throw redirect({
              href,
              _builtLocation: nextLocation,
            });
        }
      }
      const pendingMatches = this.matchRoutes(this.latestLocation);
      const nextCachedMatches = this.stores.cachedMatches
        .get()
        .filter((d) => !pendingMatches.some((e) => e.id === d.id));
      this.batch(() => {
        this.stores.status.set("pending");
        this.stores.statusCode.set(200);
        this.stores.isLoading.set(true);
        this.stores.location.set(this.latestLocation);
        this.stores.setPending(pendingMatches);
        this.stores.setCached(nextCachedMatches);
      });
    };
    this.load = async (opts) => {
      let redirect;
      let notFound;
      let loadPromise;
      const previousLocation = this.stores.resolvedLocation.get() ?? this.stores.location.get();
      loadPromise = new Promise((resolve) => {
        this.startTransition(async () => {
          try {
            this.beforeLoad();
            const next = this.latestLocation;
            const locationChangeInfo = getLocationChangeInfo(
              next,
              this.stores.resolvedLocation.get(),
            );
            if (!this.stores.redirect.get())
              this.emit({
                type: "onBeforeNavigate",
                ...locationChangeInfo,
              });
            this.emit({
              type: "onBeforeLoad",
              ...locationChangeInfo,
            });
            await loadMatches({
              router: this,
              sync: opts?.sync,
              forceStaleReload: previousLocation.href === next.href,
              matches: this.stores.pendingMatches.get(),
              location: next,
              updateMatch: this.updateMatch,
              onReady: async () => {
                this.startTransition(() => {
                  this.startViewTransition(async () => {
                    let exitingMatches = null;
                    let hookExitingMatches = null;
                    let hookEnteringMatches = null;
                    let hookStayingMatches = null;
                    this.batch(() => {
                      const pendingMatches = this.stores.pendingMatches.get();
                      const mountPending = pendingMatches.length;
                      const currentMatches = this.stores.matches.get();
                      exitingMatches = mountPending
                        ? currentMatches.filter(
                            (match) => !this.stores.pendingMatchStores.has(match.id),
                          )
                        : null;
                      const pendingRouteIds = /* @__PURE__ */ new Set();
                      for (const s of this.stores.pendingMatchStores.values())
                        if (s.routeId) pendingRouteIds.add(s.routeId);
                      const activeRouteIds = /* @__PURE__ */ new Set();
                      for (const s of this.stores.matchStores.values())
                        if (s.routeId) activeRouteIds.add(s.routeId);
                      hookExitingMatches = mountPending
                        ? currentMatches.filter((match) => !pendingRouteIds.has(match.routeId))
                        : null;
                      hookEnteringMatches = mountPending
                        ? pendingMatches.filter((match) => !activeRouteIds.has(match.routeId))
                        : null;
                      hookStayingMatches = mountPending
                        ? pendingMatches.filter((match) => activeRouteIds.has(match.routeId))
                        : currentMatches;
                      this.stores.isLoading.set(false);
                      this.stores.loadedAt.set(Date.now());
                      /**
                       * When committing new matches, cache any exiting matches that are still usable.
                       * Routes that resolved with `status: 'error'` or `status: 'notFound'` are
                       * deliberately excluded from `cachedMatches` so that subsequent invalidations
                       * or reloads re-run their loaders instead of reusing the failed/not-found data.
                       */
                      if (mountPending) {
                        this.stores.setMatches(pendingMatches);
                        this.stores.setPending([]);
                        this.stores.setCached([
                          ...this.stores.cachedMatches.get(),
                          ...exitingMatches.filter(
                            (d) =>
                              d.status !== "error" &&
                              d.status !== "notFound" &&
                              d.status !== "redirected",
                          ),
                        ]);
                        this.clearExpiredCache();
                      }
                    });
                    for (const [matches, hook] of [
                      [hookExitingMatches, "onLeave"],
                      [hookEnteringMatches, "onEnter"],
                      [hookStayingMatches, "onStay"],
                    ]) {
                      if (!matches) continue;
                      for (const match of matches)
                        this.looseRoutesById[match.routeId].options[hook]?.(match);
                    }
                  });
                });
              },
            });
          } catch (err) {
            if (isRedirect(err)) redirect = err;
            else if (isNotFound(err)) notFound = err;
            const nextStatusCode = redirect
              ? redirect.status
              : notFound
                ? 404
                : this.stores.matches.get().some((d) => d.status === "error")
                  ? 500
                  : 200;
            this.batch(() => {
              this.stores.statusCode.set(nextStatusCode);
              this.stores.redirect.set(redirect);
            });
          }
          if (this.latestLoadPromise === loadPromise) {
            this.commitLocationPromise?.resolve();
            this.latestLoadPromise = void 0;
            this.commitLocationPromise = void 0;
          }
          resolve();
        });
      });
      this.latestLoadPromise = loadPromise;
      await loadPromise;
      while (this.latestLoadPromise && loadPromise !== this.latestLoadPromise)
        await this.latestLoadPromise;
      let newStatusCode = void 0;
      if (this.hasNotFoundMatch()) newStatusCode = 404;
      else if (this.stores.matches.get().some((d) => d.status === "error")) newStatusCode = 500;
      if (newStatusCode !== void 0) this.stores.statusCode.set(newStatusCode);
    };
    this.startViewTransition = (fn) => {
      const shouldViewTransition = this.shouldViewTransition ?? this.options.defaultViewTransition;
      this.shouldViewTransition = void 0;
      if (
        shouldViewTransition &&
        typeof document !== "undefined" &&
        "startViewTransition" in document &&
        typeof document.startViewTransition === "function"
      ) {
        let startViewTransitionParams;
        if (typeof shouldViewTransition === "object" && this.isViewTransitionTypesSupported) {
          const next = this.latestLocation;
          const prevLocation = this.stores.resolvedLocation.get();
          const resolvedViewTransitionTypes =
            typeof shouldViewTransition.types === "function"
              ? shouldViewTransition.types(getLocationChangeInfo(next, prevLocation))
              : shouldViewTransition.types;
          if (resolvedViewTransitionTypes === false) {
            fn();
            return;
          }
          startViewTransitionParams = {
            update: fn,
            types: resolvedViewTransitionTypes,
          };
        } else startViewTransitionParams = fn;
        document.startViewTransition(startViewTransitionParams);
      } else fn();
    };
    this.updateMatch = (id, updater) => {
      this.startTransition(() => {
        const pendingMatch = this.stores.pendingMatchStores.get(id);
        if (pendingMatch) {
          pendingMatch.set(updater);
          return;
        }
        const activeMatch = this.stores.matchStores.get(id);
        if (activeMatch) {
          activeMatch.set(updater);
          return;
        }
        const cachedMatch = this.stores.cachedMatchStores.get(id);
        if (cachedMatch) {
          const next = updater(cachedMatch.get());
          if (next.status === "redirected") {
            if (this.stores.cachedMatchStores.delete(id))
              this.stores.cachedIds.set((prev) => prev.filter((matchId) => matchId !== id));
          } else cachedMatch.set(next);
        }
      });
    };
    this.getMatch = (matchId) => {
      return (
        this.stores.cachedMatchStores.get(matchId)?.get() ??
        this.stores.pendingMatchStores.get(matchId)?.get() ??
        this.stores.matchStores.get(matchId)?.get()
      );
    };
    this.invalidate = (opts) => {
      const invalidate = (d) => {
        if (opts?.filter?.(d) ?? true)
          return {
            ...d,
            invalid: true,
            ...(opts?.forcePending || d.status === "error" || d.status === "notFound"
              ? {
                  status: "pending",
                  error: void 0,
                }
              : void 0),
          };
        return d;
      };
      this.batch(() => {
        this.stores.setMatches(this.stores.matches.get().map(invalidate));
        this.stores.setCached(this.stores.cachedMatches.get().map(invalidate));
        this.stores.setPending(this.stores.pendingMatches.get().map(invalidate));
      });
      this.shouldViewTransition = false;
      return this.load({ sync: opts?.sync });
    };
    this.getParsedLocationHref = (location) => {
      return location.publicHref || "/";
    };
    this.resolveRedirect = (redirect) => {
      const locationHeader = redirect.headers.get("Location");
      if (!redirect.options.href || redirect.options._builtLocation) {
        const location = redirect.options._builtLocation ?? this.buildLocation(redirect.options);
        const href = this.getParsedLocationHref(location);
        redirect.options.href = href;
        redirect.headers.set("Location", href);
      } else if (locationHeader)
        try {
          const url = new URL(locationHeader);
          if (this.origin && url.origin === this.origin) {
            const href = url.pathname + url.search + url.hash;
            redirect.options.href = href;
            redirect.headers.set("Location", href);
          }
        } catch {}
      if (
        redirect.options.href &&
        !redirect.options._builtLocation &&
        isDangerousProtocol(redirect.options.href, this.protocolAllowlist)
      )
        throw new Error("Redirect blocked: unsafe protocol");
      if (!redirect.headers.get("Location"))
        redirect.headers.set("Location", redirect.options.href);
      return redirect;
    };
    this.clearCache = (opts) => {
      const filter = opts?.filter;
      if (filter !== void 0)
        this.stores.setCached(this.stores.cachedMatches.get().filter((m) => !filter(m)));
      else this.stores.setCached([]);
    };
    this.clearExpiredCache = () => {
      const now = Date.now();
      const filter = (d) => {
        const route = this.looseRoutesById[d.routeId];
        if (!route.options.loader) return true;
        const gcTime =
          (d.preload
            ? (route.options.preloadGcTime ?? this.options.defaultPreloadGcTime)
            : (route.options.gcTime ?? this.options.defaultGcTime)) ?? 300 * 1e3;
        if (d.status === "error") return true;
        return now - d.updatedAt >= gcTime;
      };
      this.clearCache({ filter });
    };
    this.loadRouteChunk = loadRouteChunk;
    this.preloadRoute = async (opts) => {
      const next = opts._builtLocation ?? this.buildLocation(opts);
      let matches = this.matchRoutes(next, {
        throwOnError: true,
        preload: true,
        dest: opts,
      });
      const activeMatchIds = new Set([
        ...this.stores.matchesId.get(),
        ...this.stores.pendingIds.get(),
      ]);
      const loadedMatchIds = new Set([...activeMatchIds, ...this.stores.cachedIds.get()]);
      const matchesToCache = matches.filter((match) => !loadedMatchIds.has(match.id));
      if (matchesToCache.length) {
        const cachedMatches = this.stores.cachedMatches.get();
        this.stores.setCached([...cachedMatches, ...matchesToCache]);
      }
      try {
        matches = await loadMatches({
          router: this,
          matches,
          location: next,
          preload: true,
          updateMatch: (id, updater) => {
            if (activeMatchIds.has(id))
              matches = matches.map((d) => (d.id === id ? updater(d) : d));
            else this.updateMatch(id, updater);
          },
        });
        return matches;
      } catch (err) {
        if (isRedirect(err)) {
          if (err.options.reloadDocument) return;
          return await this.preloadRoute({
            ...err.options,
            _fromLocation: next,
          });
        }
        if (!isNotFound(err)) console.error(err);
        return;
      }
    };
    this.matchRoute = (location, opts) => {
      const matchLocation = {
        ...location,
        to: location.to ? this.resolvePathWithBase(location.from || "", location.to) : void 0,
        params: location.params || {},
        leaveParams: true,
      };
      const next = this.buildLocation(matchLocation);
      if (opts?.pending && this.stores.status.get() !== "pending") return false;
      const baseLocation = (opts?.pending === void 0 ? !this.stores.isLoading.get() : opts.pending)
        ? this.latestLocation
        : this.stores.resolvedLocation.get() || this.stores.location.get();
      const match = findSingleMatch(
        next.pathname,
        opts?.caseSensitive ?? false,
        opts?.fuzzy ?? false,
        baseLocation.pathname,
        this.processedTree,
      );
      if (!match) return false;
      if (location.params) {
        if (!deepEqual(match.rawParams, location.params, { partial: true })) return false;
      }
      if (opts?.includeSearch ?? true)
        return deepEqual(baseLocation.search, next.search, { partial: true })
          ? match.rawParams
          : false;
      return match.rawParams;
    };
    this.hasNotFoundMatch = () => {
      return this.stores.matches.get().some((d) => d.status === "notFound" || d.globalNotFound);
    };
    this.getStoreConfig = getStoreConfig;
    this.update({
      defaultPreloadDelay: 50,
      defaultPendingMs: 1e3,
      defaultPendingMinMs: 500,
      context: void 0,
      ...options,
      caseSensitive: options.caseSensitive ?? false,
      notFoundMode: options.notFoundMode ?? "fuzzy",
      stringifySearch: options.stringifySearch ?? defaultStringifySearch,
      parseSearch: options.parseSearch ?? defaultParseSearch,
      protocolAllowlist: options.protocolAllowlist ?? DEFAULT_PROTOCOL_ALLOWLIST,
    });
    if (typeof document !== "undefined") self.__TSR_ROUTER__ = this;
  }
  isShell() {
    return !!this.options.isShell;
  }
  isPrerendering() {
    return !!this.options.isPrerendering;
  }
  get state() {
    return this.stores.__store.get();
  }
  setRoutes({ routesById, routesByPath, processedTree }) {
    this.routesById = routesById;
    this.routesByPath = routesByPath;
    this.processedTree = processedTree;
    const notFoundRoute = this.options.notFoundRoute;
    if (notFoundRoute) {
      notFoundRoute.init({ originalIndex: 99999999999 });
      this.routesById[notFoundRoute.id] = notFoundRoute;
    }
  }
  get looseRoutesById() {
    return this.routesById;
  }
  getParentContext(parentMatch) {
    return !parentMatch?.id
      ? (this.options.context ?? void 0)
      : (parentMatch.context ?? this.options.context ?? void 0);
  }
  matchRoutesInternal(next, opts) {
    const matchedRoutesResult = this.getMatchedRoutes(next.pathname);
    const { foundRoute, routeParams, parsedParams } = matchedRoutesResult;
    let { matchedRoutes } = matchedRoutesResult;
    let isGlobalNotFound = false;
    if (foundRoute ? foundRoute.path !== "/" && routeParams["**"] : trimPathRight(next.pathname))
      if (this.options.notFoundRoute)
        matchedRoutes = [...matchedRoutes, this.options.notFoundRoute];
      else isGlobalNotFound = true;
    const globalNotFoundRouteId = isGlobalNotFound
      ? findGlobalNotFoundRouteId(this.options.notFoundMode, matchedRoutes)
      : void 0;
    const matches = new Array(matchedRoutes.length);
    const previousActiveMatchesByRouteId = /* @__PURE__ */ new Map();
    for (const store of this.stores.matchStores.values())
      if (store.routeId) previousActiveMatchesByRouteId.set(store.routeId, store.get());
    for (let index = 0; index < matchedRoutes.length; index++) {
      const route = matchedRoutes[index];
      const parentMatch = matches[index - 1];
      let preMatchSearch;
      let strictMatchSearch;
      let searchError;
      {
        const parentSearch = parentMatch?.search ?? next.search;
        const parentStrictSearch = parentMatch?._strictSearch ?? void 0;
        try {
          const strictSearch =
            validateSearch(route.options.validateSearch, { ...parentSearch }) ?? void 0;
          preMatchSearch = {
            ...parentSearch,
            ...strictSearch,
          };
          strictMatchSearch = {
            ...parentStrictSearch,
            ...strictSearch,
          };
          searchError = void 0;
        } catch (err) {
          let searchParamError = err;
          if (!(err instanceof SearchParamError))
            searchParamError = new SearchParamError(err.message, { cause: err });
          if (opts?.throwOnError) throw searchParamError;
          preMatchSearch = parentSearch;
          strictMatchSearch = {};
          searchError = searchParamError;
        }
      }
      const loaderDeps = route.options.loaderDeps?.({ search: preMatchSearch }) ?? "";
      const loaderDepsHash = loaderDeps ? JSON.stringify(loaderDeps) : "";
      const { interpolatedPath, usedParams } = interpolatePath({
        path: route.fullPath,
        params: routeParams,
        decoder: this.pathParamsDecoder,
        server: this.isServer,
      });
      const matchId = route.id + interpolatedPath + loaderDepsHash;
      const existingMatch = this.getMatch(matchId);
      const previousMatch = previousActiveMatchesByRouteId.get(route.id);
      const strictParams = existingMatch?._strictParams ?? usedParams;
      let paramsError = void 0;
      if (!existingMatch)
        try {
          extractStrictParams(route, usedParams, parsedParams, strictParams);
        } catch (err) {
          if (isNotFound(err) || isRedirect(err)) paramsError = err;
          else paramsError = new PathParamError(err.message, { cause: err });
          if (opts?.throwOnError) throw paramsError;
        }
      Object.assign(routeParams, strictParams);
      const cause = previousMatch ? "stay" : "enter";
      let match;
      if (existingMatch)
        match = {
          ...existingMatch,
          cause,
          params: previousMatch?.params ?? routeParams,
          _strictParams: strictParams,
          search: previousMatch
            ? nullReplaceEqualDeep(previousMatch.search, preMatchSearch)
            : nullReplaceEqualDeep(existingMatch.search, preMatchSearch),
          _strictSearch: strictMatchSearch,
        };
      else {
        const status =
          route.options.loader ||
          route.options.beforeLoad ||
          route.lazyFn ||
          routeNeedsPreload(route)
            ? "pending"
            : "success";
        match = {
          id: matchId,
          ssr: void 0,
          index,
          routeId: route.id,
          params: previousMatch?.params ?? routeParams,
          _strictParams: strictParams,
          pathname: interpolatedPath,
          updatedAt: Date.now(),
          search: previousMatch
            ? nullReplaceEqualDeep(previousMatch.search, preMatchSearch)
            : preMatchSearch,
          _strictSearch: strictMatchSearch,
          searchError: void 0,
          status,
          isFetching: false,
          error: void 0,
          paramsError,
          __routeContext: void 0,
          _nonReactive: { loadPromise: createControlledPromise() },
          __beforeLoadContext: void 0,
          context: {},
          abortController: new AbortController(),
          fetchCount: 0,
          cause,
          loaderDeps: previousMatch
            ? replaceEqualDeep(previousMatch.loaderDeps, loaderDeps)
            : loaderDeps,
          invalid: false,
          preload: false,
          links: void 0,
          scripts: void 0,
          headScripts: void 0,
          meta: void 0,
          staticData: route.options.staticData || {},
          fullPath: route.fullPath,
        };
      }
      if (!opts?.preload) match.globalNotFound = globalNotFoundRouteId === route.id;
      match.searchError = searchError;
      const parentContext = this.getParentContext(parentMatch);
      match.context = {
        ...parentContext,
        ...match.__routeContext,
        ...match.__beforeLoadContext,
      };
      matches[index] = match;
    }
    for (let index = 0; index < matches.length; index++) {
      const match = matches[index];
      const route = this.looseRoutesById[match.routeId];
      const existingMatch = this.getMatch(match.id);
      const previousMatch = previousActiveMatchesByRouteId.get(match.routeId);
      match.params = previousMatch
        ? nullReplaceEqualDeep(previousMatch.params, routeParams)
        : routeParams;
      if (!existingMatch) {
        const parentMatch = matches[index - 1];
        const parentContext = this.getParentContext(parentMatch);
        if (route.options.context) {
          const contextFnContext = {
            deps: match.loaderDeps,
            params: match.params,
            context: parentContext ?? {},
            location: next,
            navigate: (opts) =>
              this.navigate({
                ...opts,
                _fromLocation: next,
              }),
            buildLocation: this.buildLocation,
            cause: match.cause,
            abortController: match.abortController,
            preload: !!match.preload,
            matches,
            routeId: route.id,
          };
          match.__routeContext = route.options.context(contextFnContext) ?? void 0;
        }
        match.context = {
          ...parentContext,
          ...match.__routeContext,
          ...match.__beforeLoadContext,
        };
      }
    }
    return matches;
  }
  /**
   * Lightweight route matching for buildLocation.
   * Only computes fullPath, accumulated search, and params - skipping expensive
   * operations like AbortController, ControlledPromise, loaderDeps, and full match objects.
   */
  matchRoutesLightweight(location) {
    const { matchedRoutes, routeParams, parsedParams } = this.getMatchedRoutes(location.pathname);
    const lastRoute = last(matchedRoutes);
    const accumulatedSearch = { ...location.search };
    for (const route of matchedRoutes)
      try {
        Object.assign(
          accumulatedSearch,
          validateSearch(route.options.validateSearch, accumulatedSearch),
        );
      } catch {}
    const lastStateMatchId = last(this.stores.matchesId.get());
    const lastStateMatch = lastStateMatchId && this.stores.matchStores.get(lastStateMatchId)?.get();
    const canReuseParams =
      lastStateMatch &&
      lastStateMatch.routeId === lastRoute.id &&
      lastStateMatch.pathname === location.pathname;
    let params;
    if (canReuseParams) params = lastStateMatch.params;
    else {
      const strictParams = Object.assign(Object.create(null), routeParams);
      for (const route of matchedRoutes)
        try {
          extractStrictParams(route, routeParams, parsedParams ?? {}, strictParams);
        } catch {}
      params = strictParams;
    }
    return {
      matchedRoutes,
      fullPath: lastRoute.fullPath,
      search: accumulatedSearch,
      params,
    };
  }
};
/** Error thrown when search parameter validation fails. */
var SearchParamError = class extends Error {};
/** Error thrown when path parameter parsing/validation fails. */
var PathParamError = class extends Error {};
/** Create an initial RouterState from a parsed location. */
function getInitialRouterState(location) {
  return {
    loadedAt: 0,
    isLoading: false,
    isTransitioning: false,
    status: "idle",
    resolvedLocation: void 0,
    location,
    matches: [],
    statusCode: 200,
  };
}
function validateSearch(validateSearch, input) {
  if (validateSearch == null) return {};
  if ("~standard" in validateSearch) {
    const result = validateSearch["~standard"].validate(input);
    if (result instanceof Promise) throw new SearchParamError("Async validation not supported");
    if (result.issues)
      throw new SearchParamError(JSON.stringify(result.issues, void 0, 2), { cause: result });
    return result.value;
  }
  if ("parse" in validateSearch) return validateSearch.parse(input);
  if (typeof validateSearch === "function") return validateSearch(input);
  return {};
}
/**
 * Build the matched route chain and extract params for a pathname.
 * Falls back to the root route if no specific route is found.
 */
function getMatchedRoutes({ pathname, routesById, processedTree }) {
  const routeParams = Object.create(null);
  const trimmedPath = trimPathRight(pathname);
  let foundRoute = void 0;
  let parsedParams = void 0;
  const match = findRouteMatch(trimmedPath, processedTree, true);
  if (match) {
    foundRoute = match.route;
    Object.assign(routeParams, match.rawParams);
    parsedParams = Object.assign(Object.create(null), match.parsedParams);
  }
  return {
    matchedRoutes: match?.branch || [routesById["__root__"]],
    routeParams,
    foundRoute,
    parsedParams,
  };
}
/**
 * TODO: once caches are persisted across requests on the server,
 * we can cache the built middleware chain using `last(destRoutes)` as the key
 */
function applySearchMiddleware({ search, dest, destRoutes, _includeValidateSearch }) {
  return buildMiddlewareChain(destRoutes)(search, dest, _includeValidateSearch ?? false);
}
function buildMiddlewareChain(destRoutes) {
  const context = {
    dest: null,
    _includeValidateSearch: false,
    middlewares: [],
  };
  for (const route of destRoutes) {
    if ("search" in route.options) {
      if (route.options.search?.middlewares)
        context.middlewares.push(...route.options.search.middlewares);
    } else if (route.options.preSearchFilters || route.options.postSearchFilters) {
      const legacyMiddleware = ({ search, next }) => {
        let nextSearch = search;
        if ("preSearchFilters" in route.options && route.options.preSearchFilters)
          nextSearch = route.options.preSearchFilters.reduce((prev, next) => next(prev), search);
        const result = next(nextSearch);
        if ("postSearchFilters" in route.options && route.options.postSearchFilters)
          return route.options.postSearchFilters.reduce((prev, next) => next(prev), result);
        return result;
      };
      context.middlewares.push(legacyMiddleware);
    }
    if (route.options.validateSearch) {
      const validate = ({ search, next }) => {
        const result = next(search);
        if (!context._includeValidateSearch) return result;
        try {
          return {
            ...result,
            ...(validateSearch(route.options.validateSearch, result) ?? void 0),
          };
        } catch {
          return result;
        }
      };
      context.middlewares.push(validate);
    }
  }
  const final = ({ search }) => {
    const dest = context.dest;
    if (!dest.search) return {};
    if (dest.search === true) return search;
    return functionalUpdate(dest.search, search);
  };
  context.middlewares.push(final);
  const applyNext = (index, currentSearch, middlewares) => {
    if (index >= middlewares.length) return currentSearch;
    const middleware = middlewares[index];
    const next = (newSearch) => {
      return applyNext(index + 1, newSearch, middlewares);
    };
    return middleware({
      search: currentSearch,
      next,
    });
  };
  return function middleware(search, dest, _includeValidateSearch) {
    context.dest = dest;
    context._includeValidateSearch = _includeValidateSearch;
    return applyNext(0, search, context.middlewares);
  };
}
function findGlobalNotFoundRouteId(notFoundMode, routes) {
  if (notFoundMode !== "root")
    for (let i = routes.length - 1; i >= 0; i--) {
      const route = routes[i];
      if (route.children) return route.id;
    }
  return rootRouteId;
}
function extractStrictParams(route, referenceParams, parsedParams, accumulatedParams) {
  const parseParams = route.options.params?.parse ?? route.options.parseParams;
  if (parseParams)
    if (route.options.skipRouteOnParseError) {
      for (const key in referenceParams)
        if (key in parsedParams) accumulatedParams[key] = parsedParams[key];
    } else {
      const result = parseParams(accumulatedParams);
      Object.assign(accumulatedParams, result);
    }
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/manifest.js
function getAssetCrossOrigin(assetCrossOrigin, kind) {
  if (!assetCrossOrigin) return;
  if (typeof assetCrossOrigin === "string") return assetCrossOrigin;
  return assetCrossOrigin[kind];
}
function resolveManifestAssetLink(link) {
  if (typeof link === "string")
    return {
      href: link,
      crossOrigin: void 0,
    };
  return link;
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/CatchBoundary.js
var import_react = /* @__PURE__ */ __toESM(require_react(), 1);
var import_jsx_runtime = require_jsx_runtime();
function CatchBoundary(props) {
  const errorComponent = props.errorComponent ?? ErrorComponent;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CatchBoundaryImpl, {
    getResetKey: props.getResetKey,
    onCatch: props.onCatch,
    children: ({ error, reset }) => {
      if (error)
        return import_react.createElement(errorComponent, {
          error,
          reset,
        });
      return props.children;
    },
  });
}
var CatchBoundaryImpl = class extends import_react.Component {
  constructor(..._args) {
    super(..._args);
    this.state = { error: null };
  }
  static getDerivedStateFromProps(props, state) {
    const resetKey = props.getResetKey();
    if (state.error && state.resetKey !== resetKey)
      return {
        resetKey,
        error: null,
      };
    return { resetKey };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  reset() {
    this.setState({ error: null });
  }
  componentDidCatch(error, errorInfo) {
    if (this.props.onCatch) this.props.onCatch(error, errorInfo);
  }
  render() {
    return this.props.children({
      error: this.state.error,
      reset: () => {
        this.reset();
      },
    });
  }
};
function ErrorComponent({ error }) {
  const [show, setShow] = import_react.useState(false);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
    style: {
      padding: ".5rem",
      maxWidth: "100%",
    },
    children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: ".5rem",
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", {
            style: { fontSize: "1rem" },
            children: "Something went wrong!",
          }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
            style: {
              appearance: "none",
              fontSize: ".6em",
              border: "1px solid currentColor",
              padding: ".1rem .2rem",
              fontWeight: "bold",
              borderRadius: ".25rem",
            },
            onClick: () => setShow((d) => !d),
            children: show ? "Hide Error" : "Show Error",
          }),
        ],
      }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { height: ".25rem" } }),
      show
        ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
            children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
              style: {
                fontSize: ".7em",
                border: "1px solid red",
                borderRadius: ".25rem",
                padding: ".3rem",
                color: "red",
                overflow: "auto",
              },
              children: error.message
                ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: error.message })
                : null,
            }),
          })
        : null,
    ],
  });
}
//#endregion
//#region node_modules/@tanstack/store/dist/esm/alien.js
var ReactiveFlags = /* @__PURE__ */ ((ReactiveFlags2) => {
  ReactiveFlags2[(ReactiveFlags2["None"] = 0)] = "None";
  ReactiveFlags2[(ReactiveFlags2["Mutable"] = 1)] = "Mutable";
  ReactiveFlags2[(ReactiveFlags2["Watching"] = 2)] = "Watching";
  ReactiveFlags2[(ReactiveFlags2["RecursedCheck"] = 4)] = "RecursedCheck";
  ReactiveFlags2[(ReactiveFlags2["Recursed"] = 8)] = "Recursed";
  ReactiveFlags2[(ReactiveFlags2["Dirty"] = 16)] = "Dirty";
  ReactiveFlags2[(ReactiveFlags2["Pending"] = 32)] = "Pending";
  return ReactiveFlags2;
})(ReactiveFlags || {});
/* @__NO_SIDE_EFFECTS__ */
function createReactiveSystem({ update, notify, unwatched }) {
  return {
    link,
    unlink,
    propagate,
    checkDirty,
    shallowPropagate,
  };
  function link(dep, sub, version) {
    const prevDep = sub.depsTail;
    if (prevDep !== void 0 && prevDep.dep === dep) return;
    const nextDep = prevDep !== void 0 ? prevDep.nextDep : sub.deps;
    if (nextDep !== void 0 && nextDep.dep === dep) {
      nextDep.version = version;
      sub.depsTail = nextDep;
      return;
    }
    const prevSub = dep.subsTail;
    if (prevSub !== void 0 && prevSub.version === version && prevSub.sub === sub) return;
    const newLink =
      (sub.depsTail =
      dep.subsTail =
        {
          version,
          dep,
          sub,
          prevDep,
          nextDep,
          prevSub,
          nextSub: void 0,
        });
    if (nextDep !== void 0) nextDep.prevDep = newLink;
    if (prevDep !== void 0) prevDep.nextDep = newLink;
    else sub.deps = newLink;
    if (prevSub !== void 0) prevSub.nextSub = newLink;
    else dep.subs = newLink;
  }
  function unlink(link2, sub = link2.sub) {
    const dep = link2.dep;
    const prevDep = link2.prevDep;
    const nextDep = link2.nextDep;
    const nextSub = link2.nextSub;
    const prevSub = link2.prevSub;
    if (nextDep !== void 0) nextDep.prevDep = prevDep;
    else sub.depsTail = prevDep;
    if (prevDep !== void 0) prevDep.nextDep = nextDep;
    else sub.deps = nextDep;
    if (nextSub !== void 0) nextSub.prevSub = prevSub;
    else dep.subsTail = prevSub;
    if (prevSub !== void 0) prevSub.nextSub = nextSub;
    else if ((dep.subs = nextSub) === void 0) unwatched(dep);
    return nextDep;
  }
  function propagate(link2) {
    let next = link2.nextSub;
    let stack;
    top: do {
      const sub = link2.sub;
      let flags = sub.flags;
      if (!(flags & 60)) sub.flags = flags | 32;
      else if (!(flags & 12)) flags = 0;
      else if (!(flags & 4)) sub.flags = (flags & -9) | 32;
      else if (!(flags & 48) && isValidLink(link2, sub)) {
        sub.flags = flags | 40;
        flags &= 1;
      } else flags = 0;
      if (flags & 2) notify(sub);
      if (flags & 1) {
        const subSubs = sub.subs;
        if (subSubs !== void 0) {
          const nextSub = (link2 = subSubs).nextSub;
          if (nextSub !== void 0) {
            stack = {
              value: next,
              prev: stack,
            };
            next = nextSub;
          }
          continue;
        }
      }
      if ((link2 = next) !== void 0) {
        next = link2.nextSub;
        continue;
      }
      while (stack !== void 0) {
        link2 = stack.value;
        stack = stack.prev;
        if (link2 !== void 0) {
          next = link2.nextSub;
          continue top;
        }
      }
      break;
    } while (true);
  }
  function checkDirty(link2, sub) {
    let stack;
    let checkDepth = 0;
    let dirty = false;
    top: do {
      const dep = link2.dep;
      const flags = dep.flags;
      if (sub.flags & 16) dirty = true;
      else if ((flags & 17) === 17) {
        if (update(dep)) {
          const subs = dep.subs;
          if (subs.nextSub !== void 0) shallowPropagate(subs);
          dirty = true;
        }
      } else if ((flags & 33) === 33) {
        if (link2.nextSub !== void 0 || link2.prevSub !== void 0)
          stack = {
            value: link2,
            prev: stack,
          };
        link2 = dep.deps;
        sub = dep;
        ++checkDepth;
        continue;
      }
      if (!dirty) {
        const nextDep = link2.nextDep;
        if (nextDep !== void 0) {
          link2 = nextDep;
          continue;
        }
      }
      while (checkDepth--) {
        const firstSub = sub.subs;
        const hasMultipleSubs = firstSub.nextSub !== void 0;
        if (hasMultipleSubs) {
          link2 = stack.value;
          stack = stack.prev;
        } else link2 = firstSub;
        if (dirty) {
          if (update(sub)) {
            if (hasMultipleSubs) shallowPropagate(firstSub);
            sub = link2.sub;
            continue;
          }
          dirty = false;
        } else sub.flags &= -33;
        sub = link2.sub;
        const nextDep = link2.nextDep;
        if (nextDep !== void 0) {
          link2 = nextDep;
          continue top;
        }
      }
      return dirty;
    } while (true);
  }
  function shallowPropagate(link2) {
    do {
      const sub = link2.sub;
      const flags = sub.flags;
      if ((flags & 48) === 32) {
        sub.flags = flags | 16;
        if ((flags & 6) === 2) notify(sub);
      }
    } while ((link2 = link2.nextSub) !== void 0);
  }
  function isValidLink(checkLink, sub) {
    let link2 = sub.depsTail;
    while (link2 !== void 0) {
      if (link2 === checkLink) return true;
      link2 = link2.prevDep;
    }
    return false;
  }
}
//#endregion
//#region node_modules/@tanstack/store/dist/esm/atom.js
function toObserver(nextHandler, errorHandler, completionHandler) {
  const isObserver = typeof nextHandler === "object";
  const self = isObserver ? nextHandler : void 0;
  return {
    next: (isObserver ? nextHandler.next : nextHandler)?.bind(self),
    error: (isObserver ? nextHandler.error : errorHandler)?.bind(self),
    complete: (isObserver ? nextHandler.complete : completionHandler)?.bind(self),
  };
}
var queuedEffects = [];
var cycle = 0;
var { link, unlink, propagate, checkDirty, shallowPropagate } =
  /* @__PURE__ */ createReactiveSystem({
    update(atom) {
      return atom._update();
    },
    notify(effect2) {
      queuedEffects[queuedEffectsLength++] = effect2;
      effect2.flags &= ~ReactiveFlags.Watching;
    },
    unwatched(atom) {
      if (atom.depsTail !== void 0) {
        atom.depsTail = void 0;
        atom.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
        purgeDeps(atom);
      }
    },
  });
var notifyIndex = 0;
var queuedEffectsLength = 0;
var activeSub;
var batchDepth = 0;
function batch(fn) {
  try {
    ++batchDepth;
    fn();
  } finally {
    if (!--batchDepth) flush();
  }
}
function purgeDeps(sub) {
  const depsTail = sub.depsTail;
  let dep = depsTail !== void 0 ? depsTail.nextDep : sub.deps;
  while (dep !== void 0) dep = unlink(dep, sub);
}
function flush() {
  if (batchDepth > 0) return;
  while (notifyIndex < queuedEffectsLength) {
    const effect2 = queuedEffects[notifyIndex];
    queuedEffects[notifyIndex++] = void 0;
    effect2.notify();
  }
  notifyIndex = 0;
  queuedEffectsLength = 0;
}
function createAtom(valueOrFn, options) {
  const isComputed = typeof valueOrFn === "function";
  const getter = valueOrFn;
  const atom = {
    _snapshot: isComputed ? void 0 : valueOrFn,
    subs: void 0,
    subsTail: void 0,
    deps: void 0,
    depsTail: void 0,
    flags: isComputed ? ReactiveFlags.None : ReactiveFlags.Mutable,
    get() {
      if (activeSub !== void 0) link(atom, activeSub, cycle);
      return atom._snapshot;
    },
    subscribe(observerOrFn) {
      const obs = toObserver(observerOrFn);
      const observed = { current: false };
      const e = effect(() => {
        atom.get();
        if (!observed.current) observed.current = true;
        else obs.next?.(atom._snapshot);
      });
      return {
        unsubscribe: () => {
          e.stop();
        },
      };
    },
    _update(getValue) {
      const prevSub = activeSub;
      const compare = options?.compare ?? Object.is;
      if (isComputed) {
        activeSub = atom;
        ++cycle;
        atom.depsTail = void 0;
      } else if (getValue === void 0) return false;
      if (isComputed) atom.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;
      try {
        const oldValue = atom._snapshot;
        const newValue =
          typeof getValue === "function"
            ? getValue(oldValue)
            : getValue === void 0 && isComputed
              ? getter(oldValue)
              : getValue;
        if (oldValue === void 0 || !compare(oldValue, newValue)) {
          atom._snapshot = newValue;
          return true;
        }
        return false;
      } finally {
        activeSub = prevSub;
        if (isComputed) atom.flags &= ~ReactiveFlags.RecursedCheck;
        purgeDeps(atom);
      }
    },
  };
  if (isComputed) {
    atom.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
    atom.get = function () {
      const flags = atom.flags;
      if (
        flags & ReactiveFlags.Dirty ||
        (flags & ReactiveFlags.Pending && checkDirty(atom.deps, atom))
      ) {
        if (atom._update()) {
          const subs = atom.subs;
          if (subs !== void 0) shallowPropagate(subs);
        }
      } else if (flags & ReactiveFlags.Pending) atom.flags = flags & ~ReactiveFlags.Pending;
      if (activeSub !== void 0) link(atom, activeSub, cycle);
      return atom._snapshot;
    };
  } else
    atom.set = function (valueOrFn2) {
      if (atom._update(valueOrFn2)) {
        const subs = atom.subs;
        if (subs !== void 0) {
          propagate(subs);
          shallowPropagate(subs);
          flush();
        }
      }
    };
  return atom;
}
function effect(fn) {
  const run = () => {
    const prevSub = activeSub;
    activeSub = effectObj;
    ++cycle;
    effectObj.depsTail = void 0;
    effectObj.flags = ReactiveFlags.Watching | ReactiveFlags.RecursedCheck;
    try {
      return fn();
    } finally {
      activeSub = prevSub;
      effectObj.flags &= ~ReactiveFlags.RecursedCheck;
      purgeDeps(effectObj);
    }
  };
  const effectObj = {
    deps: void 0,
    depsTail: void 0,
    subs: void 0,
    subsTail: void 0,
    flags: ReactiveFlags.Watching | ReactiveFlags.RecursedCheck,
    notify() {
      const flags = this.flags;
      if (
        flags & ReactiveFlags.Dirty ||
        (flags & ReactiveFlags.Pending && checkDirty(this.deps, this))
      )
        run();
      else this.flags = ReactiveFlags.Watching;
    },
    stop() {
      this.flags = ReactiveFlags.None;
      this.depsTail = void 0;
      purgeDeps(this);
    },
  };
  run();
  return effectObj;
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/not-found.js
function CatchNotFound(props) {
  const router = useRouter();
  {
    const resetKey = `not-found-${router.stores.location.get().pathname}-${router.stores.status.get()}`;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CatchBoundary, {
      getResetKey: () => resetKey,
      onCatch: (error, errorInfo) => {
        if (isNotFound(error)) props.onCatch?.(error, errorInfo);
        else throw error;
      },
      errorComponent: ({ error }) => {
        if (isNotFound(error)) return props.fallback?.(error);
        else throw error;
      },
      children: props.children,
    });
  }
  const resetKey = `not-found-${useStore(router.stores.location, (location) => location.pathname)}-${useStore(router.stores.status, (status) => status)}`;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CatchBoundary, {
    getResetKey: () => resetKey,
    onCatch: (error, errorInfo) => {
      if (isNotFound(error)) props.onCatch?.(error, errorInfo);
      else throw error;
    },
    errorComponent: ({ error }) => {
      if (isNotFound(error)) return props.fallback?.(error);
      else throw error;
    },
    children: props.children,
  });
}
function DefaultGlobalNotFound() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "Not Found" });
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/ScriptOnce.js
/**
 * Server-only helper to emit a script tag exactly once during SSR.
 */
function ScriptOnce({ children }) {
  const router = useRouter();
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("script", {
    nonce: router.options.ssr?.nonce,
    dangerouslySetInnerHTML: { __html: children + ";document.currentScript.remove()" },
  });
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/SafeFragment.js
function SafeFragment(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, {
    children: props.children,
  });
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/renderRouteNotFound.js
/**
 * Renders a not found component for a route when no matching route is found.
 *
 * @param router - The router instance containing the route configuration
 * @param route - The route that triggered the not found state
 * @param data - Additional data to pass to the not found component
 * @returns The rendered not found component or a default fallback component
 */
function renderRouteNotFound(router, route, data) {
  if (!route.options.notFoundComponent) {
    if (router.options.defaultNotFoundComponent)
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(router.options.defaultNotFoundComponent, {
        ...data,
      });
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DefaultGlobalNotFound, {});
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(route.options.notFoundComponent, { ...data });
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/scroll-restoration-script/client.js
function getScrollRestorationScriptForRouter(_router) {
  return null;
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/scroll-restoration.js
function ScrollRestoration() {
  const script = getScrollRestorationScriptForRouter(useRouter());
  if (!script) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ScriptOnce, { children: script });
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/Match.js
var Match = import_react.memo(function MatchImpl({ matchId }) {
  const router = useRouter();
  {
    const match = router.stores.matchStores.get(matchId)?.get();
    if (!match) invariant();
    const routeId = match.routeId;
    const parentRouteId = router.routesById[routeId].parentRoute?.id;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MatchView, {
      router,
      matchId,
      resetKey: router.stores.loadedAt.get(),
      matchState: {
        routeId,
        ssr: match.ssr,
        _displayPending: match._displayPending,
        parentRouteId,
      },
    });
  }
  const matchStore = router.stores.matchStores.get(matchId);
  if (!matchStore) invariant();
  const resetKey = useStore(router.stores.loadedAt, (loadedAt) => loadedAt);
  const match = useStore(matchStore, (value) => value);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MatchView, {
    router,
    matchId,
    resetKey,
    matchState: import_react.useMemo(() => {
      const routeId = match.routeId;
      const parentRouteId = router.routesById[routeId].parentRoute?.id;
      return {
        routeId,
        ssr: match.ssr,
        _displayPending: match._displayPending,
        parentRouteId,
      };
    }, [match._displayPending, match.routeId, match.ssr, router.routesById]),
  });
});
function MatchView({ router, matchId, resetKey, matchState }) {
  const route = router.routesById[matchState.routeId];
  const PendingComponent = route.options.pendingComponent ?? router.options.defaultPendingComponent;
  const pendingElement = PendingComponent
    ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PendingComponent, {})
    : null;
  const routeErrorComponent = route.options.errorComponent ?? router.options.defaultErrorComponent;
  const routeOnCatch = route.options.onCatch ?? router.options.defaultOnCatch;
  const routeNotFoundComponent = route.isRoot
    ? (route.options.notFoundComponent ?? router.options.notFoundRoute?.options.component)
    : route.options.notFoundComponent;
  const resolvedNoSsr = matchState.ssr === false || matchState.ssr === "data-only";
  const ResolvedSuspenseBoundary =
    (!route.isRoot || route.options.wrapInSuspense || resolvedNoSsr) &&
    (route.options.wrapInSuspense ??
      PendingComponent ??
      (route.options.errorComponent?.preload || resolvedNoSsr))
      ? import_react.Suspense
      : SafeFragment;
  const ResolvedCatchBoundary = routeErrorComponent ? CatchBoundary : SafeFragment;
  const ResolvedNotFoundBoundary = routeNotFoundComponent ? CatchNotFound : SafeFragment;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    route.isRoot ? (route.options.shellComponent ?? SafeFragment) : SafeFragment,
    {
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(matchContext.Provider, {
          value: matchId,
          children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ResolvedSuspenseBoundary, {
            fallback: pendingElement,
            children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ResolvedCatchBoundary, {
              getResetKey: () => resetKey,
              errorComponent: routeErrorComponent || ErrorComponent,
              onCatch: (error, errorInfo) => {
                if (isNotFound(error)) {
                  error.routeId ??= matchState.routeId;
                  throw error;
                }
                routeOnCatch?.(error, errorInfo);
              },
              children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ResolvedNotFoundBoundary, {
                fallback: (error) => {
                  error.routeId ??= matchState.routeId;
                  if (
                    !routeNotFoundComponent ||
                    (error.routeId && error.routeId !== matchState.routeId) ||
                    (!error.routeId && !route.isRoot)
                  )
                    throw error;
                  return import_react.createElement(routeNotFoundComponent, error);
                },
                children:
                  resolvedNoSsr || matchState._displayPending
                    ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ClientOnly, {
                        fallback: pendingElement,
                        children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MatchInner, {
                          matchId,
                        }),
                      })
                    : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MatchInner, { matchId }),
              }),
            }),
          }),
        }),
        matchState.parentRouteId === "__root__"
          ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, {
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(OnRendered, { resetKey }),
                router.options.scrollRestoration && true
                  ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ScrollRestoration, {})
                  : null,
              ],
            })
          : null,
      ],
    },
  );
}
function OnRendered({ resetKey }) {
  useRouter();
  return null;
}
var MatchInner = import_react.memo(function MatchInnerImpl({ matchId }) {
  const router = useRouter();
  const getMatchPromise = (match, key) => {
    return router.getMatch(match.id)?._nonReactive[key] ?? match._nonReactive[key];
  };
  {
    const match = router.stores.matchStores.get(matchId)?.get();
    if (!match) invariant();
    const routeId = match.routeId;
    const route = router.routesById[routeId];
    const remountDeps = (
      router.routesById[routeId].options.remountDeps ?? router.options.defaultRemountDeps
    )?.({
      routeId,
      loaderDeps: match.loaderDeps,
      params: match._strictParams,
      search: match._strictSearch,
    });
    const key = remountDeps ? JSON.stringify(remountDeps) : void 0;
    const Comp = route.options.component ?? router.options.defaultComponent;
    const out = Comp
      ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Comp, {}, key)
      : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Outlet, {});
    if (match._displayPending) throw getMatchPromise(match, "displayPendingPromise");
    if (match._forcePending) throw getMatchPromise(match, "minPendingPromise");
    if (match.status === "pending") throw getMatchPromise(match, "loadPromise");
    if (match.status === "notFound") {
      if (!isNotFound(match.error)) invariant();
      return renderRouteNotFound(router, route, match.error);
    }
    if (match.status === "redirected") {
      if (!isRedirect(match.error)) invariant();
      throw getMatchPromise(match, "loadPromise");
    }
    if (match.status === "error")
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        (route.options.errorComponent ?? router.options.defaultErrorComponent) || ErrorComponent,
        {
          error: match.error,
          reset: void 0,
          info: { componentStack: "" },
        },
      );
    return out;
  }
  const matchStore = router.stores.matchStores.get(matchId);
  if (!matchStore) invariant();
  const match = useStore(matchStore, (value) => value);
  const routeId = match.routeId;
  const route = router.routesById[routeId];
  const key = import_react.useMemo(() => {
    const remountDeps = (
      router.routesById[routeId].options.remountDeps ?? router.options.defaultRemountDeps
    )?.({
      routeId,
      loaderDeps: match.loaderDeps,
      params: match._strictParams,
      search: match._strictSearch,
    });
    return remountDeps ? JSON.stringify(remountDeps) : void 0;
  }, [
    routeId,
    match.loaderDeps,
    match._strictParams,
    match._strictSearch,
    router.options.defaultRemountDeps,
    router.routesById,
  ]);
  const out = import_react.useMemo(() => {
    const Comp = route.options.component ?? router.options.defaultComponent;
    if (Comp) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Comp, {}, key);
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Outlet, {});
  }, [key, route.options.component, router.options.defaultComponent]);
  if (match._displayPending) throw getMatchPromise(match, "displayPendingPromise");
  if (match._forcePending) throw getMatchPromise(match, "minPendingPromise");
  if (match.status === "pending") {
    if (route.options.pendingMinMs ?? router.options.defaultPendingMinMs) {
      const routerMatch = router.getMatch(match.id);
      if (routerMatch && !routerMatch._nonReactive.minPendingPromise) {
      }
    }
    throw getMatchPromise(match, "loadPromise");
  }
  if (match.status === "notFound") {
    if (!isNotFound(match.error)) invariant();
    return renderRouteNotFound(router, route, match.error);
  }
  if (match.status === "redirected") {
    if (!isRedirect(match.error)) invariant();
    throw getMatchPromise(match, "loadPromise");
  }
  if (match.status === "error")
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      (route.options.errorComponent ?? router.options.defaultErrorComponent) || ErrorComponent,
      {
        error: match.error,
        reset: void 0,
        info: { componentStack: "" },
      },
    );
  return out;
});
/**
 * Render the next child match in the route tree. Typically used inside
 * a route component to render nested routes.
 *
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/outletComponent
 */
var Outlet = import_react.memo(function OutletImpl() {
  const router = useRouter();
  const matchId = import_react.useContext(matchContext);
  let routeId;
  let parentGlobalNotFound = false;
  let childMatchId;
  {
    const matches = router.stores.matches.get();
    const parentIndex = matchId ? matches.findIndex((match) => match.id === matchId) : -1;
    const parentMatch = parentIndex >= 0 ? matches[parentIndex] : void 0;
    routeId = parentMatch?.routeId;
    parentGlobalNotFound = parentMatch?.globalNotFound ?? false;
    childMatchId = parentIndex >= 0 ? matches[parentIndex + 1]?.id : void 0;
  }
  const route = routeId ? router.routesById[routeId] : void 0;
  const pendingElement = router.options.defaultPendingComponent
    ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(router.options.defaultPendingComponent, {})
    : null;
  if (parentGlobalNotFound) {
    if (!route) invariant();
    return renderRouteNotFound(router, route, void 0);
  }
  if (!childMatchId) return null;
  const nextMatch = /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Match, { matchId: childMatchId });
  if (routeId === "__root__")
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_react.Suspense, {
      fallback: pendingElement,
      children: nextMatch,
    });
  return nextMatch;
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
function getRouter(router, path) {
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
      return unlazy(getRouter((await unlazy(lazied)).default, rest));
    }, getLazyMeta(lazied));
  }
  return current;
}
function createAccessibleLazyRouter(lazied) {
  return new Proxy(lazied, {
    get(target, key) {
      if (typeof key !== "string") return Reflect.get(target, key);
      return createAccessibleLazyRouter(getRouter(lazied, [key]));
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
  tree = new NullProtoObj();
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
      const { default: maybeProcedure } = await unlazy(getRouter(match.router, match.path));
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
var things = [];
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
    list: os.things.list.handler(async () => ({
      items: [...things].reverse(),
      total: things.length,
    })),
    create: os.things.create.handler(async ({ input }) => {
      const thing = {
        id: "thing_" + crypto.randomUUID().slice(0, 8),
        name: input.name,
        createdAt: /* @__PURE__ */ new Date().toISOString(),
      };
      things.push(thing);
      return thing;
    }),
    remove: os.things.remove.handler(async ({ input }) => {
      const idx = things.findIndex((t) => t.id === input.id);
      if (idx === -1)
        return {
          ok: true,
          id: input.id,
          deleted: false,
        };
      things.splice(idx, 1);
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
export {
  getLocationChangeInfo as C,
  executeRewriteInput as D,
  createNonReactiveReadonlyStore as E,
  RouterCore as S,
  createNonReactiveMutableStore as T,
  createAtom as _,
  createContractedProcedure as a,
  getAssetCrossOrigin as b,
  isProcedure as c,
  unlazy as d,
  resolveFriendlyStandardHandleOptions as f,
  batch as g,
  SafeFragment as h,
  StandardRPCHandler as i,
  resolveContractProcedures as l,
  Outlet as m,
  CompositeStandardHandlerPlugin as n,
  getLazyMeta as o,
  Match as p,
  StandardHandler as r,
  getRouter as s,
  appRouter as t,
  traverseContractProcedures as u,
  CatchBoundary as v,
  createMemoryHistory as w,
  resolveManifestAssetLink as x,
  ErrorComponent as y,
};
