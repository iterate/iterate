import {
  i as __toESM,
  n as require_react,
  t as require_jsx_runtime,
} from "./jsx-runtime-B9Euz7RS.js";
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
  x as toORPCError,
  y as isORPCErrorJson,
} from "./client.DrB9nq_G-C5sxXqjr.js";
import { f as isContractProcedure, i as fallbackContractConfig } from "./contract-DV24D5zz.js";
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
  resolveEnabled as A,
  hashQueryKeyByOptions as C,
  noop as D,
  matchQuery as E,
  timeUntilStale as F,
  timeoutManager as I,
  focusManager as L,
  shallowEqualObjects as M,
  shouldThrowError as N,
  partialMatchKey as O,
  skipToken as P,
  Subscribable as R,
  hashKey as S,
  matchMutation as T,
  addConsumeAwareSignal as _,
  standardizeHTTPPath as a,
  ensureQueryFn as b,
  useQueryClient as c,
  Query as d,
  fetchState as f,
  environmentManager as g,
  pendingThenable as h,
  getDynamicParams as i,
  resolveStaleTime as j,
  replaceData as k,
  Mutation as l,
  notifyManager as m,
  StandardOpenAPILink as n,
  StandardBracketNotationSerializer as o,
  onlineManager as p,
  StandardOpenAPISerializer as r,
  QueryClientProvider as s,
  StandardOpenAPIJsonSerializer as t,
  getDefaultState as u,
  addToEnd as v,
  isValidTimeout as w,
  functionalUpdate as x,
  addToStart as y,
};
