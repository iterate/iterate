import { AsyncLocalStorage as AsyncLocalStorage$1 } from "node:async_hooks";
import { ReadableStream as ReadableStream$1 } from "node:stream/web";
import { Readable, PassThrough } from "node:stream";
function getDefaultExportFromCjs(x3) {
  return x3 && x3.__esModule && Object.prototype.hasOwnProperty.call(x3, "default")
    ? x3["default"]
    : x3;
}
var react = { exports: {} };
var react_production = {};
/**
 * @license React
 * react.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var hasRequiredReact_production;
function requireReact_production() {
  if (hasRequiredReact_production) return react_production;
  hasRequiredReact_production = 1;
  var REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element"),
    REACT_PORTAL_TYPE = Symbol.for("react.portal"),
    REACT_FRAGMENT_TYPE = Symbol.for("react.fragment"),
    REACT_STRICT_MODE_TYPE = Symbol.for("react.strict_mode"),
    REACT_PROFILER_TYPE = Symbol.for("react.profiler"),
    REACT_CONSUMER_TYPE = Symbol.for("react.consumer"),
    REACT_CONTEXT_TYPE = Symbol.for("react.context"),
    REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref"),
    REACT_SUSPENSE_TYPE = Symbol.for("react.suspense"),
    REACT_MEMO_TYPE = Symbol.for("react.memo"),
    REACT_LAZY_TYPE = Symbol.for("react.lazy"),
    REACT_ACTIVITY_TYPE = Symbol.for("react.activity"),
    MAYBE_ITERATOR_SYMBOL = Symbol.iterator;
  function getIteratorFn(maybeIterable) {
    if (null === maybeIterable || "object" !== typeof maybeIterable) return null;
    maybeIterable =
      (MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL]) ||
      maybeIterable["@@iterator"];
    return "function" === typeof maybeIterable ? maybeIterable : null;
  }
  var ReactNoopUpdateQueue = {
      isMounted: function () {
        return false;
      },
      enqueueForceUpdate: function () {},
      enqueueReplaceState: function () {},
      enqueueSetState: function () {},
    },
    assign = Object.assign,
    emptyObject = {};
  function Component(props, context, updater) {
    this.props = props;
    this.context = context;
    this.refs = emptyObject;
    this.updater = updater || ReactNoopUpdateQueue;
  }
  Component.prototype.isReactComponent = {};
  Component.prototype.setState = function (partialState, callback) {
    if (
      "object" !== typeof partialState &&
      "function" !== typeof partialState &&
      null != partialState
    )
      throw Error(
        "takes an object of state variables to update or a function which returns an object of state variables.",
      );
    this.updater.enqueueSetState(this, partialState, callback, "setState");
  };
  Component.prototype.forceUpdate = function (callback) {
    this.updater.enqueueForceUpdate(this, callback, "forceUpdate");
  };
  function ComponentDummy() {}
  ComponentDummy.prototype = Component.prototype;
  function PureComponent(props, context, updater) {
    this.props = props;
    this.context = context;
    this.refs = emptyObject;
    this.updater = updater || ReactNoopUpdateQueue;
  }
  var pureComponentPrototype = (PureComponent.prototype = new ComponentDummy());
  pureComponentPrototype.constructor = PureComponent;
  assign(pureComponentPrototype, Component.prototype);
  pureComponentPrototype.isPureReactComponent = true;
  var isArrayImpl = Array.isArray;
  function noop() {}
  var ReactSharedInternals = { H: null, A: null, T: null, S: null },
    hasOwnProperty = Object.prototype.hasOwnProperty;
  function ReactElement(type, key, props) {
    var refProp = props.ref;
    return {
      $$typeof: REACT_ELEMENT_TYPE,
      type,
      key,
      ref: void 0 !== refProp ? refProp : null,
      props,
    };
  }
  function cloneAndReplaceKey(oldElement, newKey) {
    return ReactElement(oldElement.type, newKey, oldElement.props);
  }
  function isValidElement(object) {
    return "object" === typeof object && null !== object && object.$$typeof === REACT_ELEMENT_TYPE;
  }
  function escape(key) {
    var escaperLookup = { "=": "=0", ":": "=2" };
    return (
      "$" +
      key.replace(/[=:]/g, function (match) {
        return escaperLookup[match];
      })
    );
  }
  var userProvidedKeyEscapeRegex = /\/+/g;
  function getElementKey(element, index) {
    return "object" === typeof element && null !== element && null != element.key
      ? escape("" + element.key)
      : index.toString(36);
  }
  function resolveThenable(thenable) {
    switch (thenable.status) {
      case "fulfilled":
        return thenable.value;
      case "rejected":
        throw thenable.reason;
      default:
        switch (
          ("string" === typeof thenable.status
            ? thenable.then(noop, noop)
            : ((thenable.status = "pending"),
              thenable.then(
                function (fulfilledValue) {
                  "pending" === thenable.status &&
                    ((thenable.status = "fulfilled"), (thenable.value = fulfilledValue));
                },
                function (error) {
                  "pending" === thenable.status &&
                    ((thenable.status = "rejected"), (thenable.reason = error));
                },
              )),
          thenable.status)
        ) {
          case "fulfilled":
            return thenable.value;
          case "rejected":
            throw thenable.reason;
        }
    }
    throw thenable;
  }
  function mapIntoArray(children, array, escapedPrefix, nameSoFar, callback) {
    var type = typeof children;
    if ("undefined" === type || "boolean" === type) children = null;
    var invokeCallback = false;
    if (null === children) invokeCallback = true;
    else
      switch (type) {
        case "bigint":
        case "string":
        case "number":
          invokeCallback = true;
          break;
        case "object":
          switch (children.$$typeof) {
            case REACT_ELEMENT_TYPE:
            case REACT_PORTAL_TYPE:
              invokeCallback = true;
              break;
            case REACT_LAZY_TYPE:
              return (
                (invokeCallback = children._init),
                mapIntoArray(
                  invokeCallback(children._payload),
                  array,
                  escapedPrefix,
                  nameSoFar,
                  callback,
                )
              );
          }
      }
    if (invokeCallback)
      return (
        (callback = callback(children)),
        (invokeCallback = "" === nameSoFar ? "." + getElementKey(children, 0) : nameSoFar),
        isArrayImpl(callback)
          ? ((escapedPrefix = ""),
            null != invokeCallback &&
              (escapedPrefix = invokeCallback.replace(userProvidedKeyEscapeRegex, "$&/") + "/"),
            mapIntoArray(callback, array, escapedPrefix, "", function (c2) {
              return c2;
            }))
          : null != callback &&
            (isValidElement(callback) &&
              (callback = cloneAndReplaceKey(
                callback,
                escapedPrefix +
                  (null == callback.key || (children && children.key === callback.key)
                    ? ""
                    : ("" + callback.key).replace(userProvidedKeyEscapeRegex, "$&/") + "/") +
                  invokeCallback,
              )),
            array.push(callback)),
        1
      );
    invokeCallback = 0;
    var nextNamePrefix = "" === nameSoFar ? "." : nameSoFar + ":";
    if (isArrayImpl(children))
      for (var i = 0; i < children.length; i++)
        ((nameSoFar = children[i]),
          (type = nextNamePrefix + getElementKey(nameSoFar, i)),
          (invokeCallback += mapIntoArray(nameSoFar, array, escapedPrefix, type, callback)));
    else if (((i = getIteratorFn(children)), "function" === typeof i))
      for (children = i.call(children), i = 0; !(nameSoFar = children.next()).done; )
        ((nameSoFar = nameSoFar.value),
          (type = nextNamePrefix + getElementKey(nameSoFar, i++)),
          (invokeCallback += mapIntoArray(nameSoFar, array, escapedPrefix, type, callback)));
    else if ("object" === type) {
      if ("function" === typeof children.then)
        return mapIntoArray(resolveThenable(children), array, escapedPrefix, nameSoFar, callback);
      array = String(children);
      throw Error(
        "Objects are not valid as a React child (found: " +
          ("[object Object]" === array
            ? "object with keys {" + Object.keys(children).join(", ") + "}"
            : array) +
          "). If you meant to render a collection of children, use an array instead.",
      );
    }
    return invokeCallback;
  }
  function mapChildren(children, func, context) {
    if (null == children) return children;
    var result = [],
      count = 0;
    mapIntoArray(children, result, "", "", function (child) {
      return func.call(context, child, count++);
    });
    return result;
  }
  function lazyInitializer(payload) {
    if (-1 === payload._status) {
      var ctor = payload._result;
      ctor = ctor();
      ctor.then(
        function (moduleObject) {
          if (0 === payload._status || -1 === payload._status)
            ((payload._status = 1), (payload._result = moduleObject));
        },
        function (error) {
          if (0 === payload._status || -1 === payload._status)
            ((payload._status = 2), (payload._result = error));
        },
      );
      -1 === payload._status && ((payload._status = 0), (payload._result = ctor));
    }
    if (1 === payload._status) return payload._result.default;
    throw payload._result;
  }
  var reportGlobalError =
      "function" === typeof reportError
        ? reportError
        : function (error) {
            if ("object" === typeof window && "function" === typeof window.ErrorEvent) {
              var event = new window.ErrorEvent("error", {
                bubbles: true,
                cancelable: true,
                message:
                  "object" === typeof error && null !== error && "string" === typeof error.message
                    ? String(error.message)
                    : String(error),
                error,
              });
              if (!window.dispatchEvent(event)) return;
            } else if ("object" === typeof process && "function" === typeof process.emit) {
              process.emit("uncaughtException", error);
              return;
            }
            console.error(error);
          },
    Children = {
      map: mapChildren,
      forEach: function (children, forEachFunc, forEachContext) {
        mapChildren(
          children,
          function () {
            forEachFunc.apply(this, arguments);
          },
          forEachContext,
        );
      },
      count: function (children) {
        var n2 = 0;
        mapChildren(children, function () {
          n2++;
        });
        return n2;
      },
      toArray: function (children) {
        return (
          mapChildren(children, function (child) {
            return child;
          }) || []
        );
      },
      only: function (children) {
        if (!isValidElement(children))
          throw Error("React.Children.only expected to receive a single React element child.");
        return children;
      },
    };
  react_production.Activity = REACT_ACTIVITY_TYPE;
  react_production.Children = Children;
  react_production.Component = Component;
  react_production.Fragment = REACT_FRAGMENT_TYPE;
  react_production.Profiler = REACT_PROFILER_TYPE;
  react_production.PureComponent = PureComponent;
  react_production.StrictMode = REACT_STRICT_MODE_TYPE;
  react_production.Suspense = REACT_SUSPENSE_TYPE;
  react_production.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE =
    ReactSharedInternals;
  react_production.__COMPILER_RUNTIME = {
    __proto__: null,
    c: function (size) {
      return ReactSharedInternals.H.useMemoCache(size);
    },
  };
  react_production.cache = function (fn2) {
    return function () {
      return fn2.apply(null, arguments);
    };
  };
  react_production.cacheSignal = function () {
    return null;
  };
  react_production.cloneElement = function (element, config, children) {
    if (null === element || void 0 === element)
      throw Error("The argument must be a React element, but you passed " + element + ".");
    var props = assign({}, element.props),
      key = element.key;
    if (null != config)
      for (propName in (void 0 !== config.key && (key = "" + config.key), config))
        !hasOwnProperty.call(config, propName) ||
          "key" === propName ||
          "__self" === propName ||
          "__source" === propName ||
          ("ref" === propName && void 0 === config.ref) ||
          (props[propName] = config[propName]);
    var propName = arguments.length - 2;
    if (1 === propName) props.children = children;
    else if (1 < propName) {
      for (var childArray = Array(propName), i = 0; i < propName; i++)
        childArray[i] = arguments[i + 2];
      props.children = childArray;
    }
    return ReactElement(element.type, key, props);
  };
  react_production.createContext = function (defaultValue) {
    defaultValue = {
      $$typeof: REACT_CONTEXT_TYPE,
      _currentValue: defaultValue,
      _currentValue2: defaultValue,
      _threadCount: 0,
      Provider: null,
      Consumer: null,
    };
    defaultValue.Provider = defaultValue;
    defaultValue.Consumer = {
      $$typeof: REACT_CONSUMER_TYPE,
      _context: defaultValue,
    };
    return defaultValue;
  };
  react_production.createElement = function (type, config, children) {
    var propName,
      props = {},
      key = null;
    if (null != config)
      for (propName in (void 0 !== config.key && (key = "" + config.key), config))
        hasOwnProperty.call(config, propName) &&
          "key" !== propName &&
          "__self" !== propName &&
          "__source" !== propName &&
          (props[propName] = config[propName]);
    var childrenLength = arguments.length - 2;
    if (1 === childrenLength) props.children = children;
    else if (1 < childrenLength) {
      for (var childArray = Array(childrenLength), i = 0; i < childrenLength; i++)
        childArray[i] = arguments[i + 2];
      props.children = childArray;
    }
    if (type && type.defaultProps)
      for (propName in ((childrenLength = type.defaultProps), childrenLength))
        void 0 === props[propName] && (props[propName] = childrenLength[propName]);
    return ReactElement(type, key, props);
  };
  react_production.createRef = function () {
    return { current: null };
  };
  react_production.forwardRef = function (render) {
    return { $$typeof: REACT_FORWARD_REF_TYPE, render };
  };
  react_production.isValidElement = isValidElement;
  react_production.lazy = function (ctor) {
    return {
      $$typeof: REACT_LAZY_TYPE,
      _payload: { _status: -1, _result: ctor },
      _init: lazyInitializer,
    };
  };
  react_production.memo = function (type, compare) {
    return {
      $$typeof: REACT_MEMO_TYPE,
      type,
      compare: void 0 === compare ? null : compare,
    };
  };
  react_production.startTransition = function (scope) {
    var prevTransition = ReactSharedInternals.T,
      currentTransition = {};
    ReactSharedInternals.T = currentTransition;
    try {
      var returnValue = scope(),
        onStartTransitionFinish = ReactSharedInternals.S;
      null !== onStartTransitionFinish && onStartTransitionFinish(currentTransition, returnValue);
      "object" === typeof returnValue &&
        null !== returnValue &&
        "function" === typeof returnValue.then &&
        returnValue.then(noop, reportGlobalError);
    } catch (error) {
      reportGlobalError(error);
    } finally {
      (null !== prevTransition &&
        null !== currentTransition.types &&
        (prevTransition.types = currentTransition.types),
        (ReactSharedInternals.T = prevTransition));
    }
  };
  react_production.unstable_useCacheRefresh = function () {
    return ReactSharedInternals.H.useCacheRefresh();
  };
  react_production.use = function (usable) {
    return ReactSharedInternals.H.use(usable);
  };
  react_production.useActionState = function (action, initialState, permalink) {
    return ReactSharedInternals.H.useActionState(action, initialState, permalink);
  };
  react_production.useCallback = function (callback, deps) {
    return ReactSharedInternals.H.useCallback(callback, deps);
  };
  react_production.useContext = function (Context) {
    return ReactSharedInternals.H.useContext(Context);
  };
  react_production.useDebugValue = function () {};
  react_production.useDeferredValue = function (value, initialValue) {
    return ReactSharedInternals.H.useDeferredValue(value, initialValue);
  };
  react_production.useEffect = function (create, deps) {
    return ReactSharedInternals.H.useEffect(create, deps);
  };
  react_production.useEffectEvent = function (callback) {
    return ReactSharedInternals.H.useEffectEvent(callback);
  };
  react_production.useId = function () {
    return ReactSharedInternals.H.useId();
  };
  react_production.useImperativeHandle = function (ref, create, deps) {
    return ReactSharedInternals.H.useImperativeHandle(ref, create, deps);
  };
  react_production.useInsertionEffect = function (create, deps) {
    return ReactSharedInternals.H.useInsertionEffect(create, deps);
  };
  react_production.useLayoutEffect = function (create, deps) {
    return ReactSharedInternals.H.useLayoutEffect(create, deps);
  };
  react_production.useMemo = function (create, deps) {
    return ReactSharedInternals.H.useMemo(create, deps);
  };
  react_production.useOptimistic = function (passthrough, reducer) {
    return ReactSharedInternals.H.useOptimistic(passthrough, reducer);
  };
  react_production.useReducer = function (reducer, initialArg, init) {
    return ReactSharedInternals.H.useReducer(reducer, initialArg, init);
  };
  react_production.useRef = function (initialValue) {
    return ReactSharedInternals.H.useRef(initialValue);
  };
  react_production.useState = function (initialState) {
    return ReactSharedInternals.H.useState(initialState);
  };
  react_production.useSyncExternalStore = function (subscribe2, getSnapshot, getServerSnapshot) {
    return ReactSharedInternals.H.useSyncExternalStore(subscribe2, getSnapshot, getServerSnapshot);
  };
  react_production.useTransition = function () {
    return ReactSharedInternals.H.useTransition();
  };
  react_production.version = "19.2.5";
  return react_production;
}
var hasRequiredReact;
function requireReact() {
  if (hasRequiredReact) return react.exports;
  hasRequiredReact = 1;
  {
    react.exports = requireReact_production();
  }
  return react.exports;
}
var reactExports = requireReact();
const React = /* @__PURE__ */ getDefaultExportFromCjs(reactExports);
var isServer = true;
function last(arr) {
  return arr[arr.length - 1];
}
function isFunction(d) {
  return typeof d === "function";
}
function functionalUpdate(updater, previous) {
  if (isFunction(updater)) return updater(previous);
  return updater;
}
var createNull = () => /* @__PURE__ */ Object.create(null);
var nullReplaceEqualDeep = (prev, next) => replaceEqualDeep(prev, next, createNull);
function replaceEqualDeep(prev, _next, _makeObj = () => ({}), _depth = 0) {
  return _next;
}
function isPlainObject(o2) {
  if (!hasObjectPrototype(o2)) return false;
  const ctor = o2.constructor;
  if (typeof ctor === "undefined") return true;
  const prot = ctor.prototype;
  if (!hasObjectPrototype(prot)) return false;
  if (!prot.hasOwnProperty("isPrototypeOf")) return false;
  return true;
}
function hasObjectPrototype(o2) {
  return Object.prototype.toString.call(o2) === "[object Object]";
}
function deepEqual(a, b2, opts) {
  if (a === b2) return true;
  if (typeof a !== typeof b2) return false;
  if (Array.isArray(a) && Array.isArray(b2)) {
    if (a.length !== b2.length) return false;
    for (let i = 0, l = a.length; i < l; i++) if (!deepEqual(a[i], b2[i], opts)) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b2)) {
    const ignoreUndefined = opts?.ignoreUndefined ?? true;
    if (opts?.partial) {
      for (const k2 in b2)
        if (!ignoreUndefined || b2[k2] !== void 0) {
          if (!deepEqual(a[k2], b2[k2], opts)) return false;
        }
      return true;
    }
    let aCount = 0;
    if (!ignoreUndefined) aCount = Object.keys(a).length;
    else for (const k2 in a) if (a[k2] !== void 0) aCount++;
    let bCount = 0;
    for (const k2 in b2)
      if (!ignoreUndefined || b2[k2] !== void 0) {
        bCount++;
        if (bCount > aCount || !deepEqual(a[k2], b2[k2], opts)) return false;
      }
    return aCount === bCount;
  }
  return false;
}
function createControlledPromise(onResolve) {
  let resolveLoadPromise;
  let rejectLoadPromise;
  const controlledPromise = new Promise((resolve, reject) => {
    resolveLoadPromise = resolve;
    rejectLoadPromise = reject;
  });
  controlledPromise.status = "pending";
  controlledPromise.resolve = (value) => {
    controlledPromise.status = "resolved";
    controlledPromise.value = value;
    resolveLoadPromise(value);
    onResolve?.(value);
  };
  controlledPromise.reject = (e) => {
    controlledPromise.status = "rejected";
    rejectLoadPromise(e);
  };
  return controlledPromise;
}
function isModuleNotFoundError(error) {
  if (typeof error?.message !== "string") return false;
  return (
    error.message.startsWith("Failed to fetch dynamically imported module") ||
    error.message.startsWith("error loading dynamically imported module") ||
    error.message.startsWith("Importing a module script failed")
  );
}
function isPromise(value) {
  return Boolean(value && typeof value === "object" && typeof value.then === "function");
}
function sanitizePathSegment(segment) {
  return segment.replace(/[\x00-\x1f\x7f]/g, "");
}
function decodeSegment(segment) {
  let decoded;
  try {
    decoded = decodeURI(segment);
  } catch {
    decoded = segment.replaceAll(/%[0-9A-F]{2}/gi, (match) => {
      try {
        return decodeURI(match);
      } catch {
        return match;
      }
    });
  }
  return sanitizePathSegment(decoded);
}
var DEFAULT_PROTOCOL_ALLOWLIST = ["http:", "https:", "mailto:", "tel:"];
function isDangerousProtocol(url, allowlist) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return !allowlist.has(parsed.protocol);
  } catch {
    return false;
  }
}
var HTML_ESCAPE_LOOKUP = {
  "&": "\\u0026",
  ">": "\\u003e",
  "<": "\\u003c",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};
var HTML_ESCAPE_REGEX = /[&><\u2028\u2029]/g;
function escapeHtml(str) {
  return str.replace(HTML_ESCAPE_REGEX, (match) => HTML_ESCAPE_LOOKUP[match]);
}
function decodePath(path) {
  if (!path)
    return {
      path,
      handledProtocolRelativeURL: false,
    };
  if (!/[%\\\x00-\x1f\x7f]/.test(path) && !path.startsWith("//"))
    return {
      path,
      handledProtocolRelativeURL: false,
    };
  const re2 = /%25|%5C/gi;
  let cursor = 0;
  let result = "";
  let match;
  while (null !== (match = re2.exec(path))) {
    result += decodeSegment(path.slice(cursor, match.index)) + match[0];
    cursor = re2.lastIndex;
  }
  result = result + decodeSegment(cursor ? path.slice(cursor) : path);
  let handledProtocolRelativeURL = false;
  if (result.startsWith("//")) {
    handledProtocolRelativeURL = true;
    result = "/" + result.replace(/^\/+/, "");
  }
  return {
    path: result,
    handledProtocolRelativeURL,
  };
}
function encodePathLikeUrl(path) {
  if (!/\s|[^\u0000-\u007F]/.test(path)) return path;
  return path.replace(/\s|[^\u0000-\u007F]/gu, encodeURIComponent);
}
function arraysEqual(a, b2) {
  if (a === b2) return true;
  if (a.length !== b2.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b2[i]) return false;
  return true;
}
function invariant() {
  throw new Error("Invariant failed");
}
function createLRUCache(max) {
  const cache = /* @__PURE__ */ new Map();
  let oldest;
  let newest;
  const touch = (entry) => {
    if (!entry.next) return;
    if (!entry.prev) {
      entry.next.prev = void 0;
      oldest = entry.next;
      entry.next = void 0;
      if (newest) {
        entry.prev = newest;
        newest.next = entry;
      }
    } else {
      entry.prev.next = entry.next;
      entry.next.prev = entry.prev;
      entry.next = void 0;
      if (newest) {
        newest.next = entry;
        entry.prev = newest;
      }
    }
    newest = entry;
  };
  return {
    get(key) {
      const entry = cache.get(key);
      if (!entry) return void 0;
      touch(entry);
      return entry.value;
    },
    set(key, value) {
      if (cache.size >= max && oldest) {
        const toDelete = oldest;
        cache.delete(toDelete.key);
        if (toDelete.next) {
          oldest = toDelete.next;
          toDelete.next.prev = void 0;
        }
        if (toDelete === newest) newest = void 0;
      }
      const existing = cache.get(key);
      if (existing) {
        existing.value = value;
        touch(existing);
      } else {
        const entry = {
          key,
          value,
          prev: newest,
        };
        if (newest) newest.next = entry;
        newest = entry;
        if (!oldest) oldest = entry;
        cache.set(key, entry);
      }
    },
    clear() {
      cache.clear();
      oldest = void 0;
      newest = void 0;
    },
  };
}
var SEGMENT_TYPE_INDEX = 4;
var SEGMENT_TYPE_PATHLESS = 5;
function getOpenAndCloseBraces(part) {
  const openBrace = part.indexOf("{");
  if (openBrace === -1) return null;
  const closeBrace = part.indexOf("}", openBrace);
  if (closeBrace === -1) return null;
  if (openBrace + 1 >= part.length) return null;
  return [openBrace, closeBrace];
}
function parseSegment(path, start, output = new Uint16Array(6)) {
  const next = path.indexOf("/", start);
  const end = next === -1 ? path.length : next;
  const part = path.substring(start, end);
  if (!part || !part.includes("$")) {
    output[0] = 0;
    output[1] = start;
    output[2] = start;
    output[3] = end;
    output[4] = end;
    output[5] = end;
    return output;
  }
  if (part === "$") {
    const total = path.length;
    output[0] = 2;
    output[1] = start;
    output[2] = start;
    output[3] = total;
    output[4] = total;
    output[5] = total;
    return output;
  }
  if (part.charCodeAt(0) === 36) {
    output[0] = 1;
    output[1] = start;
    output[2] = start + 1;
    output[3] = end;
    output[4] = end;
    output[5] = end;
    return output;
  }
  const braces = getOpenAndCloseBraces(part);
  if (braces) {
    const [openBrace, closeBrace] = braces;
    const firstChar = part.charCodeAt(openBrace + 1);
    if (firstChar === 45) {
      if (openBrace + 2 < part.length && part.charCodeAt(openBrace + 2) === 36) {
        const paramStart = openBrace + 3;
        const paramEnd = closeBrace;
        if (paramStart < paramEnd) {
          output[0] = 3;
          output[1] = start + openBrace;
          output[2] = start + paramStart;
          output[3] = start + paramEnd;
          output[4] = start + closeBrace + 1;
          output[5] = end;
          return output;
        }
      }
    } else if (firstChar === 36) {
      const dollarPos = openBrace + 1;
      const afterDollar = openBrace + 2;
      if (afterDollar === closeBrace) {
        output[0] = 2;
        output[1] = start + openBrace;
        output[2] = start + dollarPos;
        output[3] = start + afterDollar;
        output[4] = start + closeBrace + 1;
        output[5] = path.length;
        return output;
      }
      output[0] = 1;
      output[1] = start + openBrace;
      output[2] = start + afterDollar;
      output[3] = start + closeBrace;
      output[4] = start + closeBrace + 1;
      output[5] = end;
      return output;
    }
  }
  output[0] = 0;
  output[1] = start;
  output[2] = start;
  output[3] = end;
  output[4] = end;
  output[5] = end;
  return output;
}
function parseSegments(defaultCaseSensitive, data, route, start, node, depth, onRoute) {
  onRoute?.(route);
  let cursor = start;
  {
    const path = route.fullPath ?? route.from;
    const length = path.length;
    const caseSensitive = route.options?.caseSensitive ?? defaultCaseSensitive;
    const skipOnParamError = !!(
      route.options?.params?.parse && route.options?.skipRouteOnParseError?.params
    );
    while (cursor < length) {
      const segment = parseSegment(path, cursor, data);
      let nextNode;
      const start2 = cursor;
      const end = segment[5];
      cursor = end + 1;
      depth++;
      switch (segment[0]) {
        case 0: {
          const value = path.substring(segment[2], segment[3]);
          if (caseSensitive) {
            const existingNode = node.static?.get(value);
            if (existingNode) nextNode = existingNode;
            else {
              node.static ??= /* @__PURE__ */ new Map();
              const next = createStaticNode(route.fullPath ?? route.from);
              next.parent = node;
              next.depth = depth;
              nextNode = next;
              node.static.set(value, next);
            }
          } else {
            const name = value.toLowerCase();
            const existingNode = node.staticInsensitive?.get(name);
            if (existingNode) nextNode = existingNode;
            else {
              node.staticInsensitive ??= /* @__PURE__ */ new Map();
              const next = createStaticNode(route.fullPath ?? route.from);
              next.parent = node;
              next.depth = depth;
              nextNode = next;
              node.staticInsensitive.set(name, next);
            }
          }
          break;
        }
        case 1: {
          const prefix_raw = path.substring(start2, segment[1]);
          const suffix_raw = path.substring(segment[4], end);
          const actuallyCaseSensitive = caseSensitive && !!(prefix_raw || suffix_raw);
          const prefix = !prefix_raw
            ? void 0
            : actuallyCaseSensitive
              ? prefix_raw
              : prefix_raw.toLowerCase();
          const suffix = !suffix_raw
            ? void 0
            : actuallyCaseSensitive
              ? suffix_raw
              : suffix_raw.toLowerCase();
          const existingNode =
            !skipOnParamError &&
            node.dynamic?.find(
              (s) =>
                !s.skipOnParamError &&
                s.caseSensitive === actuallyCaseSensitive &&
                s.prefix === prefix &&
                s.suffix === suffix,
            );
          if (existingNode) nextNode = existingNode;
          else {
            const next = createDynamicNode(
              1,
              route.fullPath ?? route.from,
              actuallyCaseSensitive,
              prefix,
              suffix,
            );
            nextNode = next;
            next.depth = depth;
            next.parent = node;
            node.dynamic ??= [];
            node.dynamic.push(next);
          }
          break;
        }
        case 3: {
          const prefix_raw = path.substring(start2, segment[1]);
          const suffix_raw = path.substring(segment[4], end);
          const actuallyCaseSensitive = caseSensitive && !!(prefix_raw || suffix_raw);
          const prefix = !prefix_raw
            ? void 0
            : actuallyCaseSensitive
              ? prefix_raw
              : prefix_raw.toLowerCase();
          const suffix = !suffix_raw
            ? void 0
            : actuallyCaseSensitive
              ? suffix_raw
              : suffix_raw.toLowerCase();
          const existingNode =
            !skipOnParamError &&
            node.optional?.find(
              (s) =>
                !s.skipOnParamError &&
                s.caseSensitive === actuallyCaseSensitive &&
                s.prefix === prefix &&
                s.suffix === suffix,
            );
          if (existingNode) nextNode = existingNode;
          else {
            const next = createDynamicNode(
              3,
              route.fullPath ?? route.from,
              actuallyCaseSensitive,
              prefix,
              suffix,
            );
            nextNode = next;
            next.parent = node;
            next.depth = depth;
            node.optional ??= [];
            node.optional.push(next);
          }
          break;
        }
        case 2: {
          const prefix_raw = path.substring(start2, segment[1]);
          const suffix_raw = path.substring(segment[4], end);
          const actuallyCaseSensitive = caseSensitive && !!(prefix_raw || suffix_raw);
          const prefix = !prefix_raw
            ? void 0
            : actuallyCaseSensitive
              ? prefix_raw
              : prefix_raw.toLowerCase();
          const suffix = !suffix_raw
            ? void 0
            : actuallyCaseSensitive
              ? suffix_raw
              : suffix_raw.toLowerCase();
          const next = createDynamicNode(
            2,
            route.fullPath ?? route.from,
            actuallyCaseSensitive,
            prefix,
            suffix,
          );
          nextNode = next;
          next.parent = node;
          next.depth = depth;
          node.wildcard ??= [];
          node.wildcard.push(next);
        }
      }
      node = nextNode;
    }
    if (
      skipOnParamError &&
      route.children &&
      !route.isRoot &&
      route.id &&
      route.id.charCodeAt(route.id.lastIndexOf("/") + 1) === 95
    ) {
      const pathlessNode = createStaticNode(route.fullPath ?? route.from);
      pathlessNode.kind = SEGMENT_TYPE_PATHLESS;
      pathlessNode.parent = node;
      depth++;
      pathlessNode.depth = depth;
      node.pathless ??= [];
      node.pathless.push(pathlessNode);
      node = pathlessNode;
    }
    const isLeaf = (route.path || !route.children) && !route.isRoot;
    if (isLeaf && path.endsWith("/")) {
      const indexNode = createStaticNode(route.fullPath ?? route.from);
      indexNode.kind = SEGMENT_TYPE_INDEX;
      indexNode.parent = node;
      depth++;
      indexNode.depth = depth;
      node.index = indexNode;
      node = indexNode;
    }
    node.parse = route.options?.params?.parse ?? null;
    node.skipOnParamError = skipOnParamError;
    node.parsingPriority = route.options?.skipRouteOnParseError?.priority ?? 0;
    if (isLeaf && !node.route) {
      node.route = route;
      node.fullPath = route.fullPath ?? route.from;
    }
  }
  if (route.children)
    for (const child of route.children)
      parseSegments(defaultCaseSensitive, data, child, cursor, node, depth, onRoute);
}
function sortDynamic(a, b2) {
  if (a.skipOnParamError && !b2.skipOnParamError) return -1;
  if (!a.skipOnParamError && b2.skipOnParamError) return 1;
  if (a.skipOnParamError && b2.skipOnParamError && (a.parsingPriority || b2.parsingPriority))
    return b2.parsingPriority - a.parsingPriority;
  if (a.prefix && b2.prefix && a.prefix !== b2.prefix) {
    if (a.prefix.startsWith(b2.prefix)) return -1;
    if (b2.prefix.startsWith(a.prefix)) return 1;
  }
  if (a.suffix && b2.suffix && a.suffix !== b2.suffix) {
    if (a.suffix.endsWith(b2.suffix)) return -1;
    if (b2.suffix.endsWith(a.suffix)) return 1;
  }
  if (a.prefix && !b2.prefix) return -1;
  if (!a.prefix && b2.prefix) return 1;
  if (a.suffix && !b2.suffix) return -1;
  if (!a.suffix && b2.suffix) return 1;
  if (a.caseSensitive && !b2.caseSensitive) return -1;
  if (!a.caseSensitive && b2.caseSensitive) return 1;
  return 0;
}
function sortTreeNodes(node) {
  if (node.pathless) for (const child of node.pathless) sortTreeNodes(child);
  if (node.static) for (const child of node.static.values()) sortTreeNodes(child);
  if (node.staticInsensitive)
    for (const child of node.staticInsensitive.values()) sortTreeNodes(child);
  if (node.dynamic?.length) {
    node.dynamic.sort(sortDynamic);
    for (const child of node.dynamic) sortTreeNodes(child);
  }
  if (node.optional?.length) {
    node.optional.sort(sortDynamic);
    for (const child of node.optional) sortTreeNodes(child);
  }
  if (node.wildcard?.length) {
    node.wildcard.sort(sortDynamic);
    for (const child of node.wildcard) sortTreeNodes(child);
  }
}
function createStaticNode(fullPath) {
  return {
    kind: 0,
    depth: 0,
    pathless: null,
    index: null,
    static: null,
    staticInsensitive: null,
    dynamic: null,
    optional: null,
    wildcard: null,
    route: null,
    fullPath,
    parent: null,
    parse: null,
    skipOnParamError: false,
    parsingPriority: 0,
  };
}
function createDynamicNode(kind, fullPath, caseSensitive, prefix, suffix) {
  return {
    kind,
    depth: 0,
    pathless: null,
    index: null,
    static: null,
    staticInsensitive: null,
    dynamic: null,
    optional: null,
    wildcard: null,
    route: null,
    fullPath,
    parent: null,
    parse: null,
    skipOnParamError: false,
    parsingPriority: 0,
    caseSensitive,
    prefix,
    suffix,
  };
}
function processRouteMasks(routeList, processedTree) {
  const segmentTree = createStaticNode("/");
  const data = new Uint16Array(6);
  for (const route of routeList) parseSegments(false, data, route, 1, segmentTree, 0);
  sortTreeNodes(segmentTree);
  processedTree.masksTree = segmentTree;
  processedTree.flatCache = createLRUCache(1e3);
}
function findFlatMatch(path, processedTree) {
  path ||= "/";
  const cached = processedTree.flatCache.get(path);
  if (cached) return cached;
  const result = findMatch(path, processedTree.masksTree);
  processedTree.flatCache.set(path, result);
  return result;
}
function findSingleMatch(from, caseSensitive, fuzzy, path, processedTree) {
  from ||= "/";
  path ||= "/";
  const key = caseSensitive ? `case\0${from}` : from;
  let tree = processedTree.singleCache.get(key);
  if (!tree) {
    tree = createStaticNode("/");
    parseSegments(caseSensitive, new Uint16Array(6), { from }, 1, tree, 0);
    processedTree.singleCache.set(key, tree);
  }
  return findMatch(path, tree, fuzzy);
}
function findRouteMatch(path, processedTree, fuzzy = false) {
  const key = fuzzy ? path : `nofuzz\0${path}`;
  const cached = processedTree.matchCache.get(key);
  if (cached !== void 0) return cached;
  path ||= "/";
  let result;
  try {
    result = findMatch(path, processedTree.segmentTree, fuzzy);
  } catch (err) {
    if (err instanceof URIError) result = null;
    else throw err;
  }
  if (result) result.branch = buildRouteBranch(result.route);
  processedTree.matchCache.set(key, result);
  return result;
}
function trimPathRight$1(path) {
  return path === "/" ? path : path.replace(/\/{1,}$/, "");
}
function processRouteTree(routeTree, caseSensitive = false, initRoute) {
  const segmentTree = createStaticNode(routeTree.fullPath);
  const data = new Uint16Array(6);
  const routesById = {};
  const routesByPath = {};
  let index = 0;
  parseSegments(caseSensitive, data, routeTree, 1, segmentTree, 0, (route) => {
    initRoute?.(route, index);
    if (route.id in routesById) {
      invariant();
    }
    routesById[route.id] = route;
    if (index !== 0 && route.path) {
      const trimmedFullPath = trimPathRight$1(route.fullPath);
      if (!routesByPath[trimmedFullPath] || route.fullPath.endsWith("/"))
        routesByPath[trimmedFullPath] = route;
    }
    index++;
  });
  sortTreeNodes(segmentTree);
  return {
    processedTree: {
      segmentTree,
      singleCache: createLRUCache(1e3),
      matchCache: createLRUCache(1e3),
      flatCache: null,
      masksTree: null,
    },
    routesById,
    routesByPath,
  };
}
function findMatch(path, segmentTree, fuzzy = false) {
  const parts = path.split("/");
  const leaf = getNodeMatch(path, parts, segmentTree, fuzzy);
  if (!leaf) return null;
  const [rawParams] = extractParams(path, parts, leaf);
  return {
    route: leaf.node.route,
    rawParams,
    parsedParams: leaf.parsedParams,
  };
}
function extractParams(path, parts, leaf) {
  const list = buildBranch(leaf.node);
  let nodeParts = null;
  const rawParams = /* @__PURE__ */ Object.create(null);
  let partIndex = leaf.extract?.part ?? 0;
  let nodeIndex = leaf.extract?.node ?? 0;
  let pathIndex = leaf.extract?.path ?? 0;
  let segmentCount = leaf.extract?.segment ?? 0;
  for (; nodeIndex < list.length; partIndex++, nodeIndex++, pathIndex++, segmentCount++) {
    const node = list[nodeIndex];
    if (node.kind === SEGMENT_TYPE_INDEX) break;
    if (node.kind === SEGMENT_TYPE_PATHLESS) {
      segmentCount--;
      partIndex--;
      pathIndex--;
      continue;
    }
    const part = parts[partIndex];
    const currentPathIndex = pathIndex;
    if (part) pathIndex += part.length;
    if (node.kind === 1) {
      nodeParts ??= leaf.node.fullPath.split("/");
      const nodePart = nodeParts[segmentCount];
      const preLength = node.prefix?.length ?? 0;
      if (nodePart.charCodeAt(preLength) === 123) {
        const sufLength = node.suffix?.length ?? 0;
        const name = nodePart.substring(preLength + 2, nodePart.length - sufLength - 1);
        const value = part.substring(preLength, part.length - sufLength);
        rawParams[name] = decodeURIComponent(value);
      } else {
        const name = nodePart.substring(1);
        rawParams[name] = decodeURIComponent(part);
      }
    } else if (node.kind === 3) {
      if (leaf.skipped & (1 << nodeIndex)) {
        partIndex--;
        pathIndex = currentPathIndex - 1;
        continue;
      }
      nodeParts ??= leaf.node.fullPath.split("/");
      const nodePart = nodeParts[segmentCount];
      const preLength = node.prefix?.length ?? 0;
      const sufLength = node.suffix?.length ?? 0;
      const name = nodePart.substring(preLength + 3, nodePart.length - sufLength - 1);
      const value =
        node.suffix || node.prefix ? part.substring(preLength, part.length - sufLength) : part;
      if (value) rawParams[name] = decodeURIComponent(value);
    } else if (node.kind === 2) {
      const n2 = node;
      const value = path.substring(
        currentPathIndex + (n2.prefix?.length ?? 0),
        path.length - (n2.suffix?.length ?? 0),
      );
      const splat = decodeURIComponent(value);
      rawParams["*"] = splat;
      rawParams._splat = splat;
      break;
    }
  }
  if (leaf.rawParams) Object.assign(rawParams, leaf.rawParams);
  return [
    rawParams,
    {
      part: partIndex,
      node: nodeIndex,
      path: pathIndex,
      segment: segmentCount,
    },
  ];
}
function buildRouteBranch(route) {
  const list = [route];
  while (route.parentRoute) {
    route = route.parentRoute;
    list.push(route);
  }
  list.reverse();
  return list;
}
function buildBranch(node) {
  const list = Array(node.depth + 1);
  do {
    list[node.depth] = node;
    node = node.parent;
  } while (node);
  return list;
}
function getNodeMatch(path, parts, segmentTree, fuzzy) {
  if (path === "/" && segmentTree.index)
    return {
      node: segmentTree.index,
      skipped: 0,
    };
  const trailingSlash = !last(parts);
  const pathIsIndex = trailingSlash && path !== "/";
  const partsLength = parts.length - (trailingSlash ? 1 : 0);
  const stack = [
    {
      node: segmentTree,
      index: 1,
      skipped: 0,
      depth: 1,
      statics: 1,
      dynamics: 0,
      optionals: 0,
    },
  ];
  let wildcardMatch = null;
  let bestFuzzy = null;
  let bestMatch = null;
  while (stack.length) {
    const frame = stack.pop();
    const { node, index, skipped, depth, statics, dynamics, optionals } = frame;
    let { extract, rawParams, parsedParams } = frame;
    if (node.skipOnParamError) {
      if (!validateMatchParams(path, parts, frame)) continue;
      rawParams = frame.rawParams;
      extract = frame.extract;
      parsedParams = frame.parsedParams;
    }
    if (
      fuzzy &&
      node.route &&
      node.kind !== SEGMENT_TYPE_INDEX &&
      isFrameMoreSpecific(bestFuzzy, frame)
    )
      bestFuzzy = frame;
    const isBeyondPath = index === partsLength;
    if (isBeyondPath) {
      if (node.route && !pathIsIndex && isFrameMoreSpecific(bestMatch, frame)) bestMatch = frame;
      if (!node.optional && !node.wildcard && !node.index && !node.pathless) continue;
    }
    const part = isBeyondPath ? void 0 : parts[index];
    let lowerPart;
    if (isBeyondPath && node.index) {
      const indexFrame = {
        node: node.index,
        index,
        skipped,
        depth: depth + 1,
        statics,
        dynamics,
        optionals,
        extract,
        rawParams,
        parsedParams,
      };
      let indexValid = true;
      if (node.index.skipOnParamError) {
        if (!validateMatchParams(path, parts, indexFrame)) indexValid = false;
      }
      if (indexValid) {
        if (statics === partsLength && !dynamics && !optionals && !skipped) return indexFrame;
        if (isFrameMoreSpecific(bestMatch, indexFrame)) bestMatch = indexFrame;
      }
    }
    if (node.wildcard && isFrameMoreSpecific(wildcardMatch, frame))
      for (const segment of node.wildcard) {
        const { prefix, suffix } = segment;
        if (prefix) {
          if (isBeyondPath) continue;
          if (
            !(segment.caseSensitive ? part : (lowerPart ??= part.toLowerCase())).startsWith(prefix)
          )
            continue;
        }
        if (suffix) {
          if (isBeyondPath) continue;
          const end = parts.slice(index).join("/").slice(-suffix.length);
          if ((segment.caseSensitive ? end : end.toLowerCase()) !== suffix) continue;
        }
        const frame2 = {
          node: segment,
          index: partsLength,
          skipped,
          depth,
          statics,
          dynamics,
          optionals,
          extract,
          rawParams,
          parsedParams,
        };
        if (segment.skipOnParamError) {
          if (!validateMatchParams(path, parts, frame2)) continue;
        }
        wildcardMatch = frame2;
        break;
      }
    if (node.optional) {
      const nextSkipped = skipped | (1 << depth);
      const nextDepth = depth + 1;
      for (let i = node.optional.length - 1; i >= 0; i--) {
        const segment = node.optional[i];
        stack.push({
          node: segment,
          index,
          skipped: nextSkipped,
          depth: nextDepth,
          statics,
          dynamics,
          optionals,
          extract,
          rawParams,
          parsedParams,
        });
      }
      if (!isBeyondPath)
        for (let i = node.optional.length - 1; i >= 0; i--) {
          const segment = node.optional[i];
          const { prefix, suffix } = segment;
          if (prefix || suffix) {
            const casePart = segment.caseSensitive ? part : (lowerPart ??= part.toLowerCase());
            if (prefix && !casePart.startsWith(prefix)) continue;
            if (suffix && !casePart.endsWith(suffix)) continue;
          }
          stack.push({
            node: segment,
            index: index + 1,
            skipped,
            depth: nextDepth,
            statics,
            dynamics,
            optionals: optionals + 1,
            extract,
            rawParams,
            parsedParams,
          });
        }
    }
    if (!isBeyondPath && node.dynamic && part)
      for (let i = node.dynamic.length - 1; i >= 0; i--) {
        const segment = node.dynamic[i];
        const { prefix, suffix } = segment;
        if (prefix || suffix) {
          const casePart = segment.caseSensitive ? part : (lowerPart ??= part.toLowerCase());
          if (prefix && !casePart.startsWith(prefix)) continue;
          if (suffix && !casePart.endsWith(suffix)) continue;
        }
        stack.push({
          node: segment,
          index: index + 1,
          skipped,
          depth: depth + 1,
          statics,
          dynamics: dynamics + 1,
          optionals,
          extract,
          rawParams,
          parsedParams,
        });
      }
    if (!isBeyondPath && node.staticInsensitive) {
      const match = node.staticInsensitive.get((lowerPart ??= part.toLowerCase()));
      if (match)
        stack.push({
          node: match,
          index: index + 1,
          skipped,
          depth: depth + 1,
          statics: statics + 1,
          dynamics,
          optionals,
          extract,
          rawParams,
          parsedParams,
        });
    }
    if (!isBeyondPath && node.static) {
      const match = node.static.get(part);
      if (match)
        stack.push({
          node: match,
          index: index + 1,
          skipped,
          depth: depth + 1,
          statics: statics + 1,
          dynamics,
          optionals,
          extract,
          rawParams,
          parsedParams,
        });
    }
    if (node.pathless) {
      const nextDepth = depth + 1;
      for (let i = node.pathless.length - 1; i >= 0; i--) {
        const segment = node.pathless[i];
        stack.push({
          node: segment,
          index,
          skipped,
          depth: nextDepth,
          statics,
          dynamics,
          optionals,
          extract,
          rawParams,
          parsedParams,
        });
      }
    }
  }
  if (bestMatch && wildcardMatch)
    return isFrameMoreSpecific(wildcardMatch, bestMatch) ? bestMatch : wildcardMatch;
  if (bestMatch) return bestMatch;
  if (wildcardMatch) return wildcardMatch;
  if (fuzzy && bestFuzzy) {
    let sliceIndex = bestFuzzy.index;
    for (let i = 0; i < bestFuzzy.index; i++) sliceIndex += parts[i].length;
    const splat = sliceIndex === path.length ? "/" : path.slice(sliceIndex);
    bestFuzzy.rawParams ??= /* @__PURE__ */ Object.create(null);
    bestFuzzy.rawParams["**"] = decodeURIComponent(splat);
    return bestFuzzy;
  }
  return null;
}
function validateMatchParams(path, parts, frame) {
  try {
    const [rawParams, state] = extractParams(path, parts, frame);
    frame.rawParams = rawParams;
    frame.extract = state;
    const parsed = frame.node.parse(rawParams);
    frame.parsedParams = Object.assign(
      /* @__PURE__ */ Object.create(null),
      frame.parsedParams,
      parsed,
    );
    return true;
  } catch {
    return null;
  }
}
function isFrameMoreSpecific(prev, next) {
  if (!prev) return true;
  return (
    next.statics > prev.statics ||
    (next.statics === prev.statics &&
      (next.dynamics > prev.dynamics ||
        (next.dynamics === prev.dynamics &&
          (next.optionals > prev.optionals ||
            (next.optionals === prev.optionals &&
              ((next.node.kind === SEGMENT_TYPE_INDEX) > (prev.node.kind === SEGMENT_TYPE_INDEX) ||
                ((next.node.kind === SEGMENT_TYPE_INDEX) ===
                  (prev.node.kind === SEGMENT_TYPE_INDEX) &&
                  next.depth > prev.depth)))))))
  );
}
function joinPaths(paths) {
  return cleanPath(
    paths
      .filter((val) => {
        return val !== void 0;
      })
      .join("/"),
  );
}
function cleanPath(path) {
  return path.replace(/\/{2,}/g, "/");
}
function trimPathLeft(path) {
  return path === "/" ? path : path.replace(/^\/{1,}/, "");
}
function trimPathRight(path) {
  const len = path.length;
  return len > 1 && path[len - 1] === "/" ? path.replace(/\/{1,}$/, "") : path;
}
function trimPath(path) {
  return trimPathRight(trimPathLeft(path));
}
function removeTrailingSlash(value, basepath) {
  if (value?.endsWith("/") && value !== "/" && value !== `${basepath}/`) return value.slice(0, -1);
  return value;
}
function exactPathTest(pathName1, pathName2, basepath) {
  return removeTrailingSlash(pathName1, basepath) === removeTrailingSlash(pathName2, basepath);
}
function resolvePath({ base, to: to2, trailingSlash = "never", cache }) {
  const isAbsolute = to2.startsWith("/");
  const isBase = !isAbsolute && to2 === ".";
  let key;
  if (cache) {
    key = isAbsolute ? to2 : isBase ? base : base + "\0" + to2;
    const cached = cache.get(key);
    if (cached) return cached;
  }
  let baseSegments;
  if (isBase) baseSegments = base.split("/");
  else if (isAbsolute) baseSegments = to2.split("/");
  else {
    baseSegments = base.split("/");
    while (baseSegments.length > 1 && last(baseSegments) === "") baseSegments.pop();
    const toSegments = to2.split("/");
    for (let index = 0, length = toSegments.length; index < length; index++) {
      const value = toSegments[index];
      if (value === "") {
        if (!index) baseSegments = [value];
        else if (index === length - 1) baseSegments.push(value);
      } else if (value === "..") baseSegments.pop();
      else if (value === ".");
      else baseSegments.push(value);
    }
  }
  if (baseSegments.length > 1) {
    if (last(baseSegments) === "") {
      if (trailingSlash === "never") baseSegments.pop();
    } else if (trailingSlash === "always") baseSegments.push("");
  }
  let segment;
  let joined = "";
  for (let i = 0; i < baseSegments.length; i++) {
    if (i > 0) joined += "/";
    const part = baseSegments[i];
    if (!part) continue;
    segment = parseSegment(part, 0, segment);
    const kind = segment[0];
    if (kind === 0) {
      joined += part;
      continue;
    }
    const end = segment[5];
    const prefix = part.substring(0, segment[1]);
    const suffix = part.substring(segment[4], end);
    const value = part.substring(segment[2], segment[3]);
    if (kind === 1) joined += prefix || suffix ? `${prefix}{$${value}}${suffix}` : `$${value}`;
    else if (kind === 2) joined += prefix || suffix ? `${prefix}{$}${suffix}` : "$";
    else joined += `${prefix}{-$${value}}${suffix}`;
  }
  joined = cleanPath(joined);
  const result = joined || "/";
  if (key && cache) cache.set(key, result);
  return result;
}
function compileDecodeCharMap(pathParamsAllowedCharacters) {
  const charMap = new Map(
    pathParamsAllowedCharacters.map((char) => [encodeURIComponent(char), char]),
  );
  const pattern2 = Array.from(charMap.keys())
    .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const regex = new RegExp(pattern2, "g");
  return (encoded) => encoded.replace(regex, (match) => charMap.get(match) ?? match);
}
function encodeParam(key, params, decoder) {
  const value = params[key];
  if (typeof value !== "string") return value;
  if (key === "_splat") {
    if (/^[a-zA-Z0-9\-._~!/]*$/.test(value)) return value;
    return value
      .split("/")
      .map((segment) => encodePathParam(segment, decoder))
      .join("/");
  } else return encodePathParam(value, decoder);
}
function interpolatePath({ path, params, decoder, ...rest }) {
  let isMissingParams = false;
  const usedParams = /* @__PURE__ */ Object.create(null);
  if (!path || path === "/")
    return {
      interpolatedPath: "/",
      usedParams,
      isMissingParams,
    };
  if (!path.includes("$"))
    return {
      interpolatedPath: path,
      usedParams,
      isMissingParams,
    };
  {
    if (path.indexOf("{") === -1) {
      const length2 = path.length;
      let cursor2 = 0;
      let joined2 = "";
      while (cursor2 < length2) {
        while (cursor2 < length2 && path.charCodeAt(cursor2) === 47) cursor2++;
        if (cursor2 >= length2) break;
        const start = cursor2;
        let end = path.indexOf("/", cursor2);
        if (end === -1) end = length2;
        cursor2 = end;
        const part = path.substring(start, end);
        if (!part) continue;
        if (part.charCodeAt(0) === 36)
          if (part.length === 1) {
            const splat = params._splat;
            usedParams._splat = splat;
            usedParams["*"] = splat;
            if (!splat) {
              isMissingParams = true;
              continue;
            }
            const value = encodeParam("_splat", params, decoder);
            joined2 += "/" + value;
          } else {
            const key = part.substring(1);
            if (!isMissingParams && !(key in params)) isMissingParams = true;
            usedParams[key] = params[key];
            const value = encodeParam(key, params, decoder) ?? "undefined";
            joined2 += "/" + value;
          }
        else joined2 += "/" + part;
      }
      if (path.endsWith("/")) joined2 += "/";
      return {
        usedParams,
        interpolatedPath: joined2 || "/",
        isMissingParams,
      };
    }
  }
  const length = path.length;
  let cursor = 0;
  let segment;
  let joined = "";
  while (cursor < length) {
    const start = cursor;
    segment = parseSegment(path, start, segment);
    const end = segment[5];
    cursor = end + 1;
    if (start === end) continue;
    const kind = segment[0];
    if (kind === 0) {
      joined += "/" + path.substring(start, end);
      continue;
    }
    if (kind === 2) {
      const splat = params._splat;
      usedParams._splat = splat;
      usedParams["*"] = splat;
      const prefix = path.substring(start, segment[1]);
      const suffix = path.substring(segment[4], end);
      if (!splat) {
        isMissingParams = true;
        if (prefix || suffix) joined += "/" + prefix + suffix;
        continue;
      }
      const value = encodeParam("_splat", params, decoder);
      joined += "/" + prefix + value + suffix;
      continue;
    }
    if (kind === 1) {
      const key = path.substring(segment[2], segment[3]);
      if (!isMissingParams && !(key in params)) isMissingParams = true;
      usedParams[key] = params[key];
      const prefix = path.substring(start, segment[1]);
      const suffix = path.substring(segment[4], end);
      const value = encodeParam(key, params, decoder) ?? "undefined";
      joined += "/" + prefix + value + suffix;
      continue;
    }
    if (kind === 3) {
      const key = path.substring(segment[2], segment[3]);
      const valueRaw = params[key];
      if (valueRaw == null) continue;
      usedParams[key] = valueRaw;
      const prefix = path.substring(start, segment[1]);
      const suffix = path.substring(segment[4], end);
      const value = encodeParam(key, params, decoder) ?? "";
      joined += "/" + prefix + value + suffix;
      continue;
    }
  }
  if (path.endsWith("/")) joined += "/";
  return {
    usedParams,
    interpolatedPath: joined || "/",
    isMissingParams,
  };
}
function encodePathParam(value, decoder) {
  const encoded = encodeURIComponent(value);
  return decoder?.(encoded) ?? encoded;
}
function isNotFound(obj) {
  return obj?.isNotFound === true;
}
var rootRouteId = "__root__";
function redirect(opts) {
  opts.statusCode = opts.statusCode || opts.code || 307;
  if (!opts._builtLocation && !opts.reloadDocument && typeof opts.href === "string")
    try {
      new URL(opts.href);
      opts.reloadDocument = true;
    } catch {}
  const headers = new Headers(opts.headers);
  if (opts.href && headers.get("Location") === null) headers.set("Location", opts.href);
  const response = new Response(null, {
    status: opts.statusCode,
    headers,
  });
  response.options = opts;
  if (opts.throw) throw response;
  return response;
}
function isRedirect(obj) {
  return obj instanceof Response && !!obj.options;
}
function isResolvedRedirect(obj) {
  return isRedirect(obj) && !!obj.options.href;
}
function parseRedirect(obj) {
  if (obj !== null && typeof obj === "object" && obj.isSerializedRedirect) return redirect(obj);
}
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
function executeRewriteInput(rewrite, url) {
  const res = rewrite?.input?.({ url });
  if (res) {
    if (typeof res === "string") return new URL(res);
    else if (res instanceof URL) return res;
  }
  return url;
}
function executeRewriteOutput(rewrite, url) {
  const res = rewrite?.output?.({ url });
  if (res) {
    if (typeof res === "string") return new URL(res);
    else if (res instanceof URL) return res;
  }
  return url;
}
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
        const blockers2 = opts.getBlockers?.() ?? [];
        opts.setBlockers?.(blockers2.filter((b2) => b2 !== blocker));
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
function createMemoryHistory(opts = { initialEntries: ["/"] }) {
  const entries = opts.initialEntries;
  let index = opts.initialIndex
    ? Math.min(Math.max(opts.initialIndex, 0), entries.length - 1)
    : entries.length - 1;
  const states = entries.map((_entry, index2) => assignKeyAndIndex(index2, void 0));
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
    go: (n2) => {
      index = Math.min(Math.max(index + n2, 0), entries.length - 1);
    },
    createHref: (path) => path,
    getBlockers: _getBlockers,
    setBlockers: _setBlockers,
  });
}
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
var GLOBAL_TSR = "$_TSR";
var TSR_SCRIPT_BARRIER_ID = "$tsr-stream-barrier";
var L = ((i) => (
  (i[(i.AggregateError = 1)] = "AggregateError"),
  (i[(i.ArrowFunction = 2)] = "ArrowFunction"),
  (i[(i.ErrorPrototypeStack = 4)] = "ErrorPrototypeStack"),
  (i[(i.ObjectAssign = 8)] = "ObjectAssign"),
  (i[(i.BigIntTypedArray = 16)] = "BigIntTypedArray"),
  (i[(i.RegExp = 32)] = "RegExp"),
  i
))(L || {});
var v = Symbol.asyncIterator,
  mr = Symbol.hasInstance,
  R = Symbol.isConcatSpreadable,
  C = Symbol.iterator,
  pr = Symbol.match,
  dr = Symbol.matchAll,
  gr = Symbol.replace,
  yr = Symbol.search,
  Nr = Symbol.species,
  br = Symbol.split,
  vr = Symbol.toPrimitive,
  P$1 = Symbol.toStringTag,
  Cr = Symbol.unscopables;
var rt = {
    0: "Symbol.asyncIterator",
    1: "Symbol.hasInstance",
    2: "Symbol.isConcatSpreadable",
    3: "Symbol.iterator",
    4: "Symbol.match",
    5: "Symbol.matchAll",
    6: "Symbol.replace",
    7: "Symbol.search",
    8: "Symbol.species",
    9: "Symbol.split",
    10: "Symbol.toPrimitive",
    11: "Symbol.toStringTag",
    12: "Symbol.unscopables",
  },
  ve = {
    [v]: 0,
    [mr]: 1,
    [R]: 2,
    [C]: 3,
    [pr]: 4,
    [dr]: 5,
    [gr]: 6,
    [yr]: 7,
    [Nr]: 8,
    [br]: 9,
    [vr]: 10,
    [P$1]: 11,
    [Cr]: 12,
  },
  tt = {
    0: v,
    1: mr,
    2: R,
    3: C,
    4: pr,
    5: dr,
    6: gr,
    7: yr,
    8: Nr,
    9: br,
    10: vr,
    11: P$1,
    12: Cr,
  },
  nt = { 2: "!0", 3: "!1", 1: "void 0", 0: "null", 4: "-0", 5: "1/0", 6: "-1/0", 7: "0/0" },
  o = void 0,
  ot = {
    2: true,
    3: false,
    1: o,
    0: null,
    4: -0,
    5: Number.POSITIVE_INFINITY,
    6: Number.NEGATIVE_INFINITY,
    7: Number.NaN,
  };
var Ce = {
    0: "Error",
    1: "EvalError",
    2: "RangeError",
    3: "ReferenceError",
    4: "SyntaxError",
    5: "TypeError",
    6: "URIError",
  },
  at = {
    0: Error,
    1: EvalError,
    2: RangeError,
    3: ReferenceError,
    4: SyntaxError,
    5: TypeError,
    6: URIError,
  };
function c(e, r, t, n2, a, s, i, u, l, g, S, d) {
  return { t: e, i: r, s: t, c: n2, m: a, p: s, e: i, a: u, f: l, b: g, o: S, l: d };
}
function B(e) {
  return c(2, o, e, o, o, o, o, o, o, o, o, o);
}
var J = B(2),
  Z = B(3),
  Ae = B(1),
  Ee = B(0),
  st = B(4),
  it = B(5),
  ut = B(6),
  lt = B(7);
function fn(e) {
  switch (e) {
    case '"':
      return '\\"';
    case "\\":
      return "\\\\";
    case `
`:
      return "\\n";
    case "\r":
      return "\\r";
    case "\b":
      return "\\b";
    case "	":
      return "\\t";
    case "\f":
      return "\\f";
    case "<":
      return "\\x3C";
    case "\u2028":
      return "\\u2028";
    case "\u2029":
      return "\\u2029";
    default:
      return o;
  }
}
function y(e) {
  let r = "",
    t = 0,
    n2;
  for (let a = 0, s = e.length; a < s; a++)
    ((n2 = fn(e[a])), n2 && ((r += e.slice(t, a) + n2), (t = a + 1)));
  return (t === 0 ? (r = e) : (r += e.slice(t)), r);
}
function Sn(e) {
  switch (e) {
    case "\\\\":
      return "\\";
    case '\\"':
      return '"';
    case "\\n":
      return `
`;
    case "\\r":
      return "\r";
    case "\\b":
      return "\b";
    case "\\t":
      return "	";
    case "\\f":
      return "\f";
    case "\\x3C":
      return "<";
    case "\\u2028":
      return "\u2028";
    case "\\u2029":
      return "\u2029";
    default:
      return e;
  }
}
function D(e) {
  return e.replace(/(\\\\|\\"|\\n|\\r|\\b|\\t|\\f|\\u2028|\\u2029|\\x3C)/g, Sn);
}
var U = "__SEROVAL_REFS__",
  ce = "$R",
  Ie = `self.${ce}`;
function mn(e) {
  return e == null ? `${Ie}=${Ie}||[]` : `(${Ie}=${Ie}||{})["${y(e)}"]=[]`;
}
var Ar = /* @__PURE__ */ new Map(),
  j = /* @__PURE__ */ new Map();
function Er(e) {
  return Ar.has(e);
}
function dn(e) {
  return j.has(e);
}
function ct(e) {
  if (Er(e)) return Ar.get(e);
  throw new Re(e);
}
function ft(e) {
  if (dn(e)) return j.get(e);
  throw new Pe(e);
}
typeof globalThis != "undefined"
  ? Object.defineProperty(globalThis, U, {
      value: j,
      configurable: true,
      writable: false,
      enumerable: false,
    })
  : typeof window != "undefined"
    ? Object.defineProperty(window, U, {
        value: j,
        configurable: true,
        writable: false,
        enumerable: false,
      })
    : typeof self != "undefined"
      ? Object.defineProperty(self, U, {
          value: j,
          configurable: true,
          writable: false,
          enumerable: false,
        })
      : typeof global != "undefined" &&
        Object.defineProperty(global, U, {
          value: j,
          configurable: true,
          writable: false,
          enumerable: false,
        });
function xe(e) {
  return e instanceof EvalError
    ? 1
    : e instanceof RangeError
      ? 2
      : e instanceof ReferenceError
        ? 3
        : e instanceof SyntaxError
          ? 4
          : e instanceof TypeError
            ? 5
            : e instanceof URIError
              ? 6
              : 0;
}
function gn(e) {
  let r = Ce[xe(e)];
  return e.name !== r
    ? { name: e.name }
    : e.constructor.name !== r
      ? { name: e.constructor.name }
      : {};
}
function $(e, r) {
  let t = gn(e),
    n2 = Object.getOwnPropertyNames(e);
  for (let a = 0, s = n2.length, i; a < s; a++)
    ((i = n2[a]),
      i !== "name" &&
        i !== "message" &&
        (i === "stack" ? r & 4 && ((t = t || {}), (t[i] = e[i])) : ((t = t || {}), (t[i] = e[i]))));
  return t;
}
function Oe(e) {
  return Object.isFrozen(e) ? 3 : Object.isSealed(e) ? 2 : Object.isExtensible(e) ? 0 : 1;
}
function Te(e) {
  switch (e) {
    case Number.POSITIVE_INFINITY:
      return it;
    case Number.NEGATIVE_INFINITY:
      return ut;
  }
  return e !== e ? lt : Object.is(e, -0) ? st : c(0, o, e, o, o, o, o, o, o, o, o, o);
}
function X(e) {
  return c(1, o, y(e), o, o, o, o, o, o, o, o, o);
}
function we(e) {
  return c(3, o, "" + e, o, o, o, o, o, o, o, o, o);
}
function mt(e) {
  return c(4, e, o, o, o, o, o, o, o, o, o, o);
}
function he(e, r) {
  let t = r.valueOf();
  return c(5, e, t !== t ? "" : r.toISOString(), o, o, o, o, o, o, o, o, o);
}
function ze(e, r) {
  return c(6, e, o, y(r.source), r.flags, o, o, o, o, o, o, o);
}
function pt(e, r) {
  return c(17, e, ve[r], o, o, o, o, o, o, o, o, o);
}
function dt(e, r) {
  return c(18, e, y(ct(r)), o, o, o, o, o, o, o, o, o);
}
function fe(e, r, t) {
  return c(25, e, t, y(r), o, o, o, o, o, o, o, o);
}
function _e(e, r, t) {
  return c(9, e, o, o, o, o, o, t, o, o, Oe(r), o);
}
function ke(e, r) {
  return c(21, e, o, o, o, o, o, o, r, o, o, o);
}
function De(e, r, t) {
  return c(15, e, o, r.constructor.name, o, o, o, o, t, r.byteOffset, o, r.length);
}
function Fe(e, r, t) {
  return c(16, e, o, r.constructor.name, o, o, o, o, t, r.byteOffset, o, r.byteLength);
}
function Be(e, r, t) {
  return c(20, e, o, o, o, o, o, o, t, r.byteOffset, o, r.byteLength);
}
function Ve(e, r, t) {
  return c(13, e, xe(r), o, y(r.message), t, o, o, o, o, o, o);
}
function Me(e, r, t) {
  return c(14, e, xe(r), o, y(r.message), t, o, o, o, o, o, o);
}
function Le(e, r) {
  return c(7, e, o, o, o, o, o, r, o, o, o, o);
}
function Ue(e, r) {
  return c(28, o, o, o, o, o, o, [e, r], o, o, o, o);
}
function je(e, r) {
  return c(30, o, o, o, o, o, o, [e, r], o, o, o, o);
}
function Ye(e, r, t) {
  return c(31, e, o, o, o, o, o, t, r, o, o, o);
}
function qe(e, r) {
  return c(32, e, o, o, o, o, o, o, r, o, o, o);
}
function We(e, r) {
  return c(33, e, o, o, o, o, o, o, r, o, o, o);
}
function Ge(e, r) {
  return c(34, e, o, o, o, o, o, o, r, o, o, o);
}
function Ke(e, r, t, n2) {
  return c(35, e, t, o, o, o, o, r, o, o, o, n2);
}
var yn = { parsing: 1, serialization: 2, deserialization: 3 };
function Nn(e) {
  return `Seroval Error (step: ${yn[e]})`;
}
var bn = (e, r) => Nn(e),
  Se = class extends Error {
    constructor(t, n2) {
      super(bn(t));
      this.cause = n2;
    }
  },
  z = class extends Se {
    constructor(r) {
      super("parsing", r);
    }
  },
  He = class extends Se {
    constructor(r) {
      super("deserialization", r);
    }
  };
function _(e) {
  return `Seroval Error (specific: ${e})`;
}
var x$1 = class x extends Error {
    constructor(t) {
      super(_(1));
      this.value = t;
    }
  },
  w$1 = class w extends Error {
    constructor(r) {
      super(_(2));
    }
  },
  Q = class extends Error {
    constructor(r) {
      super(_(3));
    }
  },
  V = class extends Error {
    constructor(r) {
      super(_(4));
    }
  },
  Re = class extends Error {
    constructor(t) {
      super(_(5));
      this.value = t;
    }
  },
  Pe = class extends Error {
    constructor(r) {
      super(_(6));
    }
  },
  Je = class extends Error {
    constructor(r) {
      super(_(7));
    }
  },
  h = class extends Error {
    constructor(r) {
      super(_(8));
    }
  },
  ee$1 = class ee extends Error {
    constructor(r) {
      super(_(9));
    }
  };
var Y = class {
  constructor(r, t) {
    this.value = r;
    this.replacement = t;
  }
};
var re = () => {
    let e = { p: 0, s: 0, f: 0 };
    return (
      (e.p = new Promise((r, t) => {
        ((e.s = r), (e.f = t));
      })),
      e
    );
  },
  vn = (e, r) => {
    (e.s(r), (e.p.s = 1), (e.p.v = r));
  },
  Cn = (e, r) => {
    (e.f(r), (e.p.s = 2), (e.p.v = r));
  },
  yt = re.toString(),
  Nt = vn.toString(),
  bt = Cn.toString(),
  Rr = () => {
    let e = [],
      r = [],
      t = true,
      n2 = false,
      a = 0,
      s = (l, g, S) => {
        for (S = 0; S < a; S++) r[S] && r[S][g](l);
      },
      i = (l, g, S, d) => {
        for (g = 0, S = e.length; g < S; g++)
          ((d = e[g]), !t && g === S - 1 ? l[n2 ? "return" : "throw"](d) : l.next(d));
      },
      u = (l, g) => (
        t && ((g = a++), (r[g] = l)),
        i(l),
        () => {
          t && ((r[g] = r[a]), (r[a--] = void 0));
        }
      );
    return {
      __SEROVAL_STREAM__: true,
      on: (l) => u(l),
      next: (l) => {
        t && (e.push(l), s(l, "next"));
      },
      throw: (l) => {
        t && (e.push(l), s(l, "throw"), (t = false), (n2 = false), (r.length = 0));
      },
      return: (l) => {
        t && (e.push(l), s(l, "return"), (t = false), (n2 = true), (r.length = 0));
      },
    };
  },
  vt = Rr.toString(),
  Pr = (e) => (r) => () => {
    let t = 0,
      n2 = {
        [e]: () => n2,
        next: () => {
          if (t > r.d) return { done: true, value: void 0 };
          let a = t++,
            s = r.v[a];
          if (a === r.t) throw s;
          return { done: a === r.d, value: s };
        },
      };
    return n2;
  },
  Ct = Pr.toString(),
  xr = (e, r) => (t) => () => {
    let n2 = 0,
      a = -1,
      s = false,
      i = [],
      u = [],
      l = (S = 0, d = u.length) => {
        for (; S < d; S++) u[S].s({ done: true, value: void 0 });
      };
    t.on({
      next: (S) => {
        let d = u.shift();
        (d && d.s({ done: false, value: S }), i.push(S));
      },
      throw: (S) => {
        let d = u.shift();
        (d && d.f(S), l(), (a = i.length), (s = true), i.push(S));
      },
      return: (S) => {
        let d = u.shift();
        (d && d.s({ done: true, value: S }), l(), (a = i.length), i.push(S));
      },
    });
    let g = {
      [e]: () => g,
      next: () => {
        if (a === -1) {
          let K = n2++;
          if (K >= i.length) {
            let et = r();
            return (u.push(et), et.p);
          }
          return { done: false, value: i[K] };
        }
        if (n2 > a) return { done: true, value: void 0 };
        let S = n2++,
          d = i[S];
        if (S !== a) return { done: false, value: d };
        if (s) throw d;
        return { done: true, value: d };
      },
    };
    return g;
  },
  At = xr.toString(),
  Or = (e) => {
    let r = atob(e),
      t = r.length,
      n2 = new Uint8Array(t);
    for (let a = 0; a < t; a++) n2[a] = r.charCodeAt(a);
    return n2.buffer;
  },
  Et = Or.toString();
function Ze(e) {
  return "__SEROVAL_SEQUENCE__" in e;
}
function Tr(e, r, t) {
  return { __SEROVAL_SEQUENCE__: true, v: e, t: r, d: t };
}
function $e(e) {
  let r = [],
    t = -1,
    n2 = -1,
    a = e[C]();
  for (;;)
    try {
      let s = a.next();
      if ((r.push(s.value), s.done)) {
        n2 = r.length - 1;
        break;
      }
    } catch (s) {
      ((t = r.length), r.push(s));
    }
  return Tr(r, t, n2);
}
var An = Pr(C);
function It(e) {
  return An(e);
}
var Rt = {},
  Pt = {};
var xt = { 0: {}, 1: {}, 2: {}, 3: {}, 4: {}, 5: {} },
  Ot = { 0: "[]", 1: yt, 2: Nt, 3: bt, 4: vt, 5: Et };
function M(e) {
  return "__SEROVAL_STREAM__" in e;
}
function te() {
  return Rr();
}
function Xe(e) {
  let r = te(),
    t = e[v]();
  async function n2() {
    try {
      let a = await t.next();
      a.done ? r.return(a.value) : (r.next(a.value), await n2());
    } catch (a) {
      r.throw(a);
    }
  }
  return (n2().catch(() => {}), r);
}
var En = xr(v, re);
function Tt(e) {
  return En(e);
}
async function wr(e) {
  try {
    return [1, await e];
  } catch (r) {
    return [0, r];
  }
}
function pe(e, r) {
  return {
    plugins: r.plugins,
    mode: e,
    marked: /* @__PURE__ */ new Set(),
    features: 63 ^ (r.disabledFeatures || 0),
    refs: r.refs || /* @__PURE__ */ new Map(),
    depthLimit: r.depthLimit || 1e3,
  };
}
function de(e, r) {
  e.marked.add(r);
}
function hr(e, r) {
  let t = e.refs.size;
  return (e.refs.set(r, t), t);
}
function Qe(e, r) {
  let t = e.refs.get(r);
  return t != null ? (de(e, t), { type: 1, value: mt(t) }) : { type: 0, value: hr(e, r) };
}
function q(e, r) {
  let t = Qe(e, r);
  return t.type === 1 ? t : Er(r) ? { type: 2, value: dt(t.value, r) } : t;
}
function I(e, r) {
  let t = q(e, r);
  if (t.type !== 0) return t.value;
  if (r in ve) return pt(t.value, r);
  throw new x$1(r);
}
function k(e, r) {
  let t = Qe(e, xt[r]);
  return t.type === 1 ? t.value : c(26, t.value, r, o, o, o, o, o, o, o, o, o);
}
function er(e) {
  let r = Qe(e, Rt);
  return r.type === 1 ? r.value : c(27, r.value, o, o, o, o, o, o, I(e, C), o, o, o);
}
function rr(e) {
  let r = Qe(e, Pt);
  return r.type === 1 ? r.value : c(29, r.value, o, o, o, o, o, [k(e, 1), I(e, v)], o, o, o, o);
}
function tr(e, r, t, n2) {
  return c(t ? 11 : 10, e, o, o, o, n2, o, o, o, o, Oe(r), o);
}
function nr(e, r, t, n2) {
  return c(8, r, o, o, o, o, { k: t, v: n2 }, o, k(e, 0), o, o, o);
}
function ht(e, r, t) {
  return c(22, r, t, o, o, o, o, o, k(e, 1), o, o, o);
}
function or(e, r, t) {
  let n2 = new Uint8Array(t),
    a = "";
  for (let s = 0, i = n2.length; s < i; s++) a += String.fromCharCode(n2[s]);
  return c(19, r, y(btoa(a)), o, o, o, o, o, k(e, 5), o, o, o);
}
function ne(e, r) {
  return { base: pe(e, r), child: void 0 };
}
var _r = class {
  constructor(r, t) {
    this._p = r;
    this.depth = t;
  }
  parse(r) {
    return N(this._p, this.depth, r);
  }
};
async function Rn(e, r, t) {
  let n2 = [];
  for (let a = 0, s = t.length; a < s; a++) a in t ? (n2[a] = await N(e, r, t[a])) : (n2[a] = 0);
  return n2;
}
async function Pn(e, r, t, n2) {
  return _e(t, n2, await Rn(e, r, n2));
}
async function kr(e, r, t) {
  let n2 = Object.entries(t),
    a = [],
    s = [];
  for (let i = 0, u = n2.length; i < u; i++) (a.push(y(n2[i][0])), s.push(await N(e, r, n2[i][1])));
  return (
    C in t && (a.push(I(e.base, C)), s.push(Ue(er(e.base), await N(e, r, $e(t))))),
    v in t && (a.push(I(e.base, v)), s.push(je(rr(e.base), await N(e, r, Xe(t))))),
    P$1 in t && (a.push(I(e.base, P$1)), s.push(X(t[P$1]))),
    R in t && (a.push(I(e.base, R)), s.push(t[R] ? J : Z)),
    { k: a, v: s }
  );
}
async function zr(e, r, t, n2, a) {
  return tr(t, n2, a, await kr(e, r, n2));
}
async function xn(e, r, t, n2) {
  return ke(t, await N(e, r, n2.valueOf()));
}
async function On(e, r, t, n2) {
  return De(t, n2, await N(e, r, n2.buffer));
}
async function Tn(e, r, t, n2) {
  return Fe(t, n2, await N(e, r, n2.buffer));
}
async function wn(e, r, t, n2) {
  return Be(t, n2, await N(e, r, n2.buffer));
}
async function zt(e, r, t, n2) {
  let a = $(n2, e.base.features);
  return Ve(t, n2, a ? await kr(e, r, a) : o);
}
async function hn(e, r, t, n2) {
  let a = $(n2, e.base.features);
  return Me(t, n2, a ? await kr(e, r, a) : o);
}
async function zn(e, r, t, n2) {
  let a = [],
    s = [];
  for (let [i, u] of n2.entries()) (a.push(await N(e, r, i)), s.push(await N(e, r, u)));
  return nr(e.base, t, a, s);
}
async function _n(e, r, t, n2) {
  let a = [];
  for (let s of n2.keys()) a.push(await N(e, r, s));
  return Le(t, a);
}
async function _t(e, r, t, n2) {
  let a = e.base.plugins;
  if (a)
    for (let s = 0, i = a.length; s < i; s++) {
      let u = a[s];
      if (u.parse.async && u.test(n2))
        return fe(t, u.tag, await u.parse.async(n2, new _r(e, r), { id: t }));
    }
  return o;
}
async function kn(e, r, t, n2) {
  let [a, s] = await wr(n2);
  return c(12, t, a, o, o, o, o, o, await N(e, r, s), o, o, o);
}
function Dn(e, r, t, n2, a) {
  let s = [],
    i = t.on({
      next: (u) => {
        (de(this.base, r),
          N(this, e, u).then(
            (l) => {
              s.push(qe(r, l));
            },
            (l) => {
              (a(l), i());
            },
          ));
      },
      throw: (u) => {
        (de(this.base, r),
          N(this, e, u).then(
            (l) => {
              (s.push(We(r, l)), n2(s), i());
            },
            (l) => {
              (a(l), i());
            },
          ));
      },
      return: (u) => {
        (de(this.base, r),
          N(this, e, u).then(
            (l) => {
              (s.push(Ge(r, l)), n2(s), i());
            },
            (l) => {
              (a(l), i());
            },
          ));
      },
    });
}
async function Fn(e, r, t, n2) {
  return Ye(t, k(e.base, 4), await new Promise(Dn.bind(e, r, t, n2)));
}
async function Bn(e, r, t, n2) {
  let a = [];
  for (let s = 0, i = n2.v.length; s < i; s++) a[s] = await N(e, r, n2.v[s]);
  return Ke(t, a, n2.t, n2.d);
}
async function Vn(e, r, t, n2) {
  if (Array.isArray(n2)) return Pn(e, r, t, n2);
  if (M(n2)) return Fn(e, r, t, n2);
  if (Ze(n2)) return Bn(e, r, t, n2);
  let a = n2.constructor;
  if (a === Y) return N(e, r, n2.replacement);
  let s = await _t(e, r, t, n2);
  if (s) return s;
  switch (a) {
    case Object:
      return zr(e, r, t, n2, false);
    case o:
      return zr(e, r, t, n2, true);
    case Date:
      return he(t, n2);
    case Error:
    case EvalError:
    case RangeError:
    case ReferenceError:
    case SyntaxError:
    case TypeError:
    case URIError:
      return zt(e, r, t, n2);
    case Number:
    case Boolean:
    case String:
    case BigInt:
      return xn(e, r, t, n2);
    case ArrayBuffer:
      return or(e.base, t, n2);
    case Int8Array:
    case Int16Array:
    case Int32Array:
    case Uint8Array:
    case Uint16Array:
    case Uint32Array:
    case Uint8ClampedArray:
    case Float32Array:
    case Float64Array:
      return On(e, r, t, n2);
    case DataView:
      return wn(e, r, t, n2);
    case Map:
      return zn(e, r, t, n2);
    case Set:
      return _n(e, r, t, n2);
  }
  if (a === Promise || n2 instanceof Promise) return kn(e, r, t, n2);
  let i = e.base.features;
  if (i & 32 && a === RegExp) return ze(t, n2);
  if (i & 16)
    switch (a) {
      case BigInt64Array:
      case BigUint64Array:
        return Tn(e, r, t, n2);
    }
  if (
    i & 1 &&
    typeof AggregateError != "undefined" &&
    (a === AggregateError || n2 instanceof AggregateError)
  )
    return hn(e, r, t, n2);
  if (n2 instanceof Error) return zt(e, r, t, n2);
  if (C in n2 || v in n2) return zr(e, r, t, n2, !!a);
  throw new x$1(n2);
}
async function Mn(e, r, t) {
  let n2 = q(e.base, t);
  if (n2.type !== 0) return n2.value;
  let a = await _t(e, r, n2.value, t);
  if (a) return a;
  throw new x$1(t);
}
async function N(e, r, t) {
  switch (typeof t) {
    case "boolean":
      return t ? J : Z;
    case "undefined":
      return Ae;
    case "string":
      return X(t);
    case "number":
      return Te(t);
    case "bigint":
      return we(t);
    case "object": {
      if (t) {
        let n2 = q(e.base, t);
        return n2.type === 0 ? await Vn(e, r + 1, n2.value, t) : n2.value;
      }
      return Ee;
    }
    case "symbol":
      return I(e.base, t);
    case "function":
      return Mn(e, r, t);
    default:
      throw new x$1(t);
  }
}
async function oe(e, r) {
  try {
    return await N(e, 0, r);
  } catch (t) {
    throw t instanceof z ? t : new z(t);
  }
}
var ae = ((t) => ((t[(t.Vanilla = 1)] = "Vanilla"), (t[(t.Cross = 2)] = "Cross"), t))(ae || {});
function ni(e) {
  return e;
}
function kt(e, r) {
  for (let t = 0, n2 = r.length; t < n2; t++) {
    let a = r[t];
    e.has(a) || (e.add(a), a.extends && kt(e, a.extends));
  }
}
function A(e) {
  if (e) {
    let r = /* @__PURE__ */ new Set();
    return (kt(r, e), [...r]);
  }
}
function Dt(e) {
  switch (e) {
    case "Int8Array":
      return Int8Array;
    case "Int16Array":
      return Int16Array;
    case "Int32Array":
      return Int32Array;
    case "Uint8Array":
      return Uint8Array;
    case "Uint16Array":
      return Uint16Array;
    case "Uint32Array":
      return Uint32Array;
    case "Uint8ClampedArray":
      return Uint8ClampedArray;
    case "Float32Array":
      return Float32Array;
    case "Float64Array":
      return Float64Array;
    case "BigInt64Array":
      return BigInt64Array;
    case "BigUint64Array":
      return BigUint64Array;
    default:
      throw new Je(e);
  }
}
var Ln = 1e6,
  Un = 1e4,
  jn = 2e4;
function Bt(e, r) {
  switch (r) {
    case 3:
      return Object.freeze(e);
    case 1:
      return Object.preventExtensions(e);
    case 2:
      return Object.seal(e);
    default:
      return e;
  }
}
var Yn = 1e3;
function Vt(e, r) {
  var t;
  return {
    mode: e,
    plugins: r.plugins,
    refs: r.refs || /* @__PURE__ */ new Map(),
    features: (t = r.features) != null ? t : 63 ^ (r.disabledFeatures || 0),
    depthLimit: r.depthLimit || Yn,
  };
}
function Mt(e) {
  return { mode: 1, base: Vt(1, e), child: o, state: { marked: new Set(e.markedRefs) } };
}
var Dr = class {
  constructor(r, t) {
    this._p = r;
    this.depth = t;
  }
  deserialize(r) {
    return p$1(this._p, this.depth, r);
  }
};
function Ut(e, r) {
  if (r < 0 || !Number.isFinite(r) || !Number.isInteger(r)) throw new h({ t: 4, i: r });
  if (e.refs.has(r)) throw new Error("Conflicted ref id: " + r);
}
function qn(e, r, t) {
  return (Ut(e.base, r), e.state.marked.has(r) && e.base.refs.set(r, t), t);
}
function Wn(e, r, t) {
  return (Ut(e.base, r), e.base.refs.set(r, t), t);
}
function b(e, r, t) {
  return e.mode === 1 ? qn(e, r, t) : Wn(e, r, t);
}
function Fr(e, r, t) {
  if (Object.hasOwn(r, t)) return r[t];
  throw new h(e);
}
function Gn(e, r) {
  return b(e, r.i, ft(D(r.s)));
}
function Kn(e, r, t) {
  let n2 = t.a,
    a = n2.length,
    s = b(e, t.i, new Array(a));
  for (let i = 0, u; i < a; i++) ((u = n2[i]), u && (s[i] = p$1(e, r, u)));
  return (Bt(s, t.o), s);
}
function Hn(e) {
  switch (e) {
    case "constructor":
    case "__proto__":
    case "prototype":
    case "__defineGetter__":
    case "__defineSetter__":
    case "__lookupGetter__":
    case "__lookupSetter__":
      return false;
    default:
      return true;
  }
}
function Jn(e) {
  switch (e) {
    case v:
    case R:
    case P$1:
    case C:
      return true;
    default:
      return false;
  }
}
function Ft(e, r, t) {
  Hn(r)
    ? (e[r] = t)
    : Object.defineProperty(e, r, {
        value: t,
        configurable: true,
        enumerable: true,
        writable: true,
      });
}
function Zn(e, r, t, n2, a) {
  if (typeof n2 == "string") Ft(t, D(n2), p$1(e, r, a));
  else {
    let s = p$1(e, r, n2);
    switch (typeof s) {
      case "string":
        Ft(t, s, p$1(e, r, a));
        break;
      case "symbol":
        Jn(s) && (t[s] = p$1(e, r, a));
        break;
      default:
        throw new h(n2);
    }
  }
}
function jt(e, r, t, n2) {
  let a = t.k;
  if (a.length > 0) for (let i = 0, u = t.v, l = a.length; i < l; i++) Zn(e, r, n2, a[i], u[i]);
  return n2;
}
function $n(e, r, t) {
  let n2 = b(e, t.i, t.t === 10 ? {} : /* @__PURE__ */ Object.create(null));
  return (jt(e, r, t.p, n2), Bt(n2, t.o), n2);
}
function Xn(e, r) {
  return b(e, r.i, new Date(r.s));
}
function Qn(e, r) {
  if (e.base.features & 32) {
    let t = D(r.c);
    if (t.length > jn) throw new h(r);
    return b(e, r.i, new RegExp(t, r.m));
  }
  throw new w$1(r);
}
function eo(e, r, t) {
  let n2 = b(e, t.i, /* @__PURE__ */ new Set());
  for (let a = 0, s = t.a, i = s.length; a < i; a++) n2.add(p$1(e, r, s[a]));
  return n2;
}
function ro(e, r, t) {
  let n2 = b(e, t.i, /* @__PURE__ */ new Map());
  for (let a = 0, s = t.e.k, i = t.e.v, u = s.length; a < u; a++)
    n2.set(p$1(e, r, s[a]), p$1(e, r, i[a]));
  return n2;
}
function to(e, r) {
  if (r.s.length > Ln) throw new h(r);
  return b(e, r.i, Or(D(r.s)));
}
function no(e, r, t) {
  var u;
  let n2 = Dt(t.c),
    a = p$1(e, r, t.f),
    s = (u = t.b) != null ? u : 0;
  if (s < 0 || s > a.byteLength) throw new h(t);
  return b(e, t.i, new n2(a, s, t.l));
}
function oo(e, r, t) {
  var i;
  let n2 = p$1(e, r, t.f),
    a = (i = t.b) != null ? i : 0;
  if (a < 0 || a > n2.byteLength) throw new h(t);
  return b(e, t.i, new DataView(n2, a, t.l));
}
function Yt(e, r, t, n2) {
  if (t.p) {
    let a = jt(e, r, t.p, {});
    Object.defineProperties(n2, Object.getOwnPropertyDescriptors(a));
  }
  return n2;
}
function ao(e, r, t) {
  let n2 = b(e, t.i, new AggregateError([], D(t.m)));
  return Yt(e, r, t, n2);
}
function so(e, r, t) {
  let n2 = Fr(t, at, t.s),
    a = b(e, t.i, new n2(D(t.m)));
  return Yt(e, r, t, a);
}
function io(e, r, t) {
  let n2 = re(),
    a = b(e, t.i, n2.p),
    s = p$1(e, r, t.f);
  return (t.s ? n2.s(s) : n2.f(s), a);
}
function uo(e, r, t) {
  return b(e, t.i, Object(p$1(e, r, t.f)));
}
function lo(e, r, t) {
  let n2 = e.base.plugins;
  if (n2) {
    let a = D(t.c);
    for (let s = 0, i = n2.length; s < i; s++) {
      let u = n2[s];
      if (u.tag === a) return b(e, t.i, u.deserialize(t.s, new Dr(e, r), { id: t.i }));
    }
  }
  throw new Q(t.c);
}
function co(e, r) {
  return b(e, r.i, b(e, r.s, re()).p);
}
function fo(e, r, t) {
  let n2 = e.base.refs.get(t.i);
  if (n2) return (n2.s(p$1(e, r, t.a[1])), o);
  throw new V("Promise");
}
function So(e, r, t) {
  let n2 = e.base.refs.get(t.i);
  if (n2) return (n2.f(p$1(e, r, t.a[1])), o);
  throw new V("Promise");
}
function mo(e, r, t) {
  p$1(e, r, t.a[0]);
  let n2 = p$1(e, r, t.a[1]);
  return It(n2);
}
function po(e, r, t) {
  p$1(e, r, t.a[0]);
  let n2 = p$1(e, r, t.a[1]);
  return Tt(n2);
}
function go(e, r, t) {
  let n2 = b(e, t.i, te()),
    a = t.a,
    s = a.length;
  if (s) for (let i = 0; i < s; i++) p$1(e, r, a[i]);
  return n2;
}
function yo(e, r, t) {
  let n2 = e.base.refs.get(t.i);
  if (n2 && M(n2)) return (n2.next(p$1(e, r, t.f)), o);
  throw new V("Stream");
}
function No(e, r, t) {
  let n2 = e.base.refs.get(t.i);
  if (n2 && M(n2)) return (n2.throw(p$1(e, r, t.f)), o);
  throw new V("Stream");
}
function bo(e, r, t) {
  let n2 = e.base.refs.get(t.i);
  if (n2 && M(n2)) return (n2.return(p$1(e, r, t.f)), o);
  throw new V("Stream");
}
function vo(e, r, t) {
  return (p$1(e, r, t.f), o);
}
function Co(e, r, t) {
  return (p$1(e, r, t.a[1]), o);
}
function Ao(e, r, t) {
  let n2 = b(e, t.i, Tr([], t.s, t.l));
  for (let a = 0, s = t.a.length; a < s; a++) n2.v[a] = p$1(e, r, t.a[a]);
  return n2;
}
function p$1(e, r, t) {
  if (r > e.base.depthLimit) throw new ee$1(e.base.depthLimit);
  switch (((r += 1), t.t)) {
    case 2:
      return Fr(t, ot, t.s);
    case 0:
      return Number(t.s);
    case 1:
      return D(String(t.s));
    case 3:
      if (String(t.s).length > Un) throw new h(t);
      return BigInt(t.s);
    case 4:
      return e.base.refs.get(t.i);
    case 18:
      return Gn(e, t);
    case 9:
      return Kn(e, r, t);
    case 10:
    case 11:
      return $n(e, r, t);
    case 5:
      return Xn(e, t);
    case 6:
      return Qn(e, t);
    case 7:
      return eo(e, r, t);
    case 8:
      return ro(e, r, t);
    case 19:
      return to(e, t);
    case 16:
    case 15:
      return no(e, r, t);
    case 20:
      return oo(e, r, t);
    case 14:
      return ao(e, r, t);
    case 13:
      return so(e, r, t);
    case 12:
      return io(e, r, t);
    case 17:
      return Fr(t, tt, t.s);
    case 21:
      return uo(e, r, t);
    case 25:
      return lo(e, r, t);
    case 22:
      return co(e, t);
    case 23:
      return fo(e, r, t);
    case 24:
      return So(e, r, t);
    case 28:
      return mo(e, r, t);
    case 30:
      return po(e, r, t);
    case 31:
      return go(e, r, t);
    case 32:
      return yo(e, r, t);
    case 33:
      return No(e, r, t);
    case 34:
      return bo(e, r, t);
    case 27:
      return vo(e, r, t);
    case 29:
      return Co(e, r, t);
    case 35:
      return Ao(e, r, t);
    default:
      throw new w$1(t);
  }
}
function ar(e, r) {
  try {
    return p$1(e, 0, r);
  } catch (t) {
    throw new He(t);
  }
}
var Eo = () => T,
  Io = Eo.toString(),
  qt = /=>/.test(Io);
function sr(e, r) {
  return qt
    ? (e.length === 1 ? e[0] : "(" + e.join(",") + ")") +
        "=>" +
        (r.startsWith("{") ? "(" + r + ")" : r)
    : "function(" + e.join(",") + "){return " + r + "}";
}
function Wt(e, r) {
  return qt
    ? (e.length === 1 ? e[0] : "(" + e.join(",") + ")") + "=>{" + r + "}"
    : "function(" + e.join(",") + "){" + r + "}";
}
var Ht = "hjkmoquxzABCDEFGHIJKLNPQRTUVWXYZ$_",
  Gt = Ht.length,
  Jt = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$_",
  Kt = Jt.length;
function Br(e) {
  let r = e % Gt,
    t = Ht[r];
  for (e = (e - r) / Gt; e > 0; ) ((r = e % Kt), (t += Jt[r]), (e = (e - r) / Kt));
  return t;
}
var Ro = /^[$A-Z_][0-9A-Z_$]*$/i;
function Vr(e) {
  let r = e[0];
  return (r === "$" || r === "_" || (r >= "A" && r <= "Z") || (r >= "a" && r <= "z")) && Ro.test(e);
}
function ye(e) {
  switch (e.t) {
    case 0:
      return e.s + "=" + e.v;
    case 2:
      return e.s + ".set(" + e.k + "," + e.v + ")";
    case 1:
      return e.s + ".add(" + e.v + ")";
    case 3:
      return e.s + ".delete(" + e.k + ")";
  }
}
function Po(e) {
  let r = [],
    t = e[0];
  for (let n2 = 1, a = e.length, s, i = t; n2 < a; n2++)
    ((s = e[n2]),
      s.t === 0 && s.v === i.v
        ? (t = { t: 0, s: s.s, k: o, v: ye(t) })
        : s.t === 2 && s.s === i.s
          ? (t = { t: 2, s: ye(t), k: s.k, v: s.v })
          : s.t === 1 && s.s === i.s
            ? (t = { t: 1, s: ye(t), k: o, v: s.v })
            : s.t === 3 && s.s === i.s
              ? (t = { t: 3, s: ye(t), k: s.k, v: o })
              : (r.push(t), (t = s)),
      (i = s));
  return (r.push(t), r);
}
function tn(e) {
  if (e.length) {
    let r = "",
      t = Po(e);
    for (let n2 = 0, a = t.length; n2 < a; n2++) r += ye(t[n2]) + ",";
    return r;
  }
  return o;
}
var xo = "Object.create(null)",
  Oo = "new Set",
  To = "new Map",
  wo = "Promise.resolve",
  ho = "Promise.reject",
  zo = { 3: "Object.freeze", 2: "Object.seal", 1: "Object.preventExtensions", 0: o };
function nn(e, r) {
  return {
    mode: e,
    plugins: r.plugins,
    features: r.features,
    marked: new Set(r.markedRefs),
    stack: [],
    flags: [],
    assignments: [],
  };
}
function ur(e) {
  return { mode: 2, base: nn(2, e), state: e, child: o };
}
var Mr = class {
  constructor(r) {
    this._p = r;
  }
  serialize(r) {
    return f(this._p, r);
  }
};
function ko(e, r) {
  let t = e.valid.get(r);
  t == null && ((t = e.valid.size), e.valid.set(r, t));
  let n2 = e.vars[t];
  return (n2 == null && ((n2 = Br(t)), (e.vars[t] = n2)), n2);
}
function Do(e) {
  return ce + "[" + e + "]";
}
function m(e, r) {
  return e.mode === 1 ? ko(e.state, r) : Do(r);
}
function O(e, r) {
  e.marked.add(r);
}
function Lr(e, r) {
  return e.marked.has(r);
}
function jr(e, r, t) {
  r !== 0 && (O(e.base, t), e.base.flags.push({ type: r, value: m(e, t) }));
}
function Fo(e) {
  let r = "";
  for (let t = 0, n2 = e.flags, a = n2.length; t < a; t++) {
    let s = n2[t];
    r += zo[s.type] + "(" + s.value + "),";
  }
  return r;
}
function on(e) {
  let r = tn(e.assignments),
    t = Fo(e);
  return r ? (t ? r + t : r) : t;
}
function Yr(e, r, t) {
  e.assignments.push({ t: 0, s: r, k: o, v: t });
}
function Bo(e, r, t) {
  e.base.assignments.push({ t: 1, s: m(e, r), k: o, v: t });
}
function ge(e, r, t, n2) {
  e.base.assignments.push({ t: 2, s: m(e, r), k: t, v: n2 });
}
function Zt(e, r, t) {
  e.base.assignments.push({ t: 3, s: m(e, r), k: t, v: o });
}
function Ne(e, r, t, n2) {
  Yr(e.base, m(e, r) + "[" + t + "]", n2);
}
function Ur(e, r, t, n2) {
  Yr(e.base, m(e, r) + "." + t, n2);
}
function Vo(e, r, t, n2) {
  Yr(e.base, m(e, r) + ".v[" + t + "]", n2);
}
function F(e, r) {
  return r.t === 4 && e.stack.includes(r.i);
}
function se(e, r, t) {
  return e.mode === 1 && !Lr(e.base, r) ? t : m(e, r) + "=" + t;
}
function Mo(e) {
  return U + '.get("' + e.s + '")';
}
function $t(e, r, t, n2) {
  return t ? (F(e.base, t) ? (O(e.base, r), Ne(e, r, n2, m(e, t.i)), "") : f(e, t)) : "";
}
function Lo(e, r) {
  let t = r.i,
    n2 = r.a,
    a = n2.length;
  if (a > 0) {
    e.base.stack.push(t);
    let s = $t(e, t, n2[0], 0),
      i = s === "";
    for (let u = 1, l; u < a; u++) ((l = $t(e, t, n2[u], u)), (s += "," + l), (i = l === ""));
    return (e.base.stack.pop(), jr(e, r.o, r.i), "[" + s + (i ? ",]" : "]"));
  }
  return "[]";
}
function Xt(e, r, t, n2) {
  if (typeof t == "string") {
    let a = Number(t),
      s = (a >= 0 && a.toString() === t) || Vr(t);
    if (F(e.base, n2)) {
      let i = m(e, n2.i);
      return (
        O(e.base, r.i), s && a !== a ? Ur(e, r.i, t, i) : Ne(e, r.i, s ? t : '"' + t + '"', i), ""
      );
    }
    return (s ? t : '"' + t + '"') + ":" + f(e, n2);
  }
  return "[" + f(e, t) + "]:" + f(e, n2);
}
function an(e, r, t) {
  let n2 = t.k,
    a = n2.length;
  if (a > 0) {
    let s = t.v;
    e.base.stack.push(r.i);
    let i = Xt(e, r, n2[0], s[0]);
    for (let u = 1, l = i; u < a; u++) ((l = Xt(e, r, n2[u], s[u])), (i += (l && i && ",") + l));
    return (e.base.stack.pop(), "{" + i + "}");
  }
  return "{}";
}
function Uo(e, r) {
  return (jr(e, r.o, r.i), an(e, r, r.p));
}
function jo(e, r, t, n2) {
  let a = an(e, r, t);
  return a !== "{}" ? "Object.assign(" + n2 + "," + a + ")" : n2;
}
function Yo(e, r, t, n2, a) {
  let s = e.base,
    i = f(e, a),
    u = Number(n2),
    l = (u >= 0 && u.toString() === n2) || Vr(n2);
  if (F(s, a)) l && u !== u ? Ur(e, r.i, n2, i) : Ne(e, r.i, l ? n2 : '"' + n2 + '"', i);
  else {
    let g = s.assignments;
    ((s.assignments = t),
      l && u !== u ? Ur(e, r.i, n2, i) : Ne(e, r.i, l ? n2 : '"' + n2 + '"', i),
      (s.assignments = g));
  }
}
function qo(e, r, t, n2, a) {
  if (typeof n2 == "string") Yo(e, r, t, n2, a);
  else {
    let s = e.base,
      i = s.stack;
    s.stack = [];
    let u = f(e, a);
    s.stack = i;
    let l = s.assignments;
    ((s.assignments = t), Ne(e, r.i, f(e, n2), u), (s.assignments = l));
  }
}
function Wo(e, r, t) {
  let n2 = t.k,
    a = n2.length;
  if (a > 0) {
    let s = [],
      i = t.v;
    e.base.stack.push(r.i);
    for (let u = 0; u < a; u++) qo(e, r, s, n2[u], i[u]);
    return (e.base.stack.pop(), tn(s));
  }
  return o;
}
function qr(e, r, t) {
  if (r.p) {
    let n2 = e.base;
    if (n2.features & 8) t = jo(e, r, r.p, t);
    else {
      O(n2, r.i);
      let a = Wo(e, r, r.p);
      if (a) return "(" + se(e, r.i, t) + "," + a + m(e, r.i) + ")";
    }
  }
  return t;
}
function Go(e, r) {
  return (jr(e, r.o, r.i), qr(e, r, xo));
}
function Ko(e) {
  return 'new Date("' + e.s + '")';
}
function Ho(e, r) {
  if (e.base.features & 32) return "/" + r.c + "/" + r.m;
  throw new w$1(r);
}
function Qt(e, r, t) {
  let n2 = e.base;
  return F(n2, t) ? (O(n2, r), Bo(e, r, m(e, t.i)), "") : f(e, t);
}
function Jo(e, r) {
  let t = Oo,
    n2 = r.a,
    a = n2.length,
    s = r.i;
  if (a > 0) {
    e.base.stack.push(s);
    let i = Qt(e, s, n2[0]);
    for (let u = 1, l = i; u < a; u++) ((l = Qt(e, s, n2[u])), (i += (l && i && ",") + l));
    (e.base.stack.pop(), i && (t += "([" + i + "])"));
  }
  return t;
}
function en(e, r, t, n2, a) {
  let s = e.base;
  if (F(s, t)) {
    let i = m(e, t.i);
    if ((O(s, r), F(s, n2))) {
      let l = m(e, n2.i);
      return (ge(e, r, i, l), "");
    }
    if (n2.t !== 4 && n2.i != null && Lr(s, n2.i)) {
      let l = "(" + f(e, n2) + ",[" + a + "," + a + "])";
      return (ge(e, r, i, m(e, n2.i)), Zt(e, r, a), l);
    }
    let u = s.stack;
    return ((s.stack = []), ge(e, r, i, f(e, n2)), (s.stack = u), "");
  }
  if (F(s, n2)) {
    let i = m(e, n2.i);
    if ((O(s, r), t.t !== 4 && t.i != null && Lr(s, t.i))) {
      let l = "(" + f(e, t) + ",[" + a + "," + a + "])";
      return (ge(e, r, m(e, t.i), i), Zt(e, r, a), l);
    }
    let u = s.stack;
    return ((s.stack = []), ge(e, r, f(e, t), i), (s.stack = u), "");
  }
  return "[" + f(e, t) + "," + f(e, n2) + "]";
}
function Zo(e, r) {
  let t = To,
    n2 = r.e.k,
    a = n2.length,
    s = r.i,
    i = r.f,
    u = m(e, i.i),
    l = e.base;
  if (a > 0) {
    let g = r.e.v;
    l.stack.push(s);
    let S = en(e, s, n2[0], g[0], u);
    for (let d = 1, K = S; d < a; d++) ((K = en(e, s, n2[d], g[d], u)), (S += (K && S && ",") + K));
    (l.stack.pop(), S && (t += "([" + S + "])"));
  }
  return (i.t === 26 && (O(l, i.i), (t = "(" + f(e, i) + "," + t + ")")), t);
}
function $o(e, r) {
  return W(e, r.f) + '("' + r.s + '")';
}
function Xo(e, r) {
  return "new " + r.c + "(" + f(e, r.f) + "," + r.b + "," + r.l + ")";
}
function Qo(e, r) {
  return "new DataView(" + f(e, r.f) + "," + r.b + "," + r.l + ")";
}
function ea(e, r) {
  let t = r.i;
  e.base.stack.push(t);
  let n2 = qr(e, r, 'new AggregateError([],"' + r.m + '")');
  return (e.base.stack.pop(), n2);
}
function ra(e, r) {
  return qr(e, r, "new " + Ce[r.s] + '("' + r.m + '")');
}
function ta(e, r) {
  let t,
    n2 = r.f,
    a = r.i,
    s = r.s ? wo : ho,
    i = e.base;
  if (F(i, n2)) {
    let u = m(e, n2.i);
    t = s + (r.s ? "().then(" + sr([], u) + ")" : "().catch(" + Wt([], "throw " + u) + ")");
  } else {
    i.stack.push(a);
    let u = f(e, n2);
    (i.stack.pop(), (t = s + "(" + u + ")"));
  }
  return t;
}
function na(e, r) {
  return "Object(" + f(e, r.f) + ")";
}
function W(e, r) {
  let t = f(e, r);
  return r.t === 4 ? t : "(" + t + ")";
}
function oa(e, r) {
  if (e.mode === 1) throw new w$1(r);
  return "(" + se(e, r.s, W(e, r.f) + "()") + ").p";
}
function aa(e, r) {
  if (e.mode === 1) throw new w$1(r);
  return W(e, r.a[0]) + "(" + m(e, r.i) + "," + f(e, r.a[1]) + ")";
}
function sa(e, r) {
  if (e.mode === 1) throw new w$1(r);
  return W(e, r.a[0]) + "(" + m(e, r.i) + "," + f(e, r.a[1]) + ")";
}
function ia(e, r) {
  let t = e.base.plugins;
  if (t)
    for (let n2 = 0, a = t.length; n2 < a; n2++) {
      let s = t[n2];
      if (s.tag === r.c)
        return (e.child == null && (e.child = new Mr(e)), s.serialize(r.s, e.child, { id: r.i }));
    }
  throw new Q(r.c);
}
function ua(e, r) {
  let t = "",
    n2 = false;
  return (
    r.f.t !== 4 && (O(e.base, r.f.i), (t = "(" + f(e, r.f) + ","), (n2 = true)),
    (t += se(e, r.i, "(" + Ct + ")(" + m(e, r.f.i) + ")")),
    n2 && (t += ")"),
    t
  );
}
function la(e, r) {
  return W(e, r.a[0]) + "(" + f(e, r.a[1]) + ")";
}
function ca(e, r) {
  let t = r.a[0],
    n2 = r.a[1],
    a = e.base,
    s = "";
  (t.t !== 4 && (O(a, t.i), (s += "(" + f(e, t))),
    n2.t !== 4 && (O(a, n2.i), (s += (s ? "," : "(") + f(e, n2))),
    s && (s += ","));
  let i = se(e, r.i, "(" + At + ")(" + m(e, n2.i) + "," + m(e, t.i) + ")");
  return s ? s + i + ")" : i;
}
function fa(e, r) {
  return W(e, r.a[0]) + "(" + f(e, r.a[1]) + ")";
}
function Sa(e, r) {
  let t = se(e, r.i, W(e, r.f) + "()"),
    n2 = r.a.length;
  if (n2) {
    let a = f(e, r.a[0]);
    for (let s = 1; s < n2; s++) a += "," + f(e, r.a[s]);
    return "(" + t + "," + a + "," + m(e, r.i) + ")";
  }
  return t;
}
function ma(e, r) {
  return m(e, r.i) + ".next(" + f(e, r.f) + ")";
}
function pa(e, r) {
  return m(e, r.i) + ".throw(" + f(e, r.f) + ")";
}
function da(e, r) {
  return m(e, r.i) + ".return(" + f(e, r.f) + ")";
}
function rn(e, r, t, n2) {
  let a = e.base;
  return F(a, n2) ? (O(a, r), Vo(e, r, t, m(e, n2.i)), "") : f(e, n2);
}
function ga(e, r) {
  let t = r.a,
    n2 = t.length,
    a = r.i;
  if (n2 > 0) {
    e.base.stack.push(a);
    let s = rn(e, a, 0, t[0]);
    for (let i = 1, u = s; i < n2; i++) ((u = rn(e, a, i, t[i])), (s += (u && s && ",") + u));
    if ((e.base.stack.pop(), s))
      return "{__SEROVAL_SEQUENCE__:!0,v:[" + s + "],t:" + r.s + ",d:" + r.l + "}";
  }
  return "{__SEROVAL_SEQUENCE__:!0,v:[],t:-1,d:0}";
}
function ya(e, r) {
  switch (r.t) {
    case 17:
      return rt[r.s];
    case 18:
      return Mo(r);
    case 9:
      return Lo(e, r);
    case 10:
      return Uo(e, r);
    case 11:
      return Go(e, r);
    case 5:
      return Ko(r);
    case 6:
      return Ho(e, r);
    case 7:
      return Jo(e, r);
    case 8:
      return Zo(e, r);
    case 19:
      return $o(e, r);
    case 16:
    case 15:
      return Xo(e, r);
    case 20:
      return Qo(e, r);
    case 14:
      return ea(e, r);
    case 13:
      return ra(e, r);
    case 12:
      return ta(e, r);
    case 21:
      return na(e, r);
    case 22:
      return oa(e, r);
    case 25:
      return ia(e, r);
    case 26:
      return Ot[r.s];
    case 35:
      return ga(e, r);
    default:
      throw new w$1(r);
  }
}
function f(e, r) {
  switch (r.t) {
    case 2:
      return nt[r.s];
    case 0:
      return "" + r.s;
    case 1:
      return '"' + r.s + '"';
    case 3:
      return r.s + "n";
    case 4:
      return m(e, r.i);
    case 23:
      return aa(e, r);
    case 24:
      return sa(e, r);
    case 27:
      return ua(e, r);
    case 28:
      return la(e, r);
    case 29:
      return ca(e, r);
    case 30:
      return fa(e, r);
    case 31:
      return Sa(e, r);
    case 32:
      return ma(e, r);
    case 33:
      return pa(e, r);
    case 34:
      return da(e, r);
    default:
      return se(e, r.i, ya(e, r));
  }
}
function cr(e, r) {
  let t = f(e, r),
    n2 = r.i;
  if (n2 == null) return t;
  let a = on(e.base),
    s = m(e, n2),
    i = e.state.scopeId,
    u = i == null ? "" : ce,
    l = a ? "(" + t + "," + a + s + ")" : t;
  if (u === "") return r.t === 10 && !a ? "(" + l + ")" : l;
  let g = i == null ? "()" : "(" + ce + '["' + y(i) + '"])';
  return "(" + sr([u], l) + ")" + g;
}
var Gr = class {
    constructor(r, t) {
      this._p = r;
      this.depth = t;
    }
    parse(r) {
      return E(this._p, this.depth, r);
    }
  },
  Kr = class {
    constructor(r, t) {
      this._p = r;
      this.depth = t;
    }
    parse(r) {
      return E(this._p, this.depth, r);
    }
    parseWithError(r) {
      return G(this._p, this.depth, r);
    }
    isAlive() {
      return this._p.state.alive;
    }
    pushPendingState() {
      Xr(this._p);
    }
    popPendingState() {
      be(this._p);
    }
    onParse(r) {
      ie(this._p, r);
    }
    onError(r) {
      Zr(this._p, r);
    }
  };
function Na(e) {
  return {
    alive: true,
    pending: 0,
    initial: true,
    buffer: [],
    onParse: e.onParse,
    onError: e.onError,
    onDone: e.onDone,
  };
}
function Hr(e) {
  return { type: 2, base: pe(2, e), state: Na(e) };
}
function ba(e, r, t) {
  let n2 = [];
  for (let a = 0, s = t.length; a < s; a++) a in t ? (n2[a] = E(e, r, t[a])) : (n2[a] = 0);
  return n2;
}
function va(e, r, t, n2) {
  return _e(t, n2, ba(e, r, n2));
}
function Jr(e, r, t) {
  let n2 = Object.entries(t),
    a = [],
    s = [];
  for (let i = 0, u = n2.length; i < u; i++) (a.push(y(n2[i][0])), s.push(E(e, r, n2[i][1])));
  return (
    C in t && (a.push(I(e.base, C)), s.push(Ue(er(e.base), E(e, r, $e(t))))),
    v in t && (a.push(I(e.base, v)), s.push(je(rr(e.base), E(e, r, e.type === 1 ? te() : Xe(t))))),
    P$1 in t && (a.push(I(e.base, P$1)), s.push(X(t[P$1]))),
    R in t && (a.push(I(e.base, R)), s.push(t[R] ? J : Z)),
    { k: a, v: s }
  );
}
function Wr(e, r, t, n2, a) {
  return tr(t, n2, a, Jr(e, r, n2));
}
function Ca(e, r, t, n2) {
  return ke(t, E(e, r, n2.valueOf()));
}
function Aa(e, r, t, n2) {
  return De(t, n2, E(e, r, n2.buffer));
}
function Ea(e, r, t, n2) {
  return Fe(t, n2, E(e, r, n2.buffer));
}
function Ia(e, r, t, n2) {
  return Be(t, n2, E(e, r, n2.buffer));
}
function sn(e, r, t, n2) {
  let a = $(n2, e.base.features);
  return Ve(t, n2, a ? Jr(e, r, a) : o);
}
function Ra(e, r, t, n2) {
  let a = $(n2, e.base.features);
  return Me(t, n2, a ? Jr(e, r, a) : o);
}
function Pa(e, r, t, n2) {
  let a = [],
    s = [];
  for (let [i, u] of n2.entries()) (a.push(E(e, r, i)), s.push(E(e, r, u)));
  return nr(e.base, t, a, s);
}
function xa(e, r, t, n2) {
  let a = [];
  for (let s of n2.keys()) a.push(E(e, r, s));
  return Le(t, a);
}
function Oa(e, r, t, n2) {
  let a = Ye(t, k(e.base, 4), []);
  return (
    e.type === 1 ||
      (Xr(e),
      n2.on({
        next: (s) => {
          if (e.state.alive) {
            let i = G(e, r, s);
            i && ie(e, qe(t, i));
          }
        },
        throw: (s) => {
          if (e.state.alive) {
            let i = G(e, r, s);
            i && ie(e, We(t, i));
          }
          be(e);
        },
        return: (s) => {
          if (e.state.alive) {
            let i = G(e, r, s);
            i && ie(e, Ge(t, i));
          }
          be(e);
        },
      })),
    a
  );
}
function Ta(e, r, t) {
  if (this.state.alive) {
    let n2 = G(this, r, t);
    (n2 && ie(this, c(23, e, o, o, o, o, o, [k(this.base, 2), n2], o, o, o, o)), be(this));
  }
}
function wa(e, r, t) {
  if (this.state.alive) {
    let n2 = G(this, r, t);
    n2 && ie(this, c(24, e, o, o, o, o, o, [k(this.base, 3), n2], o, o, o, o));
  }
  be(this);
}
function ha(e, r, t, n2) {
  let a = hr(e.base, {});
  return (e.type === 2 && (Xr(e), n2.then(Ta.bind(e, a, r), wa.bind(e, a, r))), ht(e.base, t, a));
}
function za(e, r, t, n2, a) {
  for (let s = 0, i = a.length; s < i; s++) {
    let u = a[s];
    if (u.parse.sync && u.test(n2)) return fe(t, u.tag, u.parse.sync(n2, new Gr(e, r), { id: t }));
  }
  return o;
}
function _a(e, r, t, n2, a) {
  for (let s = 0, i = a.length; s < i; s++) {
    let u = a[s];
    if (u.parse.stream && u.test(n2))
      return fe(t, u.tag, u.parse.stream(n2, new Kr(e, r), { id: t }));
  }
  return o;
}
function un(e, r, t, n2) {
  let a = e.base.plugins;
  return a ? (e.type === 1 ? za(e, r, t, n2, a) : _a(e, r, t, n2, a)) : o;
}
function ka(e, r, t, n2) {
  let a = [];
  for (let s = 0, i = n2.v.length; s < i; s++) a[s] = E(e, r, n2.v[s]);
  return Ke(t, a, n2.t, n2.d);
}
function Da(e, r, t, n2, a) {
  switch (a) {
    case Object:
      return Wr(e, r, t, n2, false);
    case o:
      return Wr(e, r, t, n2, true);
    case Date:
      return he(t, n2);
    case Error:
    case EvalError:
    case RangeError:
    case ReferenceError:
    case SyntaxError:
    case TypeError:
    case URIError:
      return sn(e, r, t, n2);
    case Number:
    case Boolean:
    case String:
    case BigInt:
      return Ca(e, r, t, n2);
    case ArrayBuffer:
      return or(e.base, t, n2);
    case Int8Array:
    case Int16Array:
    case Int32Array:
    case Uint8Array:
    case Uint16Array:
    case Uint32Array:
    case Uint8ClampedArray:
    case Float32Array:
    case Float64Array:
      return Aa(e, r, t, n2);
    case DataView:
      return Ia(e, r, t, n2);
    case Map:
      return Pa(e, r, t, n2);
    case Set:
      return xa(e, r, t, n2);
  }
  if (a === Promise || n2 instanceof Promise) return ha(e, r, t, n2);
  let s = e.base.features;
  if (s & 32 && a === RegExp) return ze(t, n2);
  if (s & 16)
    switch (a) {
      case BigInt64Array:
      case BigUint64Array:
        return Ea(e, r, t, n2);
    }
  if (
    s & 1 &&
    typeof AggregateError != "undefined" &&
    (a === AggregateError || n2 instanceof AggregateError)
  )
    return Ra(e, r, t, n2);
  if (n2 instanceof Error) return sn(e, r, t, n2);
  if (C in n2 || v in n2) return Wr(e, r, t, n2, !!a);
  throw new x$1(n2);
}
function Fa(e, r, t, n2) {
  if (Array.isArray(n2)) return va(e, r, t, n2);
  if (M(n2)) return Oa(e, r, t, n2);
  if (Ze(n2)) return ka(e, r, t, n2);
  let a = n2.constructor;
  if (a === Y) return E(e, r, n2.replacement);
  let s = un(e, r, t, n2);
  return s || Da(e, r, t, n2, a);
}
function Ba(e, r, t) {
  let n2 = q(e.base, t);
  if (n2.type !== 0) return n2.value;
  let a = un(e, r, n2.value, t);
  if (a) return a;
  throw new x$1(t);
}
function E(e, r, t) {
  if (r >= e.base.depthLimit) throw new ee$1(e.base.depthLimit);
  switch (typeof t) {
    case "boolean":
      return t ? J : Z;
    case "undefined":
      return Ae;
    case "string":
      return X(t);
    case "number":
      return Te(t);
    case "bigint":
      return we(t);
    case "object": {
      if (t) {
        let n2 = q(e.base, t);
        return n2.type === 0 ? Fa(e, r + 1, n2.value, t) : n2.value;
      }
      return Ee;
    }
    case "symbol":
      return I(e.base, t);
    case "function":
      return Ba(e, r, t);
    default:
      throw new x$1(t);
  }
}
function ie(e, r) {
  e.state.initial ? e.state.buffer.push(r) : $r(e, r, false);
}
function Zr(e, r) {
  if (e.state.onError) e.state.onError(r);
  else throw r instanceof z ? r : new z(r);
}
function ln(e) {
  e.state.onDone && e.state.onDone();
}
function $r(e, r, t) {
  try {
    e.state.onParse(r, t);
  } catch (n2) {
    Zr(e, n2);
  }
}
function Xr(e) {
  e.state.pending++;
}
function be(e) {
  --e.state.pending <= 0 && ln(e);
}
function G(e, r, t) {
  try {
    return E(e, r, t);
  } catch (n2) {
    return (Zr(e, n2), o);
  }
}
function Qr(e, r) {
  let t = G(e, 0, r);
  t && ($r(e, t, true), (e.state.initial = false), Va(e, e.state), e.state.pending <= 0 && fr(e));
}
function Va(e, r) {
  for (let t = 0, n2 = r.buffer.length; t < n2; t++) $r(e, r.buffer[t], false);
}
function fr(e) {
  e.state.alive && (ln(e), (e.state.alive = false));
}
async function ou(e, r = {}) {
  let t = A(r.plugins),
    n2 = ne(2, { plugins: t, disabledFeatures: r.disabledFeatures, refs: r.refs });
  return await oe(n2, e);
}
function cn(e, r) {
  let t = A(r.plugins),
    n2 = Hr({
      plugins: t,
      refs: r.refs,
      disabledFeatures: r.disabledFeatures,
      onParse(a, s) {
        let i = ur({
            plugins: t,
            features: n2.base.features,
            scopeId: r.scopeId,
            markedRefs: n2.base.marked,
          }),
          u;
        try {
          u = cr(i, a);
        } catch (l) {
          r.onError && r.onError(l);
          return;
        }
        r.onSerialize(u, s);
      },
      onError: r.onError,
      onDone: r.onDone,
    });
  return (Qr(n2, e), fr.bind(null, n2));
}
function au(e, r) {
  let t = A(r.plugins),
    n2 = Hr({
      plugins: t,
      refs: r.refs,
      disabledFeatures: r.disabledFeatures,
      depthLimit: r.depthLimit,
      onParse: r.onParse,
      onError: r.onError,
      onDone: r.onDone,
    });
  return (Qr(n2, e), fr.bind(null, n2));
}
function Iu(e, r = {}) {
  var i;
  let t = A(r.plugins),
    n2 = r.disabledFeatures || 0,
    a = (i = e.f) != null ? i : 63,
    s = Mt({ plugins: t, markedRefs: e.m, features: a & ~n2, disabledFeatures: n2 });
  return ar(s, e.t);
}
function createSerializationAdapter(opts) {
  return opts;
}
// @__NO_SIDE_EFFECTS__
function makeSsrSerovalPlugin(serializationAdapter, options) {
  return /* @__PURE__ */ ni({
    tag: "$TSR/t/" + serializationAdapter.key,
    test: serializationAdapter.test,
    parse: {
      stream(value, ctx, _data) {
        return { v: ctx.parse(serializationAdapter.toSerializable(value)) };
      },
    },
    serialize(node, ctx, _data) {
      options.didRun = true;
      return (
        GLOBAL_TSR + '.t.get("' + serializationAdapter.key + '")(' + ctx.serialize(node.v) + ")"
      );
    },
    deserialize: void 0,
  });
}
// @__NO_SIDE_EFFECTS__
function makeSerovalPlugin(serializationAdapter) {
  return /* @__PURE__ */ ni({
    tag: "$TSR/t/" + serializationAdapter.key,
    test: serializationAdapter.test,
    parse: {
      sync(value, ctx, _data) {
        return { v: ctx.parse(serializationAdapter.toSerializable(value)) };
      },
      async async(value, ctx, _data) {
        return { v: await ctx.parse(serializationAdapter.toSerializable(value)) };
      },
      stream(value, ctx, _data) {
        return { v: ctx.parse(serializationAdapter.toSerializable(value)) };
      },
    },
    serialize: void 0,
    deserialize(node, ctx, _data) {
      return serializationAdapter.fromSerializable(ctx.deserialize(node.v));
    },
  });
}
var RawStream = class {
  constructor(stream, options) {
    this.stream = stream;
    this.hint = options?.hint ?? "binary";
  }
};
var BufferCtor = globalThis.Buffer;
var hasNodeBuffer = !!BufferCtor && typeof BufferCtor.from === "function";
function uint8ArrayToBase64(bytes) {
  if (bytes.length === 0) return "";
  if (hasNodeBuffer) return BufferCtor.from(bytes).toString("base64");
  const CHUNK_SIZE = 32768;
  const chunks = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    chunks.push(String.fromCharCode.apply(null, chunk));
  }
  return btoa(chunks.join(""));
}
function base64ToUint8Array(base64) {
  if (base64.length === 0) return new Uint8Array(0);
  if (hasNodeBuffer) {
    const buf = BufferCtor.from(base64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
var RAW_STREAM_FACTORY_BINARY = /* @__PURE__ */ Object.create(null);
var RAW_STREAM_FACTORY_TEXT = /* @__PURE__ */ Object.create(null);
var RAW_STREAM_FACTORY_CONSTRUCTOR_BINARY = (stream) =>
  new ReadableStream({
    start(controller) {
      stream.on({
        next(base64) {
          try {
            controller.enqueue(base64ToUint8Array(base64));
          } catch {}
        },
        throw(error) {
          controller.error(error);
        },
        return() {
          try {
            controller.close();
          } catch {}
        },
      });
    },
  });
var textEncoderForFactory = new TextEncoder();
var RAW_STREAM_FACTORY_CONSTRUCTOR_TEXT = (stream) => {
  return new ReadableStream({
    start(controller) {
      stream.on({
        next(value) {
          try {
            if (typeof value === "string") controller.enqueue(textEncoderForFactory.encode(value));
            else controller.enqueue(base64ToUint8Array(value.$b64));
          } catch {}
        },
        throw(error) {
          controller.error(error);
        },
        return() {
          try {
            controller.close();
          } catch {}
        },
      });
    },
  });
};
var FACTORY_BINARY = `(s=>new ReadableStream({start(c){s.on({next(b){try{const d=atob(b),a=new Uint8Array(d.length);for(let i=0;i<d.length;i++)a[i]=d.charCodeAt(i);c.enqueue(a)}catch(_){}},throw(e){c.error(e)},return(){try{c.close()}catch(_){}}})}}))`;
var FACTORY_TEXT = `(s=>{const e=new TextEncoder();return new ReadableStream({start(c){s.on({next(v){try{if(typeof v==='string'){c.enqueue(e.encode(v))}else{const d=atob(v.$b64),a=new Uint8Array(d.length);for(let i=0;i<d.length;i++)a[i]=d.charCodeAt(i);c.enqueue(a)}}catch(_){}},throw(x){c.error(x)},return(){try{c.close()}catch(_){}}})}})})`;
function toBinaryStream(readable) {
  const stream = te();
  const reader = readable.getReader();
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          stream.return(void 0);
          break;
        }
        stream.next(uint8ArrayToBase64(value));
      }
    } catch (error) {
      stream.throw(error);
    } finally {
      reader.releaseLock();
    }
  })();
  return stream;
}
function toTextStream(readable) {
  const stream = te();
  const reader = readable.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          try {
            const remaining = decoder.decode();
            if (remaining.length > 0) stream.next(remaining);
          } catch {}
          stream.return(void 0);
          break;
        }
        try {
          const text = decoder.decode(value, { stream: true });
          if (text.length > 0) stream.next(text);
        } catch {
          stream.next({ $b64: uint8ArrayToBase64(value) });
        }
      }
    } catch (error) {
      stream.throw(error);
    } finally {
      reader.releaseLock();
    }
  })();
  return stream;
}
var RawStreamSSRPlugin = /* @__PURE__ */ ni({
  tag: "tss/RawStream",
  extends: [
    /* @__PURE__ */ ni({
      tag: "tss/RawStreamFactory",
      test(value) {
        return value === RAW_STREAM_FACTORY_BINARY;
      },
      parse: {
        sync(_value, _ctx, _data) {
          return {};
        },
        async async(_value, _ctx, _data) {
          return {};
        },
        stream(_value, _ctx, _data) {
          return {};
        },
      },
      serialize(_node, _ctx, _data) {
        return FACTORY_BINARY;
      },
      deserialize(_node, _ctx, _data) {
        return RAW_STREAM_FACTORY_BINARY;
      },
    }),
    /* @__PURE__ */ ni({
      tag: "tss/RawStreamFactoryText",
      test(value) {
        return value === RAW_STREAM_FACTORY_TEXT;
      },
      parse: {
        sync(_value, _ctx, _data) {
          return {};
        },
        async async(_value, _ctx, _data) {
          return {};
        },
        stream(_value, _ctx, _data) {
          return {};
        },
      },
      serialize(_node, _ctx, _data) {
        return FACTORY_TEXT;
      },
      deserialize(_node, _ctx, _data) {
        return RAW_STREAM_FACTORY_TEXT;
      },
    }),
  ],
  test(value) {
    return value instanceof RawStream;
  },
  parse: {
    sync(value, ctx, _data) {
      const factory = value.hint === "text" ? RAW_STREAM_FACTORY_TEXT : RAW_STREAM_FACTORY_BINARY;
      return {
        hint: ctx.parse(value.hint),
        factory: ctx.parse(factory),
        stream: ctx.parse(te()),
      };
    },
    async async(value, ctx, _data) {
      const factory = value.hint === "text" ? RAW_STREAM_FACTORY_TEXT : RAW_STREAM_FACTORY_BINARY;
      const encodedStream =
        value.hint === "text" ? toTextStream(value.stream) : toBinaryStream(value.stream);
      return {
        hint: await ctx.parse(value.hint),
        factory: await ctx.parse(factory),
        stream: await ctx.parse(encodedStream),
      };
    },
    stream(value, ctx, _data) {
      const factory = value.hint === "text" ? RAW_STREAM_FACTORY_TEXT : RAW_STREAM_FACTORY_BINARY;
      const encodedStream =
        value.hint === "text" ? toTextStream(value.stream) : toBinaryStream(value.stream);
      return {
        hint: ctx.parse(value.hint),
        factory: ctx.parse(factory),
        stream: ctx.parse(encodedStream),
      };
    },
  },
  serialize(node, ctx, _data) {
    return "(" + ctx.serialize(node.factory) + ")(" + ctx.serialize(node.stream) + ")";
  },
  deserialize(node, ctx, _data) {
    const stream = ctx.deserialize(node.stream);
    return ctx.deserialize(node.hint) === "text"
      ? RAW_STREAM_FACTORY_CONSTRUCTOR_TEXT(stream)
      : RAW_STREAM_FACTORY_CONSTRUCTOR_BINARY(stream);
  },
});
// @__NO_SIDE_EFFECTS__
function createRawStreamRPCPlugin(onRawStream) {
  let nextStreamId = 1;
  return /* @__PURE__ */ ni({
    tag: "tss/RawStream",
    test(value) {
      return value instanceof RawStream;
    },
    parse: {
      async async(value, ctx, _data) {
        const streamId = nextStreamId++;
        onRawStream(streamId, value.stream);
        return { streamId: await ctx.parse(streamId) };
      },
      stream(value, ctx, _data) {
        const streamId = nextStreamId++;
        onRawStream(streamId, value.stream);
        return { streamId: ctx.parse(streamId) };
      },
    },
    serialize() {
      throw new Error(
        "RawStreamRPCPlugin.serialize should not be called. RPC uses JSON serialization, not JS code generation.",
      );
    },
    deserialize() {
      throw new Error(
        "RawStreamRPCPlugin.deserialize should not be called. Use createRawStreamDeserializePlugin on client.",
      );
    },
  });
}
var ShallowErrorPlugin = /* @__PURE__ */ ni({
  tag: "$TSR/Error",
  test(value) {
    return value instanceof Error;
  },
  parse: {
    sync(value, ctx) {
      return { message: ctx.parse(value.message) };
    },
    async async(value, ctx) {
      return { message: await ctx.parse(value.message) };
    },
    stream(value, ctx) {
      return { message: ctx.parse(value.message) };
    },
  },
  serialize(node, ctx) {
    return "new Error(" + ctx.serialize(node.message) + ")";
  },
  deserialize(node, ctx) {
    return new Error(ctx.deserialize(node.message));
  },
});
var n = {},
  P = (e) =>
    new ReadableStream({
      start: (r) => {
        e.on({
          next: (a) => {
            try {
              r.enqueue(a);
            } catch (t) {}
          },
          throw: (a) => {
            r.error(a);
          },
          return: () => {
            try {
              r.close();
            } catch (a) {}
          },
        });
      },
    }),
  x2 = ni({
    tag: "seroval-plugins/web/ReadableStreamFactory",
    test(e) {
      return e === n;
    },
    parse: {
      sync() {
        return n;
      },
      async async() {
        return await Promise.resolve(n);
      },
      stream() {
        return n;
      },
    },
    serialize() {
      return P.toString();
    },
    deserialize() {
      return n;
    },
  });
function w2(e) {
  let r = te(),
    a = e.getReader();
  async function t() {
    try {
      let s = await a.read();
      s.done ? r.return(s.value) : (r.next(s.value), await t());
    } catch (s) {
      r.throw(s);
    }
  }
  return (t().catch(() => {}), r);
}
var ee2 = ni({
    tag: "seroval/plugins/web/ReadableStream",
    extends: [x2],
    test(e) {
      return typeof ReadableStream == "undefined" ? false : e instanceof ReadableStream;
    },
    parse: {
      sync(e, r) {
        return { factory: r.parse(n), stream: r.parse(te()) };
      },
      async async(e, r) {
        return { factory: await r.parse(n), stream: await r.parse(w2(e)) };
      },
      stream(e, r) {
        return { factory: r.parse(n), stream: r.parse(w2(e)) };
      },
    },
    serialize(e, r) {
      return "(" + r.serialize(e.factory) + ")(" + r.serialize(e.stream) + ")";
    },
    deserialize(e, r) {
      let a = r.deserialize(e.stream);
      return P(a);
    },
  }),
  p = ee2;
var defaultSerovalPlugins = [ShallowErrorPlugin, RawStreamSSRPlugin, p];
var jsxRuntime = { exports: {} };
var reactJsxRuntime_production = {};
/**
 * @license React
 * react-jsx-runtime.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var hasRequiredReactJsxRuntime_production;
function requireReactJsxRuntime_production() {
  if (hasRequiredReactJsxRuntime_production) return reactJsxRuntime_production;
  hasRequiredReactJsxRuntime_production = 1;
  var REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element"),
    REACT_FRAGMENT_TYPE = Symbol.for("react.fragment");
  function jsxProd(type, config, maybeKey) {
    var key = null;
    void 0 !== maybeKey && (key = "" + maybeKey);
    void 0 !== config.key && (key = "" + config.key);
    if ("key" in config) {
      maybeKey = {};
      for (var propName in config) "key" !== propName && (maybeKey[propName] = config[propName]);
    } else maybeKey = config;
    config = maybeKey.ref;
    return {
      $$typeof: REACT_ELEMENT_TYPE,
      type,
      key,
      ref: void 0 !== config ? config : null,
      props: maybeKey,
    };
  }
  reactJsxRuntime_production.Fragment = REACT_FRAGMENT_TYPE;
  reactJsxRuntime_production.jsx = jsxProd;
  reactJsxRuntime_production.jsxs = jsxProd;
  return reactJsxRuntime_production;
}
var hasRequiredJsxRuntime;
function requireJsxRuntime() {
  if (hasRequiredJsxRuntime) return jsxRuntime.exports;
  hasRequiredJsxRuntime = 1;
  {
    jsxRuntime.exports = requireReactJsxRuntime_production();
  }
  return jsxRuntime.exports;
}
var jsxRuntimeExports = requireJsxRuntime();
function CatchBoundary(props) {
  const errorComponent = props.errorComponent ?? ErrorComponent;
  return /* @__PURE__ */ jsxRuntimeExports.jsx(CatchBoundaryImpl, {
    getResetKey: props.getResetKey,
    onCatch: props.onCatch,
    children: ({ error, reset }) => {
      if (error)
        return reactExports.createElement(errorComponent, {
          error,
          reset,
        });
      return props.children;
    },
  });
}
var CatchBoundaryImpl = class extends reactExports.Component {
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
  const [show, setShow] = reactExports.useState(false);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", {
    style: {
      padding: ".5rem",
      maxWidth: "100%",
    },
    children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: ".5rem",
        },
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("strong", {
            style: { fontSize: "1rem" },
            children: "Something went wrong!",
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("button", {
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
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { height: ".25rem" } }),
      show
        ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", {
            children: /* @__PURE__ */ jsxRuntimeExports.jsx("pre", {
              style: {
                fontSize: ".7em",
                border: "1px solid red",
                borderRadius: ".25rem",
                padding: ".3rem",
                color: "red",
                overflow: "auto",
              },
              children: error.message
                ? /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: error.message })
                : null,
            }),
          })
        : null,
    ],
  });
}
function ClientOnly({ children, fallback = null }) {
  return useHydrated()
    ? /* @__PURE__ */ jsxRuntimeExports.jsx(React.Fragment, { children })
    : /* @__PURE__ */ jsxRuntimeExports.jsx(React.Fragment, { children: fallback });
}
function useHydrated() {
  return React.useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
function subscribe() {
  return () => {};
}
var routerContext = reactExports.createContext(null);
function useRouter(opts) {
  const value = reactExports.useContext(routerContext);
  return value;
}
var matchContext = reactExports.createContext(void 0);
var dummyMatchContext = reactExports.createContext(void 0);
var reactDom = { exports: {} };
var reactDom_production = {};
/**
 * @license React
 * react-dom.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var hasRequiredReactDom_production;
function requireReactDom_production() {
  if (hasRequiredReactDom_production) return reactDom_production;
  hasRequiredReactDom_production = 1;
  var React2 = requireReact();
  function formatProdErrorMessage(code) {
    var url = "https://react.dev/errors/" + code;
    if (1 < arguments.length) {
      url += "?args[]=" + encodeURIComponent(arguments[1]);
      for (var i = 2; i < arguments.length; i++)
        url += "&args[]=" + encodeURIComponent(arguments[i]);
    }
    return (
      "Minified React error #" +
      code +
      "; visit " +
      url +
      " for the full message or use the non-minified dev environment for full errors and additional helpful warnings."
    );
  }
  function noop() {}
  var Internals = {
      d: {
        f: noop,
        r: function () {
          throw Error(formatProdErrorMessage(522));
        },
        D: noop,
        C: noop,
        L: noop,
        m: noop,
        X: noop,
        S: noop,
        M: noop,
      },
      p: 0,
      findDOMNode: null,
    },
    REACT_PORTAL_TYPE = Symbol.for("react.portal");
  function createPortal$1(children, containerInfo, implementation) {
    var key = 3 < arguments.length && void 0 !== arguments[3] ? arguments[3] : null;
    return {
      $$typeof: REACT_PORTAL_TYPE,
      key: null == key ? null : "" + key,
      children,
      containerInfo,
      implementation,
    };
  }
  var ReactSharedInternals = React2.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  function getCrossOriginStringAs(as, input) {
    if ("font" === as) return "";
    if ("string" === typeof input) return "use-credentials" === input ? input : "";
  }
  reactDom_production.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = Internals;
  reactDom_production.createPortal = function (children, container) {
    var key = 2 < arguments.length && void 0 !== arguments[2] ? arguments[2] : null;
    if (
      !container ||
      (1 !== container.nodeType && 9 !== container.nodeType && 11 !== container.nodeType)
    )
      throw Error(formatProdErrorMessage(299));
    return createPortal$1(children, container, null, key);
  };
  reactDom_production.flushSync = function (fn2) {
    var previousTransition = ReactSharedInternals.T,
      previousUpdatePriority = Internals.p;
    try {
      if (((ReactSharedInternals.T = null), (Internals.p = 2), fn2)) return fn2();
    } finally {
      ((ReactSharedInternals.T = previousTransition),
        (Internals.p = previousUpdatePriority),
        Internals.d.f());
    }
  };
  reactDom_production.preconnect = function (href, options) {
    "string" === typeof href &&
      (options
        ? ((options = options.crossOrigin),
          (options =
            "string" === typeof options ? ("use-credentials" === options ? options : "") : void 0))
        : (options = null),
      Internals.d.C(href, options));
  };
  reactDom_production.prefetchDNS = function (href) {
    "string" === typeof href && Internals.d.D(href);
  };
  reactDom_production.preinit = function (href, options) {
    if ("string" === typeof href && options && "string" === typeof options.as) {
      var as = options.as,
        crossOrigin = getCrossOriginStringAs(as, options.crossOrigin),
        integrity = "string" === typeof options.integrity ? options.integrity : void 0,
        fetchPriority = "string" === typeof options.fetchPriority ? options.fetchPriority : void 0;
      "style" === as
        ? Internals.d.S(
            href,
            "string" === typeof options.precedence ? options.precedence : void 0,
            {
              crossOrigin,
              integrity,
              fetchPriority,
            },
          )
        : "script" === as &&
          Internals.d.X(href, {
            crossOrigin,
            integrity,
            fetchPriority,
            nonce: "string" === typeof options.nonce ? options.nonce : void 0,
          });
    }
  };
  reactDom_production.preinitModule = function (href, options) {
    if ("string" === typeof href)
      if ("object" === typeof options && null !== options) {
        if (null == options.as || "script" === options.as) {
          var crossOrigin = getCrossOriginStringAs(options.as, options.crossOrigin);
          Internals.d.M(href, {
            crossOrigin,
            integrity: "string" === typeof options.integrity ? options.integrity : void 0,
            nonce: "string" === typeof options.nonce ? options.nonce : void 0,
          });
        }
      } else null == options && Internals.d.M(href);
  };
  reactDom_production.preload = function (href, options) {
    if (
      "string" === typeof href &&
      "object" === typeof options &&
      null !== options &&
      "string" === typeof options.as
    ) {
      var as = options.as,
        crossOrigin = getCrossOriginStringAs(as, options.crossOrigin);
      Internals.d.L(href, as, {
        crossOrigin,
        integrity: "string" === typeof options.integrity ? options.integrity : void 0,
        nonce: "string" === typeof options.nonce ? options.nonce : void 0,
        type: "string" === typeof options.type ? options.type : void 0,
        fetchPriority: "string" === typeof options.fetchPriority ? options.fetchPriority : void 0,
        referrerPolicy:
          "string" === typeof options.referrerPolicy ? options.referrerPolicy : void 0,
        imageSrcSet: "string" === typeof options.imageSrcSet ? options.imageSrcSet : void 0,
        imageSizes: "string" === typeof options.imageSizes ? options.imageSizes : void 0,
        media: "string" === typeof options.media ? options.media : void 0,
      });
    }
  };
  reactDom_production.preloadModule = function (href, options) {
    if ("string" === typeof href)
      if (options) {
        var crossOrigin = getCrossOriginStringAs(options.as, options.crossOrigin);
        Internals.d.m(href, {
          as: "string" === typeof options.as && "script" !== options.as ? options.as : void 0,
          crossOrigin,
          integrity: "string" === typeof options.integrity ? options.integrity : void 0,
        });
      } else Internals.d.m(href);
  };
  reactDom_production.requestFormReset = function (form) {
    Internals.d.r(form);
  };
  reactDom_production.unstable_batchedUpdates = function (fn2, a) {
    return fn2(a);
  };
  reactDom_production.useFormState = function (action, initialState, permalink) {
    return ReactSharedInternals.H.useFormState(action, initialState, permalink);
  };
  reactDom_production.useFormStatus = function () {
    return ReactSharedInternals.H.useHostTransitionStatus();
  };
  reactDom_production.version = "19.2.5";
  return reactDom_production;
}
var hasRequiredReactDom;
function requireReactDom() {
  if (hasRequiredReactDom) return reactDom.exports;
  hasRequiredReactDom = 1;
  function checkDCE() {
    if (
      typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ === "undefined" ||
      typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE !== "function"
    ) {
      return;
    }
    try {
      __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(checkDCE);
    } catch (err) {
      console.error(err);
    }
  }
  {
    checkDCE();
    reactDom.exports = requireReactDom_production();
  }
  return reactDom.exports;
}
function CatchNotFound(props) {
  const router = useRouter();
  {
    const resetKey = `not-found-${router.stores.location.get().pathname}-${router.stores.status.get()}`;
    return /* @__PURE__ */ jsxRuntimeExports.jsx(CatchBoundary, {
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
}
function DefaultGlobalNotFound() {
  return /* @__PURE__ */ jsxRuntimeExports.jsx("p", { children: "Not Found" });
}
function SafeFragment(props) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx(jsxRuntimeExports.Fragment, {
    children: props.children,
  });
}
function renderRouteNotFound(router, route, data) {
  if (!route.options.notFoundComponent) {
    if (router.options.defaultNotFoundComponent)
      return /* @__PURE__ */ jsxRuntimeExports.jsx(router.options.defaultNotFoundComponent, {
        ...data,
      });
    return /* @__PURE__ */ jsxRuntimeExports.jsx(DefaultGlobalNotFound, {});
  }
  return /* @__PURE__ */ jsxRuntimeExports.jsx(route.options.notFoundComponent, { ...data });
}
function getScrollRestorationScriptForRouter(_router) {
  return null;
}
function ScrollRestoration() {
  getScrollRestorationScriptForRouter(useRouter());
  return null;
}
var Match = reactExports.memo(function MatchImpl({ matchId }) {
  const router = useRouter();
  {
    const match2 = router.stores.matchStores.get(matchId)?.get();
    if (!match2) {
      invariant();
    }
    const routeId = match2.routeId;
    const parentRouteId = router.routesById[routeId].parentRoute?.id;
    return /* @__PURE__ */ jsxRuntimeExports.jsx(MatchView, {
      router,
      matchId,
      resetKey: router.stores.loadedAt.get(),
      matchState: {
        routeId,
        ssr: match2.ssr,
        _displayPending: match2._displayPending,
        parentRouteId,
      },
    });
  }
});
function MatchView({ router, matchId, resetKey, matchState }) {
  const route = router.routesById[matchState.routeId];
  const PendingComponent = route.options.pendingComponent ?? router.options.defaultPendingComponent;
  const pendingElement = PendingComponent
    ? /* @__PURE__ */ jsxRuntimeExports.jsx(PendingComponent, {})
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
      ? reactExports.Suspense
      : SafeFragment;
  const ResolvedCatchBoundary = routeErrorComponent ? CatchBoundary : SafeFragment;
  const ResolvedNotFoundBoundary = routeNotFoundComponent ? CatchNotFound : SafeFragment;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    route.isRoot ? (route.options.shellComponent ?? SafeFragment) : SafeFragment,
    {
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(matchContext.Provider, {
          value: matchId,
          children: /* @__PURE__ */ jsxRuntimeExports.jsx(ResolvedSuspenseBoundary, {
            fallback: pendingElement,
            children: /* @__PURE__ */ jsxRuntimeExports.jsx(ResolvedCatchBoundary, {
              getResetKey: () => resetKey,
              errorComponent: routeErrorComponent || ErrorComponent,
              onCatch: (error, errorInfo) => {
                if (isNotFound(error)) {
                  error.routeId ??= matchState.routeId;
                  throw error;
                }
                routeOnCatch?.(error, errorInfo);
              },
              children: /* @__PURE__ */ jsxRuntimeExports.jsx(ResolvedNotFoundBoundary, {
                fallback: (error) => {
                  error.routeId ??= matchState.routeId;
                  if (
                    !routeNotFoundComponent ||
                    (error.routeId && error.routeId !== matchState.routeId) ||
                    (!error.routeId && !route.isRoot)
                  )
                    throw error;
                  return reactExports.createElement(routeNotFoundComponent, error);
                },
                children:
                  resolvedNoSsr || matchState._displayPending
                    ? /* @__PURE__ */ jsxRuntimeExports.jsx(ClientOnly, {
                        fallback: pendingElement,
                        children: /* @__PURE__ */ jsxRuntimeExports.jsx(MatchInner, { matchId }),
                      })
                    : /* @__PURE__ */ jsxRuntimeExports.jsx(MatchInner, { matchId }),
              }),
            }),
          }),
        }),
        matchState.parentRouteId === rootRouteId
          ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, {
              children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx(OnRendered, { resetKey }),
                router.options.scrollRestoration && isServer
                  ? /* @__PURE__ */ jsxRuntimeExports.jsx(ScrollRestoration, {})
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
var MatchInner = reactExports.memo(function MatchInnerImpl({ matchId }) {
  const router = useRouter();
  const getMatchPromise = (match2, key2) => {
    return router.getMatch(match2.id)?._nonReactive[key2] ?? match2._nonReactive[key2];
  };
  {
    const match2 = router.stores.matchStores.get(matchId)?.get();
    if (!match2) {
      invariant();
    }
    const routeId2 = match2.routeId;
    const route2 = router.routesById[routeId2];
    const remountDeps = (
      router.routesById[routeId2].options.remountDeps ?? router.options.defaultRemountDeps
    )?.({
      routeId: routeId2,
      loaderDeps: match2.loaderDeps,
      params: match2._strictParams,
      search: match2._strictSearch,
    });
    const key2 = remountDeps ? JSON.stringify(remountDeps) : void 0;
    const Comp = route2.options.component ?? router.options.defaultComponent;
    const out2 = Comp
      ? /* @__PURE__ */ jsxRuntimeExports.jsx(Comp, {}, key2)
      : /* @__PURE__ */ jsxRuntimeExports.jsx(Outlet, {});
    if (match2._displayPending) throw getMatchPromise(match2, "displayPendingPromise");
    if (match2._forcePending) throw getMatchPromise(match2, "minPendingPromise");
    if (match2.status === "pending") throw getMatchPromise(match2, "loadPromise");
    if (match2.status === "notFound") {
      if (!isNotFound(match2.error)) {
        invariant();
      }
      return renderRouteNotFound(router, route2, match2.error);
    }
    if (match2.status === "redirected") {
      if (!isRedirect(match2.error)) {
        invariant();
      }
      throw getMatchPromise(match2, "loadPromise");
    }
    if (match2.status === "error")
      return /* @__PURE__ */ jsxRuntimeExports.jsx(
        (route2.options.errorComponent ?? router.options.defaultErrorComponent) || ErrorComponent,
        {
          error: match2.error,
          reset: void 0,
          info: { componentStack: "" },
        },
      );
    return out2;
  }
});
var Outlet = reactExports.memo(function OutletImpl() {
  const router = useRouter();
  const matchId = reactExports.useContext(matchContext);
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
    ? /* @__PURE__ */ jsxRuntimeExports.jsx(router.options.defaultPendingComponent, {})
    : null;
  if (parentGlobalNotFound) {
    if (!route) {
      invariant();
    }
    return renderRouteNotFound(router, route, void 0);
  }
  if (!childMatchId) return null;
  const nextMatch = /* @__PURE__ */ jsxRuntimeExports.jsx(Match, { matchId: childMatchId });
  if (routeId === rootRouteId)
    return /* @__PURE__ */ jsxRuntimeExports.jsx(reactExports.Suspense, {
      fallback: pendingElement,
      children: nextMatch,
    });
  return nextMatch;
});
function Matches() {
  const router = useRouter();
  const PendingComponent =
    router.routesById[rootRouteId].options.pendingComponent ??
    router.options.defaultPendingComponent;
  const pendingElement = PendingComponent
    ? /* @__PURE__ */ jsxRuntimeExports.jsx(PendingComponent, {})
    : null;
  const inner = /* @__PURE__ */ jsxRuntimeExports.jsxs(SafeFragment, {
    fallback: pendingElement,
    children: [false, /* @__PURE__ */ jsxRuntimeExports.jsx(MatchesInner, {})],
  });
  return router.options.InnerWrap
    ? /* @__PURE__ */ jsxRuntimeExports.jsx(router.options.InnerWrap, { children: inner })
    : inner;
}
function MatchesInner() {
  const router = useRouter();
  const matchId = router.stores.firstId.get();
  const resetKey = router.stores.loadedAt.get();
  const matchComponent = matchId ? /* @__PURE__ */ jsxRuntimeExports.jsx(Match, { matchId }) : null;
  return /* @__PURE__ */ jsxRuntimeExports.jsx(matchContext.Provider, {
    value: matchId,
    children: router.options.disableGlobalCatchBoundary
      ? matchComponent
      : /* @__PURE__ */ jsxRuntimeExports.jsx(CatchBoundary, {
          getResetKey: () => resetKey,
          errorComponent: ErrorComponent,
          onCatch: void 0,
          children: matchComponent,
        }),
  });
}
function RouterContextProvider({ router, children, ...rest }) {
  if (Object.keys(rest).length > 0)
    router.update({
      ...router.options,
      ...rest,
      context: {
        ...router.options.context,
        ...rest.context,
      },
    });
  const provider = /* @__PURE__ */ jsxRuntimeExports.jsx(routerContext.Provider, {
    value: router,
    children,
  });
  if (router.options.Wrap)
    return /* @__PURE__ */ jsxRuntimeExports.jsx(router.options.Wrap, { children: provider });
  return provider;
}
function RouterProvider({ router, ...rest }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx(RouterContextProvider, {
    router,
    ...rest,
    children: /* @__PURE__ */ jsxRuntimeExports.jsx(Matches, {}),
  });
}
function StartServer(props) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx(RouterProvider, { router: props.router });
}
var server_edge = {};
var reactDomServer_edge_production = {};
/**
 * @license React
 * react-dom-server.edge.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var hasRequiredReactDomServer_edge_production;
function requireReactDomServer_edge_production() {
  if (hasRequiredReactDomServer_edge_production) return reactDomServer_edge_production;
  hasRequiredReactDomServer_edge_production = 1;
  var React2 = requireReact(),
    ReactDOM = requireReactDom(),
    REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element"),
    REACT_PORTAL_TYPE = Symbol.for("react.portal"),
    REACT_FRAGMENT_TYPE = Symbol.for("react.fragment"),
    REACT_STRICT_MODE_TYPE = Symbol.for("react.strict_mode"),
    REACT_PROFILER_TYPE = Symbol.for("react.profiler"),
    REACT_CONSUMER_TYPE = Symbol.for("react.consumer"),
    REACT_CONTEXT_TYPE = Symbol.for("react.context"),
    REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref"),
    REACT_SUSPENSE_TYPE = Symbol.for("react.suspense"),
    REACT_SUSPENSE_LIST_TYPE = Symbol.for("react.suspense_list"),
    REACT_MEMO_TYPE = Symbol.for("react.memo"),
    REACT_LAZY_TYPE = Symbol.for("react.lazy"),
    REACT_SCOPE_TYPE = Symbol.for("react.scope"),
    REACT_ACTIVITY_TYPE = Symbol.for("react.activity"),
    REACT_LEGACY_HIDDEN_TYPE = Symbol.for("react.legacy_hidden"),
    REACT_MEMO_CACHE_SENTINEL = Symbol.for("react.memo_cache_sentinel"),
    REACT_VIEW_TRANSITION_TYPE = Symbol.for("react.view_transition"),
    MAYBE_ITERATOR_SYMBOL = Symbol.iterator;
  function getIteratorFn(maybeIterable) {
    if (null === maybeIterable || "object" !== typeof maybeIterable) return null;
    maybeIterable =
      (MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL]) ||
      maybeIterable["@@iterator"];
    return "function" === typeof maybeIterable ? maybeIterable : null;
  }
  var isArrayImpl = Array.isArray;
  function murmurhash3_32_gc(key, seed) {
    var remainder = key.length & 3;
    var bytes = key.length - remainder;
    var h1 = seed;
    for (seed = 0; seed < bytes; ) {
      var k1 =
        (key.charCodeAt(seed) & 255) |
        ((key.charCodeAt(++seed) & 255) << 8) |
        ((key.charCodeAt(++seed) & 255) << 16) |
        ((key.charCodeAt(++seed) & 255) << 24);
      ++seed;
      k1 = (3432918353 * (k1 & 65535) + (((3432918353 * (k1 >>> 16)) & 65535) << 16)) & 4294967295;
      k1 = (k1 << 15) | (k1 >>> 17);
      k1 = (461845907 * (k1 & 65535) + (((461845907 * (k1 >>> 16)) & 65535) << 16)) & 4294967295;
      h1 ^= k1;
      h1 = (h1 << 13) | (h1 >>> 19);
      h1 = (5 * (h1 & 65535) + (((5 * (h1 >>> 16)) & 65535) << 16)) & 4294967295;
      h1 = (h1 & 65535) + 27492 + ((((h1 >>> 16) + 58964) & 65535) << 16);
    }
    k1 = 0;
    switch (remainder) {
      case 3:
        k1 ^= (key.charCodeAt(seed + 2) & 255) << 16;
      case 2:
        k1 ^= (key.charCodeAt(seed + 1) & 255) << 8;
      case 1:
        ((k1 ^= key.charCodeAt(seed) & 255),
          (k1 =
            (3432918353 * (k1 & 65535) + (((3432918353 * (k1 >>> 16)) & 65535) << 16)) &
            4294967295),
          (k1 = (k1 << 15) | (k1 >>> 17)),
          (h1 ^=
            (461845907 * (k1 & 65535) + (((461845907 * (k1 >>> 16)) & 65535) << 16)) & 4294967295));
    }
    h1 ^= key.length;
    h1 ^= h1 >>> 16;
    h1 = (2246822507 * (h1 & 65535) + (((2246822507 * (h1 >>> 16)) & 65535) << 16)) & 4294967295;
    h1 ^= h1 >>> 13;
    h1 = (3266489909 * (h1 & 65535) + (((3266489909 * (h1 >>> 16)) & 65535) << 16)) & 4294967295;
    return (h1 ^ (h1 >>> 16)) >>> 0;
  }
  function handleErrorInNextTick(error) {
    setTimeout(function () {
      throw error;
    });
  }
  var LocalPromise = Promise,
    scheduleMicrotask =
      "function" === typeof queueMicrotask
        ? queueMicrotask
        : function (callback) {
            LocalPromise.resolve(null).then(callback).catch(handleErrorInNextTick);
          },
    currentView = null,
    writtenBytes = 0;
  function writeChunk(destination, chunk) {
    if (0 !== chunk.byteLength)
      if (2048 < chunk.byteLength)
        (0 < writtenBytes &&
          (destination.enqueue(new Uint8Array(currentView.buffer, 0, writtenBytes)),
          (currentView = new Uint8Array(2048)),
          (writtenBytes = 0)),
          destination.enqueue(chunk));
      else {
        var allowableBytes = currentView.length - writtenBytes;
        allowableBytes < chunk.byteLength &&
          (0 === allowableBytes
            ? destination.enqueue(currentView)
            : (currentView.set(chunk.subarray(0, allowableBytes), writtenBytes),
              destination.enqueue(currentView),
              (chunk = chunk.subarray(allowableBytes))),
          (currentView = new Uint8Array(2048)),
          (writtenBytes = 0));
        currentView.set(chunk, writtenBytes);
        writtenBytes += chunk.byteLength;
      }
  }
  function writeChunkAndReturn(destination, chunk) {
    writeChunk(destination, chunk);
    return true;
  }
  function completeWriting(destination) {
    currentView &&
      0 < writtenBytes &&
      (destination.enqueue(new Uint8Array(currentView.buffer, 0, writtenBytes)),
      (currentView = null),
      (writtenBytes = 0));
  }
  var textEncoder2 = new TextEncoder();
  function stringToChunk(content) {
    return textEncoder2.encode(content);
  }
  function stringToPrecomputedChunk(content) {
    return textEncoder2.encode(content);
  }
  function byteLengthOfChunk(chunk) {
    return chunk.byteLength;
  }
  function closeWithError(destination, error) {
    "function" === typeof destination.error ? destination.error(error) : destination.close();
  }
  var assign = Object.assign,
    hasOwnProperty = Object.prototype.hasOwnProperty,
    VALID_ATTRIBUTE_NAME_REGEX = RegExp(
      "^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$",
    ),
    illegalAttributeNameCache = {},
    validatedAttributeNameCache = {};
  function isAttributeNameSafe(attributeName) {
    if (hasOwnProperty.call(validatedAttributeNameCache, attributeName)) return true;
    if (hasOwnProperty.call(illegalAttributeNameCache, attributeName)) return false;
    if (VALID_ATTRIBUTE_NAME_REGEX.test(attributeName))
      return (validatedAttributeNameCache[attributeName] = true);
    illegalAttributeNameCache[attributeName] = true;
    return false;
  }
  var unitlessNumbers = new Set(
      "animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp".split(
        " ",
      ),
    ),
    aliases = /* @__PURE__ */ new Map([
      ["acceptCharset", "accept-charset"],
      ["htmlFor", "for"],
      ["httpEquiv", "http-equiv"],
      ["crossOrigin", "crossorigin"],
      ["accentHeight", "accent-height"],
      ["alignmentBaseline", "alignment-baseline"],
      ["arabicForm", "arabic-form"],
      ["baselineShift", "baseline-shift"],
      ["capHeight", "cap-height"],
      ["clipPath", "clip-path"],
      ["clipRule", "clip-rule"],
      ["colorInterpolation", "color-interpolation"],
      ["colorInterpolationFilters", "color-interpolation-filters"],
      ["colorProfile", "color-profile"],
      ["colorRendering", "color-rendering"],
      ["dominantBaseline", "dominant-baseline"],
      ["enableBackground", "enable-background"],
      ["fillOpacity", "fill-opacity"],
      ["fillRule", "fill-rule"],
      ["floodColor", "flood-color"],
      ["floodOpacity", "flood-opacity"],
      ["fontFamily", "font-family"],
      ["fontSize", "font-size"],
      ["fontSizeAdjust", "font-size-adjust"],
      ["fontStretch", "font-stretch"],
      ["fontStyle", "font-style"],
      ["fontVariant", "font-variant"],
      ["fontWeight", "font-weight"],
      ["glyphName", "glyph-name"],
      ["glyphOrientationHorizontal", "glyph-orientation-horizontal"],
      ["glyphOrientationVertical", "glyph-orientation-vertical"],
      ["horizAdvX", "horiz-adv-x"],
      ["horizOriginX", "horiz-origin-x"],
      ["imageRendering", "image-rendering"],
      ["letterSpacing", "letter-spacing"],
      ["lightingColor", "lighting-color"],
      ["markerEnd", "marker-end"],
      ["markerMid", "marker-mid"],
      ["markerStart", "marker-start"],
      ["overlinePosition", "overline-position"],
      ["overlineThickness", "overline-thickness"],
      ["paintOrder", "paint-order"],
      ["panose-1", "panose-1"],
      ["pointerEvents", "pointer-events"],
      ["renderingIntent", "rendering-intent"],
      ["shapeRendering", "shape-rendering"],
      ["stopColor", "stop-color"],
      ["stopOpacity", "stop-opacity"],
      ["strikethroughPosition", "strikethrough-position"],
      ["strikethroughThickness", "strikethrough-thickness"],
      ["strokeDasharray", "stroke-dasharray"],
      ["strokeDashoffset", "stroke-dashoffset"],
      ["strokeLinecap", "stroke-linecap"],
      ["strokeLinejoin", "stroke-linejoin"],
      ["strokeMiterlimit", "stroke-miterlimit"],
      ["strokeOpacity", "stroke-opacity"],
      ["strokeWidth", "stroke-width"],
      ["textAnchor", "text-anchor"],
      ["textDecoration", "text-decoration"],
      ["textRendering", "text-rendering"],
      ["transformOrigin", "transform-origin"],
      ["underlinePosition", "underline-position"],
      ["underlineThickness", "underline-thickness"],
      ["unicodeBidi", "unicode-bidi"],
      ["unicodeRange", "unicode-range"],
      ["unitsPerEm", "units-per-em"],
      ["vAlphabetic", "v-alphabetic"],
      ["vHanging", "v-hanging"],
      ["vIdeographic", "v-ideographic"],
      ["vMathematical", "v-mathematical"],
      ["vectorEffect", "vector-effect"],
      ["vertAdvY", "vert-adv-y"],
      ["vertOriginX", "vert-origin-x"],
      ["vertOriginY", "vert-origin-y"],
      ["wordSpacing", "word-spacing"],
      ["writingMode", "writing-mode"],
      ["xmlnsXlink", "xmlns:xlink"],
      ["xHeight", "x-height"],
    ]),
    matchHtmlRegExp = /["'&<>]/;
  function escapeTextForBrowser(text) {
    if ("boolean" === typeof text || "number" === typeof text || "bigint" === typeof text)
      return "" + text;
    text = "" + text;
    var match = matchHtmlRegExp.exec(text);
    if (match) {
      var html = "",
        index,
        lastIndex = 0;
      for (index = match.index; index < text.length; index++) {
        switch (text.charCodeAt(index)) {
          case 34:
            match = "&quot;";
            break;
          case 38:
            match = "&amp;";
            break;
          case 39:
            match = "&#x27;";
            break;
          case 60:
            match = "&lt;";
            break;
          case 62:
            match = "&gt;";
            break;
          default:
            continue;
        }
        lastIndex !== index && (html += text.slice(lastIndex, index));
        lastIndex = index + 1;
        html += match;
      }
      text = lastIndex !== index ? html + text.slice(lastIndex, index) : html;
    }
    return text;
  }
  var uppercasePattern = /([A-Z])/g,
    msPattern = /^ms-/,
    isJavaScriptProtocol =
      /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;
  function sanitizeURL(url) {
    return isJavaScriptProtocol.test("" + url)
      ? "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')"
      : url;
  }
  var ReactSharedInternals = React2.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
    ReactDOMSharedInternals = ReactDOM.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
    sharedNotPendingObject = {
      pending: false,
      data: null,
      method: null,
      action: null,
    },
    previousDispatcher = ReactDOMSharedInternals.d;
  ReactDOMSharedInternals.d = {
    f: previousDispatcher.f,
    r: previousDispatcher.r,
    D: prefetchDNS,
    C: preconnect,
    L: preload,
    m: preloadModule,
    X: preinitScript,
    S: preinitStyle,
    M: preinitModuleScript,
  };
  var PRELOAD_NO_CREDS = [],
    currentlyFlushingRenderState = null;
  stringToPrecomputedChunk('"></template>');
  var startInlineScript = stringToPrecomputedChunk("<script"),
    endInlineScript = stringToPrecomputedChunk("<\/script>"),
    startScriptSrc = stringToPrecomputedChunk('<script src="'),
    startModuleSrc = stringToPrecomputedChunk('<script type="module" src="'),
    scriptNonce = stringToPrecomputedChunk(' nonce="'),
    scriptIntegirty = stringToPrecomputedChunk(' integrity="'),
    scriptCrossOrigin = stringToPrecomputedChunk(' crossorigin="'),
    endAsyncScript = stringToPrecomputedChunk(' async=""><\/script>'),
    startInlineStyle = stringToPrecomputedChunk("<style"),
    scriptRegex = /(<\/|<)(s)(cript)/gi;
  function scriptReplacer(match, prefix2, s, suffix2) {
    return "" + prefix2 + ("s" === s ? "\\u0073" : "\\u0053") + suffix2;
  }
  var importMapScriptStart = stringToPrecomputedChunk('<script type="importmap">'),
    importMapScriptEnd = stringToPrecomputedChunk("<\/script>");
  function createRenderState(
    resumableState,
    nonce,
    externalRuntimeConfig,
    importMap,
    onHeaders,
    maxHeadersLength,
  ) {
    externalRuntimeConfig = "string" === typeof nonce ? nonce : nonce && nonce.script;
    var inlineScriptWithNonce =
        void 0 === externalRuntimeConfig
          ? startInlineScript
          : stringToPrecomputedChunk(
              '<script nonce="' + escapeTextForBrowser(externalRuntimeConfig) + '"',
            ),
      nonceStyle = "string" === typeof nonce ? void 0 : nonce && nonce.style,
      inlineStyleWithNonce =
        void 0 === nonceStyle
          ? startInlineStyle
          : stringToPrecomputedChunk('<style nonce="' + escapeTextForBrowser(nonceStyle) + '"'),
      idPrefix = resumableState.idPrefix,
      bootstrapChunks = [],
      bootstrapScriptContent = resumableState.bootstrapScriptContent,
      bootstrapScripts = resumableState.bootstrapScripts,
      bootstrapModules = resumableState.bootstrapModules;
    void 0 !== bootstrapScriptContent &&
      (bootstrapChunks.push(inlineScriptWithNonce),
      pushCompletedShellIdAttribute(bootstrapChunks, resumableState),
      bootstrapChunks.push(
        endOfStartTag,
        stringToChunk(("" + bootstrapScriptContent).replace(scriptRegex, scriptReplacer)),
        endInlineScript,
      ));
    bootstrapScriptContent = [];
    void 0 !== importMap &&
      (bootstrapScriptContent.push(importMapScriptStart),
      bootstrapScriptContent.push(
        stringToChunk(("" + JSON.stringify(importMap)).replace(scriptRegex, scriptReplacer)),
      ),
      bootstrapScriptContent.push(importMapScriptEnd));
    importMap = onHeaders
      ? {
          preconnects: "",
          fontPreloads: "",
          highImagePreloads: "",
          remainingCapacity: 2 + ("number" === typeof maxHeadersLength ? maxHeadersLength : 2e3),
        }
      : null;
    onHeaders = {
      placeholderPrefix: stringToPrecomputedChunk(idPrefix + "P:"),
      segmentPrefix: stringToPrecomputedChunk(idPrefix + "S:"),
      boundaryPrefix: stringToPrecomputedChunk(idPrefix + "B:"),
      startInlineScript: inlineScriptWithNonce,
      startInlineStyle: inlineStyleWithNonce,
      preamble: createPreambleState(),
      externalRuntimeScript: null,
      bootstrapChunks,
      importMapChunks: bootstrapScriptContent,
      onHeaders,
      headers: importMap,
      resets: {
        font: {},
        dns: {},
        connect: { default: {}, anonymous: {}, credentials: {} },
        image: {},
        style: {},
      },
      charsetChunks: [],
      viewportChunks: [],
      hoistableChunks: [],
      preconnects: /* @__PURE__ */ new Set(),
      fontPreloads: /* @__PURE__ */ new Set(),
      highImagePreloads: /* @__PURE__ */ new Set(),
      styles: /* @__PURE__ */ new Map(),
      bootstrapScripts: /* @__PURE__ */ new Set(),
      scripts: /* @__PURE__ */ new Set(),
      bulkPreloads: /* @__PURE__ */ new Set(),
      preloads: {
        images: /* @__PURE__ */ new Map(),
        stylesheets: /* @__PURE__ */ new Map(),
        scripts: /* @__PURE__ */ new Map(),
        moduleScripts: /* @__PURE__ */ new Map(),
      },
      nonce: { script: externalRuntimeConfig, style: nonceStyle },
      hoistableState: null,
      stylesToHoist: false,
    };
    if (void 0 !== bootstrapScripts)
      for (importMap = 0; importMap < bootstrapScripts.length; importMap++)
        ((idPrefix = bootstrapScripts[importMap]),
          (nonceStyle = inlineScriptWithNonce = void 0),
          (inlineStyleWithNonce = {
            rel: "preload",
            as: "script",
            fetchPriority: "low",
            nonce,
          }),
          "string" === typeof idPrefix
            ? (inlineStyleWithNonce.href = maxHeadersLength = idPrefix)
            : ((inlineStyleWithNonce.href = maxHeadersLength = idPrefix.src),
              (inlineStyleWithNonce.integrity = nonceStyle =
                "string" === typeof idPrefix.integrity ? idPrefix.integrity : void 0),
              (inlineStyleWithNonce.crossOrigin = inlineScriptWithNonce =
                "string" === typeof idPrefix || null == idPrefix.crossOrigin
                  ? void 0
                  : "use-credentials" === idPrefix.crossOrigin
                    ? "use-credentials"
                    : "")),
          (idPrefix = resumableState),
          (bootstrapScriptContent = maxHeadersLength),
          (idPrefix.scriptResources[bootstrapScriptContent] = null),
          (idPrefix.moduleScriptResources[bootstrapScriptContent] = null),
          (idPrefix = []),
          pushLinkImpl(idPrefix, inlineStyleWithNonce),
          onHeaders.bootstrapScripts.add(idPrefix),
          bootstrapChunks.push(
            startScriptSrc,
            stringToChunk(escapeTextForBrowser(maxHeadersLength)),
            attributeEnd,
          ),
          externalRuntimeConfig &&
            bootstrapChunks.push(
              scriptNonce,
              stringToChunk(escapeTextForBrowser(externalRuntimeConfig)),
              attributeEnd,
            ),
          "string" === typeof nonceStyle &&
            bootstrapChunks.push(
              scriptIntegirty,
              stringToChunk(escapeTextForBrowser(nonceStyle)),
              attributeEnd,
            ),
          "string" === typeof inlineScriptWithNonce &&
            bootstrapChunks.push(
              scriptCrossOrigin,
              stringToChunk(escapeTextForBrowser(inlineScriptWithNonce)),
              attributeEnd,
            ),
          pushCompletedShellIdAttribute(bootstrapChunks, resumableState),
          bootstrapChunks.push(endAsyncScript));
    if (void 0 !== bootstrapModules)
      for (nonce = 0; nonce < bootstrapModules.length; nonce++)
        ((nonceStyle = bootstrapModules[nonce]),
          (maxHeadersLength = importMap = void 0),
          (inlineScriptWithNonce = {
            rel: "modulepreload",
            fetchPriority: "low",
            nonce: externalRuntimeConfig,
          }),
          "string" === typeof nonceStyle
            ? (inlineScriptWithNonce.href = bootstrapScripts = nonceStyle)
            : ((inlineScriptWithNonce.href = bootstrapScripts = nonceStyle.src),
              (inlineScriptWithNonce.integrity = maxHeadersLength =
                "string" === typeof nonceStyle.integrity ? nonceStyle.integrity : void 0),
              (inlineScriptWithNonce.crossOrigin = importMap =
                "string" === typeof nonceStyle || null == nonceStyle.crossOrigin
                  ? void 0
                  : "use-credentials" === nonceStyle.crossOrigin
                    ? "use-credentials"
                    : "")),
          (nonceStyle = resumableState),
          (inlineStyleWithNonce = bootstrapScripts),
          (nonceStyle.scriptResources[inlineStyleWithNonce] = null),
          (nonceStyle.moduleScriptResources[inlineStyleWithNonce] = null),
          (nonceStyle = []),
          pushLinkImpl(nonceStyle, inlineScriptWithNonce),
          onHeaders.bootstrapScripts.add(nonceStyle),
          bootstrapChunks.push(
            startModuleSrc,
            stringToChunk(escapeTextForBrowser(bootstrapScripts)),
            attributeEnd,
          ),
          externalRuntimeConfig &&
            bootstrapChunks.push(
              scriptNonce,
              stringToChunk(escapeTextForBrowser(externalRuntimeConfig)),
              attributeEnd,
            ),
          "string" === typeof maxHeadersLength &&
            bootstrapChunks.push(
              scriptIntegirty,
              stringToChunk(escapeTextForBrowser(maxHeadersLength)),
              attributeEnd,
            ),
          "string" === typeof importMap &&
            bootstrapChunks.push(
              scriptCrossOrigin,
              stringToChunk(escapeTextForBrowser(importMap)),
              attributeEnd,
            ),
          pushCompletedShellIdAttribute(bootstrapChunks, resumableState),
          bootstrapChunks.push(endAsyncScript));
    return onHeaders;
  }
  function createResumableState(
    identifierPrefix,
    externalRuntimeConfig,
    bootstrapScriptContent,
    bootstrapScripts,
    bootstrapModules,
  ) {
    return {
      idPrefix: void 0 === identifierPrefix ? "" : identifierPrefix,
      nextFormID: 0,
      streamingFormat: 0,
      bootstrapScriptContent,
      bootstrapScripts,
      bootstrapModules,
      instructions: 0,
      hasBody: false,
      hasHtml: false,
      unknownResources: {},
      dnsResources: {},
      connectResources: { default: {}, anonymous: {}, credentials: {} },
      imageResources: {},
      styleResources: {},
      scriptResources: {},
      moduleUnknownResources: {},
      moduleScriptResources: {},
    };
  }
  function createPreambleState() {
    return { htmlChunks: null, headChunks: null, bodyChunks: null };
  }
  function createFormatContext(insertionMode, selectedValue, tagScope, viewTransition) {
    return {
      insertionMode,
      selectedValue,
      tagScope,
      viewTransition,
    };
  }
  function createRootFormatContext(namespaceURI) {
    return createFormatContext(
      "http://www.w3.org/2000/svg" === namespaceURI
        ? 4
        : "http://www.w3.org/1998/Math/MathML" === namespaceURI
          ? 5
          : 0,
      null,
      0,
      null,
    );
  }
  function getChildFormatContext(parentContext, type, props) {
    var subtreeScope = parentContext.tagScope & -25;
    switch (type) {
      case "noscript":
        return createFormatContext(2, null, subtreeScope | 1, null);
      case "select":
        return createFormatContext(
          2,
          null != props.value ? props.value : props.defaultValue,
          subtreeScope,
          null,
        );
      case "svg":
        return createFormatContext(4, null, subtreeScope, null);
      case "picture":
        return createFormatContext(2, null, subtreeScope | 2, null);
      case "math":
        return createFormatContext(5, null, subtreeScope, null);
      case "foreignObject":
        return createFormatContext(2, null, subtreeScope, null);
      case "table":
        return createFormatContext(6, null, subtreeScope, null);
      case "thead":
      case "tbody":
      case "tfoot":
        return createFormatContext(7, null, subtreeScope, null);
      case "colgroup":
        return createFormatContext(9, null, subtreeScope, null);
      case "tr":
        return createFormatContext(8, null, subtreeScope, null);
      case "head":
        if (2 > parentContext.insertionMode)
          return createFormatContext(3, null, subtreeScope, null);
        break;
      case "html":
        if (0 === parentContext.insertionMode)
          return createFormatContext(1, null, subtreeScope, null);
    }
    return 6 <= parentContext.insertionMode || 2 > parentContext.insertionMode
      ? createFormatContext(2, null, subtreeScope, null)
      : parentContext.tagScope !== subtreeScope
        ? createFormatContext(
            parentContext.insertionMode,
            parentContext.selectedValue,
            subtreeScope,
            null,
          )
        : parentContext;
  }
  function getSuspenseViewTransition(parentViewTransition) {
    return null === parentViewTransition
      ? null
      : {
          update: parentViewTransition.update,
          enter: "none",
          exit: "none",
          share: parentViewTransition.update,
          name: parentViewTransition.autoName,
          autoName: parentViewTransition.autoName,
          nameIdx: 0,
        };
  }
  function getSuspenseFallbackFormatContext(resumableState, parentContext) {
    parentContext.tagScope & 32 && (resumableState.instructions |= 128);
    return createFormatContext(
      parentContext.insertionMode,
      parentContext.selectedValue,
      parentContext.tagScope | 12,
      getSuspenseViewTransition(parentContext.viewTransition),
    );
  }
  function getSuspenseContentFormatContext(resumableState, parentContext) {
    resumableState = getSuspenseViewTransition(parentContext.viewTransition);
    var subtreeScope = parentContext.tagScope | 16;
    null !== resumableState && "none" !== resumableState.share && (subtreeScope |= 64);
    return createFormatContext(
      parentContext.insertionMode,
      parentContext.selectedValue,
      subtreeScope,
      resumableState,
    );
  }
  var textSeparator = stringToPrecomputedChunk("<!-- -->");
  function pushTextInstance(target, text, renderState, textEmbedded) {
    if ("" === text) return textEmbedded;
    textEmbedded && target.push(textSeparator);
    target.push(stringToChunk(escapeTextForBrowser(text)));
    return true;
  }
  var styleNameCache = /* @__PURE__ */ new Map(),
    styleAttributeStart = stringToPrecomputedChunk(' style="'),
    styleAssign = stringToPrecomputedChunk(":"),
    styleSeparator = stringToPrecomputedChunk(";");
  function pushStyleAttribute(target, style) {
    if ("object" !== typeof style)
      throw Error(
        "The `style` prop expects a mapping from style properties to values, not a string. For example, style={{marginRight: spacing + 'em'}} when using JSX.",
      );
    var isFirst = true,
      styleName;
    for (styleName in style)
      if (hasOwnProperty.call(style, styleName)) {
        var styleValue = style[styleName];
        if (null != styleValue && "boolean" !== typeof styleValue && "" !== styleValue) {
          if (0 === styleName.indexOf("--")) {
            var nameChunk = stringToChunk(escapeTextForBrowser(styleName));
            styleValue = stringToChunk(escapeTextForBrowser(("" + styleValue).trim()));
          } else
            ((nameChunk = styleNameCache.get(styleName)),
              void 0 === nameChunk &&
                ((nameChunk = stringToPrecomputedChunk(
                  escapeTextForBrowser(
                    styleName
                      .replace(uppercasePattern, "-$1")
                      .toLowerCase()
                      .replace(msPattern, "-ms-"),
                  ),
                )),
                styleNameCache.set(styleName, nameChunk)),
              (styleValue =
                "number" === typeof styleValue
                  ? 0 === styleValue || unitlessNumbers.has(styleName)
                    ? stringToChunk("" + styleValue)
                    : stringToChunk(styleValue + "px")
                  : stringToChunk(escapeTextForBrowser(("" + styleValue).trim()))));
          isFirst
            ? ((isFirst = false),
              target.push(styleAttributeStart, nameChunk, styleAssign, styleValue))
            : target.push(styleSeparator, nameChunk, styleAssign, styleValue);
        }
      }
    isFirst || target.push(attributeEnd);
  }
  var attributeSeparator = stringToPrecomputedChunk(" "),
    attributeAssign = stringToPrecomputedChunk('="'),
    attributeEnd = stringToPrecomputedChunk('"'),
    attributeEmptyString = stringToPrecomputedChunk('=""');
  function pushBooleanAttribute(target, name, value) {
    value &&
      "function" !== typeof value &&
      "symbol" !== typeof value &&
      target.push(attributeSeparator, stringToChunk(name), attributeEmptyString);
  }
  function pushStringAttribute(target, name, value) {
    "function" !== typeof value &&
      "symbol" !== typeof value &&
      "boolean" !== typeof value &&
      target.push(
        attributeSeparator,
        stringToChunk(name),
        attributeAssign,
        stringToChunk(escapeTextForBrowser(value)),
        attributeEnd,
      );
  }
  var actionJavaScriptURL = stringToPrecomputedChunk(
      escapeTextForBrowser("javascript:throw new Error('React form unexpectedly submitted.')"),
    ),
    startHiddenInputChunk = stringToPrecomputedChunk('<input type="hidden"');
  function pushAdditionalFormField(value, key) {
    this.push(startHiddenInputChunk);
    validateAdditionalFormField(value);
    pushStringAttribute(this, "name", key);
    pushStringAttribute(this, "value", value);
    this.push(endOfStartTagSelfClosing);
  }
  function validateAdditionalFormField(value) {
    if ("string" !== typeof value)
      throw Error(
        "File/Blob fields are not yet supported in progressive forms. Will fallback to client hydration.",
      );
  }
  function getCustomFormFields(resumableState, formAction) {
    if ("function" === typeof formAction.$$FORM_ACTION) {
      var id = resumableState.nextFormID++;
      resumableState = resumableState.idPrefix + id;
      try {
        var customFields = formAction.$$FORM_ACTION(resumableState);
        if (customFields) {
          var formData = customFields.data;
          null != formData && formData.forEach(validateAdditionalFormField);
        }
        return customFields;
      } catch (x3) {
        if ("object" === typeof x3 && null !== x3 && "function" === typeof x3.then) throw x3;
      }
    }
    return null;
  }
  function pushFormActionAttribute(
    target,
    resumableState,
    renderState,
    formAction,
    formEncType,
    formMethod,
    formTarget,
    name,
  ) {
    var formData = null;
    if ("function" === typeof formAction) {
      var customFields = getCustomFormFields(resumableState, formAction);
      null !== customFields
        ? ((name = customFields.name),
          (formAction = customFields.action || ""),
          (formEncType = customFields.encType),
          (formMethod = customFields.method),
          (formTarget = customFields.target),
          (formData = customFields.data))
        : (target.push(
            attributeSeparator,
            stringToChunk("formAction"),
            attributeAssign,
            actionJavaScriptURL,
            attributeEnd,
          ),
          (formTarget = formMethod = formEncType = formAction = name = null),
          injectFormReplayingRuntime(resumableState, renderState));
    }
    null != name && pushAttribute(target, "name", name);
    null != formAction && pushAttribute(target, "formAction", formAction);
    null != formEncType && pushAttribute(target, "formEncType", formEncType);
    null != formMethod && pushAttribute(target, "formMethod", formMethod);
    null != formTarget && pushAttribute(target, "formTarget", formTarget);
    return formData;
  }
  function pushAttribute(target, name, value) {
    switch (name) {
      case "className":
        pushStringAttribute(target, "class", value);
        break;
      case "tabIndex":
        pushStringAttribute(target, "tabindex", value);
        break;
      case "dir":
      case "role":
      case "viewBox":
      case "width":
      case "height":
        pushStringAttribute(target, name, value);
        break;
      case "style":
        pushStyleAttribute(target, value);
        break;
      case "src":
      case "href":
        if ("" === value) break;
      case "action":
      case "formAction":
        if (
          null == value ||
          "function" === typeof value ||
          "symbol" === typeof value ||
          "boolean" === typeof value
        )
          break;
        value = sanitizeURL("" + value);
        target.push(
          attributeSeparator,
          stringToChunk(name),
          attributeAssign,
          stringToChunk(escapeTextForBrowser(value)),
          attributeEnd,
        );
        break;
      case "defaultValue":
      case "defaultChecked":
      case "innerHTML":
      case "suppressContentEditableWarning":
      case "suppressHydrationWarning":
      case "ref":
        break;
      case "autoFocus":
      case "multiple":
      case "muted":
        pushBooleanAttribute(target, name.toLowerCase(), value);
        break;
      case "xlinkHref":
        if ("function" === typeof value || "symbol" === typeof value || "boolean" === typeof value)
          break;
        value = sanitizeURL("" + value);
        target.push(
          attributeSeparator,
          stringToChunk("xlink:href"),
          attributeAssign,
          stringToChunk(escapeTextForBrowser(value)),
          attributeEnd,
        );
        break;
      case "contentEditable":
      case "spellCheck":
      case "draggable":
      case "value":
      case "autoReverse":
      case "externalResourcesRequired":
      case "focusable":
      case "preserveAlpha":
        "function" !== typeof value &&
          "symbol" !== typeof value &&
          target.push(
            attributeSeparator,
            stringToChunk(name),
            attributeAssign,
            stringToChunk(escapeTextForBrowser(value)),
            attributeEnd,
          );
        break;
      case "inert":
      case "allowFullScreen":
      case "async":
      case "autoPlay":
      case "controls":
      case "default":
      case "defer":
      case "disabled":
      case "disablePictureInPicture":
      case "disableRemotePlayback":
      case "formNoValidate":
      case "hidden":
      case "loop":
      case "noModule":
      case "noValidate":
      case "open":
      case "playsInline":
      case "readOnly":
      case "required":
      case "reversed":
      case "scoped":
      case "seamless":
      case "itemScope":
        value &&
          "function" !== typeof value &&
          "symbol" !== typeof value &&
          target.push(attributeSeparator, stringToChunk(name), attributeEmptyString);
        break;
      case "capture":
      case "download":
        true === value
          ? target.push(attributeSeparator, stringToChunk(name), attributeEmptyString)
          : false !== value &&
            "function" !== typeof value &&
            "symbol" !== typeof value &&
            target.push(
              attributeSeparator,
              stringToChunk(name),
              attributeAssign,
              stringToChunk(escapeTextForBrowser(value)),
              attributeEnd,
            );
        break;
      case "cols":
      case "rows":
      case "size":
      case "span":
        "function" !== typeof value &&
          "symbol" !== typeof value &&
          !isNaN(value) &&
          1 <= value &&
          target.push(
            attributeSeparator,
            stringToChunk(name),
            attributeAssign,
            stringToChunk(escapeTextForBrowser(value)),
            attributeEnd,
          );
        break;
      case "rowSpan":
      case "start":
        "function" === typeof value ||
          "symbol" === typeof value ||
          isNaN(value) ||
          target.push(
            attributeSeparator,
            stringToChunk(name),
            attributeAssign,
            stringToChunk(escapeTextForBrowser(value)),
            attributeEnd,
          );
        break;
      case "xlinkActuate":
        pushStringAttribute(target, "xlink:actuate", value);
        break;
      case "xlinkArcrole":
        pushStringAttribute(target, "xlink:arcrole", value);
        break;
      case "xlinkRole":
        pushStringAttribute(target, "xlink:role", value);
        break;
      case "xlinkShow":
        pushStringAttribute(target, "xlink:show", value);
        break;
      case "xlinkTitle":
        pushStringAttribute(target, "xlink:title", value);
        break;
      case "xlinkType":
        pushStringAttribute(target, "xlink:type", value);
        break;
      case "xmlBase":
        pushStringAttribute(target, "xml:base", value);
        break;
      case "xmlLang":
        pushStringAttribute(target, "xml:lang", value);
        break;
      case "xmlSpace":
        pushStringAttribute(target, "xml:space", value);
        break;
      default:
        if (
          !(2 < name.length) ||
          ("o" !== name[0] && "O" !== name[0]) ||
          ("n" !== name[1] && "N" !== name[1])
        ) {
          if (((name = aliases.get(name) || name), isAttributeNameSafe(name))) {
            switch (typeof value) {
              case "function":
              case "symbol":
                return;
              case "boolean":
                var prefix$8 = name.toLowerCase().slice(0, 5);
                if ("data-" !== prefix$8 && "aria-" !== prefix$8) return;
            }
            target.push(
              attributeSeparator,
              stringToChunk(name),
              attributeAssign,
              stringToChunk(escapeTextForBrowser(value)),
              attributeEnd,
            );
          }
        }
    }
  }
  var endOfStartTag = stringToPrecomputedChunk(">"),
    endOfStartTagSelfClosing = stringToPrecomputedChunk("/>");
  function pushInnerHTML(target, innerHTML, children) {
    if (null != innerHTML) {
      if (null != children)
        throw Error("Can only set one of `children` or `props.dangerouslySetInnerHTML`.");
      if ("object" !== typeof innerHTML || !("__html" in innerHTML))
        throw Error(
          "`props.dangerouslySetInnerHTML` must be in the form `{__html: ...}`. Please visit https://react.dev/link/dangerously-set-inner-html for more information.",
        );
      innerHTML = innerHTML.__html;
      null !== innerHTML && void 0 !== innerHTML && target.push(stringToChunk("" + innerHTML));
    }
  }
  function flattenOptionChildren(children) {
    var content = "";
    React2.Children.forEach(children, function (child) {
      null != child && (content += child);
    });
    return content;
  }
  var selectedMarkerAttribute = stringToPrecomputedChunk(' selected=""'),
    formReplayingRuntimeScript = stringToPrecomputedChunk(
      `addEventListener("submit",function(a){if(!a.defaultPrevented){var c=a.target,d=a.submitter,e=c.action,b=d;if(d){var f=d.getAttribute("formAction");null!=f&&(e=f,b=null)}"javascript:throw new Error('React form unexpectedly submitted.')"===e&&(a.preventDefault(),b?(a=document.createElement("input"),a.name=b.name,a.value=b.value,b.parentNode.insertBefore(a,b),b=new FormData(c),a.parentNode.removeChild(a)):b=new FormData(c),a=c.ownerDocument||c,(a.$$reactFormReplay=a.$$reactFormReplay||[]).push(c,d,b))}});`,
    );
  function injectFormReplayingRuntime(resumableState, renderState) {
    if (0 === (resumableState.instructions & 16)) {
      resumableState.instructions |= 16;
      var preamble = renderState.preamble,
        bootstrapChunks = renderState.bootstrapChunks;
      (preamble.htmlChunks || preamble.headChunks) && 0 === bootstrapChunks.length
        ? (bootstrapChunks.push(renderState.startInlineScript),
          pushCompletedShellIdAttribute(bootstrapChunks, resumableState),
          bootstrapChunks.push(endOfStartTag, formReplayingRuntimeScript, endInlineScript))
        : bootstrapChunks.unshift(
            renderState.startInlineScript,
            endOfStartTag,
            formReplayingRuntimeScript,
            endInlineScript,
          );
    }
  }
  var formStateMarkerIsMatching = stringToPrecomputedChunk("<!--F!-->"),
    formStateMarkerIsNotMatching = stringToPrecomputedChunk("<!--F-->");
  function pushLinkImpl(target, props) {
    target.push(startChunkForTag("link"));
    for (var propKey in props)
      if (hasOwnProperty.call(props, propKey)) {
        var propValue = props[propKey];
        if (null != propValue)
          switch (propKey) {
            case "children":
            case "dangerouslySetInnerHTML":
              throw Error(
                "link is a self-closing tag and must neither have `children` nor use `dangerouslySetInnerHTML`.",
              );
            default:
              pushAttribute(target, propKey, propValue);
          }
      }
    target.push(endOfStartTagSelfClosing);
    return null;
  }
  var styleRegex = /(<\/|<)(s)(tyle)/gi;
  function styleReplacer(match, prefix2, s, suffix2) {
    return "" + prefix2 + ("s" === s ? "\\73 " : "\\53 ") + suffix2;
  }
  function pushSelfClosing(target, props, tag) {
    target.push(startChunkForTag(tag));
    for (var propKey in props)
      if (hasOwnProperty.call(props, propKey)) {
        var propValue = props[propKey];
        if (null != propValue)
          switch (propKey) {
            case "children":
            case "dangerouslySetInnerHTML":
              throw Error(
                tag +
                  " is a self-closing tag and must neither have `children` nor use `dangerouslySetInnerHTML`.",
              );
            default:
              pushAttribute(target, propKey, propValue);
          }
      }
    target.push(endOfStartTagSelfClosing);
    return null;
  }
  function pushTitleImpl(target, props) {
    target.push(startChunkForTag("title"));
    var children = null,
      innerHTML = null,
      propKey;
    for (propKey in props)
      if (hasOwnProperty.call(props, propKey)) {
        var propValue = props[propKey];
        if (null != propValue)
          switch (propKey) {
            case "children":
              children = propValue;
              break;
            case "dangerouslySetInnerHTML":
              innerHTML = propValue;
              break;
            default:
              pushAttribute(target, propKey, propValue);
          }
      }
    target.push(endOfStartTag);
    props = Array.isArray(children) ? (2 > children.length ? children[0] : null) : children;
    "function" !== typeof props &&
      "symbol" !== typeof props &&
      null !== props &&
      void 0 !== props &&
      target.push(stringToChunk(escapeTextForBrowser("" + props)));
    pushInnerHTML(target, innerHTML, children);
    target.push(endChunkForTag("title"));
    return null;
  }
  var headPreambleContributionChunk = stringToPrecomputedChunk("<!--head-->"),
    bodyPreambleContributionChunk = stringToPrecomputedChunk("<!--body-->"),
    htmlPreambleContributionChunk = stringToPrecomputedChunk("<!--html-->");
  function pushScriptImpl(target, props) {
    target.push(startChunkForTag("script"));
    var children = null,
      innerHTML = null,
      propKey;
    for (propKey in props)
      if (hasOwnProperty.call(props, propKey)) {
        var propValue = props[propKey];
        if (null != propValue)
          switch (propKey) {
            case "children":
              children = propValue;
              break;
            case "dangerouslySetInnerHTML":
              innerHTML = propValue;
              break;
            default:
              pushAttribute(target, propKey, propValue);
          }
      }
    target.push(endOfStartTag);
    pushInnerHTML(target, innerHTML, children);
    "string" === typeof children &&
      target.push(stringToChunk(("" + children).replace(scriptRegex, scriptReplacer)));
    target.push(endChunkForTag("script"));
    return null;
  }
  function pushStartSingletonElement(target, props, tag) {
    target.push(startChunkForTag(tag));
    var innerHTML = (tag = null),
      propKey;
    for (propKey in props)
      if (hasOwnProperty.call(props, propKey)) {
        var propValue = props[propKey];
        if (null != propValue)
          switch (propKey) {
            case "children":
              tag = propValue;
              break;
            case "dangerouslySetInnerHTML":
              innerHTML = propValue;
              break;
            default:
              pushAttribute(target, propKey, propValue);
          }
      }
    target.push(endOfStartTag);
    pushInnerHTML(target, innerHTML, tag);
    return tag;
  }
  function pushStartGenericElement(target, props, tag) {
    target.push(startChunkForTag(tag));
    var innerHTML = (tag = null),
      propKey;
    for (propKey in props)
      if (hasOwnProperty.call(props, propKey)) {
        var propValue = props[propKey];
        if (null != propValue)
          switch (propKey) {
            case "children":
              tag = propValue;
              break;
            case "dangerouslySetInnerHTML":
              innerHTML = propValue;
              break;
            default:
              pushAttribute(target, propKey, propValue);
          }
      }
    target.push(endOfStartTag);
    pushInnerHTML(target, innerHTML, tag);
    return "string" === typeof tag
      ? (target.push(stringToChunk(escapeTextForBrowser(tag))), null)
      : tag;
  }
  var leadingNewline = stringToPrecomputedChunk("\n"),
    VALID_TAG_REGEX = /^[a-zA-Z][a-zA-Z:_\.\-\d]*$/,
    validatedTagCache = /* @__PURE__ */ new Map();
  function startChunkForTag(tag) {
    var tagStartChunk = validatedTagCache.get(tag);
    if (void 0 === tagStartChunk) {
      if (!VALID_TAG_REGEX.test(tag)) throw Error("Invalid tag: " + tag);
      tagStartChunk = stringToPrecomputedChunk("<" + tag);
      validatedTagCache.set(tag, tagStartChunk);
    }
    return tagStartChunk;
  }
  var doctypeChunk = stringToPrecomputedChunk("<!DOCTYPE html>");
  function pushStartInstance(
    target$jscomp$0,
    type,
    props,
    resumableState,
    renderState,
    preambleState,
    hoistableState,
    formatContext,
    textEmbedded,
  ) {
    switch (type) {
      case "div":
      case "span":
      case "svg":
      case "path":
        break;
      case "a":
        target$jscomp$0.push(startChunkForTag("a"));
        var children = null,
          innerHTML = null,
          propKey;
        for (propKey in props)
          if (hasOwnProperty.call(props, propKey)) {
            var propValue = props[propKey];
            if (null != propValue)
              switch (propKey) {
                case "children":
                  children = propValue;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML = propValue;
                  break;
                case "href":
                  "" === propValue
                    ? pushStringAttribute(target$jscomp$0, "href", "")
                    : pushAttribute(target$jscomp$0, propKey, propValue);
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey, propValue);
              }
          }
        target$jscomp$0.push(endOfStartTag);
        pushInnerHTML(target$jscomp$0, innerHTML, children);
        if ("string" === typeof children) {
          target$jscomp$0.push(stringToChunk(escapeTextForBrowser(children)));
          var JSCompiler_inline_result = null;
        } else JSCompiler_inline_result = children;
        return JSCompiler_inline_result;
      case "g":
      case "p":
      case "li":
        break;
      case "select":
        target$jscomp$0.push(startChunkForTag("select"));
        var children$jscomp$0 = null,
          innerHTML$jscomp$0 = null,
          propKey$jscomp$0;
        for (propKey$jscomp$0 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$0)) {
            var propValue$jscomp$0 = props[propKey$jscomp$0];
            if (null != propValue$jscomp$0)
              switch (propKey$jscomp$0) {
                case "children":
                  children$jscomp$0 = propValue$jscomp$0;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML$jscomp$0 = propValue$jscomp$0;
                  break;
                case "defaultValue":
                case "value":
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$0, propValue$jscomp$0);
              }
          }
        target$jscomp$0.push(endOfStartTag);
        pushInnerHTML(target$jscomp$0, innerHTML$jscomp$0, children$jscomp$0);
        return children$jscomp$0;
      case "option":
        var selectedValue = formatContext.selectedValue;
        target$jscomp$0.push(startChunkForTag("option"));
        var children$jscomp$1 = null,
          value = null,
          selected = null,
          innerHTML$jscomp$1 = null,
          propKey$jscomp$1;
        for (propKey$jscomp$1 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$1)) {
            var propValue$jscomp$1 = props[propKey$jscomp$1];
            if (null != propValue$jscomp$1)
              switch (propKey$jscomp$1) {
                case "children":
                  children$jscomp$1 = propValue$jscomp$1;
                  break;
                case "selected":
                  selected = propValue$jscomp$1;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML$jscomp$1 = propValue$jscomp$1;
                  break;
                case "value":
                  value = propValue$jscomp$1;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$1, propValue$jscomp$1);
              }
          }
        if (null != selectedValue) {
          var stringValue = null !== value ? "" + value : flattenOptionChildren(children$jscomp$1);
          if (isArrayImpl(selectedValue))
            for (var i = 0; i < selectedValue.length; i++) {
              if ("" + selectedValue[i] === stringValue) {
                target$jscomp$0.push(selectedMarkerAttribute);
                break;
              }
            }
          else "" + selectedValue === stringValue && target$jscomp$0.push(selectedMarkerAttribute);
        } else selected && target$jscomp$0.push(selectedMarkerAttribute);
        target$jscomp$0.push(endOfStartTag);
        pushInnerHTML(target$jscomp$0, innerHTML$jscomp$1, children$jscomp$1);
        return children$jscomp$1;
      case "textarea":
        target$jscomp$0.push(startChunkForTag("textarea"));
        var value$jscomp$0 = null,
          defaultValue = null,
          children$jscomp$2 = null,
          propKey$jscomp$2;
        for (propKey$jscomp$2 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$2)) {
            var propValue$jscomp$2 = props[propKey$jscomp$2];
            if (null != propValue$jscomp$2)
              switch (propKey$jscomp$2) {
                case "children":
                  children$jscomp$2 = propValue$jscomp$2;
                  break;
                case "value":
                  value$jscomp$0 = propValue$jscomp$2;
                  break;
                case "defaultValue":
                  defaultValue = propValue$jscomp$2;
                  break;
                case "dangerouslySetInnerHTML":
                  throw Error("`dangerouslySetInnerHTML` does not make sense on <textarea>.");
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$2, propValue$jscomp$2);
              }
          }
        null === value$jscomp$0 && null !== defaultValue && (value$jscomp$0 = defaultValue);
        target$jscomp$0.push(endOfStartTag);
        if (null != children$jscomp$2) {
          if (null != value$jscomp$0)
            throw Error("If you supply `defaultValue` on a <textarea>, do not pass children.");
          if (isArrayImpl(children$jscomp$2)) {
            if (1 < children$jscomp$2.length)
              throw Error("<textarea> can only have at most one child.");
            value$jscomp$0 = "" + children$jscomp$2[0];
          }
          value$jscomp$0 = "" + children$jscomp$2;
        }
        "string" === typeof value$jscomp$0 &&
          "\n" === value$jscomp$0[0] &&
          target$jscomp$0.push(leadingNewline);
        null !== value$jscomp$0 &&
          target$jscomp$0.push(stringToChunk(escapeTextForBrowser("" + value$jscomp$0)));
        return null;
      case "input":
        target$jscomp$0.push(startChunkForTag("input"));
        var name = null,
          formAction = null,
          formEncType = null,
          formMethod = null,
          formTarget = null,
          value$jscomp$1 = null,
          defaultValue$jscomp$0 = null,
          checked = null,
          defaultChecked = null,
          propKey$jscomp$3;
        for (propKey$jscomp$3 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$3)) {
            var propValue$jscomp$3 = props[propKey$jscomp$3];
            if (null != propValue$jscomp$3)
              switch (propKey$jscomp$3) {
                case "children":
                case "dangerouslySetInnerHTML":
                  throw Error(
                    "input is a self-closing tag and must neither have `children` nor use `dangerouslySetInnerHTML`.",
                  );
                case "name":
                  name = propValue$jscomp$3;
                  break;
                case "formAction":
                  formAction = propValue$jscomp$3;
                  break;
                case "formEncType":
                  formEncType = propValue$jscomp$3;
                  break;
                case "formMethod":
                  formMethod = propValue$jscomp$3;
                  break;
                case "formTarget":
                  formTarget = propValue$jscomp$3;
                  break;
                case "defaultChecked":
                  defaultChecked = propValue$jscomp$3;
                  break;
                case "defaultValue":
                  defaultValue$jscomp$0 = propValue$jscomp$3;
                  break;
                case "checked":
                  checked = propValue$jscomp$3;
                  break;
                case "value":
                  value$jscomp$1 = propValue$jscomp$3;
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$3, propValue$jscomp$3);
              }
          }
        var formData = pushFormActionAttribute(
          target$jscomp$0,
          resumableState,
          renderState,
          formAction,
          formEncType,
          formMethod,
          formTarget,
          name,
        );
        null !== checked
          ? pushBooleanAttribute(target$jscomp$0, "checked", checked)
          : null !== defaultChecked &&
            pushBooleanAttribute(target$jscomp$0, "checked", defaultChecked);
        null !== value$jscomp$1
          ? pushAttribute(target$jscomp$0, "value", value$jscomp$1)
          : null !== defaultValue$jscomp$0 &&
            pushAttribute(target$jscomp$0, "value", defaultValue$jscomp$0);
        target$jscomp$0.push(endOfStartTagSelfClosing);
        null != formData && formData.forEach(pushAdditionalFormField, target$jscomp$0);
        return null;
      case "button":
        target$jscomp$0.push(startChunkForTag("button"));
        var children$jscomp$3 = null,
          innerHTML$jscomp$2 = null,
          name$jscomp$0 = null,
          formAction$jscomp$0 = null,
          formEncType$jscomp$0 = null,
          formMethod$jscomp$0 = null,
          formTarget$jscomp$0 = null,
          propKey$jscomp$4;
        for (propKey$jscomp$4 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$4)) {
            var propValue$jscomp$4 = props[propKey$jscomp$4];
            if (null != propValue$jscomp$4)
              switch (propKey$jscomp$4) {
                case "children":
                  children$jscomp$3 = propValue$jscomp$4;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML$jscomp$2 = propValue$jscomp$4;
                  break;
                case "name":
                  name$jscomp$0 = propValue$jscomp$4;
                  break;
                case "formAction":
                  formAction$jscomp$0 = propValue$jscomp$4;
                  break;
                case "formEncType":
                  formEncType$jscomp$0 = propValue$jscomp$4;
                  break;
                case "formMethod":
                  formMethod$jscomp$0 = propValue$jscomp$4;
                  break;
                case "formTarget":
                  formTarget$jscomp$0 = propValue$jscomp$4;
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$4, propValue$jscomp$4);
              }
          }
        var formData$jscomp$0 = pushFormActionAttribute(
          target$jscomp$0,
          resumableState,
          renderState,
          formAction$jscomp$0,
          formEncType$jscomp$0,
          formMethod$jscomp$0,
          formTarget$jscomp$0,
          name$jscomp$0,
        );
        target$jscomp$0.push(endOfStartTag);
        null != formData$jscomp$0 &&
          formData$jscomp$0.forEach(pushAdditionalFormField, target$jscomp$0);
        pushInnerHTML(target$jscomp$0, innerHTML$jscomp$2, children$jscomp$3);
        if ("string" === typeof children$jscomp$3) {
          target$jscomp$0.push(stringToChunk(escapeTextForBrowser(children$jscomp$3)));
          var JSCompiler_inline_result$jscomp$0 = null;
        } else JSCompiler_inline_result$jscomp$0 = children$jscomp$3;
        return JSCompiler_inline_result$jscomp$0;
      case "form":
        target$jscomp$0.push(startChunkForTag("form"));
        var children$jscomp$4 = null,
          innerHTML$jscomp$3 = null,
          formAction$jscomp$1 = null,
          formEncType$jscomp$1 = null,
          formMethod$jscomp$1 = null,
          formTarget$jscomp$1 = null,
          propKey$jscomp$5;
        for (propKey$jscomp$5 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$5)) {
            var propValue$jscomp$5 = props[propKey$jscomp$5];
            if (null != propValue$jscomp$5)
              switch (propKey$jscomp$5) {
                case "children":
                  children$jscomp$4 = propValue$jscomp$5;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML$jscomp$3 = propValue$jscomp$5;
                  break;
                case "action":
                  formAction$jscomp$1 = propValue$jscomp$5;
                  break;
                case "encType":
                  formEncType$jscomp$1 = propValue$jscomp$5;
                  break;
                case "method":
                  formMethod$jscomp$1 = propValue$jscomp$5;
                  break;
                case "target":
                  formTarget$jscomp$1 = propValue$jscomp$5;
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$5, propValue$jscomp$5);
              }
          }
        var formData$jscomp$1 = null,
          formActionName = null;
        if ("function" === typeof formAction$jscomp$1) {
          var customFields = getCustomFormFields(resumableState, formAction$jscomp$1);
          null !== customFields
            ? ((formAction$jscomp$1 = customFields.action || ""),
              (formEncType$jscomp$1 = customFields.encType),
              (formMethod$jscomp$1 = customFields.method),
              (formTarget$jscomp$1 = customFields.target),
              (formData$jscomp$1 = customFields.data),
              (formActionName = customFields.name))
            : (target$jscomp$0.push(
                attributeSeparator,
                stringToChunk("action"),
                attributeAssign,
                actionJavaScriptURL,
                attributeEnd,
              ),
              (formTarget$jscomp$1 =
                formMethod$jscomp$1 =
                formEncType$jscomp$1 =
                formAction$jscomp$1 =
                  null),
              injectFormReplayingRuntime(resumableState, renderState));
        }
        null != formAction$jscomp$1 &&
          pushAttribute(target$jscomp$0, "action", formAction$jscomp$1);
        null != formEncType$jscomp$1 &&
          pushAttribute(target$jscomp$0, "encType", formEncType$jscomp$1);
        null != formMethod$jscomp$1 &&
          pushAttribute(target$jscomp$0, "method", formMethod$jscomp$1);
        null != formTarget$jscomp$1 &&
          pushAttribute(target$jscomp$0, "target", formTarget$jscomp$1);
        target$jscomp$0.push(endOfStartTag);
        null !== formActionName &&
          (target$jscomp$0.push(startHiddenInputChunk),
          pushStringAttribute(target$jscomp$0, "name", formActionName),
          target$jscomp$0.push(endOfStartTagSelfClosing),
          null != formData$jscomp$1 &&
            formData$jscomp$1.forEach(pushAdditionalFormField, target$jscomp$0));
        pushInnerHTML(target$jscomp$0, innerHTML$jscomp$3, children$jscomp$4);
        if ("string" === typeof children$jscomp$4) {
          target$jscomp$0.push(stringToChunk(escapeTextForBrowser(children$jscomp$4)));
          var JSCompiler_inline_result$jscomp$1 = null;
        } else JSCompiler_inline_result$jscomp$1 = children$jscomp$4;
        return JSCompiler_inline_result$jscomp$1;
      case "menuitem":
        target$jscomp$0.push(startChunkForTag("menuitem"));
        for (var propKey$jscomp$6 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$6)) {
            var propValue$jscomp$6 = props[propKey$jscomp$6];
            if (null != propValue$jscomp$6)
              switch (propKey$jscomp$6) {
                case "children":
                case "dangerouslySetInnerHTML":
                  throw Error("menuitems cannot have `children` nor `dangerouslySetInnerHTML`.");
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$6, propValue$jscomp$6);
              }
          }
        target$jscomp$0.push(endOfStartTag);
        return null;
      case "object":
        target$jscomp$0.push(startChunkForTag("object"));
        var children$jscomp$5 = null,
          innerHTML$jscomp$4 = null,
          propKey$jscomp$7;
        for (propKey$jscomp$7 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$7)) {
            var propValue$jscomp$7 = props[propKey$jscomp$7];
            if (null != propValue$jscomp$7)
              switch (propKey$jscomp$7) {
                case "children":
                  children$jscomp$5 = propValue$jscomp$7;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML$jscomp$4 = propValue$jscomp$7;
                  break;
                case "data":
                  var sanitizedValue = sanitizeURL("" + propValue$jscomp$7);
                  if ("" === sanitizedValue) break;
                  target$jscomp$0.push(
                    attributeSeparator,
                    stringToChunk("data"),
                    attributeAssign,
                    stringToChunk(escapeTextForBrowser(sanitizedValue)),
                    attributeEnd,
                  );
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$7, propValue$jscomp$7);
              }
          }
        target$jscomp$0.push(endOfStartTag);
        pushInnerHTML(target$jscomp$0, innerHTML$jscomp$4, children$jscomp$5);
        if ("string" === typeof children$jscomp$5) {
          target$jscomp$0.push(stringToChunk(escapeTextForBrowser(children$jscomp$5)));
          var JSCompiler_inline_result$jscomp$2 = null;
        } else JSCompiler_inline_result$jscomp$2 = children$jscomp$5;
        return JSCompiler_inline_result$jscomp$2;
      case "title":
        var noscriptTagInScope = formatContext.tagScope & 1,
          isFallback = formatContext.tagScope & 4;
        if (4 === formatContext.insertionMode || noscriptTagInScope || null != props.itemProp)
          var JSCompiler_inline_result$jscomp$3 = pushTitleImpl(target$jscomp$0, props);
        else
          isFallback
            ? (JSCompiler_inline_result$jscomp$3 = null)
            : (pushTitleImpl(renderState.hoistableChunks, props),
              (JSCompiler_inline_result$jscomp$3 = void 0));
        return JSCompiler_inline_result$jscomp$3;
      case "link":
        var noscriptTagInScope$jscomp$0 = formatContext.tagScope & 1,
          isFallback$jscomp$0 = formatContext.tagScope & 4,
          rel = props.rel,
          href = props.href,
          precedence = props.precedence;
        if (
          4 === formatContext.insertionMode ||
          noscriptTagInScope$jscomp$0 ||
          null != props.itemProp ||
          "string" !== typeof rel ||
          "string" !== typeof href ||
          "" === href
        ) {
          pushLinkImpl(target$jscomp$0, props);
          var JSCompiler_inline_result$jscomp$4 = null;
        } else if ("stylesheet" === props.rel)
          if (
            "string" !== typeof precedence ||
            null != props.disabled ||
            props.onLoad ||
            props.onError
          )
            JSCompiler_inline_result$jscomp$4 = pushLinkImpl(target$jscomp$0, props);
          else {
            var styleQueue = renderState.styles.get(precedence),
              resourceState = resumableState.styleResources.hasOwnProperty(href)
                ? resumableState.styleResources[href]
                : void 0;
            if (null !== resourceState) {
              resumableState.styleResources[href] = null;
              styleQueue ||
                ((styleQueue = {
                  precedence: stringToChunk(escapeTextForBrowser(precedence)),
                  rules: [],
                  hrefs: [],
                  sheets: /* @__PURE__ */ new Map(),
                }),
                renderState.styles.set(precedence, styleQueue));
              var resource = {
                state: 0,
                props: assign({}, props, {
                  "data-precedence": props.precedence,
                  precedence: null,
                }),
              };
              if (resourceState) {
                2 === resourceState.length &&
                  adoptPreloadCredentials(resource.props, resourceState);
                var preloadResource = renderState.preloads.stylesheets.get(href);
                preloadResource && 0 < preloadResource.length
                  ? (preloadResource.length = 0)
                  : (resource.state = 1);
              }
              styleQueue.sheets.set(href, resource);
              hoistableState && hoistableState.stylesheets.add(resource);
            } else if (styleQueue) {
              var resource$9 = styleQueue.sheets.get(href);
              resource$9 && hoistableState && hoistableState.stylesheets.add(resource$9);
            }
            textEmbedded && target$jscomp$0.push(textSeparator);
            JSCompiler_inline_result$jscomp$4 = null;
          }
        else
          props.onLoad || props.onError
            ? (JSCompiler_inline_result$jscomp$4 = pushLinkImpl(target$jscomp$0, props))
            : (textEmbedded && target$jscomp$0.push(textSeparator),
              (JSCompiler_inline_result$jscomp$4 = isFallback$jscomp$0
                ? null
                : pushLinkImpl(renderState.hoistableChunks, props)));
        return JSCompiler_inline_result$jscomp$4;
      case "script":
        var noscriptTagInScope$jscomp$1 = formatContext.tagScope & 1,
          asyncProp = props.async;
        if (
          "string" !== typeof props.src ||
          !props.src ||
          !asyncProp ||
          "function" === typeof asyncProp ||
          "symbol" === typeof asyncProp ||
          props.onLoad ||
          props.onError ||
          4 === formatContext.insertionMode ||
          noscriptTagInScope$jscomp$1 ||
          null != props.itemProp
        )
          var JSCompiler_inline_result$jscomp$5 = pushScriptImpl(target$jscomp$0, props);
        else {
          var key = props.src;
          if ("module" === props.type) {
            var resources = resumableState.moduleScriptResources;
            var preloads = renderState.preloads.moduleScripts;
          } else
            ((resources = resumableState.scriptResources),
              (preloads = renderState.preloads.scripts));
          var resourceState$jscomp$0 = resources.hasOwnProperty(key) ? resources[key] : void 0;
          if (null !== resourceState$jscomp$0) {
            resources[key] = null;
            var scriptProps = props;
            if (resourceState$jscomp$0) {
              2 === resourceState$jscomp$0.length &&
                ((scriptProps = assign({}, props)),
                adoptPreloadCredentials(scriptProps, resourceState$jscomp$0));
              var preloadResource$jscomp$0 = preloads.get(key);
              preloadResource$jscomp$0 && (preloadResource$jscomp$0.length = 0);
            }
            var resource$jscomp$0 = [];
            renderState.scripts.add(resource$jscomp$0);
            pushScriptImpl(resource$jscomp$0, scriptProps);
          }
          textEmbedded && target$jscomp$0.push(textSeparator);
          JSCompiler_inline_result$jscomp$5 = null;
        }
        return JSCompiler_inline_result$jscomp$5;
      case "style":
        var noscriptTagInScope$jscomp$2 = formatContext.tagScope & 1,
          precedence$jscomp$0 = props.precedence,
          href$jscomp$0 = props.href,
          nonce = props.nonce;
        if (
          4 === formatContext.insertionMode ||
          noscriptTagInScope$jscomp$2 ||
          null != props.itemProp ||
          "string" !== typeof precedence$jscomp$0 ||
          "string" !== typeof href$jscomp$0 ||
          "" === href$jscomp$0
        ) {
          target$jscomp$0.push(startChunkForTag("style"));
          var children$jscomp$6 = null,
            innerHTML$jscomp$5 = null,
            propKey$jscomp$8;
          for (propKey$jscomp$8 in props)
            if (hasOwnProperty.call(props, propKey$jscomp$8)) {
              var propValue$jscomp$8 = props[propKey$jscomp$8];
              if (null != propValue$jscomp$8)
                switch (propKey$jscomp$8) {
                  case "children":
                    children$jscomp$6 = propValue$jscomp$8;
                    break;
                  case "dangerouslySetInnerHTML":
                    innerHTML$jscomp$5 = propValue$jscomp$8;
                    break;
                  default:
                    pushAttribute(target$jscomp$0, propKey$jscomp$8, propValue$jscomp$8);
                }
            }
          target$jscomp$0.push(endOfStartTag);
          var child = Array.isArray(children$jscomp$6)
            ? 2 > children$jscomp$6.length
              ? children$jscomp$6[0]
              : null
            : children$jscomp$6;
          "function" !== typeof child &&
            "symbol" !== typeof child &&
            null !== child &&
            void 0 !== child &&
            target$jscomp$0.push(stringToChunk(("" + child).replace(styleRegex, styleReplacer)));
          pushInnerHTML(target$jscomp$0, innerHTML$jscomp$5, children$jscomp$6);
          target$jscomp$0.push(endChunkForTag("style"));
          var JSCompiler_inline_result$jscomp$6 = null;
        } else {
          var styleQueue$jscomp$0 = renderState.styles.get(precedence$jscomp$0);
          if (
            null !==
            (resumableState.styleResources.hasOwnProperty(href$jscomp$0)
              ? resumableState.styleResources[href$jscomp$0]
              : void 0)
          ) {
            resumableState.styleResources[href$jscomp$0] = null;
            styleQueue$jscomp$0 ||
              ((styleQueue$jscomp$0 = {
                precedence: stringToChunk(escapeTextForBrowser(precedence$jscomp$0)),
                rules: [],
                hrefs: [],
                sheets: /* @__PURE__ */ new Map(),
              }),
              renderState.styles.set(precedence$jscomp$0, styleQueue$jscomp$0));
            var nonceStyle = renderState.nonce.style;
            if (!nonceStyle || nonceStyle === nonce) {
              styleQueue$jscomp$0.hrefs.push(stringToChunk(escapeTextForBrowser(href$jscomp$0)));
              var target = styleQueue$jscomp$0.rules,
                children$jscomp$7 = null,
                innerHTML$jscomp$6 = null,
                propKey$jscomp$9;
              for (propKey$jscomp$9 in props)
                if (hasOwnProperty.call(props, propKey$jscomp$9)) {
                  var propValue$jscomp$9 = props[propKey$jscomp$9];
                  if (null != propValue$jscomp$9)
                    switch (propKey$jscomp$9) {
                      case "children":
                        children$jscomp$7 = propValue$jscomp$9;
                        break;
                      case "dangerouslySetInnerHTML":
                        innerHTML$jscomp$6 = propValue$jscomp$9;
                    }
                }
              var child$jscomp$0 = Array.isArray(children$jscomp$7)
                ? 2 > children$jscomp$7.length
                  ? children$jscomp$7[0]
                  : null
                : children$jscomp$7;
              "function" !== typeof child$jscomp$0 &&
                "symbol" !== typeof child$jscomp$0 &&
                null !== child$jscomp$0 &&
                void 0 !== child$jscomp$0 &&
                target.push(
                  stringToChunk(("" + child$jscomp$0).replace(styleRegex, styleReplacer)),
                );
              pushInnerHTML(target, innerHTML$jscomp$6, children$jscomp$7);
            }
          }
          styleQueue$jscomp$0 && hoistableState && hoistableState.styles.add(styleQueue$jscomp$0);
          textEmbedded && target$jscomp$0.push(textSeparator);
          JSCompiler_inline_result$jscomp$6 = void 0;
        }
        return JSCompiler_inline_result$jscomp$6;
      case "meta":
        var noscriptTagInScope$jscomp$3 = formatContext.tagScope & 1,
          isFallback$jscomp$1 = formatContext.tagScope & 4;
        if (
          4 === formatContext.insertionMode ||
          noscriptTagInScope$jscomp$3 ||
          null != props.itemProp
        )
          var JSCompiler_inline_result$jscomp$7 = pushSelfClosing(target$jscomp$0, props, "meta");
        else
          (textEmbedded && target$jscomp$0.push(textSeparator),
            (JSCompiler_inline_result$jscomp$7 = isFallback$jscomp$1
              ? null
              : "string" === typeof props.charSet
                ? pushSelfClosing(renderState.charsetChunks, props, "meta")
                : "viewport" === props.name
                  ? pushSelfClosing(renderState.viewportChunks, props, "meta")
                  : pushSelfClosing(renderState.hoistableChunks, props, "meta")));
        return JSCompiler_inline_result$jscomp$7;
      case "listing":
      case "pre":
        target$jscomp$0.push(startChunkForTag(type));
        var children$jscomp$8 = null,
          innerHTML$jscomp$7 = null,
          propKey$jscomp$10;
        for (propKey$jscomp$10 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$10)) {
            var propValue$jscomp$10 = props[propKey$jscomp$10];
            if (null != propValue$jscomp$10)
              switch (propKey$jscomp$10) {
                case "children":
                  children$jscomp$8 = propValue$jscomp$10;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML$jscomp$7 = propValue$jscomp$10;
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$10, propValue$jscomp$10);
              }
          }
        target$jscomp$0.push(endOfStartTag);
        if (null != innerHTML$jscomp$7) {
          if (null != children$jscomp$8)
            throw Error("Can only set one of `children` or `props.dangerouslySetInnerHTML`.");
          if ("object" !== typeof innerHTML$jscomp$7 || !("__html" in innerHTML$jscomp$7))
            throw Error(
              "`props.dangerouslySetInnerHTML` must be in the form `{__html: ...}`. Please visit https://react.dev/link/dangerously-set-inner-html for more information.",
            );
          var html = innerHTML$jscomp$7.__html;
          null !== html &&
            void 0 !== html &&
            ("string" === typeof html && 0 < html.length && "\n" === html[0]
              ? target$jscomp$0.push(leadingNewline, stringToChunk(html))
              : target$jscomp$0.push(stringToChunk("" + html)));
        }
        "string" === typeof children$jscomp$8 &&
          "\n" === children$jscomp$8[0] &&
          target$jscomp$0.push(leadingNewline);
        return children$jscomp$8;
      case "img":
        var pictureOrNoScriptTagInScope = formatContext.tagScope & 3,
          src = props.src,
          srcSet = props.srcSet;
        if (
          !(
            "lazy" === props.loading ||
            (!src && !srcSet) ||
            ("string" !== typeof src && null != src) ||
            ("string" !== typeof srcSet && null != srcSet) ||
            "low" === props.fetchPriority ||
            pictureOrNoScriptTagInScope
          ) &&
          ("string" !== typeof src ||
            ":" !== src[4] ||
            ("d" !== src[0] && "D" !== src[0]) ||
            ("a" !== src[1] && "A" !== src[1]) ||
            ("t" !== src[2] && "T" !== src[2]) ||
            ("a" !== src[3] && "A" !== src[3])) &&
          ("string" !== typeof srcSet ||
            ":" !== srcSet[4] ||
            ("d" !== srcSet[0] && "D" !== srcSet[0]) ||
            ("a" !== srcSet[1] && "A" !== srcSet[1]) ||
            ("t" !== srcSet[2] && "T" !== srcSet[2]) ||
            ("a" !== srcSet[3] && "A" !== srcSet[3]))
        ) {
          null !== hoistableState &&
            formatContext.tagScope & 64 &&
            (hoistableState.suspenseyImages = true);
          var sizes = "string" === typeof props.sizes ? props.sizes : void 0,
            key$jscomp$0 = srcSet ? srcSet + "\n" + (sizes || "") : src,
            promotablePreloads = renderState.preloads.images,
            resource$jscomp$1 = promotablePreloads.get(key$jscomp$0);
          if (resource$jscomp$1) {
            if ("high" === props.fetchPriority || 10 > renderState.highImagePreloads.size)
              (promotablePreloads.delete(key$jscomp$0),
                renderState.highImagePreloads.add(resource$jscomp$1));
          } else if (!resumableState.imageResources.hasOwnProperty(key$jscomp$0)) {
            resumableState.imageResources[key$jscomp$0] = PRELOAD_NO_CREDS;
            var input = props.crossOrigin;
            var JSCompiler_inline_result$jscomp$8 =
              "string" === typeof input ? ("use-credentials" === input ? input : "") : void 0;
            var headers = renderState.headers,
              header;
            headers &&
            0 < headers.remainingCapacity &&
            "string" !== typeof props.srcSet &&
            ("high" === props.fetchPriority || 500 > headers.highImagePreloads.length) &&
            ((header = getPreloadAsHeader(src, "image", {
              imageSrcSet: props.srcSet,
              imageSizes: props.sizes,
              crossOrigin: JSCompiler_inline_result$jscomp$8,
              integrity: props.integrity,
              nonce: props.nonce,
              type: props.type,
              fetchPriority: props.fetchPriority,
              referrerPolicy: props.refererPolicy,
            })),
            0 <= (headers.remainingCapacity -= header.length + 2))
              ? ((renderState.resets.image[key$jscomp$0] = PRELOAD_NO_CREDS),
                headers.highImagePreloads && (headers.highImagePreloads += ", "),
                (headers.highImagePreloads += header))
              : ((resource$jscomp$1 = []),
                pushLinkImpl(resource$jscomp$1, {
                  rel: "preload",
                  as: "image",
                  href: srcSet ? void 0 : src,
                  imageSrcSet: srcSet,
                  imageSizes: sizes,
                  crossOrigin: JSCompiler_inline_result$jscomp$8,
                  integrity: props.integrity,
                  type: props.type,
                  fetchPriority: props.fetchPriority,
                  referrerPolicy: props.referrerPolicy,
                }),
                "high" === props.fetchPriority || 10 > renderState.highImagePreloads.size
                  ? renderState.highImagePreloads.add(resource$jscomp$1)
                  : (renderState.bulkPreloads.add(resource$jscomp$1),
                    promotablePreloads.set(key$jscomp$0, resource$jscomp$1)));
          }
        }
        return pushSelfClosing(target$jscomp$0, props, "img");
      case "base":
      case "area":
      case "br":
      case "col":
      case "embed":
      case "hr":
      case "keygen":
      case "param":
      case "source":
      case "track":
      case "wbr":
        return pushSelfClosing(target$jscomp$0, props, type);
      case "annotation-xml":
      case "color-profile":
      case "font-face":
      case "font-face-src":
      case "font-face-uri":
      case "font-face-format":
      case "font-face-name":
      case "missing-glyph":
        break;
      case "head":
        if (2 > formatContext.insertionMode) {
          var preamble = preambleState || renderState.preamble;
          if (preamble.headChunks) throw Error("The `<head>` tag may only be rendered once.");
          null !== preambleState && target$jscomp$0.push(headPreambleContributionChunk);
          preamble.headChunks = [];
          var JSCompiler_inline_result$jscomp$9 = pushStartSingletonElement(
            preamble.headChunks,
            props,
            "head",
          );
        } else
          JSCompiler_inline_result$jscomp$9 = pushStartGenericElement(
            target$jscomp$0,
            props,
            "head",
          );
        return JSCompiler_inline_result$jscomp$9;
      case "body":
        if (2 > formatContext.insertionMode) {
          var preamble$jscomp$0 = preambleState || renderState.preamble;
          if (preamble$jscomp$0.bodyChunks)
            throw Error("The `<body>` tag may only be rendered once.");
          null !== preambleState && target$jscomp$0.push(bodyPreambleContributionChunk);
          preamble$jscomp$0.bodyChunks = [];
          var JSCompiler_inline_result$jscomp$10 = pushStartSingletonElement(
            preamble$jscomp$0.bodyChunks,
            props,
            "body",
          );
        } else
          JSCompiler_inline_result$jscomp$10 = pushStartGenericElement(
            target$jscomp$0,
            props,
            "body",
          );
        return JSCompiler_inline_result$jscomp$10;
      case "html":
        if (0 === formatContext.insertionMode) {
          var preamble$jscomp$1 = preambleState || renderState.preamble;
          if (preamble$jscomp$1.htmlChunks)
            throw Error("The `<html>` tag may only be rendered once.");
          null !== preambleState && target$jscomp$0.push(htmlPreambleContributionChunk);
          preamble$jscomp$1.htmlChunks = [doctypeChunk];
          var JSCompiler_inline_result$jscomp$11 = pushStartSingletonElement(
            preamble$jscomp$1.htmlChunks,
            props,
            "html",
          );
        } else
          JSCompiler_inline_result$jscomp$11 = pushStartGenericElement(
            target$jscomp$0,
            props,
            "html",
          );
        return JSCompiler_inline_result$jscomp$11;
      default:
        if (-1 !== type.indexOf("-")) {
          target$jscomp$0.push(startChunkForTag(type));
          var children$jscomp$9 = null,
            innerHTML$jscomp$8 = null,
            propKey$jscomp$11;
          for (propKey$jscomp$11 in props)
            if (hasOwnProperty.call(props, propKey$jscomp$11)) {
              var propValue$jscomp$11 = props[propKey$jscomp$11];
              if (null != propValue$jscomp$11) {
                var attributeName = propKey$jscomp$11;
                switch (propKey$jscomp$11) {
                  case "children":
                    children$jscomp$9 = propValue$jscomp$11;
                    break;
                  case "dangerouslySetInnerHTML":
                    innerHTML$jscomp$8 = propValue$jscomp$11;
                    break;
                  case "style":
                    pushStyleAttribute(target$jscomp$0, propValue$jscomp$11);
                    break;
                  case "suppressContentEditableWarning":
                  case "suppressHydrationWarning":
                  case "ref":
                    break;
                  case "className":
                    attributeName = "class";
                  default:
                    if (
                      isAttributeNameSafe(propKey$jscomp$11) &&
                      "function" !== typeof propValue$jscomp$11 &&
                      "symbol" !== typeof propValue$jscomp$11 &&
                      false !== propValue$jscomp$11
                    ) {
                      if (true === propValue$jscomp$11) propValue$jscomp$11 = "";
                      else if ("object" === typeof propValue$jscomp$11) continue;
                      target$jscomp$0.push(
                        attributeSeparator,
                        stringToChunk(attributeName),
                        attributeAssign,
                        stringToChunk(escapeTextForBrowser(propValue$jscomp$11)),
                        attributeEnd,
                      );
                    }
                }
              }
            }
          target$jscomp$0.push(endOfStartTag);
          pushInnerHTML(target$jscomp$0, innerHTML$jscomp$8, children$jscomp$9);
          return children$jscomp$9;
        }
    }
    return pushStartGenericElement(target$jscomp$0, props, type);
  }
  var endTagCache = /* @__PURE__ */ new Map();
  function endChunkForTag(tag) {
    var chunk = endTagCache.get(tag);
    void 0 === chunk &&
      ((chunk = stringToPrecomputedChunk("</" + tag + ">")), endTagCache.set(tag, chunk));
    return chunk;
  }
  function hoistPreambleState(renderState, preambleState) {
    renderState = renderState.preamble;
    null === renderState.htmlChunks &&
      preambleState.htmlChunks &&
      (renderState.htmlChunks = preambleState.htmlChunks);
    null === renderState.headChunks &&
      preambleState.headChunks &&
      (renderState.headChunks = preambleState.headChunks);
    null === renderState.bodyChunks &&
      preambleState.bodyChunks &&
      (renderState.bodyChunks = preambleState.bodyChunks);
  }
  function writeBootstrap(destination, renderState) {
    renderState = renderState.bootstrapChunks;
    for (var i = 0; i < renderState.length - 1; i++) writeChunk(destination, renderState[i]);
    return i < renderState.length
      ? ((i = renderState[i]), (renderState.length = 0), writeChunkAndReturn(destination, i))
      : true;
  }
  var shellTimeRuntimeScript = stringToPrecomputedChunk(
      "requestAnimationFrame(function(){$RT=performance.now()});",
    ),
    placeholder1 = stringToPrecomputedChunk('<template id="'),
    placeholder2 = stringToPrecomputedChunk('"></template>'),
    startActivityBoundary = stringToPrecomputedChunk("<!--&-->"),
    endActivityBoundary = stringToPrecomputedChunk("<!--/&-->"),
    startCompletedSuspenseBoundary = stringToPrecomputedChunk("<!--$-->"),
    startPendingSuspenseBoundary1 = stringToPrecomputedChunk('<!--$?--><template id="'),
    startPendingSuspenseBoundary2 = stringToPrecomputedChunk('"></template>'),
    startClientRenderedSuspenseBoundary = stringToPrecomputedChunk("<!--$!-->"),
    endSuspenseBoundary = stringToPrecomputedChunk("<!--/$-->"),
    clientRenderedSuspenseBoundaryError1 = stringToPrecomputedChunk("<template"),
    clientRenderedSuspenseBoundaryErrorAttrInterstitial = stringToPrecomputedChunk('"'),
    clientRenderedSuspenseBoundaryError1A = stringToPrecomputedChunk(' data-dgst="');
  stringToPrecomputedChunk(' data-msg="');
  stringToPrecomputedChunk(' data-stck="');
  stringToPrecomputedChunk(' data-cstck="');
  var clientRenderedSuspenseBoundaryError2 = stringToPrecomputedChunk("></template>");
  function writeStartPendingSuspenseBoundary(destination, renderState, id) {
    writeChunk(destination, startPendingSuspenseBoundary1);
    if (null === id)
      throw Error("An ID must have been assigned before we can complete the boundary.");
    writeChunk(destination, renderState.boundaryPrefix);
    writeChunk(destination, stringToChunk(id.toString(16)));
    return writeChunkAndReturn(destination, startPendingSuspenseBoundary2);
  }
  var startSegmentHTML = stringToPrecomputedChunk('<div hidden id="'),
    startSegmentHTML2 = stringToPrecomputedChunk('">'),
    endSegmentHTML = stringToPrecomputedChunk("</div>"),
    startSegmentSVG = stringToPrecomputedChunk('<svg aria-hidden="true" style="display:none" id="'),
    startSegmentSVG2 = stringToPrecomputedChunk('">'),
    endSegmentSVG = stringToPrecomputedChunk("</svg>"),
    startSegmentMathML = stringToPrecomputedChunk(
      '<math aria-hidden="true" style="display:none" id="',
    ),
    startSegmentMathML2 = stringToPrecomputedChunk('">'),
    endSegmentMathML = stringToPrecomputedChunk("</math>"),
    startSegmentTable = stringToPrecomputedChunk('<table hidden id="'),
    startSegmentTable2 = stringToPrecomputedChunk('">'),
    endSegmentTable = stringToPrecomputedChunk("</table>"),
    startSegmentTableBody = stringToPrecomputedChunk('<table hidden><tbody id="'),
    startSegmentTableBody2 = stringToPrecomputedChunk('">'),
    endSegmentTableBody = stringToPrecomputedChunk("</tbody></table>"),
    startSegmentTableRow = stringToPrecomputedChunk('<table hidden><tr id="'),
    startSegmentTableRow2 = stringToPrecomputedChunk('">'),
    endSegmentTableRow = stringToPrecomputedChunk("</tr></table>"),
    startSegmentColGroup = stringToPrecomputedChunk('<table hidden><colgroup id="'),
    startSegmentColGroup2 = stringToPrecomputedChunk('">'),
    endSegmentColGroup = stringToPrecomputedChunk("</colgroup></table>");
  function writeStartSegment(destination, renderState, formatContext, id) {
    switch (formatContext.insertionMode) {
      case 0:
      case 1:
      case 3:
      case 2:
        return (
          writeChunk(destination, startSegmentHTML),
          writeChunk(destination, renderState.segmentPrefix),
          writeChunk(destination, stringToChunk(id.toString(16))),
          writeChunkAndReturn(destination, startSegmentHTML2)
        );
      case 4:
        return (
          writeChunk(destination, startSegmentSVG),
          writeChunk(destination, renderState.segmentPrefix),
          writeChunk(destination, stringToChunk(id.toString(16))),
          writeChunkAndReturn(destination, startSegmentSVG2)
        );
      case 5:
        return (
          writeChunk(destination, startSegmentMathML),
          writeChunk(destination, renderState.segmentPrefix),
          writeChunk(destination, stringToChunk(id.toString(16))),
          writeChunkAndReturn(destination, startSegmentMathML2)
        );
      case 6:
        return (
          writeChunk(destination, startSegmentTable),
          writeChunk(destination, renderState.segmentPrefix),
          writeChunk(destination, stringToChunk(id.toString(16))),
          writeChunkAndReturn(destination, startSegmentTable2)
        );
      case 7:
        return (
          writeChunk(destination, startSegmentTableBody),
          writeChunk(destination, renderState.segmentPrefix),
          writeChunk(destination, stringToChunk(id.toString(16))),
          writeChunkAndReturn(destination, startSegmentTableBody2)
        );
      case 8:
        return (
          writeChunk(destination, startSegmentTableRow),
          writeChunk(destination, renderState.segmentPrefix),
          writeChunk(destination, stringToChunk(id.toString(16))),
          writeChunkAndReturn(destination, startSegmentTableRow2)
        );
      case 9:
        return (
          writeChunk(destination, startSegmentColGroup),
          writeChunk(destination, renderState.segmentPrefix),
          writeChunk(destination, stringToChunk(id.toString(16))),
          writeChunkAndReturn(destination, startSegmentColGroup2)
        );
      default:
        throw Error("Unknown insertion mode. This is a bug in React.");
    }
  }
  function writeEndSegment(destination, formatContext) {
    switch (formatContext.insertionMode) {
      case 0:
      case 1:
      case 3:
      case 2:
        return writeChunkAndReturn(destination, endSegmentHTML);
      case 4:
        return writeChunkAndReturn(destination, endSegmentSVG);
      case 5:
        return writeChunkAndReturn(destination, endSegmentMathML);
      case 6:
        return writeChunkAndReturn(destination, endSegmentTable);
      case 7:
        return writeChunkAndReturn(destination, endSegmentTableBody);
      case 8:
        return writeChunkAndReturn(destination, endSegmentTableRow);
      case 9:
        return writeChunkAndReturn(destination, endSegmentColGroup);
      default:
        throw Error("Unknown insertion mode. This is a bug in React.");
    }
  }
  var completeSegmentScript1Full = stringToPrecomputedChunk(
      '$RS=function(a,b){a=document.getElementById(a);b=document.getElementById(b);for(a.parentNode.removeChild(a);a.firstChild;)b.parentNode.insertBefore(a.firstChild,b);b.parentNode.removeChild(b)};$RS("',
    ),
    completeSegmentScript1Partial = stringToPrecomputedChunk('$RS("'),
    completeSegmentScript2 = stringToPrecomputedChunk('","'),
    completeSegmentScriptEnd = stringToPrecomputedChunk('")<\/script>');
  stringToPrecomputedChunk('<template data-rsi="" data-sid="');
  stringToPrecomputedChunk('" data-pid="');
  var completeBoundaryScriptFunctionOnly = stringToPrecomputedChunk(
    '$RB=[];$RV=function(a){$RT=performance.now();for(var b=0;b<a.length;b+=2){var c=a[b],e=a[b+1];null!==e.parentNode&&e.parentNode.removeChild(e);var f=c.parentNode;if(f){var g=c.previousSibling,h=0;do{if(c&&8===c.nodeType){var d=c.data;if("/$"===d||"/&"===d)if(0===h)break;else h--;else"$"!==d&&"$?"!==d&&"$~"!==d&&"$!"!==d&&"&"!==d||h++}d=c.nextSibling;f.removeChild(c);c=d}while(c);for(;e.firstChild;)f.insertBefore(e.firstChild,c);g.data="$";g._reactRetry&&requestAnimationFrame(g._reactRetry)}}a.length=0};\n$RC=function(a,b){if(b=document.getElementById(b))(a=document.getElementById(a))?(a.previousSibling.data="$~",$RB.push(a,b),2===$RB.length&&("number"!==typeof $RT?requestAnimationFrame($RV.bind(null,$RB)):(a=performance.now(),setTimeout($RV.bind(null,$RB),2300>a&&2E3<a?2300-a:$RT+300-a)))):b.parentNode.removeChild(b)};',
  );
  stringToChunk(
    `$RV=function(A,g){function k(a,b){var e=a.getAttribute(b);e&&(b=a.style,l.push(a,b.viewTransitionName,b.viewTransitionClass),"auto"!==e&&(b.viewTransitionClass=e),(a=a.getAttribute("vt-name"))||(a="_T_"+K++ +"_"),b.viewTransitionName=a,B=!0)}var B=!1,K=0,l=[];try{var f=document.__reactViewTransition;if(f){f.finished.finally($RV.bind(null,g));return}var m=new Map;for(f=1;f<g.length;f+=2)for(var h=g[f].querySelectorAll("[vt-share]"),d=0;d<h.length;d++){var c=h[d];m.set(c.getAttribute("vt-name"),c)}var u=[];for(h=0;h<g.length;h+=2){var C=g[h],x=C.parentNode;if(x){var v=x.getBoundingClientRect();if(v.left||v.top||v.width||v.height){c=C;for(f=0;c;){if(8===c.nodeType){var r=c.data;if("/$"===r)if(0===f)break;else f--;else"$"!==r&&"$?"!==r&&"$~"!==r&&"$!"!==r||f++}else if(1===c.nodeType){d=c;var D=d.getAttribute("vt-name"),y=m.get(D);k(d,y?"vt-share":"vt-exit");y&&(k(y,"vt-share"),m.set(D,null));var E=d.querySelectorAll("[vt-share]");for(d=0;d<E.length;d++){var F=E[d],G=F.getAttribute("vt-name"),
H=m.get(G);H&&(k(F,"vt-share"),k(H,"vt-share"),m.set(G,null))}}c=c.nextSibling}for(var I=g[h+1],t=I.firstElementChild;t;)null!==m.get(t.getAttribute("vt-name"))&&k(t,"vt-enter"),t=t.nextElementSibling;c=x;do for(var n=c.firstElementChild;n;){var J=n.getAttribute("vt-update");J&&"none"!==J&&!l.includes(n)&&k(n,"vt-update");n=n.nextElementSibling}while((c=c.parentNode)&&1===c.nodeType&&"none"!==c.getAttribute("vt-update"));u.push.apply(u,I.querySelectorAll('img[src]:not([loading="lazy"])'))}}}if(B){var z=
document.__reactViewTransition=document.startViewTransition({update:function(){A(g);for(var a=[document.documentElement.clientHeight,document.fonts.ready],b={},e=0;e<u.length;b={g:b.g},e++)if(b.g=u[e],!b.g.complete){var p=b.g.getBoundingClientRect();0<p.bottom&&0<p.right&&p.top<window.innerHeight&&p.left<window.innerWidth&&(p=new Promise(function(w){return function(q){w.g.addEventListener("load",q);w.g.addEventListener("error",q)}}(b)),a.push(p))}return Promise.race([Promise.all(a),new Promise(function(w){var q=
performance.now();setTimeout(w,2300>q&&2E3<q?2300-q:500)})])},types:[]});z.ready.finally(function(){for(var a=l.length-3;0<=a;a-=3){var b=l[a],e=b.style;e.viewTransitionName=l[a+1];e.viewTransitionClass=l[a+1];""===b.getAttribute("style")&&b.removeAttribute("style")}});z.finished.finally(function(){document.__reactViewTransition===z&&(document.__reactViewTransition=null)});$RB=[];return}}catch(a){}A(g)}.bind(null,$RV);`,
  );
  var completeBoundaryScript1Partial = stringToPrecomputedChunk('$RC("'),
    completeBoundaryWithStylesScript1FullPartial = stringToPrecomputedChunk(
      '$RM=new Map;$RR=function(n,w,p){function u(q){this._p=null;q()}for(var r=new Map,t=document,h,b,e=t.querySelectorAll("link[data-precedence],style[data-precedence]"),v=[],k=0;b=e[k++];)"not all"===b.getAttribute("media")?v.push(b):("LINK"===b.tagName&&$RM.set(b.getAttribute("href"),b),r.set(b.dataset.precedence,h=b));e=0;b=[];var l,a;for(k=!0;;){if(k){var f=p[e++];if(!f){k=!1;e=0;continue}var c=!1,m=0;var d=f[m++];if(a=$RM.get(d)){var g=a._p;c=!0}else{a=t.createElement("link");a.href=d;a.rel=\n"stylesheet";for(a.dataset.precedence=l=f[m++];g=f[m++];)a.setAttribute(g,f[m++]);g=a._p=new Promise(function(q,x){a.onload=u.bind(a,q);a.onerror=u.bind(a,x)});$RM.set(d,a)}d=a.getAttribute("media");!g||d&&!matchMedia(d).matches||b.push(g);if(c)continue}else{a=v[e++];if(!a)break;l=a.getAttribute("data-precedence");a.removeAttribute("media")}c=r.get(l)||h;c===h&&(h=a);r.set(l,a);c?c.parentNode.insertBefore(a,c.nextSibling):(c=t.head,c.insertBefore(a,c.firstChild))}if(p=document.getElementById(n))p.previousSibling.data=\n"$~";Promise.all(b).then($RC.bind(null,n,w),$RX.bind(null,n,"CSS failed to load"))};$RR("',
    ),
    completeBoundaryWithStylesScript1Partial = stringToPrecomputedChunk('$RR("'),
    completeBoundaryScript2 = stringToPrecomputedChunk('","'),
    completeBoundaryScript3a = stringToPrecomputedChunk('",'),
    completeBoundaryScript3b = stringToPrecomputedChunk('"'),
    completeBoundaryScriptEnd = stringToPrecomputedChunk(")<\/script>");
  stringToPrecomputedChunk('<template data-rci="" data-bid="');
  stringToPrecomputedChunk('<template data-rri="" data-bid="');
  stringToPrecomputedChunk('" data-sid="');
  stringToPrecomputedChunk('" data-sty="');
  var clientRenderScriptFunctionOnly = stringToPrecomputedChunk(
      '$RX=function(b,c,d,e,f){var a=document.getElementById(b);a&&(b=a.previousSibling,b.data="$!",a=a.dataset,c&&(a.dgst=c),d&&(a.msg=d),e&&(a.stck=e),f&&(a.cstck=f),b._reactRetry&&b._reactRetry())};',
    ),
    clientRenderScript1Full = stringToPrecomputedChunk(
      '$RX=function(b,c,d,e,f){var a=document.getElementById(b);a&&(b=a.previousSibling,b.data="$!",a=a.dataset,c&&(a.dgst=c),d&&(a.msg=d),e&&(a.stck=e),f&&(a.cstck=f),b._reactRetry&&b._reactRetry())};;$RX("',
    ),
    clientRenderScript1Partial = stringToPrecomputedChunk('$RX("'),
    clientRenderScript1A = stringToPrecomputedChunk('"'),
    clientRenderErrorScriptArgInterstitial = stringToPrecomputedChunk(","),
    clientRenderScriptEnd = stringToPrecomputedChunk(")<\/script>");
  stringToPrecomputedChunk('<template data-rxi="" data-bid="');
  stringToPrecomputedChunk('" data-dgst="');
  stringToPrecomputedChunk('" data-msg="');
  stringToPrecomputedChunk('" data-stck="');
  stringToPrecomputedChunk('" data-cstck="');
  var regexForJSStringsInInstructionScripts = /[<\u2028\u2029]/g;
  function escapeJSStringsForInstructionScripts(input) {
    return JSON.stringify(input).replace(regexForJSStringsInInstructionScripts, function (match) {
      switch (match) {
        case "<":
          return "\\u003c";
        case "\u2028":
          return "\\u2028";
        case "\u2029":
          return "\\u2029";
        default:
          throw Error(
            "escapeJSStringsForInstructionScripts encountered a match it does not know how to replace. this means the match regex and the replacement characters are no longer in sync. This is a bug in React",
          );
      }
    });
  }
  var regexForJSStringsInScripts = /[&><\u2028\u2029]/g;
  function escapeJSObjectForInstructionScripts(input) {
    return JSON.stringify(input).replace(regexForJSStringsInScripts, function (match) {
      switch (match) {
        case "&":
          return "\\u0026";
        case ">":
          return "\\u003e";
        case "<":
          return "\\u003c";
        case "\u2028":
          return "\\u2028";
        case "\u2029":
          return "\\u2029";
        default:
          throw Error(
            "escapeJSObjectForInstructionScripts encountered a match it does not know how to replace. this means the match regex and the replacement characters are no longer in sync. This is a bug in React",
          );
      }
    });
  }
  var lateStyleTagResourceOpen1 = stringToPrecomputedChunk(' media="not all" data-precedence="'),
    lateStyleTagResourceOpen2 = stringToPrecomputedChunk('" data-href="'),
    lateStyleTagResourceOpen3 = stringToPrecomputedChunk('">'),
    lateStyleTagTemplateClose = stringToPrecomputedChunk("</style>"),
    currentlyRenderingBoundaryHasStylesToHoist = false,
    destinationHasCapacity = true;
  function flushStyleTagsLateForBoundary(styleQueue) {
    var rules = styleQueue.rules,
      hrefs = styleQueue.hrefs,
      i = 0;
    if (hrefs.length) {
      writeChunk(this, currentlyFlushingRenderState.startInlineStyle);
      writeChunk(this, lateStyleTagResourceOpen1);
      writeChunk(this, styleQueue.precedence);
      for (writeChunk(this, lateStyleTagResourceOpen2); i < hrefs.length - 1; i++)
        (writeChunk(this, hrefs[i]), writeChunk(this, spaceSeparator));
      writeChunk(this, hrefs[i]);
      writeChunk(this, lateStyleTagResourceOpen3);
      for (i = 0; i < rules.length; i++) writeChunk(this, rules[i]);
      destinationHasCapacity = writeChunkAndReturn(this, lateStyleTagTemplateClose);
      currentlyRenderingBoundaryHasStylesToHoist = true;
      rules.length = 0;
      hrefs.length = 0;
    }
  }
  function hasStylesToHoist(stylesheet) {
    return 2 !== stylesheet.state ? (currentlyRenderingBoundaryHasStylesToHoist = true) : false;
  }
  function writeHoistablesForBoundary(destination, hoistableState, renderState) {
    currentlyRenderingBoundaryHasStylesToHoist = false;
    destinationHasCapacity = true;
    currentlyFlushingRenderState = renderState;
    hoistableState.styles.forEach(flushStyleTagsLateForBoundary, destination);
    currentlyFlushingRenderState = null;
    hoistableState.stylesheets.forEach(hasStylesToHoist);
    currentlyRenderingBoundaryHasStylesToHoist && (renderState.stylesToHoist = true);
    return destinationHasCapacity;
  }
  function flushResource(resource) {
    for (var i = 0; i < resource.length; i++) writeChunk(this, resource[i]);
    resource.length = 0;
  }
  var stylesheetFlushingQueue = [];
  function flushStyleInPreamble(stylesheet) {
    pushLinkImpl(stylesheetFlushingQueue, stylesheet.props);
    for (var i = 0; i < stylesheetFlushingQueue.length; i++)
      writeChunk(this, stylesheetFlushingQueue[i]);
    stylesheetFlushingQueue.length = 0;
    stylesheet.state = 2;
  }
  var styleTagResourceOpen1 = stringToPrecomputedChunk(' data-precedence="'),
    styleTagResourceOpen2 = stringToPrecomputedChunk('" data-href="'),
    spaceSeparator = stringToPrecomputedChunk(" "),
    styleTagResourceOpen3 = stringToPrecomputedChunk('">'),
    styleTagResourceClose = stringToPrecomputedChunk("</style>");
  function flushStylesInPreamble(styleQueue) {
    var hasStylesheets = 0 < styleQueue.sheets.size;
    styleQueue.sheets.forEach(flushStyleInPreamble, this);
    styleQueue.sheets.clear();
    var rules = styleQueue.rules,
      hrefs = styleQueue.hrefs;
    if (!hasStylesheets || hrefs.length) {
      writeChunk(this, currentlyFlushingRenderState.startInlineStyle);
      writeChunk(this, styleTagResourceOpen1);
      writeChunk(this, styleQueue.precedence);
      styleQueue = 0;
      if (hrefs.length) {
        for (writeChunk(this, styleTagResourceOpen2); styleQueue < hrefs.length - 1; styleQueue++)
          (writeChunk(this, hrefs[styleQueue]), writeChunk(this, spaceSeparator));
        writeChunk(this, hrefs[styleQueue]);
      }
      writeChunk(this, styleTagResourceOpen3);
      for (styleQueue = 0; styleQueue < rules.length; styleQueue++)
        writeChunk(this, rules[styleQueue]);
      writeChunk(this, styleTagResourceClose);
      rules.length = 0;
      hrefs.length = 0;
    }
  }
  function preloadLateStyle(stylesheet) {
    if (0 === stylesheet.state) {
      stylesheet.state = 1;
      var props = stylesheet.props;
      pushLinkImpl(stylesheetFlushingQueue, {
        rel: "preload",
        as: "style",
        href: stylesheet.props.href,
        crossOrigin: props.crossOrigin,
        fetchPriority: props.fetchPriority,
        integrity: props.integrity,
        media: props.media,
        hrefLang: props.hrefLang,
        referrerPolicy: props.referrerPolicy,
      });
      for (stylesheet = 0; stylesheet < stylesheetFlushingQueue.length; stylesheet++)
        writeChunk(this, stylesheetFlushingQueue[stylesheet]);
      stylesheetFlushingQueue.length = 0;
    }
  }
  function preloadLateStyles(styleQueue) {
    styleQueue.sheets.forEach(preloadLateStyle, this);
    styleQueue.sheets.clear();
  }
  stringToPrecomputedChunk('<link rel="expect" href="#');
  stringToPrecomputedChunk('" blocking="render"/>');
  var completedShellIdAttributeStart = stringToPrecomputedChunk(' id="');
  function pushCompletedShellIdAttribute(target, resumableState) {
    0 === (resumableState.instructions & 32) &&
      ((resumableState.instructions |= 32),
      target.push(
        completedShellIdAttributeStart,
        stringToChunk(escapeTextForBrowser("_" + resumableState.idPrefix + "R_")),
        attributeEnd,
      ));
  }
  var arrayFirstOpenBracket = stringToPrecomputedChunk("["),
    arraySubsequentOpenBracket = stringToPrecomputedChunk(",["),
    arrayInterstitial = stringToPrecomputedChunk(","),
    arrayCloseBracket = stringToPrecomputedChunk("]");
  function writeStyleResourceDependenciesInJS(destination, hoistableState) {
    writeChunk(destination, arrayFirstOpenBracket);
    var nextArrayOpenBrackChunk = arrayFirstOpenBracket;
    hoistableState.stylesheets.forEach(function (resource) {
      if (2 !== resource.state)
        if (3 === resource.state)
          (writeChunk(destination, nextArrayOpenBrackChunk),
            writeChunk(
              destination,
              stringToChunk(escapeJSObjectForInstructionScripts("" + resource.props.href)),
            ),
            writeChunk(destination, arrayCloseBracket),
            (nextArrayOpenBrackChunk = arraySubsequentOpenBracket));
        else {
          writeChunk(destination, nextArrayOpenBrackChunk);
          var precedence = resource.props["data-precedence"],
            props = resource.props,
            coercedHref = sanitizeURL("" + resource.props.href);
          writeChunk(destination, stringToChunk(escapeJSObjectForInstructionScripts(coercedHref)));
          precedence = "" + precedence;
          writeChunk(destination, arrayInterstitial);
          writeChunk(destination, stringToChunk(escapeJSObjectForInstructionScripts(precedence)));
          for (var propKey in props)
            if (
              hasOwnProperty.call(props, propKey) &&
              ((precedence = props[propKey]), null != precedence)
            )
              switch (propKey) {
                case "href":
                case "rel":
                case "precedence":
                case "data-precedence":
                  break;
                case "children":
                case "dangerouslySetInnerHTML":
                  throw Error(
                    "link is a self-closing tag and must neither have `children` nor use `dangerouslySetInnerHTML`.",
                  );
                default:
                  writeStyleResourceAttributeInJS(destination, propKey, precedence);
              }
          writeChunk(destination, arrayCloseBracket);
          nextArrayOpenBrackChunk = arraySubsequentOpenBracket;
          resource.state = 3;
        }
    });
    writeChunk(destination, arrayCloseBracket);
  }
  function writeStyleResourceAttributeInJS(destination, name, value) {
    var attributeName = name.toLowerCase();
    switch (typeof value) {
      case "function":
      case "symbol":
        return;
    }
    switch (name) {
      case "innerHTML":
      case "dangerouslySetInnerHTML":
      case "suppressContentEditableWarning":
      case "suppressHydrationWarning":
      case "style":
      case "ref":
        return;
      case "className":
        attributeName = "class";
        name = "" + value;
        break;
      case "hidden":
        if (false === value) return;
        name = "";
        break;
      case "src":
      case "href":
        value = sanitizeURL(value);
        name = "" + value;
        break;
      default:
        if (
          (2 < name.length &&
            ("o" === name[0] || "O" === name[0]) &&
            ("n" === name[1] || "N" === name[1])) ||
          !isAttributeNameSafe(name)
        )
          return;
        name = "" + value;
    }
    writeChunk(destination, arrayInterstitial);
    writeChunk(destination, stringToChunk(escapeJSObjectForInstructionScripts(attributeName)));
    writeChunk(destination, arrayInterstitial);
    writeChunk(destination, stringToChunk(escapeJSObjectForInstructionScripts(name)));
  }
  function createHoistableState() {
    return {
      styles: /* @__PURE__ */ new Set(),
      stylesheets: /* @__PURE__ */ new Set(),
      suspenseyImages: false,
    };
  }
  function prefetchDNS(href) {
    var request = resolveRequest();
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if ("string" === typeof href && href) {
        if (!resumableState.dnsResources.hasOwnProperty(href)) {
          resumableState.dnsResources[href] = null;
          resumableState = renderState.headers;
          var header, JSCompiler_temp;
          if ((JSCompiler_temp = resumableState && 0 < resumableState.remainingCapacity))
            JSCompiler_temp =
              ((header =
                "<" +
                ("" + href).replace(
                  regexForHrefInLinkHeaderURLContext,
                  escapeHrefForLinkHeaderURLContextReplacer,
                ) +
                ">; rel=dns-prefetch"),
              0 <= (resumableState.remainingCapacity -= header.length + 2));
          JSCompiler_temp
            ? ((renderState.resets.dns[href] = null),
              resumableState.preconnects && (resumableState.preconnects += ", "),
              (resumableState.preconnects += header))
            : ((header = []),
              pushLinkImpl(header, { href, rel: "dns-prefetch" }),
              renderState.preconnects.add(header));
        }
        enqueueFlush(request);
      }
    } else previousDispatcher.D(href);
  }
  function preconnect(href, crossOrigin) {
    var request = resolveRequest();
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if ("string" === typeof href && href) {
        var bucket =
          "use-credentials" === crossOrigin
            ? "credentials"
            : "string" === typeof crossOrigin
              ? "anonymous"
              : "default";
        if (!resumableState.connectResources[bucket].hasOwnProperty(href)) {
          resumableState.connectResources[bucket][href] = null;
          resumableState = renderState.headers;
          var header, JSCompiler_temp;
          if ((JSCompiler_temp = resumableState && 0 < resumableState.remainingCapacity)) {
            JSCompiler_temp =
              "<" +
              ("" + href).replace(
                regexForHrefInLinkHeaderURLContext,
                escapeHrefForLinkHeaderURLContextReplacer,
              ) +
              ">; rel=preconnect";
            if ("string" === typeof crossOrigin) {
              var escapedCrossOrigin = ("" + crossOrigin).replace(
                regexForLinkHeaderQuotedParamValueContext,
                escapeStringForLinkHeaderQuotedParamValueContextReplacer,
              );
              JSCompiler_temp += '; crossorigin="' + escapedCrossOrigin + '"';
            }
            JSCompiler_temp =
              ((header = JSCompiler_temp),
              0 <= (resumableState.remainingCapacity -= header.length + 2));
          }
          JSCompiler_temp
            ? ((renderState.resets.connect[bucket][href] = null),
              resumableState.preconnects && (resumableState.preconnects += ", "),
              (resumableState.preconnects += header))
            : ((bucket = []),
              pushLinkImpl(bucket, {
                rel: "preconnect",
                href,
                crossOrigin,
              }),
              renderState.preconnects.add(bucket));
        }
        enqueueFlush(request);
      }
    } else previousDispatcher.C(href, crossOrigin);
  }
  function preload(href, as, options) {
    var request = resolveRequest();
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if (as && href) {
        switch (as) {
          case "image":
            if (options) {
              var imageSrcSet = options.imageSrcSet;
              var imageSizes = options.imageSizes;
              var fetchPriority = options.fetchPriority;
            }
            var key = imageSrcSet ? imageSrcSet + "\n" + (imageSizes || "") : href;
            if (resumableState.imageResources.hasOwnProperty(key)) return;
            resumableState.imageResources[key] = PRELOAD_NO_CREDS;
            resumableState = renderState.headers;
            var header;
            resumableState &&
            0 < resumableState.remainingCapacity &&
            "string" !== typeof imageSrcSet &&
            "high" === fetchPriority &&
            ((header = getPreloadAsHeader(href, as, options)),
            0 <= (resumableState.remainingCapacity -= header.length + 2))
              ? ((renderState.resets.image[key] = PRELOAD_NO_CREDS),
                resumableState.highImagePreloads && (resumableState.highImagePreloads += ", "),
                (resumableState.highImagePreloads += header))
              : ((resumableState = []),
                pushLinkImpl(
                  resumableState,
                  assign({ rel: "preload", href: imageSrcSet ? void 0 : href, as }, options),
                ),
                "high" === fetchPriority
                  ? renderState.highImagePreloads.add(resumableState)
                  : (renderState.bulkPreloads.add(resumableState),
                    renderState.preloads.images.set(key, resumableState)));
            break;
          case "style":
            if (resumableState.styleResources.hasOwnProperty(href)) return;
            imageSrcSet = [];
            pushLinkImpl(imageSrcSet, assign({ rel: "preload", href, as }, options));
            resumableState.styleResources[href] =
              !options ||
              ("string" !== typeof options.crossOrigin && "string" !== typeof options.integrity)
                ? PRELOAD_NO_CREDS
                : [options.crossOrigin, options.integrity];
            renderState.preloads.stylesheets.set(href, imageSrcSet);
            renderState.bulkPreloads.add(imageSrcSet);
            break;
          case "script":
            if (resumableState.scriptResources.hasOwnProperty(href)) return;
            imageSrcSet = [];
            renderState.preloads.scripts.set(href, imageSrcSet);
            renderState.bulkPreloads.add(imageSrcSet);
            pushLinkImpl(imageSrcSet, assign({ rel: "preload", href, as }, options));
            resumableState.scriptResources[href] =
              !options ||
              ("string" !== typeof options.crossOrigin && "string" !== typeof options.integrity)
                ? PRELOAD_NO_CREDS
                : [options.crossOrigin, options.integrity];
            break;
          default:
            if (resumableState.unknownResources.hasOwnProperty(as)) {
              if (
                ((imageSrcSet = resumableState.unknownResources[as]),
                imageSrcSet.hasOwnProperty(href))
              )
                return;
            } else ((imageSrcSet = {}), (resumableState.unknownResources[as] = imageSrcSet));
            imageSrcSet[href] = PRELOAD_NO_CREDS;
            if (
              (resumableState = renderState.headers) &&
              0 < resumableState.remainingCapacity &&
              "font" === as &&
              ((key = getPreloadAsHeader(href, as, options)),
              0 <= (resumableState.remainingCapacity -= key.length + 2))
            )
              ((renderState.resets.font[href] = PRELOAD_NO_CREDS),
                resumableState.fontPreloads && (resumableState.fontPreloads += ", "),
                (resumableState.fontPreloads += key));
            else
              switch (
                ((resumableState = []),
                (href = assign({ rel: "preload", href, as }, options)),
                pushLinkImpl(resumableState, href),
                as)
              ) {
                case "font":
                  renderState.fontPreloads.add(resumableState);
                  break;
                default:
                  renderState.bulkPreloads.add(resumableState);
              }
        }
        enqueueFlush(request);
      }
    } else previousDispatcher.L(href, as, options);
  }
  function preloadModule(href, options) {
    var request = resolveRequest();
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if (href) {
        var as = options && "string" === typeof options.as ? options.as : "script";
        switch (as) {
          case "script":
            if (resumableState.moduleScriptResources.hasOwnProperty(href)) return;
            as = [];
            resumableState.moduleScriptResources[href] =
              !options ||
              ("string" !== typeof options.crossOrigin && "string" !== typeof options.integrity)
                ? PRELOAD_NO_CREDS
                : [options.crossOrigin, options.integrity];
            renderState.preloads.moduleScripts.set(href, as);
            break;
          default:
            if (resumableState.moduleUnknownResources.hasOwnProperty(as)) {
              var resources = resumableState.unknownResources[as];
              if (resources.hasOwnProperty(href)) return;
            } else ((resources = {}), (resumableState.moduleUnknownResources[as] = resources));
            as = [];
            resources[href] = PRELOAD_NO_CREDS;
        }
        pushLinkImpl(as, assign({ rel: "modulepreload", href }, options));
        renderState.bulkPreloads.add(as);
        enqueueFlush(request);
      }
    } else previousDispatcher.m(href, options);
  }
  function preinitStyle(href, precedence, options) {
    var request = resolveRequest();
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if (href) {
        precedence = precedence || "default";
        var styleQueue = renderState.styles.get(precedence),
          resourceState = resumableState.styleResources.hasOwnProperty(href)
            ? resumableState.styleResources[href]
            : void 0;
        null !== resourceState &&
          ((resumableState.styleResources[href] = null),
          styleQueue ||
            ((styleQueue = {
              precedence: stringToChunk(escapeTextForBrowser(precedence)),
              rules: [],
              hrefs: [],
              sheets: /* @__PURE__ */ new Map(),
            }),
            renderState.styles.set(precedence, styleQueue)),
          (precedence = {
            state: 0,
            props: assign({ rel: "stylesheet", href, "data-precedence": precedence }, options),
          }),
          resourceState &&
            (2 === resourceState.length && adoptPreloadCredentials(precedence.props, resourceState),
            (renderState = renderState.preloads.stylesheets.get(href)) && 0 < renderState.length
              ? (renderState.length = 0)
              : (precedence.state = 1)),
          styleQueue.sheets.set(href, precedence),
          enqueueFlush(request));
      }
    } else previousDispatcher.S(href, precedence, options);
  }
  function preinitScript(src, options) {
    var request = resolveRequest();
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if (src) {
        var resourceState = resumableState.scriptResources.hasOwnProperty(src)
          ? resumableState.scriptResources[src]
          : void 0;
        null !== resourceState &&
          ((resumableState.scriptResources[src] = null),
          (options = assign({ src, async: true }, options)),
          resourceState &&
            (2 === resourceState.length && adoptPreloadCredentials(options, resourceState),
            (src = renderState.preloads.scripts.get(src))) &&
            (src.length = 0),
          (src = []),
          renderState.scripts.add(src),
          pushScriptImpl(src, options),
          enqueueFlush(request));
      }
    } else previousDispatcher.X(src, options);
  }
  function preinitModuleScript(src, options) {
    var request = resolveRequest();
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if (src) {
        var resourceState = resumableState.moduleScriptResources.hasOwnProperty(src)
          ? resumableState.moduleScriptResources[src]
          : void 0;
        null !== resourceState &&
          ((resumableState.moduleScriptResources[src] = null),
          (options = assign({ src, type: "module", async: true }, options)),
          resourceState &&
            (2 === resourceState.length && adoptPreloadCredentials(options, resourceState),
            (src = renderState.preloads.moduleScripts.get(src))) &&
            (src.length = 0),
          (src = []),
          renderState.scripts.add(src),
          pushScriptImpl(src, options),
          enqueueFlush(request));
      }
    } else previousDispatcher.M(src, options);
  }
  function adoptPreloadCredentials(target, preloadState) {
    null == target.crossOrigin && (target.crossOrigin = preloadState[0]);
    null == target.integrity && (target.integrity = preloadState[1]);
  }
  function getPreloadAsHeader(href, as, params) {
    href = ("" + href).replace(
      regexForHrefInLinkHeaderURLContext,
      escapeHrefForLinkHeaderURLContextReplacer,
    );
    as = ("" + as).replace(
      regexForLinkHeaderQuotedParamValueContext,
      escapeStringForLinkHeaderQuotedParamValueContextReplacer,
    );
    as = "<" + href + '>; rel=preload; as="' + as + '"';
    for (var paramName in params)
      hasOwnProperty.call(params, paramName) &&
        ((href = params[paramName]),
        "string" === typeof href &&
          (as +=
            "; " +
            paramName.toLowerCase() +
            '="' +
            ("" + href).replace(
              regexForLinkHeaderQuotedParamValueContext,
              escapeStringForLinkHeaderQuotedParamValueContextReplacer,
            ) +
            '"'));
    return as;
  }
  var regexForHrefInLinkHeaderURLContext = /[<>\r\n]/g;
  function escapeHrefForLinkHeaderURLContextReplacer(match) {
    switch (match) {
      case "<":
        return "%3C";
      case ">":
        return "%3E";
      case "\n":
        return "%0A";
      case "\r":
        return "%0D";
      default:
        throw Error(
          "escapeLinkHrefForHeaderContextReplacer encountered a match it does not know how to replace. this means the match regex and the replacement characters are no longer in sync. This is a bug in React",
        );
    }
  }
  var regexForLinkHeaderQuotedParamValueContext = /["';,\r\n]/g;
  function escapeStringForLinkHeaderQuotedParamValueContextReplacer(match) {
    switch (match) {
      case '"':
        return "%22";
      case "'":
        return "%27";
      case ";":
        return "%3B";
      case ",":
        return "%2C";
      case "\n":
        return "%0A";
      case "\r":
        return "%0D";
      default:
        throw Error(
          "escapeStringForLinkHeaderQuotedParamValueContextReplacer encountered a match it does not know how to replace. this means the match regex and the replacement characters are no longer in sync. This is a bug in React",
        );
    }
  }
  function hoistStyleQueueDependency(styleQueue) {
    this.styles.add(styleQueue);
  }
  function hoistStylesheetDependency(stylesheet) {
    this.stylesheets.add(stylesheet);
  }
  function hoistHoistables(parentState, childState) {
    childState.styles.forEach(hoistStyleQueueDependency, parentState);
    childState.stylesheets.forEach(hoistStylesheetDependency, parentState);
    childState.suspenseyImages && (parentState.suspenseyImages = true);
  }
  function hasSuspenseyContent(hoistableState) {
    return 0 < hoistableState.stylesheets.size || hoistableState.suspenseyImages;
  }
  var bind = Function.prototype.bind,
    supportsRequestStorage = "function" === typeof AsyncLocalStorage,
    requestStorage = supportsRequestStorage ? new AsyncLocalStorage() : null,
    REACT_CLIENT_REFERENCE = Symbol.for("react.client.reference");
  function getComponentNameFromType(type) {
    if (null == type) return null;
    if ("function" === typeof type)
      return type.$$typeof === REACT_CLIENT_REFERENCE
        ? null
        : type.displayName || type.name || null;
    if ("string" === typeof type) return type;
    switch (type) {
      case REACT_FRAGMENT_TYPE:
        return "Fragment";
      case REACT_PROFILER_TYPE:
        return "Profiler";
      case REACT_STRICT_MODE_TYPE:
        return "StrictMode";
      case REACT_SUSPENSE_TYPE:
        return "Suspense";
      case REACT_SUSPENSE_LIST_TYPE:
        return "SuspenseList";
      case REACT_ACTIVITY_TYPE:
        return "Activity";
    }
    if ("object" === typeof type)
      switch (type.$$typeof) {
        case REACT_PORTAL_TYPE:
          return "Portal";
        case REACT_CONTEXT_TYPE:
          return type.displayName || "Context";
        case REACT_CONSUMER_TYPE:
          return (type._context.displayName || "Context") + ".Consumer";
        case REACT_FORWARD_REF_TYPE:
          var innerType = type.render;
          type = type.displayName;
          type ||
            ((type = innerType.displayName || innerType.name || ""),
            (type = "" !== type ? "ForwardRef(" + type + ")" : "ForwardRef"));
          return type;
        case REACT_MEMO_TYPE:
          return (
            (innerType = type.displayName || null),
            null !== innerType ? innerType : getComponentNameFromType(type.type) || "Memo"
          );
        case REACT_LAZY_TYPE:
          innerType = type._payload;
          type = type._init;
          try {
            return getComponentNameFromType(type(innerType));
          } catch (x3) {}
      }
    return null;
  }
  var emptyContextObject = {},
    currentActiveSnapshot = null;
  function popToNearestCommonAncestor(prev, next) {
    if (prev !== next) {
      prev.context._currentValue = prev.parentValue;
      prev = prev.parent;
      var parentNext = next.parent;
      if (null === prev) {
        if (null !== parentNext)
          throw Error("The stacks must reach the root at the same time. This is a bug in React.");
      } else {
        if (null === parentNext)
          throw Error("The stacks must reach the root at the same time. This is a bug in React.");
        popToNearestCommonAncestor(prev, parentNext);
      }
      next.context._currentValue = next.value;
    }
  }
  function popAllPrevious(prev) {
    prev.context._currentValue = prev.parentValue;
    prev = prev.parent;
    null !== prev && popAllPrevious(prev);
  }
  function pushAllNext(next) {
    var parentNext = next.parent;
    null !== parentNext && pushAllNext(parentNext);
    next.context._currentValue = next.value;
  }
  function popPreviousToCommonLevel(prev, next) {
    prev.context._currentValue = prev.parentValue;
    prev = prev.parent;
    if (null === prev)
      throw Error(
        "The depth must equal at least at zero before reaching the root. This is a bug in React.",
      );
    prev.depth === next.depth
      ? popToNearestCommonAncestor(prev, next)
      : popPreviousToCommonLevel(prev, next);
  }
  function popNextToCommonLevel(prev, next) {
    var parentNext = next.parent;
    if (null === parentNext)
      throw Error(
        "The depth must equal at least at zero before reaching the root. This is a bug in React.",
      );
    prev.depth === parentNext.depth
      ? popToNearestCommonAncestor(prev, parentNext)
      : popNextToCommonLevel(prev, parentNext);
    next.context._currentValue = next.value;
  }
  function switchContext(newSnapshot) {
    var prev = currentActiveSnapshot;
    prev !== newSnapshot &&
      (null === prev
        ? pushAllNext(newSnapshot)
        : null === newSnapshot
          ? popAllPrevious(prev)
          : prev.depth === newSnapshot.depth
            ? popToNearestCommonAncestor(prev, newSnapshot)
            : prev.depth > newSnapshot.depth
              ? popPreviousToCommonLevel(prev, newSnapshot)
              : popNextToCommonLevel(prev, newSnapshot),
      (currentActiveSnapshot = newSnapshot));
  }
  var classComponentUpdater = {
      enqueueSetState: function (inst, payload) {
        inst = inst._reactInternals;
        null !== inst.queue && inst.queue.push(payload);
      },
      enqueueReplaceState: function (inst, payload) {
        inst = inst._reactInternals;
        inst.replace = true;
        inst.queue = [payload];
      },
      enqueueForceUpdate: function () {},
    },
    emptyTreeContext = { id: 1, overflow: "" };
  function pushTreeContext(baseContext, totalChildren, index) {
    var baseIdWithLeadingBit = baseContext.id;
    baseContext = baseContext.overflow;
    var baseLength = 32 - clz32(baseIdWithLeadingBit) - 1;
    baseIdWithLeadingBit &= ~(1 << baseLength);
    index += 1;
    var length = 32 - clz32(totalChildren) + baseLength;
    if (30 < length) {
      var numberOfOverflowBits = baseLength - (baseLength % 5);
      length = (baseIdWithLeadingBit & ((1 << numberOfOverflowBits) - 1)).toString(32);
      baseIdWithLeadingBit >>= numberOfOverflowBits;
      baseLength -= numberOfOverflowBits;
      return {
        id:
          (1 << (32 - clz32(totalChildren) + baseLength)) |
          (index << baseLength) |
          baseIdWithLeadingBit,
        overflow: length + baseContext,
      };
    }
    return {
      id: (1 << length) | (index << baseLength) | baseIdWithLeadingBit,
      overflow: baseContext,
    };
  }
  var clz32 = Math.clz32 ? Math.clz32 : clz32Fallback,
    log = Math.log,
    LN2 = Math.LN2;
  function clz32Fallback(x3) {
    x3 >>>= 0;
    return 0 === x3 ? 32 : (31 - ((log(x3) / LN2) | 0)) | 0;
  }
  function noop() {}
  var SuspenseException = Error(
    "Suspense Exception: This is not a real error! It's an implementation detail of `use` to interrupt the current render. You must either rethrow it immediately, or move the `use` call outside of the `try/catch` block. Capturing without rethrowing will lead to unexpected behavior.\n\nTo handle async errors, wrap your component in an error boundary, or call the promise's `.catch` method and pass the result to `use`.",
  );
  function trackUsedThenable(thenableState2, thenable, index) {
    index = thenableState2[index];
    void 0 === index
      ? thenableState2.push(thenable)
      : index !== thenable && (thenable.then(noop, noop), (thenable = index));
    switch (thenable.status) {
      case "fulfilled":
        return thenable.value;
      case "rejected":
        throw thenable.reason;
      default:
        "string" === typeof thenable.status
          ? thenable.then(noop, noop)
          : ((thenableState2 = thenable),
            (thenableState2.status = "pending"),
            thenableState2.then(
              function (fulfilledValue) {
                if ("pending" === thenable.status) {
                  var fulfilledThenable = thenable;
                  fulfilledThenable.status = "fulfilled";
                  fulfilledThenable.value = fulfilledValue;
                }
              },
              function (error) {
                if ("pending" === thenable.status) {
                  var rejectedThenable = thenable;
                  rejectedThenable.status = "rejected";
                  rejectedThenable.reason = error;
                }
              },
            ));
        switch (thenable.status) {
          case "fulfilled":
            return thenable.value;
          case "rejected":
            throw thenable.reason;
        }
        suspendedThenable = thenable;
        throw SuspenseException;
    }
  }
  var suspendedThenable = null;
  function getSuspendedThenable() {
    if (null === suspendedThenable)
      throw Error("Expected a suspended thenable. This is a bug in React. Please file an issue.");
    var thenable = suspendedThenable;
    suspendedThenable = null;
    return thenable;
  }
  function is(x3, y2) {
    return (x3 === y2 && (0 !== x3 || 1 / x3 === 1 / y2)) || (x3 !== x3 && y2 !== y2);
  }
  var objectIs = "function" === typeof Object.is ? Object.is : is,
    currentlyRenderingComponent = null,
    currentlyRenderingTask = null,
    currentlyRenderingRequest = null,
    currentlyRenderingKeyPath = null,
    firstWorkInProgressHook = null,
    workInProgressHook = null,
    isReRender = false,
    didScheduleRenderPhaseUpdate = false,
    localIdCounter = 0,
    actionStateCounter = 0,
    actionStateMatchingIndex = -1,
    thenableIndexCounter = 0,
    thenableState = null,
    renderPhaseUpdates = null,
    numberOfReRenders = 0;
  function resolveCurrentlyRenderingComponent() {
    if (null === currentlyRenderingComponent)
      throw Error(
        "Invalid hook call. Hooks can only be called inside of the body of a function component. This could happen for one of the following reasons:\n1. You might have mismatching versions of React and the renderer (such as React DOM)\n2. You might be breaking the Rules of Hooks\n3. You might have more than one copy of React in the same app\nSee https://react.dev/link/invalid-hook-call for tips about how to debug and fix this problem.",
      );
    return currentlyRenderingComponent;
  }
  function createHook() {
    if (0 < numberOfReRenders) throw Error("Rendered more hooks than during the previous render");
    return { memoizedState: null, queue: null, next: null };
  }
  function createWorkInProgressHook() {
    null === workInProgressHook
      ? null === firstWorkInProgressHook
        ? ((isReRender = false), (firstWorkInProgressHook = workInProgressHook = createHook()))
        : ((isReRender = true), (workInProgressHook = firstWorkInProgressHook))
      : null === workInProgressHook.next
        ? ((isReRender = false), (workInProgressHook = workInProgressHook.next = createHook()))
        : ((isReRender = true), (workInProgressHook = workInProgressHook.next));
    return workInProgressHook;
  }
  function getThenableStateAfterSuspending() {
    var state = thenableState;
    thenableState = null;
    return state;
  }
  function resetHooksState() {
    currentlyRenderingKeyPath =
      currentlyRenderingRequest =
      currentlyRenderingTask =
      currentlyRenderingComponent =
        null;
    didScheduleRenderPhaseUpdate = false;
    firstWorkInProgressHook = null;
    numberOfReRenders = 0;
    workInProgressHook = renderPhaseUpdates = null;
  }
  function basicStateReducer(state, action) {
    return "function" === typeof action ? action(state) : action;
  }
  function useReducer(reducer, initialArg, init) {
    currentlyRenderingComponent = resolveCurrentlyRenderingComponent();
    workInProgressHook = createWorkInProgressHook();
    if (isReRender) {
      var queue = workInProgressHook.queue;
      initialArg = queue.dispatch;
      if (
        null !== renderPhaseUpdates &&
        ((init = renderPhaseUpdates.get(queue)), void 0 !== init)
      ) {
        renderPhaseUpdates.delete(queue);
        queue = workInProgressHook.memoizedState;
        do ((queue = reducer(queue, init.action)), (init = init.next));
        while (null !== init);
        workInProgressHook.memoizedState = queue;
        return [queue, initialArg];
      }
      return [workInProgressHook.memoizedState, initialArg];
    }
    reducer =
      reducer === basicStateReducer
        ? "function" === typeof initialArg
          ? initialArg()
          : initialArg
        : void 0 !== init
          ? init(initialArg)
          : initialArg;
    workInProgressHook.memoizedState = reducer;
    reducer = workInProgressHook.queue = { last: null, dispatch: null };
    reducer = reducer.dispatch = dispatchAction.bind(null, currentlyRenderingComponent, reducer);
    return [workInProgressHook.memoizedState, reducer];
  }
  function useMemo(nextCreate, deps) {
    currentlyRenderingComponent = resolveCurrentlyRenderingComponent();
    workInProgressHook = createWorkInProgressHook();
    deps = void 0 === deps ? null : deps;
    if (null !== workInProgressHook) {
      var prevState = workInProgressHook.memoizedState;
      if (null !== prevState && null !== deps) {
        var prevDeps = prevState[1];
        a: if (null === prevDeps) prevDeps = false;
        else {
          for (var i = 0; i < prevDeps.length && i < deps.length; i++)
            if (!objectIs(deps[i], prevDeps[i])) {
              prevDeps = false;
              break a;
            }
          prevDeps = true;
        }
        if (prevDeps) return prevState[0];
      }
    }
    nextCreate = nextCreate();
    workInProgressHook.memoizedState = [nextCreate, deps];
    return nextCreate;
  }
  function dispatchAction(componentIdentity, queue, action) {
    if (25 <= numberOfReRenders)
      throw Error(
        "Too many re-renders. React limits the number of renders to prevent an infinite loop.",
      );
    if (componentIdentity === currentlyRenderingComponent)
      if (
        ((didScheduleRenderPhaseUpdate = true),
        (componentIdentity = { action, next: null }),
        null === renderPhaseUpdates && (renderPhaseUpdates = /* @__PURE__ */ new Map()),
        (action = renderPhaseUpdates.get(queue)),
        void 0 === action)
      )
        renderPhaseUpdates.set(queue, componentIdentity);
      else {
        for (queue = action; null !== queue.next; ) queue = queue.next;
        queue.next = componentIdentity;
      }
  }
  function throwOnUseEffectEventCall() {
    throw Error("A function wrapped in useEffectEvent can't be called during rendering.");
  }
  function unsupportedStartTransition() {
    throw Error("startTransition cannot be called during server rendering.");
  }
  function unsupportedSetOptimisticState() {
    throw Error("Cannot update optimistic state while rendering.");
  }
  function useActionState(action, initialState, permalink) {
    resolveCurrentlyRenderingComponent();
    var actionStateHookIndex = actionStateCounter++,
      request = currentlyRenderingRequest;
    if ("function" === typeof action.$$FORM_ACTION) {
      var nextPostbackStateKey = null,
        componentKeyPath = currentlyRenderingKeyPath;
      request = request.formState;
      var isSignatureEqual = action.$$IS_SIGNATURE_EQUAL;
      if (null !== request && "function" === typeof isSignatureEqual) {
        var postbackKey = request[1];
        isSignatureEqual.call(action, request[2], request[3]) &&
          ((nextPostbackStateKey =
            void 0 !== permalink
              ? "p" + permalink
              : "k" +
                murmurhash3_32_gc(
                  JSON.stringify([componentKeyPath, null, actionStateHookIndex]),
                  0,
                )),
          postbackKey === nextPostbackStateKey &&
            ((actionStateMatchingIndex = actionStateHookIndex), (initialState = request[0])));
      }
      var boundAction = action.bind(null, initialState);
      action = function (payload) {
        boundAction(payload);
      };
      "function" === typeof boundAction.$$FORM_ACTION &&
        (action.$$FORM_ACTION = function (prefix2) {
          prefix2 = boundAction.$$FORM_ACTION(prefix2);
          void 0 !== permalink && ((permalink += ""), (prefix2.action = permalink));
          var formData = prefix2.data;
          formData &&
            (null === nextPostbackStateKey &&
              (nextPostbackStateKey =
                void 0 !== permalink
                  ? "p" + permalink
                  : "k" +
                    murmurhash3_32_gc(
                      JSON.stringify([componentKeyPath, null, actionStateHookIndex]),
                      0,
                    )),
            formData.append("$ACTION_KEY", nextPostbackStateKey));
          return prefix2;
        });
      return [initialState, action, false];
    }
    var boundAction$22 = action.bind(null, initialState);
    return [
      initialState,
      function (payload) {
        boundAction$22(payload);
      },
      false,
    ];
  }
  function unwrapThenable(thenable) {
    var index = thenableIndexCounter;
    thenableIndexCounter += 1;
    null === thenableState && (thenableState = []);
    return trackUsedThenable(thenableState, thenable, index);
  }
  function unsupportedRefresh() {
    throw Error("Cache cannot be refreshed during server rendering.");
  }
  var HooksDispatcher = {
      readContext: function (context) {
        return context._currentValue;
      },
      use: function (usable) {
        if (null !== usable && "object" === typeof usable) {
          if ("function" === typeof usable.then) return unwrapThenable(usable);
          if (usable.$$typeof === REACT_CONTEXT_TYPE) return usable._currentValue;
        }
        throw Error("An unsupported type was passed to use(): " + String(usable));
      },
      useContext: function (context) {
        resolveCurrentlyRenderingComponent();
        return context._currentValue;
      },
      useMemo,
      useReducer,
      useRef: function (initialValue) {
        currentlyRenderingComponent = resolveCurrentlyRenderingComponent();
        workInProgressHook = createWorkInProgressHook();
        var previousRef = workInProgressHook.memoizedState;
        return null === previousRef
          ? ((initialValue = { current: initialValue }),
            (workInProgressHook.memoizedState = initialValue))
          : previousRef;
      },
      useState: function (initialState) {
        return useReducer(basicStateReducer, initialState);
      },
      useInsertionEffect: noop,
      useLayoutEffect: noop,
      useCallback: function (callback, deps) {
        return useMemo(function () {
          return callback;
        }, deps);
      },
      useImperativeHandle: noop,
      useEffect: noop,
      useDebugValue: noop,
      useDeferredValue: function (value, initialValue) {
        resolveCurrentlyRenderingComponent();
        return void 0 !== initialValue ? initialValue : value;
      },
      useTransition: function () {
        resolveCurrentlyRenderingComponent();
        return [false, unsupportedStartTransition];
      },
      useId: function () {
        var JSCompiler_inline_result = currentlyRenderingTask.treeContext;
        var overflow = JSCompiler_inline_result.overflow;
        JSCompiler_inline_result = JSCompiler_inline_result.id;
        JSCompiler_inline_result =
          (JSCompiler_inline_result & ~(1 << (32 - clz32(JSCompiler_inline_result) - 1))).toString(
            32,
          ) + overflow;
        var resumableState = currentResumableState;
        if (null === resumableState)
          throw Error(
            "Invalid hook call. Hooks can only be called inside of the body of a function component.",
          );
        overflow = localIdCounter++;
        JSCompiler_inline_result = "_" + resumableState.idPrefix + "R_" + JSCompiler_inline_result;
        0 < overflow && (JSCompiler_inline_result += "H" + overflow.toString(32));
        return JSCompiler_inline_result + "_";
      },
      useSyncExternalStore: function (subscribe2, getSnapshot, getServerSnapshot) {
        if (void 0 === getServerSnapshot)
          throw Error(
            "Missing getServerSnapshot, which is required for server-rendered content. Will revert to client rendering.",
          );
        return getServerSnapshot();
      },
      useOptimistic: function (passthrough) {
        resolveCurrentlyRenderingComponent();
        return [passthrough, unsupportedSetOptimisticState];
      },
      useActionState,
      useFormState: useActionState,
      useHostTransitionStatus: function () {
        resolveCurrentlyRenderingComponent();
        return sharedNotPendingObject;
      },
      useMemoCache: function (size) {
        for (var data = Array(size), i = 0; i < size; i++) data[i] = REACT_MEMO_CACHE_SENTINEL;
        return data;
      },
      useCacheRefresh: function () {
        return unsupportedRefresh;
      },
      useEffectEvent: function () {
        return throwOnUseEffectEventCall;
      },
    },
    currentResumableState = null,
    DefaultAsyncDispatcher = {
      getCacheForType: function () {
        throw Error("Not implemented.");
      },
      cacheSignal: function () {
        throw Error("Not implemented.");
      },
    };
  function prepareStackTrace(error, structuredStackTrace) {
    error = (error.name || "Error") + ": " + (error.message || "");
    for (var i = 0; i < structuredStackTrace.length; i++)
      error += "\n    at " + structuredStackTrace[i].toString();
    return error;
  }
  var prefix, suffix;
  function describeBuiltInComponentFrame(name) {
    if (void 0 === prefix)
      try {
        throw Error();
      } catch (x3) {
        var match = x3.stack.trim().match(/\n( *(at )?)/);
        prefix = (match && match[1]) || "";
        suffix =
          -1 < x3.stack.indexOf("\n    at")
            ? " (<anonymous>)"
            : -1 < x3.stack.indexOf("@")
              ? "@unknown:0:0"
              : "";
      }
    return "\n" + prefix + name + suffix;
  }
  var reentry = false;
  function describeNativeComponentFrame(fn2, construct) {
    if (!fn2 || reentry) return "";
    reentry = true;
    var previousPrepareStackTrace = Error.prepareStackTrace;
    Error.prepareStackTrace = prepareStackTrace;
    try {
      var RunInRootFrame = {
        DetermineComponentFrameRoot: function () {
          try {
            if (construct) {
              var Fake = function () {
                throw Error();
              };
              Object.defineProperty(Fake.prototype, "props", {
                set: function () {
                  throw Error();
                },
              });
              if ("object" === typeof Reflect && Reflect.construct) {
                try {
                  Reflect.construct(Fake, []);
                } catch (x3) {
                  var control = x3;
                }
                Reflect.construct(fn2, [], Fake);
              } else {
                try {
                  Fake.call();
                } catch (x$24) {
                  control = x$24;
                }
                fn2.call(Fake.prototype);
              }
            } else {
              try {
                throw Error();
              } catch (x$25) {
                control = x$25;
              }
              (Fake = fn2()) && "function" === typeof Fake.catch && Fake.catch(function () {});
            }
          } catch (sample) {
            if (sample && control && "string" === typeof sample.stack)
              return [sample.stack, control.stack];
          }
          return [null, null];
        },
      };
      RunInRootFrame.DetermineComponentFrameRoot.displayName = "DetermineComponentFrameRoot";
      var namePropDescriptor = Object.getOwnPropertyDescriptor(
        RunInRootFrame.DetermineComponentFrameRoot,
        "name",
      );
      namePropDescriptor &&
        namePropDescriptor.configurable &&
        Object.defineProperty(RunInRootFrame.DetermineComponentFrameRoot, "name", {
          value: "DetermineComponentFrameRoot",
        });
      var _RunInRootFrame$Deter = RunInRootFrame.DetermineComponentFrameRoot(),
        sampleStack = _RunInRootFrame$Deter[0],
        controlStack = _RunInRootFrame$Deter[1];
      if (sampleStack && controlStack) {
        var sampleLines = sampleStack.split("\n"),
          controlLines = controlStack.split("\n");
        for (
          namePropDescriptor = RunInRootFrame = 0;
          RunInRootFrame < sampleLines.length &&
          !sampleLines[RunInRootFrame].includes("DetermineComponentFrameRoot");
        )
          RunInRootFrame++;
        for (
          ;
          namePropDescriptor < controlLines.length &&
          !controlLines[namePropDescriptor].includes("DetermineComponentFrameRoot");
        )
          namePropDescriptor++;
        if (RunInRootFrame === sampleLines.length || namePropDescriptor === controlLines.length)
          for (
            RunInRootFrame = sampleLines.length - 1, namePropDescriptor = controlLines.length - 1;
            1 <= RunInRootFrame &&
            0 <= namePropDescriptor &&
            sampleLines[RunInRootFrame] !== controlLines[namePropDescriptor];
          )
            namePropDescriptor--;
        for (
          ;
          1 <= RunInRootFrame && 0 <= namePropDescriptor;
          RunInRootFrame--, namePropDescriptor--
        )
          if (sampleLines[RunInRootFrame] !== controlLines[namePropDescriptor]) {
            if (1 !== RunInRootFrame || 1 !== namePropDescriptor) {
              do
                if (
                  (RunInRootFrame--,
                  namePropDescriptor--,
                  0 > namePropDescriptor ||
                    sampleLines[RunInRootFrame] !== controlLines[namePropDescriptor])
                ) {
                  var frame = "\n" + sampleLines[RunInRootFrame].replace(" at new ", " at ");
                  fn2.displayName &&
                    frame.includes("<anonymous>") &&
                    (frame = frame.replace("<anonymous>", fn2.displayName));
                  return frame;
                }
              while (1 <= RunInRootFrame && 0 <= namePropDescriptor);
            }
            break;
          }
      }
    } finally {
      ((reentry = false), (Error.prepareStackTrace = previousPrepareStackTrace));
    }
    return (previousPrepareStackTrace = fn2 ? fn2.displayName || fn2.name : "")
      ? describeBuiltInComponentFrame(previousPrepareStackTrace)
      : "";
  }
  function describeComponentStackByType(type) {
    if ("string" === typeof type) return describeBuiltInComponentFrame(type);
    if ("function" === typeof type)
      return type.prototype && type.prototype.isReactComponent
        ? describeNativeComponentFrame(type, true)
        : describeNativeComponentFrame(type, false);
    if ("object" === typeof type && null !== type) {
      switch (type.$$typeof) {
        case REACT_FORWARD_REF_TYPE:
          return describeNativeComponentFrame(type.render, false);
        case REACT_MEMO_TYPE:
          return describeNativeComponentFrame(type.type, false);
        case REACT_LAZY_TYPE:
          var lazyComponent = type,
            payload = lazyComponent._payload;
          lazyComponent = lazyComponent._init;
          try {
            type = lazyComponent(payload);
          } catch (x3) {
            return describeBuiltInComponentFrame("Lazy");
          }
          return describeComponentStackByType(type);
      }
      if ("string" === typeof type.name) {
        a: {
          payload = type.name;
          lazyComponent = type.env;
          var location = type.debugLocation;
          if (
            null != location &&
            ((type = Error.prepareStackTrace),
            (Error.prepareStackTrace = prepareStackTrace),
            (location = location.stack),
            (Error.prepareStackTrace = type),
            location.startsWith("Error: react-stack-top-frame\n") &&
              (location = location.slice(29)),
            (type = location.indexOf("\n")),
            -1 !== type && (location = location.slice(type + 1)),
            (type = location.indexOf("react_stack_bottom_frame")),
            -1 !== type && (type = location.lastIndexOf("\n", type)),
            (type = -1 !== type ? (location = location.slice(0, type)) : ""),
            (location = type.lastIndexOf("\n")),
            (type = -1 === location ? type : type.slice(location + 1)),
            -1 !== type.indexOf(payload))
          ) {
            payload = "\n" + type;
            break a;
          }
          payload = describeBuiltInComponentFrame(
            payload + (lazyComponent ? " [" + lazyComponent + "]" : ""),
          );
        }
        return payload;
      }
    }
    switch (type) {
      case REACT_SUSPENSE_LIST_TYPE:
        return describeBuiltInComponentFrame("SuspenseList");
      case REACT_SUSPENSE_TYPE:
        return describeBuiltInComponentFrame("Suspense");
    }
    return "";
  }
  function isEligibleForOutlining(request, boundary) {
    return (
      (500 < boundary.byteSize || hasSuspenseyContent(boundary.contentState)) &&
      null === boundary.contentPreamble
    );
  }
  function defaultErrorHandler(error) {
    if ("object" === typeof error && null !== error && "string" === typeof error.environmentName) {
      var JSCompiler_inline_result = error.environmentName;
      error = [error].slice(0);
      "string" === typeof error[0]
        ? error.splice(
            0,
            1,
            "\x1B[0m\x1B[7m%c%s\x1B[0m%c " + error[0],
            "background: #e6e6e6;background: light-dark(rgba(0,0,0,0.1), rgba(255,255,255,0.25));color: #000000;color: light-dark(#000000, #ffffff);border-radius: 2px",
            " " + JSCompiler_inline_result + " ",
            "",
          )
        : error.splice(
            0,
            0,
            "\x1B[0m\x1B[7m%c%s\x1B[0m%c",
            "background: #e6e6e6;background: light-dark(rgba(0,0,0,0.1), rgba(255,255,255,0.25));color: #000000;color: light-dark(#000000, #ffffff);border-radius: 2px",
            " " + JSCompiler_inline_result + " ",
            "",
          );
      error.unshift(console);
      JSCompiler_inline_result = bind.apply(console.error, error);
      JSCompiler_inline_result();
    } else console.error(error);
    return null;
  }
  function RequestInstance(
    resumableState,
    renderState,
    rootFormatContext,
    progressiveChunkSize,
    onError,
    onAllReady,
    onShellReady,
    onShellError,
    onFatalError,
    onPostpone,
    formState,
  ) {
    var abortSet = /* @__PURE__ */ new Set();
    this.destination = null;
    this.flushScheduled = false;
    this.resumableState = resumableState;
    this.renderState = renderState;
    this.rootFormatContext = rootFormatContext;
    this.progressiveChunkSize = void 0 === progressiveChunkSize ? 12800 : progressiveChunkSize;
    this.status = 10;
    this.fatalError = null;
    this.pendingRootTasks = this.allPendingTasks = this.nextSegmentId = 0;
    this.completedPreambleSegments = this.completedRootSegment = null;
    this.byteSize = 0;
    this.abortableTasks = abortSet;
    this.pingedTasks = [];
    this.clientRenderedBoundaries = [];
    this.completedBoundaries = [];
    this.partialBoundaries = [];
    this.trackedPostpones = null;
    this.onError = void 0 === onError ? defaultErrorHandler : onError;
    this.onPostpone = void 0 === onPostpone ? noop : onPostpone;
    this.onAllReady = void 0 === onAllReady ? noop : onAllReady;
    this.onShellReady = void 0 === onShellReady ? noop : onShellReady;
    this.onShellError = void 0 === onShellError ? noop : onShellError;
    this.onFatalError = void 0 === onFatalError ? noop : onFatalError;
    this.formState = void 0 === formState ? null : formState;
  }
  function createRequest(
    children,
    resumableState,
    renderState,
    rootFormatContext,
    progressiveChunkSize,
    onError,
    onAllReady,
    onShellReady,
    onShellError,
    onFatalError,
    onPostpone,
    formState,
  ) {
    resumableState = new RequestInstance(
      resumableState,
      renderState,
      rootFormatContext,
      progressiveChunkSize,
      onError,
      onAllReady,
      onShellReady,
      onShellError,
      onFatalError,
      onPostpone,
      formState,
    );
    renderState = createPendingSegment(resumableState, 0, null, rootFormatContext, false, false);
    renderState.parentFlushed = true;
    children = createRenderTask(
      resumableState,
      null,
      children,
      -1,
      null,
      renderState,
      null,
      null,
      resumableState.abortableTasks,
      null,
      rootFormatContext,
      null,
      emptyTreeContext,
      null,
      null,
    );
    pushComponentStack(children);
    resumableState.pingedTasks.push(children);
    return resumableState;
  }
  function createPrerenderRequest(
    children,
    resumableState,
    renderState,
    rootFormatContext,
    progressiveChunkSize,
    onError,
    onAllReady,
    onShellReady,
    onShellError,
    onFatalError,
    onPostpone,
  ) {
    children = createRequest(
      children,
      resumableState,
      renderState,
      rootFormatContext,
      progressiveChunkSize,
      onError,
      onAllReady,
      onShellReady,
      onShellError,
      onFatalError,
      onPostpone,
      void 0,
    );
    children.trackedPostpones = {
      workingMap: /* @__PURE__ */ new Map(),
      rootNodes: [],
      rootSlots: null,
    };
    return children;
  }
  function resumeRequest(
    children,
    postponedState,
    renderState,
    onError,
    onAllReady,
    onShellReady,
    onShellError,
    onFatalError,
    onPostpone,
  ) {
    renderState = new RequestInstance(
      postponedState.resumableState,
      renderState,
      postponedState.rootFormatContext,
      postponedState.progressiveChunkSize,
      onError,
      onAllReady,
      onShellReady,
      onShellError,
      onFatalError,
      onPostpone,
      null,
    );
    renderState.nextSegmentId = postponedState.nextSegmentId;
    if ("number" === typeof postponedState.replaySlots)
      return (
        (onError = createPendingSegment(
          renderState,
          0,
          null,
          postponedState.rootFormatContext,
          false,
          false,
        )),
        (onError.parentFlushed = true),
        (children = createRenderTask(
          renderState,
          null,
          children,
          -1,
          null,
          onError,
          null,
          null,
          renderState.abortableTasks,
          null,
          postponedState.rootFormatContext,
          null,
          emptyTreeContext,
          null,
          null,
        )),
        pushComponentStack(children),
        renderState.pingedTasks.push(children),
        renderState
      );
    children = createReplayTask(
      renderState,
      null,
      {
        nodes: postponedState.replayNodes,
        slots: postponedState.replaySlots,
        pendingTasks: 0,
      },
      children,
      -1,
      null,
      null,
      renderState.abortableTasks,
      null,
      postponedState.rootFormatContext,
      null,
      emptyTreeContext,
      null,
      null,
    );
    pushComponentStack(children);
    renderState.pingedTasks.push(children);
    return renderState;
  }
  function resumeAndPrerenderRequest(
    children,
    postponedState,
    renderState,
    onError,
    onAllReady,
    onShellReady,
    onShellError,
    onFatalError,
    onPostpone,
  ) {
    children = resumeRequest(
      children,
      postponedState,
      renderState,
      onError,
      onAllReady,
      onShellReady,
      onShellError,
      onFatalError,
      onPostpone,
    );
    children.trackedPostpones = {
      workingMap: /* @__PURE__ */ new Map(),
      rootNodes: [],
      rootSlots: null,
    };
    return children;
  }
  var currentRequest = null;
  function resolveRequest() {
    if (currentRequest) return currentRequest;
    if (supportsRequestStorage) {
      var store = requestStorage.getStore();
      if (store) return store;
    }
    return null;
  }
  function pingTask(request, task) {
    request.pingedTasks.push(task);
    1 === request.pingedTasks.length &&
      ((request.flushScheduled = null !== request.destination),
      null !== request.trackedPostpones || 10 === request.status
        ? scheduleMicrotask(function () {
            return performWork(request);
          })
        : setTimeout(function () {
            return performWork(request);
          }, 0));
  }
  function createSuspenseBoundary(
    request,
    row,
    fallbackAbortableTasks,
    contentPreamble,
    fallbackPreamble,
  ) {
    fallbackAbortableTasks = {
      status: 0,
      rootSegmentID: -1,
      parentFlushed: false,
      pendingTasks: 0,
      row,
      completedSegments: [],
      byteSize: 0,
      fallbackAbortableTasks,
      errorDigest: null,
      contentState: createHoistableState(),
      fallbackState: createHoistableState(),
      contentPreamble,
      fallbackPreamble,
      trackedContentKeyPath: null,
      trackedFallbackNode: null,
    };
    null !== row &&
      (row.pendingTasks++,
      (contentPreamble = row.boundaries),
      null !== contentPreamble &&
        (request.allPendingTasks++,
        fallbackAbortableTasks.pendingTasks++,
        contentPreamble.push(fallbackAbortableTasks)),
      (request = row.inheritedHoistables),
      null !== request && hoistHoistables(fallbackAbortableTasks.contentState, request));
    return fallbackAbortableTasks;
  }
  function createRenderTask(
    request,
    thenableState2,
    node,
    childIndex,
    blockedBoundary,
    blockedSegment,
    blockedPreamble,
    hoistableState,
    abortSet,
    keyPath,
    formatContext,
    context,
    treeContext,
    row,
    componentStack,
  ) {
    request.allPendingTasks++;
    null === blockedBoundary ? request.pendingRootTasks++ : blockedBoundary.pendingTasks++;
    null !== row && row.pendingTasks++;
    var task = {
      replay: null,
      node,
      childIndex,
      ping: function () {
        return pingTask(request, task);
      },
      blockedBoundary,
      blockedSegment,
      blockedPreamble,
      hoistableState,
      abortSet,
      keyPath,
      formatContext,
      context,
      treeContext,
      row,
      componentStack,
      thenableState: thenableState2,
    };
    abortSet.add(task);
    return task;
  }
  function createReplayTask(
    request,
    thenableState2,
    replay,
    node,
    childIndex,
    blockedBoundary,
    hoistableState,
    abortSet,
    keyPath,
    formatContext,
    context,
    treeContext,
    row,
    componentStack,
  ) {
    request.allPendingTasks++;
    null === blockedBoundary ? request.pendingRootTasks++ : blockedBoundary.pendingTasks++;
    null !== row && row.pendingTasks++;
    replay.pendingTasks++;
    var task = {
      replay,
      node,
      childIndex,
      ping: function () {
        return pingTask(request, task);
      },
      blockedBoundary,
      blockedSegment: null,
      blockedPreamble: null,
      hoistableState,
      abortSet,
      keyPath,
      formatContext,
      context,
      treeContext,
      row,
      componentStack,
      thenableState: thenableState2,
    };
    abortSet.add(task);
    return task;
  }
  function createPendingSegment(
    request,
    index,
    boundary,
    parentFormatContext,
    lastPushedText,
    textEmbedded,
  ) {
    return {
      status: 0,
      parentFlushed: false,
      id: -1,
      index,
      chunks: [],
      children: [],
      preambleChildren: [],
      parentFormatContext,
      boundary,
      lastPushedText,
      textEmbedded,
    };
  }
  function pushComponentStack(task) {
    var node = task.node;
    if ("object" === typeof node && null !== node)
      switch (node.$$typeof) {
        case REACT_ELEMENT_TYPE:
          task.componentStack = { parent: task.componentStack, type: node.type };
      }
  }
  function replaceSuspenseComponentStackWithSuspenseFallbackStack(componentStack) {
    return null === componentStack
      ? null
      : { parent: componentStack.parent, type: "Suspense Fallback" };
  }
  function getThrownInfo(node$jscomp$0) {
    var errorInfo = {};
    node$jscomp$0 &&
      Object.defineProperty(errorInfo, "componentStack", {
        configurable: true,
        enumerable: true,
        get: function () {
          try {
            var info = "",
              node = node$jscomp$0;
            do ((info += describeComponentStackByType(node.type)), (node = node.parent));
            while (node);
            var JSCompiler_inline_result = info;
          } catch (x3) {
            JSCompiler_inline_result = "\nError generating stack: " + x3.message + "\n" + x3.stack;
          }
          Object.defineProperty(errorInfo, "componentStack", {
            value: JSCompiler_inline_result,
          });
          return JSCompiler_inline_result;
        },
      });
    return errorInfo;
  }
  function logRecoverableError(request, error, errorInfo) {
    request = request.onError;
    error = request(error, errorInfo);
    if (null == error || "string" === typeof error) return error;
  }
  function fatalError(request, error) {
    var onShellError = request.onShellError,
      onFatalError = request.onFatalError;
    onShellError(error);
    onFatalError(error);
    null !== request.destination
      ? ((request.status = 14), closeWithError(request.destination, error))
      : ((request.status = 13), (request.fatalError = error));
  }
  function finishSuspenseListRow(request, row) {
    unblockSuspenseListRow(request, row.next, row.hoistables);
  }
  function unblockSuspenseListRow(request, unblockedRow, inheritedHoistables) {
    for (; null !== unblockedRow; ) {
      null !== inheritedHoistables &&
        (hoistHoistables(unblockedRow.hoistables, inheritedHoistables),
        (unblockedRow.inheritedHoistables = inheritedHoistables));
      var unblockedBoundaries = unblockedRow.boundaries;
      if (null !== unblockedBoundaries) {
        unblockedRow.boundaries = null;
        for (var i = 0; i < unblockedBoundaries.length; i++) {
          var unblockedBoundary = unblockedBoundaries[i];
          null !== inheritedHoistables &&
            hoistHoistables(unblockedBoundary.contentState, inheritedHoistables);
          finishedTask(request, unblockedBoundary, null, null);
        }
      }
      unblockedRow.pendingTasks--;
      if (0 < unblockedRow.pendingTasks) break;
      inheritedHoistables = unblockedRow.hoistables;
      unblockedRow = unblockedRow.next;
    }
  }
  function tryToResolveTogetherRow(request, togetherRow) {
    var boundaries = togetherRow.boundaries;
    if (null !== boundaries && togetherRow.pendingTasks === boundaries.length) {
      for (var allCompleteAndInlinable = true, i = 0; i < boundaries.length; i++) {
        var rowBoundary = boundaries[i];
        if (
          1 !== rowBoundary.pendingTasks ||
          rowBoundary.parentFlushed ||
          isEligibleForOutlining(request, rowBoundary)
        ) {
          allCompleteAndInlinable = false;
          break;
        }
      }
      allCompleteAndInlinable &&
        unblockSuspenseListRow(request, togetherRow, togetherRow.hoistables);
    }
  }
  function createSuspenseListRow(previousRow) {
    var newRow = {
      pendingTasks: 1,
      boundaries: null,
      hoistables: createHoistableState(),
      inheritedHoistables: null,
      together: false,
      next: null,
    };
    null !== previousRow &&
      0 < previousRow.pendingTasks &&
      (newRow.pendingTasks++, (newRow.boundaries = []), (previousRow.next = newRow));
    return newRow;
  }
  function renderSuspenseListRows(request, task, keyPath, rows, revealOrder) {
    var prevKeyPath = task.keyPath,
      prevTreeContext = task.treeContext,
      prevRow = task.row;
    task.keyPath = keyPath;
    keyPath = rows.length;
    var previousSuspenseListRow = null;
    if (null !== task.replay) {
      var resumeSlots = task.replay.slots;
      if (null !== resumeSlots && "object" === typeof resumeSlots)
        for (var n2 = 0; n2 < keyPath; n2++) {
          var i =
              "backwards" !== revealOrder && "unstable_legacy-backwards" !== revealOrder
                ? n2
                : keyPath - 1 - n2,
            node = rows[i];
          task.row = previousSuspenseListRow = createSuspenseListRow(previousSuspenseListRow);
          task.treeContext = pushTreeContext(prevTreeContext, keyPath, i);
          var resumeSegmentID = resumeSlots[i];
          "number" === typeof resumeSegmentID
            ? (resumeNode(request, task, resumeSegmentID, node, i), delete resumeSlots[i])
            : renderNode(request, task, node, i);
          0 === --previousSuspenseListRow.pendingTasks &&
            finishSuspenseListRow(request, previousSuspenseListRow);
        }
      else
        for (resumeSlots = 0; resumeSlots < keyPath; resumeSlots++)
          ((n2 =
            "backwards" !== revealOrder && "unstable_legacy-backwards" !== revealOrder
              ? resumeSlots
              : keyPath - 1 - resumeSlots),
            (i = rows[n2]),
            (task.row = previousSuspenseListRow = createSuspenseListRow(previousSuspenseListRow)),
            (task.treeContext = pushTreeContext(prevTreeContext, keyPath, n2)),
            renderNode(request, task, i, n2),
            0 === --previousSuspenseListRow.pendingTasks &&
              finishSuspenseListRow(request, previousSuspenseListRow));
    } else if ("backwards" !== revealOrder && "unstable_legacy-backwards" !== revealOrder)
      for (revealOrder = 0; revealOrder < keyPath; revealOrder++)
        ((resumeSlots = rows[revealOrder]),
          (task.row = previousSuspenseListRow = createSuspenseListRow(previousSuspenseListRow)),
          (task.treeContext = pushTreeContext(prevTreeContext, keyPath, revealOrder)),
          renderNode(request, task, resumeSlots, revealOrder),
          0 === --previousSuspenseListRow.pendingTasks &&
            finishSuspenseListRow(request, previousSuspenseListRow));
    else {
      revealOrder = task.blockedSegment;
      resumeSlots = revealOrder.children.length;
      n2 = revealOrder.chunks.length;
      for (i = keyPath - 1; 0 <= i; i--) {
        node = rows[i];
        task.row = previousSuspenseListRow = createSuspenseListRow(previousSuspenseListRow);
        task.treeContext = pushTreeContext(prevTreeContext, keyPath, i);
        resumeSegmentID = createPendingSegment(
          request,
          n2,
          null,
          task.formatContext,
          0 === i ? revealOrder.lastPushedText : true,
          true,
        );
        revealOrder.children.splice(resumeSlots, 0, resumeSegmentID);
        task.blockedSegment = resumeSegmentID;
        try {
          (renderNode(request, task, node, i),
            resumeSegmentID.lastPushedText &&
              resumeSegmentID.textEmbedded &&
              resumeSegmentID.chunks.push(textSeparator),
            (resumeSegmentID.status = 1),
            finishedSegment(request, task.blockedBoundary, resumeSegmentID),
            0 === --previousSuspenseListRow.pendingTasks &&
              finishSuspenseListRow(request, previousSuspenseListRow));
        } catch (thrownValue) {
          throw ((resumeSegmentID.status = 12 === request.status ? 3 : 4), thrownValue);
        }
      }
      task.blockedSegment = revealOrder;
      revealOrder.lastPushedText = false;
    }
    null !== prevRow &&
      null !== previousSuspenseListRow &&
      0 < previousSuspenseListRow.pendingTasks &&
      (prevRow.pendingTasks++, (previousSuspenseListRow.next = prevRow));
    task.treeContext = prevTreeContext;
    task.row = prevRow;
    task.keyPath = prevKeyPath;
  }
  function renderWithHooks(request, task, keyPath, Component, props, secondArg) {
    var prevThenableState = task.thenableState;
    task.thenableState = null;
    currentlyRenderingComponent = {};
    currentlyRenderingTask = task;
    currentlyRenderingRequest = request;
    currentlyRenderingKeyPath = keyPath;
    actionStateCounter = localIdCounter = 0;
    actionStateMatchingIndex = -1;
    thenableIndexCounter = 0;
    thenableState = prevThenableState;
    for (request = Component(props, secondArg); didScheduleRenderPhaseUpdate; )
      ((didScheduleRenderPhaseUpdate = false),
        (actionStateCounter = localIdCounter = 0),
        (actionStateMatchingIndex = -1),
        (thenableIndexCounter = 0),
        (numberOfReRenders += 1),
        (workInProgressHook = null),
        (request = Component(props, secondArg)));
    resetHooksState();
    return request;
  }
  function finishFunctionComponent(
    request,
    task,
    keyPath,
    children,
    hasId,
    actionStateCount,
    actionStateMatchingIndex2,
  ) {
    var didEmitActionStateMarkers = false;
    if (0 !== actionStateCount && null !== request.formState) {
      var segment = task.blockedSegment;
      if (null !== segment) {
        didEmitActionStateMarkers = true;
        segment = segment.chunks;
        for (var i = 0; i < actionStateCount; i++)
          i === actionStateMatchingIndex2
            ? segment.push(formStateMarkerIsMatching)
            : segment.push(formStateMarkerIsNotMatching);
      }
    }
    actionStateCount = task.keyPath;
    task.keyPath = keyPath;
    hasId
      ? ((keyPath = task.treeContext),
        (task.treeContext = pushTreeContext(keyPath, 1, 0)),
        renderNode(request, task, children, -1),
        (task.treeContext = keyPath))
      : didEmitActionStateMarkers
        ? renderNode(request, task, children, -1)
        : renderNodeDestructive(request, task, children, -1);
    task.keyPath = actionStateCount;
  }
  function renderElement(request, task, keyPath, type, props, ref) {
    if ("function" === typeof type)
      if (type.prototype && type.prototype.isReactComponent) {
        var newProps = props;
        if ("ref" in props) {
          newProps = {};
          for (var propName in props) "ref" !== propName && (newProps[propName] = props[propName]);
        }
        var defaultProps = type.defaultProps;
        if (defaultProps) {
          newProps === props && (newProps = assign({}, newProps, props));
          for (var propName$44 in defaultProps)
            void 0 === newProps[propName$44] && (newProps[propName$44] = defaultProps[propName$44]);
        }
        props = newProps;
        newProps = emptyContextObject;
        defaultProps = type.contextType;
        "object" === typeof defaultProps &&
          null !== defaultProps &&
          (newProps = defaultProps._currentValue);
        newProps = new type(props, newProps);
        var initialState = void 0 !== newProps.state ? newProps.state : null;
        newProps.updater = classComponentUpdater;
        newProps.props = props;
        newProps.state = initialState;
        defaultProps = { queue: [], replace: false };
        newProps._reactInternals = defaultProps;
        ref = type.contextType;
        newProps.context =
          "object" === typeof ref && null !== ref ? ref._currentValue : emptyContextObject;
        ref = type.getDerivedStateFromProps;
        "function" === typeof ref &&
          ((ref = ref(props, initialState)),
          (initialState =
            null === ref || void 0 === ref ? initialState : assign({}, initialState, ref)),
          (newProps.state = initialState));
        if (
          "function" !== typeof type.getDerivedStateFromProps &&
          "function" !== typeof newProps.getSnapshotBeforeUpdate &&
          ("function" === typeof newProps.UNSAFE_componentWillMount ||
            "function" === typeof newProps.componentWillMount)
        )
          if (
            ((type = newProps.state),
            "function" === typeof newProps.componentWillMount && newProps.componentWillMount(),
            "function" === typeof newProps.UNSAFE_componentWillMount &&
              newProps.UNSAFE_componentWillMount(),
            type !== newProps.state &&
              classComponentUpdater.enqueueReplaceState(newProps, newProps.state, null),
            null !== defaultProps.queue && 0 < defaultProps.queue.length)
          )
            if (
              ((type = defaultProps.queue),
              (ref = defaultProps.replace),
              (defaultProps.queue = null),
              (defaultProps.replace = false),
              ref && 1 === type.length)
            )
              newProps.state = type[0];
            else {
              defaultProps = ref ? type[0] : newProps.state;
              initialState = true;
              for (ref = ref ? 1 : 0; ref < type.length; ref++)
                ((propName$44 = type[ref]),
                  (propName$44 =
                    "function" === typeof propName$44
                      ? propName$44.call(newProps, defaultProps, props, void 0)
                      : propName$44),
                  null != propName$44 &&
                    (initialState
                      ? ((initialState = false),
                        (defaultProps = assign({}, defaultProps, propName$44)))
                      : assign(defaultProps, propName$44)));
              newProps.state = defaultProps;
            }
          else defaultProps.queue = null;
        type = newProps.render();
        if (12 === request.status) throw null;
        props = task.keyPath;
        task.keyPath = keyPath;
        renderNodeDestructive(request, task, type, -1);
        task.keyPath = props;
      } else {
        type = renderWithHooks(request, task, keyPath, type, props, void 0);
        if (12 === request.status) throw null;
        finishFunctionComponent(
          request,
          task,
          keyPath,
          type,
          0 !== localIdCounter,
          actionStateCounter,
          actionStateMatchingIndex,
        );
      }
    else if ("string" === typeof type)
      if (((newProps = task.blockedSegment), null === newProps))
        ((newProps = props.children),
          (defaultProps = task.formatContext),
          (initialState = task.keyPath),
          (task.formatContext = getChildFormatContext(defaultProps, type, props)),
          (task.keyPath = keyPath),
          renderNode(request, task, newProps, -1),
          (task.formatContext = defaultProps),
          (task.keyPath = initialState));
      else {
        initialState = pushStartInstance(
          newProps.chunks,
          type,
          props,
          request.resumableState,
          request.renderState,
          task.blockedPreamble,
          task.hoistableState,
          task.formatContext,
          newProps.lastPushedText,
        );
        newProps.lastPushedText = false;
        defaultProps = task.formatContext;
        ref = task.keyPath;
        task.keyPath = keyPath;
        if (
          3 ===
          (task.formatContext = getChildFormatContext(defaultProps, type, props)).insertionMode
        ) {
          keyPath = createPendingSegment(request, 0, null, task.formatContext, false, false);
          newProps.preambleChildren.push(keyPath);
          task.blockedSegment = keyPath;
          try {
            ((keyPath.status = 6),
              renderNode(request, task, initialState, -1),
              keyPath.lastPushedText && keyPath.textEmbedded && keyPath.chunks.push(textSeparator),
              (keyPath.status = 1),
              finishedSegment(request, task.blockedBoundary, keyPath));
          } finally {
            task.blockedSegment = newProps;
          }
        } else renderNode(request, task, initialState, -1);
        task.formatContext = defaultProps;
        task.keyPath = ref;
        a: {
          task = newProps.chunks;
          request = request.resumableState;
          switch (type) {
            case "title":
            case "style":
            case "script":
            case "area":
            case "base":
            case "br":
            case "col":
            case "embed":
            case "hr":
            case "img":
            case "input":
            case "keygen":
            case "link":
            case "meta":
            case "param":
            case "source":
            case "track":
            case "wbr":
              break a;
            case "body":
              if (1 >= defaultProps.insertionMode) {
                request.hasBody = true;
                break a;
              }
              break;
            case "html":
              if (0 === defaultProps.insertionMode) {
                request.hasHtml = true;
                break a;
              }
              break;
            case "head":
              if (1 >= defaultProps.insertionMode) break a;
          }
          task.push(endChunkForTag(type));
        }
        newProps.lastPushedText = false;
      }
    else {
      switch (type) {
        case REACT_LEGACY_HIDDEN_TYPE:
        case REACT_STRICT_MODE_TYPE:
        case REACT_PROFILER_TYPE:
        case REACT_FRAGMENT_TYPE:
          type = task.keyPath;
          task.keyPath = keyPath;
          renderNodeDestructive(request, task, props.children, -1);
          task.keyPath = type;
          return;
        case REACT_ACTIVITY_TYPE:
          type = task.blockedSegment;
          null === type
            ? "hidden" !== props.mode &&
              ((type = task.keyPath),
              (task.keyPath = keyPath),
              renderNode(request, task, props.children, -1),
              (task.keyPath = type))
            : "hidden" !== props.mode &&
              (type.chunks.push(startActivityBoundary),
              (type.lastPushedText = false),
              (newProps = task.keyPath),
              (task.keyPath = keyPath),
              renderNode(request, task, props.children, -1),
              (task.keyPath = newProps),
              type.chunks.push(endActivityBoundary),
              (type.lastPushedText = false));
          return;
        case REACT_SUSPENSE_LIST_TYPE:
          a: {
            type = props.children;
            props = props.revealOrder;
            if (
              "forwards" === props ||
              "backwards" === props ||
              "unstable_legacy-backwards" === props
            ) {
              if (isArrayImpl(type)) {
                renderSuspenseListRows(request, task, keyPath, type, props);
                break a;
              }
              if ((newProps = getIteratorFn(type))) {
                if ((newProps = newProps.call(type))) {
                  defaultProps = newProps.next();
                  if (!defaultProps.done) {
                    do defaultProps = newProps.next();
                    while (!defaultProps.done);
                    renderSuspenseListRows(request, task, keyPath, type, props);
                  }
                  break a;
                }
              }
            }
            "together" === props
              ? ((props = task.keyPath),
                (newProps = task.row),
                (defaultProps = task.row = createSuspenseListRow(null)),
                (defaultProps.boundaries = []),
                (defaultProps.together = true),
                (task.keyPath = keyPath),
                renderNodeDestructive(request, task, type, -1),
                0 === --defaultProps.pendingTasks && finishSuspenseListRow(request, defaultProps),
                (task.keyPath = props),
                (task.row = newProps),
                null !== newProps &&
                  0 < defaultProps.pendingTasks &&
                  (newProps.pendingTasks++, (defaultProps.next = newProps)))
              : ((props = task.keyPath),
                (task.keyPath = keyPath),
                renderNodeDestructive(request, task, type, -1),
                (task.keyPath = props));
          }
          return;
        case REACT_VIEW_TRANSITION_TYPE:
        case REACT_SCOPE_TYPE:
          throw Error("ReactDOMServer does not yet support scope components.");
        case REACT_SUSPENSE_TYPE:
          a: if (null !== task.replay) {
            type = task.keyPath;
            newProps = task.formatContext;
            defaultProps = task.row;
            task.keyPath = keyPath;
            task.formatContext = getSuspenseContentFormatContext(request.resumableState, newProps);
            task.row = null;
            keyPath = props.children;
            try {
              renderNode(request, task, keyPath, -1);
            } finally {
              ((task.keyPath = type), (task.formatContext = newProps), (task.row = defaultProps));
            }
          } else {
            type = task.keyPath;
            ref = task.formatContext;
            var prevRow = task.row;
            propName$44 = task.blockedBoundary;
            propName = task.blockedPreamble;
            var parentHoistableState = task.hoistableState,
              parentSegment = task.blockedSegment,
              fallback = props.fallback;
            props = props.children;
            var fallbackAbortSet = /* @__PURE__ */ new Set();
            var newBoundary =
              2 > task.formatContext.insertionMode
                ? createSuspenseBoundary(
                    request,
                    task.row,
                    fallbackAbortSet,
                    createPreambleState(),
                    createPreambleState(),
                  )
                : createSuspenseBoundary(request, task.row, fallbackAbortSet, null, null);
            null !== request.trackedPostpones && (newBoundary.trackedContentKeyPath = keyPath);
            var boundarySegment = createPendingSegment(
              request,
              parentSegment.chunks.length,
              newBoundary,
              task.formatContext,
              false,
              false,
            );
            parentSegment.children.push(boundarySegment);
            parentSegment.lastPushedText = false;
            var contentRootSegment = createPendingSegment(
              request,
              0,
              null,
              task.formatContext,
              false,
              false,
            );
            contentRootSegment.parentFlushed = true;
            if (null !== request.trackedPostpones) {
              newProps = task.componentStack;
              defaultProps = [keyPath[0], "Suspense Fallback", keyPath[2]];
              initialState = [defaultProps[1], defaultProps[2], [], null];
              request.trackedPostpones.workingMap.set(defaultProps, initialState);
              newBoundary.trackedFallbackNode = initialState;
              task.blockedSegment = boundarySegment;
              task.blockedPreamble = newBoundary.fallbackPreamble;
              task.keyPath = defaultProps;
              task.formatContext = getSuspenseFallbackFormatContext(request.resumableState, ref);
              task.componentStack =
                replaceSuspenseComponentStackWithSuspenseFallbackStack(newProps);
              boundarySegment.status = 6;
              try {
                (renderNode(request, task, fallback, -1),
                  boundarySegment.lastPushedText &&
                    boundarySegment.textEmbedded &&
                    boundarySegment.chunks.push(textSeparator),
                  (boundarySegment.status = 1),
                  finishedSegment(request, propName$44, boundarySegment));
              } catch (thrownValue) {
                throw ((boundarySegment.status = 12 === request.status ? 3 : 4), thrownValue);
              } finally {
                ((task.blockedSegment = parentSegment),
                  (task.blockedPreamble = propName),
                  (task.keyPath = type),
                  (task.formatContext = ref));
              }
              task = createRenderTask(
                request,
                null,
                props,
                -1,
                newBoundary,
                contentRootSegment,
                newBoundary.contentPreamble,
                newBoundary.contentState,
                task.abortSet,
                keyPath,
                getSuspenseContentFormatContext(request.resumableState, task.formatContext),
                task.context,
                task.treeContext,
                null,
                newProps,
              );
              pushComponentStack(task);
              request.pingedTasks.push(task);
            } else {
              task.blockedBoundary = newBoundary;
              task.blockedPreamble = newBoundary.contentPreamble;
              task.hoistableState = newBoundary.contentState;
              task.blockedSegment = contentRootSegment;
              task.keyPath = keyPath;
              task.formatContext = getSuspenseContentFormatContext(request.resumableState, ref);
              task.row = null;
              contentRootSegment.status = 6;
              try {
                if (
                  (renderNode(request, task, props, -1),
                  contentRootSegment.lastPushedText &&
                    contentRootSegment.textEmbedded &&
                    contentRootSegment.chunks.push(textSeparator),
                  (contentRootSegment.status = 1),
                  finishedSegment(request, newBoundary, contentRootSegment),
                  queueCompletedSegment(newBoundary, contentRootSegment),
                  0 === newBoundary.pendingTasks && 0 === newBoundary.status)
                ) {
                  if (((newBoundary.status = 1), !isEligibleForOutlining(request, newBoundary))) {
                    null !== prevRow &&
                      0 === --prevRow.pendingTasks &&
                      finishSuspenseListRow(request, prevRow);
                    0 === request.pendingRootTasks &&
                      task.blockedPreamble &&
                      preparePreamble(request);
                    break a;
                  }
                } else
                  null !== prevRow && prevRow.together && tryToResolveTogetherRow(request, prevRow);
              } catch (thrownValue$31) {
                ((newBoundary.status = 4),
                  12 === request.status
                    ? ((contentRootSegment.status = 3), (newProps = request.fatalError))
                    : ((contentRootSegment.status = 4), (newProps = thrownValue$31)),
                  (defaultProps = getThrownInfo(task.componentStack)),
                  (initialState = logRecoverableError(request, newProps, defaultProps)),
                  (newBoundary.errorDigest = initialState),
                  untrackBoundary(request, newBoundary));
              } finally {
                ((task.blockedBoundary = propName$44),
                  (task.blockedPreamble = propName),
                  (task.hoistableState = parentHoistableState),
                  (task.blockedSegment = parentSegment),
                  (task.keyPath = type),
                  (task.formatContext = ref),
                  (task.row = prevRow));
              }
              task = createRenderTask(
                request,
                null,
                fallback,
                -1,
                propName$44,
                boundarySegment,
                newBoundary.fallbackPreamble,
                newBoundary.fallbackState,
                fallbackAbortSet,
                [keyPath[0], "Suspense Fallback", keyPath[2]],
                getSuspenseFallbackFormatContext(request.resumableState, task.formatContext),
                task.context,
                task.treeContext,
                task.row,
                replaceSuspenseComponentStackWithSuspenseFallbackStack(task.componentStack),
              );
              pushComponentStack(task);
              request.pingedTasks.push(task);
            }
          }
          return;
      }
      if ("object" === typeof type && null !== type)
        switch (type.$$typeof) {
          case REACT_FORWARD_REF_TYPE:
            if ("ref" in props)
              for (parentSegment in ((newProps = {}), props))
                "ref" !== parentSegment && (newProps[parentSegment] = props[parentSegment]);
            else newProps = props;
            type = renderWithHooks(request, task, keyPath, type.render, newProps, ref);
            finishFunctionComponent(
              request,
              task,
              keyPath,
              type,
              0 !== localIdCounter,
              actionStateCounter,
              actionStateMatchingIndex,
            );
            return;
          case REACT_MEMO_TYPE:
            renderElement(request, task, keyPath, type.type, props, ref);
            return;
          case REACT_CONTEXT_TYPE:
            defaultProps = props.children;
            newProps = task.keyPath;
            props = props.value;
            initialState = type._currentValue;
            type._currentValue = props;
            ref = currentActiveSnapshot;
            currentActiveSnapshot = type = {
              parent: ref,
              depth: null === ref ? 0 : ref.depth + 1,
              context: type,
              parentValue: initialState,
              value: props,
            };
            task.context = type;
            task.keyPath = keyPath;
            renderNodeDestructive(request, task, defaultProps, -1);
            request = currentActiveSnapshot;
            if (null === request)
              throw Error("Tried to pop a Context at the root of the app. This is a bug in React.");
            request.context._currentValue = request.parentValue;
            request = currentActiveSnapshot = request.parent;
            task.context = request;
            task.keyPath = newProps;
            return;
          case REACT_CONSUMER_TYPE:
            props = props.children;
            type = props(type._context._currentValue);
            props = task.keyPath;
            task.keyPath = keyPath;
            renderNodeDestructive(request, task, type, -1);
            task.keyPath = props;
            return;
          case REACT_LAZY_TYPE:
            newProps = type._init;
            type = newProps(type._payload);
            if (12 === request.status) throw null;
            renderElement(request, task, keyPath, type, props, ref);
            return;
        }
      throw Error(
        "Element type is invalid: expected a string (for built-in components) or a class/function (for composite components) but got: " +
          ((null == type ? type : typeof type) + "."),
      );
    }
  }
  function resumeNode(request, task, segmentId, node, childIndex) {
    var prevReplay = task.replay,
      blockedBoundary = task.blockedBoundary,
      resumedSegment = createPendingSegment(request, 0, null, task.formatContext, false, false);
    resumedSegment.id = segmentId;
    resumedSegment.parentFlushed = true;
    try {
      ((task.replay = null),
        (task.blockedSegment = resumedSegment),
        renderNode(request, task, node, childIndex),
        (resumedSegment.status = 1),
        finishedSegment(request, blockedBoundary, resumedSegment),
        null === blockedBoundary
          ? (request.completedRootSegment = resumedSegment)
          : (queueCompletedSegment(blockedBoundary, resumedSegment),
            blockedBoundary.parentFlushed && request.partialBoundaries.push(blockedBoundary)));
    } finally {
      ((task.replay = prevReplay), (task.blockedSegment = null));
    }
  }
  function renderNodeDestructive(request, task, node, childIndex) {
    null !== task.replay && "number" === typeof task.replay.slots
      ? resumeNode(request, task, task.replay.slots, node, childIndex)
      : ((task.node = node),
        (task.childIndex = childIndex),
        (node = task.componentStack),
        pushComponentStack(task),
        retryNode(request, task),
        (task.componentStack = node));
  }
  function retryNode(request, task) {
    var node = task.node,
      childIndex = task.childIndex;
    if (null !== node) {
      if ("object" === typeof node) {
        switch (node.$$typeof) {
          case REACT_ELEMENT_TYPE:
            var type = node.type,
              key = node.key,
              props = node.props;
            node = props.ref;
            var ref = void 0 !== node ? node : null,
              name = getComponentNameFromType(type),
              keyOrIndex = null == key ? (-1 === childIndex ? 0 : childIndex) : key;
            key = [task.keyPath, name, keyOrIndex];
            if (null !== task.replay)
              a: {
                var replay = task.replay;
                childIndex = replay.nodes;
                for (node = 0; node < childIndex.length; node++) {
                  var node$jscomp$0 = childIndex[node];
                  if (keyOrIndex === node$jscomp$0[1]) {
                    if (4 === node$jscomp$0.length) {
                      if (null !== name && name !== node$jscomp$0[0])
                        throw Error(
                          "Expected the resume to render <" +
                            node$jscomp$0[0] +
                            "> in this slot but instead it rendered <" +
                            name +
                            ">. The tree doesn't match so React will fallback to client rendering.",
                        );
                      var childNodes = node$jscomp$0[2];
                      name = node$jscomp$0[3];
                      keyOrIndex = task.node;
                      task.replay = {
                        nodes: childNodes,
                        slots: name,
                        pendingTasks: 1,
                      };
                      try {
                        renderElement(request, task, key, type, props, ref);
                        if (1 === task.replay.pendingTasks && 0 < task.replay.nodes.length)
                          throw Error(
                            "Couldn't find all resumable slots by key/index during replaying. The tree doesn't match so React will fallback to client rendering.",
                          );
                        task.replay.pendingTasks--;
                      } catch (x3) {
                        if (
                          "object" === typeof x3 &&
                          null !== x3 &&
                          (x3 === SuspenseException || "function" === typeof x3.then)
                        )
                          throw (
                            task.node === keyOrIndex
                              ? (task.replay = replay)
                              : childIndex.splice(node, 1),
                            x3
                          );
                        task.replay.pendingTasks--;
                        props = getThrownInfo(task.componentStack);
                        key = request;
                        request = task.blockedBoundary;
                        type = x3;
                        props = logRecoverableError(key, type, props);
                        abortRemainingReplayNodes(key, request, childNodes, name, type, props);
                      }
                      task.replay = replay;
                    } else {
                      if (type !== REACT_SUSPENSE_TYPE)
                        throw Error(
                          "Expected the resume to render <Suspense> in this slot but instead it rendered <" +
                            (getComponentNameFromType(type) || "Unknown") +
                            ">. The tree doesn't match so React will fallback to client rendering.",
                        );
                      b: {
                        replay = void 0;
                        type = node$jscomp$0[5];
                        ref = node$jscomp$0[2];
                        name = node$jscomp$0[3];
                        keyOrIndex = null === node$jscomp$0[4] ? [] : node$jscomp$0[4][2];
                        node$jscomp$0 = null === node$jscomp$0[4] ? null : node$jscomp$0[4][3];
                        var prevKeyPath = task.keyPath,
                          prevContext = task.formatContext,
                          prevRow = task.row,
                          previousReplaySet = task.replay,
                          parentBoundary = task.blockedBoundary,
                          parentHoistableState = task.hoistableState,
                          content = props.children,
                          fallback = props.fallback,
                          fallbackAbortSet = /* @__PURE__ */ new Set();
                        props =
                          2 > task.formatContext.insertionMode
                            ? createSuspenseBoundary(
                                request,
                                task.row,
                                fallbackAbortSet,
                                createPreambleState(),
                                createPreambleState(),
                              )
                            : createSuspenseBoundary(
                                request,
                                task.row,
                                fallbackAbortSet,
                                null,
                                null,
                              );
                        props.parentFlushed = true;
                        props.rootSegmentID = type;
                        task.blockedBoundary = props;
                        task.hoistableState = props.contentState;
                        task.keyPath = key;
                        task.formatContext = getSuspenseContentFormatContext(
                          request.resumableState,
                          prevContext,
                        );
                        task.row = null;
                        task.replay = {
                          nodes: ref,
                          slots: name,
                          pendingTasks: 1,
                        };
                        try {
                          renderNode(request, task, content, -1);
                          if (1 === task.replay.pendingTasks && 0 < task.replay.nodes.length)
                            throw Error(
                              "Couldn't find all resumable slots by key/index during replaying. The tree doesn't match so React will fallback to client rendering.",
                            );
                          task.replay.pendingTasks--;
                          if (0 === props.pendingTasks && 0 === props.status) {
                            props.status = 1;
                            request.completedBoundaries.push(props);
                            break b;
                          }
                        } catch (error) {
                          ((props.status = 4),
                            (childNodes = getThrownInfo(task.componentStack)),
                            (replay = logRecoverableError(request, error, childNodes)),
                            (props.errorDigest = replay),
                            task.replay.pendingTasks--,
                            request.clientRenderedBoundaries.push(props));
                        } finally {
                          ((task.blockedBoundary = parentBoundary),
                            (task.hoistableState = parentHoistableState),
                            (task.replay = previousReplaySet),
                            (task.keyPath = prevKeyPath),
                            (task.formatContext = prevContext),
                            (task.row = prevRow));
                        }
                        childNodes = createReplayTask(
                          request,
                          null,
                          {
                            nodes: keyOrIndex,
                            slots: node$jscomp$0,
                            pendingTasks: 0,
                          },
                          fallback,
                          -1,
                          parentBoundary,
                          props.fallbackState,
                          fallbackAbortSet,
                          [key[0], "Suspense Fallback", key[2]],
                          getSuspenseFallbackFormatContext(
                            request.resumableState,
                            task.formatContext,
                          ),
                          task.context,
                          task.treeContext,
                          task.row,
                          replaceSuspenseComponentStackWithSuspenseFallbackStack(
                            task.componentStack,
                          ),
                        );
                        pushComponentStack(childNodes);
                        request.pingedTasks.push(childNodes);
                      }
                    }
                    childIndex.splice(node, 1);
                    break a;
                  }
                }
              }
            else renderElement(request, task, key, type, props, ref);
            return;
          case REACT_PORTAL_TYPE:
            throw Error(
              "Portals are not currently supported by the server renderer. Render them conditionally so that they only appear on the client render.",
            );
          case REACT_LAZY_TYPE:
            childNodes = node._init;
            node = childNodes(node._payload);
            if (12 === request.status) throw null;
            renderNodeDestructive(request, task, node, childIndex);
            return;
        }
        if (isArrayImpl(node)) {
          renderChildrenArray(request, task, node, childIndex);
          return;
        }
        if ((childNodes = getIteratorFn(node))) {
          if ((childNodes = childNodes.call(node))) {
            node = childNodes.next();
            if (!node.done) {
              props = [];
              do (props.push(node.value), (node = childNodes.next()));
              while (!node.done);
              renderChildrenArray(request, task, props, childIndex);
            }
            return;
          }
        }
        if ("function" === typeof node.then)
          return (
            (task.thenableState = null),
            renderNodeDestructive(request, task, unwrapThenable(node), childIndex)
          );
        if (node.$$typeof === REACT_CONTEXT_TYPE)
          return renderNodeDestructive(request, task, node._currentValue, childIndex);
        childIndex = Object.prototype.toString.call(node);
        throw Error(
          "Objects are not valid as a React child (found: " +
            ("[object Object]" === childIndex
              ? "object with keys {" + Object.keys(node).join(", ") + "}"
              : childIndex) +
            "). If you meant to render a collection of children, use an array instead.",
        );
      }
      if ("string" === typeof node)
        ((childIndex = task.blockedSegment),
          null !== childIndex &&
            (childIndex.lastPushedText = pushTextInstance(
              childIndex.chunks,
              node,
              request.renderState,
              childIndex.lastPushedText,
            )));
      else if ("number" === typeof node || "bigint" === typeof node)
        ((childIndex = task.blockedSegment),
          null !== childIndex &&
            (childIndex.lastPushedText = pushTextInstance(
              childIndex.chunks,
              "" + node,
              request.renderState,
              childIndex.lastPushedText,
            )));
    }
  }
  function renderChildrenArray(request, task, children, childIndex) {
    var prevKeyPath = task.keyPath;
    if (
      -1 !== childIndex &&
      ((task.keyPath = [task.keyPath, "Fragment", childIndex]), null !== task.replay)
    ) {
      for (
        var replay = task.replay, replayNodes = replay.nodes, j2 = 0;
        j2 < replayNodes.length;
        j2++
      ) {
        var node = replayNodes[j2];
        if (node[1] === childIndex) {
          childIndex = node[2];
          node = node[3];
          task.replay = { nodes: childIndex, slots: node, pendingTasks: 1 };
          try {
            renderChildrenArray(request, task, children, -1);
            if (1 === task.replay.pendingTasks && 0 < task.replay.nodes.length)
              throw Error(
                "Couldn't find all resumable slots by key/index during replaying. The tree doesn't match so React will fallback to client rendering.",
              );
            task.replay.pendingTasks--;
          } catch (x3) {
            if (
              "object" === typeof x3 &&
              null !== x3 &&
              (x3 === SuspenseException || "function" === typeof x3.then)
            )
              throw x3;
            task.replay.pendingTasks--;
            children = getThrownInfo(task.componentStack);
            var boundary = task.blockedBoundary,
              error = x3;
            children = logRecoverableError(request, error, children);
            abortRemainingReplayNodes(request, boundary, childIndex, node, error, children);
          }
          task.replay = replay;
          replayNodes.splice(j2, 1);
          break;
        }
      }
      task.keyPath = prevKeyPath;
      return;
    }
    replay = task.treeContext;
    replayNodes = children.length;
    if (null !== task.replay && ((j2 = task.replay.slots), null !== j2 && "object" === typeof j2)) {
      for (childIndex = 0; childIndex < replayNodes; childIndex++)
        ((node = children[childIndex]),
          (task.treeContext = pushTreeContext(replay, replayNodes, childIndex)),
          (boundary = j2[childIndex]),
          "number" === typeof boundary
            ? (resumeNode(request, task, boundary, node, childIndex), delete j2[childIndex])
            : renderNode(request, task, node, childIndex));
      task.treeContext = replay;
      task.keyPath = prevKeyPath;
      return;
    }
    for (j2 = 0; j2 < replayNodes; j2++)
      ((childIndex = children[j2]),
        (task.treeContext = pushTreeContext(replay, replayNodes, j2)),
        renderNode(request, task, childIndex, j2));
    task.treeContext = replay;
    task.keyPath = prevKeyPath;
  }
  function trackPostponedBoundary(request, trackedPostpones, boundary) {
    boundary.status = 5;
    boundary.rootSegmentID = request.nextSegmentId++;
    request = boundary.trackedContentKeyPath;
    if (null === request)
      throw Error("It should not be possible to postpone at the root. This is a bug in React.");
    var fallbackReplayNode = boundary.trackedFallbackNode,
      children = [],
      boundaryNode = trackedPostpones.workingMap.get(request);
    if (void 0 === boundaryNode)
      return (
        (boundary = [
          request[1],
          request[2],
          children,
          null,
          fallbackReplayNode,
          boundary.rootSegmentID,
        ]),
        trackedPostpones.workingMap.set(request, boundary),
        addToReplayParent(boundary, request[0], trackedPostpones),
        boundary
      );
    boundaryNode[4] = fallbackReplayNode;
    boundaryNode[5] = boundary.rootSegmentID;
    return boundaryNode;
  }
  function trackPostpone(request, trackedPostpones, task, segment) {
    segment.status = 5;
    var keyPath = task.keyPath,
      boundary = task.blockedBoundary;
    if (null === boundary)
      ((segment.id = request.nextSegmentId++),
        (trackedPostpones.rootSlots = segment.id),
        null !== request.completedRootSegment && (request.completedRootSegment.status = 5));
    else {
      if (null !== boundary && 0 === boundary.status) {
        var boundaryNode = trackPostponedBoundary(request, trackedPostpones, boundary);
        if (boundary.trackedContentKeyPath === keyPath && -1 === task.childIndex) {
          -1 === segment.id &&
            (segment.id = segment.parentFlushed ? boundary.rootSegmentID : request.nextSegmentId++);
          boundaryNode[3] = segment.id;
          return;
        }
      }
      -1 === segment.id &&
        (segment.id =
          segment.parentFlushed && null !== boundary
            ? boundary.rootSegmentID
            : request.nextSegmentId++);
      if (-1 === task.childIndex)
        null === keyPath
          ? (trackedPostpones.rootSlots = segment.id)
          : ((task = trackedPostpones.workingMap.get(keyPath)),
            void 0 === task
              ? ((task = [keyPath[1], keyPath[2], [], segment.id]),
                addToReplayParent(task, keyPath[0], trackedPostpones))
              : (task[3] = segment.id));
      else {
        if (null === keyPath)
          if (((request = trackedPostpones.rootSlots), null === request))
            request = trackedPostpones.rootSlots = {};
          else {
            if ("number" === typeof request)
              throw Error(
                "It should not be possible to postpone both at the root of an element as well as a slot below. This is a bug in React.",
              );
          }
        else if (
          ((boundary = trackedPostpones.workingMap),
          (boundaryNode = boundary.get(keyPath)),
          void 0 === boundaryNode)
        )
          ((request = {}),
            (boundaryNode = [keyPath[1], keyPath[2], [], request]),
            boundary.set(keyPath, boundaryNode),
            addToReplayParent(boundaryNode, keyPath[0], trackedPostpones));
        else if (((request = boundaryNode[3]), null === request)) request = boundaryNode[3] = {};
        else if ("number" === typeof request)
          throw Error(
            "It should not be possible to postpone both at the root of an element as well as a slot below. This is a bug in React.",
          );
        request[task.childIndex] = segment.id;
      }
    }
  }
  function untrackBoundary(request, boundary) {
    request = request.trackedPostpones;
    null !== request &&
      ((boundary = boundary.trackedContentKeyPath),
      null !== boundary &&
        ((boundary = request.workingMap.get(boundary)),
        void 0 !== boundary && ((boundary.length = 4), (boundary[2] = []), (boundary[3] = null))));
  }
  function spawnNewSuspendedReplayTask(request, task, thenableState2) {
    return createReplayTask(
      request,
      thenableState2,
      task.replay,
      task.node,
      task.childIndex,
      task.blockedBoundary,
      task.hoistableState,
      task.abortSet,
      task.keyPath,
      task.formatContext,
      task.context,
      task.treeContext,
      task.row,
      task.componentStack,
    );
  }
  function spawnNewSuspendedRenderTask(request, task, thenableState2) {
    var segment = task.blockedSegment,
      newSegment = createPendingSegment(
        request,
        segment.chunks.length,
        null,
        task.formatContext,
        segment.lastPushedText,
        true,
      );
    segment.children.push(newSegment);
    segment.lastPushedText = false;
    return createRenderTask(
      request,
      thenableState2,
      task.node,
      task.childIndex,
      task.blockedBoundary,
      newSegment,
      task.blockedPreamble,
      task.hoistableState,
      task.abortSet,
      task.keyPath,
      task.formatContext,
      task.context,
      task.treeContext,
      task.row,
      task.componentStack,
    );
  }
  function renderNode(request, task, node, childIndex) {
    var previousFormatContext = task.formatContext,
      previousContext = task.context,
      previousKeyPath = task.keyPath,
      previousTreeContext = task.treeContext,
      previousComponentStack = task.componentStack,
      segment = task.blockedSegment;
    if (null === segment) {
      segment = task.replay;
      try {
        return renderNodeDestructive(request, task, node, childIndex);
      } catch (thrownValue) {
        if (
          (resetHooksState(),
          (node = thrownValue === SuspenseException ? getSuspendedThenable() : thrownValue),
          12 !== request.status && "object" === typeof node && null !== node)
        ) {
          if ("function" === typeof node.then) {
            childIndex =
              thrownValue === SuspenseException ? getThenableStateAfterSuspending() : null;
            request = spawnNewSuspendedReplayTask(request, task, childIndex).ping;
            node.then(request, request);
            task.formatContext = previousFormatContext;
            task.context = previousContext;
            task.keyPath = previousKeyPath;
            task.treeContext = previousTreeContext;
            task.componentStack = previousComponentStack;
            task.replay = segment;
            switchContext(previousContext);
            return;
          }
          if ("Maximum call stack size exceeded" === node.message) {
            node = thrownValue === SuspenseException ? getThenableStateAfterSuspending() : null;
            node = spawnNewSuspendedReplayTask(request, task, node);
            request.pingedTasks.push(node);
            task.formatContext = previousFormatContext;
            task.context = previousContext;
            task.keyPath = previousKeyPath;
            task.treeContext = previousTreeContext;
            task.componentStack = previousComponentStack;
            task.replay = segment;
            switchContext(previousContext);
            return;
          }
        }
      }
    } else {
      var childrenLength = segment.children.length,
        chunkLength = segment.chunks.length;
      try {
        return renderNodeDestructive(request, task, node, childIndex);
      } catch (thrownValue$63) {
        if (
          (resetHooksState(),
          (segment.children.length = childrenLength),
          (segment.chunks.length = chunkLength),
          (node = thrownValue$63 === SuspenseException ? getSuspendedThenable() : thrownValue$63),
          12 !== request.status && "object" === typeof node && null !== node)
        ) {
          if ("function" === typeof node.then) {
            segment = node;
            node = thrownValue$63 === SuspenseException ? getThenableStateAfterSuspending() : null;
            request = spawnNewSuspendedRenderTask(request, task, node).ping;
            segment.then(request, request);
            task.formatContext = previousFormatContext;
            task.context = previousContext;
            task.keyPath = previousKeyPath;
            task.treeContext = previousTreeContext;
            task.componentStack = previousComponentStack;
            switchContext(previousContext);
            return;
          }
          if ("Maximum call stack size exceeded" === node.message) {
            segment =
              thrownValue$63 === SuspenseException ? getThenableStateAfterSuspending() : null;
            segment = spawnNewSuspendedRenderTask(request, task, segment);
            request.pingedTasks.push(segment);
            task.formatContext = previousFormatContext;
            task.context = previousContext;
            task.keyPath = previousKeyPath;
            task.treeContext = previousTreeContext;
            task.componentStack = previousComponentStack;
            switchContext(previousContext);
            return;
          }
        }
      }
    }
    task.formatContext = previousFormatContext;
    task.context = previousContext;
    task.keyPath = previousKeyPath;
    task.treeContext = previousTreeContext;
    switchContext(previousContext);
    throw node;
  }
  function abortTaskSoft(task) {
    var boundary = task.blockedBoundary,
      segment = task.blockedSegment;
    null !== segment && ((segment.status = 3), finishedTask(this, boundary, task.row, segment));
  }
  function abortRemainingReplayNodes(
    request$jscomp$0,
    boundary,
    nodes,
    slots,
    error,
    errorDigest$jscomp$0,
  ) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (4 === node.length)
        abortRemainingReplayNodes(
          request$jscomp$0,
          boundary,
          node[2],
          node[3],
          error,
          errorDigest$jscomp$0,
        );
      else {
        node = node[5];
        var request = request$jscomp$0,
          errorDigest = errorDigest$jscomp$0,
          resumedBoundary = createSuspenseBoundary(
            request,
            null,
            /* @__PURE__ */ new Set(),
            null,
            null,
          );
        resumedBoundary.parentFlushed = true;
        resumedBoundary.rootSegmentID = node;
        resumedBoundary.status = 4;
        resumedBoundary.errorDigest = errorDigest;
        resumedBoundary.parentFlushed && request.clientRenderedBoundaries.push(resumedBoundary);
      }
    }
    nodes.length = 0;
    if (null !== slots) {
      if (null === boundary)
        throw Error("We should not have any resumable nodes in the shell. This is a bug in React.");
      4 !== boundary.status &&
        ((boundary.status = 4),
        (boundary.errorDigest = errorDigest$jscomp$0),
        boundary.parentFlushed && request$jscomp$0.clientRenderedBoundaries.push(boundary));
      if ("object" === typeof slots) for (var index in slots) delete slots[index];
    }
  }
  function abortTask(task, request, error) {
    var boundary = task.blockedBoundary,
      segment = task.blockedSegment;
    if (null !== segment) {
      if (6 === segment.status) return;
      segment.status = 3;
    }
    var errorInfo = getThrownInfo(task.componentStack);
    if (null === boundary) {
      if (13 !== request.status && 14 !== request.status) {
        boundary = task.replay;
        if (null === boundary) {
          null !== request.trackedPostpones && null !== segment
            ? ((boundary = request.trackedPostpones),
              logRecoverableError(request, error, errorInfo),
              trackPostpone(request, boundary, task, segment),
              finishedTask(request, null, task.row, segment))
            : (logRecoverableError(request, error, errorInfo), fatalError(request, error));
          return;
        }
        boundary.pendingTasks--;
        0 === boundary.pendingTasks &&
          0 < boundary.nodes.length &&
          ((segment = logRecoverableError(request, error, errorInfo)),
          abortRemainingReplayNodes(request, null, boundary.nodes, boundary.slots, error, segment));
        request.pendingRootTasks--;
        0 === request.pendingRootTasks && completeShell(request);
      }
    } else {
      var trackedPostpones$64 = request.trackedPostpones;
      if (4 !== boundary.status) {
        if (null !== trackedPostpones$64 && null !== segment)
          return (
            logRecoverableError(request, error, errorInfo),
            trackPostpone(request, trackedPostpones$64, task, segment),
            boundary.fallbackAbortableTasks.forEach(function (fallbackTask) {
              return abortTask(fallbackTask, request, error);
            }),
            boundary.fallbackAbortableTasks.clear(),
            finishedTask(request, boundary, task.row, segment)
          );
        boundary.status = 4;
        segment = logRecoverableError(request, error, errorInfo);
        boundary.status = 4;
        boundary.errorDigest = segment;
        untrackBoundary(request, boundary);
        boundary.parentFlushed && request.clientRenderedBoundaries.push(boundary);
      }
      boundary.pendingTasks--;
      segment = boundary.row;
      null !== segment && 0 === --segment.pendingTasks && finishSuspenseListRow(request, segment);
      boundary.fallbackAbortableTasks.forEach(function (fallbackTask) {
        return abortTask(fallbackTask, request, error);
      });
      boundary.fallbackAbortableTasks.clear();
    }
    task = task.row;
    null !== task && 0 === --task.pendingTasks && finishSuspenseListRow(request, task);
    request.allPendingTasks--;
    0 === request.allPendingTasks && completeAll(request);
  }
  function safelyEmitEarlyPreloads(request, shellComplete) {
    try {
      var renderState = request.renderState,
        onHeaders = renderState.onHeaders;
      if (onHeaders) {
        var headers = renderState.headers;
        if (headers) {
          renderState.headers = null;
          var linkHeader = headers.preconnects;
          headers.fontPreloads &&
            (linkHeader && (linkHeader += ", "), (linkHeader += headers.fontPreloads));
          headers.highImagePreloads &&
            (linkHeader && (linkHeader += ", "), (linkHeader += headers.highImagePreloads));
          if (!shellComplete) {
            var queueIter = renderState.styles.values(),
              queueStep = queueIter.next();
            b: for (
              ;
              0 < headers.remainingCapacity && !queueStep.done;
              queueStep = queueIter.next()
            )
              for (
                var sheetIter = queueStep.value.sheets.values(), sheetStep = sheetIter.next();
                0 < headers.remainingCapacity && !sheetStep.done;
                sheetStep = sheetIter.next()
              ) {
                var sheet = sheetStep.value,
                  props = sheet.props,
                  key = props.href,
                  props$jscomp$0 = sheet.props,
                  header = getPreloadAsHeader(props$jscomp$0.href, "style", {
                    crossOrigin: props$jscomp$0.crossOrigin,
                    integrity: props$jscomp$0.integrity,
                    nonce: props$jscomp$0.nonce,
                    type: props$jscomp$0.type,
                    fetchPriority: props$jscomp$0.fetchPriority,
                    referrerPolicy: props$jscomp$0.referrerPolicy,
                    media: props$jscomp$0.media,
                  });
                if (0 <= (headers.remainingCapacity -= header.length + 2))
                  ((renderState.resets.style[key] = PRELOAD_NO_CREDS),
                    linkHeader && (linkHeader += ", "),
                    (linkHeader += header),
                    (renderState.resets.style[key] =
                      "string" === typeof props.crossOrigin || "string" === typeof props.integrity
                        ? [props.crossOrigin, props.integrity]
                        : PRELOAD_NO_CREDS));
                else break b;
              }
          }
          linkHeader ? onHeaders({ Link: linkHeader }) : onHeaders({});
        }
      }
    } catch (error) {
      logRecoverableError(request, error, {});
    }
  }
  function completeShell(request) {
    null === request.trackedPostpones && safelyEmitEarlyPreloads(request, true);
    null === request.trackedPostpones && preparePreamble(request);
    request.onShellError = noop;
    request = request.onShellReady;
    request();
  }
  function completeAll(request) {
    safelyEmitEarlyPreloads(
      request,
      null === request.trackedPostpones
        ? true
        : null === request.completedRootSegment || 5 !== request.completedRootSegment.status,
    );
    preparePreamble(request);
    request = request.onAllReady;
    request();
  }
  function queueCompletedSegment(boundary, segment) {
    if (
      0 === segment.chunks.length &&
      1 === segment.children.length &&
      null === segment.children[0].boundary &&
      -1 === segment.children[0].id
    ) {
      var childSegment = segment.children[0];
      childSegment.id = segment.id;
      childSegment.parentFlushed = true;
      (1 !== childSegment.status && 3 !== childSegment.status && 4 !== childSegment.status) ||
        queueCompletedSegment(boundary, childSegment);
    } else boundary.completedSegments.push(segment);
  }
  function finishedSegment(request, boundary, segment) {
    if (null !== byteLengthOfChunk) {
      segment = segment.chunks;
      for (var segmentByteSize = 0, i = 0; i < segment.length; i++)
        segmentByteSize += segment[i].byteLength;
      null === boundary
        ? (request.byteSize += segmentByteSize)
        : (boundary.byteSize += segmentByteSize);
    }
  }
  function finishedTask(request, boundary, row, segment) {
    null !== row &&
      (0 === --row.pendingTasks
        ? finishSuspenseListRow(request, row)
        : row.together && tryToResolveTogetherRow(request, row));
    request.allPendingTasks--;
    if (null === boundary) {
      if (null !== segment && segment.parentFlushed) {
        if (null !== request.completedRootSegment)
          throw Error("There can only be one root segment. This is a bug in React.");
        request.completedRootSegment = segment;
      }
      request.pendingRootTasks--;
      0 === request.pendingRootTasks && completeShell(request);
    } else if ((boundary.pendingTasks--, 4 !== boundary.status))
      if (0 === boundary.pendingTasks)
        if (
          (0 === boundary.status && (boundary.status = 1),
          null !== segment &&
            segment.parentFlushed &&
            (1 === segment.status || 3 === segment.status) &&
            queueCompletedSegment(boundary, segment),
          boundary.parentFlushed && request.completedBoundaries.push(boundary),
          1 === boundary.status)
        )
          ((row = boundary.row),
            null !== row && hoistHoistables(row.hoistables, boundary.contentState),
            isEligibleForOutlining(request, boundary) ||
              (boundary.fallbackAbortableTasks.forEach(abortTaskSoft, request),
              boundary.fallbackAbortableTasks.clear(),
              null !== row && 0 === --row.pendingTasks && finishSuspenseListRow(request, row)),
            0 === request.pendingRootTasks &&
              null === request.trackedPostpones &&
              null !== boundary.contentPreamble &&
              preparePreamble(request));
        else {
          if (5 === boundary.status && ((boundary = boundary.row), null !== boundary)) {
            if (null !== request.trackedPostpones) {
              row = request.trackedPostpones;
              var postponedRow = boundary.next;
              if (null !== postponedRow && ((segment = postponedRow.boundaries), null !== segment))
                for (
                  postponedRow.boundaries = null, postponedRow = 0;
                  postponedRow < segment.length;
                  postponedRow++
                ) {
                  var postponedBoundary = segment[postponedRow];
                  trackPostponedBoundary(request, row, postponedBoundary);
                  finishedTask(request, postponedBoundary, null, null);
                }
            }
            0 === --boundary.pendingTasks && finishSuspenseListRow(request, boundary);
          }
        }
      else
        (null === segment ||
          !segment.parentFlushed ||
          (1 !== segment.status && 3 !== segment.status) ||
          (queueCompletedSegment(boundary, segment),
          1 === boundary.completedSegments.length &&
            boundary.parentFlushed &&
            request.partialBoundaries.push(boundary)),
          (boundary = boundary.row),
          null !== boundary && boundary.together && tryToResolveTogetherRow(request, boundary));
    0 === request.allPendingTasks && completeAll(request);
  }
  function performWork(request$jscomp$2) {
    if (14 !== request$jscomp$2.status && 13 !== request$jscomp$2.status) {
      var prevContext = currentActiveSnapshot,
        prevDispatcher = ReactSharedInternals.H;
      ReactSharedInternals.H = HooksDispatcher;
      var prevAsyncDispatcher = ReactSharedInternals.A;
      ReactSharedInternals.A = DefaultAsyncDispatcher;
      var prevRequest = currentRequest;
      currentRequest = request$jscomp$2;
      var prevResumableState = currentResumableState;
      currentResumableState = request$jscomp$2.resumableState;
      try {
        var pingedTasks = request$jscomp$2.pingedTasks,
          i;
        for (i = 0; i < pingedTasks.length; i++) {
          var task = pingedTasks[i],
            request = request$jscomp$2,
            segment = task.blockedSegment;
          if (null === segment) {
            var request$jscomp$0 = request;
            if (0 !== task.replay.pendingTasks) {
              switchContext(task.context);
              try {
                "number" === typeof task.replay.slots
                  ? resumeNode(
                      request$jscomp$0,
                      task,
                      task.replay.slots,
                      task.node,
                      task.childIndex,
                    )
                  : retryNode(request$jscomp$0, task);
                if (1 === task.replay.pendingTasks && 0 < task.replay.nodes.length)
                  throw Error(
                    "Couldn't find all resumable slots by key/index during replaying. The tree doesn't match so React will fallback to client rendering.",
                  );
                task.replay.pendingTasks--;
                task.abortSet.delete(task);
                finishedTask(request$jscomp$0, task.blockedBoundary, task.row, null);
              } catch (thrownValue) {
                resetHooksState();
                var x3 = thrownValue === SuspenseException ? getSuspendedThenable() : thrownValue;
                if ("object" === typeof x3 && null !== x3 && "function" === typeof x3.then) {
                  var ping = task.ping;
                  x3.then(ping, ping);
                  task.thenableState =
                    thrownValue === SuspenseException ? getThenableStateAfterSuspending() : null;
                } else {
                  task.replay.pendingTasks--;
                  task.abortSet.delete(task);
                  var errorInfo = getThrownInfo(task.componentStack);
                  request = void 0;
                  var request$jscomp$1 = request$jscomp$0,
                    boundary = task.blockedBoundary,
                    error$jscomp$0 =
                      12 === request$jscomp$0.status ? request$jscomp$0.fatalError : x3,
                    replayNodes = task.replay.nodes,
                    resumeSlots = task.replay.slots;
                  request = logRecoverableError(request$jscomp$1, error$jscomp$0, errorInfo);
                  abortRemainingReplayNodes(
                    request$jscomp$1,
                    boundary,
                    replayNodes,
                    resumeSlots,
                    error$jscomp$0,
                    request,
                  );
                  request$jscomp$0.pendingRootTasks--;
                  0 === request$jscomp$0.pendingRootTasks && completeShell(request$jscomp$0);
                  request$jscomp$0.allPendingTasks--;
                  0 === request$jscomp$0.allPendingTasks && completeAll(request$jscomp$0);
                }
              } finally {
              }
            }
          } else if (
            ((request$jscomp$0 = void 0),
            (request$jscomp$1 = segment),
            0 === request$jscomp$1.status)
          ) {
            request$jscomp$1.status = 6;
            switchContext(task.context);
            var childrenLength = request$jscomp$1.children.length,
              chunkLength = request$jscomp$1.chunks.length;
            try {
              (retryNode(request, task),
                request$jscomp$1.lastPushedText &&
                  request$jscomp$1.textEmbedded &&
                  request$jscomp$1.chunks.push(textSeparator),
                task.abortSet.delete(task),
                (request$jscomp$1.status = 1),
                finishedSegment(request, task.blockedBoundary, request$jscomp$1),
                finishedTask(request, task.blockedBoundary, task.row, request$jscomp$1));
            } catch (thrownValue) {
              resetHooksState();
              request$jscomp$1.children.length = childrenLength;
              request$jscomp$1.chunks.length = chunkLength;
              var x$jscomp$0 =
                thrownValue === SuspenseException
                  ? getSuspendedThenable()
                  : 12 === request.status
                    ? request.fatalError
                    : thrownValue;
              if (12 === request.status && null !== request.trackedPostpones) {
                var trackedPostpones = request.trackedPostpones,
                  thrownInfo = getThrownInfo(task.componentStack);
                task.abortSet.delete(task);
                logRecoverableError(request, x$jscomp$0, thrownInfo);
                trackPostpone(request, trackedPostpones, task, request$jscomp$1);
                finishedTask(request, task.blockedBoundary, task.row, request$jscomp$1);
              } else if (
                "object" === typeof x$jscomp$0 &&
                null !== x$jscomp$0 &&
                "function" === typeof x$jscomp$0.then
              ) {
                request$jscomp$1.status = 0;
                task.thenableState =
                  thrownValue === SuspenseException ? getThenableStateAfterSuspending() : null;
                var ping$jscomp$0 = task.ping;
                x$jscomp$0.then(ping$jscomp$0, ping$jscomp$0);
              } else {
                var errorInfo$jscomp$0 = getThrownInfo(task.componentStack);
                task.abortSet.delete(task);
                request$jscomp$1.status = 4;
                var boundary$jscomp$0 = task.blockedBoundary,
                  row = task.row;
                null !== row && 0 === --row.pendingTasks && finishSuspenseListRow(request, row);
                request.allPendingTasks--;
                request$jscomp$0 = logRecoverableError(request, x$jscomp$0, errorInfo$jscomp$0);
                if (null === boundary$jscomp$0) fatalError(request, x$jscomp$0);
                else if ((boundary$jscomp$0.pendingTasks--, 4 !== boundary$jscomp$0.status)) {
                  boundary$jscomp$0.status = 4;
                  boundary$jscomp$0.errorDigest = request$jscomp$0;
                  untrackBoundary(request, boundary$jscomp$0);
                  var boundaryRow = boundary$jscomp$0.row;
                  null !== boundaryRow &&
                    0 === --boundaryRow.pendingTasks &&
                    finishSuspenseListRow(request, boundaryRow);
                  boundary$jscomp$0.parentFlushed &&
                    request.clientRenderedBoundaries.push(boundary$jscomp$0);
                  0 === request.pendingRootTasks &&
                    null === request.trackedPostpones &&
                    null !== boundary$jscomp$0.contentPreamble &&
                    preparePreamble(request);
                }
                0 === request.allPendingTasks && completeAll(request);
              }
            } finally {
            }
          }
        }
        pingedTasks.splice(0, i);
        null !== request$jscomp$2.destination &&
          flushCompletedQueues(request$jscomp$2, request$jscomp$2.destination);
      } catch (error) {
        (logRecoverableError(request$jscomp$2, error, {}), fatalError(request$jscomp$2, error));
      } finally {
        ((currentResumableState = prevResumableState),
          (ReactSharedInternals.H = prevDispatcher),
          (ReactSharedInternals.A = prevAsyncDispatcher),
          prevDispatcher === HooksDispatcher && switchContext(prevContext),
          (currentRequest = prevRequest));
      }
    }
  }
  function preparePreambleFromSubtree(request, segment, collectedPreambleSegments) {
    segment.preambleChildren.length && collectedPreambleSegments.push(segment.preambleChildren);
    for (var pendingPreambles = false, i = 0; i < segment.children.length; i++)
      pendingPreambles =
        preparePreambleFromSegment(request, segment.children[i], collectedPreambleSegments) ||
        pendingPreambles;
    return pendingPreambles;
  }
  function preparePreambleFromSegment(request, segment, collectedPreambleSegments) {
    var boundary = segment.boundary;
    if (null === boundary)
      return preparePreambleFromSubtree(request, segment, collectedPreambleSegments);
    var preamble = boundary.contentPreamble,
      fallbackPreamble = boundary.fallbackPreamble;
    if (null === preamble || null === fallbackPreamble) return false;
    switch (boundary.status) {
      case 1:
        hoistPreambleState(request.renderState, preamble);
        request.byteSize += boundary.byteSize;
        segment = boundary.completedSegments[0];
        if (!segment)
          throw Error(
            "A previously unvisited boundary must have exactly one root segment. This is a bug in React.",
          );
        return preparePreambleFromSubtree(request, segment, collectedPreambleSegments);
      case 5:
        if (null !== request.trackedPostpones) return true;
      case 4:
        if (1 === segment.status)
          return (
            hoistPreambleState(request.renderState, fallbackPreamble),
            preparePreambleFromSubtree(request, segment, collectedPreambleSegments)
          );
      default:
        return true;
    }
  }
  function preparePreamble(request) {
    if (request.completedRootSegment && null === request.completedPreambleSegments) {
      var collectedPreambleSegments = [],
        originalRequestByteSize = request.byteSize,
        hasPendingPreambles = preparePreambleFromSegment(
          request,
          request.completedRootSegment,
          collectedPreambleSegments,
        ),
        preamble = request.renderState.preamble;
      false === hasPendingPreambles || (preamble.headChunks && preamble.bodyChunks)
        ? (request.completedPreambleSegments = collectedPreambleSegments)
        : (request.byteSize = originalRequestByteSize);
    }
  }
  function flushSubtree(request, destination, segment, hoistableState) {
    segment.parentFlushed = true;
    switch (segment.status) {
      case 0:
        segment.id = request.nextSegmentId++;
      case 5:
        return (
          (hoistableState = segment.id),
          (segment.lastPushedText = false),
          (segment.textEmbedded = false),
          (request = request.renderState),
          writeChunk(destination, placeholder1),
          writeChunk(destination, request.placeholderPrefix),
          (request = stringToChunk(hoistableState.toString(16))),
          writeChunk(destination, request),
          writeChunkAndReturn(destination, placeholder2)
        );
      case 1:
        segment.status = 2;
        var r = true,
          chunks = segment.chunks,
          chunkIdx = 0;
        segment = segment.children;
        for (var childIdx = 0; childIdx < segment.length; childIdx++) {
          for (r = segment[childIdx]; chunkIdx < r.index; chunkIdx++)
            writeChunk(destination, chunks[chunkIdx]);
          r = flushSegment(request, destination, r, hoistableState);
        }
        for (; chunkIdx < chunks.length - 1; chunkIdx++) writeChunk(destination, chunks[chunkIdx]);
        chunkIdx < chunks.length && (r = writeChunkAndReturn(destination, chunks[chunkIdx]));
        return r;
      case 3:
        return true;
      default:
        throw Error(
          "Aborted, errored or already flushed boundaries should not be flushed again. This is a bug in React.",
        );
    }
  }
  var flushedByteSize = 0;
  function flushSegment(request, destination, segment, hoistableState) {
    var boundary = segment.boundary;
    if (null === boundary) return flushSubtree(request, destination, segment, hoistableState);
    boundary.parentFlushed = true;
    if (4 === boundary.status) {
      var row = boundary.row;
      null !== row && 0 === --row.pendingTasks && finishSuspenseListRow(request, row);
      boundary = boundary.errorDigest;
      writeChunkAndReturn(destination, startClientRenderedSuspenseBoundary);
      writeChunk(destination, clientRenderedSuspenseBoundaryError1);
      boundary &&
        (writeChunk(destination, clientRenderedSuspenseBoundaryError1A),
        writeChunk(destination, stringToChunk(escapeTextForBrowser(boundary))),
        writeChunk(destination, clientRenderedSuspenseBoundaryErrorAttrInterstitial));
      writeChunkAndReturn(destination, clientRenderedSuspenseBoundaryError2);
      flushSubtree(request, destination, segment, hoistableState);
    } else if (1 !== boundary.status)
      (0 === boundary.status && (boundary.rootSegmentID = request.nextSegmentId++),
        0 < boundary.completedSegments.length && request.partialBoundaries.push(boundary),
        writeStartPendingSuspenseBoundary(destination, request.renderState, boundary.rootSegmentID),
        hoistableState && hoistHoistables(hoistableState, boundary.fallbackState),
        flushSubtree(request, destination, segment, hoistableState));
    else if (
      !flushingPartialBoundaries &&
      isEligibleForOutlining(request, boundary) &&
      (flushedByteSize + boundary.byteSize > request.progressiveChunkSize ||
        hasSuspenseyContent(boundary.contentState))
    )
      ((boundary.rootSegmentID = request.nextSegmentId++),
        request.completedBoundaries.push(boundary),
        writeStartPendingSuspenseBoundary(destination, request.renderState, boundary.rootSegmentID),
        flushSubtree(request, destination, segment, hoistableState));
    else {
      flushedByteSize += boundary.byteSize;
      hoistableState && hoistHoistables(hoistableState, boundary.contentState);
      segment = boundary.row;
      null !== segment &&
        isEligibleForOutlining(request, boundary) &&
        0 === --segment.pendingTasks &&
        finishSuspenseListRow(request, segment);
      writeChunkAndReturn(destination, startCompletedSuspenseBoundary);
      segment = boundary.completedSegments;
      if (1 !== segment.length)
        throw Error(
          "A previously unvisited boundary must have exactly one root segment. This is a bug in React.",
        );
      flushSegment(request, destination, segment[0], hoistableState);
    }
    return writeChunkAndReturn(destination, endSuspenseBoundary);
  }
  function flushSegmentContainer(request, destination, segment, hoistableState) {
    writeStartSegment(destination, request.renderState, segment.parentFormatContext, segment.id);
    flushSegment(request, destination, segment, hoistableState);
    return writeEndSegment(destination, segment.parentFormatContext);
  }
  function flushCompletedBoundary(request, destination, boundary) {
    flushedByteSize = boundary.byteSize;
    for (
      var completedSegments = boundary.completedSegments, i = 0;
      i < completedSegments.length;
      i++
    )
      flushPartiallyCompletedSegment(request, destination, boundary, completedSegments[i]);
    completedSegments.length = 0;
    completedSegments = boundary.row;
    null !== completedSegments &&
      isEligibleForOutlining(request, boundary) &&
      0 === --completedSegments.pendingTasks &&
      finishSuspenseListRow(request, completedSegments);
    writeHoistablesForBoundary(destination, boundary.contentState, request.renderState);
    completedSegments = request.resumableState;
    request = request.renderState;
    i = boundary.rootSegmentID;
    boundary = boundary.contentState;
    var requiresStyleInsertion = request.stylesToHoist;
    request.stylesToHoist = false;
    writeChunk(destination, request.startInlineScript);
    writeChunk(destination, endOfStartTag);
    requiresStyleInsertion
      ? (0 === (completedSegments.instructions & 4) &&
          ((completedSegments.instructions |= 4),
          writeChunk(destination, clientRenderScriptFunctionOnly)),
        0 === (completedSegments.instructions & 2) &&
          ((completedSegments.instructions |= 2),
          writeChunk(destination, completeBoundaryScriptFunctionOnly)),
        0 === (completedSegments.instructions & 8)
          ? ((completedSegments.instructions |= 8),
            writeChunk(destination, completeBoundaryWithStylesScript1FullPartial))
          : writeChunk(destination, completeBoundaryWithStylesScript1Partial))
      : (0 === (completedSegments.instructions & 2) &&
          ((completedSegments.instructions |= 2),
          writeChunk(destination, completeBoundaryScriptFunctionOnly)),
        writeChunk(destination, completeBoundaryScript1Partial));
    completedSegments = stringToChunk(i.toString(16));
    writeChunk(destination, request.boundaryPrefix);
    writeChunk(destination, completedSegments);
    writeChunk(destination, completeBoundaryScript2);
    writeChunk(destination, request.segmentPrefix);
    writeChunk(destination, completedSegments);
    requiresStyleInsertion
      ? (writeChunk(destination, completeBoundaryScript3a),
        writeStyleResourceDependenciesInJS(destination, boundary))
      : writeChunk(destination, completeBoundaryScript3b);
    boundary = writeChunkAndReturn(destination, completeBoundaryScriptEnd);
    return writeBootstrap(destination, request) && boundary;
  }
  function flushPartiallyCompletedSegment(request, destination, boundary, segment) {
    if (2 === segment.status) return true;
    var hoistableState = boundary.contentState,
      segmentID = segment.id;
    if (-1 === segmentID) {
      if (-1 === (segment.id = boundary.rootSegmentID))
        throw Error("A root segment ID must have been assigned by now. This is a bug in React.");
      return flushSegmentContainer(request, destination, segment, hoistableState);
    }
    if (segmentID === boundary.rootSegmentID)
      return flushSegmentContainer(request, destination, segment, hoistableState);
    flushSegmentContainer(request, destination, segment, hoistableState);
    boundary = request.resumableState;
    request = request.renderState;
    writeChunk(destination, request.startInlineScript);
    writeChunk(destination, endOfStartTag);
    0 === (boundary.instructions & 1)
      ? ((boundary.instructions |= 1), writeChunk(destination, completeSegmentScript1Full))
      : writeChunk(destination, completeSegmentScript1Partial);
    writeChunk(destination, request.segmentPrefix);
    segmentID = stringToChunk(segmentID.toString(16));
    writeChunk(destination, segmentID);
    writeChunk(destination, completeSegmentScript2);
    writeChunk(destination, request.placeholderPrefix);
    writeChunk(destination, segmentID);
    destination = writeChunkAndReturn(destination, completeSegmentScriptEnd);
    return destination;
  }
  var flushingPartialBoundaries = false;
  function flushCompletedQueues(request, destination) {
    currentView = new Uint8Array(2048);
    writtenBytes = 0;
    try {
      if (!(0 < request.pendingRootTasks)) {
        var i,
          completedRootSegment = request.completedRootSegment;
        if (null !== completedRootSegment) {
          if (5 === completedRootSegment.status) return;
          var completedPreambleSegments = request.completedPreambleSegments;
          if (null === completedPreambleSegments) return;
          flushedByteSize = request.byteSize;
          var resumableState = request.resumableState,
            renderState = request.renderState,
            preamble = renderState.preamble,
            htmlChunks = preamble.htmlChunks,
            headChunks = preamble.headChunks,
            i$jscomp$0;
          if (htmlChunks) {
            for (i$jscomp$0 = 0; i$jscomp$0 < htmlChunks.length; i$jscomp$0++)
              writeChunk(destination, htmlChunks[i$jscomp$0]);
            if (headChunks)
              for (i$jscomp$0 = 0; i$jscomp$0 < headChunks.length; i$jscomp$0++)
                writeChunk(destination, headChunks[i$jscomp$0]);
            else
              (writeChunk(destination, startChunkForTag("head")),
                writeChunk(destination, endOfStartTag));
          } else if (headChunks)
            for (i$jscomp$0 = 0; i$jscomp$0 < headChunks.length; i$jscomp$0++)
              writeChunk(destination, headChunks[i$jscomp$0]);
          var charsetChunks = renderState.charsetChunks;
          for (i$jscomp$0 = 0; i$jscomp$0 < charsetChunks.length; i$jscomp$0++)
            writeChunk(destination, charsetChunks[i$jscomp$0]);
          charsetChunks.length = 0;
          renderState.preconnects.forEach(flushResource, destination);
          renderState.preconnects.clear();
          var viewportChunks = renderState.viewportChunks;
          for (i$jscomp$0 = 0; i$jscomp$0 < viewportChunks.length; i$jscomp$0++)
            writeChunk(destination, viewportChunks[i$jscomp$0]);
          viewportChunks.length = 0;
          renderState.fontPreloads.forEach(flushResource, destination);
          renderState.fontPreloads.clear();
          renderState.highImagePreloads.forEach(flushResource, destination);
          renderState.highImagePreloads.clear();
          currentlyFlushingRenderState = renderState;
          renderState.styles.forEach(flushStylesInPreamble, destination);
          currentlyFlushingRenderState = null;
          var importMapChunks = renderState.importMapChunks;
          for (i$jscomp$0 = 0; i$jscomp$0 < importMapChunks.length; i$jscomp$0++)
            writeChunk(destination, importMapChunks[i$jscomp$0]);
          importMapChunks.length = 0;
          renderState.bootstrapScripts.forEach(flushResource, destination);
          renderState.scripts.forEach(flushResource, destination);
          renderState.scripts.clear();
          renderState.bulkPreloads.forEach(flushResource, destination);
          renderState.bulkPreloads.clear();
          htmlChunks || headChunks || (resumableState.instructions |= 32);
          var hoistableChunks = renderState.hoistableChunks;
          for (i$jscomp$0 = 0; i$jscomp$0 < hoistableChunks.length; i$jscomp$0++)
            writeChunk(destination, hoistableChunks[i$jscomp$0]);
          for (
            resumableState = hoistableChunks.length = 0;
            resumableState < completedPreambleSegments.length;
            resumableState++
          ) {
            var segments = completedPreambleSegments[resumableState];
            for (renderState = 0; renderState < segments.length; renderState++)
              flushSegment(request, destination, segments[renderState], null);
          }
          var preamble$jscomp$0 = request.renderState.preamble,
            headChunks$jscomp$0 = preamble$jscomp$0.headChunks;
          (preamble$jscomp$0.htmlChunks || headChunks$jscomp$0) &&
            writeChunk(destination, endChunkForTag("head"));
          var bodyChunks = preamble$jscomp$0.bodyChunks;
          if (bodyChunks)
            for (
              completedPreambleSegments = 0;
              completedPreambleSegments < bodyChunks.length;
              completedPreambleSegments++
            )
              writeChunk(destination, bodyChunks[completedPreambleSegments]);
          flushSegment(request, destination, completedRootSegment, null);
          request.completedRootSegment = null;
          var renderState$jscomp$0 = request.renderState;
          if (
            0 !== request.allPendingTasks ||
            0 !== request.clientRenderedBoundaries.length ||
            0 !== request.completedBoundaries.length ||
            (null !== request.trackedPostpones &&
              (0 !== request.trackedPostpones.rootNodes.length ||
                null !== request.trackedPostpones.rootSlots))
          ) {
            var resumableState$jscomp$0 = request.resumableState;
            if (0 === (resumableState$jscomp$0.instructions & 64)) {
              resumableState$jscomp$0.instructions |= 64;
              writeChunk(destination, renderState$jscomp$0.startInlineScript);
              if (0 === (resumableState$jscomp$0.instructions & 32)) {
                resumableState$jscomp$0.instructions |= 32;
                var shellId = "_" + resumableState$jscomp$0.idPrefix + "R_";
                writeChunk(destination, completedShellIdAttributeStart);
                writeChunk(destination, stringToChunk(escapeTextForBrowser(shellId)));
                writeChunk(destination, attributeEnd);
              }
              writeChunk(destination, endOfStartTag);
              writeChunk(destination, shellTimeRuntimeScript);
              writeChunkAndReturn(destination, endInlineScript);
            }
          }
          writeBootstrap(destination, renderState$jscomp$0);
        }
        var renderState$jscomp$1 = request.renderState;
        completedRootSegment = 0;
        var viewportChunks$jscomp$0 = renderState$jscomp$1.viewportChunks;
        for (
          completedRootSegment = 0;
          completedRootSegment < viewportChunks$jscomp$0.length;
          completedRootSegment++
        )
          writeChunk(destination, viewportChunks$jscomp$0[completedRootSegment]);
        viewportChunks$jscomp$0.length = 0;
        renderState$jscomp$1.preconnects.forEach(flushResource, destination);
        renderState$jscomp$1.preconnects.clear();
        renderState$jscomp$1.fontPreloads.forEach(flushResource, destination);
        renderState$jscomp$1.fontPreloads.clear();
        renderState$jscomp$1.highImagePreloads.forEach(flushResource, destination);
        renderState$jscomp$1.highImagePreloads.clear();
        renderState$jscomp$1.styles.forEach(preloadLateStyles, destination);
        renderState$jscomp$1.scripts.forEach(flushResource, destination);
        renderState$jscomp$1.scripts.clear();
        renderState$jscomp$1.bulkPreloads.forEach(flushResource, destination);
        renderState$jscomp$1.bulkPreloads.clear();
        var hoistableChunks$jscomp$0 = renderState$jscomp$1.hoistableChunks;
        for (
          completedRootSegment = 0;
          completedRootSegment < hoistableChunks$jscomp$0.length;
          completedRootSegment++
        )
          writeChunk(destination, hoistableChunks$jscomp$0[completedRootSegment]);
        hoistableChunks$jscomp$0.length = 0;
        var clientRenderedBoundaries = request.clientRenderedBoundaries;
        for (i = 0; i < clientRenderedBoundaries.length; i++) {
          var boundary = clientRenderedBoundaries[i];
          renderState$jscomp$1 = destination;
          var resumableState$jscomp$1 = request.resumableState,
            renderState$jscomp$2 = request.renderState,
            id = boundary.rootSegmentID,
            errorDigest = boundary.errorDigest;
          writeChunk(renderState$jscomp$1, renderState$jscomp$2.startInlineScript);
          writeChunk(renderState$jscomp$1, endOfStartTag);
          0 === (resumableState$jscomp$1.instructions & 4)
            ? ((resumableState$jscomp$1.instructions |= 4),
              writeChunk(renderState$jscomp$1, clientRenderScript1Full))
            : writeChunk(renderState$jscomp$1, clientRenderScript1Partial);
          writeChunk(renderState$jscomp$1, renderState$jscomp$2.boundaryPrefix);
          writeChunk(renderState$jscomp$1, stringToChunk(id.toString(16)));
          writeChunk(renderState$jscomp$1, clientRenderScript1A);
          errorDigest &&
            (writeChunk(renderState$jscomp$1, clientRenderErrorScriptArgInterstitial),
            writeChunk(
              renderState$jscomp$1,
              stringToChunk(escapeJSStringsForInstructionScripts(errorDigest || "")),
            ));
          var JSCompiler_inline_result = writeChunkAndReturn(
            renderState$jscomp$1,
            clientRenderScriptEnd,
          );
          if (!JSCompiler_inline_result) {
            request.destination = null;
            i++;
            clientRenderedBoundaries.splice(0, i);
            return;
          }
        }
        clientRenderedBoundaries.splice(0, i);
        var completedBoundaries = request.completedBoundaries;
        for (i = 0; i < completedBoundaries.length; i++)
          if (!flushCompletedBoundary(request, destination, completedBoundaries[i])) {
            request.destination = null;
            i++;
            completedBoundaries.splice(0, i);
            return;
          }
        completedBoundaries.splice(0, i);
        completeWriting(destination);
        currentView = new Uint8Array(2048);
        writtenBytes = 0;
        flushingPartialBoundaries = true;
        var partialBoundaries = request.partialBoundaries;
        for (i = 0; i < partialBoundaries.length; i++) {
          var boundary$70 = partialBoundaries[i];
          a: {
            clientRenderedBoundaries = request;
            boundary = destination;
            flushedByteSize = boundary$70.byteSize;
            var completedSegments = boundary$70.completedSegments;
            for (
              JSCompiler_inline_result = 0;
              JSCompiler_inline_result < completedSegments.length;
              JSCompiler_inline_result++
            )
              if (
                !flushPartiallyCompletedSegment(
                  clientRenderedBoundaries,
                  boundary,
                  boundary$70,
                  completedSegments[JSCompiler_inline_result],
                )
              ) {
                JSCompiler_inline_result++;
                completedSegments.splice(0, JSCompiler_inline_result);
                var JSCompiler_inline_result$jscomp$0 = false;
                break a;
              }
            completedSegments.splice(0, JSCompiler_inline_result);
            var row = boundary$70.row;
            null !== row &&
              row.together &&
              1 === boundary$70.pendingTasks &&
              (1 === row.pendingTasks
                ? unblockSuspenseListRow(clientRenderedBoundaries, row, row.hoistables)
                : row.pendingTasks--);
            JSCompiler_inline_result$jscomp$0 = writeHoistablesForBoundary(
              boundary,
              boundary$70.contentState,
              clientRenderedBoundaries.renderState,
            );
          }
          if (!JSCompiler_inline_result$jscomp$0) {
            request.destination = null;
            i++;
            partialBoundaries.splice(0, i);
            return;
          }
        }
        partialBoundaries.splice(0, i);
        flushingPartialBoundaries = false;
        var largeBoundaries = request.completedBoundaries;
        for (i = 0; i < largeBoundaries.length; i++)
          if (!flushCompletedBoundary(request, destination, largeBoundaries[i])) {
            request.destination = null;
            i++;
            largeBoundaries.splice(0, i);
            return;
          }
        largeBoundaries.splice(0, i);
      }
    } finally {
      ((flushingPartialBoundaries = false),
        0 === request.allPendingTasks &&
        0 === request.clientRenderedBoundaries.length &&
        0 === request.completedBoundaries.length
          ? ((request.flushScheduled = false),
            (i = request.resumableState),
            i.hasBody && writeChunk(destination, endChunkForTag("body")),
            i.hasHtml && writeChunk(destination, endChunkForTag("html")),
            completeWriting(destination),
            (request.status = 14),
            destination.close(),
            (request.destination = null))
          : completeWriting(destination));
    }
  }
  function startWork(request) {
    request.flushScheduled = null !== request.destination;
    supportsRequestStorage
      ? scheduleMicrotask(function () {
          return requestStorage.run(request, performWork, request);
        })
      : scheduleMicrotask(function () {
          return performWork(request);
        });
    setTimeout(function () {
      10 === request.status && (request.status = 11);
      null === request.trackedPostpones &&
        (supportsRequestStorage
          ? requestStorage.run(request, enqueueEarlyPreloadsAfterInitialWork, request)
          : enqueueEarlyPreloadsAfterInitialWork(request));
    }, 0);
  }
  function enqueueEarlyPreloadsAfterInitialWork(request) {
    safelyEmitEarlyPreloads(request, 0 === request.pendingRootTasks);
  }
  function enqueueFlush(request) {
    false === request.flushScheduled &&
      0 === request.pingedTasks.length &&
      null !== request.destination &&
      ((request.flushScheduled = true),
      setTimeout(function () {
        var destination = request.destination;
        destination ? flushCompletedQueues(request, destination) : (request.flushScheduled = false);
      }, 0));
  }
  function startFlowing(request, destination) {
    if (13 === request.status)
      ((request.status = 14), closeWithError(destination, request.fatalError));
    else if (14 !== request.status && null === request.destination) {
      request.destination = destination;
      try {
        flushCompletedQueues(request, destination);
      } catch (error) {
        (logRecoverableError(request, error, {}), fatalError(request, error));
      }
    }
  }
  function abort(request, reason) {
    if (11 === request.status || 10 === request.status) request.status = 12;
    try {
      var abortableTasks = request.abortableTasks;
      if (0 < abortableTasks.size) {
        var error =
          void 0 === reason
            ? Error("The render was aborted by the server without a reason.")
            : "object" === typeof reason && null !== reason && "function" === typeof reason.then
              ? Error("The render was aborted by the server with a promise.")
              : reason;
        request.fatalError = error;
        abortableTasks.forEach(function (task) {
          return abortTask(task, request, error);
        });
        abortableTasks.clear();
      }
      null !== request.destination && flushCompletedQueues(request, request.destination);
    } catch (error$72) {
      (logRecoverableError(request, error$72, {}), fatalError(request, error$72));
    }
  }
  function addToReplayParent(node, parentKeyPath, trackedPostpones) {
    if (null === parentKeyPath) trackedPostpones.rootNodes.push(node);
    else {
      var workingMap = trackedPostpones.workingMap,
        parentNode = workingMap.get(parentKeyPath);
      void 0 === parentNode &&
        ((parentNode = [parentKeyPath[1], parentKeyPath[2], [], null]),
        workingMap.set(parentKeyPath, parentNode),
        addToReplayParent(parentNode, parentKeyPath[0], trackedPostpones));
      parentNode[2].push(node);
    }
  }
  function getPostponedState(request) {
    var trackedPostpones = request.trackedPostpones;
    if (
      null === trackedPostpones ||
      (0 === trackedPostpones.rootNodes.length && null === trackedPostpones.rootSlots)
    )
      return (request.trackedPostpones = null);
    if (
      null === request.completedRootSegment ||
      (5 !== request.completedRootSegment.status && null !== request.completedPreambleSegments)
    ) {
      var nextSegmentId = request.nextSegmentId;
      var replaySlots = trackedPostpones.rootSlots;
      var resumableState = request.resumableState;
      resumableState.bootstrapScriptContent = void 0;
      resumableState.bootstrapScripts = void 0;
      resumableState.bootstrapModules = void 0;
    } else {
      nextSegmentId = 0;
      replaySlots = -1;
      resumableState = request.resumableState;
      var renderState = request.renderState;
      resumableState.nextFormID = 0;
      resumableState.hasBody = false;
      resumableState.hasHtml = false;
      resumableState.unknownResources = { font: renderState.resets.font };
      resumableState.dnsResources = renderState.resets.dns;
      resumableState.connectResources = renderState.resets.connect;
      resumableState.imageResources = renderState.resets.image;
      resumableState.styleResources = renderState.resets.style;
      resumableState.scriptResources = {};
      resumableState.moduleUnknownResources = {};
      resumableState.moduleScriptResources = {};
      resumableState.instructions = 0;
    }
    return {
      nextSegmentId,
      rootFormatContext: request.rootFormatContext,
      progressiveChunkSize: request.progressiveChunkSize,
      resumableState: request.resumableState,
      replayNodes: trackedPostpones.rootNodes,
      replaySlots,
    };
  }
  function ensureCorrectIsomorphicReactVersion() {
    var isomorphicReactPackageVersion = React2.version;
    if ("19.2.5" !== isomorphicReactPackageVersion)
      throw Error(
        'Incompatible React versions: The "react" and "react-dom" packages must have the exact same version. Instead got:\n  - react:      ' +
          (isomorphicReactPackageVersion +
            "\n  - react-dom:  19.2.5\nLearn more: https://react.dev/warnings/version-mismatch"),
      );
  }
  ensureCorrectIsomorphicReactVersion();
  ensureCorrectIsomorphicReactVersion();
  reactDomServer_edge_production.prerender = function (children, options) {
    return new Promise(function (resolve, reject) {
      var onHeaders = options ? options.onHeaders : void 0,
        onHeadersImpl;
      onHeaders &&
        (onHeadersImpl = function (headersDescriptor) {
          onHeaders(new Headers(headersDescriptor));
        });
      var resources = createResumableState(
          options ? options.identifierPrefix : void 0,
          options ? options.unstable_externalRuntimeSrc : void 0,
          options ? options.bootstrapScriptContent : void 0,
          options ? options.bootstrapScripts : void 0,
          options ? options.bootstrapModules : void 0,
        ),
        request = createPrerenderRequest(
          children,
          resources,
          createRenderState(
            resources,
            void 0,
            options ? options.unstable_externalRuntimeSrc : void 0,
            options ? options.importMap : void 0,
            onHeadersImpl,
            options ? options.maxHeadersLength : void 0,
          ),
          createRootFormatContext(options ? options.namespaceURI : void 0),
          options ? options.progressiveChunkSize : void 0,
          options ? options.onError : void 0,
          function () {
            var stream = new ReadableStream(
              {
                type: "bytes",
                pull: function (controller) {
                  startFlowing(request, controller);
                },
                cancel: function (reason) {
                  request.destination = null;
                  abort(request, reason);
                },
              },
              { highWaterMark: 0 },
            );
            stream = { postponed: getPostponedState(request), prelude: stream };
            resolve(stream);
          },
          void 0,
          void 0,
          reject,
          options ? options.onPostpone : void 0,
        );
      if (options && options.signal) {
        var signal = options.signal;
        if (signal.aborted) abort(request, signal.reason);
        else {
          var listener = function () {
            abort(request, signal.reason);
            signal.removeEventListener("abort", listener);
          };
          signal.addEventListener("abort", listener);
        }
      }
      startWork(request);
    });
  };
  reactDomServer_edge_production.renderToReadableStream = function (children, options) {
    return new Promise(function (resolve, reject) {
      var onFatalError,
        onAllReady,
        allReady = new Promise(function (res, rej) {
          onAllReady = res;
          onFatalError = rej;
        }),
        onHeaders = options ? options.onHeaders : void 0,
        onHeadersImpl;
      onHeaders &&
        (onHeadersImpl = function (headersDescriptor) {
          onHeaders(new Headers(headersDescriptor));
        });
      var resumableState = createResumableState(
          options ? options.identifierPrefix : void 0,
          options ? options.unstable_externalRuntimeSrc : void 0,
          options ? options.bootstrapScriptContent : void 0,
          options ? options.bootstrapScripts : void 0,
          options ? options.bootstrapModules : void 0,
        ),
        request = createRequest(
          children,
          resumableState,
          createRenderState(
            resumableState,
            options ? options.nonce : void 0,
            options ? options.unstable_externalRuntimeSrc : void 0,
            options ? options.importMap : void 0,
            onHeadersImpl,
            options ? options.maxHeadersLength : void 0,
          ),
          createRootFormatContext(options ? options.namespaceURI : void 0),
          options ? options.progressiveChunkSize : void 0,
          options ? options.onError : void 0,
          onAllReady,
          function () {
            var stream = new ReadableStream(
              {
                type: "bytes",
                pull: function (controller) {
                  startFlowing(request, controller);
                },
                cancel: function (reason) {
                  request.destination = null;
                  abort(request, reason);
                },
              },
              { highWaterMark: 0 },
            );
            stream.allReady = allReady;
            resolve(stream);
          },
          function (error) {
            allReady.catch(function () {});
            reject(error);
          },
          onFatalError,
          options ? options.onPostpone : void 0,
          options ? options.formState : void 0,
        );
      if (options && options.signal) {
        var signal = options.signal;
        if (signal.aborted) abort(request, signal.reason);
        else {
          var listener = function () {
            abort(request, signal.reason);
            signal.removeEventListener("abort", listener);
          };
          signal.addEventListener("abort", listener);
        }
      }
      startWork(request);
    });
  };
  reactDomServer_edge_production.resume = function (children, postponedState, options) {
    return new Promise(function (resolve, reject) {
      var onFatalError,
        onAllReady,
        allReady = new Promise(function (res, rej) {
          onAllReady = res;
          onFatalError = rej;
        }),
        request = resumeRequest(
          children,
          postponedState,
          createRenderState(
            postponedState.resumableState,
            options ? options.nonce : void 0,
            void 0,
            void 0,
            void 0,
            void 0,
          ),
          options ? options.onError : void 0,
          onAllReady,
          function () {
            var stream = new ReadableStream(
              {
                type: "bytes",
                pull: function (controller) {
                  startFlowing(request, controller);
                },
                cancel: function (reason) {
                  request.destination = null;
                  abort(request, reason);
                },
              },
              { highWaterMark: 0 },
            );
            stream.allReady = allReady;
            resolve(stream);
          },
          function (error) {
            allReady.catch(function () {});
            reject(error);
          },
          onFatalError,
          options ? options.onPostpone : void 0,
        );
      if (options && options.signal) {
        var signal = options.signal;
        if (signal.aborted) abort(request, signal.reason);
        else {
          var listener = function () {
            abort(request, signal.reason);
            signal.removeEventListener("abort", listener);
          };
          signal.addEventListener("abort", listener);
        }
      }
      startWork(request);
    });
  };
  reactDomServer_edge_production.resumeAndPrerender = function (children, postponedState, options) {
    return new Promise(function (resolve, reject) {
      var request = resumeAndPrerenderRequest(
        children,
        postponedState,
        createRenderState(postponedState.resumableState, void 0, void 0, void 0, void 0, void 0),
        options ? options.onError : void 0,
        function () {
          var stream = new ReadableStream(
            {
              type: "bytes",
              pull: function (controller) {
                startFlowing(request, controller);
              },
              cancel: function (reason) {
                request.destination = null;
                abort(request, reason);
              },
            },
            { highWaterMark: 0 },
          );
          stream = { postponed: getPostponedState(request), prelude: stream };
          resolve(stream);
        },
        void 0,
        void 0,
        reject,
        options ? options.onPostpone : void 0,
      );
      if (options && options.signal) {
        var signal = options.signal;
        if (signal.aborted) abort(request, signal.reason);
        else {
          var listener = function () {
            abort(request, signal.reason);
            signal.removeEventListener("abort", listener);
          };
          signal.addEventListener("abort", listener);
        }
      }
      startWork(request);
    });
  };
  reactDomServer_edge_production.version = "19.2.5";
  return reactDomServer_edge_production;
}
var reactDomServerLegacy_browser_production = {};
/**
 * @license React
 * react-dom-server-legacy.browser.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var hasRequiredReactDomServerLegacy_browser_production;
function requireReactDomServerLegacy_browser_production() {
  if (hasRequiredReactDomServerLegacy_browser_production)
    return reactDomServerLegacy_browser_production;
  hasRequiredReactDomServerLegacy_browser_production = 1;
  var React2 = requireReact(),
    ReactDOM = requireReactDom();
  function formatProdErrorMessage(code) {
    var url = "https://react.dev/errors/" + code;
    if (1 < arguments.length) {
      url += "?args[]=" + encodeURIComponent(arguments[1]);
      for (var i = 2; i < arguments.length; i++)
        url += "&args[]=" + encodeURIComponent(arguments[i]);
    }
    return (
      "Minified React error #" +
      code +
      "; visit " +
      url +
      " for the full message or use the non-minified dev environment for full errors and additional helpful warnings."
    );
  }
  var REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element"),
    REACT_PORTAL_TYPE = Symbol.for("react.portal"),
    REACT_FRAGMENT_TYPE = Symbol.for("react.fragment"),
    REACT_STRICT_MODE_TYPE = Symbol.for("react.strict_mode"),
    REACT_PROFILER_TYPE = Symbol.for("react.profiler"),
    REACT_CONSUMER_TYPE = Symbol.for("react.consumer"),
    REACT_CONTEXT_TYPE = Symbol.for("react.context"),
    REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref"),
    REACT_SUSPENSE_TYPE = Symbol.for("react.suspense"),
    REACT_SUSPENSE_LIST_TYPE = Symbol.for("react.suspense_list"),
    REACT_MEMO_TYPE = Symbol.for("react.memo"),
    REACT_LAZY_TYPE = Symbol.for("react.lazy"),
    REACT_SCOPE_TYPE = Symbol.for("react.scope"),
    REACT_ACTIVITY_TYPE = Symbol.for("react.activity"),
    REACT_LEGACY_HIDDEN_TYPE = Symbol.for("react.legacy_hidden"),
    REACT_MEMO_CACHE_SENTINEL = Symbol.for("react.memo_cache_sentinel"),
    REACT_VIEW_TRANSITION_TYPE = Symbol.for("react.view_transition"),
    MAYBE_ITERATOR_SYMBOL = Symbol.iterator;
  function getIteratorFn(maybeIterable) {
    if (null === maybeIterable || "object" !== typeof maybeIterable) return null;
    maybeIterable =
      (MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL]) ||
      maybeIterable["@@iterator"];
    return "function" === typeof maybeIterable ? maybeIterable : null;
  }
  var isArrayImpl = Array.isArray;
  function murmurhash3_32_gc(key, seed) {
    var remainder = key.length & 3;
    var bytes = key.length - remainder;
    var h1 = seed;
    for (seed = 0; seed < bytes; ) {
      var k1 =
        (key.charCodeAt(seed) & 255) |
        ((key.charCodeAt(++seed) & 255) << 8) |
        ((key.charCodeAt(++seed) & 255) << 16) |
        ((key.charCodeAt(++seed) & 255) << 24);
      ++seed;
      k1 = (3432918353 * (k1 & 65535) + (((3432918353 * (k1 >>> 16)) & 65535) << 16)) & 4294967295;
      k1 = (k1 << 15) | (k1 >>> 17);
      k1 = (461845907 * (k1 & 65535) + (((461845907 * (k1 >>> 16)) & 65535) << 16)) & 4294967295;
      h1 ^= k1;
      h1 = (h1 << 13) | (h1 >>> 19);
      h1 = (5 * (h1 & 65535) + (((5 * (h1 >>> 16)) & 65535) << 16)) & 4294967295;
      h1 = (h1 & 65535) + 27492 + ((((h1 >>> 16) + 58964) & 65535) << 16);
    }
    k1 = 0;
    switch (remainder) {
      case 3:
        k1 ^= (key.charCodeAt(seed + 2) & 255) << 16;
      case 2:
        k1 ^= (key.charCodeAt(seed + 1) & 255) << 8;
      case 1:
        ((k1 ^= key.charCodeAt(seed) & 255),
          (k1 =
            (3432918353 * (k1 & 65535) + (((3432918353 * (k1 >>> 16)) & 65535) << 16)) &
            4294967295),
          (k1 = (k1 << 15) | (k1 >>> 17)),
          (h1 ^=
            (461845907 * (k1 & 65535) + (((461845907 * (k1 >>> 16)) & 65535) << 16)) & 4294967295));
    }
    h1 ^= key.length;
    h1 ^= h1 >>> 16;
    h1 = (2246822507 * (h1 & 65535) + (((2246822507 * (h1 >>> 16)) & 65535) << 16)) & 4294967295;
    h1 ^= h1 >>> 13;
    h1 = (3266489909 * (h1 & 65535) + (((3266489909 * (h1 >>> 16)) & 65535) << 16)) & 4294967295;
    return (h1 ^ (h1 >>> 16)) >>> 0;
  }
  var assign = Object.assign,
    hasOwnProperty = Object.prototype.hasOwnProperty,
    VALID_ATTRIBUTE_NAME_REGEX = RegExp(
      "^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$",
    ),
    illegalAttributeNameCache = {},
    validatedAttributeNameCache = {};
  function isAttributeNameSafe(attributeName) {
    if (hasOwnProperty.call(validatedAttributeNameCache, attributeName)) return true;
    if (hasOwnProperty.call(illegalAttributeNameCache, attributeName)) return false;
    if (VALID_ATTRIBUTE_NAME_REGEX.test(attributeName))
      return (validatedAttributeNameCache[attributeName] = true);
    illegalAttributeNameCache[attributeName] = true;
    return false;
  }
  var unitlessNumbers = new Set(
      "animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp".split(
        " ",
      ),
    ),
    aliases = /* @__PURE__ */ new Map([
      ["acceptCharset", "accept-charset"],
      ["htmlFor", "for"],
      ["httpEquiv", "http-equiv"],
      ["crossOrigin", "crossorigin"],
      ["accentHeight", "accent-height"],
      ["alignmentBaseline", "alignment-baseline"],
      ["arabicForm", "arabic-form"],
      ["baselineShift", "baseline-shift"],
      ["capHeight", "cap-height"],
      ["clipPath", "clip-path"],
      ["clipRule", "clip-rule"],
      ["colorInterpolation", "color-interpolation"],
      ["colorInterpolationFilters", "color-interpolation-filters"],
      ["colorProfile", "color-profile"],
      ["colorRendering", "color-rendering"],
      ["dominantBaseline", "dominant-baseline"],
      ["enableBackground", "enable-background"],
      ["fillOpacity", "fill-opacity"],
      ["fillRule", "fill-rule"],
      ["floodColor", "flood-color"],
      ["floodOpacity", "flood-opacity"],
      ["fontFamily", "font-family"],
      ["fontSize", "font-size"],
      ["fontSizeAdjust", "font-size-adjust"],
      ["fontStretch", "font-stretch"],
      ["fontStyle", "font-style"],
      ["fontVariant", "font-variant"],
      ["fontWeight", "font-weight"],
      ["glyphName", "glyph-name"],
      ["glyphOrientationHorizontal", "glyph-orientation-horizontal"],
      ["glyphOrientationVertical", "glyph-orientation-vertical"],
      ["horizAdvX", "horiz-adv-x"],
      ["horizOriginX", "horiz-origin-x"],
      ["imageRendering", "image-rendering"],
      ["letterSpacing", "letter-spacing"],
      ["lightingColor", "lighting-color"],
      ["markerEnd", "marker-end"],
      ["markerMid", "marker-mid"],
      ["markerStart", "marker-start"],
      ["overlinePosition", "overline-position"],
      ["overlineThickness", "overline-thickness"],
      ["paintOrder", "paint-order"],
      ["panose-1", "panose-1"],
      ["pointerEvents", "pointer-events"],
      ["renderingIntent", "rendering-intent"],
      ["shapeRendering", "shape-rendering"],
      ["stopColor", "stop-color"],
      ["stopOpacity", "stop-opacity"],
      ["strikethroughPosition", "strikethrough-position"],
      ["strikethroughThickness", "strikethrough-thickness"],
      ["strokeDasharray", "stroke-dasharray"],
      ["strokeDashoffset", "stroke-dashoffset"],
      ["strokeLinecap", "stroke-linecap"],
      ["strokeLinejoin", "stroke-linejoin"],
      ["strokeMiterlimit", "stroke-miterlimit"],
      ["strokeOpacity", "stroke-opacity"],
      ["strokeWidth", "stroke-width"],
      ["textAnchor", "text-anchor"],
      ["textDecoration", "text-decoration"],
      ["textRendering", "text-rendering"],
      ["transformOrigin", "transform-origin"],
      ["underlinePosition", "underline-position"],
      ["underlineThickness", "underline-thickness"],
      ["unicodeBidi", "unicode-bidi"],
      ["unicodeRange", "unicode-range"],
      ["unitsPerEm", "units-per-em"],
      ["vAlphabetic", "v-alphabetic"],
      ["vHanging", "v-hanging"],
      ["vIdeographic", "v-ideographic"],
      ["vMathematical", "v-mathematical"],
      ["vectorEffect", "vector-effect"],
      ["vertAdvY", "vert-adv-y"],
      ["vertOriginX", "vert-origin-x"],
      ["vertOriginY", "vert-origin-y"],
      ["wordSpacing", "word-spacing"],
      ["writingMode", "writing-mode"],
      ["xmlnsXlink", "xmlns:xlink"],
      ["xHeight", "x-height"],
    ]),
    matchHtmlRegExp = /["'&<>]/;
  function escapeTextForBrowser(text) {
    if ("boolean" === typeof text || "number" === typeof text || "bigint" === typeof text)
      return "" + text;
    text = "" + text;
    var match = matchHtmlRegExp.exec(text);
    if (match) {
      var html = "",
        index,
        lastIndex = 0;
      for (index = match.index; index < text.length; index++) {
        switch (text.charCodeAt(index)) {
          case 34:
            match = "&quot;";
            break;
          case 38:
            match = "&amp;";
            break;
          case 39:
            match = "&#x27;";
            break;
          case 60:
            match = "&lt;";
            break;
          case 62:
            match = "&gt;";
            break;
          default:
            continue;
        }
        lastIndex !== index && (html += text.slice(lastIndex, index));
        lastIndex = index + 1;
        html += match;
      }
      text = lastIndex !== index ? html + text.slice(lastIndex, index) : html;
    }
    return text;
  }
  var uppercasePattern = /([A-Z])/g,
    msPattern = /^ms-/,
    isJavaScriptProtocol =
      /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;
  function sanitizeURL(url) {
    return isJavaScriptProtocol.test("" + url)
      ? "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')"
      : url;
  }
  var ReactSharedInternals = React2.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
    ReactDOMSharedInternals = ReactDOM.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
    sharedNotPendingObject = {
      pending: false,
      data: null,
      method: null,
      action: null,
    },
    previousDispatcher = ReactDOMSharedInternals.d;
  ReactDOMSharedInternals.d = {
    f: previousDispatcher.f,
    r: previousDispatcher.r,
    D: prefetchDNS,
    C: preconnect,
    L: preload,
    m: preloadModule,
    X: preinitScript,
    S: preinitStyle,
    M: preinitModuleScript,
  };
  var PRELOAD_NO_CREDS = [],
    currentlyFlushingRenderState = null,
    scriptRegex = /(<\/|<)(s)(cript)/gi;
  function scriptReplacer(match, prefix2, s, suffix2) {
    return "" + prefix2 + ("s" === s ? "\\u0073" : "\\u0053") + suffix2;
  }
  function createResumableState(
    identifierPrefix,
    externalRuntimeConfig,
    bootstrapScriptContent,
    bootstrapScripts,
    bootstrapModules,
  ) {
    return {
      idPrefix: void 0 === identifierPrefix ? "" : identifierPrefix,
      nextFormID: 0,
      streamingFormat: 0,
      bootstrapScriptContent,
      bootstrapScripts,
      bootstrapModules,
      instructions: 0,
      hasBody: false,
      hasHtml: false,
      unknownResources: {},
      dnsResources: {},
      connectResources: { default: {}, anonymous: {}, credentials: {} },
      imageResources: {},
      styleResources: {},
      scriptResources: {},
      moduleUnknownResources: {},
      moduleScriptResources: {},
    };
  }
  function createFormatContext(insertionMode, selectedValue, tagScope, viewTransition) {
    return {
      insertionMode,
      selectedValue,
      tagScope,
      viewTransition,
    };
  }
  function getChildFormatContext(parentContext, type, props) {
    var subtreeScope = parentContext.tagScope & -25;
    switch (type) {
      case "noscript":
        return createFormatContext(2, null, subtreeScope | 1, null);
      case "select":
        return createFormatContext(
          2,
          null != props.value ? props.value : props.defaultValue,
          subtreeScope,
          null,
        );
      case "svg":
        return createFormatContext(4, null, subtreeScope, null);
      case "picture":
        return createFormatContext(2, null, subtreeScope | 2, null);
      case "math":
        return createFormatContext(5, null, subtreeScope, null);
      case "foreignObject":
        return createFormatContext(2, null, subtreeScope, null);
      case "table":
        return createFormatContext(6, null, subtreeScope, null);
      case "thead":
      case "tbody":
      case "tfoot":
        return createFormatContext(7, null, subtreeScope, null);
      case "colgroup":
        return createFormatContext(9, null, subtreeScope, null);
      case "tr":
        return createFormatContext(8, null, subtreeScope, null);
      case "head":
        if (2 > parentContext.insertionMode)
          return createFormatContext(3, null, subtreeScope, null);
        break;
      case "html":
        if (0 === parentContext.insertionMode)
          return createFormatContext(1, null, subtreeScope, null);
    }
    return 6 <= parentContext.insertionMode || 2 > parentContext.insertionMode
      ? createFormatContext(2, null, subtreeScope, null)
      : parentContext.tagScope !== subtreeScope
        ? createFormatContext(
            parentContext.insertionMode,
            parentContext.selectedValue,
            subtreeScope,
            null,
          )
        : parentContext;
  }
  function getSuspenseViewTransition(parentViewTransition) {
    return null === parentViewTransition
      ? null
      : {
          update: parentViewTransition.update,
          enter: "none",
          exit: "none",
          share: parentViewTransition.update,
          name: parentViewTransition.autoName,
          autoName: parentViewTransition.autoName,
          nameIdx: 0,
        };
  }
  function getSuspenseFallbackFormatContext(resumableState, parentContext) {
    parentContext.tagScope & 32 && (resumableState.instructions |= 128);
    return createFormatContext(
      parentContext.insertionMode,
      parentContext.selectedValue,
      parentContext.tagScope | 12,
      getSuspenseViewTransition(parentContext.viewTransition),
    );
  }
  function getSuspenseContentFormatContext(resumableState, parentContext) {
    resumableState = getSuspenseViewTransition(parentContext.viewTransition);
    var subtreeScope = parentContext.tagScope | 16;
    null !== resumableState && "none" !== resumableState.share && (subtreeScope |= 64);
    return createFormatContext(
      parentContext.insertionMode,
      parentContext.selectedValue,
      subtreeScope,
      resumableState,
    );
  }
  var styleNameCache = /* @__PURE__ */ new Map();
  function pushStyleAttribute(target, style) {
    if ("object" !== typeof style) throw Error(formatProdErrorMessage(62));
    var isFirst = true,
      styleName;
    for (styleName in style)
      if (hasOwnProperty.call(style, styleName)) {
        var styleValue = style[styleName];
        if (null != styleValue && "boolean" !== typeof styleValue && "" !== styleValue) {
          if (0 === styleName.indexOf("--")) {
            var nameChunk = escapeTextForBrowser(styleName);
            styleValue = escapeTextForBrowser(("" + styleValue).trim());
          } else
            ((nameChunk = styleNameCache.get(styleName)),
              void 0 === nameChunk &&
                ((nameChunk = escapeTextForBrowser(
                  styleName
                    .replace(uppercasePattern, "-$1")
                    .toLowerCase()
                    .replace(msPattern, "-ms-"),
                )),
                styleNameCache.set(styleName, nameChunk)),
              (styleValue =
                "number" === typeof styleValue
                  ? 0 === styleValue || unitlessNumbers.has(styleName)
                    ? "" + styleValue
                    : styleValue + "px"
                  : escapeTextForBrowser(("" + styleValue).trim())));
          isFirst
            ? ((isFirst = false), target.push(' style="', nameChunk, ":", styleValue))
            : target.push(";", nameChunk, ":", styleValue);
        }
      }
    isFirst || target.push('"');
  }
  function pushBooleanAttribute(target, name, value) {
    value &&
      "function" !== typeof value &&
      "symbol" !== typeof value &&
      target.push(" ", name, '=""');
  }
  function pushStringAttribute(target, name, value) {
    "function" !== typeof value &&
      "symbol" !== typeof value &&
      "boolean" !== typeof value &&
      target.push(" ", name, '="', escapeTextForBrowser(value), '"');
  }
  var actionJavaScriptURL = escapeTextForBrowser(
    "javascript:throw new Error('React form unexpectedly submitted.')",
  );
  function pushAdditionalFormField(value, key) {
    this.push('<input type="hidden"');
    validateAdditionalFormField(value);
    pushStringAttribute(this, "name", key);
    pushStringAttribute(this, "value", value);
    this.push("/>");
  }
  function validateAdditionalFormField(value) {
    if ("string" !== typeof value) throw Error(formatProdErrorMessage(480));
  }
  function getCustomFormFields(resumableState, formAction) {
    if ("function" === typeof formAction.$$FORM_ACTION) {
      var id = resumableState.nextFormID++;
      resumableState = resumableState.idPrefix + id;
      try {
        var customFields = formAction.$$FORM_ACTION(resumableState);
        if (customFields) {
          var formData = customFields.data;
          null != formData && formData.forEach(validateAdditionalFormField);
        }
        return customFields;
      } catch (x3) {
        if ("object" === typeof x3 && null !== x3 && "function" === typeof x3.then) throw x3;
      }
    }
    return null;
  }
  function pushFormActionAttribute(
    target,
    resumableState,
    renderState,
    formAction,
    formEncType,
    formMethod,
    formTarget,
    name,
  ) {
    var formData = null;
    if ("function" === typeof formAction) {
      var customFields = getCustomFormFields(resumableState, formAction);
      null !== customFields
        ? ((name = customFields.name),
          (formAction = customFields.action || ""),
          (formEncType = customFields.encType),
          (formMethod = customFields.method),
          (formTarget = customFields.target),
          (formData = customFields.data))
        : (target.push(" ", "formAction", '="', actionJavaScriptURL, '"'),
          (formTarget = formMethod = formEncType = formAction = name = null),
          injectFormReplayingRuntime(resumableState, renderState));
    }
    null != name && pushAttribute(target, "name", name);
    null != formAction && pushAttribute(target, "formAction", formAction);
    null != formEncType && pushAttribute(target, "formEncType", formEncType);
    null != formMethod && pushAttribute(target, "formMethod", formMethod);
    null != formTarget && pushAttribute(target, "formTarget", formTarget);
    return formData;
  }
  function pushAttribute(target, name, value) {
    switch (name) {
      case "className":
        pushStringAttribute(target, "class", value);
        break;
      case "tabIndex":
        pushStringAttribute(target, "tabindex", value);
        break;
      case "dir":
      case "role":
      case "viewBox":
      case "width":
      case "height":
        pushStringAttribute(target, name, value);
        break;
      case "style":
        pushStyleAttribute(target, value);
        break;
      case "src":
      case "href":
        if ("" === value) break;
      case "action":
      case "formAction":
        if (
          null == value ||
          "function" === typeof value ||
          "symbol" === typeof value ||
          "boolean" === typeof value
        )
          break;
        value = sanitizeURL("" + value);
        target.push(" ", name, '="', escapeTextForBrowser(value), '"');
        break;
      case "defaultValue":
      case "defaultChecked":
      case "innerHTML":
      case "suppressContentEditableWarning":
      case "suppressHydrationWarning":
      case "ref":
        break;
      case "autoFocus":
      case "multiple":
      case "muted":
        pushBooleanAttribute(target, name.toLowerCase(), value);
        break;
      case "xlinkHref":
        if ("function" === typeof value || "symbol" === typeof value || "boolean" === typeof value)
          break;
        value = sanitizeURL("" + value);
        target.push(" ", "xlink:href", '="', escapeTextForBrowser(value), '"');
        break;
      case "contentEditable":
      case "spellCheck":
      case "draggable":
      case "value":
      case "autoReverse":
      case "externalResourcesRequired":
      case "focusable":
      case "preserveAlpha":
        "function" !== typeof value &&
          "symbol" !== typeof value &&
          target.push(" ", name, '="', escapeTextForBrowser(value), '"');
        break;
      case "inert":
      case "allowFullScreen":
      case "async":
      case "autoPlay":
      case "controls":
      case "default":
      case "defer":
      case "disabled":
      case "disablePictureInPicture":
      case "disableRemotePlayback":
      case "formNoValidate":
      case "hidden":
      case "loop":
      case "noModule":
      case "noValidate":
      case "open":
      case "playsInline":
      case "readOnly":
      case "required":
      case "reversed":
      case "scoped":
      case "seamless":
      case "itemScope":
        value &&
          "function" !== typeof value &&
          "symbol" !== typeof value &&
          target.push(" ", name, '=""');
        break;
      case "capture":
      case "download":
        true === value
          ? target.push(" ", name, '=""')
          : false !== value &&
            "function" !== typeof value &&
            "symbol" !== typeof value &&
            target.push(" ", name, '="', escapeTextForBrowser(value), '"');
        break;
      case "cols":
      case "rows":
      case "size":
      case "span":
        "function" !== typeof value &&
          "symbol" !== typeof value &&
          !isNaN(value) &&
          1 <= value &&
          target.push(" ", name, '="', escapeTextForBrowser(value), '"');
        break;
      case "rowSpan":
      case "start":
        "function" === typeof value ||
          "symbol" === typeof value ||
          isNaN(value) ||
          target.push(" ", name, '="', escapeTextForBrowser(value), '"');
        break;
      case "xlinkActuate":
        pushStringAttribute(target, "xlink:actuate", value);
        break;
      case "xlinkArcrole":
        pushStringAttribute(target, "xlink:arcrole", value);
        break;
      case "xlinkRole":
        pushStringAttribute(target, "xlink:role", value);
        break;
      case "xlinkShow":
        pushStringAttribute(target, "xlink:show", value);
        break;
      case "xlinkTitle":
        pushStringAttribute(target, "xlink:title", value);
        break;
      case "xlinkType":
        pushStringAttribute(target, "xlink:type", value);
        break;
      case "xmlBase":
        pushStringAttribute(target, "xml:base", value);
        break;
      case "xmlLang":
        pushStringAttribute(target, "xml:lang", value);
        break;
      case "xmlSpace":
        pushStringAttribute(target, "xml:space", value);
        break;
      default:
        if (
          !(2 < name.length) ||
          ("o" !== name[0] && "O" !== name[0]) ||
          ("n" !== name[1] && "N" !== name[1])
        ) {
          if (((name = aliases.get(name) || name), isAttributeNameSafe(name))) {
            switch (typeof value) {
              case "function":
              case "symbol":
                return;
              case "boolean":
                var prefix$8 = name.toLowerCase().slice(0, 5);
                if ("data-" !== prefix$8 && "aria-" !== prefix$8) return;
            }
            target.push(" ", name, '="', escapeTextForBrowser(value), '"');
          }
        }
    }
  }
  function pushInnerHTML(target, innerHTML, children) {
    if (null != innerHTML) {
      if (null != children) throw Error(formatProdErrorMessage(60));
      if ("object" !== typeof innerHTML || !("__html" in innerHTML))
        throw Error(formatProdErrorMessage(61));
      innerHTML = innerHTML.__html;
      null !== innerHTML && void 0 !== innerHTML && target.push("" + innerHTML);
    }
  }
  function flattenOptionChildren(children) {
    var content = "";
    React2.Children.forEach(children, function (child) {
      null != child && (content += child);
    });
    return content;
  }
  function injectFormReplayingRuntime(resumableState, renderState) {
    if (0 === (resumableState.instructions & 16)) {
      resumableState.instructions |= 16;
      var preamble = renderState.preamble,
        bootstrapChunks = renderState.bootstrapChunks;
      (preamble.htmlChunks || preamble.headChunks) && 0 === bootstrapChunks.length
        ? (bootstrapChunks.push(renderState.startInlineScript),
          pushCompletedShellIdAttribute(bootstrapChunks, resumableState),
          bootstrapChunks.push(
            ">",
            `addEventListener("submit",function(a){if(!a.defaultPrevented){var c=a.target,d=a.submitter,e=c.action,b=d;if(d){var f=d.getAttribute("formAction");null!=f&&(e=f,b=null)}"javascript:throw new Error('React form unexpectedly submitted.')"===e&&(a.preventDefault(),b?(a=document.createElement("input"),a.name=b.name,a.value=b.value,b.parentNode.insertBefore(a,b),b=new FormData(c),a.parentNode.removeChild(a)):b=new FormData(c),a=c.ownerDocument||c,(a.$$reactFormReplay=a.$$reactFormReplay||[]).push(c,d,b))}});`,
            "<\/script>",
          ))
        : bootstrapChunks.unshift(
            renderState.startInlineScript,
            ">",
            `addEventListener("submit",function(a){if(!a.defaultPrevented){var c=a.target,d=a.submitter,e=c.action,b=d;if(d){var f=d.getAttribute("formAction");null!=f&&(e=f,b=null)}"javascript:throw new Error('React form unexpectedly submitted.')"===e&&(a.preventDefault(),b?(a=document.createElement("input"),a.name=b.name,a.value=b.value,b.parentNode.insertBefore(a,b),b=new FormData(c),a.parentNode.removeChild(a)):b=new FormData(c),a=c.ownerDocument||c,(a.$$reactFormReplay=a.$$reactFormReplay||[]).push(c,d,b))}});`,
            "<\/script>",
          );
    }
  }
  function pushLinkImpl(target, props) {
    target.push(startChunkForTag("link"));
    for (var propKey in props)
      if (hasOwnProperty.call(props, propKey)) {
        var propValue = props[propKey];
        if (null != propValue)
          switch (propKey) {
            case "children":
            case "dangerouslySetInnerHTML":
              throw Error(formatProdErrorMessage(399, "link"));
            default:
              pushAttribute(target, propKey, propValue);
          }
      }
    target.push("/>");
    return null;
  }
  var styleRegex = /(<\/|<)(s)(tyle)/gi;
  function styleReplacer(match, prefix2, s, suffix2) {
    return "" + prefix2 + ("s" === s ? "\\73 " : "\\53 ") + suffix2;
  }
  function pushSelfClosing(target, props, tag) {
    target.push(startChunkForTag(tag));
    for (var propKey in props)
      if (hasOwnProperty.call(props, propKey)) {
        var propValue = props[propKey];
        if (null != propValue)
          switch (propKey) {
            case "children":
            case "dangerouslySetInnerHTML":
              throw Error(formatProdErrorMessage(399, tag));
            default:
              pushAttribute(target, propKey, propValue);
          }
      }
    target.push("/>");
    return null;
  }
  function pushTitleImpl(target, props) {
    target.push(startChunkForTag("title"));
    var children = null,
      innerHTML = null,
      propKey;
    for (propKey in props)
      if (hasOwnProperty.call(props, propKey)) {
        var propValue = props[propKey];
        if (null != propValue)
          switch (propKey) {
            case "children":
              children = propValue;
              break;
            case "dangerouslySetInnerHTML":
              innerHTML = propValue;
              break;
            default:
              pushAttribute(target, propKey, propValue);
          }
      }
    target.push(">");
    props = Array.isArray(children) ? (2 > children.length ? children[0] : null) : children;
    "function" !== typeof props &&
      "symbol" !== typeof props &&
      null !== props &&
      void 0 !== props &&
      target.push(escapeTextForBrowser("" + props));
    pushInnerHTML(target, innerHTML, children);
    target.push(endChunkForTag("title"));
    return null;
  }
  function pushScriptImpl(target, props) {
    target.push(startChunkForTag("script"));
    var children = null,
      innerHTML = null,
      propKey;
    for (propKey in props)
      if (hasOwnProperty.call(props, propKey)) {
        var propValue = props[propKey];
        if (null != propValue)
          switch (propKey) {
            case "children":
              children = propValue;
              break;
            case "dangerouslySetInnerHTML":
              innerHTML = propValue;
              break;
            default:
              pushAttribute(target, propKey, propValue);
          }
      }
    target.push(">");
    pushInnerHTML(target, innerHTML, children);
    "string" === typeof children &&
      target.push(("" + children).replace(scriptRegex, scriptReplacer));
    target.push(endChunkForTag("script"));
    return null;
  }
  function pushStartSingletonElement(target, props, tag) {
    target.push(startChunkForTag(tag));
    var innerHTML = (tag = null),
      propKey;
    for (propKey in props)
      if (hasOwnProperty.call(props, propKey)) {
        var propValue = props[propKey];
        if (null != propValue)
          switch (propKey) {
            case "children":
              tag = propValue;
              break;
            case "dangerouslySetInnerHTML":
              innerHTML = propValue;
              break;
            default:
              pushAttribute(target, propKey, propValue);
          }
      }
    target.push(">");
    pushInnerHTML(target, innerHTML, tag);
    return tag;
  }
  function pushStartGenericElement(target, props, tag) {
    target.push(startChunkForTag(tag));
    var innerHTML = (tag = null),
      propKey;
    for (propKey in props)
      if (hasOwnProperty.call(props, propKey)) {
        var propValue = props[propKey];
        if (null != propValue)
          switch (propKey) {
            case "children":
              tag = propValue;
              break;
            case "dangerouslySetInnerHTML":
              innerHTML = propValue;
              break;
            default:
              pushAttribute(target, propKey, propValue);
          }
      }
    target.push(">");
    pushInnerHTML(target, innerHTML, tag);
    return "string" === typeof tag ? (target.push(escapeTextForBrowser(tag)), null) : tag;
  }
  var VALID_TAG_REGEX = /^[a-zA-Z][a-zA-Z:_\.\-\d]*$/,
    validatedTagCache = /* @__PURE__ */ new Map();
  function startChunkForTag(tag) {
    var tagStartChunk = validatedTagCache.get(tag);
    if (void 0 === tagStartChunk) {
      if (!VALID_TAG_REGEX.test(tag)) throw Error(formatProdErrorMessage(65, tag));
      tagStartChunk = "<" + tag;
      validatedTagCache.set(tag, tagStartChunk);
    }
    return tagStartChunk;
  }
  function pushStartInstance(
    target$jscomp$0,
    type,
    props,
    resumableState,
    renderState,
    preambleState,
    hoistableState,
    formatContext,
    textEmbedded,
  ) {
    switch (type) {
      case "div":
      case "span":
      case "svg":
      case "path":
        break;
      case "a":
        target$jscomp$0.push(startChunkForTag("a"));
        var children = null,
          innerHTML = null,
          propKey;
        for (propKey in props)
          if (hasOwnProperty.call(props, propKey)) {
            var propValue = props[propKey];
            if (null != propValue)
              switch (propKey) {
                case "children":
                  children = propValue;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML = propValue;
                  break;
                case "href":
                  "" === propValue
                    ? pushStringAttribute(target$jscomp$0, "href", "")
                    : pushAttribute(target$jscomp$0, propKey, propValue);
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey, propValue);
              }
          }
        target$jscomp$0.push(">");
        pushInnerHTML(target$jscomp$0, innerHTML, children);
        if ("string" === typeof children) {
          target$jscomp$0.push(escapeTextForBrowser(children));
          var JSCompiler_inline_result = null;
        } else JSCompiler_inline_result = children;
        return JSCompiler_inline_result;
      case "g":
      case "p":
      case "li":
        break;
      case "select":
        target$jscomp$0.push(startChunkForTag("select"));
        var children$jscomp$0 = null,
          innerHTML$jscomp$0 = null,
          propKey$jscomp$0;
        for (propKey$jscomp$0 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$0)) {
            var propValue$jscomp$0 = props[propKey$jscomp$0];
            if (null != propValue$jscomp$0)
              switch (propKey$jscomp$0) {
                case "children":
                  children$jscomp$0 = propValue$jscomp$0;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML$jscomp$0 = propValue$jscomp$0;
                  break;
                case "defaultValue":
                case "value":
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$0, propValue$jscomp$0);
              }
          }
        target$jscomp$0.push(">");
        pushInnerHTML(target$jscomp$0, innerHTML$jscomp$0, children$jscomp$0);
        return children$jscomp$0;
      case "option":
        var selectedValue = formatContext.selectedValue;
        target$jscomp$0.push(startChunkForTag("option"));
        var children$jscomp$1 = null,
          value = null,
          selected = null,
          innerHTML$jscomp$1 = null,
          propKey$jscomp$1;
        for (propKey$jscomp$1 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$1)) {
            var propValue$jscomp$1 = props[propKey$jscomp$1];
            if (null != propValue$jscomp$1)
              switch (propKey$jscomp$1) {
                case "children":
                  children$jscomp$1 = propValue$jscomp$1;
                  break;
                case "selected":
                  selected = propValue$jscomp$1;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML$jscomp$1 = propValue$jscomp$1;
                  break;
                case "value":
                  value = propValue$jscomp$1;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$1, propValue$jscomp$1);
              }
          }
        if (null != selectedValue) {
          var stringValue = null !== value ? "" + value : flattenOptionChildren(children$jscomp$1);
          if (isArrayImpl(selectedValue))
            for (var i = 0; i < selectedValue.length; i++) {
              if ("" + selectedValue[i] === stringValue) {
                target$jscomp$0.push(' selected=""');
                break;
              }
            }
          else "" + selectedValue === stringValue && target$jscomp$0.push(' selected=""');
        } else selected && target$jscomp$0.push(' selected=""');
        target$jscomp$0.push(">");
        pushInnerHTML(target$jscomp$0, innerHTML$jscomp$1, children$jscomp$1);
        return children$jscomp$1;
      case "textarea":
        target$jscomp$0.push(startChunkForTag("textarea"));
        var value$jscomp$0 = null,
          defaultValue = null,
          children$jscomp$2 = null,
          propKey$jscomp$2;
        for (propKey$jscomp$2 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$2)) {
            var propValue$jscomp$2 = props[propKey$jscomp$2];
            if (null != propValue$jscomp$2)
              switch (propKey$jscomp$2) {
                case "children":
                  children$jscomp$2 = propValue$jscomp$2;
                  break;
                case "value":
                  value$jscomp$0 = propValue$jscomp$2;
                  break;
                case "defaultValue":
                  defaultValue = propValue$jscomp$2;
                  break;
                case "dangerouslySetInnerHTML":
                  throw Error(formatProdErrorMessage(91));
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$2, propValue$jscomp$2);
              }
          }
        null === value$jscomp$0 && null !== defaultValue && (value$jscomp$0 = defaultValue);
        target$jscomp$0.push(">");
        if (null != children$jscomp$2) {
          if (null != value$jscomp$0) throw Error(formatProdErrorMessage(92));
          if (isArrayImpl(children$jscomp$2)) {
            if (1 < children$jscomp$2.length) throw Error(formatProdErrorMessage(93));
            value$jscomp$0 = "" + children$jscomp$2[0];
          }
          value$jscomp$0 = "" + children$jscomp$2;
        }
        "string" === typeof value$jscomp$0 &&
          "\n" === value$jscomp$0[0] &&
          target$jscomp$0.push("\n");
        null !== value$jscomp$0 && target$jscomp$0.push(escapeTextForBrowser("" + value$jscomp$0));
        return null;
      case "input":
        target$jscomp$0.push(startChunkForTag("input"));
        var name = null,
          formAction = null,
          formEncType = null,
          formMethod = null,
          formTarget = null,
          value$jscomp$1 = null,
          defaultValue$jscomp$0 = null,
          checked = null,
          defaultChecked = null,
          propKey$jscomp$3;
        for (propKey$jscomp$3 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$3)) {
            var propValue$jscomp$3 = props[propKey$jscomp$3];
            if (null != propValue$jscomp$3)
              switch (propKey$jscomp$3) {
                case "children":
                case "dangerouslySetInnerHTML":
                  throw Error(formatProdErrorMessage(399, "input"));
                case "name":
                  name = propValue$jscomp$3;
                  break;
                case "formAction":
                  formAction = propValue$jscomp$3;
                  break;
                case "formEncType":
                  formEncType = propValue$jscomp$3;
                  break;
                case "formMethod":
                  formMethod = propValue$jscomp$3;
                  break;
                case "formTarget":
                  formTarget = propValue$jscomp$3;
                  break;
                case "defaultChecked":
                  defaultChecked = propValue$jscomp$3;
                  break;
                case "defaultValue":
                  defaultValue$jscomp$0 = propValue$jscomp$3;
                  break;
                case "checked":
                  checked = propValue$jscomp$3;
                  break;
                case "value":
                  value$jscomp$1 = propValue$jscomp$3;
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$3, propValue$jscomp$3);
              }
          }
        var formData = pushFormActionAttribute(
          target$jscomp$0,
          resumableState,
          renderState,
          formAction,
          formEncType,
          formMethod,
          formTarget,
          name,
        );
        null !== checked
          ? pushBooleanAttribute(target$jscomp$0, "checked", checked)
          : null !== defaultChecked &&
            pushBooleanAttribute(target$jscomp$0, "checked", defaultChecked);
        null !== value$jscomp$1
          ? pushAttribute(target$jscomp$0, "value", value$jscomp$1)
          : null !== defaultValue$jscomp$0 &&
            pushAttribute(target$jscomp$0, "value", defaultValue$jscomp$0);
        target$jscomp$0.push("/>");
        null != formData && formData.forEach(pushAdditionalFormField, target$jscomp$0);
        return null;
      case "button":
        target$jscomp$0.push(startChunkForTag("button"));
        var children$jscomp$3 = null,
          innerHTML$jscomp$2 = null,
          name$jscomp$0 = null,
          formAction$jscomp$0 = null,
          formEncType$jscomp$0 = null,
          formMethod$jscomp$0 = null,
          formTarget$jscomp$0 = null,
          propKey$jscomp$4;
        for (propKey$jscomp$4 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$4)) {
            var propValue$jscomp$4 = props[propKey$jscomp$4];
            if (null != propValue$jscomp$4)
              switch (propKey$jscomp$4) {
                case "children":
                  children$jscomp$3 = propValue$jscomp$4;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML$jscomp$2 = propValue$jscomp$4;
                  break;
                case "name":
                  name$jscomp$0 = propValue$jscomp$4;
                  break;
                case "formAction":
                  formAction$jscomp$0 = propValue$jscomp$4;
                  break;
                case "formEncType":
                  formEncType$jscomp$0 = propValue$jscomp$4;
                  break;
                case "formMethod":
                  formMethod$jscomp$0 = propValue$jscomp$4;
                  break;
                case "formTarget":
                  formTarget$jscomp$0 = propValue$jscomp$4;
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$4, propValue$jscomp$4);
              }
          }
        var formData$jscomp$0 = pushFormActionAttribute(
          target$jscomp$0,
          resumableState,
          renderState,
          formAction$jscomp$0,
          formEncType$jscomp$0,
          formMethod$jscomp$0,
          formTarget$jscomp$0,
          name$jscomp$0,
        );
        target$jscomp$0.push(">");
        null != formData$jscomp$0 &&
          formData$jscomp$0.forEach(pushAdditionalFormField, target$jscomp$0);
        pushInnerHTML(target$jscomp$0, innerHTML$jscomp$2, children$jscomp$3);
        if ("string" === typeof children$jscomp$3) {
          target$jscomp$0.push(escapeTextForBrowser(children$jscomp$3));
          var JSCompiler_inline_result$jscomp$0 = null;
        } else JSCompiler_inline_result$jscomp$0 = children$jscomp$3;
        return JSCompiler_inline_result$jscomp$0;
      case "form":
        target$jscomp$0.push(startChunkForTag("form"));
        var children$jscomp$4 = null,
          innerHTML$jscomp$3 = null,
          formAction$jscomp$1 = null,
          formEncType$jscomp$1 = null,
          formMethod$jscomp$1 = null,
          formTarget$jscomp$1 = null,
          propKey$jscomp$5;
        for (propKey$jscomp$5 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$5)) {
            var propValue$jscomp$5 = props[propKey$jscomp$5];
            if (null != propValue$jscomp$5)
              switch (propKey$jscomp$5) {
                case "children":
                  children$jscomp$4 = propValue$jscomp$5;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML$jscomp$3 = propValue$jscomp$5;
                  break;
                case "action":
                  formAction$jscomp$1 = propValue$jscomp$5;
                  break;
                case "encType":
                  formEncType$jscomp$1 = propValue$jscomp$5;
                  break;
                case "method":
                  formMethod$jscomp$1 = propValue$jscomp$5;
                  break;
                case "target":
                  formTarget$jscomp$1 = propValue$jscomp$5;
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$5, propValue$jscomp$5);
              }
          }
        var formData$jscomp$1 = null,
          formActionName = null;
        if ("function" === typeof formAction$jscomp$1) {
          var customFields = getCustomFormFields(resumableState, formAction$jscomp$1);
          null !== customFields
            ? ((formAction$jscomp$1 = customFields.action || ""),
              (formEncType$jscomp$1 = customFields.encType),
              (formMethod$jscomp$1 = customFields.method),
              (formTarget$jscomp$1 = customFields.target),
              (formData$jscomp$1 = customFields.data),
              (formActionName = customFields.name))
            : (target$jscomp$0.push(" ", "action", '="', actionJavaScriptURL, '"'),
              (formTarget$jscomp$1 =
                formMethod$jscomp$1 =
                formEncType$jscomp$1 =
                formAction$jscomp$1 =
                  null),
              injectFormReplayingRuntime(resumableState, renderState));
        }
        null != formAction$jscomp$1 &&
          pushAttribute(target$jscomp$0, "action", formAction$jscomp$1);
        null != formEncType$jscomp$1 &&
          pushAttribute(target$jscomp$0, "encType", formEncType$jscomp$1);
        null != formMethod$jscomp$1 &&
          pushAttribute(target$jscomp$0, "method", formMethod$jscomp$1);
        null != formTarget$jscomp$1 &&
          pushAttribute(target$jscomp$0, "target", formTarget$jscomp$1);
        target$jscomp$0.push(">");
        null !== formActionName &&
          (target$jscomp$0.push('<input type="hidden"'),
          pushStringAttribute(target$jscomp$0, "name", formActionName),
          target$jscomp$0.push("/>"),
          null != formData$jscomp$1 &&
            formData$jscomp$1.forEach(pushAdditionalFormField, target$jscomp$0));
        pushInnerHTML(target$jscomp$0, innerHTML$jscomp$3, children$jscomp$4);
        if ("string" === typeof children$jscomp$4) {
          target$jscomp$0.push(escapeTextForBrowser(children$jscomp$4));
          var JSCompiler_inline_result$jscomp$1 = null;
        } else JSCompiler_inline_result$jscomp$1 = children$jscomp$4;
        return JSCompiler_inline_result$jscomp$1;
      case "menuitem":
        target$jscomp$0.push(startChunkForTag("menuitem"));
        for (var propKey$jscomp$6 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$6)) {
            var propValue$jscomp$6 = props[propKey$jscomp$6];
            if (null != propValue$jscomp$6)
              switch (propKey$jscomp$6) {
                case "children":
                case "dangerouslySetInnerHTML":
                  throw Error(formatProdErrorMessage(400));
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$6, propValue$jscomp$6);
              }
          }
        target$jscomp$0.push(">");
        return null;
      case "object":
        target$jscomp$0.push(startChunkForTag("object"));
        var children$jscomp$5 = null,
          innerHTML$jscomp$4 = null,
          propKey$jscomp$7;
        for (propKey$jscomp$7 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$7)) {
            var propValue$jscomp$7 = props[propKey$jscomp$7];
            if (null != propValue$jscomp$7)
              switch (propKey$jscomp$7) {
                case "children":
                  children$jscomp$5 = propValue$jscomp$7;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML$jscomp$4 = propValue$jscomp$7;
                  break;
                case "data":
                  var sanitizedValue = sanitizeURL("" + propValue$jscomp$7);
                  if ("" === sanitizedValue) break;
                  target$jscomp$0.push(
                    " ",
                    "data",
                    '="',
                    escapeTextForBrowser(sanitizedValue),
                    '"',
                  );
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$7, propValue$jscomp$7);
              }
          }
        target$jscomp$0.push(">");
        pushInnerHTML(target$jscomp$0, innerHTML$jscomp$4, children$jscomp$5);
        if ("string" === typeof children$jscomp$5) {
          target$jscomp$0.push(escapeTextForBrowser(children$jscomp$5));
          var JSCompiler_inline_result$jscomp$2 = null;
        } else JSCompiler_inline_result$jscomp$2 = children$jscomp$5;
        return JSCompiler_inline_result$jscomp$2;
      case "title":
        var noscriptTagInScope = formatContext.tagScope & 1,
          isFallback = formatContext.tagScope & 4;
        if (4 === formatContext.insertionMode || noscriptTagInScope || null != props.itemProp)
          var JSCompiler_inline_result$jscomp$3 = pushTitleImpl(target$jscomp$0, props);
        else
          isFallback
            ? (JSCompiler_inline_result$jscomp$3 = null)
            : (pushTitleImpl(renderState.hoistableChunks, props),
              (JSCompiler_inline_result$jscomp$3 = void 0));
        return JSCompiler_inline_result$jscomp$3;
      case "link":
        var noscriptTagInScope$jscomp$0 = formatContext.tagScope & 1,
          isFallback$jscomp$0 = formatContext.tagScope & 4,
          rel = props.rel,
          href = props.href,
          precedence = props.precedence;
        if (
          4 === formatContext.insertionMode ||
          noscriptTagInScope$jscomp$0 ||
          null != props.itemProp ||
          "string" !== typeof rel ||
          "string" !== typeof href ||
          "" === href
        ) {
          pushLinkImpl(target$jscomp$0, props);
          var JSCompiler_inline_result$jscomp$4 = null;
        } else if ("stylesheet" === props.rel)
          if (
            "string" !== typeof precedence ||
            null != props.disabled ||
            props.onLoad ||
            props.onError
          )
            JSCompiler_inline_result$jscomp$4 = pushLinkImpl(target$jscomp$0, props);
          else {
            var styleQueue = renderState.styles.get(precedence),
              resourceState = resumableState.styleResources.hasOwnProperty(href)
                ? resumableState.styleResources[href]
                : void 0;
            if (null !== resourceState) {
              resumableState.styleResources[href] = null;
              styleQueue ||
                ((styleQueue = {
                  precedence: escapeTextForBrowser(precedence),
                  rules: [],
                  hrefs: [],
                  sheets: /* @__PURE__ */ new Map(),
                }),
                renderState.styles.set(precedence, styleQueue));
              var resource = {
                state: 0,
                props: assign({}, props, {
                  "data-precedence": props.precedence,
                  precedence: null,
                }),
              };
              if (resourceState) {
                2 === resourceState.length &&
                  adoptPreloadCredentials(resource.props, resourceState);
                var preloadResource = renderState.preloads.stylesheets.get(href);
                preloadResource && 0 < preloadResource.length
                  ? (preloadResource.length = 0)
                  : (resource.state = 1);
              }
              styleQueue.sheets.set(href, resource);
              hoistableState && hoistableState.stylesheets.add(resource);
            } else if (styleQueue) {
              var resource$9 = styleQueue.sheets.get(href);
              resource$9 && hoistableState && hoistableState.stylesheets.add(resource$9);
            }
            textEmbedded && target$jscomp$0.push("<!-- -->");
            JSCompiler_inline_result$jscomp$4 = null;
          }
        else
          props.onLoad || props.onError
            ? (JSCompiler_inline_result$jscomp$4 = pushLinkImpl(target$jscomp$0, props))
            : (textEmbedded && target$jscomp$0.push("<!-- -->"),
              (JSCompiler_inline_result$jscomp$4 = isFallback$jscomp$0
                ? null
                : pushLinkImpl(renderState.hoistableChunks, props)));
        return JSCompiler_inline_result$jscomp$4;
      case "script":
        var noscriptTagInScope$jscomp$1 = formatContext.tagScope & 1,
          asyncProp = props.async;
        if (
          "string" !== typeof props.src ||
          !props.src ||
          !asyncProp ||
          "function" === typeof asyncProp ||
          "symbol" === typeof asyncProp ||
          props.onLoad ||
          props.onError ||
          4 === formatContext.insertionMode ||
          noscriptTagInScope$jscomp$1 ||
          null != props.itemProp
        )
          var JSCompiler_inline_result$jscomp$5 = pushScriptImpl(target$jscomp$0, props);
        else {
          var key = props.src;
          if ("module" === props.type) {
            var resources = resumableState.moduleScriptResources;
            var preloads = renderState.preloads.moduleScripts;
          } else
            ((resources = resumableState.scriptResources),
              (preloads = renderState.preloads.scripts));
          var resourceState$jscomp$0 = resources.hasOwnProperty(key) ? resources[key] : void 0;
          if (null !== resourceState$jscomp$0) {
            resources[key] = null;
            var scriptProps = props;
            if (resourceState$jscomp$0) {
              2 === resourceState$jscomp$0.length &&
                ((scriptProps = assign({}, props)),
                adoptPreloadCredentials(scriptProps, resourceState$jscomp$0));
              var preloadResource$jscomp$0 = preloads.get(key);
              preloadResource$jscomp$0 && (preloadResource$jscomp$0.length = 0);
            }
            var resource$jscomp$0 = [];
            renderState.scripts.add(resource$jscomp$0);
            pushScriptImpl(resource$jscomp$0, scriptProps);
          }
          textEmbedded && target$jscomp$0.push("<!-- -->");
          JSCompiler_inline_result$jscomp$5 = null;
        }
        return JSCompiler_inline_result$jscomp$5;
      case "style":
        var noscriptTagInScope$jscomp$2 = formatContext.tagScope & 1,
          precedence$jscomp$0 = props.precedence,
          href$jscomp$0 = props.href,
          nonce = props.nonce;
        if (
          4 === formatContext.insertionMode ||
          noscriptTagInScope$jscomp$2 ||
          null != props.itemProp ||
          "string" !== typeof precedence$jscomp$0 ||
          "string" !== typeof href$jscomp$0 ||
          "" === href$jscomp$0
        ) {
          target$jscomp$0.push(startChunkForTag("style"));
          var children$jscomp$6 = null,
            innerHTML$jscomp$5 = null,
            propKey$jscomp$8;
          for (propKey$jscomp$8 in props)
            if (hasOwnProperty.call(props, propKey$jscomp$8)) {
              var propValue$jscomp$8 = props[propKey$jscomp$8];
              if (null != propValue$jscomp$8)
                switch (propKey$jscomp$8) {
                  case "children":
                    children$jscomp$6 = propValue$jscomp$8;
                    break;
                  case "dangerouslySetInnerHTML":
                    innerHTML$jscomp$5 = propValue$jscomp$8;
                    break;
                  default:
                    pushAttribute(target$jscomp$0, propKey$jscomp$8, propValue$jscomp$8);
                }
            }
          target$jscomp$0.push(">");
          var child = Array.isArray(children$jscomp$6)
            ? 2 > children$jscomp$6.length
              ? children$jscomp$6[0]
              : null
            : children$jscomp$6;
          "function" !== typeof child &&
            "symbol" !== typeof child &&
            null !== child &&
            void 0 !== child &&
            target$jscomp$0.push(("" + child).replace(styleRegex, styleReplacer));
          pushInnerHTML(target$jscomp$0, innerHTML$jscomp$5, children$jscomp$6);
          target$jscomp$0.push(endChunkForTag("style"));
          var JSCompiler_inline_result$jscomp$6 = null;
        } else {
          var styleQueue$jscomp$0 = renderState.styles.get(precedence$jscomp$0);
          if (
            null !==
            (resumableState.styleResources.hasOwnProperty(href$jscomp$0)
              ? resumableState.styleResources[href$jscomp$0]
              : void 0)
          ) {
            resumableState.styleResources[href$jscomp$0] = null;
            styleQueue$jscomp$0 ||
              ((styleQueue$jscomp$0 = {
                precedence: escapeTextForBrowser(precedence$jscomp$0),
                rules: [],
                hrefs: [],
                sheets: /* @__PURE__ */ new Map(),
              }),
              renderState.styles.set(precedence$jscomp$0, styleQueue$jscomp$0));
            var nonceStyle = renderState.nonce.style;
            if (!nonceStyle || nonceStyle === nonce) {
              styleQueue$jscomp$0.hrefs.push(escapeTextForBrowser(href$jscomp$0));
              var target = styleQueue$jscomp$0.rules,
                children$jscomp$7 = null,
                innerHTML$jscomp$6 = null,
                propKey$jscomp$9;
              for (propKey$jscomp$9 in props)
                if (hasOwnProperty.call(props, propKey$jscomp$9)) {
                  var propValue$jscomp$9 = props[propKey$jscomp$9];
                  if (null != propValue$jscomp$9)
                    switch (propKey$jscomp$9) {
                      case "children":
                        children$jscomp$7 = propValue$jscomp$9;
                        break;
                      case "dangerouslySetInnerHTML":
                        innerHTML$jscomp$6 = propValue$jscomp$9;
                    }
                }
              var child$jscomp$0 = Array.isArray(children$jscomp$7)
                ? 2 > children$jscomp$7.length
                  ? children$jscomp$7[0]
                  : null
                : children$jscomp$7;
              "function" !== typeof child$jscomp$0 &&
                "symbol" !== typeof child$jscomp$0 &&
                null !== child$jscomp$0 &&
                void 0 !== child$jscomp$0 &&
                target.push(("" + child$jscomp$0).replace(styleRegex, styleReplacer));
              pushInnerHTML(target, innerHTML$jscomp$6, children$jscomp$7);
            }
          }
          styleQueue$jscomp$0 && hoistableState && hoistableState.styles.add(styleQueue$jscomp$0);
          textEmbedded && target$jscomp$0.push("<!-- -->");
          JSCompiler_inline_result$jscomp$6 = void 0;
        }
        return JSCompiler_inline_result$jscomp$6;
      case "meta":
        var noscriptTagInScope$jscomp$3 = formatContext.tagScope & 1,
          isFallback$jscomp$1 = formatContext.tagScope & 4;
        if (
          4 === formatContext.insertionMode ||
          noscriptTagInScope$jscomp$3 ||
          null != props.itemProp
        )
          var JSCompiler_inline_result$jscomp$7 = pushSelfClosing(target$jscomp$0, props, "meta");
        else
          (textEmbedded && target$jscomp$0.push("<!-- -->"),
            (JSCompiler_inline_result$jscomp$7 = isFallback$jscomp$1
              ? null
              : "string" === typeof props.charSet
                ? pushSelfClosing(renderState.charsetChunks, props, "meta")
                : "viewport" === props.name
                  ? pushSelfClosing(renderState.viewportChunks, props, "meta")
                  : pushSelfClosing(renderState.hoistableChunks, props, "meta")));
        return JSCompiler_inline_result$jscomp$7;
      case "listing":
      case "pre":
        target$jscomp$0.push(startChunkForTag(type));
        var children$jscomp$8 = null,
          innerHTML$jscomp$7 = null,
          propKey$jscomp$10;
        for (propKey$jscomp$10 in props)
          if (hasOwnProperty.call(props, propKey$jscomp$10)) {
            var propValue$jscomp$10 = props[propKey$jscomp$10];
            if (null != propValue$jscomp$10)
              switch (propKey$jscomp$10) {
                case "children":
                  children$jscomp$8 = propValue$jscomp$10;
                  break;
                case "dangerouslySetInnerHTML":
                  innerHTML$jscomp$7 = propValue$jscomp$10;
                  break;
                default:
                  pushAttribute(target$jscomp$0, propKey$jscomp$10, propValue$jscomp$10);
              }
          }
        target$jscomp$0.push(">");
        if (null != innerHTML$jscomp$7) {
          if (null != children$jscomp$8) throw Error(formatProdErrorMessage(60));
          if ("object" !== typeof innerHTML$jscomp$7 || !("__html" in innerHTML$jscomp$7))
            throw Error(formatProdErrorMessage(61));
          var html = innerHTML$jscomp$7.__html;
          null !== html &&
            void 0 !== html &&
            ("string" === typeof html && 0 < html.length && "\n" === html[0]
              ? target$jscomp$0.push("\n", html)
              : target$jscomp$0.push("" + html));
        }
        "string" === typeof children$jscomp$8 &&
          "\n" === children$jscomp$8[0] &&
          target$jscomp$0.push("\n");
        return children$jscomp$8;
      case "img":
        var pictureOrNoScriptTagInScope = formatContext.tagScope & 3,
          src = props.src,
          srcSet = props.srcSet;
        if (
          !(
            "lazy" === props.loading ||
            (!src && !srcSet) ||
            ("string" !== typeof src && null != src) ||
            ("string" !== typeof srcSet && null != srcSet) ||
            "low" === props.fetchPriority ||
            pictureOrNoScriptTagInScope
          ) &&
          ("string" !== typeof src ||
            ":" !== src[4] ||
            ("d" !== src[0] && "D" !== src[0]) ||
            ("a" !== src[1] && "A" !== src[1]) ||
            ("t" !== src[2] && "T" !== src[2]) ||
            ("a" !== src[3] && "A" !== src[3])) &&
          ("string" !== typeof srcSet ||
            ":" !== srcSet[4] ||
            ("d" !== srcSet[0] && "D" !== srcSet[0]) ||
            ("a" !== srcSet[1] && "A" !== srcSet[1]) ||
            ("t" !== srcSet[2] && "T" !== srcSet[2]) ||
            ("a" !== srcSet[3] && "A" !== srcSet[3]))
        ) {
          null !== hoistableState &&
            formatContext.tagScope & 64 &&
            (hoistableState.suspenseyImages = true);
          var sizes = "string" === typeof props.sizes ? props.sizes : void 0,
            key$jscomp$0 = srcSet ? srcSet + "\n" + (sizes || "") : src,
            promotablePreloads = renderState.preloads.images,
            resource$jscomp$1 = promotablePreloads.get(key$jscomp$0);
          if (resource$jscomp$1) {
            if ("high" === props.fetchPriority || 10 > renderState.highImagePreloads.size)
              (promotablePreloads.delete(key$jscomp$0),
                renderState.highImagePreloads.add(resource$jscomp$1));
          } else if (!resumableState.imageResources.hasOwnProperty(key$jscomp$0)) {
            resumableState.imageResources[key$jscomp$0] = PRELOAD_NO_CREDS;
            var input = props.crossOrigin;
            var JSCompiler_inline_result$jscomp$8 =
              "string" === typeof input ? ("use-credentials" === input ? input : "") : void 0;
            var headers = renderState.headers,
              header;
            headers &&
            0 < headers.remainingCapacity &&
            "string" !== typeof props.srcSet &&
            ("high" === props.fetchPriority || 500 > headers.highImagePreloads.length) &&
            ((header = getPreloadAsHeader(src, "image", {
              imageSrcSet: props.srcSet,
              imageSizes: props.sizes,
              crossOrigin: JSCompiler_inline_result$jscomp$8,
              integrity: props.integrity,
              nonce: props.nonce,
              type: props.type,
              fetchPriority: props.fetchPriority,
              referrerPolicy: props.refererPolicy,
            })),
            0 <= (headers.remainingCapacity -= header.length + 2))
              ? ((renderState.resets.image[key$jscomp$0] = PRELOAD_NO_CREDS),
                headers.highImagePreloads && (headers.highImagePreloads += ", "),
                (headers.highImagePreloads += header))
              : ((resource$jscomp$1 = []),
                pushLinkImpl(resource$jscomp$1, {
                  rel: "preload",
                  as: "image",
                  href: srcSet ? void 0 : src,
                  imageSrcSet: srcSet,
                  imageSizes: sizes,
                  crossOrigin: JSCompiler_inline_result$jscomp$8,
                  integrity: props.integrity,
                  type: props.type,
                  fetchPriority: props.fetchPriority,
                  referrerPolicy: props.referrerPolicy,
                }),
                "high" === props.fetchPriority || 10 > renderState.highImagePreloads.size
                  ? renderState.highImagePreloads.add(resource$jscomp$1)
                  : (renderState.bulkPreloads.add(resource$jscomp$1),
                    promotablePreloads.set(key$jscomp$0, resource$jscomp$1)));
          }
        }
        return pushSelfClosing(target$jscomp$0, props, "img");
      case "base":
      case "area":
      case "br":
      case "col":
      case "embed":
      case "hr":
      case "keygen":
      case "param":
      case "source":
      case "track":
      case "wbr":
        return pushSelfClosing(target$jscomp$0, props, type);
      case "annotation-xml":
      case "color-profile":
      case "font-face":
      case "font-face-src":
      case "font-face-uri":
      case "font-face-format":
      case "font-face-name":
      case "missing-glyph":
        break;
      case "head":
        if (2 > formatContext.insertionMode) {
          var preamble = preambleState || renderState.preamble;
          if (preamble.headChunks) throw Error(formatProdErrorMessage(545, "`<head>`"));
          null !== preambleState && target$jscomp$0.push("<!--head-->");
          preamble.headChunks = [];
          var JSCompiler_inline_result$jscomp$9 = pushStartSingletonElement(
            preamble.headChunks,
            props,
            "head",
          );
        } else
          JSCompiler_inline_result$jscomp$9 = pushStartGenericElement(
            target$jscomp$0,
            props,
            "head",
          );
        return JSCompiler_inline_result$jscomp$9;
      case "body":
        if (2 > formatContext.insertionMode) {
          var preamble$jscomp$0 = preambleState || renderState.preamble;
          if (preamble$jscomp$0.bodyChunks) throw Error(formatProdErrorMessage(545, "`<body>`"));
          null !== preambleState && target$jscomp$0.push("<!--body-->");
          preamble$jscomp$0.bodyChunks = [];
          var JSCompiler_inline_result$jscomp$10 = pushStartSingletonElement(
            preamble$jscomp$0.bodyChunks,
            props,
            "body",
          );
        } else
          JSCompiler_inline_result$jscomp$10 = pushStartGenericElement(
            target$jscomp$0,
            props,
            "body",
          );
        return JSCompiler_inline_result$jscomp$10;
      case "html":
        if (0 === formatContext.insertionMode) {
          var preamble$jscomp$1 = preambleState || renderState.preamble;
          if (preamble$jscomp$1.htmlChunks) throw Error(formatProdErrorMessage(545, "`<html>`"));
          null !== preambleState && target$jscomp$0.push("<!--html-->");
          preamble$jscomp$1.htmlChunks = [""];
          var JSCompiler_inline_result$jscomp$11 = pushStartSingletonElement(
            preamble$jscomp$1.htmlChunks,
            props,
            "html",
          );
        } else
          JSCompiler_inline_result$jscomp$11 = pushStartGenericElement(
            target$jscomp$0,
            props,
            "html",
          );
        return JSCompiler_inline_result$jscomp$11;
      default:
        if (-1 !== type.indexOf("-")) {
          target$jscomp$0.push(startChunkForTag(type));
          var children$jscomp$9 = null,
            innerHTML$jscomp$8 = null,
            propKey$jscomp$11;
          for (propKey$jscomp$11 in props)
            if (hasOwnProperty.call(props, propKey$jscomp$11)) {
              var propValue$jscomp$11 = props[propKey$jscomp$11];
              if (null != propValue$jscomp$11) {
                var attributeName = propKey$jscomp$11;
                switch (propKey$jscomp$11) {
                  case "children":
                    children$jscomp$9 = propValue$jscomp$11;
                    break;
                  case "dangerouslySetInnerHTML":
                    innerHTML$jscomp$8 = propValue$jscomp$11;
                    break;
                  case "style":
                    pushStyleAttribute(target$jscomp$0, propValue$jscomp$11);
                    break;
                  case "suppressContentEditableWarning":
                  case "suppressHydrationWarning":
                  case "ref":
                    break;
                  case "className":
                    attributeName = "class";
                  default:
                    if (
                      isAttributeNameSafe(propKey$jscomp$11) &&
                      "function" !== typeof propValue$jscomp$11 &&
                      "symbol" !== typeof propValue$jscomp$11 &&
                      false !== propValue$jscomp$11
                    ) {
                      if (true === propValue$jscomp$11) propValue$jscomp$11 = "";
                      else if ("object" === typeof propValue$jscomp$11) continue;
                      target$jscomp$0.push(
                        " ",
                        attributeName,
                        '="',
                        escapeTextForBrowser(propValue$jscomp$11),
                        '"',
                      );
                    }
                }
              }
            }
          target$jscomp$0.push(">");
          pushInnerHTML(target$jscomp$0, innerHTML$jscomp$8, children$jscomp$9);
          return children$jscomp$9;
        }
    }
    return pushStartGenericElement(target$jscomp$0, props, type);
  }
  var endTagCache = /* @__PURE__ */ new Map();
  function endChunkForTag(tag) {
    var chunk = endTagCache.get(tag);
    void 0 === chunk && ((chunk = "</" + tag + ">"), endTagCache.set(tag, chunk));
    return chunk;
  }
  function hoistPreambleState(renderState, preambleState) {
    renderState = renderState.preamble;
    null === renderState.htmlChunks &&
      preambleState.htmlChunks &&
      (renderState.htmlChunks = preambleState.htmlChunks);
    null === renderState.headChunks &&
      preambleState.headChunks &&
      (renderState.headChunks = preambleState.headChunks);
    null === renderState.bodyChunks &&
      preambleState.bodyChunks &&
      (renderState.bodyChunks = preambleState.bodyChunks);
  }
  function writeBootstrap(destination, renderState) {
    renderState = renderState.bootstrapChunks;
    for (var i = 0; i < renderState.length - 1; i++) destination.push(renderState[i]);
    return i < renderState.length
      ? ((i = renderState[i]), (renderState.length = 0), destination.push(i))
      : true;
  }
  function writeStartPendingSuspenseBoundary(destination, renderState, id) {
    destination.push('<!--$?--><template id="');
    if (null === id) throw Error(formatProdErrorMessage(395));
    destination.push(renderState.boundaryPrefix);
    renderState = id.toString(16);
    destination.push(renderState);
    return destination.push('"></template>');
  }
  function writeStartSegment(destination, renderState, formatContext, id) {
    switch (formatContext.insertionMode) {
      case 0:
      case 1:
      case 3:
      case 2:
        return (
          destination.push('<div hidden id="'),
          destination.push(renderState.segmentPrefix),
          (renderState = id.toString(16)),
          destination.push(renderState),
          destination.push('">')
        );
      case 4:
        return (
          destination.push('<svg aria-hidden="true" style="display:none" id="'),
          destination.push(renderState.segmentPrefix),
          (renderState = id.toString(16)),
          destination.push(renderState),
          destination.push('">')
        );
      case 5:
        return (
          destination.push('<math aria-hidden="true" style="display:none" id="'),
          destination.push(renderState.segmentPrefix),
          (renderState = id.toString(16)),
          destination.push(renderState),
          destination.push('">')
        );
      case 6:
        return (
          destination.push('<table hidden id="'),
          destination.push(renderState.segmentPrefix),
          (renderState = id.toString(16)),
          destination.push(renderState),
          destination.push('">')
        );
      case 7:
        return (
          destination.push('<table hidden><tbody id="'),
          destination.push(renderState.segmentPrefix),
          (renderState = id.toString(16)),
          destination.push(renderState),
          destination.push('">')
        );
      case 8:
        return (
          destination.push('<table hidden><tr id="'),
          destination.push(renderState.segmentPrefix),
          (renderState = id.toString(16)),
          destination.push(renderState),
          destination.push('">')
        );
      case 9:
        return (
          destination.push('<table hidden><colgroup id="'),
          destination.push(renderState.segmentPrefix),
          (renderState = id.toString(16)),
          destination.push(renderState),
          destination.push('">')
        );
      default:
        throw Error(formatProdErrorMessage(397));
    }
  }
  function writeEndSegment(destination, formatContext) {
    switch (formatContext.insertionMode) {
      case 0:
      case 1:
      case 3:
      case 2:
        return destination.push("</div>");
      case 4:
        return destination.push("</svg>");
      case 5:
        return destination.push("</math>");
      case 6:
        return destination.push("</table>");
      case 7:
        return destination.push("</tbody></table>");
      case 8:
        return destination.push("</tr></table>");
      case 9:
        return destination.push("</colgroup></table>");
      default:
        throw Error(formatProdErrorMessage(397));
    }
  }
  var regexForJSStringsInInstructionScripts = /[<\u2028\u2029]/g;
  function escapeJSStringsForInstructionScripts(input) {
    return JSON.stringify(input).replace(regexForJSStringsInInstructionScripts, function (match) {
      switch (match) {
        case "<":
          return "\\u003c";
        case "\u2028":
          return "\\u2028";
        case "\u2029":
          return "\\u2029";
        default:
          throw Error(
            "escapeJSStringsForInstructionScripts encountered a match it does not know how to replace. this means the match regex and the replacement characters are no longer in sync. This is a bug in React",
          );
      }
    });
  }
  var regexForJSStringsInScripts = /[&><\u2028\u2029]/g;
  function escapeJSObjectForInstructionScripts(input) {
    return JSON.stringify(input).replace(regexForJSStringsInScripts, function (match) {
      switch (match) {
        case "&":
          return "\\u0026";
        case ">":
          return "\\u003e";
        case "<":
          return "\\u003c";
        case "\u2028":
          return "\\u2028";
        case "\u2029":
          return "\\u2029";
        default:
          throw Error(
            "escapeJSObjectForInstructionScripts encountered a match it does not know how to replace. this means the match regex and the replacement characters are no longer in sync. This is a bug in React",
          );
      }
    });
  }
  var currentlyRenderingBoundaryHasStylesToHoist = false,
    destinationHasCapacity = true;
  function flushStyleTagsLateForBoundary(styleQueue) {
    var rules = styleQueue.rules,
      hrefs = styleQueue.hrefs,
      i = 0;
    if (hrefs.length) {
      this.push(currentlyFlushingRenderState.startInlineStyle);
      this.push(' media="not all" data-precedence="');
      this.push(styleQueue.precedence);
      for (this.push('" data-href="'); i < hrefs.length - 1; i++)
        (this.push(hrefs[i]), this.push(" "));
      this.push(hrefs[i]);
      this.push('">');
      for (i = 0; i < rules.length; i++) this.push(rules[i]);
      destinationHasCapacity = this.push("</style>");
      currentlyRenderingBoundaryHasStylesToHoist = true;
      rules.length = 0;
      hrefs.length = 0;
    }
  }
  function hasStylesToHoist(stylesheet) {
    return 2 !== stylesheet.state ? (currentlyRenderingBoundaryHasStylesToHoist = true) : false;
  }
  function writeHoistablesForBoundary(destination, hoistableState, renderState) {
    currentlyRenderingBoundaryHasStylesToHoist = false;
    destinationHasCapacity = true;
    currentlyFlushingRenderState = renderState;
    hoistableState.styles.forEach(flushStyleTagsLateForBoundary, destination);
    currentlyFlushingRenderState = null;
    hoistableState.stylesheets.forEach(hasStylesToHoist);
    currentlyRenderingBoundaryHasStylesToHoist && (renderState.stylesToHoist = true);
    return destinationHasCapacity;
  }
  function flushResource(resource) {
    for (var i = 0; i < resource.length; i++) this.push(resource[i]);
    resource.length = 0;
  }
  var stylesheetFlushingQueue = [];
  function flushStyleInPreamble(stylesheet) {
    pushLinkImpl(stylesheetFlushingQueue, stylesheet.props);
    for (var i = 0; i < stylesheetFlushingQueue.length; i++) this.push(stylesheetFlushingQueue[i]);
    stylesheetFlushingQueue.length = 0;
    stylesheet.state = 2;
  }
  function flushStylesInPreamble(styleQueue) {
    var hasStylesheets = 0 < styleQueue.sheets.size;
    styleQueue.sheets.forEach(flushStyleInPreamble, this);
    styleQueue.sheets.clear();
    var rules = styleQueue.rules,
      hrefs = styleQueue.hrefs;
    if (!hasStylesheets || hrefs.length) {
      this.push(currentlyFlushingRenderState.startInlineStyle);
      this.push(' data-precedence="');
      this.push(styleQueue.precedence);
      styleQueue = 0;
      if (hrefs.length) {
        for (this.push('" data-href="'); styleQueue < hrefs.length - 1; styleQueue++)
          (this.push(hrefs[styleQueue]), this.push(" "));
        this.push(hrefs[styleQueue]);
      }
      this.push('">');
      for (styleQueue = 0; styleQueue < rules.length; styleQueue++) this.push(rules[styleQueue]);
      this.push("</style>");
      rules.length = 0;
      hrefs.length = 0;
    }
  }
  function preloadLateStyle(stylesheet) {
    if (0 === stylesheet.state) {
      stylesheet.state = 1;
      var props = stylesheet.props;
      pushLinkImpl(stylesheetFlushingQueue, {
        rel: "preload",
        as: "style",
        href: stylesheet.props.href,
        crossOrigin: props.crossOrigin,
        fetchPriority: props.fetchPriority,
        integrity: props.integrity,
        media: props.media,
        hrefLang: props.hrefLang,
        referrerPolicy: props.referrerPolicy,
      });
      for (stylesheet = 0; stylesheet < stylesheetFlushingQueue.length; stylesheet++)
        this.push(stylesheetFlushingQueue[stylesheet]);
      stylesheetFlushingQueue.length = 0;
    }
  }
  function preloadLateStyles(styleQueue) {
    styleQueue.sheets.forEach(preloadLateStyle, this);
    styleQueue.sheets.clear();
  }
  function pushCompletedShellIdAttribute(target, resumableState) {
    0 === (resumableState.instructions & 32) &&
      ((resumableState.instructions |= 32),
      target.push(' id="', escapeTextForBrowser("_" + resumableState.idPrefix + "R_"), '"'));
  }
  function writeStyleResourceDependenciesInJS(destination, hoistableState) {
    destination.push("[");
    var nextArrayOpenBrackChunk = "[";
    hoistableState.stylesheets.forEach(function (resource) {
      if (2 !== resource.state)
        if (3 === resource.state)
          (destination.push(nextArrayOpenBrackChunk),
            (resource = escapeJSObjectForInstructionScripts("" + resource.props.href)),
            destination.push(resource),
            destination.push("]"),
            (nextArrayOpenBrackChunk = ",["));
        else {
          destination.push(nextArrayOpenBrackChunk);
          var precedence = resource.props["data-precedence"],
            props = resource.props,
            coercedHref = sanitizeURL("" + resource.props.href);
          coercedHref = escapeJSObjectForInstructionScripts(coercedHref);
          destination.push(coercedHref);
          precedence = "" + precedence;
          destination.push(",");
          precedence = escapeJSObjectForInstructionScripts(precedence);
          destination.push(precedence);
          for (var propKey in props)
            if (
              hasOwnProperty.call(props, propKey) &&
              ((precedence = props[propKey]), null != precedence)
            )
              switch (propKey) {
                case "href":
                case "rel":
                case "precedence":
                case "data-precedence":
                  break;
                case "children":
                case "dangerouslySetInnerHTML":
                  throw Error(formatProdErrorMessage(399, "link"));
                default:
                  writeStyleResourceAttributeInJS(destination, propKey, precedence);
              }
          destination.push("]");
          nextArrayOpenBrackChunk = ",[";
          resource.state = 3;
        }
    });
    destination.push("]");
  }
  function writeStyleResourceAttributeInJS(destination, name, value) {
    var attributeName = name.toLowerCase();
    switch (typeof value) {
      case "function":
      case "symbol":
        return;
    }
    switch (name) {
      case "innerHTML":
      case "dangerouslySetInnerHTML":
      case "suppressContentEditableWarning":
      case "suppressHydrationWarning":
      case "style":
      case "ref":
        return;
      case "className":
        attributeName = "class";
        name = "" + value;
        break;
      case "hidden":
        if (false === value) return;
        name = "";
        break;
      case "src":
      case "href":
        value = sanitizeURL(value);
        name = "" + value;
        break;
      default:
        if (
          (2 < name.length &&
            ("o" === name[0] || "O" === name[0]) &&
            ("n" === name[1] || "N" === name[1])) ||
          !isAttributeNameSafe(name)
        )
          return;
        name = "" + value;
    }
    destination.push(",");
    attributeName = escapeJSObjectForInstructionScripts(attributeName);
    destination.push(attributeName);
    destination.push(",");
    attributeName = escapeJSObjectForInstructionScripts(name);
    destination.push(attributeName);
  }
  function createHoistableState() {
    return {
      styles: /* @__PURE__ */ new Set(),
      stylesheets: /* @__PURE__ */ new Set(),
      suspenseyImages: false,
    };
  }
  function prefetchDNS(href) {
    var request = currentRequest ? currentRequest : null;
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if ("string" === typeof href && href) {
        if (!resumableState.dnsResources.hasOwnProperty(href)) {
          resumableState.dnsResources[href] = null;
          resumableState = renderState.headers;
          var header, JSCompiler_temp;
          if ((JSCompiler_temp = resumableState && 0 < resumableState.remainingCapacity))
            JSCompiler_temp =
              ((header =
                "<" +
                ("" + href).replace(
                  regexForHrefInLinkHeaderURLContext,
                  escapeHrefForLinkHeaderURLContextReplacer,
                ) +
                ">; rel=dns-prefetch"),
              0 <= (resumableState.remainingCapacity -= header.length + 2));
          JSCompiler_temp
            ? ((renderState.resets.dns[href] = null),
              resumableState.preconnects && (resumableState.preconnects += ", "),
              (resumableState.preconnects += header))
            : ((header = []),
              pushLinkImpl(header, { href, rel: "dns-prefetch" }),
              renderState.preconnects.add(header));
        }
        enqueueFlush(request);
      }
    } else previousDispatcher.D(href);
  }
  function preconnect(href, crossOrigin) {
    var request = currentRequest ? currentRequest : null;
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if ("string" === typeof href && href) {
        var bucket =
          "use-credentials" === crossOrigin
            ? "credentials"
            : "string" === typeof crossOrigin
              ? "anonymous"
              : "default";
        if (!resumableState.connectResources[bucket].hasOwnProperty(href)) {
          resumableState.connectResources[bucket][href] = null;
          resumableState = renderState.headers;
          var header, JSCompiler_temp;
          if ((JSCompiler_temp = resumableState && 0 < resumableState.remainingCapacity)) {
            JSCompiler_temp =
              "<" +
              ("" + href).replace(
                regexForHrefInLinkHeaderURLContext,
                escapeHrefForLinkHeaderURLContextReplacer,
              ) +
              ">; rel=preconnect";
            if ("string" === typeof crossOrigin) {
              var escapedCrossOrigin = ("" + crossOrigin).replace(
                regexForLinkHeaderQuotedParamValueContext,
                escapeStringForLinkHeaderQuotedParamValueContextReplacer,
              );
              JSCompiler_temp += '; crossorigin="' + escapedCrossOrigin + '"';
            }
            JSCompiler_temp =
              ((header = JSCompiler_temp),
              0 <= (resumableState.remainingCapacity -= header.length + 2));
          }
          JSCompiler_temp
            ? ((renderState.resets.connect[bucket][href] = null),
              resumableState.preconnects && (resumableState.preconnects += ", "),
              (resumableState.preconnects += header))
            : ((bucket = []),
              pushLinkImpl(bucket, {
                rel: "preconnect",
                href,
                crossOrigin,
              }),
              renderState.preconnects.add(bucket));
        }
        enqueueFlush(request);
      }
    } else previousDispatcher.C(href, crossOrigin);
  }
  function preload(href, as, options) {
    var request = currentRequest ? currentRequest : null;
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if (as && href) {
        switch (as) {
          case "image":
            if (options) {
              var imageSrcSet = options.imageSrcSet;
              var imageSizes = options.imageSizes;
              var fetchPriority = options.fetchPriority;
            }
            var key = imageSrcSet ? imageSrcSet + "\n" + (imageSizes || "") : href;
            if (resumableState.imageResources.hasOwnProperty(key)) return;
            resumableState.imageResources[key] = PRELOAD_NO_CREDS;
            resumableState = renderState.headers;
            var header;
            resumableState &&
            0 < resumableState.remainingCapacity &&
            "string" !== typeof imageSrcSet &&
            "high" === fetchPriority &&
            ((header = getPreloadAsHeader(href, as, options)),
            0 <= (resumableState.remainingCapacity -= header.length + 2))
              ? ((renderState.resets.image[key] = PRELOAD_NO_CREDS),
                resumableState.highImagePreloads && (resumableState.highImagePreloads += ", "),
                (resumableState.highImagePreloads += header))
              : ((resumableState = []),
                pushLinkImpl(
                  resumableState,
                  assign({ rel: "preload", href: imageSrcSet ? void 0 : href, as }, options),
                ),
                "high" === fetchPriority
                  ? renderState.highImagePreloads.add(resumableState)
                  : (renderState.bulkPreloads.add(resumableState),
                    renderState.preloads.images.set(key, resumableState)));
            break;
          case "style":
            if (resumableState.styleResources.hasOwnProperty(href)) return;
            imageSrcSet = [];
            pushLinkImpl(imageSrcSet, assign({ rel: "preload", href, as }, options));
            resumableState.styleResources[href] =
              !options ||
              ("string" !== typeof options.crossOrigin && "string" !== typeof options.integrity)
                ? PRELOAD_NO_CREDS
                : [options.crossOrigin, options.integrity];
            renderState.preloads.stylesheets.set(href, imageSrcSet);
            renderState.bulkPreloads.add(imageSrcSet);
            break;
          case "script":
            if (resumableState.scriptResources.hasOwnProperty(href)) return;
            imageSrcSet = [];
            renderState.preloads.scripts.set(href, imageSrcSet);
            renderState.bulkPreloads.add(imageSrcSet);
            pushLinkImpl(imageSrcSet, assign({ rel: "preload", href, as }, options));
            resumableState.scriptResources[href] =
              !options ||
              ("string" !== typeof options.crossOrigin && "string" !== typeof options.integrity)
                ? PRELOAD_NO_CREDS
                : [options.crossOrigin, options.integrity];
            break;
          default:
            if (resumableState.unknownResources.hasOwnProperty(as)) {
              if (
                ((imageSrcSet = resumableState.unknownResources[as]),
                imageSrcSet.hasOwnProperty(href))
              )
                return;
            } else ((imageSrcSet = {}), (resumableState.unknownResources[as] = imageSrcSet));
            imageSrcSet[href] = PRELOAD_NO_CREDS;
            if (
              (resumableState = renderState.headers) &&
              0 < resumableState.remainingCapacity &&
              "font" === as &&
              ((key = getPreloadAsHeader(href, as, options)),
              0 <= (resumableState.remainingCapacity -= key.length + 2))
            )
              ((renderState.resets.font[href] = PRELOAD_NO_CREDS),
                resumableState.fontPreloads && (resumableState.fontPreloads += ", "),
                (resumableState.fontPreloads += key));
            else
              switch (
                ((resumableState = []),
                (href = assign({ rel: "preload", href, as }, options)),
                pushLinkImpl(resumableState, href),
                as)
              ) {
                case "font":
                  renderState.fontPreloads.add(resumableState);
                  break;
                default:
                  renderState.bulkPreloads.add(resumableState);
              }
        }
        enqueueFlush(request);
      }
    } else previousDispatcher.L(href, as, options);
  }
  function preloadModule(href, options) {
    var request = currentRequest ? currentRequest : null;
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if (href) {
        var as = options && "string" === typeof options.as ? options.as : "script";
        switch (as) {
          case "script":
            if (resumableState.moduleScriptResources.hasOwnProperty(href)) return;
            as = [];
            resumableState.moduleScriptResources[href] =
              !options ||
              ("string" !== typeof options.crossOrigin && "string" !== typeof options.integrity)
                ? PRELOAD_NO_CREDS
                : [options.crossOrigin, options.integrity];
            renderState.preloads.moduleScripts.set(href, as);
            break;
          default:
            if (resumableState.moduleUnknownResources.hasOwnProperty(as)) {
              var resources = resumableState.unknownResources[as];
              if (resources.hasOwnProperty(href)) return;
            } else ((resources = {}), (resumableState.moduleUnknownResources[as] = resources));
            as = [];
            resources[href] = PRELOAD_NO_CREDS;
        }
        pushLinkImpl(as, assign({ rel: "modulepreload", href }, options));
        renderState.bulkPreloads.add(as);
        enqueueFlush(request);
      }
    } else previousDispatcher.m(href, options);
  }
  function preinitStyle(href, precedence, options) {
    var request = currentRequest ? currentRequest : null;
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if (href) {
        precedence = precedence || "default";
        var styleQueue = renderState.styles.get(precedence),
          resourceState = resumableState.styleResources.hasOwnProperty(href)
            ? resumableState.styleResources[href]
            : void 0;
        null !== resourceState &&
          ((resumableState.styleResources[href] = null),
          styleQueue ||
            ((styleQueue = {
              precedence: escapeTextForBrowser(precedence),
              rules: [],
              hrefs: [],
              sheets: /* @__PURE__ */ new Map(),
            }),
            renderState.styles.set(precedence, styleQueue)),
          (precedence = {
            state: 0,
            props: assign({ rel: "stylesheet", href, "data-precedence": precedence }, options),
          }),
          resourceState &&
            (2 === resourceState.length && adoptPreloadCredentials(precedence.props, resourceState),
            (renderState = renderState.preloads.stylesheets.get(href)) && 0 < renderState.length
              ? (renderState.length = 0)
              : (precedence.state = 1)),
          styleQueue.sheets.set(href, precedence),
          enqueueFlush(request));
      }
    } else previousDispatcher.S(href, precedence, options);
  }
  function preinitScript(src, options) {
    var request = currentRequest ? currentRequest : null;
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if (src) {
        var resourceState = resumableState.scriptResources.hasOwnProperty(src)
          ? resumableState.scriptResources[src]
          : void 0;
        null !== resourceState &&
          ((resumableState.scriptResources[src] = null),
          (options = assign({ src, async: true }, options)),
          resourceState &&
            (2 === resourceState.length && adoptPreloadCredentials(options, resourceState),
            (src = renderState.preloads.scripts.get(src))) &&
            (src.length = 0),
          (src = []),
          renderState.scripts.add(src),
          pushScriptImpl(src, options),
          enqueueFlush(request));
      }
    } else previousDispatcher.X(src, options);
  }
  function preinitModuleScript(src, options) {
    var request = currentRequest ? currentRequest : null;
    if (request) {
      var resumableState = request.resumableState,
        renderState = request.renderState;
      if (src) {
        var resourceState = resumableState.moduleScriptResources.hasOwnProperty(src)
          ? resumableState.moduleScriptResources[src]
          : void 0;
        null !== resourceState &&
          ((resumableState.moduleScriptResources[src] = null),
          (options = assign({ src, type: "module", async: true }, options)),
          resourceState &&
            (2 === resourceState.length && adoptPreloadCredentials(options, resourceState),
            (src = renderState.preloads.moduleScripts.get(src))) &&
            (src.length = 0),
          (src = []),
          renderState.scripts.add(src),
          pushScriptImpl(src, options),
          enqueueFlush(request));
      }
    } else previousDispatcher.M(src, options);
  }
  function adoptPreloadCredentials(target, preloadState) {
    null == target.crossOrigin && (target.crossOrigin = preloadState[0]);
    null == target.integrity && (target.integrity = preloadState[1]);
  }
  function getPreloadAsHeader(href, as, params) {
    href = ("" + href).replace(
      regexForHrefInLinkHeaderURLContext,
      escapeHrefForLinkHeaderURLContextReplacer,
    );
    as = ("" + as).replace(
      regexForLinkHeaderQuotedParamValueContext,
      escapeStringForLinkHeaderQuotedParamValueContextReplacer,
    );
    as = "<" + href + '>; rel=preload; as="' + as + '"';
    for (var paramName in params)
      hasOwnProperty.call(params, paramName) &&
        ((href = params[paramName]),
        "string" === typeof href &&
          (as +=
            "; " +
            paramName.toLowerCase() +
            '="' +
            ("" + href).replace(
              regexForLinkHeaderQuotedParamValueContext,
              escapeStringForLinkHeaderQuotedParamValueContextReplacer,
            ) +
            '"'));
    return as;
  }
  var regexForHrefInLinkHeaderURLContext = /[<>\r\n]/g;
  function escapeHrefForLinkHeaderURLContextReplacer(match) {
    switch (match) {
      case "<":
        return "%3C";
      case ">":
        return "%3E";
      case "\n":
        return "%0A";
      case "\r":
        return "%0D";
      default:
        throw Error(
          "escapeLinkHrefForHeaderContextReplacer encountered a match it does not know how to replace. this means the match regex and the replacement characters are no longer in sync. This is a bug in React",
        );
    }
  }
  var regexForLinkHeaderQuotedParamValueContext = /["';,\r\n]/g;
  function escapeStringForLinkHeaderQuotedParamValueContextReplacer(match) {
    switch (match) {
      case '"':
        return "%22";
      case "'":
        return "%27";
      case ";":
        return "%3B";
      case ",":
        return "%2C";
      case "\n":
        return "%0A";
      case "\r":
        return "%0D";
      default:
        throw Error(
          "escapeStringForLinkHeaderQuotedParamValueContextReplacer encountered a match it does not know how to replace. this means the match regex and the replacement characters are no longer in sync. This is a bug in React",
        );
    }
  }
  function hoistStyleQueueDependency(styleQueue) {
    this.styles.add(styleQueue);
  }
  function hoistStylesheetDependency(stylesheet) {
    this.stylesheets.add(stylesheet);
  }
  function hoistHoistables(parentState, childState) {
    childState.styles.forEach(hoistStyleQueueDependency, parentState);
    childState.stylesheets.forEach(hoistStylesheetDependency, parentState);
    childState.suspenseyImages && (parentState.suspenseyImages = true);
  }
  function createRenderState(resumableState, generateStaticMarkup) {
    var idPrefix = resumableState.idPrefix,
      bootstrapChunks = [],
      bootstrapScriptContent = resumableState.bootstrapScriptContent,
      bootstrapScripts = resumableState.bootstrapScripts,
      bootstrapModules = resumableState.bootstrapModules;
    void 0 !== bootstrapScriptContent &&
      (bootstrapChunks.push("<script"),
      pushCompletedShellIdAttribute(bootstrapChunks, resumableState),
      bootstrapChunks.push(
        ">",
        ("" + bootstrapScriptContent).replace(scriptRegex, scriptReplacer),
        "<\/script>",
      ));
    bootstrapScriptContent = idPrefix + "P:";
    var JSCompiler_object_inline_segmentPrefix_1673 = idPrefix + "S:";
    idPrefix += "B:";
    var JSCompiler_object_inline_preconnects_1687 = /* @__PURE__ */ new Set(),
      JSCompiler_object_inline_fontPreloads_1688 = /* @__PURE__ */ new Set(),
      JSCompiler_object_inline_highImagePreloads_1689 = /* @__PURE__ */ new Set(),
      JSCompiler_object_inline_styles_1690 = /* @__PURE__ */ new Map(),
      JSCompiler_object_inline_bootstrapScripts_1691 = /* @__PURE__ */ new Set(),
      JSCompiler_object_inline_scripts_1692 = /* @__PURE__ */ new Set(),
      JSCompiler_object_inline_bulkPreloads_1693 = /* @__PURE__ */ new Set(),
      JSCompiler_object_inline_preloads_1694 = {
        images: /* @__PURE__ */ new Map(),
        stylesheets: /* @__PURE__ */ new Map(),
        scripts: /* @__PURE__ */ new Map(),
        moduleScripts: /* @__PURE__ */ new Map(),
      };
    if (void 0 !== bootstrapScripts)
      for (var i = 0; i < bootstrapScripts.length; i++) {
        var scriptConfig = bootstrapScripts[i],
          src,
          crossOrigin = void 0,
          integrity = void 0,
          props = {
            rel: "preload",
            as: "script",
            fetchPriority: "low",
            nonce: void 0,
          };
        "string" === typeof scriptConfig
          ? (props.href = src = scriptConfig)
          : ((props.href = src = scriptConfig.src),
            (props.integrity = integrity =
              "string" === typeof scriptConfig.integrity ? scriptConfig.integrity : void 0),
            (props.crossOrigin = crossOrigin =
              "string" === typeof scriptConfig || null == scriptConfig.crossOrigin
                ? void 0
                : "use-credentials" === scriptConfig.crossOrigin
                  ? "use-credentials"
                  : ""));
        scriptConfig = resumableState;
        var href = src;
        scriptConfig.scriptResources[href] = null;
        scriptConfig.moduleScriptResources[href] = null;
        scriptConfig = [];
        pushLinkImpl(scriptConfig, props);
        JSCompiler_object_inline_bootstrapScripts_1691.add(scriptConfig);
        bootstrapChunks.push('<script src="', escapeTextForBrowser(src), '"');
        "string" === typeof integrity &&
          bootstrapChunks.push(' integrity="', escapeTextForBrowser(integrity), '"');
        "string" === typeof crossOrigin &&
          bootstrapChunks.push(' crossorigin="', escapeTextForBrowser(crossOrigin), '"');
        pushCompletedShellIdAttribute(bootstrapChunks, resumableState);
        bootstrapChunks.push(' async=""><\/script>');
      }
    if (void 0 !== bootstrapModules)
      for (bootstrapScripts = 0; bootstrapScripts < bootstrapModules.length; bootstrapScripts++)
        ((props = bootstrapModules[bootstrapScripts]),
          (crossOrigin = src = void 0),
          (integrity = {
            rel: "modulepreload",
            fetchPriority: "low",
            nonce: void 0,
          }),
          "string" === typeof props
            ? (integrity.href = i = props)
            : ((integrity.href = i = props.src),
              (integrity.integrity = crossOrigin =
                "string" === typeof props.integrity ? props.integrity : void 0),
              (integrity.crossOrigin = src =
                "string" === typeof props || null == props.crossOrigin
                  ? void 0
                  : "use-credentials" === props.crossOrigin
                    ? "use-credentials"
                    : "")),
          (props = resumableState),
          (scriptConfig = i),
          (props.scriptResources[scriptConfig] = null),
          (props.moduleScriptResources[scriptConfig] = null),
          (props = []),
          pushLinkImpl(props, integrity),
          JSCompiler_object_inline_bootstrapScripts_1691.add(props),
          bootstrapChunks.push('<script type="module" src="', escapeTextForBrowser(i), '"'),
          "string" === typeof crossOrigin &&
            bootstrapChunks.push(' integrity="', escapeTextForBrowser(crossOrigin), '"'),
          "string" === typeof src &&
            bootstrapChunks.push(' crossorigin="', escapeTextForBrowser(src), '"'),
          pushCompletedShellIdAttribute(bootstrapChunks, resumableState),
          bootstrapChunks.push(' async=""><\/script>'));
    return {
      placeholderPrefix: bootstrapScriptContent,
      segmentPrefix: JSCompiler_object_inline_segmentPrefix_1673,
      boundaryPrefix: idPrefix,
      startInlineScript: "<script",
      startInlineStyle: "<style",
      preamble: { htmlChunks: null, headChunks: null, bodyChunks: null },
      externalRuntimeScript: null,
      bootstrapChunks,
      importMapChunks: [],
      onHeaders: void 0,
      headers: null,
      resets: {
        font: {},
        dns: {},
        connect: { default: {}, anonymous: {}, credentials: {} },
        image: {},
        style: {},
      },
      charsetChunks: [],
      viewportChunks: [],
      hoistableChunks: [],
      preconnects: JSCompiler_object_inline_preconnects_1687,
      fontPreloads: JSCompiler_object_inline_fontPreloads_1688,
      highImagePreloads: JSCompiler_object_inline_highImagePreloads_1689,
      styles: JSCompiler_object_inline_styles_1690,
      bootstrapScripts: JSCompiler_object_inline_bootstrapScripts_1691,
      scripts: JSCompiler_object_inline_scripts_1692,
      bulkPreloads: JSCompiler_object_inline_bulkPreloads_1693,
      preloads: JSCompiler_object_inline_preloads_1694,
      nonce: { script: void 0, style: void 0 },
      stylesToHoist: false,
      generateStaticMarkup,
    };
  }
  function pushTextInstance(target, text, renderState, textEmbedded) {
    if (renderState.generateStaticMarkup) return (target.push(escapeTextForBrowser(text)), false);
    "" === text
      ? (target = textEmbedded)
      : (textEmbedded && target.push("<!-- -->"),
        target.push(escapeTextForBrowser(text)),
        (target = true));
    return target;
  }
  function pushSegmentFinale(target, renderState, lastPushedText, textEmbedded) {
    renderState.generateStaticMarkup || (lastPushedText && textEmbedded && target.push("<!-- -->"));
  }
  var bind = Function.prototype.bind,
    REACT_CLIENT_REFERENCE = Symbol.for("react.client.reference");
  function getComponentNameFromType(type) {
    if (null == type) return null;
    if ("function" === typeof type)
      return type.$$typeof === REACT_CLIENT_REFERENCE
        ? null
        : type.displayName || type.name || null;
    if ("string" === typeof type) return type;
    switch (type) {
      case REACT_FRAGMENT_TYPE:
        return "Fragment";
      case REACT_PROFILER_TYPE:
        return "Profiler";
      case REACT_STRICT_MODE_TYPE:
        return "StrictMode";
      case REACT_SUSPENSE_TYPE:
        return "Suspense";
      case REACT_SUSPENSE_LIST_TYPE:
        return "SuspenseList";
      case REACT_ACTIVITY_TYPE:
        return "Activity";
    }
    if ("object" === typeof type)
      switch (type.$$typeof) {
        case REACT_PORTAL_TYPE:
          return "Portal";
        case REACT_CONTEXT_TYPE:
          return type.displayName || "Context";
        case REACT_CONSUMER_TYPE:
          return (type._context.displayName || "Context") + ".Consumer";
        case REACT_FORWARD_REF_TYPE:
          var innerType = type.render;
          type = type.displayName;
          type ||
            ((type = innerType.displayName || innerType.name || ""),
            (type = "" !== type ? "ForwardRef(" + type + ")" : "ForwardRef"));
          return type;
        case REACT_MEMO_TYPE:
          return (
            (innerType = type.displayName || null),
            null !== innerType ? innerType : getComponentNameFromType(type.type) || "Memo"
          );
        case REACT_LAZY_TYPE:
          innerType = type._payload;
          type = type._init;
          try {
            return getComponentNameFromType(type(innerType));
          } catch (x3) {}
      }
    return null;
  }
  var emptyContextObject = {},
    currentActiveSnapshot = null;
  function popToNearestCommonAncestor(prev, next) {
    if (prev !== next) {
      prev.context._currentValue2 = prev.parentValue;
      prev = prev.parent;
      var parentNext = next.parent;
      if (null === prev) {
        if (null !== parentNext) throw Error(formatProdErrorMessage(401));
      } else {
        if (null === parentNext) throw Error(formatProdErrorMessage(401));
        popToNearestCommonAncestor(prev, parentNext);
      }
      next.context._currentValue2 = next.value;
    }
  }
  function popAllPrevious(prev) {
    prev.context._currentValue2 = prev.parentValue;
    prev = prev.parent;
    null !== prev && popAllPrevious(prev);
  }
  function pushAllNext(next) {
    var parentNext = next.parent;
    null !== parentNext && pushAllNext(parentNext);
    next.context._currentValue2 = next.value;
  }
  function popPreviousToCommonLevel(prev, next) {
    prev.context._currentValue2 = prev.parentValue;
    prev = prev.parent;
    if (null === prev) throw Error(formatProdErrorMessage(402));
    prev.depth === next.depth
      ? popToNearestCommonAncestor(prev, next)
      : popPreviousToCommonLevel(prev, next);
  }
  function popNextToCommonLevel(prev, next) {
    var parentNext = next.parent;
    if (null === parentNext) throw Error(formatProdErrorMessage(402));
    prev.depth === parentNext.depth
      ? popToNearestCommonAncestor(prev, parentNext)
      : popNextToCommonLevel(prev, parentNext);
    next.context._currentValue2 = next.value;
  }
  function switchContext(newSnapshot) {
    var prev = currentActiveSnapshot;
    prev !== newSnapshot &&
      (null === prev
        ? pushAllNext(newSnapshot)
        : null === newSnapshot
          ? popAllPrevious(prev)
          : prev.depth === newSnapshot.depth
            ? popToNearestCommonAncestor(prev, newSnapshot)
            : prev.depth > newSnapshot.depth
              ? popPreviousToCommonLevel(prev, newSnapshot)
              : popNextToCommonLevel(prev, newSnapshot),
      (currentActiveSnapshot = newSnapshot));
  }
  var classComponentUpdater = {
      enqueueSetState: function (inst, payload) {
        inst = inst._reactInternals;
        null !== inst.queue && inst.queue.push(payload);
      },
      enqueueReplaceState: function (inst, payload) {
        inst = inst._reactInternals;
        inst.replace = true;
        inst.queue = [payload];
      },
      enqueueForceUpdate: function () {},
    },
    emptyTreeContext = { id: 1, overflow: "" };
  function pushTreeContext(baseContext, totalChildren, index) {
    var baseIdWithLeadingBit = baseContext.id;
    baseContext = baseContext.overflow;
    var baseLength = 32 - clz32(baseIdWithLeadingBit) - 1;
    baseIdWithLeadingBit &= ~(1 << baseLength);
    index += 1;
    var length = 32 - clz32(totalChildren) + baseLength;
    if (30 < length) {
      var numberOfOverflowBits = baseLength - (baseLength % 5);
      length = (baseIdWithLeadingBit & ((1 << numberOfOverflowBits) - 1)).toString(32);
      baseIdWithLeadingBit >>= numberOfOverflowBits;
      baseLength -= numberOfOverflowBits;
      return {
        id:
          (1 << (32 - clz32(totalChildren) + baseLength)) |
          (index << baseLength) |
          baseIdWithLeadingBit,
        overflow: length + baseContext,
      };
    }
    return {
      id: (1 << length) | (index << baseLength) | baseIdWithLeadingBit,
      overflow: baseContext,
    };
  }
  var clz32 = Math.clz32 ? Math.clz32 : clz32Fallback,
    log = Math.log,
    LN2 = Math.LN2;
  function clz32Fallback(x3) {
    x3 >>>= 0;
    return 0 === x3 ? 32 : (31 - ((log(x3) / LN2) | 0)) | 0;
  }
  function noop() {}
  var SuspenseException = Error(formatProdErrorMessage(460));
  function trackUsedThenable(thenableState2, thenable, index) {
    index = thenableState2[index];
    void 0 === index
      ? thenableState2.push(thenable)
      : index !== thenable && (thenable.then(noop, noop), (thenable = index));
    switch (thenable.status) {
      case "fulfilled":
        return thenable.value;
      case "rejected":
        throw thenable.reason;
      default:
        "string" === typeof thenable.status
          ? thenable.then(noop, noop)
          : ((thenableState2 = thenable),
            (thenableState2.status = "pending"),
            thenableState2.then(
              function (fulfilledValue) {
                if ("pending" === thenable.status) {
                  var fulfilledThenable = thenable;
                  fulfilledThenable.status = "fulfilled";
                  fulfilledThenable.value = fulfilledValue;
                }
              },
              function (error) {
                if ("pending" === thenable.status) {
                  var rejectedThenable = thenable;
                  rejectedThenable.status = "rejected";
                  rejectedThenable.reason = error;
                }
              },
            ));
        switch (thenable.status) {
          case "fulfilled":
            return thenable.value;
          case "rejected":
            throw thenable.reason;
        }
        suspendedThenable = thenable;
        throw SuspenseException;
    }
  }
  var suspendedThenable = null;
  function getSuspendedThenable() {
    if (null === suspendedThenable) throw Error(formatProdErrorMessage(459));
    var thenable = suspendedThenable;
    suspendedThenable = null;
    return thenable;
  }
  function is(x3, y2) {
    return (x3 === y2 && (0 !== x3 || 1 / x3 === 1 / y2)) || (x3 !== x3 && y2 !== y2);
  }
  var objectIs = "function" === typeof Object.is ? Object.is : is,
    currentlyRenderingComponent = null,
    currentlyRenderingTask = null,
    currentlyRenderingRequest = null,
    currentlyRenderingKeyPath = null,
    firstWorkInProgressHook = null,
    workInProgressHook = null,
    isReRender = false,
    didScheduleRenderPhaseUpdate = false,
    localIdCounter = 0,
    actionStateCounter = 0,
    actionStateMatchingIndex = -1,
    thenableIndexCounter = 0,
    thenableState = null,
    renderPhaseUpdates = null,
    numberOfReRenders = 0;
  function resolveCurrentlyRenderingComponent() {
    if (null === currentlyRenderingComponent) throw Error(formatProdErrorMessage(321));
    return currentlyRenderingComponent;
  }
  function createHook() {
    if (0 < numberOfReRenders) throw Error(formatProdErrorMessage(312));
    return { memoizedState: null, queue: null, next: null };
  }
  function createWorkInProgressHook() {
    null === workInProgressHook
      ? null === firstWorkInProgressHook
        ? ((isReRender = false), (firstWorkInProgressHook = workInProgressHook = createHook()))
        : ((isReRender = true), (workInProgressHook = firstWorkInProgressHook))
      : null === workInProgressHook.next
        ? ((isReRender = false), (workInProgressHook = workInProgressHook.next = createHook()))
        : ((isReRender = true), (workInProgressHook = workInProgressHook.next));
    return workInProgressHook;
  }
  function getThenableStateAfterSuspending() {
    var state = thenableState;
    thenableState = null;
    return state;
  }
  function resetHooksState() {
    currentlyRenderingKeyPath =
      currentlyRenderingRequest =
      currentlyRenderingTask =
      currentlyRenderingComponent =
        null;
    didScheduleRenderPhaseUpdate = false;
    firstWorkInProgressHook = null;
    numberOfReRenders = 0;
    workInProgressHook = renderPhaseUpdates = null;
  }
  function basicStateReducer(state, action) {
    return "function" === typeof action ? action(state) : action;
  }
  function useReducer(reducer, initialArg, init) {
    currentlyRenderingComponent = resolveCurrentlyRenderingComponent();
    workInProgressHook = createWorkInProgressHook();
    if (isReRender) {
      var queue = workInProgressHook.queue;
      initialArg = queue.dispatch;
      if (
        null !== renderPhaseUpdates &&
        ((init = renderPhaseUpdates.get(queue)), void 0 !== init)
      ) {
        renderPhaseUpdates.delete(queue);
        queue = workInProgressHook.memoizedState;
        do ((queue = reducer(queue, init.action)), (init = init.next));
        while (null !== init);
        workInProgressHook.memoizedState = queue;
        return [queue, initialArg];
      }
      return [workInProgressHook.memoizedState, initialArg];
    }
    reducer =
      reducer === basicStateReducer
        ? "function" === typeof initialArg
          ? initialArg()
          : initialArg
        : void 0 !== init
          ? init(initialArg)
          : initialArg;
    workInProgressHook.memoizedState = reducer;
    reducer = workInProgressHook.queue = { last: null, dispatch: null };
    reducer = reducer.dispatch = dispatchAction.bind(null, currentlyRenderingComponent, reducer);
    return [workInProgressHook.memoizedState, reducer];
  }
  function useMemo(nextCreate, deps) {
    currentlyRenderingComponent = resolveCurrentlyRenderingComponent();
    workInProgressHook = createWorkInProgressHook();
    deps = void 0 === deps ? null : deps;
    if (null !== workInProgressHook) {
      var prevState = workInProgressHook.memoizedState;
      if (null !== prevState && null !== deps) {
        var prevDeps = prevState[1];
        a: if (null === prevDeps) prevDeps = false;
        else {
          for (var i = 0; i < prevDeps.length && i < deps.length; i++)
            if (!objectIs(deps[i], prevDeps[i])) {
              prevDeps = false;
              break a;
            }
          prevDeps = true;
        }
        if (prevDeps) return prevState[0];
      }
    }
    nextCreate = nextCreate();
    workInProgressHook.memoizedState = [nextCreate, deps];
    return nextCreate;
  }
  function dispatchAction(componentIdentity, queue, action) {
    if (25 <= numberOfReRenders) throw Error(formatProdErrorMessage(301));
    if (componentIdentity === currentlyRenderingComponent)
      if (
        ((didScheduleRenderPhaseUpdate = true),
        (componentIdentity = { action, next: null }),
        null === renderPhaseUpdates && (renderPhaseUpdates = /* @__PURE__ */ new Map()),
        (action = renderPhaseUpdates.get(queue)),
        void 0 === action)
      )
        renderPhaseUpdates.set(queue, componentIdentity);
      else {
        for (queue = action; null !== queue.next; ) queue = queue.next;
        queue.next = componentIdentity;
      }
  }
  function throwOnUseEffectEventCall() {
    throw Error(formatProdErrorMessage(440));
  }
  function unsupportedStartTransition() {
    throw Error(formatProdErrorMessage(394));
  }
  function unsupportedSetOptimisticState() {
    throw Error(formatProdErrorMessage(479));
  }
  function useActionState(action, initialState, permalink) {
    resolveCurrentlyRenderingComponent();
    var actionStateHookIndex = actionStateCounter++,
      request = currentlyRenderingRequest;
    if ("function" === typeof action.$$FORM_ACTION) {
      var nextPostbackStateKey = null,
        componentKeyPath = currentlyRenderingKeyPath;
      request = request.formState;
      var isSignatureEqual = action.$$IS_SIGNATURE_EQUAL;
      if (null !== request && "function" === typeof isSignatureEqual) {
        var postbackKey = request[1];
        isSignatureEqual.call(action, request[2], request[3]) &&
          ((nextPostbackStateKey =
            void 0 !== permalink
              ? "p" + permalink
              : "k" +
                murmurhash3_32_gc(
                  JSON.stringify([componentKeyPath, null, actionStateHookIndex]),
                  0,
                )),
          postbackKey === nextPostbackStateKey &&
            ((actionStateMatchingIndex = actionStateHookIndex), (initialState = request[0])));
      }
      var boundAction = action.bind(null, initialState);
      action = function (payload) {
        boundAction(payload);
      };
      "function" === typeof boundAction.$$FORM_ACTION &&
        (action.$$FORM_ACTION = function (prefix2) {
          prefix2 = boundAction.$$FORM_ACTION(prefix2);
          void 0 !== permalink && ((permalink += ""), (prefix2.action = permalink));
          var formData = prefix2.data;
          formData &&
            (null === nextPostbackStateKey &&
              (nextPostbackStateKey =
                void 0 !== permalink
                  ? "p" + permalink
                  : "k" +
                    murmurhash3_32_gc(
                      JSON.stringify([componentKeyPath, null, actionStateHookIndex]),
                      0,
                    )),
            formData.append("$ACTION_KEY", nextPostbackStateKey));
          return prefix2;
        });
      return [initialState, action, false];
    }
    var boundAction$22 = action.bind(null, initialState);
    return [
      initialState,
      function (payload) {
        boundAction$22(payload);
      },
      false,
    ];
  }
  function unwrapThenable(thenable) {
    var index = thenableIndexCounter;
    thenableIndexCounter += 1;
    null === thenableState && (thenableState = []);
    return trackUsedThenable(thenableState, thenable, index);
  }
  function unsupportedRefresh() {
    throw Error(formatProdErrorMessage(393));
  }
  var HooksDispatcher = {
      readContext: function (context) {
        return context._currentValue2;
      },
      use: function (usable) {
        if (null !== usable && "object" === typeof usable) {
          if ("function" === typeof usable.then) return unwrapThenable(usable);
          if (usable.$$typeof === REACT_CONTEXT_TYPE) return usable._currentValue2;
        }
        throw Error(formatProdErrorMessage(438, String(usable)));
      },
      useContext: function (context) {
        resolveCurrentlyRenderingComponent();
        return context._currentValue2;
      },
      useMemo,
      useReducer,
      useRef: function (initialValue) {
        currentlyRenderingComponent = resolveCurrentlyRenderingComponent();
        workInProgressHook = createWorkInProgressHook();
        var previousRef = workInProgressHook.memoizedState;
        return null === previousRef
          ? ((initialValue = { current: initialValue }),
            (workInProgressHook.memoizedState = initialValue))
          : previousRef;
      },
      useState: function (initialState) {
        return useReducer(basicStateReducer, initialState);
      },
      useInsertionEffect: noop,
      useLayoutEffect: noop,
      useCallback: function (callback, deps) {
        return useMemo(function () {
          return callback;
        }, deps);
      },
      useImperativeHandle: noop,
      useEffect: noop,
      useDebugValue: noop,
      useDeferredValue: function (value, initialValue) {
        resolveCurrentlyRenderingComponent();
        return void 0 !== initialValue ? initialValue : value;
      },
      useTransition: function () {
        resolveCurrentlyRenderingComponent();
        return [false, unsupportedStartTransition];
      },
      useId: function () {
        var JSCompiler_inline_result = currentlyRenderingTask.treeContext;
        var overflow = JSCompiler_inline_result.overflow;
        JSCompiler_inline_result = JSCompiler_inline_result.id;
        JSCompiler_inline_result =
          (JSCompiler_inline_result & ~(1 << (32 - clz32(JSCompiler_inline_result) - 1))).toString(
            32,
          ) + overflow;
        var resumableState = currentResumableState;
        if (null === resumableState) throw Error(formatProdErrorMessage(404));
        overflow = localIdCounter++;
        JSCompiler_inline_result = "_" + resumableState.idPrefix + "R_" + JSCompiler_inline_result;
        0 < overflow && (JSCompiler_inline_result += "H" + overflow.toString(32));
        return JSCompiler_inline_result + "_";
      },
      useSyncExternalStore: function (subscribe2, getSnapshot, getServerSnapshot) {
        if (void 0 === getServerSnapshot) throw Error(formatProdErrorMessage(407));
        return getServerSnapshot();
      },
      useOptimistic: function (passthrough) {
        resolveCurrentlyRenderingComponent();
        return [passthrough, unsupportedSetOptimisticState];
      },
      useActionState,
      useFormState: useActionState,
      useHostTransitionStatus: function () {
        resolveCurrentlyRenderingComponent();
        return sharedNotPendingObject;
      },
      useMemoCache: function (size) {
        for (var data = Array(size), i = 0; i < size; i++) data[i] = REACT_MEMO_CACHE_SENTINEL;
        return data;
      },
      useCacheRefresh: function () {
        return unsupportedRefresh;
      },
      useEffectEvent: function () {
        return throwOnUseEffectEventCall;
      },
    },
    currentResumableState = null,
    DefaultAsyncDispatcher = {
      getCacheForType: function () {
        throw Error(formatProdErrorMessage(248));
      },
      cacheSignal: function () {
        throw Error(formatProdErrorMessage(248));
      },
    },
    prefix,
    suffix;
  function describeBuiltInComponentFrame(name) {
    if (void 0 === prefix)
      try {
        throw Error();
      } catch (x3) {
        var match = x3.stack.trim().match(/\n( *(at )?)/);
        prefix = (match && match[1]) || "";
        suffix =
          -1 < x3.stack.indexOf("\n    at")
            ? " (<anonymous>)"
            : -1 < x3.stack.indexOf("@")
              ? "@unknown:0:0"
              : "";
      }
    return "\n" + prefix + name + suffix;
  }
  var reentry = false;
  function describeNativeComponentFrame(fn2, construct) {
    if (!fn2 || reentry) return "";
    reentry = true;
    var previousPrepareStackTrace = Error.prepareStackTrace;
    Error.prepareStackTrace = void 0;
    try {
      var RunInRootFrame = {
        DetermineComponentFrameRoot: function () {
          try {
            if (construct) {
              var Fake = function () {
                throw Error();
              };
              Object.defineProperty(Fake.prototype, "props", {
                set: function () {
                  throw Error();
                },
              });
              if ("object" === typeof Reflect && Reflect.construct) {
                try {
                  Reflect.construct(Fake, []);
                } catch (x3) {
                  var control = x3;
                }
                Reflect.construct(fn2, [], Fake);
              } else {
                try {
                  Fake.call();
                } catch (x$24) {
                  control = x$24;
                }
                fn2.call(Fake.prototype);
              }
            } else {
              try {
                throw Error();
              } catch (x$25) {
                control = x$25;
              }
              (Fake = fn2()) && "function" === typeof Fake.catch && Fake.catch(function () {});
            }
          } catch (sample) {
            if (sample && control && "string" === typeof sample.stack)
              return [sample.stack, control.stack];
          }
          return [null, null];
        },
      };
      RunInRootFrame.DetermineComponentFrameRoot.displayName = "DetermineComponentFrameRoot";
      var namePropDescriptor = Object.getOwnPropertyDescriptor(
        RunInRootFrame.DetermineComponentFrameRoot,
        "name",
      );
      namePropDescriptor &&
        namePropDescriptor.configurable &&
        Object.defineProperty(RunInRootFrame.DetermineComponentFrameRoot, "name", {
          value: "DetermineComponentFrameRoot",
        });
      var _RunInRootFrame$Deter = RunInRootFrame.DetermineComponentFrameRoot(),
        sampleStack = _RunInRootFrame$Deter[0],
        controlStack = _RunInRootFrame$Deter[1];
      if (sampleStack && controlStack) {
        var sampleLines = sampleStack.split("\n"),
          controlLines = controlStack.split("\n");
        for (
          namePropDescriptor = RunInRootFrame = 0;
          RunInRootFrame < sampleLines.length &&
          !sampleLines[RunInRootFrame].includes("DetermineComponentFrameRoot");
        )
          RunInRootFrame++;
        for (
          ;
          namePropDescriptor < controlLines.length &&
          !controlLines[namePropDescriptor].includes("DetermineComponentFrameRoot");
        )
          namePropDescriptor++;
        if (RunInRootFrame === sampleLines.length || namePropDescriptor === controlLines.length)
          for (
            RunInRootFrame = sampleLines.length - 1, namePropDescriptor = controlLines.length - 1;
            1 <= RunInRootFrame &&
            0 <= namePropDescriptor &&
            sampleLines[RunInRootFrame] !== controlLines[namePropDescriptor];
          )
            namePropDescriptor--;
        for (
          ;
          1 <= RunInRootFrame && 0 <= namePropDescriptor;
          RunInRootFrame--, namePropDescriptor--
        )
          if (sampleLines[RunInRootFrame] !== controlLines[namePropDescriptor]) {
            if (1 !== RunInRootFrame || 1 !== namePropDescriptor) {
              do
                if (
                  (RunInRootFrame--,
                  namePropDescriptor--,
                  0 > namePropDescriptor ||
                    sampleLines[RunInRootFrame] !== controlLines[namePropDescriptor])
                ) {
                  var frame = "\n" + sampleLines[RunInRootFrame].replace(" at new ", " at ");
                  fn2.displayName &&
                    frame.includes("<anonymous>") &&
                    (frame = frame.replace("<anonymous>", fn2.displayName));
                  return frame;
                }
              while (1 <= RunInRootFrame && 0 <= namePropDescriptor);
            }
            break;
          }
      }
    } finally {
      ((reentry = false), (Error.prepareStackTrace = previousPrepareStackTrace));
    }
    return (previousPrepareStackTrace = fn2 ? fn2.displayName || fn2.name : "")
      ? describeBuiltInComponentFrame(previousPrepareStackTrace)
      : "";
  }
  function describeComponentStackByType(type) {
    if ("string" === typeof type) return describeBuiltInComponentFrame(type);
    if ("function" === typeof type)
      return type.prototype && type.prototype.isReactComponent
        ? describeNativeComponentFrame(type, true)
        : describeNativeComponentFrame(type, false);
    if ("object" === typeof type && null !== type) {
      switch (type.$$typeof) {
        case REACT_FORWARD_REF_TYPE:
          return describeNativeComponentFrame(type.render, false);
        case REACT_MEMO_TYPE:
          return describeNativeComponentFrame(type.type, false);
        case REACT_LAZY_TYPE:
          var lazyComponent = type,
            payload = lazyComponent._payload;
          lazyComponent = lazyComponent._init;
          try {
            type = lazyComponent(payload);
          } catch (x3) {
            return describeBuiltInComponentFrame("Lazy");
          }
          return describeComponentStackByType(type);
      }
      if ("string" === typeof type.name) {
        a: {
          payload = type.name;
          lazyComponent = type.env;
          var location = type.debugLocation;
          if (
            null != location &&
            ((type = Error.prepareStackTrace),
            (Error.prepareStackTrace = void 0),
            (location = location.stack),
            (Error.prepareStackTrace = type),
            location.startsWith("Error: react-stack-top-frame\n") &&
              (location = location.slice(29)),
            (type = location.indexOf("\n")),
            -1 !== type && (location = location.slice(type + 1)),
            (type = location.indexOf("react_stack_bottom_frame")),
            -1 !== type && (type = location.lastIndexOf("\n", type)),
            (type = -1 !== type ? (location = location.slice(0, type)) : ""),
            (location = type.lastIndexOf("\n")),
            (type = -1 === location ? type : type.slice(location + 1)),
            -1 !== type.indexOf(payload))
          ) {
            payload = "\n" + type;
            break a;
          }
          payload = describeBuiltInComponentFrame(
            payload + (lazyComponent ? " [" + lazyComponent + "]" : ""),
          );
        }
        return payload;
      }
    }
    switch (type) {
      case REACT_SUSPENSE_LIST_TYPE:
        return describeBuiltInComponentFrame("SuspenseList");
      case REACT_SUSPENSE_TYPE:
        return describeBuiltInComponentFrame("Suspense");
    }
    return "";
  }
  function isEligibleForOutlining(request, boundary) {
    return (500 < boundary.byteSize || false) && null === boundary.contentPreamble;
  }
  function defaultErrorHandler(error) {
    if ("object" === typeof error && null !== error && "string" === typeof error.environmentName) {
      var JSCompiler_inline_result = error.environmentName;
      error = [error].slice(0);
      "string" === typeof error[0]
        ? error.splice(0, 1, "[%s] " + error[0], " " + JSCompiler_inline_result + " ")
        : error.splice(0, 0, "[%s]", " " + JSCompiler_inline_result + " ");
      error.unshift(console);
      JSCompiler_inline_result = bind.apply(console.error, error);
      JSCompiler_inline_result();
    } else console.error(error);
    return null;
  }
  function RequestInstance(
    resumableState,
    renderState,
    rootFormatContext,
    progressiveChunkSize,
    onError2,
    onAllReady,
    onShellReady,
    onShellError,
    onFatalError,
    onPostpone,
    formState,
  ) {
    var abortSet = /* @__PURE__ */ new Set();
    this.destination = null;
    this.flushScheduled = false;
    this.resumableState = resumableState;
    this.renderState = renderState;
    this.rootFormatContext = rootFormatContext;
    this.progressiveChunkSize = void 0 === progressiveChunkSize ? 12800 : progressiveChunkSize;
    this.status = 10;
    this.fatalError = null;
    this.pendingRootTasks = this.allPendingTasks = this.nextSegmentId = 0;
    this.completedPreambleSegments = this.completedRootSegment = null;
    this.byteSize = 0;
    this.abortableTasks = abortSet;
    this.pingedTasks = [];
    this.clientRenderedBoundaries = [];
    this.completedBoundaries = [];
    this.partialBoundaries = [];
    this.trackedPostpones = null;
    this.onError = void 0 === onError2 ? defaultErrorHandler : onError2;
    this.onPostpone = void 0 === onPostpone ? noop : onPostpone;
    this.onAllReady = void 0 === onAllReady ? noop : onAllReady;
    this.onShellReady = void 0 === onShellReady ? noop : onShellReady;
    this.onShellError = void 0 === onShellError ? noop : onShellError;
    this.onFatalError = void 0 === onFatalError ? noop : onFatalError;
    this.formState = void 0 === formState ? null : formState;
  }
  function createRequest(
    children,
    resumableState,
    renderState,
    rootFormatContext,
    progressiveChunkSize,
    onError2,
    onAllReady,
    onShellReady,
    onShellError,
    onFatalError,
    onPostpone,
    formState,
  ) {
    resumableState = new RequestInstance(
      resumableState,
      renderState,
      rootFormatContext,
      progressiveChunkSize,
      onError2,
      onAllReady,
      onShellReady,
      onShellError,
      onFatalError,
      onPostpone,
      formState,
    );
    renderState = createPendingSegment(resumableState, 0, null, rootFormatContext, false, false);
    renderState.parentFlushed = true;
    children = createRenderTask(
      resumableState,
      null,
      children,
      -1,
      null,
      renderState,
      null,
      null,
      resumableState.abortableTasks,
      null,
      rootFormatContext,
      null,
      emptyTreeContext,
      null,
      null,
    );
    pushComponentStack(children);
    resumableState.pingedTasks.push(children);
    return resumableState;
  }
  var currentRequest = null;
  function pingTask(request, task) {
    request.pingedTasks.push(task);
    1 === request.pingedTasks.length &&
      ((request.flushScheduled = null !== request.destination), performWork(request));
  }
  function createSuspenseBoundary(
    request,
    row,
    fallbackAbortableTasks,
    contentPreamble,
    fallbackPreamble,
  ) {
    fallbackAbortableTasks = {
      status: 0,
      rootSegmentID: -1,
      parentFlushed: false,
      pendingTasks: 0,
      row,
      completedSegments: [],
      byteSize: 0,
      fallbackAbortableTasks,
      errorDigest: null,
      contentState: createHoistableState(),
      fallbackState: createHoistableState(),
      contentPreamble,
      fallbackPreamble,
      trackedContentKeyPath: null,
      trackedFallbackNode: null,
    };
    null !== row &&
      (row.pendingTasks++,
      (contentPreamble = row.boundaries),
      null !== contentPreamble &&
        (request.allPendingTasks++,
        fallbackAbortableTasks.pendingTasks++,
        contentPreamble.push(fallbackAbortableTasks)),
      (request = row.inheritedHoistables),
      null !== request && hoistHoistables(fallbackAbortableTasks.contentState, request));
    return fallbackAbortableTasks;
  }
  function createRenderTask(
    request,
    thenableState2,
    node,
    childIndex,
    blockedBoundary,
    blockedSegment,
    blockedPreamble,
    hoistableState,
    abortSet,
    keyPath,
    formatContext,
    context,
    treeContext,
    row,
    componentStack,
  ) {
    request.allPendingTasks++;
    null === blockedBoundary ? request.pendingRootTasks++ : blockedBoundary.pendingTasks++;
    null !== row && row.pendingTasks++;
    var task = {
      replay: null,
      node,
      childIndex,
      ping: function () {
        return pingTask(request, task);
      },
      blockedBoundary,
      blockedSegment,
      blockedPreamble,
      hoistableState,
      abortSet,
      keyPath,
      formatContext,
      context,
      treeContext,
      row,
      componentStack,
      thenableState: thenableState2,
    };
    abortSet.add(task);
    return task;
  }
  function createReplayTask(
    request,
    thenableState2,
    replay,
    node,
    childIndex,
    blockedBoundary,
    hoistableState,
    abortSet,
    keyPath,
    formatContext,
    context,
    treeContext,
    row,
    componentStack,
  ) {
    request.allPendingTasks++;
    null === blockedBoundary ? request.pendingRootTasks++ : blockedBoundary.pendingTasks++;
    null !== row && row.pendingTasks++;
    replay.pendingTasks++;
    var task = {
      replay,
      node,
      childIndex,
      ping: function () {
        return pingTask(request, task);
      },
      blockedBoundary,
      blockedSegment: null,
      blockedPreamble: null,
      hoistableState,
      abortSet,
      keyPath,
      formatContext,
      context,
      treeContext,
      row,
      componentStack,
      thenableState: thenableState2,
    };
    abortSet.add(task);
    return task;
  }
  function createPendingSegment(
    request,
    index,
    boundary,
    parentFormatContext,
    lastPushedText,
    textEmbedded,
  ) {
    return {
      status: 0,
      parentFlushed: false,
      id: -1,
      index,
      chunks: [],
      children: [],
      preambleChildren: [],
      parentFormatContext,
      boundary,
      lastPushedText,
      textEmbedded,
    };
  }
  function pushComponentStack(task) {
    var node = task.node;
    if ("object" === typeof node && null !== node)
      switch (node.$$typeof) {
        case REACT_ELEMENT_TYPE:
          task.componentStack = { parent: task.componentStack, type: node.type };
      }
  }
  function replaceSuspenseComponentStackWithSuspenseFallbackStack(componentStack) {
    return null === componentStack
      ? null
      : { parent: componentStack.parent, type: "Suspense Fallback" };
  }
  function getThrownInfo(node$jscomp$0) {
    var errorInfo = {};
    node$jscomp$0 &&
      Object.defineProperty(errorInfo, "componentStack", {
        configurable: true,
        enumerable: true,
        get: function () {
          try {
            var info = "",
              node = node$jscomp$0;
            do ((info += describeComponentStackByType(node.type)), (node = node.parent));
            while (node);
            var JSCompiler_inline_result = info;
          } catch (x3) {
            JSCompiler_inline_result = "\nError generating stack: " + x3.message + "\n" + x3.stack;
          }
          Object.defineProperty(errorInfo, "componentStack", {
            value: JSCompiler_inline_result,
          });
          return JSCompiler_inline_result;
        },
      });
    return errorInfo;
  }
  function logRecoverableError(request, error, errorInfo) {
    request = request.onError;
    error = request(error, errorInfo);
    if (null == error || "string" === typeof error) return error;
  }
  function fatalError(request, error) {
    var onShellError = request.onShellError,
      onFatalError = request.onFatalError;
    onShellError(error);
    onFatalError(error);
    null !== request.destination
      ? ((request.status = 14), request.destination.destroy(error))
      : ((request.status = 13), (request.fatalError = error));
  }
  function finishSuspenseListRow(request, row) {
    unblockSuspenseListRow(request, row.next, row.hoistables);
  }
  function unblockSuspenseListRow(request, unblockedRow, inheritedHoistables) {
    for (; null !== unblockedRow; ) {
      null !== inheritedHoistables &&
        (hoistHoistables(unblockedRow.hoistables, inheritedHoistables),
        (unblockedRow.inheritedHoistables = inheritedHoistables));
      var unblockedBoundaries = unblockedRow.boundaries;
      if (null !== unblockedBoundaries) {
        unblockedRow.boundaries = null;
        for (var i = 0; i < unblockedBoundaries.length; i++) {
          var unblockedBoundary = unblockedBoundaries[i];
          null !== inheritedHoistables &&
            hoistHoistables(unblockedBoundary.contentState, inheritedHoistables);
          finishedTask(request, unblockedBoundary, null, null);
        }
      }
      unblockedRow.pendingTasks--;
      if (0 < unblockedRow.pendingTasks) break;
      inheritedHoistables = unblockedRow.hoistables;
      unblockedRow = unblockedRow.next;
    }
  }
  function tryToResolveTogetherRow(request, togetherRow) {
    var boundaries = togetherRow.boundaries;
    if (null !== boundaries && togetherRow.pendingTasks === boundaries.length) {
      for (var allCompleteAndInlinable = true, i = 0; i < boundaries.length; i++) {
        var rowBoundary = boundaries[i];
        if (
          1 !== rowBoundary.pendingTasks ||
          rowBoundary.parentFlushed ||
          isEligibleForOutlining(request, rowBoundary)
        ) {
          allCompleteAndInlinable = false;
          break;
        }
      }
      allCompleteAndInlinable &&
        unblockSuspenseListRow(request, togetherRow, togetherRow.hoistables);
    }
  }
  function createSuspenseListRow(previousRow) {
    var newRow = {
      pendingTasks: 1,
      boundaries: null,
      hoistables: createHoistableState(),
      inheritedHoistables: null,
      together: false,
      next: null,
    };
    null !== previousRow &&
      0 < previousRow.pendingTasks &&
      (newRow.pendingTasks++, (newRow.boundaries = []), (previousRow.next = newRow));
    return newRow;
  }
  function renderSuspenseListRows(request, task, keyPath, rows, revealOrder) {
    var prevKeyPath = task.keyPath,
      prevTreeContext = task.treeContext,
      prevRow = task.row;
    task.keyPath = keyPath;
    keyPath = rows.length;
    var previousSuspenseListRow = null;
    if (null !== task.replay) {
      var resumeSlots = task.replay.slots;
      if (null !== resumeSlots && "object" === typeof resumeSlots)
        for (var n2 = 0; n2 < keyPath; n2++) {
          var i =
              "backwards" !== revealOrder && "unstable_legacy-backwards" !== revealOrder
                ? n2
                : keyPath - 1 - n2,
            node = rows[i];
          task.row = previousSuspenseListRow = createSuspenseListRow(previousSuspenseListRow);
          task.treeContext = pushTreeContext(prevTreeContext, keyPath, i);
          var resumeSegmentID = resumeSlots[i];
          "number" === typeof resumeSegmentID
            ? (resumeNode(request, task, resumeSegmentID, node, i), delete resumeSlots[i])
            : renderNode(request, task, node, i);
          0 === --previousSuspenseListRow.pendingTasks &&
            finishSuspenseListRow(request, previousSuspenseListRow);
        }
      else
        for (resumeSlots = 0; resumeSlots < keyPath; resumeSlots++)
          ((n2 =
            "backwards" !== revealOrder && "unstable_legacy-backwards" !== revealOrder
              ? resumeSlots
              : keyPath - 1 - resumeSlots),
            (i = rows[n2]),
            (task.row = previousSuspenseListRow = createSuspenseListRow(previousSuspenseListRow)),
            (task.treeContext = pushTreeContext(prevTreeContext, keyPath, n2)),
            renderNode(request, task, i, n2),
            0 === --previousSuspenseListRow.pendingTasks &&
              finishSuspenseListRow(request, previousSuspenseListRow));
    } else if ("backwards" !== revealOrder && "unstable_legacy-backwards" !== revealOrder)
      for (revealOrder = 0; revealOrder < keyPath; revealOrder++)
        ((resumeSlots = rows[revealOrder]),
          (task.row = previousSuspenseListRow = createSuspenseListRow(previousSuspenseListRow)),
          (task.treeContext = pushTreeContext(prevTreeContext, keyPath, revealOrder)),
          renderNode(request, task, resumeSlots, revealOrder),
          0 === --previousSuspenseListRow.pendingTasks &&
            finishSuspenseListRow(request, previousSuspenseListRow));
    else {
      revealOrder = task.blockedSegment;
      resumeSlots = revealOrder.children.length;
      n2 = revealOrder.chunks.length;
      for (i = keyPath - 1; 0 <= i; i--) {
        node = rows[i];
        task.row = previousSuspenseListRow = createSuspenseListRow(previousSuspenseListRow);
        task.treeContext = pushTreeContext(prevTreeContext, keyPath, i);
        resumeSegmentID = createPendingSegment(
          request,
          n2,
          null,
          task.formatContext,
          0 === i ? revealOrder.lastPushedText : true,
          true,
        );
        revealOrder.children.splice(resumeSlots, 0, resumeSegmentID);
        task.blockedSegment = resumeSegmentID;
        try {
          (renderNode(request, task, node, i),
            pushSegmentFinale(
              resumeSegmentID.chunks,
              request.renderState,
              resumeSegmentID.lastPushedText,
              resumeSegmentID.textEmbedded,
            ),
            (resumeSegmentID.status = 1),
            0 === --previousSuspenseListRow.pendingTasks &&
              finishSuspenseListRow(request, previousSuspenseListRow));
        } catch (thrownValue) {
          throw ((resumeSegmentID.status = 12 === request.status ? 3 : 4), thrownValue);
        }
      }
      task.blockedSegment = revealOrder;
      revealOrder.lastPushedText = false;
    }
    null !== prevRow &&
      null !== previousSuspenseListRow &&
      0 < previousSuspenseListRow.pendingTasks &&
      (prevRow.pendingTasks++, (previousSuspenseListRow.next = prevRow));
    task.treeContext = prevTreeContext;
    task.row = prevRow;
    task.keyPath = prevKeyPath;
  }
  function renderWithHooks(request, task, keyPath, Component, props, secondArg) {
    var prevThenableState = task.thenableState;
    task.thenableState = null;
    currentlyRenderingComponent = {};
    currentlyRenderingTask = task;
    currentlyRenderingRequest = request;
    currentlyRenderingKeyPath = keyPath;
    actionStateCounter = localIdCounter = 0;
    actionStateMatchingIndex = -1;
    thenableIndexCounter = 0;
    thenableState = prevThenableState;
    for (request = Component(props, secondArg); didScheduleRenderPhaseUpdate; )
      ((didScheduleRenderPhaseUpdate = false),
        (actionStateCounter = localIdCounter = 0),
        (actionStateMatchingIndex = -1),
        (thenableIndexCounter = 0),
        (numberOfReRenders += 1),
        (workInProgressHook = null),
        (request = Component(props, secondArg)));
    resetHooksState();
    return request;
  }
  function finishFunctionComponent(
    request,
    task,
    keyPath,
    children,
    hasId,
    actionStateCount,
    actionStateMatchingIndex2,
  ) {
    var didEmitActionStateMarkers = false;
    if (0 !== actionStateCount && null !== request.formState) {
      var segment = task.blockedSegment;
      if (null !== segment) {
        didEmitActionStateMarkers = true;
        segment = segment.chunks;
        for (var i = 0; i < actionStateCount; i++)
          i === actionStateMatchingIndex2 ? segment.push("<!--F!-->") : segment.push("<!--F-->");
      }
    }
    actionStateCount = task.keyPath;
    task.keyPath = keyPath;
    hasId
      ? ((keyPath = task.treeContext),
        (task.treeContext = pushTreeContext(keyPath, 1, 0)),
        renderNode(request, task, children, -1),
        (task.treeContext = keyPath))
      : didEmitActionStateMarkers
        ? renderNode(request, task, children, -1)
        : renderNodeDestructive(request, task, children, -1);
    task.keyPath = actionStateCount;
  }
  function renderElement(request, task, keyPath, type, props, ref) {
    if ("function" === typeof type)
      if (type.prototype && type.prototype.isReactComponent) {
        var newProps = props;
        if ("ref" in props) {
          newProps = {};
          for (var propName in props) "ref" !== propName && (newProps[propName] = props[propName]);
        }
        var defaultProps = type.defaultProps;
        if (defaultProps) {
          newProps === props && (newProps = assign({}, newProps, props));
          for (var propName$43 in defaultProps)
            void 0 === newProps[propName$43] && (newProps[propName$43] = defaultProps[propName$43]);
        }
        props = newProps;
        newProps = emptyContextObject;
        defaultProps = type.contextType;
        "object" === typeof defaultProps &&
          null !== defaultProps &&
          (newProps = defaultProps._currentValue2);
        newProps = new type(props, newProps);
        var initialState = void 0 !== newProps.state ? newProps.state : null;
        newProps.updater = classComponentUpdater;
        newProps.props = props;
        newProps.state = initialState;
        defaultProps = { queue: [], replace: false };
        newProps._reactInternals = defaultProps;
        ref = type.contextType;
        newProps.context =
          "object" === typeof ref && null !== ref ? ref._currentValue2 : emptyContextObject;
        ref = type.getDerivedStateFromProps;
        "function" === typeof ref &&
          ((ref = ref(props, initialState)),
          (initialState =
            null === ref || void 0 === ref ? initialState : assign({}, initialState, ref)),
          (newProps.state = initialState));
        if (
          "function" !== typeof type.getDerivedStateFromProps &&
          "function" !== typeof newProps.getSnapshotBeforeUpdate &&
          ("function" === typeof newProps.UNSAFE_componentWillMount ||
            "function" === typeof newProps.componentWillMount)
        )
          if (
            ((type = newProps.state),
            "function" === typeof newProps.componentWillMount && newProps.componentWillMount(),
            "function" === typeof newProps.UNSAFE_componentWillMount &&
              newProps.UNSAFE_componentWillMount(),
            type !== newProps.state &&
              classComponentUpdater.enqueueReplaceState(newProps, newProps.state, null),
            null !== defaultProps.queue && 0 < defaultProps.queue.length)
          )
            if (
              ((type = defaultProps.queue),
              (ref = defaultProps.replace),
              (defaultProps.queue = null),
              (defaultProps.replace = false),
              ref && 1 === type.length)
            )
              newProps.state = type[0];
            else {
              defaultProps = ref ? type[0] : newProps.state;
              initialState = true;
              for (ref = ref ? 1 : 0; ref < type.length; ref++)
                ((propName$43 = type[ref]),
                  (propName$43 =
                    "function" === typeof propName$43
                      ? propName$43.call(newProps, defaultProps, props, void 0)
                      : propName$43),
                  null != propName$43 &&
                    (initialState
                      ? ((initialState = false),
                        (defaultProps = assign({}, defaultProps, propName$43)))
                      : assign(defaultProps, propName$43)));
              newProps.state = defaultProps;
            }
          else defaultProps.queue = null;
        type = newProps.render();
        if (12 === request.status) throw null;
        props = task.keyPath;
        task.keyPath = keyPath;
        renderNodeDestructive(request, task, type, -1);
        task.keyPath = props;
      } else {
        type = renderWithHooks(request, task, keyPath, type, props, void 0);
        if (12 === request.status) throw null;
        finishFunctionComponent(
          request,
          task,
          keyPath,
          type,
          0 !== localIdCounter,
          actionStateCounter,
          actionStateMatchingIndex,
        );
      }
    else if ("string" === typeof type)
      if (((newProps = task.blockedSegment), null === newProps))
        ((newProps = props.children),
          (defaultProps = task.formatContext),
          (initialState = task.keyPath),
          (task.formatContext = getChildFormatContext(defaultProps, type, props)),
          (task.keyPath = keyPath),
          renderNode(request, task, newProps, -1),
          (task.formatContext = defaultProps),
          (task.keyPath = initialState));
      else {
        initialState = pushStartInstance(
          newProps.chunks,
          type,
          props,
          request.resumableState,
          request.renderState,
          task.blockedPreamble,
          task.hoistableState,
          task.formatContext,
          newProps.lastPushedText,
        );
        newProps.lastPushedText = false;
        defaultProps = task.formatContext;
        ref = task.keyPath;
        task.keyPath = keyPath;
        if (
          3 ===
          (task.formatContext = getChildFormatContext(defaultProps, type, props)).insertionMode
        ) {
          keyPath = createPendingSegment(request, 0, null, task.formatContext, false, false);
          newProps.preambleChildren.push(keyPath);
          task.blockedSegment = keyPath;
          try {
            ((keyPath.status = 6),
              renderNode(request, task, initialState, -1),
              pushSegmentFinale(
                keyPath.chunks,
                request.renderState,
                keyPath.lastPushedText,
                keyPath.textEmbedded,
              ),
              (keyPath.status = 1));
          } finally {
            task.blockedSegment = newProps;
          }
        } else renderNode(request, task, initialState, -1);
        task.formatContext = defaultProps;
        task.keyPath = ref;
        a: {
          task = newProps.chunks;
          request = request.resumableState;
          switch (type) {
            case "title":
            case "style":
            case "script":
            case "area":
            case "base":
            case "br":
            case "col":
            case "embed":
            case "hr":
            case "img":
            case "input":
            case "keygen":
            case "link":
            case "meta":
            case "param":
            case "source":
            case "track":
            case "wbr":
              break a;
            case "body":
              if (1 >= defaultProps.insertionMode) {
                request.hasBody = true;
                break a;
              }
              break;
            case "html":
              if (0 === defaultProps.insertionMode) {
                request.hasHtml = true;
                break a;
              }
              break;
            case "head":
              if (1 >= defaultProps.insertionMode) break a;
          }
          task.push(endChunkForTag(type));
        }
        newProps.lastPushedText = false;
      }
    else {
      switch (type) {
        case REACT_LEGACY_HIDDEN_TYPE:
        case REACT_STRICT_MODE_TYPE:
        case REACT_PROFILER_TYPE:
        case REACT_FRAGMENT_TYPE:
          type = task.keyPath;
          task.keyPath = keyPath;
          renderNodeDestructive(request, task, props.children, -1);
          task.keyPath = type;
          return;
        case REACT_ACTIVITY_TYPE:
          type = task.blockedSegment;
          null === type
            ? "hidden" !== props.mode &&
              ((type = task.keyPath),
              (task.keyPath = keyPath),
              renderNode(request, task, props.children, -1),
              (task.keyPath = type))
            : "hidden" !== props.mode &&
              (request.renderState.generateStaticMarkup || type.chunks.push("<!--&-->"),
              (type.lastPushedText = false),
              (newProps = task.keyPath),
              (task.keyPath = keyPath),
              renderNode(request, task, props.children, -1),
              (task.keyPath = newProps),
              request.renderState.generateStaticMarkup || type.chunks.push("<!--/&-->"),
              (type.lastPushedText = false));
          return;
        case REACT_SUSPENSE_LIST_TYPE:
          a: {
            type = props.children;
            props = props.revealOrder;
            if (
              "forwards" === props ||
              "backwards" === props ||
              "unstable_legacy-backwards" === props
            ) {
              if (isArrayImpl(type)) {
                renderSuspenseListRows(request, task, keyPath, type, props);
                break a;
              }
              if ((newProps = getIteratorFn(type))) {
                if ((newProps = newProps.call(type))) {
                  defaultProps = newProps.next();
                  if (!defaultProps.done) {
                    do defaultProps = newProps.next();
                    while (!defaultProps.done);
                    renderSuspenseListRows(request, task, keyPath, type, props);
                  }
                  break a;
                }
              }
            }
            "together" === props
              ? ((props = task.keyPath),
                (newProps = task.row),
                (defaultProps = task.row = createSuspenseListRow(null)),
                (defaultProps.boundaries = []),
                (defaultProps.together = true),
                (task.keyPath = keyPath),
                renderNodeDestructive(request, task, type, -1),
                0 === --defaultProps.pendingTasks && finishSuspenseListRow(request, defaultProps),
                (task.keyPath = props),
                (task.row = newProps),
                null !== newProps &&
                  0 < defaultProps.pendingTasks &&
                  (newProps.pendingTasks++, (defaultProps.next = newProps)))
              : ((props = task.keyPath),
                (task.keyPath = keyPath),
                renderNodeDestructive(request, task, type, -1),
                (task.keyPath = props));
          }
          return;
        case REACT_VIEW_TRANSITION_TYPE:
        case REACT_SCOPE_TYPE:
          throw Error(formatProdErrorMessage(343));
        case REACT_SUSPENSE_TYPE:
          a: if (null !== task.replay) {
            type = task.keyPath;
            newProps = task.formatContext;
            defaultProps = task.row;
            task.keyPath = keyPath;
            task.formatContext = getSuspenseContentFormatContext(request.resumableState, newProps);
            task.row = null;
            keyPath = props.children;
            try {
              renderNode(request, task, keyPath, -1);
            } finally {
              ((task.keyPath = type), (task.formatContext = newProps), (task.row = defaultProps));
            }
          } else {
            type = task.keyPath;
            ref = task.formatContext;
            var prevRow = task.row,
              parentBoundary = task.blockedBoundary;
            propName$43 = task.blockedPreamble;
            var parentHoistableState = task.hoistableState;
            propName = task.blockedSegment;
            var fallback = props.fallback;
            props = props.children;
            var fallbackAbortSet = /* @__PURE__ */ new Set();
            var newBoundary = createSuspenseBoundary(
              request,
              task.row,
              fallbackAbortSet,
              null,
              null,
            );
            null !== request.trackedPostpones && (newBoundary.trackedContentKeyPath = keyPath);
            var boundarySegment = createPendingSegment(
              request,
              propName.chunks.length,
              newBoundary,
              task.formatContext,
              false,
              false,
            );
            propName.children.push(boundarySegment);
            propName.lastPushedText = false;
            var contentRootSegment = createPendingSegment(
              request,
              0,
              null,
              task.formatContext,
              false,
              false,
            );
            contentRootSegment.parentFlushed = true;
            if (null !== request.trackedPostpones) {
              newProps = task.componentStack;
              defaultProps = [keyPath[0], "Suspense Fallback", keyPath[2]];
              initialState = [defaultProps[1], defaultProps[2], [], null];
              request.trackedPostpones.workingMap.set(defaultProps, initialState);
              newBoundary.trackedFallbackNode = initialState;
              task.blockedSegment = boundarySegment;
              task.blockedPreamble = newBoundary.fallbackPreamble;
              task.keyPath = defaultProps;
              task.formatContext = getSuspenseFallbackFormatContext(request.resumableState, ref);
              task.componentStack =
                replaceSuspenseComponentStackWithSuspenseFallbackStack(newProps);
              boundarySegment.status = 6;
              try {
                (renderNode(request, task, fallback, -1),
                  pushSegmentFinale(
                    boundarySegment.chunks,
                    request.renderState,
                    boundarySegment.lastPushedText,
                    boundarySegment.textEmbedded,
                  ),
                  (boundarySegment.status = 1));
              } catch (thrownValue) {
                throw ((boundarySegment.status = 12 === request.status ? 3 : 4), thrownValue);
              } finally {
                ((task.blockedSegment = propName),
                  (task.blockedPreamble = propName$43),
                  (task.keyPath = type),
                  (task.formatContext = ref));
              }
              task = createRenderTask(
                request,
                null,
                props,
                -1,
                newBoundary,
                contentRootSegment,
                newBoundary.contentPreamble,
                newBoundary.contentState,
                task.abortSet,
                keyPath,
                getSuspenseContentFormatContext(request.resumableState, task.formatContext),
                task.context,
                task.treeContext,
                null,
                newProps,
              );
              pushComponentStack(task);
              request.pingedTasks.push(task);
            } else {
              task.blockedBoundary = newBoundary;
              task.blockedPreamble = newBoundary.contentPreamble;
              task.hoistableState = newBoundary.contentState;
              task.blockedSegment = contentRootSegment;
              task.keyPath = keyPath;
              task.formatContext = getSuspenseContentFormatContext(request.resumableState, ref);
              task.row = null;
              contentRootSegment.status = 6;
              try {
                if (
                  (renderNode(request, task, props, -1),
                  pushSegmentFinale(
                    contentRootSegment.chunks,
                    request.renderState,
                    contentRootSegment.lastPushedText,
                    contentRootSegment.textEmbedded,
                  ),
                  (contentRootSegment.status = 1),
                  queueCompletedSegment(newBoundary, contentRootSegment),
                  0 === newBoundary.pendingTasks && 0 === newBoundary.status)
                ) {
                  if (((newBoundary.status = 1), !isEligibleForOutlining(request, newBoundary))) {
                    null !== prevRow &&
                      0 === --prevRow.pendingTasks &&
                      finishSuspenseListRow(request, prevRow);
                    0 === request.pendingRootTasks &&
                      task.blockedPreamble &&
                      preparePreamble(request);
                    break a;
                  }
                } else
                  null !== prevRow && prevRow.together && tryToResolveTogetherRow(request, prevRow);
              } catch (thrownValue$30) {
                ((newBoundary.status = 4),
                  12 === request.status
                    ? ((contentRootSegment.status = 3), (newProps = request.fatalError))
                    : ((contentRootSegment.status = 4), (newProps = thrownValue$30)),
                  (defaultProps = getThrownInfo(task.componentStack)),
                  (initialState = logRecoverableError(request, newProps, defaultProps)),
                  (newBoundary.errorDigest = initialState),
                  untrackBoundary(request, newBoundary));
              } finally {
                ((task.blockedBoundary = parentBoundary),
                  (task.blockedPreamble = propName$43),
                  (task.hoistableState = parentHoistableState),
                  (task.blockedSegment = propName),
                  (task.keyPath = type),
                  (task.formatContext = ref),
                  (task.row = prevRow));
              }
              task = createRenderTask(
                request,
                null,
                fallback,
                -1,
                parentBoundary,
                boundarySegment,
                newBoundary.fallbackPreamble,
                newBoundary.fallbackState,
                fallbackAbortSet,
                [keyPath[0], "Suspense Fallback", keyPath[2]],
                getSuspenseFallbackFormatContext(request.resumableState, task.formatContext),
                task.context,
                task.treeContext,
                task.row,
                replaceSuspenseComponentStackWithSuspenseFallbackStack(task.componentStack),
              );
              pushComponentStack(task);
              request.pingedTasks.push(task);
            }
          }
          return;
      }
      if ("object" === typeof type && null !== type)
        switch (type.$$typeof) {
          case REACT_FORWARD_REF_TYPE:
            if ("ref" in props)
              for (fallback in ((newProps = {}), props))
                "ref" !== fallback && (newProps[fallback] = props[fallback]);
            else newProps = props;
            type = renderWithHooks(request, task, keyPath, type.render, newProps, ref);
            finishFunctionComponent(
              request,
              task,
              keyPath,
              type,
              0 !== localIdCounter,
              actionStateCounter,
              actionStateMatchingIndex,
            );
            return;
          case REACT_MEMO_TYPE:
            renderElement(request, task, keyPath, type.type, props, ref);
            return;
          case REACT_CONTEXT_TYPE:
            defaultProps = props.children;
            newProps = task.keyPath;
            props = props.value;
            initialState = type._currentValue2;
            type._currentValue2 = props;
            ref = currentActiveSnapshot;
            currentActiveSnapshot = type = {
              parent: ref,
              depth: null === ref ? 0 : ref.depth + 1,
              context: type,
              parentValue: initialState,
              value: props,
            };
            task.context = type;
            task.keyPath = keyPath;
            renderNodeDestructive(request, task, defaultProps, -1);
            request = currentActiveSnapshot;
            if (null === request) throw Error(formatProdErrorMessage(403));
            request.context._currentValue2 = request.parentValue;
            request = currentActiveSnapshot = request.parent;
            task.context = request;
            task.keyPath = newProps;
            return;
          case REACT_CONSUMER_TYPE:
            props = props.children;
            type = props(type._context._currentValue2);
            props = task.keyPath;
            task.keyPath = keyPath;
            renderNodeDestructive(request, task, type, -1);
            task.keyPath = props;
            return;
          case REACT_LAZY_TYPE:
            newProps = type._init;
            type = newProps(type._payload);
            if (12 === request.status) throw null;
            renderElement(request, task, keyPath, type, props, ref);
            return;
        }
      throw Error(formatProdErrorMessage(130, null == type ? type : typeof type, ""));
    }
  }
  function resumeNode(request, task, segmentId, node, childIndex) {
    var prevReplay = task.replay,
      blockedBoundary = task.blockedBoundary,
      resumedSegment = createPendingSegment(request, 0, null, task.formatContext, false, false);
    resumedSegment.id = segmentId;
    resumedSegment.parentFlushed = true;
    try {
      ((task.replay = null),
        (task.blockedSegment = resumedSegment),
        renderNode(request, task, node, childIndex),
        (resumedSegment.status = 1),
        null === blockedBoundary
          ? (request.completedRootSegment = resumedSegment)
          : (queueCompletedSegment(blockedBoundary, resumedSegment),
            blockedBoundary.parentFlushed && request.partialBoundaries.push(blockedBoundary)));
    } finally {
      ((task.replay = prevReplay), (task.blockedSegment = null));
    }
  }
  function renderNodeDestructive(request, task, node, childIndex) {
    null !== task.replay && "number" === typeof task.replay.slots
      ? resumeNode(request, task, task.replay.slots, node, childIndex)
      : ((task.node = node),
        (task.childIndex = childIndex),
        (node = task.componentStack),
        pushComponentStack(task),
        retryNode(request, task),
        (task.componentStack = node));
  }
  function retryNode(request, task) {
    var node = task.node,
      childIndex = task.childIndex;
    if (null !== node) {
      if ("object" === typeof node) {
        switch (node.$$typeof) {
          case REACT_ELEMENT_TYPE:
            var type = node.type,
              key = node.key,
              props = node.props;
            node = props.ref;
            var ref = void 0 !== node ? node : null,
              name = getComponentNameFromType(type),
              keyOrIndex = null == key ? (-1 === childIndex ? 0 : childIndex) : key;
            key = [task.keyPath, name, keyOrIndex];
            if (null !== task.replay)
              a: {
                var replay = task.replay;
                childIndex = replay.nodes;
                for (node = 0; node < childIndex.length; node++) {
                  var node$jscomp$0 = childIndex[node];
                  if (keyOrIndex === node$jscomp$0[1]) {
                    if (4 === node$jscomp$0.length) {
                      if (null !== name && name !== node$jscomp$0[0])
                        throw Error(formatProdErrorMessage(490, node$jscomp$0[0], name));
                      var childNodes = node$jscomp$0[2];
                      name = node$jscomp$0[3];
                      keyOrIndex = task.node;
                      task.replay = {
                        nodes: childNodes,
                        slots: name,
                        pendingTasks: 1,
                      };
                      try {
                        renderElement(request, task, key, type, props, ref);
                        if (1 === task.replay.pendingTasks && 0 < task.replay.nodes.length)
                          throw Error(formatProdErrorMessage(488));
                        task.replay.pendingTasks--;
                      } catch (x3) {
                        if (
                          "object" === typeof x3 &&
                          null !== x3 &&
                          (x3 === SuspenseException || "function" === typeof x3.then)
                        )
                          throw (
                            task.node === keyOrIndex
                              ? (task.replay = replay)
                              : childIndex.splice(node, 1),
                            x3
                          );
                        task.replay.pendingTasks--;
                        props = getThrownInfo(task.componentStack);
                        key = request;
                        request = task.blockedBoundary;
                        type = x3;
                        props = logRecoverableError(key, type, props);
                        abortRemainingReplayNodes(key, request, childNodes, name, type, props);
                      }
                      task.replay = replay;
                    } else {
                      if (type !== REACT_SUSPENSE_TYPE)
                        throw Error(
                          formatProdErrorMessage(
                            490,
                            "Suspense",
                            getComponentNameFromType(type) || "Unknown",
                          ),
                        );
                      b: {
                        replay = void 0;
                        type = node$jscomp$0[5];
                        ref = node$jscomp$0[2];
                        name = node$jscomp$0[3];
                        keyOrIndex = null === node$jscomp$0[4] ? [] : node$jscomp$0[4][2];
                        node$jscomp$0 = null === node$jscomp$0[4] ? null : node$jscomp$0[4][3];
                        var prevKeyPath = task.keyPath,
                          prevContext = task.formatContext,
                          prevRow = task.row,
                          previousReplaySet = task.replay,
                          parentBoundary = task.blockedBoundary,
                          parentHoistableState = task.hoistableState,
                          content = props.children,
                          fallback = props.fallback,
                          fallbackAbortSet = /* @__PURE__ */ new Set();
                        props = createSuspenseBoundary(
                          request,
                          task.row,
                          fallbackAbortSet,
                          null,
                          null,
                        );
                        props.parentFlushed = true;
                        props.rootSegmentID = type;
                        task.blockedBoundary = props;
                        task.hoistableState = props.contentState;
                        task.keyPath = key;
                        task.formatContext = getSuspenseContentFormatContext(
                          request.resumableState,
                          prevContext,
                        );
                        task.row = null;
                        task.replay = {
                          nodes: ref,
                          slots: name,
                          pendingTasks: 1,
                        };
                        try {
                          renderNode(request, task, content, -1);
                          if (1 === task.replay.pendingTasks && 0 < task.replay.nodes.length)
                            throw Error(formatProdErrorMessage(488));
                          task.replay.pendingTasks--;
                          if (0 === props.pendingTasks && 0 === props.status) {
                            props.status = 1;
                            request.completedBoundaries.push(props);
                            break b;
                          }
                        } catch (error) {
                          ((props.status = 4),
                            (childNodes = getThrownInfo(task.componentStack)),
                            (replay = logRecoverableError(request, error, childNodes)),
                            (props.errorDigest = replay),
                            task.replay.pendingTasks--,
                            request.clientRenderedBoundaries.push(props));
                        } finally {
                          ((task.blockedBoundary = parentBoundary),
                            (task.hoistableState = parentHoistableState),
                            (task.replay = previousReplaySet),
                            (task.keyPath = prevKeyPath),
                            (task.formatContext = prevContext),
                            (task.row = prevRow));
                        }
                        childNodes = createReplayTask(
                          request,
                          null,
                          {
                            nodes: keyOrIndex,
                            slots: node$jscomp$0,
                            pendingTasks: 0,
                          },
                          fallback,
                          -1,
                          parentBoundary,
                          props.fallbackState,
                          fallbackAbortSet,
                          [key[0], "Suspense Fallback", key[2]],
                          getSuspenseFallbackFormatContext(
                            request.resumableState,
                            task.formatContext,
                          ),
                          task.context,
                          task.treeContext,
                          task.row,
                          replaceSuspenseComponentStackWithSuspenseFallbackStack(
                            task.componentStack,
                          ),
                        );
                        pushComponentStack(childNodes);
                        request.pingedTasks.push(childNodes);
                      }
                    }
                    childIndex.splice(node, 1);
                    break a;
                  }
                }
              }
            else renderElement(request, task, key, type, props, ref);
            return;
          case REACT_PORTAL_TYPE:
            throw Error(formatProdErrorMessage(257));
          case REACT_LAZY_TYPE:
            childNodes = node._init;
            node = childNodes(node._payload);
            if (12 === request.status) throw null;
            renderNodeDestructive(request, task, node, childIndex);
            return;
        }
        if (isArrayImpl(node)) {
          renderChildrenArray(request, task, node, childIndex);
          return;
        }
        if ((childNodes = getIteratorFn(node))) {
          if ((childNodes = childNodes.call(node))) {
            node = childNodes.next();
            if (!node.done) {
              props = [];
              do (props.push(node.value), (node = childNodes.next()));
              while (!node.done);
              renderChildrenArray(request, task, props, childIndex);
            }
            return;
          }
        }
        if ("function" === typeof node.then)
          return (
            (task.thenableState = null),
            renderNodeDestructive(request, task, unwrapThenable(node), childIndex)
          );
        if (node.$$typeof === REACT_CONTEXT_TYPE)
          return renderNodeDestructive(request, task, node._currentValue2, childIndex);
        childIndex = Object.prototype.toString.call(node);
        throw Error(
          formatProdErrorMessage(
            31,
            "[object Object]" === childIndex
              ? "object with keys {" + Object.keys(node).join(", ") + "}"
              : childIndex,
          ),
        );
      }
      if ("string" === typeof node)
        ((childIndex = task.blockedSegment),
          null !== childIndex &&
            (childIndex.lastPushedText = pushTextInstance(
              childIndex.chunks,
              node,
              request.renderState,
              childIndex.lastPushedText,
            )));
      else if ("number" === typeof node || "bigint" === typeof node)
        ((childIndex = task.blockedSegment),
          null !== childIndex &&
            (childIndex.lastPushedText = pushTextInstance(
              childIndex.chunks,
              "" + node,
              request.renderState,
              childIndex.lastPushedText,
            )));
    }
  }
  function renderChildrenArray(request, task, children, childIndex) {
    var prevKeyPath = task.keyPath;
    if (
      -1 !== childIndex &&
      ((task.keyPath = [task.keyPath, "Fragment", childIndex]), null !== task.replay)
    ) {
      for (
        var replay = task.replay, replayNodes = replay.nodes, j2 = 0;
        j2 < replayNodes.length;
        j2++
      ) {
        var node = replayNodes[j2];
        if (node[1] === childIndex) {
          childIndex = node[2];
          node = node[3];
          task.replay = { nodes: childIndex, slots: node, pendingTasks: 1 };
          try {
            renderChildrenArray(request, task, children, -1);
            if (1 === task.replay.pendingTasks && 0 < task.replay.nodes.length)
              throw Error(formatProdErrorMessage(488));
            task.replay.pendingTasks--;
          } catch (x3) {
            if (
              "object" === typeof x3 &&
              null !== x3 &&
              (x3 === SuspenseException || "function" === typeof x3.then)
            )
              throw x3;
            task.replay.pendingTasks--;
            children = getThrownInfo(task.componentStack);
            var boundary = task.blockedBoundary,
              error = x3;
            children = logRecoverableError(request, error, children);
            abortRemainingReplayNodes(request, boundary, childIndex, node, error, children);
          }
          task.replay = replay;
          replayNodes.splice(j2, 1);
          break;
        }
      }
      task.keyPath = prevKeyPath;
      return;
    }
    replay = task.treeContext;
    replayNodes = children.length;
    if (null !== task.replay && ((j2 = task.replay.slots), null !== j2 && "object" === typeof j2)) {
      for (childIndex = 0; childIndex < replayNodes; childIndex++)
        ((node = children[childIndex]),
          (task.treeContext = pushTreeContext(replay, replayNodes, childIndex)),
          (boundary = j2[childIndex]),
          "number" === typeof boundary
            ? (resumeNode(request, task, boundary, node, childIndex), delete j2[childIndex])
            : renderNode(request, task, node, childIndex));
      task.treeContext = replay;
      task.keyPath = prevKeyPath;
      return;
    }
    for (j2 = 0; j2 < replayNodes; j2++)
      ((childIndex = children[j2]),
        (task.treeContext = pushTreeContext(replay, replayNodes, j2)),
        renderNode(request, task, childIndex, j2));
    task.treeContext = replay;
    task.keyPath = prevKeyPath;
  }
  function trackPostponedBoundary(request, trackedPostpones, boundary) {
    boundary.status = 5;
    boundary.rootSegmentID = request.nextSegmentId++;
    request = boundary.trackedContentKeyPath;
    if (null === request) throw Error(formatProdErrorMessage(486));
    var fallbackReplayNode = boundary.trackedFallbackNode,
      children = [],
      boundaryNode = trackedPostpones.workingMap.get(request);
    if (void 0 === boundaryNode)
      return (
        (boundary = [
          request[1],
          request[2],
          children,
          null,
          fallbackReplayNode,
          boundary.rootSegmentID,
        ]),
        trackedPostpones.workingMap.set(request, boundary),
        addToReplayParent(boundary, request[0], trackedPostpones),
        boundary
      );
    boundaryNode[4] = fallbackReplayNode;
    boundaryNode[5] = boundary.rootSegmentID;
    return boundaryNode;
  }
  function trackPostpone(request, trackedPostpones, task, segment) {
    segment.status = 5;
    var keyPath = task.keyPath,
      boundary = task.blockedBoundary;
    if (null === boundary)
      ((segment.id = request.nextSegmentId++),
        (trackedPostpones.rootSlots = segment.id),
        null !== request.completedRootSegment && (request.completedRootSegment.status = 5));
    else {
      if (null !== boundary && 0 === boundary.status) {
        var boundaryNode = trackPostponedBoundary(request, trackedPostpones, boundary);
        if (boundary.trackedContentKeyPath === keyPath && -1 === task.childIndex) {
          -1 === segment.id &&
            (segment.id = segment.parentFlushed ? boundary.rootSegmentID : request.nextSegmentId++);
          boundaryNode[3] = segment.id;
          return;
        }
      }
      -1 === segment.id &&
        (segment.id =
          segment.parentFlushed && null !== boundary
            ? boundary.rootSegmentID
            : request.nextSegmentId++);
      if (-1 === task.childIndex)
        null === keyPath
          ? (trackedPostpones.rootSlots = segment.id)
          : ((task = trackedPostpones.workingMap.get(keyPath)),
            void 0 === task
              ? ((task = [keyPath[1], keyPath[2], [], segment.id]),
                addToReplayParent(task, keyPath[0], trackedPostpones))
              : (task[3] = segment.id));
      else {
        if (null === keyPath)
          if (((request = trackedPostpones.rootSlots), null === request))
            request = trackedPostpones.rootSlots = {};
          else {
            if ("number" === typeof request) throw Error(formatProdErrorMessage(491));
          }
        else if (
          ((boundary = trackedPostpones.workingMap),
          (boundaryNode = boundary.get(keyPath)),
          void 0 === boundaryNode)
        )
          ((request = {}),
            (boundaryNode = [keyPath[1], keyPath[2], [], request]),
            boundary.set(keyPath, boundaryNode),
            addToReplayParent(boundaryNode, keyPath[0], trackedPostpones));
        else if (((request = boundaryNode[3]), null === request)) request = boundaryNode[3] = {};
        else if ("number" === typeof request) throw Error(formatProdErrorMessage(491));
        request[task.childIndex] = segment.id;
      }
    }
  }
  function untrackBoundary(request, boundary) {
    request = request.trackedPostpones;
    null !== request &&
      ((boundary = boundary.trackedContentKeyPath),
      null !== boundary &&
        ((boundary = request.workingMap.get(boundary)),
        void 0 !== boundary && ((boundary.length = 4), (boundary[2] = []), (boundary[3] = null))));
  }
  function spawnNewSuspendedReplayTask(request, task, thenableState2) {
    return createReplayTask(
      request,
      thenableState2,
      task.replay,
      task.node,
      task.childIndex,
      task.blockedBoundary,
      task.hoistableState,
      task.abortSet,
      task.keyPath,
      task.formatContext,
      task.context,
      task.treeContext,
      task.row,
      task.componentStack,
    );
  }
  function spawnNewSuspendedRenderTask(request, task, thenableState2) {
    var segment = task.blockedSegment,
      newSegment = createPendingSegment(
        request,
        segment.chunks.length,
        null,
        task.formatContext,
        segment.lastPushedText,
        true,
      );
    segment.children.push(newSegment);
    segment.lastPushedText = false;
    return createRenderTask(
      request,
      thenableState2,
      task.node,
      task.childIndex,
      task.blockedBoundary,
      newSegment,
      task.blockedPreamble,
      task.hoistableState,
      task.abortSet,
      task.keyPath,
      task.formatContext,
      task.context,
      task.treeContext,
      task.row,
      task.componentStack,
    );
  }
  function renderNode(request, task, node, childIndex) {
    var previousFormatContext = task.formatContext,
      previousContext = task.context,
      previousKeyPath = task.keyPath,
      previousTreeContext = task.treeContext,
      previousComponentStack = task.componentStack,
      segment = task.blockedSegment;
    if (null === segment) {
      segment = task.replay;
      try {
        return renderNodeDestructive(request, task, node, childIndex);
      } catch (thrownValue) {
        if (
          (resetHooksState(),
          (node = thrownValue === SuspenseException ? getSuspendedThenable() : thrownValue),
          12 !== request.status && "object" === typeof node && null !== node)
        ) {
          if ("function" === typeof node.then) {
            childIndex =
              thrownValue === SuspenseException ? getThenableStateAfterSuspending() : null;
            request = spawnNewSuspendedReplayTask(request, task, childIndex).ping;
            node.then(request, request);
            task.formatContext = previousFormatContext;
            task.context = previousContext;
            task.keyPath = previousKeyPath;
            task.treeContext = previousTreeContext;
            task.componentStack = previousComponentStack;
            task.replay = segment;
            switchContext(previousContext);
            return;
          }
          if ("Maximum call stack size exceeded" === node.message) {
            node = thrownValue === SuspenseException ? getThenableStateAfterSuspending() : null;
            node = spawnNewSuspendedReplayTask(request, task, node);
            request.pingedTasks.push(node);
            task.formatContext = previousFormatContext;
            task.context = previousContext;
            task.keyPath = previousKeyPath;
            task.treeContext = previousTreeContext;
            task.componentStack = previousComponentStack;
            task.replay = segment;
            switchContext(previousContext);
            return;
          }
        }
      }
    } else {
      var childrenLength = segment.children.length,
        chunkLength = segment.chunks.length;
      try {
        return renderNodeDestructive(request, task, node, childIndex);
      } catch (thrownValue$62) {
        if (
          (resetHooksState(),
          (segment.children.length = childrenLength),
          (segment.chunks.length = chunkLength),
          (node = thrownValue$62 === SuspenseException ? getSuspendedThenable() : thrownValue$62),
          12 !== request.status && "object" === typeof node && null !== node)
        ) {
          if ("function" === typeof node.then) {
            segment = node;
            node = thrownValue$62 === SuspenseException ? getThenableStateAfterSuspending() : null;
            request = spawnNewSuspendedRenderTask(request, task, node).ping;
            segment.then(request, request);
            task.formatContext = previousFormatContext;
            task.context = previousContext;
            task.keyPath = previousKeyPath;
            task.treeContext = previousTreeContext;
            task.componentStack = previousComponentStack;
            switchContext(previousContext);
            return;
          }
          if ("Maximum call stack size exceeded" === node.message) {
            segment =
              thrownValue$62 === SuspenseException ? getThenableStateAfterSuspending() : null;
            segment = spawnNewSuspendedRenderTask(request, task, segment);
            request.pingedTasks.push(segment);
            task.formatContext = previousFormatContext;
            task.context = previousContext;
            task.keyPath = previousKeyPath;
            task.treeContext = previousTreeContext;
            task.componentStack = previousComponentStack;
            switchContext(previousContext);
            return;
          }
        }
      }
    }
    task.formatContext = previousFormatContext;
    task.context = previousContext;
    task.keyPath = previousKeyPath;
    task.treeContext = previousTreeContext;
    switchContext(previousContext);
    throw node;
  }
  function abortTaskSoft(task) {
    var boundary = task.blockedBoundary,
      segment = task.blockedSegment;
    null !== segment && ((segment.status = 3), finishedTask(this, boundary, task.row, segment));
  }
  function abortRemainingReplayNodes(
    request$jscomp$0,
    boundary,
    nodes,
    slots,
    error,
    errorDigest$jscomp$0,
  ) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (4 === node.length)
        abortRemainingReplayNodes(
          request$jscomp$0,
          boundary,
          node[2],
          node[3],
          error,
          errorDigest$jscomp$0,
        );
      else {
        node = node[5];
        var request = request$jscomp$0,
          errorDigest = errorDigest$jscomp$0,
          resumedBoundary = createSuspenseBoundary(
            request,
            null,
            /* @__PURE__ */ new Set(),
            null,
            null,
          );
        resumedBoundary.parentFlushed = true;
        resumedBoundary.rootSegmentID = node;
        resumedBoundary.status = 4;
        resumedBoundary.errorDigest = errorDigest;
        resumedBoundary.parentFlushed && request.clientRenderedBoundaries.push(resumedBoundary);
      }
    }
    nodes.length = 0;
    if (null !== slots) {
      if (null === boundary) throw Error(formatProdErrorMessage(487));
      4 !== boundary.status &&
        ((boundary.status = 4),
        (boundary.errorDigest = errorDigest$jscomp$0),
        boundary.parentFlushed && request$jscomp$0.clientRenderedBoundaries.push(boundary));
      if ("object" === typeof slots) for (var index in slots) delete slots[index];
    }
  }
  function abortTask(task, request, error) {
    var boundary = task.blockedBoundary,
      segment = task.blockedSegment;
    if (null !== segment) {
      if (6 === segment.status) return;
      segment.status = 3;
    }
    var errorInfo = getThrownInfo(task.componentStack);
    if (null === boundary) {
      if (13 !== request.status && 14 !== request.status) {
        boundary = task.replay;
        if (null === boundary) {
          null !== request.trackedPostpones && null !== segment
            ? ((boundary = request.trackedPostpones),
              logRecoverableError(request, error, errorInfo),
              trackPostpone(request, boundary, task, segment),
              finishedTask(request, null, task.row, segment))
            : (logRecoverableError(request, error, errorInfo), fatalError(request, error));
          return;
        }
        boundary.pendingTasks--;
        0 === boundary.pendingTasks &&
          0 < boundary.nodes.length &&
          ((segment = logRecoverableError(request, error, errorInfo)),
          abortRemainingReplayNodes(request, null, boundary.nodes, boundary.slots, error, segment));
        request.pendingRootTasks--;
        0 === request.pendingRootTasks && completeShell(request);
      }
    } else {
      var trackedPostpones$63 = request.trackedPostpones;
      if (4 !== boundary.status) {
        if (null !== trackedPostpones$63 && null !== segment)
          return (
            logRecoverableError(request, error, errorInfo),
            trackPostpone(request, trackedPostpones$63, task, segment),
            boundary.fallbackAbortableTasks.forEach(function (fallbackTask) {
              return abortTask(fallbackTask, request, error);
            }),
            boundary.fallbackAbortableTasks.clear(),
            finishedTask(request, boundary, task.row, segment)
          );
        boundary.status = 4;
        segment = logRecoverableError(request, error, errorInfo);
        boundary.status = 4;
        boundary.errorDigest = segment;
        untrackBoundary(request, boundary);
        boundary.parentFlushed && request.clientRenderedBoundaries.push(boundary);
      }
      boundary.pendingTasks--;
      segment = boundary.row;
      null !== segment && 0 === --segment.pendingTasks && finishSuspenseListRow(request, segment);
      boundary.fallbackAbortableTasks.forEach(function (fallbackTask) {
        return abortTask(fallbackTask, request, error);
      });
      boundary.fallbackAbortableTasks.clear();
    }
    task = task.row;
    null !== task && 0 === --task.pendingTasks && finishSuspenseListRow(request, task);
    request.allPendingTasks--;
    0 === request.allPendingTasks && completeAll(request);
  }
  function safelyEmitEarlyPreloads(request, shellComplete) {
    try {
      var renderState = request.renderState,
        onHeaders = renderState.onHeaders;
      if (onHeaders) {
        var headers = renderState.headers;
        if (headers) {
          renderState.headers = null;
          var linkHeader = headers.preconnects;
          headers.fontPreloads &&
            (linkHeader && (linkHeader += ", "), (linkHeader += headers.fontPreloads));
          headers.highImagePreloads &&
            (linkHeader && (linkHeader += ", "), (linkHeader += headers.highImagePreloads));
          if (!shellComplete) {
            var queueIter = renderState.styles.values(),
              queueStep = queueIter.next();
            b: for (
              ;
              0 < headers.remainingCapacity && !queueStep.done;
              queueStep = queueIter.next()
            )
              for (
                var sheetIter = queueStep.value.sheets.values(), sheetStep = sheetIter.next();
                0 < headers.remainingCapacity && !sheetStep.done;
                sheetStep = sheetIter.next()
              ) {
                var sheet = sheetStep.value,
                  props = sheet.props,
                  key = props.href,
                  props$jscomp$0 = sheet.props,
                  header = getPreloadAsHeader(props$jscomp$0.href, "style", {
                    crossOrigin: props$jscomp$0.crossOrigin,
                    integrity: props$jscomp$0.integrity,
                    nonce: props$jscomp$0.nonce,
                    type: props$jscomp$0.type,
                    fetchPriority: props$jscomp$0.fetchPriority,
                    referrerPolicy: props$jscomp$0.referrerPolicy,
                    media: props$jscomp$0.media,
                  });
                if (0 <= (headers.remainingCapacity -= header.length + 2))
                  ((renderState.resets.style[key] = PRELOAD_NO_CREDS),
                    linkHeader && (linkHeader += ", "),
                    (linkHeader += header),
                    (renderState.resets.style[key] =
                      "string" === typeof props.crossOrigin || "string" === typeof props.integrity
                        ? [props.crossOrigin, props.integrity]
                        : PRELOAD_NO_CREDS));
                else break b;
              }
          }
          linkHeader ? onHeaders({ Link: linkHeader }) : onHeaders({});
        }
      }
    } catch (error) {
      logRecoverableError(request, error, {});
    }
  }
  function completeShell(request) {
    null === request.trackedPostpones && safelyEmitEarlyPreloads(request, true);
    null === request.trackedPostpones && preparePreamble(request);
    request.onShellError = noop;
    request = request.onShellReady;
    request();
  }
  function completeAll(request) {
    safelyEmitEarlyPreloads(
      request,
      null === request.trackedPostpones
        ? true
        : null === request.completedRootSegment || 5 !== request.completedRootSegment.status,
    );
    preparePreamble(request);
    request = request.onAllReady;
    request();
  }
  function queueCompletedSegment(boundary, segment) {
    if (
      0 === segment.chunks.length &&
      1 === segment.children.length &&
      null === segment.children[0].boundary &&
      -1 === segment.children[0].id
    ) {
      var childSegment = segment.children[0];
      childSegment.id = segment.id;
      childSegment.parentFlushed = true;
      (1 !== childSegment.status && 3 !== childSegment.status && 4 !== childSegment.status) ||
        queueCompletedSegment(boundary, childSegment);
    } else boundary.completedSegments.push(segment);
  }
  function finishedTask(request, boundary, row, segment) {
    null !== row &&
      (0 === --row.pendingTasks
        ? finishSuspenseListRow(request, row)
        : row.together && tryToResolveTogetherRow(request, row));
    request.allPendingTasks--;
    if (null === boundary) {
      if (null !== segment && segment.parentFlushed) {
        if (null !== request.completedRootSegment) throw Error(formatProdErrorMessage(389));
        request.completedRootSegment = segment;
      }
      request.pendingRootTasks--;
      0 === request.pendingRootTasks && completeShell(request);
    } else if ((boundary.pendingTasks--, 4 !== boundary.status))
      if (0 === boundary.pendingTasks)
        if (
          (0 === boundary.status && (boundary.status = 1),
          null !== segment &&
            segment.parentFlushed &&
            (1 === segment.status || 3 === segment.status) &&
            queueCompletedSegment(boundary, segment),
          boundary.parentFlushed && request.completedBoundaries.push(boundary),
          1 === boundary.status)
        )
          ((row = boundary.row),
            null !== row && hoistHoistables(row.hoistables, boundary.contentState),
            isEligibleForOutlining(request, boundary) ||
              (boundary.fallbackAbortableTasks.forEach(abortTaskSoft, request),
              boundary.fallbackAbortableTasks.clear(),
              null !== row && 0 === --row.pendingTasks && finishSuspenseListRow(request, row)),
            0 === request.pendingRootTasks &&
              null === request.trackedPostpones &&
              null !== boundary.contentPreamble &&
              preparePreamble(request));
        else {
          if (5 === boundary.status && ((boundary = boundary.row), null !== boundary)) {
            if (null !== request.trackedPostpones) {
              row = request.trackedPostpones;
              var postponedRow = boundary.next;
              if (null !== postponedRow && ((segment = postponedRow.boundaries), null !== segment))
                for (
                  postponedRow.boundaries = null, postponedRow = 0;
                  postponedRow < segment.length;
                  postponedRow++
                ) {
                  var postponedBoundary = segment[postponedRow];
                  trackPostponedBoundary(request, row, postponedBoundary);
                  finishedTask(request, postponedBoundary, null, null);
                }
            }
            0 === --boundary.pendingTasks && finishSuspenseListRow(request, boundary);
          }
        }
      else
        (null === segment ||
          !segment.parentFlushed ||
          (1 !== segment.status && 3 !== segment.status) ||
          (queueCompletedSegment(boundary, segment),
          1 === boundary.completedSegments.length &&
            boundary.parentFlushed &&
            request.partialBoundaries.push(boundary)),
          (boundary = boundary.row),
          null !== boundary && boundary.together && tryToResolveTogetherRow(request, boundary));
    0 === request.allPendingTasks && completeAll(request);
  }
  function performWork(request$jscomp$2) {
    if (14 !== request$jscomp$2.status && 13 !== request$jscomp$2.status) {
      var prevContext = currentActiveSnapshot,
        prevDispatcher = ReactSharedInternals.H;
      ReactSharedInternals.H = HooksDispatcher;
      var prevAsyncDispatcher = ReactSharedInternals.A;
      ReactSharedInternals.A = DefaultAsyncDispatcher;
      var prevRequest = currentRequest;
      currentRequest = request$jscomp$2;
      var prevResumableState = currentResumableState;
      currentResumableState = request$jscomp$2.resumableState;
      try {
        var pingedTasks = request$jscomp$2.pingedTasks,
          i;
        for (i = 0; i < pingedTasks.length; i++) {
          var task = pingedTasks[i],
            request = request$jscomp$2,
            segment = task.blockedSegment;
          if (null === segment) {
            var request$jscomp$0 = request;
            if (0 !== task.replay.pendingTasks) {
              switchContext(task.context);
              try {
                "number" === typeof task.replay.slots
                  ? resumeNode(
                      request$jscomp$0,
                      task,
                      task.replay.slots,
                      task.node,
                      task.childIndex,
                    )
                  : retryNode(request$jscomp$0, task);
                if (1 === task.replay.pendingTasks && 0 < task.replay.nodes.length)
                  throw Error(formatProdErrorMessage(488));
                task.replay.pendingTasks--;
                task.abortSet.delete(task);
                finishedTask(request$jscomp$0, task.blockedBoundary, task.row, null);
              } catch (thrownValue) {
                resetHooksState();
                var x3 = thrownValue === SuspenseException ? getSuspendedThenable() : thrownValue;
                if ("object" === typeof x3 && null !== x3 && "function" === typeof x3.then) {
                  var ping = task.ping;
                  x3.then(ping, ping);
                  task.thenableState =
                    thrownValue === SuspenseException ? getThenableStateAfterSuspending() : null;
                } else {
                  task.replay.pendingTasks--;
                  task.abortSet.delete(task);
                  var errorInfo = getThrownInfo(task.componentStack);
                  request = void 0;
                  var request$jscomp$1 = request$jscomp$0,
                    boundary = task.blockedBoundary,
                    error$jscomp$0 =
                      12 === request$jscomp$0.status ? request$jscomp$0.fatalError : x3,
                    replayNodes = task.replay.nodes,
                    resumeSlots = task.replay.slots;
                  request = logRecoverableError(request$jscomp$1, error$jscomp$0, errorInfo);
                  abortRemainingReplayNodes(
                    request$jscomp$1,
                    boundary,
                    replayNodes,
                    resumeSlots,
                    error$jscomp$0,
                    request,
                  );
                  request$jscomp$0.pendingRootTasks--;
                  0 === request$jscomp$0.pendingRootTasks && completeShell(request$jscomp$0);
                  request$jscomp$0.allPendingTasks--;
                  0 === request$jscomp$0.allPendingTasks && completeAll(request$jscomp$0);
                }
              } finally {
              }
            }
          } else if (
            ((request$jscomp$0 = void 0),
            (request$jscomp$1 = segment),
            0 === request$jscomp$1.status)
          ) {
            request$jscomp$1.status = 6;
            switchContext(task.context);
            var childrenLength = request$jscomp$1.children.length,
              chunkLength = request$jscomp$1.chunks.length;
            try {
              (retryNode(request, task),
                pushSegmentFinale(
                  request$jscomp$1.chunks,
                  request.renderState,
                  request$jscomp$1.lastPushedText,
                  request$jscomp$1.textEmbedded,
                ),
                task.abortSet.delete(task),
                (request$jscomp$1.status = 1),
                finishedTask(request, task.blockedBoundary, task.row, request$jscomp$1));
            } catch (thrownValue) {
              resetHooksState();
              request$jscomp$1.children.length = childrenLength;
              request$jscomp$1.chunks.length = chunkLength;
              var x$jscomp$0 =
                thrownValue === SuspenseException
                  ? getSuspendedThenable()
                  : 12 === request.status
                    ? request.fatalError
                    : thrownValue;
              if (12 === request.status && null !== request.trackedPostpones) {
                var trackedPostpones = request.trackedPostpones,
                  thrownInfo = getThrownInfo(task.componentStack);
                task.abortSet.delete(task);
                logRecoverableError(request, x$jscomp$0, thrownInfo);
                trackPostpone(request, trackedPostpones, task, request$jscomp$1);
                finishedTask(request, task.blockedBoundary, task.row, request$jscomp$1);
              } else if (
                "object" === typeof x$jscomp$0 &&
                null !== x$jscomp$0 &&
                "function" === typeof x$jscomp$0.then
              ) {
                request$jscomp$1.status = 0;
                task.thenableState =
                  thrownValue === SuspenseException ? getThenableStateAfterSuspending() : null;
                var ping$jscomp$0 = task.ping;
                x$jscomp$0.then(ping$jscomp$0, ping$jscomp$0);
              } else {
                var errorInfo$jscomp$0 = getThrownInfo(task.componentStack);
                task.abortSet.delete(task);
                request$jscomp$1.status = 4;
                var boundary$jscomp$0 = task.blockedBoundary,
                  row = task.row;
                null !== row && 0 === --row.pendingTasks && finishSuspenseListRow(request, row);
                request.allPendingTasks--;
                request$jscomp$0 = logRecoverableError(request, x$jscomp$0, errorInfo$jscomp$0);
                if (null === boundary$jscomp$0) fatalError(request, x$jscomp$0);
                else if ((boundary$jscomp$0.pendingTasks--, 4 !== boundary$jscomp$0.status)) {
                  boundary$jscomp$0.status = 4;
                  boundary$jscomp$0.errorDigest = request$jscomp$0;
                  untrackBoundary(request, boundary$jscomp$0);
                  var boundaryRow = boundary$jscomp$0.row;
                  null !== boundaryRow &&
                    0 === --boundaryRow.pendingTasks &&
                    finishSuspenseListRow(request, boundaryRow);
                  boundary$jscomp$0.parentFlushed &&
                    request.clientRenderedBoundaries.push(boundary$jscomp$0);
                  0 === request.pendingRootTasks &&
                    null === request.trackedPostpones &&
                    null !== boundary$jscomp$0.contentPreamble &&
                    preparePreamble(request);
                }
                0 === request.allPendingTasks && completeAll(request);
              }
            } finally {
            }
          }
        }
        pingedTasks.splice(0, i);
        null !== request$jscomp$2.destination &&
          flushCompletedQueues(request$jscomp$2, request$jscomp$2.destination);
      } catch (error) {
        (logRecoverableError(request$jscomp$2, error, {}), fatalError(request$jscomp$2, error));
      } finally {
        ((currentResumableState = prevResumableState),
          (ReactSharedInternals.H = prevDispatcher),
          (ReactSharedInternals.A = prevAsyncDispatcher),
          prevDispatcher === HooksDispatcher && switchContext(prevContext),
          (currentRequest = prevRequest));
      }
    }
  }
  function preparePreambleFromSubtree(request, segment, collectedPreambleSegments) {
    segment.preambleChildren.length && collectedPreambleSegments.push(segment.preambleChildren);
    for (var pendingPreambles = false, i = 0; i < segment.children.length; i++)
      pendingPreambles =
        preparePreambleFromSegment(request, segment.children[i], collectedPreambleSegments) ||
        pendingPreambles;
    return pendingPreambles;
  }
  function preparePreambleFromSegment(request, segment, collectedPreambleSegments) {
    var boundary = segment.boundary;
    if (null === boundary)
      return preparePreambleFromSubtree(request, segment, collectedPreambleSegments);
    var preamble = boundary.contentPreamble,
      fallbackPreamble = boundary.fallbackPreamble;
    if (null === preamble || null === fallbackPreamble) return false;
    switch (boundary.status) {
      case 1:
        hoistPreambleState(request.renderState, preamble);
        request.byteSize += boundary.byteSize;
        segment = boundary.completedSegments[0];
        if (!segment) throw Error(formatProdErrorMessage(391));
        return preparePreambleFromSubtree(request, segment, collectedPreambleSegments);
      case 5:
        if (null !== request.trackedPostpones) return true;
      case 4:
        if (1 === segment.status)
          return (
            hoistPreambleState(request.renderState, fallbackPreamble),
            preparePreambleFromSubtree(request, segment, collectedPreambleSegments)
          );
      default:
        return true;
    }
  }
  function preparePreamble(request) {
    if (request.completedRootSegment && null === request.completedPreambleSegments) {
      var collectedPreambleSegments = [],
        originalRequestByteSize = request.byteSize,
        hasPendingPreambles = preparePreambleFromSegment(
          request,
          request.completedRootSegment,
          collectedPreambleSegments,
        ),
        preamble = request.renderState.preamble;
      false === hasPendingPreambles || (preamble.headChunks && preamble.bodyChunks)
        ? (request.completedPreambleSegments = collectedPreambleSegments)
        : (request.byteSize = originalRequestByteSize);
    }
  }
  function flushSubtree(request, destination, segment, hoistableState) {
    segment.parentFlushed = true;
    switch (segment.status) {
      case 0:
        segment.id = request.nextSegmentId++;
      case 5:
        return (
          (hoistableState = segment.id),
          (segment.lastPushedText = false),
          (segment.textEmbedded = false),
          (request = request.renderState),
          destination.push('<template id="'),
          destination.push(request.placeholderPrefix),
          (request = hoistableState.toString(16)),
          destination.push(request),
          destination.push('"></template>')
        );
      case 1:
        segment.status = 2;
        var r = true,
          chunks = segment.chunks,
          chunkIdx = 0;
        segment = segment.children;
        for (var childIdx = 0; childIdx < segment.length; childIdx++) {
          for (r = segment[childIdx]; chunkIdx < r.index; chunkIdx++)
            destination.push(chunks[chunkIdx]);
          r = flushSegment(request, destination, r, hoistableState);
        }
        for (; chunkIdx < chunks.length - 1; chunkIdx++) destination.push(chunks[chunkIdx]);
        chunkIdx < chunks.length && (r = destination.push(chunks[chunkIdx]));
        return r;
      case 3:
        return true;
      default:
        throw Error(formatProdErrorMessage(390));
    }
  }
  var flushedByteSize = 0;
  function flushSegment(request, destination, segment, hoistableState) {
    var boundary = segment.boundary;
    if (null === boundary) return flushSubtree(request, destination, segment, hoistableState);
    boundary.parentFlushed = true;
    if (4 === boundary.status) {
      var row = boundary.row;
      null !== row && 0 === --row.pendingTasks && finishSuspenseListRow(request, row);
      request.renderState.generateStaticMarkup ||
        ((boundary = boundary.errorDigest),
        destination.push("<!--$!-->"),
        destination.push("<template"),
        boundary &&
          (destination.push(' data-dgst="'),
          (boundary = escapeTextForBrowser(boundary)),
          destination.push(boundary),
          destination.push('"')),
        destination.push("></template>"));
      flushSubtree(request, destination, segment, hoistableState);
      request = request.renderState.generateStaticMarkup ? true : destination.push("<!--/$-->");
      return request;
    }
    if (1 !== boundary.status)
      return (
        0 === boundary.status && (boundary.rootSegmentID = request.nextSegmentId++),
        0 < boundary.completedSegments.length && request.partialBoundaries.push(boundary),
        writeStartPendingSuspenseBoundary(destination, request.renderState, boundary.rootSegmentID),
        hoistableState && hoistHoistables(hoistableState, boundary.fallbackState),
        flushSubtree(request, destination, segment, hoistableState),
        destination.push("<!--/$-->")
      );
    if (
      !flushingPartialBoundaries &&
      isEligibleForOutlining(request, boundary) &&
      flushedByteSize + boundary.byteSize > request.progressiveChunkSize
    )
      return (
        (boundary.rootSegmentID = request.nextSegmentId++),
        request.completedBoundaries.push(boundary),
        writeStartPendingSuspenseBoundary(destination, request.renderState, boundary.rootSegmentID),
        flushSubtree(request, destination, segment, hoistableState),
        destination.push("<!--/$-->")
      );
    flushedByteSize += boundary.byteSize;
    hoistableState && hoistHoistables(hoistableState, boundary.contentState);
    segment = boundary.row;
    null !== segment &&
      isEligibleForOutlining(request, boundary) &&
      0 === --segment.pendingTasks &&
      finishSuspenseListRow(request, segment);
    request.renderState.generateStaticMarkup || destination.push("<!--$-->");
    segment = boundary.completedSegments;
    if (1 !== segment.length) throw Error(formatProdErrorMessage(391));
    flushSegment(request, destination, segment[0], hoistableState);
    request = request.renderState.generateStaticMarkup ? true : destination.push("<!--/$-->");
    return request;
  }
  function flushSegmentContainer(request, destination, segment, hoistableState) {
    writeStartSegment(destination, request.renderState, segment.parentFormatContext, segment.id);
    flushSegment(request, destination, segment, hoistableState);
    return writeEndSegment(destination, segment.parentFormatContext);
  }
  function flushCompletedBoundary(request, destination, boundary) {
    flushedByteSize = boundary.byteSize;
    for (
      var completedSegments = boundary.completedSegments, i = 0;
      i < completedSegments.length;
      i++
    )
      flushPartiallyCompletedSegment(request, destination, boundary, completedSegments[i]);
    completedSegments.length = 0;
    completedSegments = boundary.row;
    null !== completedSegments &&
      isEligibleForOutlining(request, boundary) &&
      0 === --completedSegments.pendingTasks &&
      finishSuspenseListRow(request, completedSegments);
    writeHoistablesForBoundary(destination, boundary.contentState, request.renderState);
    completedSegments = request.resumableState;
    request = request.renderState;
    i = boundary.rootSegmentID;
    boundary = boundary.contentState;
    var requiresStyleInsertion = request.stylesToHoist;
    request.stylesToHoist = false;
    destination.push(request.startInlineScript);
    destination.push(">");
    requiresStyleInsertion
      ? (0 === (completedSegments.instructions & 4) &&
          ((completedSegments.instructions |= 4),
          destination.push(
            '$RX=function(b,c,d,e,f){var a=document.getElementById(b);a&&(b=a.previousSibling,b.data="$!",a=a.dataset,c&&(a.dgst=c),d&&(a.msg=d),e&&(a.stck=e),f&&(a.cstck=f),b._reactRetry&&b._reactRetry())};',
          )),
        0 === (completedSegments.instructions & 2) &&
          ((completedSegments.instructions |= 2),
          destination.push(
            '$RB=[];$RV=function(a){$RT=performance.now();for(var b=0;b<a.length;b+=2){var c=a[b],e=a[b+1];null!==e.parentNode&&e.parentNode.removeChild(e);var f=c.parentNode;if(f){var g=c.previousSibling,h=0;do{if(c&&8===c.nodeType){var d=c.data;if("/$"===d||"/&"===d)if(0===h)break;else h--;else"$"!==d&&"$?"!==d&&"$~"!==d&&"$!"!==d&&"&"!==d||h++}d=c.nextSibling;f.removeChild(c);c=d}while(c);for(;e.firstChild;)f.insertBefore(e.firstChild,c);g.data="$";g._reactRetry&&requestAnimationFrame(g._reactRetry)}}a.length=0};\n$RC=function(a,b){if(b=document.getElementById(b))(a=document.getElementById(a))?(a.previousSibling.data="$~",$RB.push(a,b),2===$RB.length&&("number"!==typeof $RT?requestAnimationFrame($RV.bind(null,$RB)):(a=performance.now(),setTimeout($RV.bind(null,$RB),2300>a&&2E3<a?2300-a:$RT+300-a)))):b.parentNode.removeChild(b)};',
          )),
        0 === (completedSegments.instructions & 8)
          ? ((completedSegments.instructions |= 8),
            destination.push(
              '$RM=new Map;$RR=function(n,w,p){function u(q){this._p=null;q()}for(var r=new Map,t=document,h,b,e=t.querySelectorAll("link[data-precedence],style[data-precedence]"),v=[],k=0;b=e[k++];)"not all"===b.getAttribute("media")?v.push(b):("LINK"===b.tagName&&$RM.set(b.getAttribute("href"),b),r.set(b.dataset.precedence,h=b));e=0;b=[];var l,a;for(k=!0;;){if(k){var f=p[e++];if(!f){k=!1;e=0;continue}var c=!1,m=0;var d=f[m++];if(a=$RM.get(d)){var g=a._p;c=!0}else{a=t.createElement("link");a.href=d;a.rel=\n"stylesheet";for(a.dataset.precedence=l=f[m++];g=f[m++];)a.setAttribute(g,f[m++]);g=a._p=new Promise(function(q,x){a.onload=u.bind(a,q);a.onerror=u.bind(a,x)});$RM.set(d,a)}d=a.getAttribute("media");!g||d&&!matchMedia(d).matches||b.push(g);if(c)continue}else{a=v[e++];if(!a)break;l=a.getAttribute("data-precedence");a.removeAttribute("media")}c=r.get(l)||h;c===h&&(h=a);r.set(l,a);c?c.parentNode.insertBefore(a,c.nextSibling):(c=t.head,c.insertBefore(a,c.firstChild))}if(p=document.getElementById(n))p.previousSibling.data=\n"$~";Promise.all(b).then($RC.bind(null,n,w),$RX.bind(null,n,"CSS failed to load"))};$RR("',
            ))
          : destination.push('$RR("'))
      : (0 === (completedSegments.instructions & 2) &&
          ((completedSegments.instructions |= 2),
          destination.push(
            '$RB=[];$RV=function(a){$RT=performance.now();for(var b=0;b<a.length;b+=2){var c=a[b],e=a[b+1];null!==e.parentNode&&e.parentNode.removeChild(e);var f=c.parentNode;if(f){var g=c.previousSibling,h=0;do{if(c&&8===c.nodeType){var d=c.data;if("/$"===d||"/&"===d)if(0===h)break;else h--;else"$"!==d&&"$?"!==d&&"$~"!==d&&"$!"!==d&&"&"!==d||h++}d=c.nextSibling;f.removeChild(c);c=d}while(c);for(;e.firstChild;)f.insertBefore(e.firstChild,c);g.data="$";g._reactRetry&&requestAnimationFrame(g._reactRetry)}}a.length=0};\n$RC=function(a,b){if(b=document.getElementById(b))(a=document.getElementById(a))?(a.previousSibling.data="$~",$RB.push(a,b),2===$RB.length&&("number"!==typeof $RT?requestAnimationFrame($RV.bind(null,$RB)):(a=performance.now(),setTimeout($RV.bind(null,$RB),2300>a&&2E3<a?2300-a:$RT+300-a)))):b.parentNode.removeChild(b)};',
          )),
        destination.push('$RC("'));
    completedSegments = i.toString(16);
    destination.push(request.boundaryPrefix);
    destination.push(completedSegments);
    destination.push('","');
    destination.push(request.segmentPrefix);
    destination.push(completedSegments);
    requiresStyleInsertion
      ? (destination.push('",'), writeStyleResourceDependenciesInJS(destination, boundary))
      : destination.push('"');
    boundary = destination.push(")<\/script>");
    return writeBootstrap(destination, request) && boundary;
  }
  function flushPartiallyCompletedSegment(request, destination, boundary, segment) {
    if (2 === segment.status) return true;
    var hoistableState = boundary.contentState,
      segmentID = segment.id;
    if (-1 === segmentID) {
      if (-1 === (segment.id = boundary.rootSegmentID)) throw Error(formatProdErrorMessage(392));
      return flushSegmentContainer(request, destination, segment, hoistableState);
    }
    if (segmentID === boundary.rootSegmentID)
      return flushSegmentContainer(request, destination, segment, hoistableState);
    flushSegmentContainer(request, destination, segment, hoistableState);
    boundary = request.resumableState;
    request = request.renderState;
    destination.push(request.startInlineScript);
    destination.push(">");
    0 === (boundary.instructions & 1)
      ? ((boundary.instructions |= 1),
        destination.push(
          '$RS=function(a,b){a=document.getElementById(a);b=document.getElementById(b);for(a.parentNode.removeChild(a);a.firstChild;)b.parentNode.insertBefore(a.firstChild,b);b.parentNode.removeChild(b)};$RS("',
        ))
      : destination.push('$RS("');
    destination.push(request.segmentPrefix);
    segmentID = segmentID.toString(16);
    destination.push(segmentID);
    destination.push('","');
    destination.push(request.placeholderPrefix);
    destination.push(segmentID);
    destination = destination.push('")<\/script>');
    return destination;
  }
  var flushingPartialBoundaries = false;
  function flushCompletedQueues(request, destination) {
    try {
      if (!(0 < request.pendingRootTasks)) {
        var i,
          completedRootSegment = request.completedRootSegment;
        if (null !== completedRootSegment) {
          if (5 === completedRootSegment.status) return;
          var completedPreambleSegments = request.completedPreambleSegments;
          if (null === completedPreambleSegments) return;
          flushedByteSize = request.byteSize;
          var resumableState = request.resumableState,
            renderState = request.renderState,
            preamble = renderState.preamble,
            htmlChunks = preamble.htmlChunks,
            headChunks = preamble.headChunks,
            i$jscomp$0;
          if (htmlChunks) {
            for (i$jscomp$0 = 0; i$jscomp$0 < htmlChunks.length; i$jscomp$0++)
              destination.push(htmlChunks[i$jscomp$0]);
            if (headChunks)
              for (i$jscomp$0 = 0; i$jscomp$0 < headChunks.length; i$jscomp$0++)
                destination.push(headChunks[i$jscomp$0]);
            else {
              var chunk = startChunkForTag("head");
              destination.push(chunk);
              destination.push(">");
            }
          } else if (headChunks)
            for (i$jscomp$0 = 0; i$jscomp$0 < headChunks.length; i$jscomp$0++)
              destination.push(headChunks[i$jscomp$0]);
          var charsetChunks = renderState.charsetChunks;
          for (i$jscomp$0 = 0; i$jscomp$0 < charsetChunks.length; i$jscomp$0++)
            destination.push(charsetChunks[i$jscomp$0]);
          charsetChunks.length = 0;
          renderState.preconnects.forEach(flushResource, destination);
          renderState.preconnects.clear();
          var viewportChunks = renderState.viewportChunks;
          for (i$jscomp$0 = 0; i$jscomp$0 < viewportChunks.length; i$jscomp$0++)
            destination.push(viewportChunks[i$jscomp$0]);
          viewportChunks.length = 0;
          renderState.fontPreloads.forEach(flushResource, destination);
          renderState.fontPreloads.clear();
          renderState.highImagePreloads.forEach(flushResource, destination);
          renderState.highImagePreloads.clear();
          currentlyFlushingRenderState = renderState;
          renderState.styles.forEach(flushStylesInPreamble, destination);
          currentlyFlushingRenderState = null;
          var importMapChunks = renderState.importMapChunks;
          for (i$jscomp$0 = 0; i$jscomp$0 < importMapChunks.length; i$jscomp$0++)
            destination.push(importMapChunks[i$jscomp$0]);
          importMapChunks.length = 0;
          renderState.bootstrapScripts.forEach(flushResource, destination);
          renderState.scripts.forEach(flushResource, destination);
          renderState.scripts.clear();
          renderState.bulkPreloads.forEach(flushResource, destination);
          renderState.bulkPreloads.clear();
          resumableState.instructions |= 32;
          var hoistableChunks = renderState.hoistableChunks;
          for (i$jscomp$0 = 0; i$jscomp$0 < hoistableChunks.length; i$jscomp$0++)
            destination.push(hoistableChunks[i$jscomp$0]);
          for (
            resumableState = hoistableChunks.length = 0;
            resumableState < completedPreambleSegments.length;
            resumableState++
          ) {
            var segments = completedPreambleSegments[resumableState];
            for (renderState = 0; renderState < segments.length; renderState++)
              flushSegment(request, destination, segments[renderState], null);
          }
          var preamble$jscomp$0 = request.renderState.preamble,
            headChunks$jscomp$0 = preamble$jscomp$0.headChunks;
          if (preamble$jscomp$0.htmlChunks || headChunks$jscomp$0) {
            var chunk$jscomp$0 = endChunkForTag("head");
            destination.push(chunk$jscomp$0);
          }
          var bodyChunks = preamble$jscomp$0.bodyChunks;
          if (bodyChunks)
            for (
              completedPreambleSegments = 0;
              completedPreambleSegments < bodyChunks.length;
              completedPreambleSegments++
            )
              destination.push(bodyChunks[completedPreambleSegments]);
          flushSegment(request, destination, completedRootSegment, null);
          request.completedRootSegment = null;
          var renderState$jscomp$0 = request.renderState;
          if (
            0 !== request.allPendingTasks ||
            0 !== request.clientRenderedBoundaries.length ||
            0 !== request.completedBoundaries.length ||
            (null !== request.trackedPostpones &&
              (0 !== request.trackedPostpones.rootNodes.length ||
                null !== request.trackedPostpones.rootSlots))
          ) {
            var resumableState$jscomp$0 = request.resumableState;
            if (0 === (resumableState$jscomp$0.instructions & 64)) {
              resumableState$jscomp$0.instructions |= 64;
              destination.push(renderState$jscomp$0.startInlineScript);
              if (0 === (resumableState$jscomp$0.instructions & 32)) {
                resumableState$jscomp$0.instructions |= 32;
                var shellId = "_" + resumableState$jscomp$0.idPrefix + "R_";
                destination.push(' id="');
                var chunk$jscomp$1 = escapeTextForBrowser(shellId);
                destination.push(chunk$jscomp$1);
                destination.push('"');
              }
              destination.push(">");
              destination.push("requestAnimationFrame(function(){$RT=performance.now()});");
              destination.push("<\/script>");
            }
          }
          writeBootstrap(destination, renderState$jscomp$0);
        }
        var renderState$jscomp$1 = request.renderState;
        completedRootSegment = 0;
        var viewportChunks$jscomp$0 = renderState$jscomp$1.viewportChunks;
        for (
          completedRootSegment = 0;
          completedRootSegment < viewportChunks$jscomp$0.length;
          completedRootSegment++
        )
          destination.push(viewportChunks$jscomp$0[completedRootSegment]);
        viewportChunks$jscomp$0.length = 0;
        renderState$jscomp$1.preconnects.forEach(flushResource, destination);
        renderState$jscomp$1.preconnects.clear();
        renderState$jscomp$1.fontPreloads.forEach(flushResource, destination);
        renderState$jscomp$1.fontPreloads.clear();
        renderState$jscomp$1.highImagePreloads.forEach(flushResource, destination);
        renderState$jscomp$1.highImagePreloads.clear();
        renderState$jscomp$1.styles.forEach(preloadLateStyles, destination);
        renderState$jscomp$1.scripts.forEach(flushResource, destination);
        renderState$jscomp$1.scripts.clear();
        renderState$jscomp$1.bulkPreloads.forEach(flushResource, destination);
        renderState$jscomp$1.bulkPreloads.clear();
        var hoistableChunks$jscomp$0 = renderState$jscomp$1.hoistableChunks;
        for (
          completedRootSegment = 0;
          completedRootSegment < hoistableChunks$jscomp$0.length;
          completedRootSegment++
        )
          destination.push(hoistableChunks$jscomp$0[completedRootSegment]);
        hoistableChunks$jscomp$0.length = 0;
        var clientRenderedBoundaries = request.clientRenderedBoundaries;
        for (i = 0; i < clientRenderedBoundaries.length; i++) {
          var boundary = clientRenderedBoundaries[i];
          renderState$jscomp$1 = destination;
          var resumableState$jscomp$1 = request.resumableState,
            renderState$jscomp$2 = request.renderState,
            id = boundary.rootSegmentID,
            errorDigest = boundary.errorDigest;
          renderState$jscomp$1.push(renderState$jscomp$2.startInlineScript);
          renderState$jscomp$1.push(">");
          0 === (resumableState$jscomp$1.instructions & 4)
            ? ((resumableState$jscomp$1.instructions |= 4),
              renderState$jscomp$1.push(
                '$RX=function(b,c,d,e,f){var a=document.getElementById(b);a&&(b=a.previousSibling,b.data="$!",a=a.dataset,c&&(a.dgst=c),d&&(a.msg=d),e&&(a.stck=e),f&&(a.cstck=f),b._reactRetry&&b._reactRetry())};;$RX("',
              ))
            : renderState$jscomp$1.push('$RX("');
          renderState$jscomp$1.push(renderState$jscomp$2.boundaryPrefix);
          var chunk$jscomp$2 = id.toString(16);
          renderState$jscomp$1.push(chunk$jscomp$2);
          renderState$jscomp$1.push('"');
          if (errorDigest) {
            renderState$jscomp$1.push(",");
            var chunk$jscomp$3 = escapeJSStringsForInstructionScripts(errorDigest || "");
            renderState$jscomp$1.push(chunk$jscomp$3);
          }
          var JSCompiler_inline_result = renderState$jscomp$1.push(")<\/script>");
          if (!JSCompiler_inline_result) {
            request.destination = null;
            i++;
            clientRenderedBoundaries.splice(0, i);
            return;
          }
        }
        clientRenderedBoundaries.splice(0, i);
        var completedBoundaries = request.completedBoundaries;
        for (i = 0; i < completedBoundaries.length; i++)
          if (!flushCompletedBoundary(request, destination, completedBoundaries[i])) {
            request.destination = null;
            i++;
            completedBoundaries.splice(0, i);
            return;
          }
        completedBoundaries.splice(0, i);
        flushingPartialBoundaries = true;
        var partialBoundaries = request.partialBoundaries;
        for (i = 0; i < partialBoundaries.length; i++) {
          var boundary$69 = partialBoundaries[i];
          a: {
            clientRenderedBoundaries = request;
            boundary = destination;
            flushedByteSize = boundary$69.byteSize;
            var completedSegments = boundary$69.completedSegments;
            for (
              JSCompiler_inline_result = 0;
              JSCompiler_inline_result < completedSegments.length;
              JSCompiler_inline_result++
            )
              if (
                !flushPartiallyCompletedSegment(
                  clientRenderedBoundaries,
                  boundary,
                  boundary$69,
                  completedSegments[JSCompiler_inline_result],
                )
              ) {
                JSCompiler_inline_result++;
                completedSegments.splice(0, JSCompiler_inline_result);
                var JSCompiler_inline_result$jscomp$0 = false;
                break a;
              }
            completedSegments.splice(0, JSCompiler_inline_result);
            var row = boundary$69.row;
            null !== row &&
              row.together &&
              1 === boundary$69.pendingTasks &&
              (1 === row.pendingTasks
                ? unblockSuspenseListRow(clientRenderedBoundaries, row, row.hoistables)
                : row.pendingTasks--);
            JSCompiler_inline_result$jscomp$0 = writeHoistablesForBoundary(
              boundary,
              boundary$69.contentState,
              clientRenderedBoundaries.renderState,
            );
          }
          if (!JSCompiler_inline_result$jscomp$0) {
            request.destination = null;
            i++;
            partialBoundaries.splice(0, i);
            return;
          }
        }
        partialBoundaries.splice(0, i);
        flushingPartialBoundaries = false;
        var largeBoundaries = request.completedBoundaries;
        for (i = 0; i < largeBoundaries.length; i++)
          if (!flushCompletedBoundary(request, destination, largeBoundaries[i])) {
            request.destination = null;
            i++;
            largeBoundaries.splice(0, i);
            return;
          }
        largeBoundaries.splice(0, i);
      }
    } finally {
      ((flushingPartialBoundaries = false),
        0 === request.allPendingTasks &&
          0 === request.clientRenderedBoundaries.length &&
          0 === request.completedBoundaries.length &&
          ((request.flushScheduled = false),
          (i = request.resumableState),
          i.hasBody &&
            ((partialBoundaries = endChunkForTag("body")), destination.push(partialBoundaries)),
          i.hasHtml && ((i = endChunkForTag("html")), destination.push(i)),
          (request.status = 14),
          destination.push(null),
          (request.destination = null)));
    }
  }
  function enqueueFlush(request) {
    if (
      false === request.flushScheduled &&
      0 === request.pingedTasks.length &&
      null !== request.destination
    ) {
      request.flushScheduled = true;
      var destination = request.destination;
      destination ? flushCompletedQueues(request, destination) : (request.flushScheduled = false);
    }
  }
  function startFlowing(request, destination) {
    if (13 === request.status) ((request.status = 14), destination.destroy(request.fatalError));
    else if (14 !== request.status && null === request.destination) {
      request.destination = destination;
      try {
        flushCompletedQueues(request, destination);
      } catch (error) {
        (logRecoverableError(request, error, {}), fatalError(request, error));
      }
    }
  }
  function abort(request, reason) {
    if (11 === request.status || 10 === request.status) request.status = 12;
    try {
      var abortableTasks = request.abortableTasks;
      if (0 < abortableTasks.size) {
        var error =
          void 0 === reason
            ? Error(formatProdErrorMessage(432))
            : "object" === typeof reason && null !== reason && "function" === typeof reason.then
              ? Error(formatProdErrorMessage(530))
              : reason;
        request.fatalError = error;
        abortableTasks.forEach(function (task) {
          return abortTask(task, request, error);
        });
        abortableTasks.clear();
      }
      null !== request.destination && flushCompletedQueues(request, request.destination);
    } catch (error$71) {
      (logRecoverableError(request, error$71, {}), fatalError(request, error$71));
    }
  }
  function addToReplayParent(node, parentKeyPath, trackedPostpones) {
    if (null === parentKeyPath) trackedPostpones.rootNodes.push(node);
    else {
      var workingMap = trackedPostpones.workingMap,
        parentNode = workingMap.get(parentKeyPath);
      void 0 === parentNode &&
        ((parentNode = [parentKeyPath[1], parentKeyPath[2], [], null]),
        workingMap.set(parentKeyPath, parentNode),
        addToReplayParent(parentNode, parentKeyPath[0], trackedPostpones));
      parentNode[2].push(node);
    }
  }
  function onError() {}
  function renderToStringImpl(children, options, generateStaticMarkup, abortReason) {
    var didFatal = false,
      fatalError2 = null,
      result = "",
      readyToStream = false;
    options = createResumableState(options ? options.identifierPrefix : void 0);
    children = createRequest(
      children,
      options,
      createRenderState(options, generateStaticMarkup),
      createFormatContext(0, null, 0, null),
      Infinity,
      onError,
      void 0,
      function () {
        readyToStream = true;
      },
      void 0,
      void 0,
      void 0,
    );
    children.flushScheduled = null !== children.destination;
    performWork(children);
    10 === children.status && (children.status = 11);
    null === children.trackedPostpones &&
      safelyEmitEarlyPreloads(children, 0 === children.pendingRootTasks);
    abort(children, abortReason);
    startFlowing(children, {
      push: function (chunk) {
        null !== chunk && (result += chunk);
        return true;
      },
      destroy: function (error) {
        didFatal = true;
        fatalError2 = error;
      },
    });
    if (didFatal && fatalError2 !== abortReason) throw fatalError2;
    if (!readyToStream) throw Error(formatProdErrorMessage(426));
    return result;
  }
  reactDomServerLegacy_browser_production.renderToStaticMarkup = function (children, options) {
    return renderToStringImpl(
      children,
      options,
      true,
      'The server used "renderToStaticMarkup" which does not support Suspense. If you intended to have the server wait for the suspended component please switch to "renderToReadableStream" which supports Suspense on the server',
    );
  };
  reactDomServerLegacy_browser_production.renderToString = function (children, options) {
    return renderToStringImpl(
      children,
      options,
      false,
      'The server used "renderToString" which does not support Suspense. If you intended for this Suspense boundary to render the fallback content on the server consider throwing an Error somewhere within the Suspense boundary. If you intended to have the server wait for the suspended component please switch to "renderToReadableStream" which supports Suspense on the server',
    );
  };
  reactDomServerLegacy_browser_production.version = "19.2.5";
  return reactDomServerLegacy_browser_production;
}
var hasRequiredServer_edge;
function requireServer_edge() {
  if (hasRequiredServer_edge) return server_edge;
  hasRequiredServer_edge = 1;
  var b2;
  var l;
  {
    b2 = requireReactDomServer_edge_production();
    l = requireReactDomServerLegacy_browser_production();
  }
  server_edge.version = b2.version;
  server_edge.renderToReadableStream = b2.renderToReadableStream;
  server_edge.renderToString = l.renderToString;
  server_edge.renderToStaticMarkup = l.renderToStaticMarkup;
  server_edge.resume = b2.resume;
  return server_edge;
}
var server_edgeExports = requireServer_edge();
const ReactDOMServer = /* @__PURE__ */ getDefaultExportFromCjs(server_edgeExports);
function dehydrateSsrMatchId(id) {
  return id.replaceAll("/", "\0");
}
var tsrScript_default =
  "self.$_TSR={h(){this.hydrated=!0,this.c()},e(){this.streamEnded=!0,this.c()},c(){this.hydrated&&this.streamEnded&&(delete self.$_TSR,delete self.$R.tsr)},p(e){this.initialized?e():this.buffer.push(e)},buffer:[]}";
var SCOPE_ID = "tsr";
var TSR_PREFIX = GLOBAL_TSR + ".router=";
var P_PREFIX = GLOBAL_TSR + ".p(()=>";
var P_SUFFIX = ")";
function dehydrateMatch(match) {
  const dehydratedMatch = {
    i: dehydrateSsrMatchId(match.id),
    u: match.updatedAt,
    s: match.status,
  };
  for (const [key, shorthand] of [
    ["__beforeLoadContext", "b"],
    ["loaderData", "l"],
    ["error", "e"],
    ["ssr", "ssr"],
  ])
    if (match[key] !== void 0) dehydratedMatch[shorthand] = match[key];
  if (match.globalNotFound) dehydratedMatch.g = true;
  return dehydratedMatch;
}
var INITIAL_SCRIPTS = [mn(SCOPE_ID), tsrScript_default];
var ScriptBuffer = class {
  constructor(router) {
    this._scriptBarrierLifted = false;
    this._cleanedUp = false;
    this._pendingMicrotask = false;
    this.router = router;
    this._queue = INITIAL_SCRIPTS.slice();
  }
  enqueue(script) {
    if (this._cleanedUp) return;
    this._queue.push(script);
    if (this._scriptBarrierLifted && !this._pendingMicrotask) {
      this._pendingMicrotask = true;
      queueMicrotask(() => {
        this._pendingMicrotask = false;
        this.injectBufferedScripts();
      });
    }
  }
  liftBarrier() {
    if (this._scriptBarrierLifted || this._cleanedUp) return;
    this._scriptBarrierLifted = true;
    if (this._queue.length > 0 && !this._pendingMicrotask) {
      this._pendingMicrotask = true;
      queueMicrotask(() => {
        this._pendingMicrotask = false;
        this.injectBufferedScripts();
      });
    }
  }
  /**
   * Flushes any pending scripts synchronously.
   * Call this before emitting onSerializationFinished to ensure all scripts are injected.
   *
   * IMPORTANT: Only injects if the barrier has been lifted. Before the barrier is lifted,
   * scripts should remain in the queue so takeBufferedScripts() can retrieve them
   */
  flush() {
    if (!this._scriptBarrierLifted) return;
    if (this._cleanedUp) return;
    this._pendingMicrotask = false;
    const scriptsToInject = this.takeAll();
    if (scriptsToInject && this.router?.serverSsr)
      this.router.serverSsr.injectScript(scriptsToInject);
  }
  takeAll() {
    const bufferedScripts = this._queue;
    this._queue = [];
    if (bufferedScripts.length === 0) return;
    if (bufferedScripts.length === 1)
      return bufferedScripts[0] + ";document.currentScript.remove()";
    return bufferedScripts.join(";") + ";document.currentScript.remove()";
  }
  injectBufferedScripts() {
    if (this._cleanedUp) return;
    if (this._queue.length === 0) return;
    const scriptsToInject = this.takeAll();
    if (scriptsToInject && this.router?.serverSsr)
      this.router.serverSsr.injectScript(scriptsToInject);
  }
  cleanup() {
    this._cleanedUp = true;
    this._queue = [];
    this.router = void 0;
  }
};
var MANIFEST_CACHE_SIZE = 100;
var manifestCaches = /* @__PURE__ */ new WeakMap();
function getManifestCache(manifest2) {
  const cache = manifestCaches.get(manifest2);
  if (cache) return cache;
  const newCache = createLRUCache(MANIFEST_CACHE_SIZE);
  manifestCaches.set(manifest2, newCache);
  return newCache;
}
function attachRouterServerSsrUtils({
  router,
  manifest: manifest2,
  getRequestAssets,
  includeUnmatchedRouteAssets = true,
}) {
  router.ssr = {
    get manifest() {
      const requestAssets = getRequestAssets?.();
      if (!requestAssets?.length) return manifest2;
      return {
        ...manifest2,
        routes: {
          ...manifest2?.routes,
          [rootRouteId]: {
            ...manifest2?.routes?.[rootRouteId],
            assets: [...requestAssets, ...(manifest2?.routes?.["__root__"]?.assets ?? [])],
          },
        },
      };
    },
  };
  let _dehydrated = false;
  let _serializationFinished = false;
  const renderFinishedListeners = [];
  const serializationFinishedListeners = [];
  const scriptBuffer = new ScriptBuffer(router);
  let injectedHtmlBuffer = "";
  router.serverSsr = {
    injectHtml: (html) => {
      if (!html) return;
      injectedHtmlBuffer += html;
      router.emit({ type: "onInjectedHtml" });
    },
    injectScript: (script) => {
      if (!script) return;
      const html = `<script${router.options.ssr?.nonce ? ` nonce='${router.options.ssr.nonce}'` : ""}>${script}<\/script>`;
      router.serverSsr.injectHtml(html);
    },
    dehydrate: async (opts) => {
      if (_dehydrated) {
        invariant();
      }
      let matchesToDehydrate = router.stores.matches.get();
      if (router.isShell()) matchesToDehydrate = matchesToDehydrate.slice(0, 1);
      const matches = matchesToDehydrate.map(dehydrateMatch);
      let manifestToDehydrate = void 0;
      if (manifest2) {
        const currentRouteIdsList = matchesToDehydrate.map((m2) => m2.routeId);
        const manifestCacheKey = `${currentRouteIdsList.join("\0")}\0includeUnmatchedRouteAssets=${includeUnmatchedRouteAssets}`;
        let filteredRoutes;
        filteredRoutes = getManifestCache(manifest2).get(manifestCacheKey);
        if (!filteredRoutes) {
          const currentRouteIds = new Set(currentRouteIdsList);
          const nextFilteredRoutes = {};
          for (const routeId in manifest2.routes) {
            const routeManifest = manifest2.routes[routeId];
            if (currentRouteIds.has(routeId)) nextFilteredRoutes[routeId] = routeManifest;
            else if (
              includeUnmatchedRouteAssets &&
              routeManifest.assets &&
              routeManifest.assets.length > 0
            )
              nextFilteredRoutes[routeId] = { assets: routeManifest.assets };
          }
          getManifestCache(manifest2).set(manifestCacheKey, nextFilteredRoutes);
          filteredRoutes = nextFilteredRoutes;
        }
        manifestToDehydrate = { routes: filteredRoutes };
        if (opts?.requestAssets?.length) {
          const existingRoot = manifestToDehydrate.routes[rootRouteId];
          manifestToDehydrate.routes[rootRouteId] = {
            ...existingRoot,
            assets: [...opts.requestAssets, ...(existingRoot?.assets ?? [])],
          };
        }
      }
      const dehydratedRouter = {
        manifest: manifestToDehydrate,
        matches,
      };
      const lastMatchId = matchesToDehydrate[matchesToDehydrate.length - 1]?.id;
      if (lastMatchId) dehydratedRouter.lastMatchId = dehydrateSsrMatchId(lastMatchId);
      const dehydratedData = await router.options.dehydrate?.();
      if (dehydratedData) dehydratedRouter.dehydratedData = dehydratedData;
      _dehydrated = true;
      const trackPlugins = { didRun: false };
      const serializationAdapters = router.options.serializationAdapters;
      const plugins = serializationAdapters
        ? serializationAdapters
            .map((t) => /* @__PURE__ */ makeSsrSerovalPlugin(t, trackPlugins))
            .concat(defaultSerovalPlugins)
        : defaultSerovalPlugins;
      const signalSerializationComplete = () => {
        _serializationFinished = true;
        try {
          serializationFinishedListeners.forEach((l) => l());
          router.emit({ type: "onSerializationFinished" });
        } catch (err) {
          console.error("Serialization listener error:", err);
        } finally {
          serializationFinishedListeners.length = 0;
          renderFinishedListeners.length = 0;
        }
      };
      cn(dehydratedRouter, {
        refs: /* @__PURE__ */ new Map(),
        plugins,
        onSerialize: (data, initial) => {
          let serialized = initial ? TSR_PREFIX + data : data;
          if (trackPlugins.didRun) serialized = P_PREFIX + serialized + P_SUFFIX;
          scriptBuffer.enqueue(serialized);
        },
        onError: (err) => {
          console.error("Serialization error:", err);
          if (err && err.stack) console.error(err.stack);
          signalSerializationComplete();
        },
        scopeId: SCOPE_ID,
        onDone: () => {
          scriptBuffer.enqueue(GLOBAL_TSR + ".e()");
          scriptBuffer.flush();
          signalSerializationComplete();
        },
      });
    },
    isDehydrated() {
      return _dehydrated;
    },
    isSerializationFinished() {
      return _serializationFinished;
    },
    onRenderFinished: (listener) => renderFinishedListeners.push(listener),
    onSerializationFinished: (listener) => serializationFinishedListeners.push(listener),
    setRenderFinished: () => {
      try {
        renderFinishedListeners.forEach((l) => l());
      } catch (err) {
        console.error("Error in render finished listener:", err);
      } finally {
        renderFinishedListeners.length = 0;
      }
      scriptBuffer.liftBarrier();
    },
    takeBufferedScripts() {
      const scripts = scriptBuffer.takeAll();
      return {
        tag: "script",
        attrs: {
          nonce: router.options.ssr?.nonce,
          className: "$tsr",
          id: TSR_SCRIPT_BARRIER_ID,
        },
        children: scripts,
      };
    },
    liftScriptBarrier() {
      scriptBuffer.liftBarrier();
    },
    takeBufferedHtml() {
      if (!injectedHtmlBuffer) return;
      const buffered = injectedHtmlBuffer;
      injectedHtmlBuffer = "";
      return buffered;
    },
    cleanup() {
      if (!router.serverSsr) return;
      renderFinishedListeners.length = 0;
      serializationFinishedListeners.length = 0;
      injectedHtmlBuffer = "";
      scriptBuffer.cleanup();
      router.serverSsr = void 0;
    },
  };
}
function getOrigin(request) {
  try {
    return new URL(request.url).origin;
  } catch {}
  return "http://localhost";
}
function getNormalizedURL(url, base) {
  if (typeof url === "string") url = url.replace("\\", "%5C");
  const rawUrl = new URL(url, base);
  const { path: decodedPathname, handledProtocolRelativeURL } = decodePath(rawUrl.pathname);
  const searchParams = new URLSearchParams(rawUrl.search);
  const normalizedHref =
    decodedPathname + (searchParams.size > 0 ? "?" : "") + searchParams.toString() + rawUrl.hash;
  return {
    url: new URL(normalizedHref, rawUrl.origin),
    handledProtocolRelativeURL,
  };
}
function splitSetCookieString(cookiesString) {
  if (Array.isArray(cookiesString)) return cookiesString.flatMap((c2) => splitSetCookieString(c2));
  if (typeof cookiesString !== "string") return [];
  const cookiesStrings = [];
  let pos = 0;
  let start;
  let ch;
  let lastComma;
  let nextStart;
  let cookiesSeparatorFound;
  const skipWhitespace = () => {
    while (pos < cookiesString.length && /\s/.test(cookiesString.charAt(pos))) pos += 1;
    return pos < cookiesString.length;
  };
  const notSpecialChar = () => {
    ch = cookiesString.charAt(pos);
    return ch !== "=" && ch !== ";" && ch !== ",";
  };
  while (pos < cookiesString.length) {
    start = pos;
    cookiesSeparatorFound = false;
    while (skipWhitespace()) {
      ch = cookiesString.charAt(pos);
      if (ch === ",") {
        lastComma = pos;
        pos += 1;
        skipWhitespace();
        nextStart = pos;
        while (pos < cookiesString.length && notSpecialChar()) pos += 1;
        if (pos < cookiesString.length && cookiesString.charAt(pos) === "=") {
          cookiesSeparatorFound = true;
          pos = nextStart;
          cookiesStrings.push(cookiesString.slice(start, lastComma));
          start = pos;
        } else pos = lastComma + 1;
      } else pos += 1;
    }
    if (!cookiesSeparatorFound || pos >= cookiesString.length)
      cookiesStrings.push(cookiesString.slice(start));
  }
  return cookiesStrings;
}
function toHeadersInstance(init) {
  if (init instanceof Headers) return init;
  else if (Array.isArray(init)) return new Headers(init);
  else if (typeof init === "object") return new Headers(init);
  else return null;
}
function mergeHeaders(...headers) {
  return headers.reduce((acc, header) => {
    const headersInstance = toHeadersInstance(header);
    if (!headersInstance) return acc;
    for (const [key, value] of headersInstance.entries())
      if (key === "set-cookie")
        splitSetCookieString(value).forEach((cookie) => acc.append("set-cookie", cookie));
      else acc.set(key, value);
    return acc;
  }, new Headers());
}
function defineHandlerCallback(handler) {
  return handler;
}
function transformReadableStreamWithRouter(router, routerStream) {
  return transformStreamWithRouter(router, routerStream);
}
function transformPipeableStreamWithRouter(router, routerStream) {
  return Readable.fromWeb(transformStreamWithRouter(router, Readable.toWeb(routerStream)));
}
var BODY_END_TAG = "</body>";
var HTML_END_TAG = "</html>";
var MIN_CLOSING_TAG_LENGTH = 4;
var DEFAULT_SERIALIZATION_TIMEOUT_MS = 6e4;
var DEFAULT_LIFETIME_TIMEOUT_MS = 6e4;
var textEncoder$1 = new TextEncoder();
function findLastClosingTagEnd(str) {
  const len = str.length;
  if (len < MIN_CLOSING_TAG_LENGTH) return -1;
  let i = len - 1;
  while (i >= MIN_CLOSING_TAG_LENGTH - 1) {
    if (str.charCodeAt(i) === 62) {
      let j2 = i - 1;
      while (j2 >= 1) {
        const code = str.charCodeAt(j2);
        if (
          (code >= 97 && code <= 122) ||
          (code >= 65 && code <= 90) ||
          (code >= 48 && code <= 57) ||
          code === 95 ||
          code === 58 ||
          code === 46 ||
          code === 45
        )
          j2--;
        else break;
      }
      const tagNameStart = j2 + 1;
      if (tagNameStart < i) {
        const startCode = str.charCodeAt(tagNameStart);
        if ((startCode >= 97 && startCode <= 122) || (startCode >= 65 && startCode <= 90)) {
          if (j2 >= 1 && str.charCodeAt(j2) === 47 && str.charCodeAt(j2 - 1) === 60) return i + 1;
        }
      }
    }
    i--;
  }
  return -1;
}
function transformStreamWithRouter(router, appStream, opts) {
  const serializationAlreadyFinished = router.serverSsr?.isSerializationFinished() ?? false;
  const initialBufferedHtml = router.serverSsr?.takeBufferedHtml();
  if (serializationAlreadyFinished && !initialBufferedHtml) {
    let cleanedUp2 = false;
    let controller2;
    let isStreamClosed2 = false;
    let lifetimeTimeoutHandle2;
    const cleanup2 = () => {
      if (cleanedUp2) return;
      cleanedUp2 = true;
      if (lifetimeTimeoutHandle2 !== void 0) {
        clearTimeout(lifetimeTimeoutHandle2);
        lifetimeTimeoutHandle2 = void 0;
      }
      router.serverSsr?.cleanup();
    };
    const safeClose2 = () => {
      if (isStreamClosed2) return;
      isStreamClosed2 = true;
      try {
        controller2?.close();
      } catch {}
    };
    const safeError2 = (error) => {
      if (isStreamClosed2) return;
      isStreamClosed2 = true;
      try {
        controller2?.error(error);
      } catch {}
    };
    const lifetimeMs2 = DEFAULT_LIFETIME_TIMEOUT_MS;
    lifetimeTimeoutHandle2 = setTimeout(() => {
      if (!cleanedUp2 && !isStreamClosed2) {
        console.warn(
          `SSR stream transform exceeded maximum lifetime (${lifetimeMs2}ms), forcing cleanup`,
        );
        safeError2(/* @__PURE__ */ new Error("Stream lifetime exceeded"));
        cleanup2();
      }
    }, lifetimeMs2);
    const stream2 = new ReadableStream$1({
      start(c2) {
        controller2 = c2;
      },
      cancel() {
        isStreamClosed2 = true;
        cleanup2();
      },
    });
    (async () => {
      const reader = appStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (cleanedUp2 || isStreamClosed2) return;
          controller2?.enqueue(value);
        }
        if (cleanedUp2 || isStreamClosed2) return;
        router.serverSsr?.setRenderFinished();
        safeClose2();
        cleanup2();
      } catch (error) {
        if (cleanedUp2) return;
        console.error("Error reading appStream:", error);
        router.serverSsr?.setRenderFinished();
        safeError2(error);
        cleanup2();
      } finally {
        reader.releaseLock();
      }
    })().catch((error) => {
      if (cleanedUp2) return;
      console.error("Error in stream transform:", error);
      safeError2(error);
      cleanup2();
    });
    return stream2;
  }
  let stopListeningToInjectedHtml;
  let stopListeningToSerializationFinished;
  let serializationTimeoutHandle;
  let lifetimeTimeoutHandle;
  let cleanedUp = false;
  let controller;
  let isStreamClosed = false;
  const textDecoder = new TextDecoder();
  let pendingRouterHtml = initialBufferedHtml ?? "";
  let leftover = "";
  let pendingClosingTags = "";
  const MAX_LEFTOVER_CHARS = 2048;
  let isAppRendering = true;
  let streamBarrierLifted = false;
  let serializationFinished = serializationAlreadyFinished;
  function safeEnqueue(chunk) {
    if (isStreamClosed) return;
    if (typeof chunk === "string") controller.enqueue(textEncoder$1.encode(chunk));
    else controller.enqueue(chunk);
  }
  function safeClose() {
    if (isStreamClosed) return;
    isStreamClosed = true;
    try {
      controller.close();
    } catch {}
  }
  function safeError(error) {
    if (isStreamClosed) return;
    isStreamClosed = true;
    try {
      controller.error(error);
    } catch {}
  }
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      stopListeningToInjectedHtml?.();
      stopListeningToSerializationFinished?.();
    } catch {}
    stopListeningToInjectedHtml = void 0;
    stopListeningToSerializationFinished = void 0;
    if (serializationTimeoutHandle !== void 0) {
      clearTimeout(serializationTimeoutHandle);
      serializationTimeoutHandle = void 0;
    }
    if (lifetimeTimeoutHandle !== void 0) {
      clearTimeout(lifetimeTimeoutHandle);
      lifetimeTimeoutHandle = void 0;
    }
    pendingRouterHtml = "";
    leftover = "";
    pendingClosingTags = "";
    router.serverSsr?.cleanup();
  }
  const stream = new ReadableStream$1({
    start(c2) {
      controller = c2;
    },
    cancel() {
      isStreamClosed = true;
      cleanup();
    },
  });
  function flushPendingRouterHtml() {
    if (!pendingRouterHtml) return;
    safeEnqueue(pendingRouterHtml);
    pendingRouterHtml = "";
  }
  function appendRouterHtml(html) {
    if (!html) return;
    pendingRouterHtml += html;
  }
  function tryFinish() {
    if (isAppRendering || !serializationFinished) return;
    if (cleanedUp || isStreamClosed) return;
    if (serializationTimeoutHandle !== void 0) {
      clearTimeout(serializationTimeoutHandle);
      serializationTimeoutHandle = void 0;
    }
    const decoderRemainder = textDecoder.decode();
    if (leftover) safeEnqueue(leftover);
    if (decoderRemainder) safeEnqueue(decoderRemainder);
    flushPendingRouterHtml();
    if (pendingClosingTags) safeEnqueue(pendingClosingTags);
    safeClose();
    cleanup();
  }
  const lifetimeMs = DEFAULT_LIFETIME_TIMEOUT_MS;
  lifetimeTimeoutHandle = setTimeout(() => {
    if (!cleanedUp && !isStreamClosed) {
      console.warn(
        `SSR stream transform exceeded maximum lifetime (${lifetimeMs}ms), forcing cleanup`,
      );
      safeError(/* @__PURE__ */ new Error("Stream lifetime exceeded"));
      cleanup();
    }
  }, lifetimeMs);
  if (!serializationAlreadyFinished) {
    stopListeningToInjectedHtml = router.subscribe("onInjectedHtml", () => {
      if (cleanedUp || isStreamClosed) return;
      const html = router.serverSsr?.takeBufferedHtml();
      if (!html) return;
      if (isAppRendering || leftover || pendingClosingTags) appendRouterHtml(html);
      else {
        flushPendingRouterHtml();
        safeEnqueue(html);
      }
    });
    stopListeningToSerializationFinished = router.subscribe("onSerializationFinished", () => {
      serializationFinished = true;
      tryFinish();
    });
  }
  (async () => {
    const reader = appStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (cleanedUp || isStreamClosed) return;
        const text =
          value instanceof Uint8Array ? textDecoder.decode(value, { stream: true }) : String(value);
        const chunkString = leftover ? leftover + text : text;
        if (!streamBarrierLifted) {
          if (chunkString.includes("$tsr-stream-barrier")) {
            streamBarrierLifted = true;
            router.serverSsr?.liftScriptBarrier();
          }
        }
        if (pendingClosingTags) {
          pendingClosingTags += chunkString;
          leftover = "";
          continue;
        }
        const bodyEndIndex = chunkString.indexOf(BODY_END_TAG);
        const htmlEndIndex = chunkString.indexOf(HTML_END_TAG);
        if (bodyEndIndex !== -1 && htmlEndIndex !== -1 && bodyEndIndex < htmlEndIndex) {
          pendingClosingTags = chunkString.slice(bodyEndIndex);
          safeEnqueue(chunkString.slice(0, bodyEndIndex));
          flushPendingRouterHtml();
          leftover = "";
          continue;
        }
        const lastClosingTagEnd = findLastClosingTagEnd(chunkString);
        if (lastClosingTagEnd > 0) {
          safeEnqueue(chunkString.slice(0, lastClosingTagEnd));
          flushPendingRouterHtml();
          leftover = chunkString.slice(lastClosingTagEnd);
          if (leftover.length > MAX_LEFTOVER_CHARS) {
            safeEnqueue(leftover.slice(0, leftover.length - MAX_LEFTOVER_CHARS));
            leftover = leftover.slice(-MAX_LEFTOVER_CHARS);
          }
        } else {
          const combined = chunkString;
          if (combined.length > MAX_LEFTOVER_CHARS) {
            const flushUpto = combined.length - MAX_LEFTOVER_CHARS;
            safeEnqueue(combined.slice(0, flushUpto));
            leftover = combined.slice(flushUpto);
          } else leftover = combined;
        }
      }
      if (cleanedUp || isStreamClosed) return;
      isAppRendering = false;
      router.serverSsr?.setRenderFinished();
      if (serializationFinished) tryFinish();
      else {
        const timeoutMs = opts?.timeoutMs ?? DEFAULT_SERIALIZATION_TIMEOUT_MS;
        serializationTimeoutHandle = setTimeout(() => {
          if (!cleanedUp && !isStreamClosed) {
            console.error("Serialization timeout after app render finished");
            safeError(/* @__PURE__ */ new Error("Serialization timeout after app render finished"));
            cleanup();
          }
        }, timeoutMs);
      }
    } catch (error) {
      if (cleanedUp) return;
      console.error("Error reading appStream:", error);
      isAppRendering = false;
      router.serverSsr?.setRenderFinished();
      safeError(error);
      cleanup();
    } finally {
      reader.releaseLock();
    }
  })().catch((error) => {
    if (cleanedUp) return;
    console.error("Error in stream transform:", error);
    safeError(error);
    cleanup();
  });
  return stream;
}
var fullPattern =
  " daum[ /]| deusu/|(?:^|[^g])news(?!sapphire)|(?<! (?:channel/|google/))google(?!(app|/google| pixel))|(?<! cu)bots?(?:\\b|_)|(?<!(?:lib))http|(?<!cam)scan|24x7|@[a-z][\\w-]+\\.|\\(\\)|\\.com\\b|\\b\\w+\\.ai|\\bcursor/|\\bmanus-user/|\\bort/|\\bperl\\b|\\bplaywright\\b|\\bsecurityheaders\\b|\\bselenium\\b|\\btime/|\\||^[\\w \\.\\-\\(?:\\):%]+(?:/v?\\d+(?:\\.\\d+)?(?:\\.\\d{1,10})*?)?(?:,|$)|^[\\w\\-]+/[\\w]+$|^[^ ]{50,}$|^\\d+\\b|^\\W|^\\w*search\\b|^\\w+/[\\w\\(\\)]*$|^\\w+/\\d\\.\\d\\s\\([\\w@]+\\)$|^active|^ad muncher|^amaya|^apache/|^avsdevicesdk/|^azure|^biglotron|^bot|^bw/|^clamav[ /]|^claude-code/|^client/|^cobweb/|^custom|^ddg[_-]android|^discourse|^dispatch/\\d|^downcast/|^duckduckgo|^email|^facebook|^getright/|^gozilla/|^hobbit|^hotzonu|^hwcdn/|^igetter/|^jeode/|^jetty/|^jigsaw|^microsoft bits|^movabletype|^mozilla/\\d\\.\\d\\s[\\w\\.-]+$|^mozilla/\\d\\.\\d\\s\\((?:compatible;)?(?:\\s?[\\w\\d-.]+\\/\\d+\\.\\d+)?\\)$|^navermailapp|^netsurf|^offline|^openai/|^owler|^php|^postman|^python|^rank|^read|^reed|^rest|^rss|^snapchat|^space bison|^svn|^swcd |^taringa|^thumbor/|^track|^w3c|^webbandit/|^webcopier|^wget|^whatsapp|^wordpress|^xenu link sleuth|^yahoo|^yandex|^zdm/\\d|^zoom marketplace/|advisor|agent\\b|analyzer|archive|ask jeeves/teoma|audit|bit\\.ly/|bluecoat drtr|browsex|burpcollaborator|capture|catch|check\\b|checker|chrome-lighthouse|chromeframe|classifier|cloudflare|convertify|crawl|cypress/|dareboost|datanyze|dejaclick|detect|dmbrowser|download|exaleadcloudview|feed|fetcher|firephp|functionize|grab|headless|httrack|hubspot marketing grader|ibisbrowser|infrawatch|insight|inspect|iplabel|java(?!;)|library|linkcheck|mail\\.ru/|manager|measure|monitor\\b|neustar wpm|node\\b|nutch|offbyone|onetrust|optimize|pageburst|pagespeed|parser|phantomjs|pingdom|powermarks|preview|proxy|ptst[ /]\\d|retriever|rexx;|rigor|rss\\b|scrape|server|sogou|sparkler/|speedcurve|spider|splash|statuscake|supercleaner|synapse|synthetic|tools|torrent|transcoder|url|validator|virtuoso|wappalyzer|webglance|webkit2png|whatcms/|xtate/";
var naivePattern = /bot|crawl|http|lighthouse|scan|search|spider/i;
var pattern;
function getPattern() {
  if (pattern instanceof RegExp) {
    return pattern;
  }
  try {
    pattern = new RegExp(fullPattern, "i");
  } catch (error) {
    pattern = naivePattern;
  }
  return pattern;
}
var isNonEmptyString = (value) => typeof value === "string" && value !== "";
function isbot(userAgent) {
  return isNonEmptyString(userAgent) && getPattern().test(userAgent);
}
var renderRouterToStream = async ({ request, router, responseHeaders, children }) => {
  if (typeof ReactDOMServer.renderToReadableStream === "function") {
    const stream = await ReactDOMServer.renderToReadableStream(children, {
      signal: request.signal,
      nonce: router.options.ssr?.nonce,
      progressiveChunkSize: Number.POSITIVE_INFINITY,
    });
    if (isbot(request.headers.get("User-Agent"))) await stream.allReady;
    const responseStream = transformReadableStreamWithRouter(router, stream);
    return new Response(responseStream, {
      status: router.stores.statusCode.get(),
      headers: responseHeaders,
    });
  }
  if (typeof ReactDOMServer.renderToPipeableStream === "function") {
    const reactAppPassthrough = new PassThrough();
    try {
      const pipeable = ReactDOMServer.renderToPipeableStream(children, {
        nonce: router.options.ssr?.nonce,
        progressiveChunkSize: Number.POSITIVE_INFINITY,
        ...(isbot(request.headers.get("User-Agent"))
          ? {
              onAllReady() {
                pipeable.pipe(reactAppPassthrough);
              },
            }
          : {
              onShellReady() {
                pipeable.pipe(reactAppPassthrough);
              },
            }),
        onError: (error, info) => {
          console.error("Error in renderToPipeableStream:", error, info);
          if (!reactAppPassthrough.destroyed)
            reactAppPassthrough.destroy(error instanceof Error ? error : new Error(String(error)));
        },
      });
    } catch (e) {
      console.error("Error in renderToPipeableStream:", e);
      reactAppPassthrough.destroy(e instanceof Error ? e : new Error(String(e)));
    }
    const responseStream = transformPipeableStreamWithRouter(router, reactAppPassthrough);
    return new Response(responseStream, {
      status: router.stores.statusCode.get(),
      headers: responseHeaders,
    });
  }
  throw new Error(
    "No renderToReadableStream or renderToPipeableStream found in react-dom/server. Ensure you are using a version of react-dom that supports streaming.",
  );
};
var defaultStreamHandler = defineHandlerCallback(({ request, router, responseHeaders }) =>
  renderRouterToStream({
    request,
    router,
    responseHeaders,
    children: /* @__PURE__ */ jsxRuntimeExports.jsx(StartServer, { router }),
  }),
);
const NullProtoObj = /* @__PURE__ */ (() => {
  const e = function () {};
  return ((e.prototype = /* @__PURE__ */ Object.create(null)), Object.freeze(e.prototype), e);
})();
const FastURL = URL;
const FastResponse = Response;
function decodePathname(pathname) {
  return decodeURI(pathname.includes("%25") ? pathname.replace(/%25/g, "%2525") : pathname);
}
const kEventNS = "h3.internal.event.";
const kEventRes = /* @__PURE__ */ Symbol.for(`${kEventNS}res`);
const kEventResHeaders = /* @__PURE__ */ Symbol.for(`${kEventNS}res.headers`);
const kEventResErrHeaders = /* @__PURE__ */ Symbol.for(`${kEventNS}res.err.headers`);
var H3Event = class {
  app;
  req;
  url;
  context;
  static __is_event__ = true;
  constructor(req, context, app) {
    this.context = context || req.context || new NullProtoObj();
    this.req = req;
    this.app = app;
    const _url = req._url;
    const url = _url && _url instanceof URL ? _url : new FastURL(req.url);
    if (url.pathname.includes("%")) url.pathname = decodePathname(url.pathname);
    this.url = url;
  }
  get res() {
    return (this[kEventRes] ||= new H3EventResponse());
  }
  get runtime() {
    return this.req.runtime;
  }
  waitUntil(promise) {
    this.req.waitUntil?.(promise);
  }
  toString() {
    return `[${this.req.method}] ${this.req.url}`;
  }
  toJSON() {
    return this.toString();
  }
  get node() {
    return this.req.runtime?.node;
  }
  get headers() {
    return this.req.headers;
  }
  get path() {
    return this.url.pathname + this.url.search;
  }
  get method() {
    return this.req.method;
  }
};
var H3EventResponse = class {
  status;
  statusText;
  get headers() {
    return (this[kEventResHeaders] ||= new Headers());
  }
  get errHeaders() {
    return (this[kEventResErrHeaders] ||= new Headers());
  }
};
const DISALLOWED_STATUS_CHARS = /[^\u0009\u0020-\u007E]/g;
function sanitizeStatusMessage(statusMessage = "") {
  return statusMessage.replace(DISALLOWED_STATUS_CHARS, "");
}
function sanitizeStatusCode(statusCode, defaultStatusCode = 200) {
  if (!statusCode) return defaultStatusCode;
  if (typeof statusCode === "string") statusCode = +statusCode;
  if (statusCode < 100 || statusCode > 599) return defaultStatusCode;
  return statusCode;
}
var HTTPError = class HTTPError2 extends Error {
  get name() {
    return "HTTPError";
  }
  status;
  statusText;
  headers;
  cause;
  data;
  body;
  unhandled;
  static isError(input) {
    return input instanceof Error && input?.name === "HTTPError";
  }
  static status(status, statusText, details) {
    return new HTTPError2({
      ...details,
      statusText,
      status,
    });
  }
  constructor(arg1, arg2) {
    let messageInput;
    let details;
    if (typeof arg1 === "string") {
      messageInput = arg1;
      details = arg2;
    } else details = arg1;
    const status = sanitizeStatusCode(
      details?.status ||
        details?.statusCode ||
        details?.cause?.status ||
        details?.cause?.statusCode,
      500,
    );
    const statusText = sanitizeStatusMessage(
      details?.statusText ||
        details?.statusMessage ||
        details?.cause?.statusText ||
        details?.cause?.statusMessage,
    );
    const message =
      messageInput ||
      details?.message ||
      details?.cause?.message ||
      details?.statusText ||
      details?.statusMessage ||
      ["HTTPError", status, statusText].filter(Boolean).join(" ");
    super(message, { cause: details });
    this.cause = details;
    this.status = status;
    this.statusText = statusText || void 0;
    const rawHeaders = details?.headers || details?.cause?.headers;
    this.headers = rawHeaders ? new Headers(rawHeaders) : void 0;
    this.unhandled = details?.unhandled ?? details?.cause?.unhandled ?? void 0;
    this.data = details?.data;
    this.body = details?.body;
  }
  get statusCode() {
    return this.status;
  }
  get statusMessage() {
    return this.statusText;
  }
  toJSON() {
    const unhandled = this.unhandled;
    return {
      status: this.status,
      statusText: this.statusText,
      unhandled,
      message: unhandled ? "HTTPError" : this.message,
      data: unhandled ? void 0 : this.data,
      ...(unhandled ? void 0 : this.body),
    };
  }
};
function isJSONSerializable(value, _type) {
  if (value === null || value === void 0) return true;
  if (_type !== "object") return _type === "boolean" || _type === "number" || _type === "string";
  if (typeof value.toJSON === "function") return true;
  if (Array.isArray(value)) return true;
  if (typeof value.pipe === "function" || typeof value.pipeTo === "function") return false;
  if (value instanceof NullProtoObj) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
const kNotFound = /* @__PURE__ */ Symbol.for("h3.notFound");
const kHandled = /* @__PURE__ */ Symbol.for("h3.handled");
function toResponse(val, event, config = {}) {
  if (typeof val?.then === "function")
    return (val.catch?.((error) => error) || Promise.resolve(val)).then((resolvedVal) =>
      toResponse(resolvedVal, event, config),
    );
  const response = prepareResponse(val, event, config);
  if (typeof response?.then === "function") return toResponse(response, event, config);
  const { onResponse } = config;
  return onResponse ? Promise.resolve(onResponse(response, event)).then(() => response) : response;
}
var HTTPResponse = class {
  #headers;
  #init;
  body;
  constructor(body, init) {
    this.body = body;
    this.#init = init;
  }
  get status() {
    return this.#init?.status || 200;
  }
  get statusText() {
    return this.#init?.statusText || "OK";
  }
  get headers() {
    return (this.#headers ||= new Headers(this.#init?.headers));
  }
};
function prepareResponse(val, event, config, nested) {
  if (val === kHandled) return new FastResponse(null);
  if (val === kNotFound)
    val = new HTTPError({
      status: 404,
      message: `Cannot find any route matching [${event.req.method}] ${event.url}`,
    });
  if (val && val instanceof Error) {
    const isHTTPError = HTTPError.isError(val);
    const error = isHTTPError ? val : new HTTPError(val);
    if (!isHTTPError) {
      error.unhandled = true;
      if (val?.stack) error.stack = val.stack;
    }
    if (error.unhandled && !config.silent) console.error(error);
    const { onError } = config;
    const errHeaders = event[kEventRes]?.[kEventResErrHeaders];
    return onError && !nested
      ? Promise.resolve(onError(error, event))
          .catch((error2) => error2)
          .then((newVal) => prepareResponse(newVal ?? val, event, config, true))
      : errorResponse(error, config.debug, errHeaders);
  }
  const preparedRes = event[kEventRes];
  const preparedHeaders = preparedRes?.[kEventResHeaders];
  event[kEventRes] = void 0;
  if (!(val instanceof Response)) {
    const res = prepareResponseBody(val, event, config);
    const status = res.status || preparedRes?.status;
    return new FastResponse(nullBody(event.req.method, status) ? null : res.body, {
      status,
      statusText: res.statusText || preparedRes?.statusText,
      headers:
        res.headers && preparedHeaders
          ? mergeHeaders$1(res.headers, preparedHeaders)
          : res.headers || preparedHeaders,
    });
  }
  if (!preparedHeaders || nested || !val.ok) return val;
  try {
    mergeHeaders$1(val.headers, preparedHeaders, val.headers);
    return val;
  } catch {
    return new FastResponse(nullBody(event.req.method, val.status) ? null : val.body, {
      status: val.status,
      statusText: val.statusText,
      headers: mergeHeaders$1(val.headers, preparedHeaders),
    });
  }
}
function mergeHeaders$1(base, overrides, target = new Headers(base)) {
  for (const [name, value] of overrides)
    if (name === "set-cookie") target.append(name, value);
    else target.set(name, value);
  return target;
}
const frozen =
  (name) =>
  (...args) => {
    throw new Error(`Headers are frozen (${name} ${args.join(", ")})`);
  };
var FrozenHeaders = class extends Headers {
  set = frozen("set");
  append = frozen("append");
  delete = frozen("delete");
};
const emptyHeaders = /* @__PURE__ */ new FrozenHeaders({ "content-length": "0" });
const jsonHeaders = /* @__PURE__ */ new FrozenHeaders({
  "content-type": "application/json;charset=UTF-8",
});
function prepareResponseBody(val, event, config) {
  if (val === null || val === void 0)
    return {
      body: "",
      headers: emptyHeaders,
    };
  const valType = typeof val;
  if (valType === "string") return { body: val };
  if (val instanceof Uint8Array) {
    event.res.headers.set("content-length", val.byteLength.toString());
    return { body: val };
  }
  if (val instanceof HTTPResponse || val?.constructor?.name === "HTTPResponse") return val;
  if (isJSONSerializable(val, valType))
    return {
      body: JSON.stringify(val, void 0, config.debug ? 2 : void 0),
      headers: jsonHeaders,
    };
  if (valType === "bigint")
    return {
      body: val.toString(),
      headers: jsonHeaders,
    };
  if (val instanceof Blob) {
    const headers = new Headers({
      "content-type": val.type,
      "content-length": val.size.toString(),
    });
    let filename = val.name;
    if (filename) {
      filename = encodeURIComponent(filename);
      headers.set("content-disposition", `filename="${filename}"; filename*=UTF-8''${filename}`);
    }
    return {
      body: val.stream(),
      headers,
    };
  }
  if (valType === "symbol") return { body: val.toString() };
  if (valType === "function") return { body: `${val.name}()` };
  return { body: val };
}
function nullBody(method, status) {
  return (
    method === "HEAD" ||
    status === 100 ||
    status === 101 ||
    status === 102 ||
    status === 204 ||
    status === 205 ||
    status === 304
  );
}
function errorResponse(error, debug, errHeaders) {
  let headers = error.headers
    ? mergeHeaders$1(jsonHeaders, error.headers)
    : new Headers(jsonHeaders);
  if (errHeaders) headers = mergeHeaders$1(headers, errHeaders);
  return new FastResponse(
    JSON.stringify(
      {
        ...error.toJSON(),
        stack: debug && error.stack ? error.stack.split("\n").map((l) => l.trim()) : void 0,
      },
      void 0,
      debug ? 2 : void 0,
    ),
    {
      status: error.status,
      statusText: error.statusText,
      headers,
    },
  );
}
var GLOBAL_EVENT_STORAGE_KEY = Symbol.for("tanstack-start:event-storage");
var globalObj$1 = globalThis;
if (!globalObj$1[GLOBAL_EVENT_STORAGE_KEY])
  globalObj$1[GLOBAL_EVENT_STORAGE_KEY] = new AsyncLocalStorage$1();
var eventStorage = globalObj$1[GLOBAL_EVENT_STORAGE_KEY];
function isPromiseLike(value) {
  return typeof value.then === "function";
}
function getSetCookieValues(headers) {
  const headersWithSetCookie = headers;
  if (typeof headersWithSetCookie.getSetCookie === "function")
    return headersWithSetCookie.getSetCookie();
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}
function mergeEventResponseHeaders(response, event) {
  if (response.ok) return;
  const eventSetCookies = getSetCookieValues(event.res.headers);
  if (eventSetCookies.length === 0) return;
  const responseSetCookies = getSetCookieValues(response.headers);
  response.headers.delete("set-cookie");
  for (const cookie of responseSetCookies) response.headers.append("set-cookie", cookie);
  for (const cookie of eventSetCookies) response.headers.append("set-cookie", cookie);
}
function attachResponseHeaders(value, event) {
  if (isPromiseLike(value))
    return value.then((resolved) => {
      if (resolved instanceof Response) mergeEventResponseHeaders(resolved, event);
      return resolved;
    });
  if (value instanceof Response) mergeEventResponseHeaders(value, event);
  return value;
}
function requestHandler(handler) {
  return (request, requestOpts) => {
    let h3Event;
    try {
      h3Event = new H3Event(request);
    } catch (error) {
      if (error instanceof URIError)
        return new Response(null, {
          status: 400,
          statusText: "Bad Request",
        });
      throw error;
    }
    return toResponse(
      attachResponseHeaders(
        eventStorage.run({ h3Event }, () => handler(request, requestOpts)),
        h3Event,
      ),
      h3Event,
    );
  };
}
function getH3Event() {
  const event = eventStorage.getStore();
  if (!event)
    throw new Error(
      `No StartEvent found in AsyncLocalStorage. Make sure you are using the function within the server runtime.`,
    );
  return event.h3Event;
}
function getResponse() {
  return getH3Event().res;
}
var HEADERS = { TSS_SHELL: "X-TSS_SHELL" };
async function getStartManifest(matchedRoutes) {
  const { tsrStartManifest } = await import("./_tanstack-start-manifest_v-B6oU8hDT.js");
  const startManifest = tsrStartManifest();
  const rootRoute = (startManifest.routes[rootRouteId] = startManifest.routes[rootRouteId] || {});
  rootRoute.assets = rootRoute.assets || [];
  let injectedHeadScripts;
  return {
    manifest: {
      routes: Object.fromEntries(
        Object.entries(startManifest.routes).flatMap(([k2, v2]) => {
          const result = {};
          let hasData = false;
          if (v2.preloads && v2.preloads.length > 0) {
            result["preloads"] = v2.preloads;
            hasData = true;
          }
          if (v2.assets && v2.assets.length > 0) {
            result["assets"] = v2.assets;
            hasData = true;
          }
          if (!hasData) return [];
          return [[k2, result]];
        }),
      ),
    },
    clientEntry: startManifest.clientEntry,
    injectedHeadScripts,
  };
}
const manifest = {
  "380e4f27c86b2e828107a0454e2715b4169bf11b02de11d0dc9ad75de7d85a7e": {
    functionName: "getCount_createServerFn_handler",
    importer: () => import("./counter-09m_KVMI.js"),
  },
  f3ae7fbdf92997d56edb6ad544a8baa338da93266345b1f99e79a0149fe30543: {
    functionName: "echoTransform_createServerFn_handler",
    importer: () => import("./server-fns-B2pw5uuz.js"),
  },
  a67c4b73a356ae3a1d33059b44816740306a7d00805b408f3f4df61dabd0c14d: {
    functionName: "fetchExternalData_createServerFn_handler",
    importer: () => import("./server-fns-B2pw5uuz.js"),
  },
  fc0cf42d85c9a4ed1b9a943c0dcc8dabc8a5e27cc36271da1679ea8406a42bca: {
    functionName: "computeFib_createServerFn_handler",
    importer: () => import("./server-fns-B2pw5uuz.js"),
  },
  "7ccc88cb5fd3e0bedc82ce4d022149d8735ecacb7be1f0b8f65ce3ad4e22f706": {
    functionName: "generateId_createServerFn_handler",
    importer: () => import("./server-fns-B2pw5uuz.js"),
  },
  bcc06e110064ff306a20f0e07346328125999211fd273f8af0a4f8e5fe43cba5: {
    functionName: "getServerInfo_createServerFn_handler",
    importer: () => import("./index-CFe-T1Ti.js"),
  },
};
async function getServerFnById(id, access) {
  const serverFnInfo = manifest[id];
  if (!serverFnInfo) {
    throw new Error("Server function info not found for " + id);
  }
  const fnModule = serverFnInfo.module ?? (await serverFnInfo.importer());
  if (!fnModule) {
    throw new Error("Server function module not resolved for " + id);
  }
  const action = fnModule[serverFnInfo.functionName];
  if (!action) {
    throw new Error("Server function module export not resolved for serverFn ID: " + id);
  }
  return action;
}
var TSS_FORMDATA_CONTEXT = "__TSS_CONTEXT";
var TSS_SERVER_FUNCTION = Symbol.for("TSS_SERVER_FUNCTION");
var TSS_SERVER_FUNCTION_FACTORY = Symbol.for("TSS_SERVER_FUNCTION_FACTORY");
var X_TSS_SERIALIZED = "x-tss-serialized";
var X_TSS_RAW_RESPONSE = "x-tss-raw";
var TSS_CONTENT_TYPE_FRAMED = "application/x-tss-framed";
var FrameType = {
  JSON: 0,
  CHUNK: 1,
  END: 2,
  ERROR: 3,
};
var FRAME_HEADER_SIZE = 9;
var TSS_CONTENT_TYPE_FRAMED_VERSIONED = `${TSS_CONTENT_TYPE_FRAMED}; v=1`;
function isSafeKey(key) {
  return key !== "__proto__" && key !== "constructor" && key !== "prototype";
}
function safeObjectMerge(target, source) {
  const result = /* @__PURE__ */ Object.create(null);
  if (target) {
    for (const key of Object.keys(target)) if (isSafeKey(key)) result[key] = target[key];
  }
  if (source && typeof source === "object") {
    for (const key of Object.keys(source)) if (isSafeKey(key)) result[key] = source[key];
  }
  return result;
}
function createNullProtoObject(source) {
  if (!source) return /* @__PURE__ */ Object.create(null);
  const obj = /* @__PURE__ */ Object.create(null);
  for (const key of Object.keys(source)) if (isSafeKey(key)) obj[key] = source[key];
  return obj;
}
var GLOBAL_STORAGE_KEY = Symbol.for("tanstack-start:start-storage-context");
var globalObj = globalThis;
if (!globalObj[GLOBAL_STORAGE_KEY]) globalObj[GLOBAL_STORAGE_KEY] = new AsyncLocalStorage$1();
var startStorage = globalObj[GLOBAL_STORAGE_KEY];
async function runWithStartContext(context, fn2) {
  return startStorage.run(context, fn2);
}
function getStartContext(opts) {
  const context = startStorage.getStore();
  if (!context && opts?.throwIfNotFound !== false)
    throw new Error(
      `No Start context found in AsyncLocalStorage. Make sure you are using the function within the server runtime.`,
    );
  return context;
}
var getStartOptions = () => getStartContext().startOptions;
var getStartContextServerOnly = getStartContext;
var createServerFn = (options, __opts) => {
  const resolvedOptions = __opts || options || {};
  if (typeof resolvedOptions.method === "undefined") resolvedOptions.method = "GET";
  const res = {
    options: resolvedOptions,
    middleware: (middleware) => {
      const newMiddleware = [...(resolvedOptions.middleware || [])];
      middleware.map((m2) => {
        if (TSS_SERVER_FUNCTION_FACTORY in m2) {
          if (m2.options.middleware) newMiddleware.push(...m2.options.middleware);
        } else newMiddleware.push(m2);
      });
      const res2 = createServerFn(void 0, {
        ...resolvedOptions,
        middleware: newMiddleware,
      });
      res2[TSS_SERVER_FUNCTION_FACTORY] = true;
      return res2;
    },
    inputValidator: (inputValidator) => {
      return createServerFn(void 0, {
        ...resolvedOptions,
        inputValidator,
      });
    },
    handler: (...args) => {
      const [extractedFn, serverFn] = args;
      const newOptions = {
        ...resolvedOptions,
        extractedFn,
        serverFn,
      };
      const resolvedMiddleware = [
        ...(newOptions.middleware || []),
        serverFnBaseToMiddleware(newOptions),
      ];
      extractedFn.method = resolvedOptions.method;
      return Object.assign(
        async (opts) => {
          const result = await executeMiddleware$1(resolvedMiddleware, "client", {
            ...extractedFn,
            ...newOptions,
            data: opts?.data,
            headers: opts?.headers,
            signal: opts?.signal,
            fetch: opts?.fetch,
            context: createNullProtoObject(),
          });
          const redirect2 = parseRedirect(result.error);
          if (redirect2) throw redirect2;
          if (result.error) throw result.error;
          return result.result;
        },
        {
          ...extractedFn,
          method: resolvedOptions.method,
          __executeServer: async (opts) => {
            const startContext = getStartContextServerOnly();
            const serverContextAfterGlobalMiddlewares = startContext.contextAfterGlobalMiddlewares;
            return await executeMiddleware$1(resolvedMiddleware, "server", {
              ...extractedFn,
              ...opts,
              serverFnMeta: extractedFn.serverFnMeta,
              context: safeObjectMerge(opts.context, serverContextAfterGlobalMiddlewares),
              request: startContext.request,
            }).then((d) => ({
              result: d.result,
              error: d.error,
              context: d.sendContext,
            }));
          },
        },
      );
    },
  };
  const fun = (options2) => {
    return createServerFn(void 0, {
      ...resolvedOptions,
      ...options2,
    });
  };
  return Object.assign(fun, res);
};
async function executeMiddleware$1(middlewares, env, opts) {
  let flattenedMiddlewares = flattenMiddlewares([
    ...(getStartOptions()?.functionMiddleware || []),
    ...middlewares,
  ]);
  if (env === "server") {
    const startContext = getStartContextServerOnly({ throwIfNotFound: false });
    if (startContext?.executedRequestMiddlewares)
      flattenedMiddlewares = flattenedMiddlewares.filter(
        (m2) => !startContext.executedRequestMiddlewares.has(m2),
      );
  }
  const callNextMiddleware = async (ctx) => {
    const nextMiddleware = flattenedMiddlewares.shift();
    if (!nextMiddleware) return ctx;
    try {
      if (
        "inputValidator" in nextMiddleware.options &&
        nextMiddleware.options.inputValidator &&
        env === "server"
      )
        ctx.data = await execValidator(nextMiddleware.options.inputValidator, ctx.data);
      let middlewareFn = void 0;
      if (env === "client") {
        if ("client" in nextMiddleware.options) middlewareFn = nextMiddleware.options.client;
      } else if ("server" in nextMiddleware.options) middlewareFn = nextMiddleware.options.server;
      if (middlewareFn) {
        const userNext = async (userCtx = {}) => {
          const result2 = await callNextMiddleware({
            ...ctx,
            ...userCtx,
            context: safeObjectMerge(ctx.context, userCtx.context),
            sendContext: safeObjectMerge(ctx.sendContext, userCtx.sendContext),
            headers: mergeHeaders(ctx.headers, userCtx.headers),
            _callSiteFetch: ctx._callSiteFetch,
            fetch: ctx._callSiteFetch ?? userCtx.fetch ?? ctx.fetch,
            result:
              userCtx.result !== void 0
                ? userCtx.result
                : userCtx instanceof Response
                  ? userCtx
                  : ctx.result,
            error: userCtx.error ?? ctx.error,
          });
          if (result2.error) throw result2.error;
          return result2;
        };
        const result = await middlewareFn({
          ...ctx,
          next: userNext,
        });
        if (isRedirect(result))
          return {
            ...ctx,
            error: result,
          };
        if (result instanceof Response)
          return {
            ...ctx,
            result,
          };
        if (!result)
          throw new Error(
            "User middleware returned undefined. You must call next() or return a result in your middlewares.",
          );
        return result;
      }
      return callNextMiddleware(ctx);
    } catch (error) {
      return {
        ...ctx,
        error,
      };
    }
  };
  return callNextMiddleware({
    ...opts,
    headers: opts.headers || {},
    sendContext: opts.sendContext || {},
    context: opts.context || createNullProtoObject(),
    _callSiteFetch: opts.fetch,
  });
}
function flattenMiddlewares(middlewares, maxDepth = 100) {
  const seen = /* @__PURE__ */ new Set();
  const flattened = [];
  const recurse = (middleware, depth) => {
    if (depth > maxDepth)
      throw new Error(
        `Middleware nesting depth exceeded maximum of ${maxDepth}. Check for circular references.`,
      );
    middleware.forEach((m2) => {
      if (m2.options.middleware) recurse(m2.options.middleware, depth + 1);
      if (!seen.has(m2)) {
        seen.add(m2);
        flattened.push(m2);
      }
    });
  };
  recurse(middlewares, 0);
  return flattened;
}
async function execValidator(validator, input) {
  if (validator == null) return {};
  if ("~standard" in validator) {
    const result = await validator["~standard"].validate(input);
    if (result.issues) throw new Error(JSON.stringify(result.issues, void 0, 2));
    return result.value;
  }
  if ("parse" in validator) return validator.parse(input);
  if (typeof validator === "function") return validator(input);
  throw new Error("Invalid validator type!");
}
function serverFnBaseToMiddleware(options) {
  return {
    "~types": void 0,
    options: {
      inputValidator: options.inputValidator,
      client: async ({ next, sendContext, fetch, ...ctx }) => {
        const payload = {
          ...ctx,
          context: sendContext,
          fetch,
        };
        return next(await options.extractedFn?.(payload));
      },
      server: async ({ next, ...ctx }) => {
        const result = await options.serverFn?.(ctx);
        return next({
          ...ctx,
          result,
        });
      },
    },
  };
}
function getDefaultSerovalPlugins() {
  return [
    ...(getStartOptions()?.serializationAdapters?.map(makeSerovalPlugin) ?? []),
    ...defaultSerovalPlugins,
  ];
}
var textEncoder = new TextEncoder();
var EMPTY_PAYLOAD = new Uint8Array(0);
function encodeFrame(type, streamId, payload) {
  const frame = new Uint8Array(FRAME_HEADER_SIZE + payload.length);
  frame[0] = type;
  frame[1] = (streamId >>> 24) & 255;
  frame[2] = (streamId >>> 16) & 255;
  frame[3] = (streamId >>> 8) & 255;
  frame[4] = streamId & 255;
  frame[5] = (payload.length >>> 24) & 255;
  frame[6] = (payload.length >>> 16) & 255;
  frame[7] = (payload.length >>> 8) & 255;
  frame[8] = payload.length & 255;
  frame.set(payload, FRAME_HEADER_SIZE);
  return frame;
}
function encodeJSONFrame(json) {
  return encodeFrame(FrameType.JSON, 0, textEncoder.encode(json));
}
function encodeChunkFrame(streamId, chunk) {
  return encodeFrame(FrameType.CHUNK, streamId, chunk);
}
function encodeEndFrame(streamId) {
  return encodeFrame(FrameType.END, streamId, EMPTY_PAYLOAD);
}
function encodeErrorFrame(streamId, error) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return encodeFrame(FrameType.ERROR, streamId, textEncoder.encode(message));
}
function createMultiplexedStream(jsonStream, rawStreams, lateStreamSource) {
  let controller;
  let cancelled = false;
  const readers = [];
  const enqueue = (frame) => {
    if (cancelled) return false;
    try {
      controller.enqueue(frame);
      return true;
    } catch {
      return false;
    }
  };
  const errorOutput = (error) => {
    if (cancelled) return;
    cancelled = true;
    try {
      controller.error(error);
    } catch {}
    for (const reader of readers) reader.cancel().catch(() => {});
  };
  async function pumpRawStream(streamId, stream) {
    const reader = stream.getReader();
    readers.push(reader);
    try {
      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) {
          enqueue(encodeEndFrame(streamId));
          return;
        }
        if (!enqueue(encodeChunkFrame(streamId, value))) return;
      }
    } catch (error) {
      enqueue(encodeErrorFrame(streamId, error));
    } finally {
      reader.releaseLock();
    }
  }
  async function pumpJSON() {
    const reader = jsonStream.getReader();
    readers.push(reader);
    try {
      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) return;
        if (!enqueue(encodeJSONFrame(value))) return;
      }
    } catch (error) {
      errorOutput(error);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  async function pumpLateStreams() {
    if (!lateStreamSource) return [];
    const lateStreamPumps = [];
    const reader = lateStreamSource.getReader();
    readers.push(reader);
    try {
      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;
        lateStreamPumps.push(pumpRawStream(value.id, value.stream));
      }
    } finally {
      reader.releaseLock();
    }
    return lateStreamPumps;
  }
  return new ReadableStream({
    async start(ctrl) {
      controller = ctrl;
      const pumps = [pumpJSON()];
      for (const [streamId, stream] of rawStreams) pumps.push(pumpRawStream(streamId, stream));
      if (lateStreamSource) pumps.push(pumpLateStreams());
      try {
        const latePumps = (await Promise.all(pumps)).find(Array.isArray);
        if (latePumps && latePumps.length > 0) await Promise.all(latePumps);
        if (!cancelled)
          try {
            controller.close();
          } catch {}
      } catch {}
    },
    cancel() {
      cancelled = true;
      for (const reader of readers) reader.cancel().catch(() => {});
      readers.length = 0;
    },
  });
}
var serovalPlugins = void 0;
var FORM_DATA_CONTENT_TYPES = ["multipart/form-data", "application/x-www-form-urlencoded"];
var MAX_PAYLOAD_SIZE = 1e6;
var handleServerAction = async ({ request, context, serverFnId }) => {
  const methodUpper = request.method.toUpperCase();
  const url = new URL(request.url);
  const action = await getServerFnById(serverFnId);
  if (action.method && methodUpper !== action.method)
    return new Response(`expected ${action.method} method. Got ${methodUpper}`, {
      status: 405,
      headers: { Allow: action.method },
    });
  const isServerFn = request.headers.get("x-tsr-serverFn") === "true";
  if (!serovalPlugins) serovalPlugins = getDefaultSerovalPlugins();
  const contentType = request.headers.get("Content-Type");
  function parsePayload(payload) {
    return Iu(payload, { plugins: serovalPlugins });
  }
  return await (async () => {
    try {
      let serializeResult = function (res2) {
        let nonStreamingBody = void 0;
        const alsResponse = getResponse();
        if (res2 !== void 0) {
          const rawStreams = /* @__PURE__ */ new Map();
          let initialPhase = true;
          let lateStreamWriter;
          let lateStreamReadable = void 0;
          const pendingLateStreams = [];
          const plugins = [
            /* @__PURE__ */ createRawStreamRPCPlugin((id, stream) => {
              if (initialPhase) {
                rawStreams.set(id, stream);
                return;
              }
              if (lateStreamWriter) {
                lateStreamWriter
                  .write({
                    id,
                    stream,
                  })
                  .catch(() => {});
                return;
              }
              pendingLateStreams.push({
                id,
                stream,
              });
            }),
            ...(serovalPlugins || []),
          ];
          let done = false;
          const callbacks = {
            onParse: (value) => {
              nonStreamingBody = value;
            },
            onDone: () => {
              done = true;
            },
            onError: (error) => {
              throw error;
            },
          };
          au(res2, {
            refs: /* @__PURE__ */ new Map(),
            plugins,
            onParse(value) {
              callbacks.onParse(value);
            },
            onDone() {
              callbacks.onDone();
            },
            onError: (error) => {
              callbacks.onError(error);
            },
          });
          initialPhase = false;
          if (done && rawStreams.size === 0)
            return new Response(nonStreamingBody ? JSON.stringify(nonStreamingBody) : void 0, {
              status: alsResponse.status,
              statusText: alsResponse.statusText,
              headers: {
                "Content-Type": "application/json",
                [X_TSS_SERIALIZED]: "true",
              },
            });
          const { readable, writable } = new TransformStream();
          lateStreamReadable = readable;
          lateStreamWriter = writable.getWriter();
          for (const registration of pendingLateStreams)
            lateStreamWriter.write(registration).catch(() => {});
          pendingLateStreams.length = 0;
          const multiplexedStream = createMultiplexedStream(
            new ReadableStream({
              start(controller) {
                callbacks.onParse = (value) => {
                  controller.enqueue(JSON.stringify(value) + "\n");
                };
                callbacks.onDone = () => {
                  try {
                    controller.close();
                  } catch {}
                  lateStreamWriter
                    ?.close()
                    .catch(() => {})
                    .finally(() => {
                      lateStreamWriter = void 0;
                    });
                };
                callbacks.onError = (error) => {
                  controller.error(error);
                  lateStreamWriter
                    ?.abort(error)
                    .catch(() => {})
                    .finally(() => {
                      lateStreamWriter = void 0;
                    });
                };
                if (nonStreamingBody !== void 0) callbacks.onParse(nonStreamingBody);
                if (done) callbacks.onDone();
              },
              cancel() {
                lateStreamWriter?.abort().catch(() => {});
                lateStreamWriter = void 0;
              },
            }),
            rawStreams,
            lateStreamReadable,
          );
          return new Response(multiplexedStream, {
            status: alsResponse.status,
            statusText: alsResponse.statusText,
            headers: {
              "Content-Type": TSS_CONTENT_TYPE_FRAMED_VERSIONED,
              [X_TSS_SERIALIZED]: "true",
            },
          });
        }
        return new Response(void 0, {
          status: alsResponse.status,
          statusText: alsResponse.statusText,
        });
      };
      let res = await (async () => {
        if (FORM_DATA_CONTENT_TYPES.some((type) => contentType && contentType.includes(type))) {
          if (methodUpper === "GET") {
            if (false);
            invariant();
          }
          const formData = await request.formData();
          const serializedContext = formData.get(TSS_FORMDATA_CONTEXT);
          formData.delete(TSS_FORMDATA_CONTEXT);
          const params = {
            context,
            data: formData,
            method: methodUpper,
          };
          if (typeof serializedContext === "string")
            try {
              const deserializedContext = Iu(JSON.parse(serializedContext), {
                plugins: serovalPlugins,
              });
              if (typeof deserializedContext === "object" && deserializedContext)
                params.context = safeObjectMerge(deserializedContext, context);
            } catch (e) {
              if (false);
            }
          return await action(params);
        }
        if (methodUpper === "GET") {
          const payloadParam = url.searchParams.get("payload");
          if (payloadParam && payloadParam.length > MAX_PAYLOAD_SIZE)
            throw new Error("Payload too large");
          const payload2 = payloadParam ? parsePayload(JSON.parse(payloadParam)) : {};
          payload2.context = safeObjectMerge(payload2.context, context);
          payload2.method = methodUpper;
          return await action(payload2);
        }
        let jsonPayload;
        if (contentType?.includes("application/json")) jsonPayload = await request.json();
        const payload = jsonPayload ? parsePayload(jsonPayload) : {};
        payload.context = safeObjectMerge(payload.context, context);
        payload.method = methodUpper;
        return await action(payload);
      })();
      const unwrapped = res.result || res.error;
      if (isNotFound(res)) res = isNotFoundResponse(res);
      if (!isServerFn) return unwrapped;
      if (unwrapped instanceof Response) {
        if (isRedirect(unwrapped)) return unwrapped;
        unwrapped.headers.set(X_TSS_RAW_RESPONSE, "true");
        return unwrapped;
      }
      return serializeResult(res);
    } catch (error) {
      if (error instanceof Response) return error;
      if (isNotFound(error)) return isNotFoundResponse(error);
      console.info();
      console.info("Server Fn Error!");
      console.info();
      console.error(error);
      console.info();
      const serializedError = JSON.stringify(
        await Promise.resolve(
          ou(error, {
            refs: /* @__PURE__ */ new Map(),
            plugins: serovalPlugins,
          }),
        ),
      );
      const response = getResponse();
      return new Response(serializedError, {
        status: response.status ?? 500,
        statusText: response.statusText,
        headers: {
          "Content-Type": "application/json",
          [X_TSS_SERIALIZED]: "true",
        },
      });
    }
  })();
};
function isNotFoundResponse(error) {
  const { headers, ...rest } = error;
  return new Response(JSON.stringify(rest), {
    status: 404,
    headers: {
      "Content-Type": "application/json",
      ...(headers || {}),
    },
  });
}
function normalizeTransformAssetResult(result) {
  if (typeof result === "string") return { href: result };
  return result;
}
function resolveTransformAssetsCrossOrigin(config, kind) {
  if (!config) return void 0;
  if (typeof config === "string") return config;
  return config[kind];
}
function isObjectShorthand(transform) {
  return "prefix" in transform;
}
function resolveTransformAssetsConfig(transform) {
  if (typeof transform === "string") {
    const prefix = transform;
    return {
      type: "transform",
      transformFn: ({ url }) => ({ href: `${prefix}${url}` }),
      cache: true,
    };
  }
  if (typeof transform === "function")
    return {
      type: "transform",
      transformFn: transform,
      cache: true,
    };
  if (isObjectShorthand(transform)) {
    const { prefix, crossOrigin } = transform;
    return {
      type: "transform",
      transformFn: ({ url, kind }) => {
        const href = `${prefix}${url}`;
        if (kind === "clientEntry") return { href };
        const co2 = resolveTransformAssetsCrossOrigin(crossOrigin, kind);
        return co2
          ? {
              href,
              crossOrigin: co2,
            }
          : { href };
      },
      cache: true,
    };
  }
  if ("createTransform" in transform && transform.createTransform)
    return {
      type: "createTransform",
      createTransform: transform.createTransform,
      cache: transform.cache !== false,
    };
  return {
    type: "transform",
    transformFn:
      typeof transform.transform === "string"
        ? ({ url }) => ({ href: `${transform.transform}${url}` })
        : transform.transform,
    cache: transform.cache !== false,
  };
}
function adaptTransformAssetUrlsToTransformAssets(transformFn) {
  return async ({ url, kind }) => ({
    href: await transformFn({
      url,
      type: kind,
    }),
  });
}
function adaptTransformAssetUrlsConfigToTransformAssets(transform) {
  if (typeof transform === "string") return transform;
  if (typeof transform === "function") return adaptTransformAssetUrlsToTransformAssets(transform);
  if ("createTransform" in transform && transform.createTransform)
    return {
      createTransform: async (ctx) =>
        adaptTransformAssetUrlsToTransformAssets(await transform.createTransform(ctx)),
      cache: transform.cache,
      warmup: transform.warmup,
    };
  return {
    transform:
      typeof transform.transform === "string"
        ? transform.transform
        : adaptTransformAssetUrlsToTransformAssets(transform.transform),
    cache: transform.cache,
    warmup: transform.warmup,
  };
}
function buildClientEntryScriptTag(clientEntry, injectedHeadScripts) {
  let script = `import(${JSON.stringify(clientEntry)})`;
  if (injectedHeadScripts) script = `${injectedHeadScripts};${script}`;
  return {
    tag: "script",
    attrs: {
      type: "module",
      async: true,
    },
    children: script,
  };
}
function assignManifestAssetLink(link, next) {
  if (typeof link === "string") return next.crossOrigin ? next : next.href;
  return next.crossOrigin ? next : { href: next.href };
}
async function transformManifestAssets(source, transformFn, _opts) {
  const manifest2 = structuredClone(source.manifest);
  for (const route of Object.values(manifest2.routes)) {
    if (route.preloads)
      route.preloads = await Promise.all(
        route.preloads.map(async (link) => {
          const result = normalizeTransformAssetResult(
            await transformFn({
              url: resolveManifestAssetLink(link).href,
              kind: "modulepreload",
            }),
          );
          return assignManifestAssetLink(link, {
            href: result.href,
            crossOrigin: result.crossOrigin,
          });
        }),
      );
    if (route.assets) {
      for (const asset of route.assets)
        if (asset.tag === "link" && asset.attrs?.href) {
          const rel = asset.attrs.rel;
          if (!(typeof rel === "string" ? rel.split(/\s+/) : []).includes("stylesheet")) continue;
          const result = normalizeTransformAssetResult(
            await transformFn({
              url: asset.attrs.href,
              kind: "stylesheet",
            }),
          );
          asset.attrs.href = result.href;
          if (result.crossOrigin) asset.attrs.crossOrigin = result.crossOrigin;
          else delete asset.attrs.crossOrigin;
        }
    }
  }
  const transformedClientEntry = normalizeTransformAssetResult(
    await transformFn({
      url: source.clientEntry,
      kind: "clientEntry",
    }),
  );
  const rootRoute = (manifest2.routes[rootRouteId] = manifest2.routes[rootRouteId] || {});
  rootRoute.assets = rootRoute.assets || [];
  rootRoute.assets.push(
    buildClientEntryScriptTag(transformedClientEntry.href, source.injectedHeadScripts),
  );
  return manifest2;
}
function buildManifestWithClientEntry(source) {
  const scriptTag = buildClientEntryScriptTag(source.clientEntry, source.injectedHeadScripts);
  const baseRootRoute = source.manifest.routes[rootRouteId];
  return {
    routes: {
      ...source.manifest.routes,
      [rootRouteId]: {
        ...baseRootRoute,
        assets: [...(baseRootRoute?.assets || []), scriptTag],
      },
    },
  };
}
var ServerFunctionSerializationAdapter = createSerializationAdapter({
  key: "$TSS/serverfn",
  test: (v2) => {
    if (typeof v2 !== "function") return false;
    if (!(TSS_SERVER_FUNCTION in v2)) return false;
    return !!v2[TSS_SERVER_FUNCTION];
  },
  toSerializable: ({ serverFnMeta }) => ({ functionId: serverFnMeta.id }),
  fromSerializable: ({ functionId }) => {
    const fn2 = async (opts, signal) => {
      return (await (await getServerFnById(functionId))(opts ?? {}, signal)).result;
    };
    return fn2;
  },
});
function getStartResponseHeaders(opts) {
  return mergeHeaders(
    { "Content-Type": "text/html; charset=utf-8" },
    ...opts.router.stores.matches.get().map((match) => {
      return match.headers;
    }),
  );
}
var entriesPromise;
var baseManifestPromise;
var cachedFinalManifestPromise;
async function loadEntries() {
  const [routerEntry, startEntry, pluginAdapters] = await Promise.all([
    import("./router-TcaY8nNQ.js").then((n2) => n2.o),
    import("./start-HYkvq4Ni.js"),
    import("./__23tanstack-start-plugin-adapters-Cwee5PKy.js"),
  ]);
  return {
    routerEntry,
    startEntry,
    pluginAdapters,
  };
}
function getEntries() {
  if (!entriesPromise) entriesPromise = loadEntries();
  return entriesPromise;
}
function getBaseManifest(matchedRoutes) {
  if (!baseManifestPromise) baseManifestPromise = getStartManifest();
  return baseManifestPromise;
}
async function resolveManifest(matchedRoutes, transformFn, cache) {
  const base = await getBaseManifest();
  const computeFinalManifest = async () => {
    return transformFn
      ? await transformManifestAssets(base, transformFn)
      : buildManifestWithClientEntry(base);
  };
  if (!transformFn || cache) {
    if (!cachedFinalManifestPromise) cachedFinalManifestPromise = computeFinalManifest();
    return cachedFinalManifestPromise;
  }
  return computeFinalManifest();
}
var ROUTER_BASEPATH = "/";
var SERVER_FN_BASE = "/_serverFn/";
var IS_PRERENDERING = process.env.TSS_PRERENDERING === "true";
var IS_SHELL_ENV = process.env.TSS_SHELL === "true";
var ERR_NO_RESPONSE = "Internal Server Error";
var ERR_NO_DEFER = "Internal Server Error";
function throwRouteHandlerError() {
  throw new Error(ERR_NO_RESPONSE);
}
function throwIfMayNotDefer() {
  throw new Error(ERR_NO_DEFER);
}
function isSpecialResponse(value) {
  return value instanceof Response || isRedirect(value);
}
function handleCtxResult(result) {
  if (isSpecialResponse(result)) return { response: result };
  return result;
}
function executeMiddleware(middlewares, ctx) {
  let index = -1;
  const next = async (nextCtx) => {
    if (nextCtx) {
      if (nextCtx.context) ctx.context = safeObjectMerge(ctx.context, nextCtx.context);
      for (const key of Object.keys(nextCtx)) if (key !== "context") ctx[key] = nextCtx[key];
    }
    index++;
    const middleware = middlewares[index];
    if (!middleware) return ctx;
    let result;
    try {
      result = await middleware({
        ...ctx,
        next,
      });
    } catch (err) {
      if (isSpecialResponse(err)) {
        ctx.response = err;
        return ctx;
      }
      throw err;
    }
    const normalized = handleCtxResult(result);
    if (normalized) {
      if (normalized.response !== void 0) ctx.response = normalized.response;
      if (normalized.context) ctx.context = safeObjectMerge(ctx.context, normalized.context);
    }
    return ctx;
  };
  return next();
}
function handlerToMiddleware(handler, mayDefer = false) {
  if (mayDefer) return handler;
  return async (ctx) => {
    const response = await handler({
      ...ctx,
      next: throwIfMayNotDefer,
    });
    if (!response) throwRouteHandlerError();
    return response;
  };
}
function createStartHandler(cbOrOptions) {
  const cb = typeof cbOrOptions === "function" ? cbOrOptions : cbOrOptions.handler;
  const transformAssetsOption =
    typeof cbOrOptions === "function" ? void 0 : cbOrOptions.transformAssets;
  const transformAssetUrlsOption =
    typeof cbOrOptions === "function" ? void 0 : cbOrOptions.transformAssetUrls;
  const transformOption =
    transformAssetsOption !== void 0
      ? resolveTransformAssetsConfig(transformAssetsOption)
      : transformAssetUrlsOption !== void 0
        ? resolveTransformAssetsConfig(
            adaptTransformAssetUrlsConfigToTransformAssets(transformAssetUrlsOption),
          )
        : void 0;
  const warmupTransformManifest =
    (!!transformAssetsOption &&
      typeof transformAssetsOption === "object" &&
      "warmup" in transformAssetsOption &&
      transformAssetsOption.warmup === true) ||
    (!!transformAssetUrlsOption &&
      typeof transformAssetUrlsOption === "object" &&
      transformAssetUrlsOption.warmup === true);
  const resolvedTransformConfig = transformOption;
  const cache = resolvedTransformConfig ? resolvedTransformConfig.cache : true;
  const shouldCacheCreateTransform = cache && true;
  let cachedCreateTransformPromise;
  const getTransformFn = async (opts) => {
    if (!resolvedTransformConfig) return void 0;
    if (resolvedTransformConfig.type === "createTransform") {
      if (shouldCacheCreateTransform) {
        if (!cachedCreateTransformPromise)
          cachedCreateTransformPromise = Promise.resolve(
            resolvedTransformConfig.createTransform(opts),
          ).catch((error) => {
            cachedCreateTransformPromise = void 0;
            throw error;
          });
        return cachedCreateTransformPromise;
      }
      return resolvedTransformConfig.createTransform(opts);
    }
    return resolvedTransformConfig.transformFn;
  };
  if (warmupTransformManifest && cache && true && !cachedFinalManifestPromise) {
    const warmupPromise = (async () => {
      const base = await getBaseManifest();
      const transformFn = await getTransformFn({ warmup: true });
      return transformFn
        ? await transformManifestAssets(base, transformFn)
        : buildManifestWithClientEntry(base);
    })();
    cachedFinalManifestPromise = warmupPromise;
    warmupPromise.catch(() => {
      if (cachedFinalManifestPromise === warmupPromise) cachedFinalManifestPromise = void 0;
      cachedCreateTransformPromise = void 0;
    });
  }
  const startRequestResolver = async (request, requestOpts) => {
    let router = null;
    let cbWillCleanup = false;
    try {
      const { url, handledProtocolRelativeURL } = getNormalizedURL(request.url);
      const href = url.pathname + url.search + url.hash;
      const origin = getOrigin(request);
      if (handledProtocolRelativeURL) return Response.redirect(url, 308);
      const entries = await getEntries();
      const startOptions = (await entries.startEntry.startInstance?.getOptions()) || {};
      const { hasPluginAdapters, pluginSerializationAdapters } = entries.pluginAdapters;
      const serializationAdapters = [
        ...(startOptions.serializationAdapters || []),
        ...(hasPluginAdapters ? pluginSerializationAdapters : []),
        ServerFunctionSerializationAdapter,
      ];
      const requestStartOptions = {
        ...startOptions,
        serializationAdapters,
      };
      const flattenedRequestMiddlewares = startOptions.requestMiddleware
        ? flattenMiddlewares(startOptions.requestMiddleware)
        : [];
      const executedRequestMiddlewares = new Set(flattenedRequestMiddlewares);
      const getRouter = async () => {
        if (router) return router;
        router = await entries.routerEntry.getRouter();
        let isShell = IS_SHELL_ENV;
        if (IS_PRERENDERING && !isShell)
          isShell = request.headers.get(HEADERS.TSS_SHELL) === "true";
        const history = createMemoryHistory({ initialEntries: [href] });
        router.update({
          history,
          isShell,
          isPrerendering: IS_PRERENDERING,
          origin: router.options.origin ?? origin,
          defaultSsr: requestStartOptions.defaultSsr,
          serializationAdapters: [
            ...requestStartOptions.serializationAdapters,
            ...(router.options.serializationAdapters || []),
          ],
          basepath: ROUTER_BASEPATH,
        });
        return router;
      };
      if (SERVER_FN_BASE && url.pathname.startsWith(SERVER_FN_BASE)) {
        const serverFnId = url.pathname.slice(SERVER_FN_BASE.length).split("/")[0];
        if (!serverFnId) throw new Error("Invalid server action param for serverFnId");
        const serverFnHandler = async ({ context }) => {
          return runWithStartContext(
            {
              getRouter,
              startOptions: requestStartOptions,
              contextAfterGlobalMiddlewares: context,
              request,
              executedRequestMiddlewares,
              handlerType: "serverFn",
            },
            () =>
              handleServerAction({
                request,
                context: requestOpts?.context,
                serverFnId,
              }),
          );
        };
        return handleRedirectResponse(
          (
            await executeMiddleware(
              [...flattenedRequestMiddlewares.map((d) => d.options.server), serverFnHandler],
              {
                request,
                pathname: url.pathname,
                context: createNullProtoObject(requestOpts?.context),
              },
            )
          ).response,
          request,
          getRouter,
        );
      }
      const executeRouter = async (serverContext, matchedRoutes) => {
        const acceptParts = (request.headers.get("Accept") || "*/*").split(",");
        if (
          !["*/*", "text/html"].some((mimeType) =>
            acceptParts.some((part) => part.trim().startsWith(mimeType)),
          )
        )
          return Response.json({ error: "Only HTML requests are supported here" }, { status: 500 });
        const manifest2 = await resolveManifest(
          matchedRoutes,
          await getTransformFn({
            warmup: false,
            request,
          }),
          cache,
        );
        const routerInstance = await getRouter();
        attachRouterServerSsrUtils({
          router: routerInstance,
          manifest: manifest2,
          getRequestAssets: () => getStartContext({ throwIfNotFound: false })?.requestAssets,
          includeUnmatchedRouteAssets: false,
        });
        routerInstance.update({ additionalContext: { serverContext } });
        await routerInstance.load();
        if (routerInstance.state.redirect) return routerInstance.state.redirect;
        const ctx = getStartContext({ throwIfNotFound: false });
        await routerInstance.serverSsr.dehydrate({ requestAssets: ctx?.requestAssets });
        const responseHeaders = getStartResponseHeaders({ router: routerInstance });
        cbWillCleanup = true;
        return cb({
          request,
          router: routerInstance,
          responseHeaders,
        });
      };
      const requestHandlerMiddleware = async ({ context }) => {
        return runWithStartContext(
          {
            getRouter,
            startOptions: requestStartOptions,
            contextAfterGlobalMiddlewares: context,
            request,
            executedRequestMiddlewares,
            handlerType: "router",
          },
          async () => {
            try {
              return await handleServerRoutes({
                getRouter,
                request,
                url,
                executeRouter,
                context,
                executedRequestMiddlewares,
              });
            } catch (err) {
              if (err instanceof Response) return err;
              throw err;
            }
          },
        );
      };
      return handleRedirectResponse(
        (
          await executeMiddleware(
            [...flattenedRequestMiddlewares.map((d) => d.options.server), requestHandlerMiddleware],
            {
              request,
              pathname: url.pathname,
              context: createNullProtoObject(requestOpts?.context),
            },
          )
        ).response,
        request,
        getRouter,
      );
    } finally {
      if (router && !cbWillCleanup) router.serverSsr?.cleanup();
      router = null;
    }
  };
  return requestHandler(startRequestResolver);
}
async function handleRedirectResponse(response, request, getRouter) {
  if (!isRedirect(response)) return response;
  if (isResolvedRedirect(response)) {
    if (request.headers.get("x-tsr-serverFn") === "true")
      return Response.json(
        {
          ...response.options,
          isSerializedRedirect: true,
        },
        { headers: response.headers },
      );
    return response;
  }
  const opts = response.options;
  if (opts.to && typeof opts.to === "string" && !opts.to.startsWith("/"))
    throw new Error(
      `Server side redirects must use absolute paths via the 'href' or 'to' options. The redirect() method's "to" property accepts an internal path only. Use the "href" property to provide an external URL. Received: ${JSON.stringify(opts)}`,
    );
  if (["params", "search", "hash"].some((d) => typeof opts[d] === "function"))
    throw new Error(
      `Server side redirects must use static search, params, and hash values and do not support functional values. Received functional values for: ${Object.keys(
        opts,
      )
        .filter((d) => typeof opts[d] === "function")
        .map((d) => `"${d}"`)
        .join(", ")}`,
    );
  const redirect2 = (await getRouter()).resolveRedirect(response);
  if (request.headers.get("x-tsr-serverFn") === "true")
    return Response.json(
      {
        ...response.options,
        isSerializedRedirect: true,
      },
      { headers: response.headers },
    );
  return redirect2;
}
async function handleServerRoutes({
  getRouter,
  request,
  url,
  executeRouter,
  context,
  executedRequestMiddlewares,
}) {
  const router = await getRouter();
  const pathname = executeRewriteInput(router.rewrite, url).pathname;
  const { matchedRoutes, foundRoute, routeParams } = router.getMatchedRoutes(pathname);
  const isExactMatch = foundRoute && routeParams["**"] === void 0;
  const routeMiddlewares = [];
  for (const route of matchedRoutes) {
    const serverMiddleware = route.options.server?.middleware;
    if (serverMiddleware) {
      const flattened = flattenMiddlewares(serverMiddleware);
      for (const m2 of flattened)
        if (!executedRequestMiddlewares.has(m2)) routeMiddlewares.push(m2.options.server);
    }
  }
  const server = foundRoute?.options.server;
  if (server?.handlers && isExactMatch) {
    const handlers =
      typeof server.handlers === "function"
        ? server.handlers({ createHandlers: (d) => d })
        : server.handlers;
    const handler = handlers[request.method.toUpperCase()] ?? handlers["ANY"];
    if (handler) {
      const mayDefer = !!foundRoute.options.component;
      if (typeof handler === "function")
        routeMiddlewares.push(handlerToMiddleware(handler, mayDefer));
      else {
        if (handler.middleware?.length) {
          const handlerMiddlewares = flattenMiddlewares(handler.middleware);
          for (const m2 of handlerMiddlewares) routeMiddlewares.push(m2.options.server);
        }
        if (handler.handler) routeMiddlewares.push(handlerToMiddleware(handler.handler, mayDefer));
      }
    }
  }
  routeMiddlewares.push((ctx) => executeRouter(ctx.context, matchedRoutes));
  return (
    await executeMiddleware(routeMiddlewares, {
      request,
      context,
      params: routeParams,
      pathname,
    })
  ).response;
}
var fetch$1 = createStartHandler(defaultStreamHandler);
function createServerEntry(entry) {
  return {
    async fetch(...args) {
      return await entry.fetch(...args);
    },
  };
}
var server_default = createServerEntry({ fetch: fetch$1 });
const workerEntry = server_default ?? {};
export {
  getServerFnById as $,
  interpolatePath as A,
  nullReplaceEqualDeep as B,
  replaceEqualDeep as C,
  DEFAULT_PROTOCOL_ALLOWLIST as D,
  last as E,
  decodePath as F,
  findFlatMatch as G,
  findRouteMatch as H,
  executeRewriteOutput as I,
  encodePathLikeUrl as J,
  trimPathLeft as K,
  joinPaths as L,
  useRouter as M,
  dummyMatchContext as N,
  matchContext as O,
  requireReactDom as P,
  exactPathTest as Q,
  removeTrailingSlash as R,
  React as S,
  jsxRuntimeExports as T,
  isModuleNotFoundError as U,
  useHydrated as V,
  escapeHtml as W,
  getAssetCrossOrigin as X,
  resolveManifestAssetLink as Y,
  Outlet as Z,
  TSS_SERVER_FUNCTION as _,
  arraysEqual as a,
  createServerFn as a0,
  createServerEntry as a1,
  workerEntry as a2,
  isRedirect as b,
  createLRUCache as c,
  isNotFound as d,
  invariant as e,
  functionalUpdate as f,
  createControlledPromise as g,
  rootRouteId as h,
  isPromise as i,
  isServer as j,
  compileDecodeCharMap as k,
  rewriteBasepath as l,
  composeRewrites as m,
  processRouteMasks as n,
  resolvePath as o,
  processRouteTree as p,
  cleanPath as q,
  reactExports as r,
  trimPathRight as s,
  trimPath as t,
  parseHref as u,
  executeRewriteInput as v,
  isDangerousProtocol as w,
  redirect as x,
  findSingleMatch as y,
  deepEqual as z,
};
