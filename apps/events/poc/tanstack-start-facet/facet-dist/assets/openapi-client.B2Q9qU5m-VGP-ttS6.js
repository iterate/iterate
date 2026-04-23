import {
  a as __toESM,
  n as require_react,
  t as require_jsx_runtime,
} from "./jsx-runtime-B8ri5dzN.js";
import {
  B as get,
  P as NullProtoObj,
  S as ErrorEvent,
  U as isAsyncIteratorObject,
  W as isObject,
  at as value,
  b as isORPCErrorStatus,
  c as toStandardHeaders,
  g as createORPCErrorFromJson,
  h as ORPCError,
  k as mergeStandardHeaders,
  m as mapEventIterator,
  n as StandardLink,
  o as getMalformedResponseErrorCode,
  s as toHttpPath,
  v as fallbackORPCErrorStatus,
  x as toORPCError,
  y as isORPCErrorJson,
} from "./client.DrB9nq_G-HI4B2Z7U.js";
//#region node_modules/@tanstack/query-core/build/modern/subscribable.js
var Subscribable = class {
  constructor() {
    this.listeners = /* @__PURE__ */ new Set();
    this.subscribe = this.subscribe.bind(this);
  }
  subscribe(listener) {
    this.listeners.add(listener);
    this.onSubscribe();
    return () => {
      this.listeners.delete(listener);
      this.onUnsubscribe();
    };
  }
  hasListeners() {
    return this.listeners.size > 0;
  }
  onSubscribe() {}
  onUnsubscribe() {}
};
//#endregion
//#region node_modules/@tanstack/query-core/build/modern/focusManager.js
var FocusManager = class extends Subscribable {
  #focused;
  #cleanup;
  #setup;
  constructor() {
    super();
    this.#setup = (onFocus) => {
      if (typeof window !== "undefined" && window.addEventListener) {
        const listener = () => onFocus();
        window.addEventListener("visibilitychange", listener, false);
        return () => {
          window.removeEventListener("visibilitychange", listener);
        };
      }
    };
  }
  onSubscribe() {
    if (!this.#cleanup) this.setEventListener(this.#setup);
  }
  onUnsubscribe() {
    if (!this.hasListeners()) {
      this.#cleanup?.();
      this.#cleanup = void 0;
    }
  }
  setEventListener(setup) {
    this.#setup = setup;
    this.#cleanup?.();
    this.#cleanup = setup((focused) => {
      if (typeof focused === "boolean") this.setFocused(focused);
      else this.onFocus();
    });
  }
  setFocused(focused) {
    if (this.#focused !== focused) {
      this.#focused = focused;
      this.onFocus();
    }
  }
  onFocus() {
    const isFocused = this.isFocused();
    this.listeners.forEach((listener) => {
      listener(isFocused);
    });
  }
  isFocused() {
    if (typeof this.#focused === "boolean") return this.#focused;
    return globalThis.document?.visibilityState !== "hidden";
  }
};
var focusManager = new FocusManager();
//#endregion
//#region node_modules/@tanstack/query-core/build/modern/timeoutManager.js
var defaultTimeoutProvider = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timeoutId) => clearTimeout(timeoutId),
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (intervalId) => clearInterval(intervalId),
};
var TimeoutManager = class {
  #provider = defaultTimeoutProvider;
  #providerCalled = false;
  setTimeoutProvider(provider) {
    this.#provider = provider;
  }
  setTimeout(callback, delay) {
    return this.#provider.setTimeout(callback, delay);
  }
  clearTimeout(timeoutId) {
    this.#provider.clearTimeout(timeoutId);
  }
  setInterval(callback, delay) {
    return this.#provider.setInterval(callback, delay);
  }
  clearInterval(intervalId) {
    this.#provider.clearInterval(intervalId);
  }
};
var timeoutManager = new TimeoutManager();
function systemSetTimeoutZero(callback) {
  setTimeout(callback, 0);
}
//#endregion
//#region node_modules/@tanstack/query-core/build/modern/utils.js
var isServer = typeof window === "undefined" || "Deno" in globalThis;
function noop() {}
function functionalUpdate(updater, input) {
  return typeof updater === "function" ? updater(input) : updater;
}
function isValidTimeout(value) {
  return typeof value === "number" && value >= 0 && value !== Infinity;
}
function timeUntilStale(updatedAt, staleTime) {
  return Math.max(updatedAt + (staleTime || 0) - Date.now(), 0);
}
function resolveStaleTime(staleTime, query) {
  return typeof staleTime === "function" ? staleTime(query) : staleTime;
}
function resolveEnabled(enabled, query) {
  return typeof enabled === "function" ? enabled(query) : enabled;
}
function matchQuery(filters, query) {
  const { type = "all", exact, fetchStatus, predicate, queryKey, stale } = filters;
  if (queryKey) {
    if (exact) {
      if (query.queryHash !== hashQueryKeyByOptions(queryKey, query.options)) return false;
    } else if (!partialMatchKey(query.queryKey, queryKey)) return false;
  }
  if (type !== "all") {
    const isActive = query.isActive();
    if (type === "active" && !isActive) return false;
    if (type === "inactive" && isActive) return false;
  }
  if (typeof stale === "boolean" && query.isStale() !== stale) return false;
  if (fetchStatus && fetchStatus !== query.state.fetchStatus) return false;
  if (predicate && !predicate(query)) return false;
  return true;
}
function matchMutation(filters, mutation) {
  const { exact, status, predicate, mutationKey } = filters;
  if (mutationKey) {
    if (!mutation.options.mutationKey) return false;
    if (exact) {
      if (hashKey(mutation.options.mutationKey) !== hashKey(mutationKey)) return false;
    } else if (!partialMatchKey(mutation.options.mutationKey, mutationKey)) return false;
  }
  if (status && mutation.state.status !== status) return false;
  if (predicate && !predicate(mutation)) return false;
  return true;
}
function hashQueryKeyByOptions(queryKey, options) {
  return (options?.queryKeyHashFn || hashKey)(queryKey);
}
function hashKey(queryKey) {
  return JSON.stringify(queryKey, (_, val) =>
    isPlainObject(val)
      ? Object.keys(val)
          .sort()
          .reduce((result, key) => {
            result[key] = val[key];
            return result;
          }, {})
      : val,
  );
}
function partialMatchKey(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object" && typeof b === "object")
    return Object.keys(b).every((key) => partialMatchKey(a[key], b[key]));
  return false;
}
var hasOwn = Object.prototype.hasOwnProperty;
function replaceEqualDeep(a, b, depth = 0) {
  if (a === b) return a;
  if (depth > 500) return b;
  const array = isPlainArray(a) && isPlainArray(b);
  if (!array && !(isPlainObject(a) && isPlainObject(b))) return b;
  const aSize = (array ? a : Object.keys(a)).length;
  const bItems = array ? b : Object.keys(b);
  const bSize = bItems.length;
  const copy = array ? new Array(bSize) : {};
  let equalItems = 0;
  for (let i = 0; i < bSize; i++) {
    const key = array ? i : bItems[i];
    const aItem = a[key];
    const bItem = b[key];
    if (aItem === bItem) {
      copy[key] = aItem;
      if (array ? i < aSize : hasOwn.call(a, key)) equalItems++;
      continue;
    }
    if (
      aItem === null ||
      bItem === null ||
      typeof aItem !== "object" ||
      typeof bItem !== "object"
    ) {
      copy[key] = bItem;
      continue;
    }
    const v = replaceEqualDeep(aItem, bItem, depth + 1);
    copy[key] = v;
    if (v === aItem) equalItems++;
  }
  return aSize === bSize && equalItems === aSize ? a : copy;
}
function shallowEqualObjects(a, b) {
  if (!b || Object.keys(a).length !== Object.keys(b).length) return false;
  for (const key in a) if (a[key] !== b[key]) return false;
  return true;
}
function isPlainArray(value) {
  return Array.isArray(value) && value.length === Object.keys(value).length;
}
function isPlainObject(o) {
  if (!hasObjectPrototype(o)) return false;
  const ctor = o.constructor;
  if (ctor === void 0) return true;
  const prot = ctor.prototype;
  if (!hasObjectPrototype(prot)) return false;
  if (!prot.hasOwnProperty("isPrototypeOf")) return false;
  if (Object.getPrototypeOf(o) !== Object.prototype) return false;
  return true;
}
function hasObjectPrototype(o) {
  return Object.prototype.toString.call(o) === "[object Object]";
}
function sleep(timeout) {
  return new Promise((resolve) => {
    timeoutManager.setTimeout(resolve, timeout);
  });
}
function replaceData(prevData, data, options) {
  if (typeof options.structuralSharing === "function")
    return options.structuralSharing(prevData, data);
  else if (options.structuralSharing !== false) return replaceEqualDeep(prevData, data);
  return data;
}
function addToEnd(items, item, max = 0) {
  const newItems = [...items, item];
  return max && newItems.length > max ? newItems.slice(1) : newItems;
}
function addToStart(items, item, max = 0) {
  const newItems = [item, ...items];
  return max && newItems.length > max ? newItems.slice(0, -1) : newItems;
}
var skipToken = /* @__PURE__ */ Symbol();
function ensureQueryFn(options, fetchOptions) {
  if (!options.queryFn && fetchOptions?.initialPromise) return () => fetchOptions.initialPromise;
  if (!options.queryFn || options.queryFn === skipToken)
    return () =>
      Promise.reject(/* @__PURE__ */ new Error(`Missing queryFn: '${options.queryHash}'`));
  return options.queryFn;
}
function shouldThrowError(throwOnError, params) {
  if (typeof throwOnError === "function") return throwOnError(...params);
  return !!throwOnError;
}
function addConsumeAwareSignal(object, getSignal, onCancelled) {
  let consumed = false;
  let signal;
  Object.defineProperty(object, "signal", {
    enumerable: true,
    get: () => {
      signal ??= getSignal();
      if (consumed) return signal;
      consumed = true;
      if (signal.aborted) onCancelled();
      else signal.addEventListener("abort", onCancelled, { once: true });
      return signal;
    },
  });
  return object;
}
//#endregion
//#region node_modules/@tanstack/query-core/build/modern/environmentManager.js
var environmentManager = /* @__PURE__ */ (() => {
  let isServerFn = () => isServer;
  return {
    /**
     * Returns whether the current runtime should be treated as a server environment.
     */
    isServer() {
      return isServerFn();
    },
    /**
     * Overrides the server check globally.
     */
    setIsServer(isServerValue) {
      isServerFn = isServerValue;
    },
  };
})();
//#endregion
//#region node_modules/@tanstack/query-core/build/modern/thenable.js
function pendingThenable() {
  let resolve;
  let reject;
  const thenable = new Promise((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  thenable.status = "pending";
  thenable.catch(() => {});
  function finalize(data) {
    Object.assign(thenable, data);
    delete thenable.resolve;
    delete thenable.reject;
  }
  thenable.resolve = (value) => {
    finalize({
      status: "fulfilled",
      value,
    });
    resolve(value);
  };
  thenable.reject = (reason) => {
    finalize({
      status: "rejected",
      reason,
    });
    reject(reason);
  };
  return thenable;
}
//#endregion
//#region node_modules/@tanstack/query-core/build/modern/notifyManager.js
var defaultScheduler = systemSetTimeoutZero;
function createNotifyManager() {
  let queue = [];
  let transactions = 0;
  let notifyFn = (callback) => {
    callback();
  };
  let batchNotifyFn = (callback) => {
    callback();
  };
  let scheduleFn = defaultScheduler;
  const schedule = (callback) => {
    if (transactions) queue.push(callback);
    else
      scheduleFn(() => {
        notifyFn(callback);
      });
  };
  const flush = () => {
    const originalQueue = queue;
    queue = [];
    if (originalQueue.length)
      scheduleFn(() => {
        batchNotifyFn(() => {
          originalQueue.forEach((callback) => {
            notifyFn(callback);
          });
        });
      });
  };
  return {
    batch: (callback) => {
      let result;
      transactions++;
      try {
        result = callback();
      } finally {
        transactions--;
        if (!transactions) flush();
      }
      return result;
    },
    /**
     * All calls to the wrapped function will be batched.
     */
    batchCalls: (callback) => {
      return (...args) => {
        schedule(() => {
          callback(...args);
        });
      };
    },
    schedule,
    /**
     * Use this method to set a custom notify function.
     * This can be used to for example wrap notifications with `React.act` while running tests.
     */
    setNotifyFunction: (fn) => {
      notifyFn = fn;
    },
    /**
     * Use this method to set a custom function to batch notifications together into a single tick.
     * By default React Query will use the batch function provided by ReactDOM or React Native.
     */
    setBatchNotifyFunction: (fn) => {
      batchNotifyFn = fn;
    },
    setScheduler: (fn) => {
      scheduleFn = fn;
    },
  };
}
var notifyManager = createNotifyManager();
//#endregion
//#region node_modules/@tanstack/query-core/build/modern/onlineManager.js
var OnlineManager = class extends Subscribable {
  #online = true;
  #cleanup;
  #setup;
  constructor() {
    super();
    this.#setup = (onOnline) => {
      if (typeof window !== "undefined" && window.addEventListener) {
        const onlineListener = () => onOnline(true);
        const offlineListener = () => onOnline(false);
        window.addEventListener("online", onlineListener, false);
        window.addEventListener("offline", offlineListener, false);
        return () => {
          window.removeEventListener("online", onlineListener);
          window.removeEventListener("offline", offlineListener);
        };
      }
    };
  }
  onSubscribe() {
    if (!this.#cleanup) this.setEventListener(this.#setup);
  }
  onUnsubscribe() {
    if (!this.hasListeners()) {
      this.#cleanup?.();
      this.#cleanup = void 0;
    }
  }
  setEventListener(setup) {
    this.#setup = setup;
    this.#cleanup?.();
    this.#cleanup = setup(this.setOnline.bind(this));
  }
  setOnline(online) {
    if (this.#online !== online) {
      this.#online = online;
      this.listeners.forEach((listener) => {
        listener(online);
      });
    }
  }
  isOnline() {
    return this.#online;
  }
};
var onlineManager = new OnlineManager();
//#endregion
//#region node_modules/@tanstack/query-core/build/modern/retryer.js
function defaultRetryDelay(failureCount) {
  return Math.min(1e3 * 2 ** failureCount, 3e4);
}
function canFetch(networkMode) {
  return (networkMode ?? "online") === "online" ? onlineManager.isOnline() : true;
}
var CancelledError = class extends Error {
  constructor(options) {
    super("CancelledError");
    this.revert = options?.revert;
    this.silent = options?.silent;
  }
};
function createRetryer(config) {
  let isRetryCancelled = false;
  let failureCount = 0;
  let continueFn;
  const thenable = pendingThenable();
  const isResolved = () => thenable.status !== "pending";
  const cancel = (cancelOptions) => {
    if (!isResolved()) {
      const error = new CancelledError(cancelOptions);
      reject(error);
      config.onCancel?.(error);
    }
  };
  const cancelRetry = () => {
    isRetryCancelled = true;
  };
  const continueRetry = () => {
    isRetryCancelled = false;
  };
  const canContinue = () =>
    focusManager.isFocused() &&
    (config.networkMode === "always" || onlineManager.isOnline()) &&
    config.canRun();
  const canStart = () => canFetch(config.networkMode) && config.canRun();
  const resolve = (value) => {
    if (!isResolved()) {
      continueFn?.();
      thenable.resolve(value);
    }
  };
  const reject = (value) => {
    if (!isResolved()) {
      continueFn?.();
      thenable.reject(value);
    }
  };
  const pause = () => {
    return new Promise((continueResolve) => {
      continueFn = (value) => {
        if (isResolved() || canContinue()) continueResolve(value);
      };
      config.onPause?.();
    }).then(() => {
      continueFn = void 0;
      if (!isResolved()) config.onContinue?.();
    });
  };
  const run = () => {
    if (isResolved()) return;
    let promiseOrValue;
    const initialPromise = failureCount === 0 ? config.initialPromise : void 0;
    try {
      promiseOrValue = initialPromise ?? config.fn();
    } catch (error) {
      promiseOrValue = Promise.reject(error);
    }
    Promise.resolve(promiseOrValue)
      .then(resolve)
      .catch((error) => {
        if (isResolved()) return;
        const retry = config.retry ?? (environmentManager.isServer() ? 0 : 3);
        const retryDelay = config.retryDelay ?? defaultRetryDelay;
        const delay =
          typeof retryDelay === "function" ? retryDelay(failureCount, error) : retryDelay;
        const shouldRetry =
          retry === true ||
          (typeof retry === "number" && failureCount < retry) ||
          (typeof retry === "function" && retry(failureCount, error));
        if (isRetryCancelled || !shouldRetry) {
          reject(error);
          return;
        }
        failureCount++;
        config.onFail?.(failureCount, error);
        sleep(delay)
          .then(() => {
            return canContinue() ? void 0 : pause();
          })
          .then(() => {
            if (isRetryCancelled) reject(error);
            else run();
          });
      });
  };
  return {
    promise: thenable,
    status: () => thenable.status,
    cancel,
    continue: () => {
      continueFn?.();
      return thenable;
    },
    cancelRetry,
    continueRetry,
    canStart,
    start: () => {
      if (canStart()) run();
      else pause().then(run);
      return thenable;
    },
  };
}
//#endregion
//#region node_modules/@tanstack/query-core/build/modern/removable.js
var Removable = class {
  #gcTimeout;
  destroy() {
    this.clearGcTimeout();
  }
  scheduleGc() {
    this.clearGcTimeout();
    if (isValidTimeout(this.gcTime))
      this.#gcTimeout = timeoutManager.setTimeout(() => {
        this.optionalRemove();
      }, this.gcTime);
  }
  updateGcTime(newGcTime) {
    this.gcTime = Math.max(
      this.gcTime || 0,
      newGcTime ?? (environmentManager.isServer() ? Infinity : 300 * 1e3),
    );
  }
  clearGcTimeout() {
    if (this.#gcTimeout !== void 0) {
      timeoutManager.clearTimeout(this.#gcTimeout);
      this.#gcTimeout = void 0;
    }
  }
};
//#endregion
//#region node_modules/@tanstack/query-core/build/modern/query.js
var Query = class extends Removable {
  #initialState;
  #revertState;
  #cache;
  #client;
  #retryer;
  #defaultOptions;
  #abortSignalConsumed;
  constructor(config) {
    super();
    this.#abortSignalConsumed = false;
    this.#defaultOptions = config.defaultOptions;
    this.setOptions(config.options);
    this.observers = [];
    this.#client = config.client;
    this.#cache = this.#client.getQueryCache();
    this.queryKey = config.queryKey;
    this.queryHash = config.queryHash;
    this.#initialState = getDefaultState$1(this.options);
    this.state = config.state ?? this.#initialState;
    this.scheduleGc();
  }
  get meta() {
    return this.options.meta;
  }
  get promise() {
    return this.#retryer?.promise;
  }
  setOptions(options) {
    this.options = {
      ...this.#defaultOptions,
      ...options,
    };
    this.updateGcTime(this.options.gcTime);
    if (this.state && this.state.data === void 0) {
      const defaultState = getDefaultState$1(this.options);
      if (defaultState.data !== void 0) {
        this.setState(successState(defaultState.data, defaultState.dataUpdatedAt));
        this.#initialState = defaultState;
      }
    }
  }
  optionalRemove() {
    if (!this.observers.length && this.state.fetchStatus === "idle") this.#cache.remove(this);
  }
  setData(newData, options) {
    const data = replaceData(this.state.data, newData, this.options);
    this.#dispatch({
      data,
      type: "success",
      dataUpdatedAt: options?.updatedAt,
      manual: options?.manual,
    });
    return data;
  }
  setState(state, setStateOptions) {
    this.#dispatch({
      type: "setState",
      state,
      setStateOptions,
    });
  }
  cancel(options) {
    const promise = this.#retryer?.promise;
    this.#retryer?.cancel(options);
    return promise ? promise.then(noop).catch(noop) : Promise.resolve();
  }
  destroy() {
    super.destroy();
    this.cancel({ silent: true });
  }
  get resetState() {
    return this.#initialState;
  }
  reset() {
    this.destroy();
    this.setState(this.resetState);
  }
  isActive() {
    return this.observers.some(
      (observer) => resolveEnabled(observer.options.enabled, this) !== false,
    );
  }
  isDisabled() {
    if (this.getObserversCount() > 0) return !this.isActive();
    return this.options.queryFn === skipToken || !this.isFetched();
  }
  isFetched() {
    return this.state.dataUpdateCount + this.state.errorUpdateCount > 0;
  }
  isStatic() {
    if (this.getObserversCount() > 0)
      return this.observers.some(
        (observer) => resolveStaleTime(observer.options.staleTime, this) === "static",
      );
    return false;
  }
  isStale() {
    if (this.getObserversCount() > 0)
      return this.observers.some((observer) => observer.getCurrentResult().isStale);
    return this.state.data === void 0 || this.state.isInvalidated;
  }
  isStaleByTime(staleTime = 0) {
    if (this.state.data === void 0) return true;
    if (staleTime === "static") return false;
    if (this.state.isInvalidated) return true;
    return !timeUntilStale(this.state.dataUpdatedAt, staleTime);
  }
  onFocus() {
    this.observers.find((x) => x.shouldFetchOnWindowFocus())?.refetch({ cancelRefetch: false });
    this.#retryer?.continue();
  }
  onOnline() {
    this.observers.find((x) => x.shouldFetchOnReconnect())?.refetch({ cancelRefetch: false });
    this.#retryer?.continue();
  }
  addObserver(observer) {
    if (!this.observers.includes(observer)) {
      this.observers.push(observer);
      this.clearGcTimeout();
      this.#cache.notify({
        type: "observerAdded",
        query: this,
        observer,
      });
    }
  }
  removeObserver(observer) {
    if (this.observers.includes(observer)) {
      this.observers = this.observers.filter((x) => x !== observer);
      if (!this.observers.length) {
        if (this.#retryer)
          if (this.#abortSignalConsumed || this.#isInitialPausedFetch())
            this.#retryer.cancel({ revert: true });
          else this.#retryer.cancelRetry();
        this.scheduleGc();
      }
      this.#cache.notify({
        type: "observerRemoved",
        query: this,
        observer,
      });
    }
  }
  getObserversCount() {
    return this.observers.length;
  }
  #isInitialPausedFetch() {
    return this.state.fetchStatus === "paused" && this.state.status === "pending";
  }
  invalidate() {
    if (!this.state.isInvalidated) this.#dispatch({ type: "invalidate" });
  }
  async fetch(options, fetchOptions) {
    if (this.state.fetchStatus !== "idle" && this.#retryer?.status() !== "rejected") {
      if (this.state.data !== void 0 && fetchOptions?.cancelRefetch) this.cancel({ silent: true });
      else if (this.#retryer) {
        this.#retryer.continueRetry();
        return this.#retryer.promise;
      }
    }
    if (options) this.setOptions(options);
    if (!this.options.queryFn) {
      const observer = this.observers.find((x) => x.options.queryFn);
      if (observer) this.setOptions(observer.options);
    }
    const abortController = new AbortController();
    const addSignalProperty = (object) => {
      Object.defineProperty(object, "signal", {
        enumerable: true,
        get: () => {
          this.#abortSignalConsumed = true;
          return abortController.signal;
        },
      });
    };
    const fetchFn = () => {
      const queryFn = ensureQueryFn(this.options, fetchOptions);
      const createQueryFnContext = () => {
        const queryFnContext2 = {
          client: this.#client,
          queryKey: this.queryKey,
          meta: this.meta,
        };
        addSignalProperty(queryFnContext2);
        return queryFnContext2;
      };
      const queryFnContext = createQueryFnContext();
      this.#abortSignalConsumed = false;
      if (this.options.persister) return this.options.persister(queryFn, queryFnContext, this);
      return queryFn(queryFnContext);
    };
    const createFetchContext = () => {
      const context2 = {
        fetchOptions,
        options: this.options,
        queryKey: this.queryKey,
        client: this.#client,
        state: this.state,
        fetchFn,
      };
      addSignalProperty(context2);
      return context2;
    };
    const context = createFetchContext();
    this.options.behavior?.onFetch(context, this);
    this.#revertState = this.state;
    if (this.state.fetchStatus === "idle" || this.state.fetchMeta !== context.fetchOptions?.meta)
      this.#dispatch({
        type: "fetch",
        meta: context.fetchOptions?.meta,
      });
    this.#retryer = createRetryer({
      initialPromise: fetchOptions?.initialPromise,
      fn: context.fetchFn,
      onCancel: (error) => {
        if (error instanceof CancelledError && error.revert)
          this.setState({
            ...this.#revertState,
            fetchStatus: "idle",
          });
        abortController.abort();
      },
      onFail: (failureCount, error) => {
        this.#dispatch({
          type: "failed",
          failureCount,
          error,
        });
      },
      onPause: () => {
        this.#dispatch({ type: "pause" });
      },
      onContinue: () => {
        this.#dispatch({ type: "continue" });
      },
      retry: context.options.retry,
      retryDelay: context.options.retryDelay,
      networkMode: context.options.networkMode,
      canRun: () => true,
    });
    try {
      const data = await this.#retryer.start();
      if (data === void 0) throw new Error(`${this.queryHash} data is undefined`);
      this.setData(data);
      this.#cache.config.onSuccess?.(data, this);
      this.#cache.config.onSettled?.(data, this.state.error, this);
      return data;
    } catch (error) {
      if (error instanceof CancelledError) {
        if (error.silent) return this.#retryer.promise;
        else if (error.revert) {
          if (this.state.data === void 0) throw error;
          return this.state.data;
        }
      }
      this.#dispatch({
        type: "error",
        error,
      });
      this.#cache.config.onError?.(error, this);
      this.#cache.config.onSettled?.(this.state.data, error, this);
      throw error;
    } finally {
      this.scheduleGc();
    }
  }
  #dispatch(action) {
    const reducer = (state) => {
      switch (action.type) {
        case "failed":
          return {
            ...state,
            fetchFailureCount: action.failureCount,
            fetchFailureReason: action.error,
          };
        case "pause":
          return {
            ...state,
            fetchStatus: "paused",
          };
        case "continue":
          return {
            ...state,
            fetchStatus: "fetching",
          };
        case "fetch":
          return {
            ...state,
            ...fetchState(state.data, this.options),
            fetchMeta: action.meta ?? null,
          };
        case "success":
          const newState = {
            ...state,
            ...successState(action.data, action.dataUpdatedAt),
            dataUpdateCount: state.dataUpdateCount + 1,
            ...(!action.manual && {
              fetchStatus: "idle",
              fetchFailureCount: 0,
              fetchFailureReason: null,
            }),
          };
          this.#revertState = action.manual ? newState : void 0;
          return newState;
        case "error":
          const error = action.error;
          return {
            ...state,
            error,
            errorUpdateCount: state.errorUpdateCount + 1,
            errorUpdatedAt: Date.now(),
            fetchFailureCount: state.fetchFailureCount + 1,
            fetchFailureReason: error,
            fetchStatus: "idle",
            status: "error",
            isInvalidated: true,
          };
        case "invalidate":
          return {
            ...state,
            isInvalidated: true,
          };
        case "setState":
          return {
            ...state,
            ...action.state,
          };
      }
    };
    this.state = reducer(this.state);
    notifyManager.batch(() => {
      this.observers.forEach((observer) => {
        observer.onQueryUpdate();
      });
      this.#cache.notify({
        query: this,
        type: "updated",
        action,
      });
    });
  }
};
function fetchState(data, options) {
  return {
    fetchFailureCount: 0,
    fetchFailureReason: null,
    fetchStatus: canFetch(options.networkMode) ? "fetching" : "paused",
    ...(data === void 0 && {
      error: null,
      status: "pending",
    }),
  };
}
function successState(data, dataUpdatedAt) {
  return {
    data,
    dataUpdatedAt: dataUpdatedAt ?? Date.now(),
    error: null,
    isInvalidated: false,
    status: "success",
  };
}
function getDefaultState$1(options) {
  const data =
    typeof options.initialData === "function" ? options.initialData() : options.initialData;
  const hasData = data !== void 0;
  const initialDataUpdatedAt = hasData
    ? typeof options.initialDataUpdatedAt === "function"
      ? options.initialDataUpdatedAt()
      : options.initialDataUpdatedAt
    : 0;
  return {
    data,
    dataUpdateCount: 0,
    dataUpdatedAt: hasData ? (initialDataUpdatedAt ?? Date.now()) : 0,
    error: null,
    errorUpdateCount: 0,
    errorUpdatedAt: 0,
    fetchFailureCount: 0,
    fetchFailureReason: null,
    fetchMeta: null,
    isInvalidated: false,
    status: hasData ? "success" : "pending",
    fetchStatus: "idle",
  };
}
//#endregion
//#region node_modules/@tanstack/query-core/build/modern/mutation.js
var Mutation = class extends Removable {
  #client;
  #observers;
  #mutationCache;
  #retryer;
  constructor(config) {
    super();
    this.#client = config.client;
    this.mutationId = config.mutationId;
    this.#mutationCache = config.mutationCache;
    this.#observers = [];
    this.state = config.state || getDefaultState();
    this.setOptions(config.options);
    this.scheduleGc();
  }
  setOptions(options) {
    this.options = options;
    this.updateGcTime(this.options.gcTime);
  }
  get meta() {
    return this.options.meta;
  }
  addObserver(observer) {
    if (!this.#observers.includes(observer)) {
      this.#observers.push(observer);
      this.clearGcTimeout();
      this.#mutationCache.notify({
        type: "observerAdded",
        mutation: this,
        observer,
      });
    }
  }
  removeObserver(observer) {
    this.#observers = this.#observers.filter((x) => x !== observer);
    this.scheduleGc();
    this.#mutationCache.notify({
      type: "observerRemoved",
      mutation: this,
      observer,
    });
  }
  optionalRemove() {
    if (!this.#observers.length)
      if (this.state.status === "pending") this.scheduleGc();
      else this.#mutationCache.remove(this);
  }
  continue() {
    return this.#retryer?.continue() ?? this.execute(this.state.variables);
  }
  async execute(variables) {
    const onContinue = () => {
      this.#dispatch({ type: "continue" });
    };
    const mutationFnContext = {
      client: this.#client,
      meta: this.options.meta,
      mutationKey: this.options.mutationKey,
    };
    this.#retryer = createRetryer({
      fn: () => {
        if (!this.options.mutationFn)
          return Promise.reject(/* @__PURE__ */ new Error("No mutationFn found"));
        return this.options.mutationFn(variables, mutationFnContext);
      },
      onFail: (failureCount, error) => {
        this.#dispatch({
          type: "failed",
          failureCount,
          error,
        });
      },
      onPause: () => {
        this.#dispatch({ type: "pause" });
      },
      onContinue,
      retry: this.options.retry ?? 0,
      retryDelay: this.options.retryDelay,
      networkMode: this.options.networkMode,
      canRun: () => this.#mutationCache.canRun(this),
    });
    const restored = this.state.status === "pending";
    const isPaused = !this.#retryer.canStart();
    try {
      if (restored) onContinue();
      else {
        this.#dispatch({
          type: "pending",
          variables,
          isPaused,
        });
        if (this.#mutationCache.config.onMutate)
          await this.#mutationCache.config.onMutate(variables, this, mutationFnContext);
        const context = await this.options.onMutate?.(variables, mutationFnContext);
        if (context !== this.state.context)
          this.#dispatch({
            type: "pending",
            context,
            variables,
            isPaused,
          });
      }
      const data = await this.#retryer.start();
      await this.#mutationCache.config.onSuccess?.(
        data,
        variables,
        this.state.context,
        this,
        mutationFnContext,
      );
      await this.options.onSuccess?.(data, variables, this.state.context, mutationFnContext);
      await this.#mutationCache.config.onSettled?.(
        data,
        null,
        this.state.variables,
        this.state.context,
        this,
        mutationFnContext,
      );
      await this.options.onSettled?.(data, null, variables, this.state.context, mutationFnContext);
      this.#dispatch({
        type: "success",
        data,
      });
      return data;
    } catch (error) {
      try {
        await this.#mutationCache.config.onError?.(
          error,
          variables,
          this.state.context,
          this,
          mutationFnContext,
        );
      } catch (e) {
        Promise.reject(e);
      }
      try {
        await this.options.onError?.(error, variables, this.state.context, mutationFnContext);
      } catch (e) {
        Promise.reject(e);
      }
      try {
        await this.#mutationCache.config.onSettled?.(
          void 0,
          error,
          this.state.variables,
          this.state.context,
          this,
          mutationFnContext,
        );
      } catch (e) {
        Promise.reject(e);
      }
      try {
        await this.options.onSettled?.(
          void 0,
          error,
          variables,
          this.state.context,
          mutationFnContext,
        );
      } catch (e) {
        Promise.reject(e);
      }
      this.#dispatch({
        type: "error",
        error,
      });
      throw error;
    } finally {
      this.#mutationCache.runNext(this);
    }
  }
  #dispatch(action) {
    const reducer = (state) => {
      switch (action.type) {
        case "failed":
          return {
            ...state,
            failureCount: action.failureCount,
            failureReason: action.error,
          };
        case "pause":
          return {
            ...state,
            isPaused: true,
          };
        case "continue":
          return {
            ...state,
            isPaused: false,
          };
        case "pending":
          return {
            ...state,
            context: action.context,
            data: void 0,
            failureCount: 0,
            failureReason: null,
            error: null,
            isPaused: action.isPaused,
            status: "pending",
            variables: action.variables,
            submittedAt: Date.now(),
          };
        case "success":
          return {
            ...state,
            data: action.data,
            failureCount: 0,
            failureReason: null,
            error: null,
            status: "success",
            isPaused: false,
          };
        case "error":
          return {
            ...state,
            data: void 0,
            error: action.error,
            failureCount: state.failureCount + 1,
            failureReason: action.error,
            isPaused: false,
            status: "error",
          };
      }
    };
    this.state = reducer(this.state);
    notifyManager.batch(() => {
      this.#observers.forEach((observer) => {
        observer.onMutationUpdate(action);
      });
      this.#mutationCache.notify({
        mutation: this,
        type: "updated",
        action,
      });
    });
  }
};
function getDefaultState() {
  return {
    context: void 0,
    data: void 0,
    error: null,
    failureCount: 0,
    failureReason: null,
    isPaused: false,
    status: "idle",
    variables: void 0,
    submittedAt: 0,
  };
}
//#endregion
//#region node_modules/@tanstack/react-query/build/modern/QueryClientProvider.js
var import_react = /* @__PURE__ */ __toESM(require_react(), 1);
var import_jsx_runtime = require_jsx_runtime();
var QueryClientContext = import_react.createContext(void 0);
var useQueryClient = (queryClient) => {
  const client = import_react.useContext(QueryClientContext);
  if (queryClient) return queryClient;
  if (!client) throw new Error("No QueryClient set, use QueryClientProvider to set one");
  return client;
};
var QueryClientProvider = ({ client, children }) => {
  import_react.useEffect(() => {
    client.mount();
    return () => {
      client.unmount();
    };
  }, [client]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(QueryClientContext.Provider, {
    value: client,
    children,
  });
};
//#endregion
//#region node_modules/@orpc/contract/dist/shared/contract.D_dZrO__.mjs
var ValidationError = class extends Error {
  issues;
  data;
  constructor(options) {
    super(options.message, options);
    this.issues = options.issues;
    this.data = options.data;
  }
};
function mergeErrorMap(errorMap1, errorMap2) {
  return {
    ...errorMap1,
    ...errorMap2,
  };
}
async function validateORPCError(map, error) {
  const { code, status, message, data, cause, defined } = error;
  const config = map?.[error.code];
  if (!config || fallbackORPCErrorStatus(error.code, config.status) !== error.status)
    return defined
      ? new ORPCError(code, {
          defined: false,
          status,
          message,
          data,
          cause,
        })
      : error;
  if (!config.data)
    return defined
      ? error
      : new ORPCError(code, {
          defined: true,
          status,
          message,
          data,
          cause,
        });
  const validated = await config.data["~standard"].validate(error.data);
  if (validated.issues)
    return defined
      ? new ORPCError(code, {
          defined: false,
          status,
          message,
          data,
          cause,
        })
      : error;
  return new ORPCError(code, {
    defined: true,
    status,
    message,
    data: validated.value,
    cause,
  });
}
var ContractProcedure = class {
  /**
   * This property holds the defined options for the contract procedure.
   */
  "~orpc";
  constructor(def) {
    if (def.route?.successStatus && isORPCErrorStatus(def.route.successStatus))
      throw new Error("[ContractProcedure] Invalid successStatus.");
    if (
      Object.values(def.errorMap).some((val) => val && val.status && !isORPCErrorStatus(val.status))
    )
      throw new Error("[ContractProcedure] Invalid error status code.");
    this["~orpc"] = def;
  }
};
function isContractProcedure(item) {
  if (item instanceof ContractProcedure) return true;
  return (
    (typeof item === "object" || typeof item === "function") &&
    item !== null &&
    "~orpc" in item &&
    typeof item["~orpc"] === "object" &&
    item["~orpc"] !== null &&
    "errorMap" in item["~orpc"] &&
    "route" in item["~orpc"] &&
    "meta" in item["~orpc"]
  );
}
//#endregion
//#region node_modules/@orpc/contract/dist/index.mjs
function mergeMeta(meta1, meta2) {
  return {
    ...meta1,
    ...meta2,
  };
}
function mergeRoute(a, b) {
  return {
    ...a,
    ...b,
  };
}
function prefixRoute(route, prefix) {
  if (!route.path) return route;
  return {
    ...route,
    path: `${prefix}${route.path}`,
  };
}
function unshiftTagRoute(route, tags) {
  return {
    ...route,
    tags: [...tags, ...(route.tags ?? [])],
  };
}
function mergePrefix(a, b) {
  return a ? `${a}${b}` : b;
}
function mergeTags(a, b) {
  return a ? [...a, ...b] : b;
}
function enhanceRoute(route, options) {
  let router = route;
  if (options.prefix) router = prefixRoute(router, options.prefix);
  if (options.tags?.length) router = unshiftTagRoute(router, options.tags);
  return router;
}
function getContractRouter(router, path) {
  let current = router;
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    if (!current) return;
    if (isContractProcedure(current)) return;
    if (typeof current !== "object") return;
    current = current[segment];
  }
  return current;
}
function enhanceContractRouter(router, options) {
  if (isContractProcedure(router))
    return new ContractProcedure({
      ...router["~orpc"],
      errorMap: mergeErrorMap(options.errorMap, router["~orpc"].errorMap),
      route: enhanceRoute(router["~orpc"].route, options),
    });
  if (typeof router !== "object" || router === null) return router;
  const enhanced = {};
  for (const key in router) enhanced[key] = enhanceContractRouter(router[key], options);
  return enhanced;
}
var oc = new (class ContractBuilder extends ContractProcedure {
  constructor(def) {
    super(def);
    this["~orpc"].prefix = def.prefix;
    this["~orpc"].tags = def.tags;
  }
  /**
   * Sets or overrides the initial meta.
   *
   * @see {@link https://orpc.dev/docs/metadata Metadata Docs}
   */
  $meta(initialMeta) {
    return new ContractBuilder({
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
    return new ContractBuilder({
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
    return new ContractBuilder({
      ...this["~orpc"],
      inputSchema: initialInputSchema,
    });
  }
  /**
   * Adds type-safe custom errors to the contract.
   * The provided errors are spared-merged with any existing errors in the contract.
   *
   * @see {@link https://orpc.dev/docs/error-handling#type%E2%80%90safe-error-handling Type-Safe Error Handling Docs}
   */
  errors(errors) {
    return new ContractBuilder({
      ...this["~orpc"],
      errorMap: mergeErrorMap(this["~orpc"].errorMap, errors),
    });
  }
  /**
   * Sets or updates the metadata for the contract.
   * The provided metadata is spared-merged with any existing metadata in the contract.
   *
   * @see {@link https://orpc.dev/docs/metadata Metadata Docs}
   */
  meta(meta) {
    return new ContractBuilder({
      ...this["~orpc"],
      meta: mergeMeta(this["~orpc"].meta, meta),
    });
  }
  /**
   * Sets or updates the route definition for the contract.
   * The provided route is spared-merged with any existing route in the contract.
   * This option is typically relevant when integrating with OpenAPI.
   *
   * @see {@link https://orpc.dev/docs/openapi/routing OpenAPI Routing Docs}
   * @see {@link https://orpc.dev/docs/openapi/input-output-structure OpenAPI Input/Output Structure Docs}
   */
  route(route) {
    return new ContractBuilder({
      ...this["~orpc"],
      route: mergeRoute(this["~orpc"].route, route),
    });
  }
  /**
   * Defines the input validation schema for the contract.
   *
   * @see {@link https://orpc.dev/docs/procedure#input-output-validation Input Validation Docs}
   */
  input(schema) {
    return new ContractBuilder({
      ...this["~orpc"],
      inputSchema: schema,
    });
  }
  /**
   * Defines the output validation schema for the contract.
   *
   * @see {@link https://orpc.dev/docs/procedure#input-output-validation Output Validation Docs}
   */
  output(schema) {
    return new ContractBuilder({
      ...this["~orpc"],
      outputSchema: schema,
    });
  }
  /**
   * Prefixes all procedures in the contract router.
   * The provided prefix is post-appended to any existing router prefix.
   *
   * @note This option does not affect procedures that do not define a path in their route definition.
   *
   * @see {@link https://orpc.dev/docs/openapi/routing#route-prefixes OpenAPI Route Prefixes Docs}
   */
  prefix(prefix) {
    return new ContractBuilder({
      ...this["~orpc"],
      prefix: mergePrefix(this["~orpc"].prefix, prefix),
    });
  }
  /**
   * Adds tags to all procedures in the contract router.
   * This helpful when you want to group procedures together in the OpenAPI specification.
   *
   * @see {@link https://orpc.dev/docs/openapi/openapi-specification#operation-metadata OpenAPI Operation Metadata Docs}
   */
  tag(...tags) {
    return new ContractBuilder({
      ...this["~orpc"],
      tags: mergeTags(this["~orpc"].tags, tags),
    });
  }
  /**
   * Applies all of the previously defined options to the specified contract router.
   *
   * @see {@link https://orpc.dev/docs/router#extending-router Extending Router Docs}
   */
  router(router) {
    return enhanceContractRouter(router, this["~orpc"]);
  }
})({
  errorMap: {},
  route: {},
  meta: {},
});
var DEFAULT_CONFIG = {
  defaultMethod: "POST",
  defaultSuccessStatus: 200,
  defaultSuccessDescription: "OK",
  defaultInputStructure: "compact",
  defaultOutputStructure: "compact",
};
function fallbackContractConfig(key, value) {
  if (value === void 0) return DEFAULT_CONFIG[key];
  return value;
}
var EVENT_ITERATOR_DETAILS_SYMBOL = Symbol("ORPC_EVENT_ITERATOR_DETAILS");
function eventIterator(yields, returns) {
  return {
    "~standard": {
      [EVENT_ITERATOR_DETAILS_SYMBOL]: {
        yields,
        returns,
      },
      vendor: "orpc",
      version: 1,
      validate(iterator) {
        if (!isAsyncIteratorObject(iterator))
          return {
            issues: [
              {
                message: "Expect event iterator",
                path: [],
              },
            ],
          };
        return {
          value: mapEventIterator(iterator, {
            async value(value, done) {
              const schema = done ? returns : yields;
              if (!schema) return value;
              const result = await schema["~standard"].validate(value);
              if (result.issues)
                throw new ORPCError("EVENT_ITERATOR_VALIDATION_FAILED", {
                  message: "Event iterator validation failed",
                  cause: new ValidationError({
                    issues: result.issues,
                    message: "Event iterator validation failed",
                    data: value,
                  }),
                });
              return result.value;
            },
            error: async (error) => error,
          }),
        };
      },
    },
  };
}
function getEventIteratorSchemaDetails(schema) {
  if (schema === void 0) return;
  return schema["~standard"][EVENT_ITERATOR_DETAILS_SYMBOL];
}
//#endregion
//#region node_modules/zod/v3/helpers/util.js
var util;
(function (util) {
  util.assertEqual = (_) => {};
  function assertIs(_arg) {}
  util.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util.assertNever = assertNever;
  util.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) obj[item] = item;
    return obj;
  };
  util.getValidEnumValues = (obj) => {
    const validKeys = util.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) filtered[k] = obj[k];
    return util.objectValues(filtered);
  };
  util.objectValues = (obj) => {
    return util.objectKeys(obj).map(function (e) {
      return obj[e];
    });
  };
  util.objectKeys =
    typeof Object.keys === "function"
      ? (obj) => Object.keys(obj)
      : (object) => {
          const keys = [];
          for (const key in object)
            if (Object.prototype.hasOwnProperty.call(object, key)) keys.push(key);
          return keys;
        };
  util.find = (arr, checker) => {
    for (const item of arr) if (checker(item)) return item;
  };
  util.isInteger =
    typeof Number.isInteger === "function"
      ? (val) => Number.isInteger(val)
      : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => (typeof val === "string" ? `'${val}'` : val)).join(separator);
  }
  util.joinValues = joinValues;
  util.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") return value.toString();
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function (objectUtil) {
  objectUtil.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second,
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set",
]);
var getParsedType = (data) => {
  switch (typeof data) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) return ZodParsedType.array;
      if (data === null) return ZodParsedType.null;
      if (
        data.then &&
        typeof data.then === "function" &&
        data.catch &&
        typeof data.catch === "function"
      )
        return ZodParsedType.promise;
      if (typeof Map !== "undefined" && data instanceof Map) return ZodParsedType.map;
      if (typeof Set !== "undefined" && data instanceof Set) return ZodParsedType.set;
      if (typeof Date !== "undefined" && data instanceof Date) return ZodParsedType.date;
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};
//#endregion
//#region node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite",
]);
var ZodError = class ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) Object.setPrototypeOf(this, actualProto);
    else this.__proto__ = actualProto;
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper =
      _mapper ||
      function (issue) {
        return issue.message;
      };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues)
        if (issue.code === "invalid_union") issue.unionErrors.map(processError);
        else if (issue.code === "invalid_return_type") processError(issue.returnTypeError);
        else if (issue.code === "invalid_arguments") processError(issue.argumentsError);
        else if (issue.path.length === 0) fieldErrors._errors.push(mapper(issue));
        else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            if (!(i === issue.path.length - 1)) curr[el] = curr[el] || { _errors: [] };
            else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof ZodError)) throw new Error(`Not a ZodError: ${value}`);
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues)
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else formErrors.push(mapper(sub));
    return {
      formErrors,
      fieldErrors,
    };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  return new ZodError(issues);
};
//#endregion
//#region node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) message = "Required";
      else message = `Expected ${issue.expected}, received ${issue.received}`;
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object")
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number")
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
        } else if ("startsWith" in issue.validation)
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        else if ("endsWith" in issue.validation)
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        else util.assertNever(issue.validation);
      else if (issue.validation !== "regex") message = `Invalid ${issue.validation}`;
      else message = "Invalid";
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
//#endregion
//#region node_modules/zod/v3/errors.js
var overrideErrorMap = errorMap;
function getErrorMap() {
  return overrideErrorMap;
}
//#endregion
//#region node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...(issueData.path || [])];
  const fullIssue = {
    ...issueData,
    path: fullPath,
  };
  if (issueData.message !== void 0)
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message,
    };
  let errorMessage = "";
  const maps = errorMaps
    .filter((m) => !!m)
    .slice()
    .reverse();
  for (const map of maps)
    errorMessage = map(fullIssue, {
      data,
      defaultError: errorMessage,
    }).message;
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage,
  };
};
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      ctx.schemaErrorMap,
      overrideMap,
      overrideMap === errorMap ? void 0 : errorMap,
    ].filter((x) => !!x),
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid") this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted") this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted") return INVALID;
      if (s.status === "dirty") status.dirty();
      arrayValue.push(s.value);
    }
    return {
      status: status.value,
      value: arrayValue,
    };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value,
      });
    }
    return ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted") return INVALID;
      if (value.status === "aborted") return INVALID;
      if (key.status === "dirty") status.dirty();
      if (value.status === "dirty") status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet))
        finalObject[key.value] = value.value;
    }
    return {
      status: status.value,
      value: finalObject,
    };
  }
};
var INVALID = Object.freeze({ status: "aborted" });
var DIRTY = (value) => ({
  status: "dirty",
  value,
});
var OK = (value) => ({
  status: "valid",
  value,
});
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;
//#endregion
//#region node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function (errorUtil) {
  errorUtil.errToObj = (message) => (typeof message === "string" ? { message } : message || {});
  errorUtil.toString = (message) => (typeof message === "string" ? message : message?.message);
})(errorUtil || (errorUtil = {}));
//#endregion
//#region node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length)
      if (Array.isArray(this._key)) this._cachedPath.push(...this._path, ...this._key);
      else this._cachedPath.push(...this._path, this._key);
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result))
    return {
      success: true,
      data: result.value,
    };
  else {
    if (!ctx.common.issues.length) throw new Error("Validation failed but no issues detected.");
    return {
      success: false,
      get error() {
        if (this._error) return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      },
    };
  }
};
function processCreateParams(params) {
  if (!params) return {};
  const { errorMap, invalid_type_error, required_error, description } = params;
  if (errorMap && (invalid_type_error || required_error))
    throw new Error(
      `Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`,
    );
  if (errorMap)
    return {
      errorMap,
      description,
    };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") return { message: message ?? ctx.defaultError };
    if (typeof ctx.data === "undefined")
      return { message: message ?? required_error ?? ctx.defaultError };
    if (iss.code !== "invalid_type") return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return {
    errorMap: customMap,
    description,
  };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return (
      ctx || {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent,
      }
    );
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent,
      },
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) throw new Error("Synchronous parse encountered promise.");
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success) return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap,
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data),
    };
    return handleResult(
      ctx,
      this._parseSync({
        data,
        path: ctx.path,
        parent: ctx,
      }),
    );
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async,
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data),
    };
    if (!this["~standard"].async)
      try {
        const result = this._parseSync({
          data,
          path: [],
          parent: ctx,
        });
        return isValid(result) ? { value: result.value } : { issues: ctx.common.issues };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) this["~standard"].async = true;
        ctx.common = {
          issues: [],
          async: true,
        };
      }
    return this._parseAsync({
      data,
      path: [],
      parent: ctx,
    }).then((result) =>
      isValid(result) ? { value: result.value } : { issues: ctx.common.issues },
    );
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success) return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true,
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data),
    };
    const maybeAsyncResult = this._parse({
      data,
      path: ctx.path,
      parent: ctx,
    });
    return handleResult(
      ctx,
      await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult)),
    );
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") return { message };
      else if (typeof message === "function") return message(val);
      else return message;
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () =>
        ctx.addIssue({
          code: ZodIssueCode.custom,
          ...getIssueProperties(val),
        });
      if (typeof Promise !== "undefined" && result instanceof Promise)
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else return true;
        });
      if (!result) {
        setError();
        return false;
      } else return true;
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(
          typeof refinementData === "function" ? refinementData(val, ctx) : refinementData,
        );
        return false;
      } else return true;
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: {
        type: "refinement",
        refinement,
      },
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    /** Alias of safeParseAsync */
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data),
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: {
        type: "transform",
        transform,
      },
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault,
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def),
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch,
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description,
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex =
  /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex =
  /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex =
  /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex =
  /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex =
  /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  else if (args.precision == null) secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset) opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) return true;
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) return true;
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt)) return false;
  try {
    const [header] = jwt.split(".");
    if (!header) return false;
    const base64 = header
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(header.length + ((4 - (header.length % 4)) % 4), "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null) return false;
    if ("typ" in decoded && decoded?.typ !== "JWT") return false;
    if (!decoded.alg) return false;
    if (alg && decoded.alg !== alg) return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) return true;
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) return true;
  return false;
}
var ZodString = class ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) input.data = String(input.data);
    if (this._getType(input) !== ZodParsedType.string) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks)
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig)
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message,
            });
          else if (tooSmall)
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message,
            });
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) emojiRegex = new RegExp(_emojiRegex, "u");
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "url")
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        if (!check.regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "trim") input.data = input.data.trim();
      else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: {
              includes: check.value,
              position: check.position,
            },
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") input.data = input.data.toLowerCase();
      else if (check.kind === "toUpperCase") input.data = input.data.toUpperCase();
      else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        if (!datetimeRegex(check).test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        if (!dateRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        if (!timeRegex(check).test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else util.assertNever(check);
    return {
      status: status.value,
      value: input.data,
    };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message),
    });
  }
  _addCheck(check) {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, check],
    });
  }
  email(message) {
    return this._addCheck({
      kind: "email",
      ...errorUtil.errToObj(message),
    });
  }
  url(message) {
    return this._addCheck({
      kind: "url",
      ...errorUtil.errToObj(message),
    });
  }
  emoji(message) {
    return this._addCheck({
      kind: "emoji",
      ...errorUtil.errToObj(message),
    });
  }
  uuid(message) {
    return this._addCheck({
      kind: "uuid",
      ...errorUtil.errToObj(message),
    });
  }
  nanoid(message) {
    return this._addCheck({
      kind: "nanoid",
      ...errorUtil.errToObj(message),
    });
  }
  cuid(message) {
    return this._addCheck({
      kind: "cuid",
      ...errorUtil.errToObj(message),
    });
  }
  cuid2(message) {
    return this._addCheck({
      kind: "cuid2",
      ...errorUtil.errToObj(message),
    });
  }
  ulid(message) {
    return this._addCheck({
      kind: "ulid",
      ...errorUtil.errToObj(message),
    });
  }
  base64(message) {
    return this._addCheck({
      kind: "base64",
      ...errorUtil.errToObj(message),
    });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message),
    });
  }
  jwt(options) {
    return this._addCheck({
      kind: "jwt",
      ...errorUtil.errToObj(options),
    });
  }
  ip(options) {
    return this._addCheck({
      kind: "ip",
      ...errorUtil.errToObj(options),
    });
  }
  cidr(options) {
    return this._addCheck({
      kind: "cidr",
      ...errorUtil.errToObj(options),
    });
  }
  datetime(options) {
    if (typeof options === "string")
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options,
      });
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message),
    });
  }
  date(message) {
    return this._addCheck({
      kind: "date",
      message,
    });
  }
  time(options) {
    if (typeof options === "string")
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options,
      });
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message),
    });
  }
  duration(message) {
    return this._addCheck({
      kind: "duration",
      ...errorUtil.errToObj(message),
    });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message),
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message),
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message),
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message),
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message),
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message),
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message),
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }],
    });
  }
  toLowerCase() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }],
    });
  }
  toUpperCase() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }],
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks)
      if (ch.kind === "min") {
        if (min === null || ch.value > min) min = ch.value;
      }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks)
      if (ch.kind === "max") {
        if (max === null || ch.value < max) max = ch.value;
      }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params),
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  return (
    (Number.parseInt(val.toFixed(decCount).replace(".", "")) %
      Number.parseInt(step.toFixed(decCount).replace(".", ""))) /
    10 ** decCount
  );
}
var ZodNumber = class ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) input.data = Number(input.data);
    if (this._getType(input) !== ZodParsedType.number) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks)
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        if (check.inclusive ? input.data < check.value : input.data <= check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (check.inclusive ? input.data > check.value : input.data >= check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message,
          });
          status.dirty();
        }
      } else util.assertNever(check);
    return {
      status: status.value,
      value: input.data,
    };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message),
        },
      ],
    });
  }
  _addCheck(check) {
    return new ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check],
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message),
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message),
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message),
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message),
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message),
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message),
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message),
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message),
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message),
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks)
      if (ch.kind === "min") {
        if (min === null || ch.value > min) min = ch.value;
      }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks)
      if (ch.kind === "max") {
        if (max === null || ch.value < max) max = ch.value;
      }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find(
      (ch) => ch.kind === "int" || (ch.kind === "multipleOf" && util.isInteger(ch.value)),
    );
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks)
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") return true;
      else if (ch.kind === "min") {
        if (min === null || ch.value > min) min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max) max = ch.value;
      }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params),
  });
};
var ZodBigInt = class ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce)
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    if (this._getType(input) !== ZodParsedType.bigint) return this._getInvalidInput(input);
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks)
      if (check.kind === "min") {
        if (check.inclusive ? input.data < check.value : input.data <= check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (check.inclusive ? input.data > check.value : input.data >= check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message,
          });
          status.dirty();
        }
      } else util.assertNever(check);
    return {
      status: status.value,
      value: input.data,
    };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType,
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message),
        },
      ],
    });
  }
  _addCheck(check) {
    return new ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check],
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message),
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message),
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message),
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message),
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message),
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks)
      if (ch.kind === "min") {
        if (min === null || ch.value > min) min = ch.value;
      }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks)
      if (ch.kind === "max") {
        if (max === null || ch.value < max) max = ch.value;
      }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params),
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) input.data = Boolean(input.data);
    if (this._getType(input) !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params),
  });
};
var ZodDate = class ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) input.data = new Date(input.data);
    if (this._getType(input) !== ZodParsedType.date) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      addIssueToContext(this._getOrReturnCtx(input), { code: ZodIssueCode.invalid_date });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks)
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date",
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date",
          });
          status.dirty();
        }
      } else util.assertNever(check);
    return {
      status: status.value,
      value: new Date(input.data.getTime()),
    };
  }
  _addCheck(check) {
    return new ZodDate({
      ...this._def,
      checks: [...this._def.checks, check],
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message),
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message),
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks)
      if (ch.kind === "min") {
        if (min === null || ch.value > min) min = ch.value;
      }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks)
      if (ch.kind === "max") {
        if (max === null || ch.value < max) max = ch.value;
      }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params),
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    if (this._getType(input) !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params),
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    if (this._getType(input) !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params),
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    if (this._getType(input) !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params),
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params),
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params),
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType,
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params),
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    if (this._getType(input) !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params),
  });
};
var ZodArray = class ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message,
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message,
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message,
        });
        status.dirty();
      }
    }
    if (ctx.common.async)
      return Promise.all(
        [...ctx.data].map((item, i) => {
          return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
        }),
      ).then((result) => {
        return ParseStatus.mergeArray(status, result);
      });
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new ZodArray({
      ...this._def,
      minLength: {
        value: minLength,
        message: errorUtil.toString(message),
      },
    });
  }
  max(maxLength, message) {
    return new ZodArray({
      ...this._def,
      maxLength: {
        value: maxLength,
        message: errorUtil.toString(message),
      },
    });
  }
  length(len, message) {
    return new ZodArray({
      ...this._def,
      exactLength: {
        value: len,
        message: errorUtil.toString(message),
      },
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params),
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape,
    });
  } else if (schema instanceof ZodArray)
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element),
    });
  else if (schema instanceof ZodOptional)
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  else if (schema instanceof ZodNullable)
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  else if (schema instanceof ZodTuple)
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  else return schema;
}
var ZodObject = class ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    /**
     * @deprecated In most cases, this is no longer needed - unknown properties are now silently stripped.
     * If you want to pass through unknown properties, use `.passthrough()` instead.
     */
    this.nonstrict = this.passthrough;
    /**
     * @deprecated Use `.extend` instead
     *  */
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null) return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = {
      shape,
      keys,
    };
    return this._cached;
  }
  _parse(input) {
    if (this._getType(input) !== ZodParsedType.object) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) if (!shapeKeys.includes(key)) extraKeys.push(key);
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: {
          status: "valid",
          value: key,
        },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data,
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough")
        for (const key of extraKeys)
          pairs.push({
            key: {
              status: "valid",
              value: key,
            },
            value: {
              status: "valid",
              value: ctx.data[key],
            },
          });
      else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys,
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: {
            status: "valid",
            value: key,
          },
          value: catchall._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
          alwaysSet: key in ctx.data,
        });
      }
    }
    if (ctx.common.async)
      return Promise.resolve()
        .then(async () => {
          const syncPairs = [];
          for (const pair of pairs) {
            const key = await pair.key;
            const value = await pair.value;
            syncPairs.push({
              key,
              value,
              alwaysSet: pair.alwaysSet,
            });
          }
          return syncPairs;
        })
        .then((syncPairs) => {
          return ParseStatus.mergeObjectSync(status, syncPairs);
        });
    else return ParseStatus.mergeObjectSync(status, pairs);
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...(message !== void 0
        ? {
            errorMap: (issue, ctx) => {
              const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
              if (issue.code === "unrecognized_keys")
                return { message: errorUtil.errToObj(message).message ?? defaultError };
              return { message: defaultError };
            },
          }
        : {}),
    });
  }
  strip() {
    return new ZodObject({
      ...this._def,
      unknownKeys: "strip",
    });
  }
  passthrough() {
    return new ZodObject({
      ...this._def,
      unknownKeys: "passthrough",
    });
  }
  extend(augmentation) {
    return new ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation,
      }),
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    return new ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape(),
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject,
    });
  }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  catchall(index) {
    return new ZodObject({
      ...this._def,
      catchall: index,
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask))
      if (mask[key] && this.shape[key]) shape[key] = this.shape[key];
    return new ZodObject({
      ...this._def,
      shape: () => shape,
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) if (!mask[key]) shape[key] = this.shape[key];
    return new ZodObject({
      ...this._def,
      shape: () => shape,
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) newShape[key] = fieldSchema;
      else newShape[key] = fieldSchema.optional();
    }
    return new ZodObject({
      ...this._def,
      shape: () => newShape,
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape))
      if (mask && !mask[key]) newShape[key] = this.shape[key];
      else {
        let newField = this.shape[key];
        while (newField instanceof ZodOptional) newField = newField._def.innerType;
        newShape[key] = newField;
      }
    return new ZodObject({
      ...this._def,
      shape: () => newShape,
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params),
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params),
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params),
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) if (result.result.status === "valid") return result.result;
      for (const result of results)
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors,
      });
      return INVALID;
    }
    if (ctx.common.async)
      return Promise.all(
        options.map(async (option) => {
          const childCtx = {
            ...ctx,
            common: {
              ...ctx.common,
              issues: [],
            },
            parent: null,
          };
          return {
            result: await option._parseAsync({
              data: ctx.data,
              path: ctx.path,
              parent: childCtx,
            }),
            ctx: childCtx,
          };
        }),
      ).then(handleResults);
    else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: [],
          },
          parent: null,
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx,
        });
        if (result.status === "valid") return result;
        else if (result.status === "dirty" && !dirty)
          dirty = {
            result,
            ctx: childCtx,
          };
        if (childCtx.common.issues.length) issues.push(childCtx.common.issues);
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues) => new ZodError(issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors,
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params),
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) return getDiscriminator(type.schema);
  else if (type instanceof ZodEffects) return getDiscriminator(type.innerType());
  else if (type instanceof ZodLiteral) return [type.value];
  else if (type instanceof ZodEnum) return type.options;
  else if (type instanceof ZodNativeEnum) return util.objectValues(type.enum);
  else if (type instanceof ZodDefault) return getDiscriminator(type._def.innerType);
  else if (type instanceof ZodUndefined) return [void 0];
  else if (type instanceof ZodNull) return [null];
  else if (type instanceof ZodOptional) return [void 0, ...getDiscriminator(type.unwrap())];
  else if (type instanceof ZodNullable) return [null, ...getDiscriminator(type.unwrap())];
  else if (type instanceof ZodBranded) return getDiscriminator(type.unwrap());
  else if (type instanceof ZodReadonly) return getDiscriminator(type.unwrap());
  else if (type instanceof ZodCatch) return getDiscriminator(type._def.innerType);
  else return [];
};
var ZodDiscriminatedUnion = class ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator],
      });
      return INVALID;
    }
    if (ctx.common.async)
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx,
      });
    else
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx,
      });
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length)
        throw new Error(
          `A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`,
        );
      for (const value of discriminatorValues) {
        if (optionsMap.has(value))
          throw new Error(
            `Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`,
          );
        optionsMap.set(value, type);
      }
    }
    return new ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params),
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b)
    return {
      valid: true,
      data: a,
    };
  else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = {
      ...a,
      ...b,
    };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) return { valid: false };
      newObj[key] = sharedValue.data;
    }
    return {
      valid: true,
      data: newObj,
    };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) return { valid: false };
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) return { valid: false };
      newArray.push(sharedValue.data);
    }
    return {
      valid: true,
      data: newArray,
    };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b)
    return {
      valid: true,
      data: a,
    };
  else return { valid: false };
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) return INVALID;
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, { code: ZodIssueCode.invalid_intersection_types });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) status.dirty();
      return {
        status: status.value,
        value: merged.data,
      };
    };
    if (ctx.common.async)
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx,
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx,
        }),
      ]).then(([left, right]) => handleParsed(left, right));
    else
      return handleParsed(
        this._def.left._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx,
        }),
        this._def.right._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx,
        }),
      );
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params),
  });
};
var ZodTuple = class ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array",
      });
      return INVALID;
    }
    if (!this._def.rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array",
      });
      status.dirty();
    }
    const items = [...ctx.data]
      .map((item, itemIndex) => {
        const schema = this._def.items[itemIndex] || this._def.rest;
        if (!schema) return null;
        return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
      })
      .filter((x) => !!x);
    if (ctx.common.async)
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    else return ParseStatus.mergeArray(status, items);
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new ZodTuple({
      ...this._def,
      rest,
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas))
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params),
  });
};
var ZodRecord = class ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data)
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data,
      });
    if (ctx.common.async) return ParseStatus.mergeObjectAsync(status, pairs);
    else return ParseStatus.mergeObjectSync(status, pairs);
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType)
      return new ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third),
      });
    return new ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second),
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"])),
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") return INVALID;
          if (key.status === "dirty" || value.status === "dirty") status.dirty();
          finalMap.set(key.value, value.value);
        }
        return {
          status: status.value,
          value: finalMap,
        };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") return INVALID;
        if (key.status === "dirty" || value.status === "dirty") status.dirty();
        finalMap.set(key.value, value.value);
      }
      return {
        status: status.value,
        value: finalMap,
      };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params),
  });
};
var ZodSet = class ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message,
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message,
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements) {
        if (element.status === "aborted") return INVALID;
        if (element.status === "dirty") status.dirty();
        parsedSet.add(element.value);
      }
      return {
        status: status.value,
        value: parsedSet,
      };
    }
    const elements = [...ctx.data.values()].map((item, i) =>
      valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)),
    );
    if (ctx.common.async) return Promise.all(elements).then((elements) => finalizeSet(elements));
    else return finalizeSet(elements);
  }
  min(minSize, message) {
    return new ZodSet({
      ...this._def,
      minSize: {
        value: minSize,
        message: errorUtil.toString(message),
      },
    });
  }
  max(maxSize, message) {
    return new ZodSet({
      ...this._def,
      maxSize: {
        value: maxSize,
        message: errorUtil.toString(message),
      },
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params),
  });
};
var ZodFunction = class ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [
          ctx.common.contextualErrorMap,
          ctx.schemaErrorMap,
          getErrorMap(),
          errorMap,
        ].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error,
        },
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [
          ctx.common.contextualErrorMap,
          ctx.schemaErrorMap,
          getErrorMap(),
          errorMap,
        ].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error,
        },
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function (...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        return await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
      });
    } else {
      const me = this;
      return OK(function (...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success)
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create()),
    });
  }
  returns(returnType) {
    return new ZodFunction({
      ...this._def,
      returns: returnType,
    });
  }
  implement(func) {
    return this.parse(func);
  }
  strictImplement(func) {
    return this.parse(func);
  }
  static create(args, returns, params) {
    return new ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params),
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    return this._def.getter()._parse({
      data: ctx.data,
      path: ctx.path,
      parent: ctx,
    });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params),
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value,
      });
      return INVALID;
    }
    return {
      status: "valid",
      value: input.data,
    };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params),
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params),
  });
}
var ZodEnum = class ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type,
      });
      return INVALID;
    }
    if (!this._cache) this._cache = new Set(this._def.values);
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues,
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) enumValues[val] = val;
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) enumValues[val] = val;
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) enumValues[val] = val;
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return ZodEnum.create(values, {
      ...this._def,
      ...newDef,
    });
  }
  exclude(values, newDef = this._def) {
    return ZodEnum.create(
      this.options.filter((opt) => !values.includes(opt)),
      {
        ...this._def,
        ...newDef,
      },
    );
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type,
      });
      return INVALID;
    }
    if (!this._cache) this._cache = new Set(util.getValidEnumValues(this._def.values));
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues,
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params),
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    return OK(
      (ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data)).then(
        (data) => {
          return this._def.type.parseAsync(data, {
            path: ctx.path,
            errorMap: ctx.common.contextualErrorMap,
          });
        },
      ),
    );
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params),
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects
      ? this._def.schema.sourceType()
      : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) status.abort();
        else status.dirty();
      },
      get path() {
        return ctx.path;
      },
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async)
        return Promise.resolve(processed).then(async (processed) => {
          if (status.value === "aborted") return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed,
            path: ctx.path,
            parent: ctx,
          });
          if (result.status === "aborted") return INVALID;
          if (result.status === "dirty") return DIRTY(result.value);
          if (status.value === "dirty") return DIRTY(result.value);
          return result;
        });
      else {
        if (status.value === "aborted") return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx,
        });
        if (result.status === "aborted") return INVALID;
        if (result.status === "dirty") return DIRTY(result.value);
        if (status.value === "dirty") return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) return Promise.resolve(result);
        if (result instanceof Promise)
          throw new Error(
            "Async refinement encountered during synchronous parse operation. Use .parseAsync instead.",
          );
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx,
        });
        if (inner.status === "aborted") return INVALID;
        if (inner.status === "dirty") status.dirty();
        executeRefinement(inner.value);
        return {
          status: status.value,
          value: inner.value,
        };
      } else
        return this._def.schema
          ._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx,
          })
          .then((inner) => {
            if (inner.status === "aborted") return INVALID;
            if (inner.status === "dirty") status.dirty();
            return executeRefinement(inner.value).then(() => {
              return {
                status: status.value,
                value: inner.value,
              };
            });
          });
    }
    if (effect.type === "transform")
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx,
        });
        if (!isValid(base)) return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise)
          throw new Error(
            `Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`,
          );
        return {
          status: status.value,
          value: result,
        };
      } else
        return this._def.schema
          ._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx,
          })
          .then((base) => {
            if (!isValid(base)) return INVALID;
            return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
              status: status.value,
              value: result,
            }));
          });
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params),
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: {
      type: "preprocess",
      transform: preprocess,
    },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params),
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    if (this._getType(input) === ZodParsedType.undefined) return OK(void 0);
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params),
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    if (this._getType(input) === ZodParsedType.null) return OK(null);
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params),
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) data = this._def.defaultValue();
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx,
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params),
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: [],
      },
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: { ...newCtx },
    });
    if (isAsync(result))
      return result.then((result) => {
        return {
          status: "valid",
          value:
            result.status === "valid"
              ? result.value
              : this._def.catchValue({
                  get error() {
                    return new ZodError(newCtx.common.issues);
                  },
                  input: newCtx.data,
                }),
        };
      });
    else
      return {
        status: "valid",
        value:
          result.status === "valid"
            ? result.value
            : this._def.catchValue({
                get error() {
                  return new ZodError(newCtx.common.issues);
                },
                input: newCtx.data,
              }),
      };
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params),
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    if (this._getType(input) !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    return {
      status: "valid",
      value: input.data,
    };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params),
  });
};
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx,
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx,
        });
        if (inResult.status === "aborted") return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx,
          });
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx,
      });
      if (inResult.status === "aborted") return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value,
        };
      } else
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx,
        });
    }
  }
  static create(a, b) {
    return new ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline,
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) data.value = Object.freeze(data.value);
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params),
  });
};
ZodObject.lazycreate;
var ZodFirstPartyTypeKind;
(function (ZodFirstPartyTypeKind) {
  ZodFirstPartyTypeKind["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var stringType = ZodString.create;
var numberType = ZodNumber.create;
ZodNaN.create;
ZodBigInt.create;
var booleanType = ZodBoolean.create;
ZodDate.create;
ZodSymbol.create;
ZodUndefined.create;
ZodNull.create;
ZodAny.create;
ZodUnknown.create;
ZodNever.create;
ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
ZodObject.strictCreate;
ZodUnion.create;
ZodDiscriminatedUnion.create;
ZodIntersection.create;
ZodTuple.create;
ZodRecord.create;
ZodMap.create;
ZodSet.create;
ZodFunction.create;
ZodLazy.create;
var literalType = ZodLiteral.create;
ZodEnum.create;
ZodNativeEnum.create;
ZodPromise.create;
ZodEffects.create;
ZodOptional.create;
ZodNullable.create;
ZodEffects.createWithPreprocess;
ZodPipeline.create;
//#endregion
//#region src/orpc/contract.ts
var Thing = objectType({
  id: stringType(),
  name: stringType(),
  createdAt: stringType(),
});
var RandomLogStreamRequest = objectType({
  count: numberType().int().min(1).max(500),
  minDelayMs: numberType().int().min(0).max(1e4),
  maxDelayMs: numberType().int().min(1).max(1e4),
});
var appContract = oc.router({
  ping: oc
    .route({
      method: "GET",
      path: "/ping",
      description: "Health check",
      tags: ["debug"],
    })
    .output(
      objectType({
        message: stringType(),
        time: stringType(),
      }),
    ),
  things: {
    list: oc
      .route({
        method: "GET",
        path: "/things",
        description: "List all things",
        tags: ["things"],
      })
      .output(
        objectType({
          items: arrayType(Thing),
          total: numberType(),
        }),
      ),
    create: oc
      .route({
        method: "POST",
        path: "/things",
        description: "Create a thing",
        tags: ["things"],
      })
      .input(objectType({ name: stringType().min(1).max(200) }))
      .output(Thing),
    remove: oc
      .route({
        method: "POST",
        path: "/things/remove",
        description: "Delete a thing",
        tags: ["things"],
      })
      .input(objectType({ id: stringType().min(1) }))
      .output(
        objectType({
          ok: literalType(true),
          id: stringType(),
          deleted: booleanType(),
        }),
      ),
  },
  test: {
    randomLogStream: oc
      .route({
        method: "POST",
        path: "/test/random-log-stream",
        description: "Stream random log lines with variable delays (async iterator)",
        tags: ["streaming"],
      })
      .input(RandomLogStreamRequest)
      .output(eventIterator(stringType())),
  },
});
//#endregion
//#region node_modules/@orpc/openapi-client/dist/shared/openapi-client.t9fCAe3x.mjs
var StandardBracketNotationSerializer = class {
  maxArrayIndex;
  constructor(options = {}) {
    this.maxArrayIndex = options.maxBracketNotationArrayIndex ?? 9999;
  }
  serialize(data, segments = [], result = []) {
    if (Array.isArray(data))
      data.forEach((item, i) => {
        this.serialize(item, [...segments, i], result);
      });
    else if (isObject(data))
      for (const key in data) this.serialize(data[key], [...segments, key], result);
    else result.push([this.stringifyPath(segments), data]);
    return result;
  }
  deserialize(serialized) {
    if (serialized.length === 0) return {};
    const arrayPushStyles = /* @__PURE__ */ new WeakSet();
    const ref = { value: [] };
    for (const [path, value] of serialized) {
      const segments = this.parsePath(path);
      let currentRef = ref;
      let nextSegment = "value";
      segments.forEach((segment, i) => {
        if (!Array.isArray(currentRef[nextSegment]) && !isObject(currentRef[nextSegment]))
          currentRef[nextSegment] = [];
        if (i !== segments.length - 1) {
          if (
            Array.isArray(currentRef[nextSegment]) &&
            !isValidArrayIndex(segment, this.maxArrayIndex)
          )
            if (arrayPushStyles.has(currentRef[nextSegment])) {
              arrayPushStyles.delete(currentRef[nextSegment]);
              currentRef[nextSegment] = pushStyleArrayToObject(currentRef[nextSegment]);
            } else currentRef[nextSegment] = arrayToObject(currentRef[nextSegment]);
        } else if (Array.isArray(currentRef[nextSegment])) {
          if (segment === "") {
            if (currentRef[nextSegment].length && !arrayPushStyles.has(currentRef[nextSegment]))
              currentRef[nextSegment] = arrayToObject(currentRef[nextSegment]);
          } else if (arrayPushStyles.has(currentRef[nextSegment])) {
            arrayPushStyles.delete(currentRef[nextSegment]);
            currentRef[nextSegment] = pushStyleArrayToObject(currentRef[nextSegment]);
          } else if (!isValidArrayIndex(segment, this.maxArrayIndex))
            currentRef[nextSegment] = arrayToObject(currentRef[nextSegment]);
        }
        currentRef = currentRef[nextSegment];
        nextSegment = segment;
      });
      if (Array.isArray(currentRef) && nextSegment === "") {
        arrayPushStyles.add(currentRef);
        currentRef.push(value);
      } else if (nextSegment in currentRef)
        if (Array.isArray(currentRef[nextSegment])) currentRef[nextSegment].push(value);
        else currentRef[nextSegment] = [currentRef[nextSegment], value];
      else currentRef[nextSegment] = value;
    }
    return ref.value;
  }
  stringifyPath(segments) {
    return segments
      .map((segment) => {
        return segment.toString().replace(/[\\[\]]/g, (match) => {
          switch (match) {
            case "\\":
              return "\\\\";
            case "[":
              return "\\[";
            case "]":
              return "\\]";
            /* v8 ignore next 2 */
            default:
              return match;
          }
        });
      })
      .reduce((result, segment, i) => {
        if (i === 0) return segment;
        return `${result}[${segment}]`;
      }, "");
  }
  parsePath(path) {
    const segments = [];
    let inBrackets = false;
    let currentSegment = "";
    let backslashCount = 0;
    for (let i = 0; i < path.length; i++) {
      const char = path[i];
      const nextChar = path[i + 1];
      if (
        inBrackets &&
        char === "]" &&
        (nextChar === void 0 || nextChar === "[") &&
        backslashCount % 2 === 0
      ) {
        if (nextChar === void 0) inBrackets = false;
        segments.push(currentSegment);
        currentSegment = "";
        i++;
      } else if (segments.length === 0 && char === "[" && backslashCount % 2 === 0) {
        inBrackets = true;
        segments.push(currentSegment);
        currentSegment = "";
      } else if (char === "\\") backslashCount++;
      else {
        currentSegment += "\\".repeat(backslashCount / 2) + char;
        backslashCount = 0;
      }
    }
    return inBrackets || segments.length === 0 ? [path] : segments;
  }
};
function isValidArrayIndex(value, maxIndex) {
  return /^0$|^[1-9]\d*$/.test(value) && Number(value) <= maxIndex;
}
function arrayToObject(array) {
  const obj = new NullProtoObj();
  array.forEach((item, i) => {
    obj[i] = item;
  });
  return obj;
}
function pushStyleArrayToObject(array) {
  const obj = new NullProtoObj();
  obj[""] = array.length === 1 ? array[0] : array;
  return obj;
}
//#endregion
//#region node_modules/@orpc/openapi-client/dist/shared/openapi-client.B2Q9qU5m.mjs
var StandardOpenAPIJsonSerializer = class {
  customSerializers;
  constructor(options = {}) {
    this.customSerializers = options.customJsonSerializers ?? [];
  }
  serialize(data, hasBlobRef = { value: false }) {
    for (const custom of this.customSerializers)
      if (custom.condition(data)) return this.serialize(custom.serialize(data), hasBlobRef);
    if (data instanceof Blob) {
      hasBlobRef.value = true;
      return [data, hasBlobRef.value];
    }
    if (data instanceof Set) return this.serialize(Array.from(data), hasBlobRef);
    if (data instanceof Map) return this.serialize(Array.from(data.entries()), hasBlobRef);
    if (Array.isArray(data))
      return [
        data.map((v) => (v === void 0 ? null : this.serialize(v, hasBlobRef)[0])),
        hasBlobRef.value,
      ];
    if (isObject(data)) {
      const json = {};
      for (const k in data) {
        if (k === "toJSON" && typeof data[k] === "function") continue;
        json[k] = this.serialize(data[k], hasBlobRef)[0];
      }
      return [json, hasBlobRef.value];
    }
    if (typeof data === "bigint" || data instanceof RegExp || data instanceof URL)
      return [data.toString(), hasBlobRef.value];
    if (data instanceof Date)
      return [Number.isNaN(data.getTime()) ? null : data.toISOString(), hasBlobRef.value];
    if (Number.isNaN(data)) return [null, hasBlobRef.value];
    return [data, hasBlobRef.value];
  }
};
function standardizeHTTPPath(path) {
  return `/${path.replace(/\/{2,}/g, "/").replace(/^\/|\/$/g, "")}`;
}
function getDynamicParams(path) {
  return path
    ? standardizeHTTPPath(path)
        .match(/\/\{[^}]+\}/g)
        ?.map((v) => ({
          raw: v,
          name: v.match(/\{\+?([^}]+)\}/)[1],
        }))
    : void 0;
}
var StandardOpenapiLinkCodec = class {
  constructor(contract, serializer, options) {
    this.contract = contract;
    this.serializer = serializer;
    this.baseUrl = options.url;
    this.headers = options.headers ?? {};
    this.customErrorResponseBodyDecoder = options.customErrorResponseBodyDecoder;
  }
  baseUrl;
  headers;
  customErrorResponseBodyDecoder;
  async encode(path, input, options) {
    let headers = toStandardHeaders(await value(this.headers, options, path, input));
    if (options.lastEventId !== void 0)
      headers = mergeStandardHeaders(headers, { "last-event-id": options.lastEventId });
    const baseUrl = await value(this.baseUrl, options, path, input);
    const procedure = get(this.contract, path);
    if (!isContractProcedure(procedure))
      throw new Error(
        `[StandardOpenapiLinkCodec] expect a contract procedure at ${path.join(".")}`,
      );
    return fallbackContractConfig(
      "defaultInputStructure",
      procedure["~orpc"].route.inputStructure,
    ) === "compact"
      ? this.#encodeCompact(procedure, path, input, options, baseUrl, headers)
      : this.#encodeDetailed(procedure, path, input, options, baseUrl, headers);
  }
  #encodeCompact(procedure, path, input, options, baseUrl, headers) {
    let httpPath = standardizeHTTPPath(procedure["~orpc"].route.path ?? toHttpPath(path));
    let httpBody = input;
    const dynamicParams = getDynamicParams(httpPath);
    if (dynamicParams?.length) {
      if (!isObject(input))
        throw new TypeError(
          `[StandardOpenapiLinkCodec] Invalid input shape for "compact" structure when has dynamic params at ${path.join(".")}.`,
        );
      const body = { ...input };
      for (const param of dynamicParams) {
        const value2 = input[param.name];
        httpPath = httpPath.replace(
          param.raw,
          `/${encodeURIComponent(`${this.serializer.serialize(value2)}`)}`,
        );
        delete body[param.name];
      }
      httpBody = Object.keys(body).length ? body : void 0;
    }
    const method = fallbackContractConfig("defaultMethod", procedure["~orpc"].route.method);
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/$/, "")}${httpPath}`;
    if (method === "GET") {
      const serialized = this.serializer.serialize(httpBody, { outputFormat: "URLSearchParams" });
      for (const [key, value2] of serialized) url.searchParams.append(key, value2);
      return {
        url,
        method,
        headers,
        body: void 0,
        signal: options.signal,
      };
    }
    return {
      url,
      method,
      headers,
      body: this.serializer.serialize(httpBody),
      signal: options.signal,
    };
  }
  #encodeDetailed(procedure, path, input, options, baseUrl, headers) {
    let httpPath = standardizeHTTPPath(procedure["~orpc"].route.path ?? toHttpPath(path));
    const dynamicParams = getDynamicParams(httpPath);
    if (!isObject(input) && input !== void 0)
      throw new TypeError(
        `[StandardOpenapiLinkCodec] Invalid input shape for "detailed" structure at ${path.join(".")}.`,
      );
    if (dynamicParams?.length) {
      if (!isObject(input?.params))
        throw new TypeError(
          `[StandardOpenapiLinkCodec] Invalid input.params shape for "detailed" structure when has dynamic params at ${path.join(".")}.`,
        );
      for (const param of dynamicParams) {
        const value2 = input.params[param.name];
        httpPath = httpPath.replace(
          param.raw,
          `/${encodeURIComponent(`${this.serializer.serialize(value2)}`)}`,
        );
      }
    }
    let mergedHeaders = headers;
    if (input?.headers !== void 0) {
      if (!isObject(input.headers))
        throw new TypeError(
          `[StandardOpenapiLinkCodec] Invalid input.headers shape for "detailed" structure at ${path.join(".")}.`,
        );
      mergedHeaders = mergeStandardHeaders(input.headers, headers);
    }
    const method = fallbackContractConfig("defaultMethod", procedure["~orpc"].route.method);
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/$/, "")}${httpPath}`;
    if (input?.query !== void 0) {
      const query = this.serializer.serialize(input.query, { outputFormat: "URLSearchParams" });
      for (const [key, value2] of query) url.searchParams.append(key, value2);
    }
    if (method === "GET")
      return {
        url,
        method,
        headers: mergedHeaders,
        body: void 0,
        signal: options.signal,
      };
    return {
      url,
      method,
      headers: mergedHeaders,
      body: this.serializer.serialize(input?.body),
      signal: options.signal,
    };
  }
  async decode(response, _options, path) {
    const isOk = !isORPCErrorStatus(response.status);
    const deserialized = await (async () => {
      let isBodyOk = false;
      try {
        const body = await response.body();
        isBodyOk = true;
        return this.serializer.deserialize(body);
      } catch (error) {
        if (!isBodyOk)
          throw new Error(
            "Cannot parse response body, please check the response body and content-type.",
            { cause: error },
          );
        throw new Error("Invalid OpenAPI response format.", { cause: error });
      }
    })();
    if (!isOk) {
      const error = this.customErrorResponseBodyDecoder?.(deserialized, response);
      if (error !== null && error !== void 0) throw error;
      if (isORPCErrorJson(deserialized)) throw createORPCErrorFromJson(deserialized);
      throw new ORPCError(getMalformedResponseErrorCode(response.status), {
        status: response.status,
        data: {
          ...response,
          body: deserialized,
        },
      });
    }
    const procedure = get(this.contract, path);
    if (!isContractProcedure(procedure))
      throw new Error(
        `[StandardOpenapiLinkCodec] expect a contract procedure at ${path.join(".")}`,
      );
    if (
      fallbackContractConfig("defaultOutputStructure", procedure["~orpc"].route.outputStructure) ===
      "compact"
    )
      return deserialized;
    return {
      status: response.status,
      headers: response.headers,
      body: deserialized,
    };
  }
};
var StandardOpenAPISerializer = class {
  constructor(jsonSerializer, bracketNotation) {
    this.jsonSerializer = jsonSerializer;
    this.bracketNotation = bracketNotation;
  }
  serialize(data, options = {}) {
    if (isAsyncIteratorObject(data) && !options.outputFormat)
      return mapEventIterator(data, {
        value: async (value) => this.#serialize(value, { outputFormat: "plain" }),
        error: async (e) => {
          return new ErrorEvent({
            data: this.#serialize(toORPCError(e).toJSON(), { outputFormat: "plain" }),
            cause: e,
          });
        },
      });
    return this.#serialize(data, options);
  }
  #serialize(data, options) {
    const [json, hasBlob] = this.jsonSerializer.serialize(data);
    if (options.outputFormat === "plain") return json;
    if (options.outputFormat === "URLSearchParams") {
      const params = new URLSearchParams();
      for (const [path, value] of this.bracketNotation.serialize(json))
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
          params.append(path, value.toString());
      return params;
    }
    if (json instanceof Blob || json === void 0 || !hasBlob) return json;
    const form = new FormData();
    for (const [path, value] of this.bracketNotation.serialize(json))
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        form.append(path, value.toString());
      else if (value instanceof Blob) form.append(path, value);
    return form;
  }
  deserialize(data) {
    if (data instanceof URLSearchParams || data instanceof FormData)
      return this.bracketNotation.deserialize(Array.from(data.entries()));
    if (isAsyncIteratorObject(data))
      return mapEventIterator(data, {
        value: async (value) => value,
        error: async (e) => {
          if (e instanceof ErrorEvent && isORPCErrorJson(e.data))
            return createORPCErrorFromJson(e.data, { cause: e });
          return e;
        },
      });
    return data;
  }
};
var StandardOpenAPILink = class extends StandardLink {
  constructor(contract, linkClient, options) {
    const linkCodec = new StandardOpenapiLinkCodec(
      contract,
      new StandardOpenAPISerializer(
        new StandardOpenAPIJsonSerializer(options),
        new StandardBracketNotationSerializer({ maxBracketNotationArrayIndex: 4294967294 }),
      ),
      options,
    );
    super(linkCodec, linkClient, options);
  }
};
//#endregion
export {
  environmentManager as A,
  matchQuery as B,
  Mutation as C,
  onlineManager as D,
  fetchState as E,
  functionalUpdate as F,
  resolveStaleTime as G,
  partialMatchKey as H,
  hashKey as I,
  skipToken as J,
  shallowEqualObjects as K,
  hashQueryKeyByOptions as L,
  addToEnd as M,
  addToStart as N,
  notifyManager as O,
  ensureQueryFn as P,
  Subscribable as Q,
  isValidTimeout as R,
  useQueryClient as S,
  Query as T,
  replaceData as U,
  noop as V,
  resolveEnabled as W,
  timeoutManager as X,
  timeUntilStale as Y,
  focusManager as Z,
  ValidationError as _,
  standardizeHTTPPath as a,
  validateORPCError as b,
  ZodFirstPartyTypeKind as c,
  getContractRouter as d,
  getEventIteratorSchemaDetails as f,
  mergeTags as g,
  mergeRoute as h,
  getDynamicParams as i,
  addConsumeAwareSignal as j,
  pendingThenable as k,
  enhanceRoute as l,
  mergePrefix as m,
  StandardOpenAPILink as n,
  StandardBracketNotationSerializer as o,
  mergeMeta as p,
  shouldThrowError as q,
  StandardOpenAPISerializer as r,
  appContract as s,
  StandardOpenAPIJsonSerializer as t,
  fallbackContractConfig as u,
  isContractProcedure as v,
  getDefaultState as w,
  QueryClientProvider as x,
  mergeErrorMap as y,
  matchMutation as z,
};
