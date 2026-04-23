import {
  a as __toESM,
  n as require_react,
  r as __commonJSMin,
  t as require_jsx_runtime,
} from "./jsx-runtime-B8ri5dzN.js";
//#region node_modules/@tanstack/react-router/dist/esm/utils.js
var import_react = /* @__PURE__ */ __toESM(require_react(), 1);
/**
 * React.use if available (React 19+), undefined otherwise.
 * Use dynamic lookup to avoid Webpack compilation errors with React 18.
 */
var reactUse = import_react.use;
var useLayoutEffect =
  typeof window !== "undefined" ? import_react.useLayoutEffect : import_react.useEffect;
/**
 * Taken from https://www.developerway.com/posts/implementing-advanced-use-previous-hook#part3
 */
function usePrevious(value) {
  const ref = import_react.useRef({
    value,
    prev: null,
  });
  const current = ref.current.value;
  if (value !== current)
    ref.current = {
      value,
      prev: current,
    };
  return ref.current.prev;
}
/**
 * React hook to wrap `IntersectionObserver`.
 *
 * This hook will create an `IntersectionObserver` and observe the ref passed to it.
 *
 * When the intersection changes, the callback will be called with the `IntersectionObserverEntry`.
 *
 * @param ref - The ref to observe
 * @param intersectionObserverOptions - The options to pass to the IntersectionObserver
 * @param options - The options to pass to the hook
 * @param callback - The callback to call when the intersection changes
 * @returns The IntersectionObserver instance
 * @example
 * ```tsx
 * const MyComponent = () => {
 * const ref = React.useRef<HTMLDivElement>(null)
 * useIntersectionObserver(
 *  ref,
 *  (entry) => { doSomething(entry) },
 *  { rootMargin: '10px' },
 *  { disabled: false }
 * )
 * return <div ref={ref} />
 * ```
 */
function useIntersectionObserver(ref, callback, intersectionObserverOptions = {}, options = {}) {
  import_react.useEffect(() => {
    if (!ref.current || options.disabled || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(([entry]) => {
      callback(entry);
    }, intersectionObserverOptions);
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
    };
  }, [callback, intersectionObserverOptions, options.disabled, ref]);
}
/**
 * React hook to take a `React.ForwardedRef` and returns a `ref` that can be used on a DOM element.
 *
 * @param ref - The forwarded ref
 * @returns The inner ref returned by `useRef`
 * @example
 * ```tsx
 * const MyComponent = React.forwardRef((props, ref) => {
 *  const innerRef = useForwardedRef(ref)
 *  return <div ref={innerRef} />
 * })
 * ```
 */
function useForwardedRef(ref) {
  const innerRef = import_react.useRef(null);
  import_react.useImperativeHandle(ref, () => innerRef.current, []);
  return innerRef;
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/utils.js
/**
 * Return the last element of an array.
 * Intended for non-empty arrays used within router internals.
 */
function last(arr) {
  return arr[arr.length - 1];
}
function isFunction(d) {
  return typeof d === "function";
}
/**
 * Apply a value-or-updater to a previous value.
 * Accepts either a literal value or a function of the previous value.
 */
function functionalUpdate(updater, previous) {
  if (isFunction(updater)) return updater(previous);
  return updater;
}
var createNull = () => Object.create(null);
var nullReplaceEqualDeep = (prev, next) => replaceEqualDeep(prev, next, createNull);
/**
 * This function returns `prev` if `_next` is deeply equal.
 * If not, it will replace any deeply equal children of `b` with those of `a`.
 * This can be used for structural sharing between immutable JSON values for example.
 * Do not use this with signals
 */
function replaceEqualDeep(prev, _next, _makeObj = () => ({}), _depth = 0) {
  return _next;
}
function isPlainObject(o) {
  if (!hasObjectPrototype(o)) return false;
  const ctor = o.constructor;
  if (typeof ctor === "undefined") return true;
  const prot = ctor.prototype;
  if (!hasObjectPrototype(prot)) return false;
  if (!prot.hasOwnProperty("isPrototypeOf")) return false;
  return true;
}
function hasObjectPrototype(o) {
  return Object.prototype.toString.call(o) === "[object Object]";
}
/**
 * Perform a deep equality check with options for partial comparison and
 * ignoring `undefined` values. Optimized for router state comparisons.
 */
function deepEqual(a, b, opts) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0, l = a.length; i < l; i++) if (!deepEqual(a[i], b[i], opts)) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ignoreUndefined = opts?.ignoreUndefined ?? true;
    if (opts?.partial) {
      for (const k in b)
        if (!ignoreUndefined || b[k] !== void 0) {
          if (!deepEqual(a[k], b[k], opts)) return false;
        }
      return true;
    }
    let aCount = 0;
    if (!ignoreUndefined) aCount = Object.keys(a).length;
    else for (const k in a) if (a[k] !== void 0) aCount++;
    let bCount = 0;
    for (const k in b)
      if (!ignoreUndefined || b[k] !== void 0) {
        bCount++;
        if (bCount > aCount || !deepEqual(a[k], b[k], opts)) return false;
      }
    return aCount === bCount;
  }
  return false;
}
/**
 * Create a promise with exposed resolve/reject and status fields.
 * Useful for coordinating async router lifecycle operations.
 */
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
/**
 * Heuristically detect dynamic import "module not found" errors
 * across major browsers for lazy route component handling.
 */
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
/**
 * Remove control characters that can cause open redirect vulnerabilities.
 * Characters like \r (CR) and \n (LF) can trick URL parsers into interpreting
 * paths like "/\r/evil.com" as "http://evil.com".
 */
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
/**
 * Default list of URL protocols to allow in links, redirects, and navigation.
 * Any absolute URL protocol not in this list is treated as dangerous by default.
 */
