import {
  a as __toESM,
  n as require_react,
  t as require_jsx_runtime,
} from "./jsx-runtime-B8ri5dzN.js";
import {
  G as useForwardedRef,
  I as functionalUpdate,
  K as useIntersectionObserver,
  L as isDangerousProtocol,
  N as deepEqual,
  O as invariant,
  R as isModuleNotFoundError,
  U as replaceEqualDeep,
  W as reactUse,
  _ as removeTrailingSlash,
  a as matchContext,
  b as trimPathLeft,
  g as joinPaths,
  i as dummyMatchContext,
  l as useHydrated,
  m as exactPathTest,
  n as require_react_dom,
  o as useRouter,
  r as useStore,
  t as getServerFnById,
  u as rootRouteId,
  x as trimPathRight,
} from "./__23tanstack-start-server-fn-resolver-CRZD-Up_.js";
import {
  _ as redirect,
  d as TSS_SERVER_FUNCTION,
  t as createServerFn,
} from "./createServerFn-Df2o8xb7.js";
//#region node_modules/@tanstack/router-core/dist/esm/link.js
var preloadWarning = "Error preloading route! ☝️";
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/route.js
var BaseRoute = class {
  get to() {
    return this._to;
  }
  get id() {
    return this._id;
  }
  get path() {
    return this._path;
  }
  get fullPath() {
    return this._fullPath;
  }
  constructor(options) {
    this.init = (opts) => {
      this.originalIndex = opts.originalIndex;
      const options = this.options;
      const isRoot = !options?.path && !options?.id;
      this.parentRoute = this.options.getParentRoute?.();
      if (isRoot) this._path = rootRouteId;
      else if (!this.parentRoute) invariant();
      let path = isRoot ? rootRouteId : options?.path;
      if (path && path !== "/") path = trimPathLeft(path);
      const customId = options?.id || path;
      let id = isRoot
        ? rootRouteId
        : joinPaths([this.parentRoute.id === "__root__" ? "" : this.parentRoute.id, customId]);
      if (path === "__root__") path = "/";
      if (id !== "__root__") id = joinPaths(["/", id]);
      const fullPath = id === "__root__" ? "/" : joinPaths([this.parentRoute.fullPath, path]);
      this._path = path;
      this._id = id;
      this._fullPath = fullPath;
      this._to = trimPathRight(fullPath);
    };
    this.addChildren = (children) => {
      return this._addFileChildren(children);
    };
    this._addFileChildren = (children) => {
      if (Array.isArray(children)) this.children = children;
      if (typeof children === "object" && children !== null)
        this.children = Object.values(children);
      return this;
    };
    this._addFileTypes = () => {
      return this;
    };
    this.updateLoader = (options) => {
      Object.assign(this.options, options);
      return this;
    };
    this.update = (options) => {
      Object.assign(this.options, options);
      return this;
    };
    this.lazy = (lazyFn) => {
      this.lazyFn = lazyFn;
      return this;
    };
    this.redirect = (opts) =>
      redirect({
        from: this.fullPath,
        ...opts,
      });
    this.options = options || {};
    this.isRoot = !options?.getParentRoute;
    if (options?.id && options?.path)
      throw new Error(`Route cannot have both an 'id' and a 'path' option.`);
  }
};
var BaseRootRoute = class extends BaseRoute {
  constructor(options) {
    super(options);
  }
};
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/useMatch.js
var import_react = /* @__PURE__ */ __toESM(require_react(), 1);
var dummyStore = {
  get: () => void 0,
  subscribe: () => ({ unsubscribe: () => {} }),
};
/**
 * Read and select the nearest or targeted route match.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/useMatchHook
 */
