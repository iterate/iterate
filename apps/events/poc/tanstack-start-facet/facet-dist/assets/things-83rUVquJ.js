import {
  i as __toESM,
  n as require_react,
  t as require_jsx_runtime,
} from "./jsx-runtime-B9Euz7RS.js";
import {
  B as get,
  U as isAsyncIteratorObject,
  nt as stringifyJSON,
  p as createORPCClient,
  rt as toArray,
} from "./client.DrB9nq_G-C5sxXqjr.js";
import { t as appContract } from "./contract-DV24D5zz.js";
import {
  A as resolveEnabled,
  D as noop,
  F as timeUntilStale,
  I as timeoutManager,
  L as focusManager,
  M as shallowEqualObjects,
  N as shouldThrowError,
  P as skipToken,
  R as Subscribable,
  S as hashKey,
  c as useQueryClient,
  f as fetchState,
  g as environmentManager,
  h as pendingThenable,
  j as resolveStaleTime,
  k as replaceData,
  m as notifyManager,
  n as StandardOpenAPILink,
  u as getDefaultState,
  w as isValidTimeout,
} from "./openapi-client.B2Q9qU5m-BkcU_lpX.js";
import { t as LinkFetchClient } from "./fetch-BU5QGx-J.js";
//#region node_modules/@tanstack/query-core/build/modern/queryObserver.js
var QueryObserver = class extends Subscribable {
  constructor(client, options) {
    super();
    this.options = options;
    this.#client = client;
    this.#selectError = null;
    this.#currentThenable = pendingThenable();
    this.bindMethods();
    this.setOptions(options);
  }
  #client;
  #currentQuery = void 0;
  #currentQueryInitialState = void 0;
  #currentResult = void 0;
  #currentResultState;
  #currentResultOptions;
  #currentThenable;
  #selectError;
  #selectFn;
  #selectResult;
  #lastQueryWithDefinedData;
  #staleTimeoutId;
  #refetchIntervalId;
  #currentRefetchInterval;
  #trackedProps = /* @__PURE__ */ new Set();
  bindMethods() {
    this.refetch = this.refetch.bind(this);
  }
  onSubscribe() {
    if (this.listeners.size === 1) {
      this.#currentQuery.addObserver(this);
      if (shouldFetchOnMount(this.#currentQuery, this.options)) this.#executeFetch();
      else this.updateResult();
      this.#updateTimers();
    }
  }
  onUnsubscribe() {
    if (!this.hasListeners()) this.destroy();
  }
  shouldFetchOnReconnect() {
    return shouldFetchOn(this.#currentQuery, this.options, this.options.refetchOnReconnect);
  }
  shouldFetchOnWindowFocus() {
    return shouldFetchOn(this.#currentQuery, this.options, this.options.refetchOnWindowFocus);
  }
  destroy() {
    this.listeners = /* @__PURE__ */ new Set();
    this.#clearStaleTimeout();
    this.#clearRefetchInterval();
    this.#currentQuery.removeObserver(this);
  }
  setOptions(options) {
    const prevOptions = this.options;
    const prevQuery = this.#currentQuery;
    this.options = this.#client.defaultQueryOptions(options);
    if (
      this.options.enabled !== void 0 &&
      typeof this.options.enabled !== "boolean" &&
      typeof this.options.enabled !== "function" &&
      typeof resolveEnabled(this.options.enabled, this.#currentQuery) !== "boolean"
    )
      throw new Error("Expected enabled to be a boolean or a callback that returns a boolean");
    this.#updateQuery();
    this.#currentQuery.setOptions(this.options);
    if (prevOptions._defaulted && !shallowEqualObjects(this.options, prevOptions))
      this.#client.getQueryCache().notify({
        type: "observerOptionsUpdated",
        query: this.#currentQuery,
        observer: this,
      });
    const mounted = this.hasListeners();
    if (mounted && shouldFetchOptionally(this.#currentQuery, prevQuery, this.options, prevOptions))
      this.#executeFetch();
    this.updateResult();
    if (
      mounted &&
      (this.#currentQuery !== prevQuery ||
        resolveEnabled(this.options.enabled, this.#currentQuery) !==
          resolveEnabled(prevOptions.enabled, this.#currentQuery) ||
        resolveStaleTime(this.options.staleTime, this.#currentQuery) !==
          resolveStaleTime(prevOptions.staleTime, this.#currentQuery))
    )
      this.#updateStaleTimeout();
    const nextRefetchInterval = this.#computeRefetchInterval();
    if (
      mounted &&
      (this.#currentQuery !== prevQuery ||
        resolveEnabled(this.options.enabled, this.#currentQuery) !==
          resolveEnabled(prevOptions.enabled, this.#currentQuery) ||
        nextRefetchInterval !== this.#currentRefetchInterval)
    )
      this.#updateRefetchInterval(nextRefetchInterval);
  }
  getOptimisticResult(options) {
    const query = this.#client.getQueryCache().build(this.#client, options);
    const result = this.createResult(query, options);
    if (shouldAssignObserverCurrentProperties(this, result)) {
      this.#currentResult = result;
      this.#currentResultOptions = this.options;
      this.#currentResultState = this.#currentQuery.state;
    }
    return result;
  }
  getCurrentResult() {
    return this.#currentResult;
  }
  trackResult(result, onPropTracked) {
    return new Proxy(result, {
      get: (target, key) => {
        this.trackProp(key);
        onPropTracked?.(key);
        if (key === "promise") {
          this.trackProp("data");
          if (
            !this.options.experimental_prefetchInRender &&
            this.#currentThenable.status === "pending"
          )
            this.#currentThenable.reject(
              /* @__PURE__ */ new Error(
                "experimental_prefetchInRender feature flag is not enabled",
              ),
            );
        }
        return Reflect.get(target, key);
      },
    });
  }
  trackProp(key) {
    this.#trackedProps.add(key);
  }
  getCurrentQuery() {
    return this.#currentQuery;
  }
  refetch({ ...options } = {}) {
    return this.fetch({ ...options });
  }
  fetchOptimistic(options) {
    const defaultedOptions = this.#client.defaultQueryOptions(options);
    const query = this.#client.getQueryCache().build(this.#client, defaultedOptions);
    return query.fetch().then(() => this.createResult(query, defaultedOptions));
  }
  fetch(fetchOptions) {
    return this.#executeFetch({
      ...fetchOptions,
      cancelRefetch: fetchOptions.cancelRefetch ?? true,
    }).then(() => {
      this.updateResult();
      return this.#currentResult;
    });
  }
  #executeFetch(fetchOptions) {
    this.#updateQuery();
    let promise = this.#currentQuery.fetch(this.options, fetchOptions);
    if (!fetchOptions?.throwOnError) promise = promise.catch(noop);
    return promise;
  }
  #updateStaleTimeout() {
    this.#clearStaleTimeout();
    const staleTime = resolveStaleTime(this.options.staleTime, this.#currentQuery);
    if (environmentManager.isServer() || this.#currentResult.isStale || !isValidTimeout(staleTime))
      return;
    const timeout = timeUntilStale(this.#currentResult.dataUpdatedAt, staleTime) + 1;
    this.#staleTimeoutId = timeoutManager.setTimeout(() => {
      if (!this.#currentResult.isStale) this.updateResult();
    }, timeout);
  }
  #computeRefetchInterval() {
    return (
      (typeof this.options.refetchInterval === "function"
        ? this.options.refetchInterval(this.#currentQuery)
        : this.options.refetchInterval) ?? false
    );
  }
  #updateRefetchInterval(nextInterval) {
    this.#clearRefetchInterval();
    this.#currentRefetchInterval = nextInterval;
    if (
      environmentManager.isServer() ||
      resolveEnabled(this.options.enabled, this.#currentQuery) === false ||
      !isValidTimeout(this.#currentRefetchInterval) ||
      this.#currentRefetchInterval === 0
    )
      return;
    this.#refetchIntervalId = timeoutManager.setInterval(() => {
      if (this.options.refetchIntervalInBackground || focusManager.isFocused())
        this.#executeFetch();
    }, this.#currentRefetchInterval);
  }
  #updateTimers() {
    this.#updateStaleTimeout();
    this.#updateRefetchInterval(this.#computeRefetchInterval());
  }
  #clearStaleTimeout() {
    if (this.#staleTimeoutId !== void 0) {
      timeoutManager.clearTimeout(this.#staleTimeoutId);
      this.#staleTimeoutId = void 0;
    }
  }
  #clearRefetchInterval() {
    if (this.#refetchIntervalId !== void 0) {
      timeoutManager.clearInterval(this.#refetchIntervalId);
      this.#refetchIntervalId = void 0;
    }
  }
  createResult(query, options) {
    const prevQuery = this.#currentQuery;
    const prevOptions = this.options;
    const prevResult = this.#currentResult;
    const prevResultState = this.#currentResultState;
    const prevResultOptions = this.#currentResultOptions;
    const queryInitialState = query !== prevQuery ? query.state : this.#currentQueryInitialState;
    const { state } = query;
    let newState = { ...state };
    let isPlaceholderData = false;
    let data;
    if (options._optimisticResults) {
      const mounted = this.hasListeners();
      const fetchOnMount = !mounted && shouldFetchOnMount(query, options);
      const fetchOptionally =
        mounted && shouldFetchOptionally(query, prevQuery, options, prevOptions);
      if (fetchOnMount || fetchOptionally)
        newState = {
          ...newState,
          ...fetchState(state.data, query.options),
        };
      if (options._optimisticResults === "isRestoring") newState.fetchStatus = "idle";
    }
    let { error, errorUpdatedAt, status } = newState;
    data = newState.data;
    let skipSelect = false;
    if (options.placeholderData !== void 0 && data === void 0 && status === "pending") {
      let placeholderData;
      if (
        prevResult?.isPlaceholderData &&
        options.placeholderData === prevResultOptions?.placeholderData
      ) {
        placeholderData = prevResult.data;
        skipSelect = true;
      } else
        placeholderData =
          typeof options.placeholderData === "function"
            ? options.placeholderData(
                this.#lastQueryWithDefinedData?.state.data,
                this.#lastQueryWithDefinedData,
              )
            : options.placeholderData;
      if (placeholderData !== void 0) {
        status = "success";
        data = replaceData(prevResult?.data, placeholderData, options);
        isPlaceholderData = true;
      }
    }
    if (options.select && data !== void 0 && !skipSelect)
      if (prevResult && data === prevResultState?.data && options.select === this.#selectFn)
        data = this.#selectResult;
      else
        try {
          this.#selectFn = options.select;
          data = options.select(data);
          data = replaceData(prevResult?.data, data, options);
          this.#selectResult = data;
          this.#selectError = null;
        } catch (selectError) {
          this.#selectError = selectError;
        }
    if (this.#selectError) {
      error = this.#selectError;
      data = this.#selectResult;
      errorUpdatedAt = Date.now();
      status = "error";
    }
    const isFetching = newState.fetchStatus === "fetching";
    const isPending = status === "pending";
    const isError = status === "error";
    const isLoading = isPending && isFetching;
    const hasData = data !== void 0;
    const nextResult = {
      status,
      fetchStatus: newState.fetchStatus,
      isPending,
      isSuccess: status === "success",
      isError,
      isInitialLoading: isLoading,
      isLoading,
      data,
      dataUpdatedAt: newState.dataUpdatedAt,
      error,
      errorUpdatedAt,
      failureCount: newState.fetchFailureCount,
      failureReason: newState.fetchFailureReason,
      errorUpdateCount: newState.errorUpdateCount,
      isFetched: query.isFetched(),
      isFetchedAfterMount:
        newState.dataUpdateCount > queryInitialState.dataUpdateCount ||
        newState.errorUpdateCount > queryInitialState.errorUpdateCount,
      isFetching,
      isRefetching: isFetching && !isPending,
      isLoadingError: isError && !hasData,
      isPaused: newState.fetchStatus === "paused",
      isPlaceholderData,
      isRefetchError: isError && hasData,
      isStale: isStale(query, options),
      refetch: this.refetch,
      promise: this.#currentThenable,
      isEnabled: resolveEnabled(options.enabled, query) !== false,
    };
    if (this.options.experimental_prefetchInRender) {
      const hasResultData = nextResult.data !== void 0;
      const isErrorWithoutData = nextResult.status === "error" && !hasResultData;
      const finalizeThenableIfPossible = (thenable) => {
        if (isErrorWithoutData) thenable.reject(nextResult.error);
        else if (hasResultData) thenable.resolve(nextResult.data);
      };
      const recreateThenable = () => {
        finalizeThenableIfPossible(
          (this.#currentThenable = nextResult.promise = pendingThenable()),
        );
      };
      const prevThenable = this.#currentThenable;
      switch (prevThenable.status) {
        case "pending":
          if (query.queryHash === prevQuery.queryHash) finalizeThenableIfPossible(prevThenable);
          break;
        case "fulfilled":
          if (isErrorWithoutData || nextResult.data !== prevThenable.value) recreateThenable();
          break;
        case "rejected":
          if (!isErrorWithoutData || nextResult.error !== prevThenable.reason) recreateThenable();
          break;
      }
    }
    return nextResult;
  }
  updateResult() {
    const prevResult = this.#currentResult;
    const nextResult = this.createResult(this.#currentQuery, this.options);
    this.#currentResultState = this.#currentQuery.state;
    this.#currentResultOptions = this.options;
    if (this.#currentResultState.data !== void 0)
      this.#lastQueryWithDefinedData = this.#currentQuery;
    if (shallowEqualObjects(nextResult, prevResult)) return;
    this.#currentResult = nextResult;
    const shouldNotifyListeners = () => {
      if (!prevResult) return true;
      const { notifyOnChangeProps } = this.options;
      const notifyOnChangePropsValue =
        typeof notifyOnChangeProps === "function" ? notifyOnChangeProps() : notifyOnChangeProps;
      if (
        notifyOnChangePropsValue === "all" ||
        (!notifyOnChangePropsValue && !this.#trackedProps.size)
      )
        return true;
      const includedProps = new Set(notifyOnChangePropsValue ?? this.#trackedProps);
      if (this.options.throwOnError) includedProps.add("error");
      return Object.keys(this.#currentResult).some((key) => {
        const typedKey = key;
        return (
          this.#currentResult[typedKey] !== prevResult[typedKey] && includedProps.has(typedKey)
        );
      });
    };
    this.#notify({ listeners: shouldNotifyListeners() });
  }
  #updateQuery() {
    const query = this.#client.getQueryCache().build(this.#client, this.options);
    if (query === this.#currentQuery) return;
    const prevQuery = this.#currentQuery;
    this.#currentQuery = query;
    this.#currentQueryInitialState = query.state;
    if (this.hasListeners()) {
      prevQuery?.removeObserver(this);
      query.addObserver(this);
    }
  }
  onQueryUpdate() {
    this.updateResult();
    if (this.hasListeners()) this.#updateTimers();
  }
  #notify(notifyOptions) {
    notifyManager.batch(() => {
      if (notifyOptions.listeners)
        this.listeners.forEach((listener) => {
          listener(this.#currentResult);
        });
      this.#client.getQueryCache().notify({
        query: this.#currentQuery,
        type: "observerResultsUpdated",
      });
    });
  }
};
function shouldLoadOnMount(query, options) {
  return (
    resolveEnabled(options.enabled, query) !== false &&
    query.state.data === void 0 &&
    !(query.state.status === "error" && options.retryOnMount === false)
  );
}
function shouldFetchOnMount(query, options) {
  return (
    shouldLoadOnMount(query, options) ||
    (query.state.data !== void 0 && shouldFetchOn(query, options, options.refetchOnMount))
  );
}
function shouldFetchOn(query, options, field) {
  if (
    resolveEnabled(options.enabled, query) !== false &&
    resolveStaleTime(options.staleTime, query) !== "static"
  ) {
    const value = typeof field === "function" ? field(query) : field;
    return value === "always" || (value !== false && isStale(query, options));
  }
  return false;
}
function shouldFetchOptionally(query, prevQuery, options, prevOptions) {
  return (
    (query !== prevQuery || resolveEnabled(prevOptions.enabled, query) === false) &&
    (!options.suspense || query.state.status !== "error") &&
    isStale(query, options)
  );
}
function isStale(query, options) {
  return (
    resolveEnabled(options.enabled, query) !== false &&
    query.isStaleByTime(resolveStaleTime(options.staleTime, query))
  );
}
function shouldAssignObserverCurrentProperties(observer, optimisticResult) {
  if (!shallowEqualObjects(observer.getCurrentResult(), optimisticResult)) return true;
  return false;
}
//#endregion
//#region node_modules/@tanstack/query-core/build/modern/mutationObserver.js
var MutationObserver = class extends Subscribable {
  #client;
  #currentResult = void 0;
  #currentMutation;
  #mutateOptions;
  constructor(client, options) {
    super();
    this.#client = client;
    this.setOptions(options);
    this.bindMethods();
    this.#updateResult();
  }
  bindMethods() {
    this.mutate = this.mutate.bind(this);
    this.reset = this.reset.bind(this);
  }
  setOptions(options) {
    const prevOptions = this.options;
    this.options = this.#client.defaultMutationOptions(options);
    if (!shallowEqualObjects(this.options, prevOptions))
      this.#client.getMutationCache().notify({
        type: "observerOptionsUpdated",
        mutation: this.#currentMutation,
        observer: this,
      });
    if (
      prevOptions?.mutationKey &&
      this.options.mutationKey &&
      hashKey(prevOptions.mutationKey) !== hashKey(this.options.mutationKey)
    )
      this.reset();
    else if (this.#currentMutation?.state.status === "pending")
      this.#currentMutation.setOptions(this.options);
  }
  onUnsubscribe() {
    if (!this.hasListeners()) this.#currentMutation?.removeObserver(this);
  }
  onMutationUpdate(action) {
    this.#updateResult();
    this.#notify(action);
  }
  getCurrentResult() {
    return this.#currentResult;
  }
  reset() {
    this.#currentMutation?.removeObserver(this);
    this.#currentMutation = void 0;
    this.#updateResult();
    this.#notify();
  }
  mutate(variables, options) {
    this.#mutateOptions = options;
    this.#currentMutation?.removeObserver(this);
    this.#currentMutation = this.#client.getMutationCache().build(this.#client, this.options);
    this.#currentMutation.addObserver(this);
    return this.#currentMutation.execute(variables);
  }
  #updateResult() {
    const state = this.#currentMutation?.state ?? getDefaultState();
    this.#currentResult = {
      ...state,
      isPending: state.status === "pending",
      isSuccess: state.status === "success",
      isError: state.status === "error",
      isIdle: state.status === "idle",
      mutate: this.mutate,
      reset: this.reset,
    };
  }
  #notify(action) {
    notifyManager.batch(() => {
      if (this.#mutateOptions && this.hasListeners()) {
        const variables = this.#currentResult.variables;
        const onMutateResult = this.#currentResult.context;
        const context = {
          client: this.#client,
          meta: this.options.meta,
          mutationKey: this.options.mutationKey,
        };
        if (action?.type === "success") {
          try {
            this.#mutateOptions.onSuccess?.(action.data, variables, onMutateResult, context);
          } catch (e) {
            Promise.reject(e);
          }
          try {
            this.#mutateOptions.onSettled?.(action.data, null, variables, onMutateResult, context);
          } catch (e) {
            Promise.reject(e);
          }
        } else if (action?.type === "error") {
          try {
            this.#mutateOptions.onError?.(action.error, variables, onMutateResult, context);
          } catch (e) {
            Promise.reject(e);
          }
          try {
            this.#mutateOptions.onSettled?.(
              void 0,
              action.error,
              variables,
              onMutateResult,
              context,
            );
          } catch (e) {
            Promise.reject(e);
          }
        }
      }
      this.listeners.forEach((listener) => {
        listener(this.#currentResult);
      });
    });
  }
};
//#endregion
//#region node_modules/@tanstack/react-query/build/modern/IsRestoringProvider.js
var import_react = /* @__PURE__ */ __toESM(require_react(), 1);
var IsRestoringContext = import_react.createContext(false);
var useIsRestoring = () => import_react.useContext(IsRestoringContext);
IsRestoringContext.Provider;
//#endregion
//#region node_modules/@tanstack/react-query/build/modern/QueryErrorResetBoundary.js
var import_jsx_runtime = require_jsx_runtime();
function createValue() {
  let isReset = false;
  return {
    clearReset: () => {
      isReset = false;
    },
    reset: () => {
      isReset = true;
    },
    isReset: () => {
      return isReset;
    },
  };
}
var QueryErrorResetBoundaryContext = import_react.createContext(createValue());
var useQueryErrorResetBoundary = () => import_react.useContext(QueryErrorResetBoundaryContext);
//#endregion
//#region node_modules/@tanstack/react-query/build/modern/errorBoundaryUtils.js
var ensurePreventErrorBoundaryRetry = (options, errorResetBoundary, query) => {
  const throwOnError =
    query?.state.error && typeof options.throwOnError === "function"
      ? shouldThrowError(options.throwOnError, [query.state.error, query])
      : options.throwOnError;
  if (options.suspense || options.experimental_prefetchInRender || throwOnError) {
    if (!errorResetBoundary.isReset()) options.retryOnMount = false;
  }
};
var useClearResetErrorBoundary = (errorResetBoundary) => {
  import_react.useEffect(() => {
    errorResetBoundary.clearReset();
  }, [errorResetBoundary]);
};
var getHasError = ({ result, errorResetBoundary, throwOnError, query, suspense }) => {
  return (
    result.isError &&
    !errorResetBoundary.isReset() &&
    !result.isFetching &&
    query &&
    ((suspense && result.data === void 0) || shouldThrowError(throwOnError, [result.error, query]))
  );
};
//#endregion
//#region node_modules/@tanstack/react-query/build/modern/suspense.js
var ensureSuspenseTimers = (defaultedOptions) => {
  if (defaultedOptions.suspense) {
    const MIN_SUSPENSE_TIME_MS = 1e3;
    const clamp = (value) =>
      value === "static" ? value : Math.max(value ?? MIN_SUSPENSE_TIME_MS, MIN_SUSPENSE_TIME_MS);
    const originalStaleTime = defaultedOptions.staleTime;
    defaultedOptions.staleTime =
      typeof originalStaleTime === "function"
        ? (...args) => clamp(originalStaleTime(...args))
        : clamp(originalStaleTime);
    if (typeof defaultedOptions.gcTime === "number")
      defaultedOptions.gcTime = Math.max(defaultedOptions.gcTime, MIN_SUSPENSE_TIME_MS);
  }
};
var willFetch = (result, isRestoring) => result.isLoading && result.isFetching && !isRestoring;
var shouldSuspend = (defaultedOptions, result) => defaultedOptions?.suspense && result.isPending;
var fetchOptimistic = (defaultedOptions, observer, errorResetBoundary) =>
  observer.fetchOptimistic(defaultedOptions).catch(() => {
    errorResetBoundary.clearReset();
  });
//#endregion
//#region node_modules/@tanstack/react-query/build/modern/useBaseQuery.js
function useBaseQuery(options, Observer, queryClient) {
  const isRestoring = useIsRestoring();
  const errorResetBoundary = useQueryErrorResetBoundary();
  const client = useQueryClient(queryClient);
  const defaultedOptions = client.defaultQueryOptions(options);
  client.getDefaultOptions().queries?._experimental_beforeQuery?.(defaultedOptions);
  const query = client.getQueryCache().get(defaultedOptions.queryHash);
  defaultedOptions._optimisticResults = isRestoring ? "isRestoring" : "optimistic";
  ensureSuspenseTimers(defaultedOptions);
  ensurePreventErrorBoundaryRetry(defaultedOptions, errorResetBoundary, query);
  useClearResetErrorBoundary(errorResetBoundary);
  const isNewCacheEntry = !client.getQueryCache().get(defaultedOptions.queryHash);
  const [observer] = import_react.useState(() => new Observer(client, defaultedOptions));
  const result = observer.getOptimisticResult(defaultedOptions);
  const shouldSubscribe = !isRestoring && options.subscribed !== false;
  import_react.useSyncExternalStore(
    import_react.useCallback(
      (onStoreChange) => {
        const unsubscribe = shouldSubscribe
          ? observer.subscribe(notifyManager.batchCalls(onStoreChange))
          : noop;
        observer.updateResult();
        return unsubscribe;
      },
      [observer, shouldSubscribe],
    ),
    () => observer.getCurrentResult(),
    () => observer.getCurrentResult(),
  );
  import_react.useEffect(() => {
    observer.setOptions(defaultedOptions);
  }, [defaultedOptions, observer]);
  if (shouldSuspend(defaultedOptions, result))
    throw fetchOptimistic(defaultedOptions, observer, errorResetBoundary);
  if (
    getHasError({
      result,
      errorResetBoundary,
      throwOnError: defaultedOptions.throwOnError,
      query,
      suspense: defaultedOptions.suspense,
    })
  )
    throw result.error;
  client.getDefaultOptions().queries?._experimental_afterQuery?.(defaultedOptions, result);
  if (
    defaultedOptions.experimental_prefetchInRender &&
    !environmentManager.isServer() &&
    willFetch(result, isRestoring)
  )
    (isNewCacheEntry
      ? fetchOptimistic(defaultedOptions, observer, errorResetBoundary)
      : query?.promise
    )
      ?.catch(noop)
      .finally(() => {
        observer.updateResult();
      });
  return !defaultedOptions.notifyOnChangeProps ? observer.trackResult(result) : result;
}
//#endregion
//#region node_modules/@tanstack/react-query/build/modern/useQuery.js
function useQuery(options, queryClient) {
  return useBaseQuery(options, QueryObserver, queryClient);
}
//#endregion
//#region node_modules/@tanstack/react-query/build/modern/useMutation.js
function useMutation(options, queryClient) {
  const client = useQueryClient(queryClient);
  const [observer] = import_react.useState(() => new MutationObserver(client, options));
  import_react.useEffect(() => {
    observer.setOptions(options);
  }, [observer, options]);
  const result = import_react.useSyncExternalStore(
    import_react.useCallback(
      (onStoreChange) => observer.subscribe(notifyManager.batchCalls(onStoreChange)),
      [observer],
    ),
    () => observer.getCurrentResult(),
    () => observer.getCurrentResult(),
  );
  const mutate = import_react.useCallback(
    (variables, mutateOptions) => {
      observer.mutate(variables, mutateOptions).catch(noop);
    },
    [observer],
  );
  if (result.error && shouldThrowError(observer.options.throwOnError, [result.error]))
    throw result.error;
  return {
    ...result,
    mutate,
    mutateAsync: result.mutate,
  };
}
//#endregion
//#region node_modules/@orpc/openapi-client/dist/adapters/fetch/index.mjs
var OpenAPILink = class extends StandardOpenAPILink {
  constructor(contract, options) {
    const linkClient = new LinkFetchClient(options);
    super(contract, linkClient, options);
  }
};
//#endregion
//#region node_modules/@orpc/tanstack-query/dist/index.mjs
function generateOperationKey(path, state = {}) {
  return [
    path,
    {
      ...(state.input !== void 0 ? { input: state.input } : {}),
      ...(state.type !== void 0 ? { type: state.type } : {}),
      ...(state.fnOptions !== void 0 ? { fnOptions: state.fnOptions } : {}),
    },
  ];
}
function createGeneralUtils(path) {
  return {
    key(options) {
      return generateOperationKey(path, options);
    },
  };
}
function experimental_liveQuery(queryFn) {
  return async (context) => {
    const stream = await queryFn(context);
    let last;
    for await (const chunk of stream) {
      if (context.signal.aborted) throw context.signal.reason;
      last = { chunk };
      context.client.setQueryData(context.queryKey, chunk);
    }
    if (!last)
      throw new Error(
        `Live query for ${stringifyJSON(context.queryKey)} did not yield any data. Ensure the query function returns an AsyncIterable with at least one chunk.`,
      );
    return last.chunk;
  };
}
function experimental_serializableStreamedQuery(
  queryFn,
  { refetchMode = "reset", maxChunks = Number.POSITIVE_INFINITY } = {},
) {
  return async (context) => {
    const query = context.client.getQueryCache().find({
      queryKey: context.queryKey,
      exact: true,
    });
    const hasPreviousData = !!query && query.state.data !== void 0;
    if (hasPreviousData)
      if (refetchMode === "reset")
        query.setState({
          status: "pending",
          data: void 0,
          error: null,
          fetchStatus: "fetching",
        });
      else
        context.client.setQueryData(context.queryKey, (prev = []) =>
          limitArraySize(prev, maxChunks),
        );
    let result = [];
    const stream = await queryFn(context);
    const shouldUpdateCacheDuringStream = !hasPreviousData || refetchMode !== "replace";
    context.client.setQueryData(context.queryKey, (prev = []) => limitArraySize(prev, maxChunks));
    for await (const chunk of stream) {
      if (context.signal.aborted) throw context.signal.reason;
      result.push(chunk);
      result = limitArraySize(result, maxChunks);
      if (shouldUpdateCacheDuringStream)
        context.client.setQueryData(context.queryKey, (prev = []) =>
          limitArraySize([...prev, chunk], maxChunks),
        );
    }
    if (!shouldUpdateCacheDuringStream) context.client.setQueryData(context.queryKey, result);
    const cachedData = context.client.getQueryData(context.queryKey);
    if (cachedData) return limitArraySize(cachedData, maxChunks);
    return result;
  };
}
function limitArraySize(items, maxSize) {
  if (items.length <= maxSize) return items;
  return items.slice(items.length - maxSize);
}
var OPERATION_CONTEXT_SYMBOL = Symbol("ORPC_OPERATION_CONTEXT");
function createProcedureUtils(client, options) {
  const utils = {
    call: client,
    queryKey(...[optionsIn = {}]) {
      optionsIn = {
        ...options.experimental_defaults?.queryKey,
        ...optionsIn,
      };
      return (
        optionsIn.queryKey ??
        generateOperationKey(options.path, {
          type: "query",
          input: optionsIn.input,
        })
      );
    },
    queryOptions(...[optionsIn = {}]) {
      optionsIn = {
        ...options.experimental_defaults?.queryOptions,
        ...optionsIn,
      };
      const queryKey = utils.queryKey(optionsIn);
      return {
        queryFn: ({ signal }) => {
          if (optionsIn.input === skipToken)
            throw new Error("queryFn should not be called with skipToken used as input");
          return client(optionsIn.input, {
            signal,
            context: {
              [OPERATION_CONTEXT_SYMBOL]: {
                key: queryKey,
                type: "query",
              },
              ...optionsIn.context,
            },
          });
        },
        ...(optionsIn.input === skipToken ? { enabled: false } : {}),
        ...optionsIn,
        queryKey,
      };
    },
    experimental_streamedKey(...[optionsIn = {}]) {
      optionsIn = {
        ...options.experimental_defaults?.experimental_streamedKey,
        ...optionsIn,
      };
      return (
        optionsIn.queryKey ??
        generateOperationKey(options.path, {
          type: "streamed",
          input: optionsIn.input,
          fnOptions: optionsIn.queryFnOptions,
        })
      );
    },
    experimental_streamedOptions(...[optionsIn = {}]) {
      optionsIn = {
        ...options.experimental_defaults?.experimental_streamedOptions,
        ...optionsIn,
      };
      const queryKey = utils.experimental_streamedKey(optionsIn);
      return {
        queryFn: experimental_serializableStreamedQuery(async ({ signal }) => {
          if (optionsIn.input === skipToken)
            throw new Error("queryFn should not be called with skipToken used as input");
          const output = await client(optionsIn.input, {
            signal,
            context: {
              [OPERATION_CONTEXT_SYMBOL]: {
                key: queryKey,
                type: "streamed",
              },
              ...optionsIn.context,
            },
          });
          if (!isAsyncIteratorObject(output))
            throw new Error("streamedQuery requires an event iterator output");
          return output;
        }, optionsIn.queryFnOptions),
        ...(optionsIn.input === skipToken ? { enabled: false } : {}),
        ...optionsIn,
        queryKey,
      };
    },
    experimental_liveKey(...[optionsIn = {}]) {
      optionsIn = {
        ...options.experimental_defaults?.experimental_liveKey,
        ...optionsIn,
      };
      return (
        optionsIn.queryKey ??
        generateOperationKey(options.path, {
          type: "live",
          input: optionsIn.input,
        })
      );
    },
    experimental_liveOptions(...[optionsIn = {}]) {
      optionsIn = {
        ...options.experimental_defaults?.experimental_liveOptions,
        ...optionsIn,
      };
      const queryKey = utils.experimental_liveKey(optionsIn);
      return {
        queryFn: experimental_liveQuery(async ({ signal }) => {
          if (optionsIn.input === skipToken)
            throw new Error("queryFn should not be called with skipToken used as input");
          const output = await client(optionsIn.input, {
            signal,
            context: {
              [OPERATION_CONTEXT_SYMBOL]: {
                key: queryKey,
                type: "live",
              },
              ...optionsIn.context,
            },
          });
          if (!isAsyncIteratorObject(output))
            throw new Error("liveQuery requires an event iterator output");
          return output;
        }),
        ...(optionsIn.input === skipToken ? { enabled: false } : {}),
        ...optionsIn,
        queryKey,
      };
    },
    infiniteKey(optionsIn) {
      optionsIn = {
        ...options.experimental_defaults?.infiniteKey,
        ...optionsIn,
      };
      return (
        optionsIn.queryKey ??
        generateOperationKey(options.path, {
          type: "infinite",
          input:
            optionsIn.input === skipToken ? skipToken : optionsIn.input(optionsIn.initialPageParam),
        })
      );
    },
    infiniteOptions(optionsIn) {
      optionsIn = {
        ...options.experimental_defaults?.infiniteOptions,
        ...optionsIn,
      };
      const queryKey = utils.infiniteKey(optionsIn);
      return {
        queryFn: ({ pageParam, signal }) => {
          if (optionsIn.input === skipToken)
            throw new Error("queryFn should not be called with skipToken used as input");
          return client(optionsIn.input(pageParam), {
            signal,
            context: {
              [OPERATION_CONTEXT_SYMBOL]: {
                key: queryKey,
                type: "infinite",
              },
              ...optionsIn.context,
            },
          });
        },
        ...(optionsIn.input === skipToken ? { enabled: false } : {}),
        ...optionsIn,
        queryKey,
      };
    },
    mutationKey(...[optionsIn = {}]) {
      optionsIn = {
        ...options.experimental_defaults?.mutationKey,
        ...optionsIn,
      };
      return optionsIn.mutationKey ?? generateOperationKey(options.path, { type: "mutation" });
    },
    mutationOptions(...[optionsIn = {}]) {
      optionsIn = {
        ...options.experimental_defaults?.mutationOptions,
        ...optionsIn,
      };
      const mutationKey = utils.mutationKey(optionsIn);
      return {
        mutationFn: (input) =>
          client(input, {
            context: {
              [OPERATION_CONTEXT_SYMBOL]: {
                key: mutationKey,
                type: "mutation",
              },
              ...optionsIn.context,
            },
          }),
        ...optionsIn,
        mutationKey,
      };
    },
  };
  return utils;
}
function createRouterUtils(client, options = {}) {
  const path = toArray(options.path);
  const generalUtils = createGeneralUtils(path);
  const procedureUtils = createProcedureUtils(client, {
    path,
    experimental_defaults: options.experimental_defaults,
  });
  return new Proxy(
    {
      ...generalUtils,
      ...procedureUtils,
    },
    {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (typeof prop !== "string") return value;
        const nextUtils = createRouterUtils(client[prop], {
          ...options,
          path: [...path, prop],
          experimental_defaults: get(options.experimental_defaults, [prop]),
        });
        if (typeof value !== "function") return nextUtils;
        return new Proxy(value, {
          get(_, prop2) {
            return Reflect.get(nextUtils, prop2);
          },
        });
      },
    },
  );
}
//#endregion
//#region src/orpc/client.ts
function createOpenApiClient() {
  return createORPCClient(new OpenAPILink(appContract, { url: `${window.location.origin}/api` }));
}
var cached;
function getClient() {
  if (typeof window === "undefined")
    return createORPCClient(new OpenAPILink(appContract, { url: "http://localhost/api" }));
  cached ??= createOpenApiClient();
  return cached;
}
var orpc = createRouterUtils(getClient());
//#endregion
//#region src/routes/things.tsx?tsr-split=component
function Things() {
  const queryClient = useQueryClient();
  const client = getClient();
  const [newName, setNewName] = (0, import_react.useState)("");
  const { data, isPending, error } = useQuery(orpc.things.list.queryOptions());
  const createMutation = useMutation({
    mutationFn: (name) => client.things.create({ name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.things.list.queryOptions().queryKey });
      setNewName("");
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (id) => client.things.remove({ id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.things.list.queryOptions().queryKey });
    },
  });
  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    createMutation.mutate(trimmed);
  };
  const things = data?.items ?? [];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("main", {
    children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", { children: "Things" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
        children: [
          "CRUD via ",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "@orpc/openapi-client" }),
          " → ",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "OpenAPIHandler" }),
          ". Typed end-to-end from contract to UI.",
        ],
      }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", {
        onSubmit: handleSubmit,
        style: {
          display: "flex",
          gap: "0.5rem",
          marginBottom: "1.5rem",
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
            type: "text",
            value: newName,
            onChange: (e) => setNewName(e.target.value),
            placeholder: "New thing...",
            disabled: createMutation.isPending,
            style: { flex: 1 },
          }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
            type: "submit",
            className: "btn-primary",
            disabled: createMutation.isPending || !newName.trim(),
            children: createMutation.isPending ? "Creating..." : "Create",
          }),
        ],
      }),
      isPending &&
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
          style: { color: "#888" },
          children: "Loading...",
        }),
      error &&
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
          style: {
            color: "#fca5a5",
            background: "#450a0a",
          },
          children: error.message,
        }),
      things.length === 0 &&
        !isPending &&
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
          style: {
            color: "#555",
            textAlign: "center",
            padding: "2rem",
          },
          children: "No things yet.",
        }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
        },
        children: things.map((thing) =>
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "div",
            {
              className: "card",
              style: {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
                  children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
                      style: { fontWeight: 500 },
                      children: thing.name,
                    }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
                      style: {
                        fontSize: "0.75rem",
                        color: "#666",
                        marginTop: "0.2rem",
                      },
                      children: [thing.id, " · ", new Date(thing.createdAt).toLocaleString()],
                    }),
                  ],
                }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
                  className: "btn-danger",
                  onClick: () => deleteMutation.mutate(thing.id),
                  disabled: deleteMutation.isPending,
                  style: {
                    fontSize: "0.75rem",
                    padding: "0.3rem 0.6rem",
                  },
                  children: "Delete",
                }),
              ],
            },
            thing.id,
          ),
        ),
      }),
      data &&
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
          style: {
            marginTop: "1rem",
            fontSize: "0.8rem",
            color: "#555",
          },
          children: [
            data.total,
            " total · via ",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "OpenAPILink" }),
            " → ",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "GET /api/things" }),
          ],
        }),
    ],
  });
}
//#endregion
export { Things as component };