var DEFAULT_PROTOCOL_ALLOWLIST = ["http:", "https:", "mailto:", "tel:"];
/**
 * Check if a URL string uses a protocol that is not in the allowlist.
 * Returns true for blocked protocols like javascript:, blob:, data:, etc.
 *
 * The URL constructor correctly normalizes:
 * - Mixed case (JavaScript: → javascript:)
 * - Whitespace/control characters (java\nscript: → javascript:)
 * - Leading whitespace
 *
 * For relative URLs (no protocol), returns false (safe).
 *
 * @param url - The URL string to check
 * @param allowlist - Set of protocols to allow
 * @returns true if the URL uses a protocol that is not allowed
 */
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
/**
 * Escape HTML special characters in a string to prevent XSS attacks
 * when embedding strings in script tags during SSR.
 *
 * This is essential for preventing XSS vulnerabilities when user-controlled
 * content is embedded in inline scripts.
 */
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
  const re = /%25|%5C/gi;
  let cursor = 0;
  let result = "";
  let match;
  while (null !== (match = re.exec(path))) {
    result += decodeSegment(path.slice(cursor, match.index)) + match[0];
    cursor = re.lastIndex;
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
/**
 * Encodes a path the same way `new URL()` would, but without the overhead of full URL parsing.
 *
 * This function encodes:
 * - Whitespace characters (spaces → %20, tabs → %09, etc.)
 * - Non-ASCII/Unicode characters (emojis, accented characters, etc.)
 *
 * It preserves:
 * - Already percent-encoded sequences (won't double-encode %2F, %25, etc.)
 * - ASCII special characters valid in URL paths (@, $, &, +, etc.)
 * - Forward slashes as path separators
 *
 * Used to generate proper href values for SSR without constructing URL objects.
 *
 * @example
 * encodePathLikeUrl('/path/file name.pdf') // '/path/file%20name.pdf'
 * encodePathLikeUrl('/path/日本語') // '/path/%E6%97%A5%E6%9C%AC%E8%AA%9E'
 * encodePathLikeUrl('/path/already%20encoded') // '/path/already%20encoded' (preserved)
 */
function encodePathLikeUrl(path) {
  if (!/\s|[^\u0000-\u007F]/.test(path)) return path;
  return path.replace(/\s|[^\u0000-\u007F]/gu, encodeURIComponent);
}
function arraysEqual(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/invariant.js
function invariant() {
  throw new Error("Invariant failed");
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/lru-cache.js
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
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/new-process-route-tree.js
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
/**
 * Populates the `output` array with the parsed representation of the given `segment` string.
 *
 * Usage:
 * ```ts
 * let output
 * let cursor = 0
 * while (cursor < path.length) {
 *   output = parseSegment(path, cursor, output)
 *   const end = output[5]
 *   cursor = end + 1
 * ```
 *
 * `output` is stored outside to avoid allocations during repeated calls. It doesn't need to be typed
 * or initialized, it will be done automatically.
 */
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
/**
 * Recursively parses the segments of the given route tree and populates a segment trie.
 *
 * @param data A reusable Uint16Array for parsing segments. (non important, we're just avoiding allocations)
 * @param route The current route to parse.
 * @param start The starting index for parsing within the route's full path.
 * @param node The current segment node in the trie to populate.
 * @param onRoute Callback invoked for each route processed.
 */
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
      const start = cursor;
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
          const prefix_raw = path.substring(start, segment[1]);
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
          const prefix_raw = path.substring(start, segment[1]);
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
          const prefix_raw = path.substring(start, segment[1]);
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
function sortDynamic(a, b) {
  if (a.skipOnParamError && !b.skipOnParamError) return -1;
  if (!a.skipOnParamError && b.skipOnParamError) return 1;
  if (a.skipOnParamError && b.skipOnParamError && (a.parsingPriority || b.parsingPriority))
    return b.parsingPriority - a.parsingPriority;
  if (a.prefix && b.prefix && a.prefix !== b.prefix) {
    if (a.prefix.startsWith(b.prefix)) return -1;
    if (b.prefix.startsWith(a.prefix)) return 1;
  }
  if (a.suffix && b.suffix && a.suffix !== b.suffix) {
    if (a.suffix.endsWith(b.suffix)) return -1;
    if (b.suffix.endsWith(a.suffix)) return 1;
  }
  if (a.prefix && !b.prefix) return -1;
  if (!a.prefix && b.prefix) return 1;
  if (a.suffix && !b.suffix) return -1;
  if (!a.suffix && b.suffix) return 1;
  if (a.caseSensitive && !b.caseSensitive) return -1;
  if (!a.caseSensitive && b.caseSensitive) return 1;
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
/**
 * Keys must be declared in the same order as in `SegmentNode` type,
 * to ensure they are represented as the same object class in the engine.
 */
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
/**
 * Take an arbitrary list of routes, create a tree from them (if it hasn't been created already), and match a path against it.
 */
function findFlatMatch(path, processedTree) {
  path ||= "/";
  const cached = processedTree.flatCache.get(path);
  if (cached) return cached;
  const result = findMatch(path, processedTree.masksTree);
  processedTree.flatCache.set(path, result);
  return result;
}
/**
 * @deprecated keep until v2 so that `router.matchRoute` can keep not caring about the actual route tree
 */
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
/** Trim trailing slashes (except preserving root '/'). */
function trimPathRight$1(path) {
  return path === "/" ? path : path.replace(/\/{1,}$/, "");
}
/**
 * Processes a route tree into a segment trie for efficient path matching.
 * Also builds lookup maps for routes by ID and by trimmed full path.
 */
function processRouteTree(routeTree, caseSensitive = false, initRoute) {
  const segmentTree = createStaticNode(routeTree.fullPath);
  const data = new Uint16Array(6);
  const routesById = {};
  const routesByPath = {};
  let index = 0;
  parseSegments(caseSensitive, data, routeTree, 1, segmentTree, 0, (route) => {
    initRoute?.(route, index);
    if (route.id in routesById) invariant();
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
/**
 * This function is "resumable":
 * - the `leaf` input can contain `extract` and `rawParams` properties from a previous `extractParams` call
 * - the returned `state` can be passed back as `extract` in a future call to continue extracting params from where we left off
 *
 * Inputs are *not* mutated.
 */
function extractParams(path, parts, leaf) {
  const list = buildBranch(leaf.node);
  let nodeParts = null;
  const rawParams = Object.create(null);
  /** which segment of the path we're currently processing */
  let partIndex = leaf.extract?.part ?? 0;
  /** which node of the route tree branch we're currently processing */
  let nodeIndex = leaf.extract?.node ?? 0;
  /** index of the 1st character of the segment we're processing in the path string */
  let pathIndex = leaf.extract?.path ?? 0;
  /** which fullPath segment we're currently processing */
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
      const n = node;
      const value = path.substring(
        currentPathIndex + (n.prefix?.length ?? 0),
        path.length - (n.suffix?.length ?? 0),
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
        const frame = {
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
          if (!validateMatchParams(path, parts, frame)) continue;
        }
        wildcardMatch = frame;
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
    bestFuzzy.rawParams ??= Object.create(null);
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
    frame.parsedParams = Object.assign(Object.create(null), frame.parsedParams, parsed);
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
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/path.js
/** Join path segments, cleaning duplicate slashes between parts. */
function joinPaths(paths) {
  return cleanPath(
    paths
      .filter((val) => {
        return val !== void 0;
      })
      .join("/"),
  );
}
/** Remove repeated slashes from a path string. */
function cleanPath(path) {
  return path.replace(/\/{2,}/g, "/");
}
/** Trim leading slashes (except preserving root '/'). */
function trimPathLeft(path) {
  return path === "/" ? path : path.replace(/^\/{1,}/, "");
}
/** Trim trailing slashes (except preserving root '/'). */
function trimPathRight(path) {
  const len = path.length;
  return len > 1 && path[len - 1] === "/" ? path.replace(/\/{1,}$/, "") : path;
}
/** Trim both leading and trailing slashes. */
function trimPath(path) {
  return trimPathRight(trimPathLeft(path));
}
/** Remove a trailing slash from value when appropriate for comparisons. */
function removeTrailingSlash(value, basepath) {
  if (value?.endsWith("/") && value !== "/" && value !== `${basepath}/`) return value.slice(0, -1);
  return value;
}
/**
 * Compare two pathnames for exact equality after normalizing trailing slashes
 * relative to the provided `basepath`.
 */
function exactPathTest(pathName1, pathName2, basepath) {
  return removeTrailingSlash(pathName1, basepath) === removeTrailingSlash(pathName2, basepath);
}
/**
 * Resolve a destination path against a base, honoring trailing-slash policy
 * and supporting relative segments (`.`/`..`) and absolute `to` values.
 */
function resolvePath({ base, to, trailingSlash = "never", cache }) {
  const isAbsolute = to.startsWith("/");
  const isBase = !isAbsolute && to === ".";
  let key;
  if (cache) {
    key = isAbsolute ? to : isBase ? base : base + "\0" + to;
    const cached = cache.get(key);
    if (cached) return cached;
  }
  let baseSegments;
  if (isBase) baseSegments = base.split("/");
  else if (isAbsolute) baseSegments = to.split("/");
  else {
    baseSegments = base.split("/");
    while (baseSegments.length > 1 && last(baseSegments) === "") baseSegments.pop();
    const toSegments = to.split("/");
    for (let index = 0, length = toSegments.length; index < length; index++) {
      const value = toSegments[index];
      if (value === "") {
        if (!index) baseSegments = [value];
        else if (index === length - 1) baseSegments.push(value);
      } else if (value === "..") baseSegments.pop();
      else if (value === ".") {
      } else baseSegments.push(value);
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
/**
 * Create a pre-compiled decode config from allowed characters.
 * This should be called once at router initialization.
 */
function compileDecodeCharMap(pathParamsAllowedCharacters) {
  const charMap = new Map(
    pathParamsAllowedCharacters.map((char) => [encodeURIComponent(char), char]),
  );
  const pattern = Array.from(charMap.keys())
    .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const regex = new RegExp(pattern, "g");
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
/**
 * Interpolate params and wildcards into a route path template.
 *
 * - Encodes params safely (configurable allowed characters)
 * - Supports `{-$optional}` segments, `{prefix{$id}suffix}` and `{$}` wildcards
 */
function interpolatePath({ path, params, decoder, ...rest }) {
  let isMissingParams = false;
  const usedParams = Object.create(null);
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
  if (path.indexOf("{") === -1) {
    const length = path.length;
    let cursor = 0;
    let joined = "";
    while (cursor < length) {
      while (cursor < length && path.charCodeAt(cursor) === 47) cursor++;
      if (cursor >= length) break;
      const start = cursor;
      let end = path.indexOf("/", cursor);
      if (end === -1) end = length;
      cursor = end;
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
          joined += "/" + value;
        } else {
          const key = part.substring(1);
          if (!isMissingParams && !(key in params)) isMissingParams = true;
          usedParams[key] = params[key];
          const value = encodeParam(key, params, decoder) ?? "undefined";
          joined += "/" + value;
        }
      else joined += "/" + part;
    }
    if (path.endsWith("/")) joined += "/";
    return {
      usedParams,
      interpolatedPath: joined || "/",
      isMissingParams,
    };
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
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/not-found.js
/** Determine if a value is a TanStack Router not-found error. */
function isNotFound(obj) {
  return obj?.isNotFound === true;
}
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/root.js
/** Stable identifier used for the root route in a route tree. */
var rootRouteId = "__root__";
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/ClientOnly.js
var import_jsx_runtime = require_jsx_runtime();
/**
 * Render the children only after the JS has loaded client-side. Use an optional
 * fallback component if the JS is not yet loaded.
 *
 * @example
 * Render a Chart component if JS loads, renders a simple FakeChart
 * component server-side or if there is no JS. The FakeChart can have only the
 * UI without the behavior or be a loading spinner or skeleton.
 *
 * ```tsx
 * return (
 *   <ClientOnly fallback={<FakeChart />}>
 *     <Chart />
 *   </ClientOnly>
 * )
 * ```
 */
function ClientOnly({ children, fallback = null }) {
  return useHydrated()
    ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_react.Fragment, { children })
    : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_react.Fragment, { children: fallback });
}
/**
 * Return a boolean indicating if the JS has been hydrated already.
 * When doing Server-Side Rendering, the result will always be false.
 * When doing Client-Side Rendering, the result will always be false on the
 * first render and true from then on. Even if a new component renders it will
 * always start with true.
 *
 * @example
 * ```tsx
 * // Disable a button that needs JS to work.
 * let hydrated = useHydrated()
 * return (
 *   <button type="button" disabled={!hydrated} onClick={doSomethingCustom}>
 *     Click me
 *   </button>
 * )
 * ```
 * @returns True if the JS has been hydrated already, false otherwise.
 */
function useHydrated() {
  return import_react.useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
function subscribe() {
  return () => {};
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/routerContext.js
var routerContext = import_react.createContext(null);
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/useRouter.js
/**
 * Access the current TanStack Router instance from React context.
 * Must be used within a `RouterProvider`.
 *
 * Options:
 * - `warn`: Log a warning if no router context is found (default: true).
 *
 * @returns The registered router instance.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/useRouterHook
 */
function useRouter(opts) {
  return import_react.useContext(routerContext);
}
//#endregion
//#region node_modules/@tanstack/react-router/dist/esm/matchContext.js
var matchContext = import_react.createContext(void 0);
var dummyMatchContext = import_react.createContext(void 0);
//#endregion
//#region node_modules/use-sync-external-store/cjs/use-sync-external-store-shim.production.js
/**
 * @license React
 * use-sync-external-store-shim.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var require_use_sync_external_store_shim_production = /* @__PURE__ */ __commonJSMin((exports) => {
  var React = require_react();
  function is(x, y) {
    return (x === y && (0 !== x || 1 / x === 1 / y)) || (x !== x && y !== y);
  }
  var objectIs = "function" === typeof Object.is ? Object.is : is,
    useState = React.useState,
    useEffect = React.useEffect,
    useLayoutEffect = React.useLayoutEffect,
    useDebugValue = React.useDebugValue;
  function useSyncExternalStore$2(subscribe, getSnapshot) {
    var value = getSnapshot(),
      _useState = useState({
        inst: {
          value,
          getSnapshot,
        },
      }),
      inst = _useState[0].inst,
      forceUpdate = _useState[1];
    useLayoutEffect(
      function () {
        inst.value = value;
        inst.getSnapshot = getSnapshot;
        checkIfSnapshotChanged(inst) && forceUpdate({ inst });
      },
      [subscribe, value, getSnapshot],
    );
    useEffect(
      function () {
        checkIfSnapshotChanged(inst) && forceUpdate({ inst });
        return subscribe(function () {
          checkIfSnapshotChanged(inst) && forceUpdate({ inst });
        });
      },
      [subscribe],
    );
    useDebugValue(value);
    return value;
  }
  function checkIfSnapshotChanged(inst) {
    var latestGetSnapshot = inst.getSnapshot;
    inst = inst.value;
    try {
      var nextValue = latestGetSnapshot();
      return !objectIs(inst, nextValue);
    } catch (error) {
      return !0;
    }
  }
  function useSyncExternalStore$1(subscribe, getSnapshot) {
    return getSnapshot();
  }
  var shim =
    "undefined" === typeof window ||
    "undefined" === typeof window.document ||
    "undefined" === typeof window.document.createElement
      ? useSyncExternalStore$1
      : useSyncExternalStore$2;
  exports.useSyncExternalStore =
    void 0 !== React.useSyncExternalStore ? React.useSyncExternalStore : shim;
});
//#endregion
//#region node_modules/use-sync-external-store/shim/index.js
var require_shim = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = require_use_sync_external_store_shim_production();
});
//#endregion
//#region node_modules/use-sync-external-store/cjs/use-sync-external-store-shim/with-selector.production.js
/**
 * @license React
 * use-sync-external-store-shim/with-selector.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var require_with_selector_production = /* @__PURE__ */ __commonJSMin((exports) => {
  var React = require_react(),
    shim = require_shim();
  function is(x, y) {
    return (x === y && (0 !== x || 1 / x === 1 / y)) || (x !== x && y !== y);
  }
  var objectIs = "function" === typeof Object.is ? Object.is : is,
    useSyncExternalStore = shim.useSyncExternalStore,
    useRef = React.useRef,
    useEffect = React.useEffect,
    useMemo = React.useMemo,
    useDebugValue = React.useDebugValue;
  exports.useSyncExternalStoreWithSelector = function (
    subscribe,
    getSnapshot,
    getServerSnapshot,
    selector,
    isEqual,
  ) {
    var instRef = useRef(null);
    if (null === instRef.current) {
      var inst = {
        hasValue: !1,
        value: null,
      };
      instRef.current = inst;
    } else inst = instRef.current;
    instRef = useMemo(
      function () {
        function memoizedSelector(nextSnapshot) {
          if (!hasMemo) {
            hasMemo = !0;
            memoizedSnapshot = nextSnapshot;
            nextSnapshot = selector(nextSnapshot);
            if (void 0 !== isEqual && inst.hasValue) {
              var currentSelection = inst.value;
              if (isEqual(currentSelection, nextSnapshot))
                return (memoizedSelection = currentSelection);
            }
            return (memoizedSelection = nextSnapshot);
          }
          currentSelection = memoizedSelection;
          if (objectIs(memoizedSnapshot, nextSnapshot)) return currentSelection;
          var nextSelection = selector(nextSnapshot);
          if (void 0 !== isEqual && isEqual(currentSelection, nextSelection))
            return ((memoizedSnapshot = nextSnapshot), currentSelection);
          memoizedSnapshot = nextSnapshot;
          return (memoizedSelection = nextSelection);
        }
        var hasMemo = !1,
          memoizedSnapshot,
          memoizedSelection,
          maybeGetServerSnapshot = void 0 === getServerSnapshot ? null : getServerSnapshot;
        return [
          function () {
            return memoizedSelector(getSnapshot());
          },
          null === maybeGetServerSnapshot
            ? void 0
            : function () {
                return memoizedSelector(maybeGetServerSnapshot());
              },
        ];
      },
      [getSnapshot, getServerSnapshot, selector, isEqual],
    );
    var value = useSyncExternalStore(subscribe, instRef[0], instRef[1]);
    useEffect(
      function () {
        inst.hasValue = !0;
        inst.value = value;
      },
      [value],
    );
    useDebugValue(value);
    return value;
  };
});
//#endregion
//#region node_modules/@tanstack/react-store/dist/esm/useStore.js
var import_with_selector = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = require_with_selector_production();
})();
function defaultCompare(a, b) {
  return a === b;
}
function useStore(atom, selector, compare = defaultCompare) {
  const subscribe = (0, import_react.useCallback)(
    (handleStoreChange) => {
      if (!atom) return () => {};
      const { unsubscribe } = atom.subscribe(handleStoreChange);
      return unsubscribe;
    },
    [atom],
  );
  const boundGetSnapshot = (0, import_react.useCallback)(() => atom?.get(), [atom]);
  return (0, import_with_selector.useSyncExternalStoreWithSelector)(
    subscribe,
    boundGetSnapshot,
    boundGetSnapshot,
    selector,
    compare,
  );
}
//#endregion
//#region node_modules/react-dom/cjs/react-dom.production.js
/**
 * @license React
 * react-dom.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var require_react_dom_production = /* @__PURE__ */ __commonJSMin((exports) => {
  var React = require_react();
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
  var ReactSharedInternals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  function getCrossOriginStringAs(as, input) {
    if ("font" === as) return "";
    if ("string" === typeof input) return "use-credentials" === input ? input : "";
  }
  exports.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = Internals;
  exports.createPortal = function (children, container) {
    var key = 2 < arguments.length && void 0 !== arguments[2] ? arguments[2] : null;
    if (
      !container ||
      (1 !== container.nodeType && 9 !== container.nodeType && 11 !== container.nodeType)
    )
      throw Error(formatProdErrorMessage(299));
    return createPortal$1(children, container, null, key);
  };
  exports.flushSync = function (fn) {
    var previousTransition = ReactSharedInternals.T,
      previousUpdatePriority = Internals.p;
    try {
      if (((ReactSharedInternals.T = null), (Internals.p = 2), fn)) return fn();
    } finally {
      ((ReactSharedInternals.T = previousTransition),
        (Internals.p = previousUpdatePriority),
        Internals.d.f());
    }
  };
  exports.preconnect = function (href, options) {
    "string" === typeof href &&
      (options
        ? ((options = options.crossOrigin),
          (options =
            "string" === typeof options ? ("use-credentials" === options ? options : "") : void 0))
        : (options = null),
      Internals.d.C(href, options));
  };
  exports.prefetchDNS = function (href) {
    "string" === typeof href && Internals.d.D(href);
  };
  exports.preinit = function (href, options) {
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
  exports.preinitModule = function (href, options) {
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
      } else options ?? Internals.d.M(href);
  };
  exports.preload = function (href, options) {
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
  exports.preloadModule = function (href, options) {
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
  exports.requestFormReset = function (form) {
    Internals.d.r(form);
  };
  exports.unstable_batchedUpdates = function (fn, a) {
    return fn(a);
  };
  exports.useFormState = function (action, initialState, permalink) {
    return ReactSharedInternals.H.useFormState(action, initialState, permalink);
  };
  exports.useFormStatus = function () {
    return ReactSharedInternals.H.useHostTransitionStatus();
  };
  exports.version = "19.2.5";
});
//#endregion
//#region node_modules/react-dom/index.js
var require_react_dom = /* @__PURE__ */ __commonJSMin((exports, module) => {
  function checkDCE() {
    if (
      typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ === "undefined" ||
      typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE !== "function"
    )
      return;
    try {
      __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(checkDCE);
    } catch (err) {
      console.error(err);
    }
  }
  checkDCE();
  module.exports = require_react_dom_production();
});
//#endregion
//#region \0%23tanstack-start-server-fn-resolver
var manifest = {
  "37e67d3ccf1225b287d37f9049d00eb6cc2b71abed75aa21d6cf45b6bbe99560": {
    functionName: "getInfo_createServerFn_handler",
    importer: () => import("./routes-DMavudsQ.js"),
  },
};
async function getServerFnById(id, access) {
  const serverFnInfo = manifest[id];
  if (!serverFnInfo) throw new Error("Server function info not found for " + id);
  const fnModule = serverFnInfo.module ?? (await serverFnInfo.importer());
  if (!fnModule) throw new Error("Server function module not resolved for " + id);
  const action = fnModule[serverFnInfo.functionName];
  if (!action) throw new Error("Server function module export not resolved for serverFn ID: " + id);
  return action;
}
//#endregion
export {
  arraysEqual as A,
  isPromise as B,
  findRouteMatch as C,
  createLRUCache as D,
  processRouteTree as E,
  escapeHtml as F,
  useForwardedRef as G,
  nullReplaceEqualDeep as H,
  functionalUpdate as I,
  usePrevious as J,
  useIntersectionObserver as K,
  isDangerousProtocol as L,
  decodePath as M,
  deepEqual as N,
  invariant as O,
  encodePathLikeUrl as P,
  isModuleNotFoundError as R,
  findFlatMatch as S,
  processRouteMasks as T,
  replaceEqualDeep as U,
  last as V,
  reactUse as W,
  removeTrailingSlash as _,
  matchContext as a,
  trimPathLeft as b,
  ClientOnly as c,
  isNotFound as d,
  cleanPath as f,
  joinPaths as g,
  interpolatePath as h,
  dummyMatchContext as i,
  createControlledPromise as j,
  DEFAULT_PROTOCOL_ALLOWLIST as k,
  useHydrated as l,
  exactPathTest as m,
  require_react_dom as n,
  useRouter as o,
  compileDecodeCharMap as p,
  useLayoutEffect as q,
  useStore as r,
  routerContext as s,
  getServerFnById as t,
  rootRouteId as u,
  resolvePath as v,
  findSingleMatch as w,
  trimPathRight as x,
  trimPath as y,
  isPlainObject as z,
};