function useMatch(opts) {
  const router = useRouter();
  const nearestMatchId = import_react.useContext(opts.from ? dummyMatchContext : matchContext);
  const key = opts.from ?? nearestMatchId;
  const matchStore = key
    ? opts.from
      ? router.stores.getRouteMatchStore(key)
      : router.stores.matchStores.get(key)
    : void 0;
  {
    const match = matchStore?.get();
    if ((opts.shouldThrow ?? true) && !match) invariant();
    if (match === void 0) return;
    return opts.select ? opts.select(match) : match;
  }
  const previousResult = import_react.useRef(void 0);
  return useStore(matchStore ?? dummyStore, (match) => {
    if ((opts.shouldThrow ?? true) && !match) invariant();
    if (match === void 0) return;
    const selected = opts.select ? opts.select(match) : match;
    if (opts.structuralSharing ?? router.options.defaultStructuralSharing) {
      const shared = replaceEqualDeep(previousResult.current, selected);
      previousResult.current = shared;
      return shared;
    }
    return selected;
  });
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/useLoaderData.js
/**
 * Read and select the current route's loader data with type‑safety.
 *
 * Options:
 * - `from`/`strict`: Choose which route's data to read and strictness
 * - `select`: Map the loader data to a derived value
 * - `structuralSharing`: Enable structural sharing for stable references
 *
 * @returns The loader data (or selected value) for the matched route.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/useLoaderDataHook
 */
function useLoaderData(opts) {
  return useMatch({
    from: opts.from,
    strict: opts.strict,
    structuralSharing: opts.structuralSharing,
    select: (s) => {
      return opts.select ? opts.select(s.loaderData) : s.loaderData;
    },
  });
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/useLoaderDeps.js
/**
 * Read and select the current route's loader dependencies object.
 *
 * Options:
 * - `from`: Choose which route's loader deps to read
 * - `select`: Map the deps to a derived value
 * - `structuralSharing`: Enable structural sharing for stable references
 *
 * @returns The loader deps (or selected value) for the matched route.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/useLoaderDepsHook
 */
function useLoaderDeps(opts) {
  const { select, ...rest } = opts;
  return useMatch({
    ...rest,
    select: (s) => {
      return select ? select(s.loaderDeps) : s.loaderDeps;
    },
  });
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/useParams.js
/**
 * Access the current route's path parameters with type-safety.
 *
 * Options:
 * - `from`/`strict`: Specify the matched route and whether to enforce strict typing
 * - `select`: Project the params object to a derived value for memoized renders
 * - `structuralSharing`: Enable structural sharing for stable references
 * - `shouldThrow`: Throw if the route is not found in strict contexts
 *
 * @returns The params object (or selected value) for the matched route.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/useParamsHook
 */
function useParams(opts) {
  return useMatch({
    from: opts.from,
    shouldThrow: opts.shouldThrow,
    structuralSharing: opts.structuralSharing,
    strict: opts.strict,
    select: (match) => {
      const params = opts.strict === false ? match.params : match._strictParams;
      return opts.select ? opts.select(params) : params;
    },
  });
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/useSearch.js
/**
 * Read and select the current route's search parameters with type-safety.
 *
 * Options:
 * - `from`/`strict`: Control which route's search is read and how strictly it's typed
 * - `select`: Map the search object to a derived value for render optimization
 * - `structuralSharing`: Enable structural sharing for stable references
 * - `shouldThrow`: Throw when the route is not found (strict contexts)
 *
 * @returns The search object (or selected value) for the matched route.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/useSearchHook
 */
function useSearch(opts) {
  return useMatch({
    from: opts.from,
    strict: opts.strict,
    shouldThrow: opts.shouldThrow,
    structuralSharing: opts.structuralSharing,
    select: (match) => {
      return opts.select ? opts.select(match.search) : match.search;
    },
  });
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/useNavigate.js
/**
 * Imperative navigation hook.
 *
 * Returns a stable `navigate(options)` function to change the current location
 * programmatically. Prefer the `Link` component for user-initiated navigation,
 * and use this hook from effects, callbacks, or handlers where imperative
 * navigation is required.
 *
 * Options:
 * - `from`: Optional route base used to resolve relative `to` paths.
 *
 * @returns A function that accepts `NavigateOptions`.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/useNavigateHook
 */
function useNavigate(_defaultOpts) {
  const router = useRouter();
  return import_react.useCallback(
    (options) => {
      return router.navigate({
        ...options,
        from: options.from ?? _defaultOpts?.from,
      });
    },
    [_defaultOpts?.from, router],
  );
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/useRouteContext.js
function useRouteContext(opts) {
  return useMatch({
    ...opts,
    select: (match) => (opts.select ? opts.select(match.context) : match.context),
  });
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/link.js
var import_jsx_runtime = require_jsx_runtime();
var import_react_dom = require_react_dom();
/**
 * Build anchor-like props for declarative navigation and preloading.
 *
 * Returns stable `href`, event handlers and accessibility props derived from
 * router options and active state. Used internally by `Link` and custom links.
 *
 * Options cover `to`, `params`, `search`, `hash`, `state`, `preload`,
 * `activeProps`, `inactiveProps`, and more.
 *
 * @returns React anchor props suitable for `<a>` or custom components.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/useLinkPropsHook
 */
function useLinkProps(options, forwardedRef) {
  const router = useRouter();
  const innerRef = useForwardedRef(forwardedRef);
  const {
    activeProps,
    inactiveProps,
    activeOptions,
    to,
    preload: userPreload,
    preloadDelay: userPreloadDelay,
    preloadIntentProximity: _preloadIntentProximity,
    hashScrollIntoView,
    replace,
    startTransition,
    resetScroll,
    viewTransition,
    children,
    target,
    disabled,
    style,
    className,
    onClick,
    onBlur,
    onFocus,
    onMouseEnter,
    onMouseLeave,
    onTouchStart,
    ignoreBlocker,
    params: _params,
    search: _search,
    hash: _hash,
    state: _state,
    mask: _mask,
    reloadDocument: _reloadDocument,
    unsafeRelative: _unsafeRelative,
    from: _from,
    _fromLocation,
    ...propsSafeToSpread
  } = options;
  {
    const safeInternal = isSafeInternal(to);
    if (typeof to === "string" && !safeInternal && to.indexOf(":") > -1)
      try {
        new URL(to);
        if (isDangerousProtocol(to, router.protocolAllowlist))
          return {
            ...propsSafeToSpread,
            ref: innerRef,
            href: void 0,
            ...(children && { children }),
            ...(target && { target }),
            ...(disabled && { disabled }),
            ...(style && { style }),
            ...(className && { className }),
          };
        return {
          ...propsSafeToSpread,
          ref: innerRef,
          href: to,
          ...(children && { children }),
          ...(target && { target }),
          ...(disabled && { disabled }),
          ...(style && { style }),
          ...(className && { className }),
        };
      } catch {}
    const next = router.buildLocation({
      ...options,
      from: options.from,
    });
    const hrefOption = getHrefOption(
      next.maskedLocation ? next.maskedLocation.publicHref : next.publicHref,
      next.maskedLocation ? next.maskedLocation.external : next.external,
      router.history,
      disabled,
    );
    const externalLink = (() => {
      if (hrefOption?.external) {
        if (isDangerousProtocol(hrefOption.href, router.protocolAllowlist)) return;
        return hrefOption.href;
      }
      if (safeInternal) return void 0;
      if (typeof to === "string" && to.indexOf(":") > -1)
        try {
          new URL(to);
          if (isDangerousProtocol(to, router.protocolAllowlist)) return;
          return to;
        } catch {}
    })();
    const isActive = (() => {
      if (externalLink) return false;
      const currentLocation = router.stores.location.get();
      const exact = activeOptions?.exact ?? false;
      if (exact) {
        if (!exactPathTest(currentLocation.pathname, next.pathname, router.basepath)) return false;
      } else {
        const currentPathSplit = removeTrailingSlash(currentLocation.pathname, router.basepath);
        const nextPathSplit = removeTrailingSlash(next.pathname, router.basepath);
        if (
          !(
            currentPathSplit.startsWith(nextPathSplit) &&
            (currentPathSplit.length === nextPathSplit.length ||
              currentPathSplit[nextPathSplit.length] === "/")
          )
        )
          return false;
      }
      if (activeOptions?.includeSearch ?? true) {
        if (currentLocation.search !== next.search) {
          const currentSearchEmpty =
            !currentLocation.search ||
            (typeof currentLocation.search === "object" &&
              Object.keys(currentLocation.search).length === 0);
          const nextSearchEmpty =
            !next.search ||
            (typeof next.search === "object" && Object.keys(next.search).length === 0);
          if (!(currentSearchEmpty && nextSearchEmpty)) {
            if (
              !deepEqual(currentLocation.search, next.search, {
                partial: !exact,
                ignoreUndefined: !activeOptions?.explicitUndefined,
              })
            )
              return false;
          }
        }
      }
      if (activeOptions?.includeHash) return false;
      return true;
    })();
    if (externalLink)
      return {
        ...propsSafeToSpread,
        ref: innerRef,
        href: externalLink,
        ...(children && { children }),
        ...(target && { target }),
        ...(disabled && { disabled }),
        ...(style && { style }),
        ...(className && { className }),
      };
    const resolvedActiveProps = isActive
      ? (functionalUpdate(activeProps, {}) ?? STATIC_ACTIVE_OBJECT)
      : STATIC_EMPTY_OBJECT;
    const resolvedInactiveProps = isActive
      ? STATIC_EMPTY_OBJECT
      : (functionalUpdate(inactiveProps, {}) ?? STATIC_EMPTY_OBJECT);
    const resolvedStyle = (() => {
      const baseStyle = style;
      const activeStyle = resolvedActiveProps.style;
      const inactiveStyle = resolvedInactiveProps.style;
      if (!baseStyle && !activeStyle && !inactiveStyle) return;
      if (baseStyle && !activeStyle && !inactiveStyle) return baseStyle;
      if (!baseStyle && activeStyle && !inactiveStyle) return activeStyle;
      if (!baseStyle && !activeStyle && inactiveStyle) return inactiveStyle;
      return {
        ...baseStyle,
        ...activeStyle,
        ...inactiveStyle,
      };
    })();
    const resolvedClassName = (() => {
      const baseClassName = className;
      const activeClassName = resolvedActiveProps.className;
      const inactiveClassName = resolvedInactiveProps.className;
      if (!baseClassName && !activeClassName && !inactiveClassName) return "";
      let out = "";
      if (baseClassName) out = baseClassName;
      if (activeClassName) out = out ? `${out} ${activeClassName}` : activeClassName;
      if (inactiveClassName) out = out ? `${out} ${inactiveClassName}` : inactiveClassName;
      return out;
    })();
    return {
      ...propsSafeToSpread,
      ...resolvedActiveProps,
      ...resolvedInactiveProps,
      href: hrefOption?.href,
      ref: innerRef,
      disabled: !!disabled,
      target,
      ...(resolvedStyle && { style: resolvedStyle }),
      ...(resolvedClassName && { className: resolvedClassName }),
      ...(disabled && STATIC_DISABLED_PROPS),
      ...(isActive && STATIC_ACTIVE_PROPS),
    };
  }
  const isHydrated = useHydrated();
  const _options = import_react.useMemo(
    () => options,
    [
      router,
      options.from,
      options._fromLocation,
      options.hash,
      options.to,
      options.search,
      options.params,
      options.state,
      options.mask,
      options.unsafeRelative,
    ],
  );
  const currentLocation = useStore(
    router.stores.location,
    (l) => l,
    (prev, next) => prev.href === next.href,
  );
  const next = import_react.useMemo(() => {
    const opts = {
      _fromLocation: currentLocation,
      ..._options,
    };
    return router.buildLocation(opts);
  }, [router, currentLocation, _options]);
  const hrefOptionPublicHref = next.maskedLocation
    ? next.maskedLocation.publicHref
    : next.publicHref;
  const hrefOptionExternal = next.maskedLocation ? next.maskedLocation.external : next.external;
  const hrefOption = import_react.useMemo(
    () => getHrefOption(hrefOptionPublicHref, hrefOptionExternal, router.history, disabled),
    [disabled, hrefOptionExternal, hrefOptionPublicHref, router.history],
  );
  const externalLink = import_react.useMemo(() => {
    if (hrefOption?.external) {
      if (isDangerousProtocol(hrefOption.href, router.protocolAllowlist)) return;
      return hrefOption.href;
    }
    if (isSafeInternal(to)) return void 0;
    if (typeof to !== "string" || to.indexOf(":") === -1) return void 0;
    try {
      new URL(to);
      if (isDangerousProtocol(to, router.protocolAllowlist)) return;
      return to;
    } catch {}
  }, [to, hrefOption, router.protocolAllowlist]);
  const isActive = import_react.useMemo(() => {
    if (externalLink) return false;
    if (activeOptions?.exact) {
      if (!exactPathTest(currentLocation.pathname, next.pathname, router.basepath)) return false;
    } else {
      const currentPathSplit = removeTrailingSlash(currentLocation.pathname, router.basepath);
      const nextPathSplit = removeTrailingSlash(next.pathname, router.basepath);
      if (
        !(
          currentPathSplit.startsWith(nextPathSplit) &&
          (currentPathSplit.length === nextPathSplit.length ||
            currentPathSplit[nextPathSplit.length] === "/")
        )
      )
        return false;
    }
    if (activeOptions?.includeSearch ?? true) {
      if (
        !deepEqual(currentLocation.search, next.search, {
          partial: !activeOptions?.exact,
          ignoreUndefined: !activeOptions?.explicitUndefined,
        })
      )
        return false;
    }
    if (activeOptions?.includeHash) return isHydrated && currentLocation.hash === next.hash;
    return true;
  }, [
    activeOptions?.exact,
    activeOptions?.explicitUndefined,
    activeOptions?.includeHash,
    activeOptions?.includeSearch,
    currentLocation,
    externalLink,
    isHydrated,
    next.hash,
    next.pathname,
    next.search,
    router.basepath,
  ]);
  const resolvedActiveProps = isActive
    ? (functionalUpdate(activeProps, {}) ?? STATIC_ACTIVE_OBJECT)
    : STATIC_EMPTY_OBJECT;
  const resolvedInactiveProps = isActive
    ? STATIC_EMPTY_OBJECT
    : (functionalUpdate(inactiveProps, {}) ?? STATIC_EMPTY_OBJECT);
  const resolvedClassName = [
    className,
    resolvedActiveProps.className,
    resolvedInactiveProps.className,
  ]
    .filter(Boolean)
    .join(" ");
  const resolvedStyle = (style || resolvedActiveProps.style || resolvedInactiveProps.style) && {
    ...style,
    ...resolvedActiveProps.style,
    ...resolvedInactiveProps.style,
  };
  const [isTransitioning, setIsTransitioning] = import_react.useState(false);
  const hasRenderFetched = import_react.useRef(false);
  const preload =
    options.reloadDocument || externalLink ? false : (userPreload ?? router.options.defaultPreload);
  const preloadDelay = userPreloadDelay ?? router.options.defaultPreloadDelay ?? 0;
  const doPreload = import_react.useCallback(() => {
    router
      .preloadRoute({
        ..._options,
        _builtLocation: next,
      })
      .catch((err) => {
        console.warn(err);
        console.warn(preloadWarning);
      });
  }, [router, _options, next]);
  useIntersectionObserver(
    innerRef,
    import_react.useCallback(
      (entry) => {
        if (entry?.isIntersecting) doPreload();
      },
      [doPreload],
    ),
    intersectionObserverOptions,
    { disabled: !!disabled || !(preload === "viewport") },
  );
  import_react.useEffect(() => {
    if (hasRenderFetched.current) return;
    if (!disabled && preload === "render") {
      doPreload();
      hasRenderFetched.current = true;
    }
  }, [disabled, doPreload, preload]);
  const handleClick = (e) => {
    const elementTarget = e.currentTarget.getAttribute("target");
    const effectiveTarget = target !== void 0 ? target : elementTarget;
    if (
      !disabled &&
      !isCtrlEvent(e) &&
      !e.defaultPrevented &&
      (!effectiveTarget || effectiveTarget === "_self") &&
      e.button === 0
    ) {
      e.preventDefault();
      (0, import_react_dom.flushSync)(() => {
        setIsTransitioning(true);
      });
      const unsub = router.subscribe("onResolved", () => {
        unsub();
        setIsTransitioning(false);
      });
      router.navigate({
        ..._options,
        replace,
        resetScroll,
        hashScrollIntoView,
        startTransition,
        viewTransition,
        ignoreBlocker,
      });
    }
  };
  if (externalLink)
    return {
      ...propsSafeToSpread,
      ref: innerRef,
      href: externalLink,
      ...(children && { children }),
      ...(target && { target }),
      ...(disabled && { disabled }),
      ...(style && { style }),
      ...(className && { className }),
      ...(onClick && { onClick }),
      ...(onBlur && { onBlur }),
      ...(onFocus && { onFocus }),
      ...(onMouseEnter && { onMouseEnter }),
      ...(onMouseLeave && { onMouseLeave }),
      ...(onTouchStart && { onTouchStart }),
    };
  const enqueueIntentPreload = (e) => {
    if (disabled || preload !== "intent") return;
    if (!preloadDelay) {
      doPreload();
      return;
    }
    const eventTarget = e.currentTarget;
    if (timeoutMap.has(eventTarget)) return;
    const id = setTimeout(() => {
      timeoutMap.delete(eventTarget);
      doPreload();
    }, preloadDelay);
    timeoutMap.set(eventTarget, id);
  };
  const handleTouchStart = (_) => {
    if (disabled || preload !== "intent") return;
    doPreload();
  };
  const handleLeave = (e) => {
    if (disabled || !preload || !preloadDelay) return;
    const eventTarget = e.currentTarget;
    const id = timeoutMap.get(eventTarget);
    if (id) {
      clearTimeout(id);
      timeoutMap.delete(eventTarget);
    }
  };
  return {
    ...propsSafeToSpread,
    ...resolvedActiveProps,
    ...resolvedInactiveProps,
    href: hrefOption?.href,
    ref: innerRef,
    onClick: composeHandlers([onClick, handleClick]),
    onBlur: composeHandlers([onBlur, handleLeave]),
    onFocus: composeHandlers([onFocus, enqueueIntentPreload]),
    onMouseEnter: composeHandlers([onMouseEnter, enqueueIntentPreload]),
    onMouseLeave: composeHandlers([onMouseLeave, handleLeave]),
    onTouchStart: composeHandlers([onTouchStart, handleTouchStart]),
    disabled: !!disabled,
    target,
    ...(resolvedStyle && { style: resolvedStyle }),
    ...(resolvedClassName && { className: resolvedClassName }),
    ...(disabled && STATIC_DISABLED_PROPS),
    ...(isActive && STATIC_ACTIVE_PROPS),
    ...(isHydrated && isTransitioning && STATIC_TRANSITIONING_PROPS),
  };
}
var STATIC_EMPTY_OBJECT = {};
var STATIC_ACTIVE_OBJECT = { className: "active" };
var STATIC_DISABLED_PROPS = {
  role: "link",
  "aria-disabled": true,
};
var STATIC_ACTIVE_PROPS = {
  "data-status": "active",
  "aria-current": "page",
};
var STATIC_TRANSITIONING_PROPS = { "data-transitioning": "transitioning" };
var timeoutMap = /* @__PURE__ */ new WeakMap();
var intersectionObserverOptions = { rootMargin: "100px" };
var composeHandlers = (handlers) => (e) => {
  for (const handler of handlers) {
    if (!handler) continue;
    if (e.defaultPrevented) return;
    handler(e);
  }
};
function getHrefOption(publicHref, external, history, disabled) {
  if (disabled) return void 0;
  if (external)
    return {
      href: publicHref,
      external: true,
    };
  return {
    href: history.createHref(publicHref) || "/",
    external: false,
  };
}
function isSafeInternal(to) {
  if (typeof to !== "string") return false;
  const zero = to.charCodeAt(0);
  if (zero === 47) return to.charCodeAt(1) !== 47;
  return zero === 46;
}
/**
 * A strongly-typed anchor component for declarative navigation.
 * Handles path, search, hash and state updates with optional route preloading
 * and active-state styling.
 *
 * Props:
 * - `preload`: Controls route preloading (eg. 'intent', 'render', 'viewport', true/false)
 * - `preloadDelay`: Delay in ms before preloading on hover
 * - `activeProps`/`inactiveProps`: Additional props merged when link is active/inactive
 * - `resetScroll`/`hashScrollIntoView`: Control scroll behavior on navigation
 * - `viewTransition`/`startTransition`: Use View Transitions/React transitions for navigation
 * - `ignoreBlocker`: Bypass registered blockers
 *
 * @returns An anchor-like element that navigates without full page reloads.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/linkComponent
 */
var Link = import_react.forwardRef((props, ref) => {
  const { _asChild, ...rest } = props;
  const { type: _type, ...linkProps } = useLinkProps(rest, ref);
  const children =
    typeof rest.children === "function"
      ? rest.children({ isActive: linkProps["data-status"] === "active" })
      : rest.children;
  if (!_asChild) {
    const { disabled: _, ...rest } = linkProps;
    return import_react.createElement("a", rest, children);
  }
  return import_react.createElement(_asChild, linkProps, children);
});
function isCtrlEvent(e) {
  return !!(e.metaKey || e.altKey || e.ctrlKey || e.shiftKey);
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/route.js
var Route$1 = class extends BaseRoute {
  /**
   * @deprecated Use the `createRoute` function instead.
   */
  constructor(options) {
    super(options);
    this.useMatch = (opts) => {
      return useMatch({
        select: opts?.select,
        from: this.id,
        structuralSharing: opts?.structuralSharing,
      });
    };
    this.useRouteContext = (opts) => {
      return useRouteContext({
        ...opts,
        from: this.id,
      });
    };
    this.useSearch = (opts) => {
      return useSearch({
        select: opts?.select,
        structuralSharing: opts?.structuralSharing,
        from: this.id,
      });
    };
    this.useParams = (opts) => {
      return useParams({
        select: opts?.select,
        structuralSharing: opts?.structuralSharing,
        from: this.id,
      });
    };
    this.useLoaderDeps = (opts) => {
      return useLoaderDeps({
        ...opts,
        from: this.id,
      });
    };
    this.useLoaderData = (opts) => {
      return useLoaderData({
        ...opts,
        from: this.id,
      });
    };
    this.useNavigate = () => {
      return useNavigate({ from: this.fullPath });
    };
    this.Link = import_react.forwardRef((props, ref) => {
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
        ref,
        from: this.fullPath,
        ...props,
      });
    });
  }
};
/**
 * Creates a non-root Route instance for code-based routing.
 *
 * Use this to define a route that will be composed into a route tree
 * (typically via a parent route's `addChildren`). If you're using file-based
 * routing, prefer `createFileRoute`.
 *
 * @param options Route options (path, component, loader, context, etc.).
 * @returns A Route instance to be attached to the route tree.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/createRouteFunction
 */
function createRoute(options) {
  return new Route$1(options);
}
var RootRoute = class extends BaseRootRoute {
  /**
   * @deprecated `RootRoute` is now an internal implementation detail. Use `createRootRoute()` instead.
   */
  constructor(options) {
    super(options);
    this.useMatch = (opts) => {
      return useMatch({
        select: opts?.select,
        from: this.id,
        structuralSharing: opts?.structuralSharing,
      });
    };
    this.useRouteContext = (opts) => {
      return useRouteContext({
        ...opts,
        from: this.id,
      });
    };
    this.useSearch = (opts) => {
      return useSearch({
        select: opts?.select,
        structuralSharing: opts?.structuralSharing,
        from: this.id,
      });
    };
    this.useParams = (opts) => {
      return useParams({
        select: opts?.select,
        structuralSharing: opts?.structuralSharing,
        from: this.id,
      });
    };
    this.useLoaderDeps = (opts) => {
      return useLoaderDeps({
        ...opts,
        from: this.id,
      });
    };
    this.useLoaderData = (opts) => {
      return useLoaderData({
        ...opts,
        from: this.id,
      });
    };
    this.useNavigate = () => {
      return useNavigate({ from: this.fullPath });
    };
    this.Link = import_react.forwardRef((props, ref) => {
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
        ref,
        from: this.fullPath,
        ...props,
      });
    });
  }
};
/**
 * Creates a root Route instance used to build your route tree.
 *
 * Typically paired with `createRouter({ routeTree })`. If you need to require
 * a typed router context, use `createRootRouteWithContext` instead.
 *
 * @param options Root route options (component, error, pending, etc.).
 * @returns A root route instance.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/createRootRouteFunction
 */
function createRootRoute(options) {
  return new RootRoute(options);
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/fileRoute.js
/**
 * Creates a file-based Route factory for a given path.
 *
 * Used by TanStack Router's file-based routing to associate a file with a
 * route. The returned function accepts standard route options. In normal usage
 * the `path` string is inserted and maintained by the `tsr` generator.
 *
 * @param path File path literal for the route (usually auto-generated).
 * @returns A function that accepts Route options and returns a Route instance.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/createFileRouteFunction
 */
function createFileRoute(path) {
  return new FileRoute(path, { silent: true }).createRoute;
}
/**
@deprecated It's no longer recommended to use the `FileRoute` class directly.
Instead, use `createFileRoute('/path/to/file')(options)` to create a file route.
*/
var FileRoute = class {
  constructor(path, _opts) {
    this.path = path;
    this.createRoute = (options) => {
      const route = createRoute(options);
      route.isRoot = false;
      return route;
    };
    this.silent = _opts?.silent;
  }
};
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/lazyRouteComponent.js
/**
 * Wrap a dynamic import to create a route component that supports
 * `.preload()` and friendly reload-on-module-missing behavior.
 *
 * @param importer Function returning a module promise
 * @param exportName Named export to use (default: `default`)
 * @returns A lazy route component compatible with TanStack Router
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/lazyRouteComponentFunction
 */
function lazyRouteComponent(importer, exportName) {
  let loadPromise;
  let comp;
  let error;
  let reload;
  const load = () => {
    if (!loadPromise)
      loadPromise = importer()
        .then((res) => {
          loadPromise = void 0;
          comp = res[exportName ?? "default"];
        })
        .catch((err) => {
          error = err;
          if (isModuleNotFoundError(error)) {
            if (
              error instanceof Error &&
              typeof window !== "undefined" &&
              typeof sessionStorage !== "undefined"
            ) {
              const storageKey = `tanstack_router_reload:${error.message}`;
              if (!sessionStorage.getItem(storageKey)) {
                sessionStorage.setItem(storageKey, "1");
                reload = true;
              }
            }
          }
        });
    return loadPromise;
  };
  const lazyComp = function Lazy(props) {
    if (reload) {
      window.location.reload();
      throw new Promise(() => {});
    }
    if (error) throw error;
    if (!comp)
      if (reactUse) reactUse(load());
      else throw load();
    return import_react.createElement(comp, props);
  };
  lazyComp.preload = load;
  return lazyComp;
}
//#endregion
//#region node_modules/@tanstack/start-server-core/dist/esm/createSsrRpc.js
var createSsrRpc = (functionId) => {
  const url = "/_serverFn/" + functionId;
  const serverFnMeta = { id: functionId };
  const fn = async (...args) => {
    return (await getServerFnById(functionId, { origin: "server" }))(...args);
  };
  return Object.assign(fn, {
    url,
    serverFnMeta,
    [TSS_SERVER_FUNCTION]: true,
  });
};
//#endregion
//#region src/routes/index.tsx
var $$splitComponentImporter = () => import("./routes-x3bk4gyF.js");
var getInfo = createServerFn({ method: "GET" }).handler(
  createSsrRpc("37e67d3ccf1225b287d37f9049d00eb6cc2b71abed75aa21d6cf45b6bbe99560"),
);
var Route = createFileRoute("/")({
  loader: () => getInfo(),
  component: lazyRouteComponent($$splitComponentImporter, "component"),
});
//#endregion
export {
  Link as a,
  createRootRoute as i,
  lazyRouteComponent as n,
  createFileRoute as r,
  Route as t,
};
