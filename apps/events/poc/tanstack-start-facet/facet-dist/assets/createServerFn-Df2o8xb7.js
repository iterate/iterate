import { AsyncLocalStorage } from "node:async_hooks";
//#region node_modules/@tanstack/router-core/dist/esm/redirect.js
/**
 * Create a redirect Response understood by TanStack Router.
 *
 * Use from route `loader`/`beforeLoad` or server functions to trigger a
 * navigation. If `throw: true` is set, the redirect is thrown instead of
 * returned. When an absolute `href` is supplied and `reloadDocument` is not
 * set, a full-document navigation is inferred.
 *
 * @param opts Options for the redirect. Common fields:
 * - `href`: absolute URL for external redirects; infers `reloadDocument`.
 * - `statusCode`: HTTP status code to use (defaults to 307).
 * - `headers`: additional headers to include on the Response.
 * - Standard navigation options like `to`, `params`, `search`, `replace`,
 *   and `reloadDocument` for internal redirects.
 * @returns A Response augmented with router navigation options.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/redirectFunction
 */
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
/** Check whether a value is a TanStack Router redirect Response. */
/** Check whether a value is a TanStack Router redirect Response. */
function isRedirect(obj) {
  return obj instanceof Response && !!obj.options;
}
/** True if value is a redirect with a resolved `href` location. */
/** True if value is a redirect with a resolved `href` location. */
function isResolvedRedirect(obj) {
  return isRedirect(obj) && !!obj.options.href;
}
/** Parse a serialized redirect object back into a redirect Response. */
/** Parse a serialized redirect object back into a redirect Response. */
function parseRedirect(obj) {
  if (obj !== null && typeof obj === "object" && obj.isSerializedRedirect) return redirect(obj);
}
//#endregion
//#region node_modules/cookie-es/dist/index.mjs
function splitSetCookieString(cookiesString) {
  if (Array.isArray(cookiesString)) return cookiesString.flatMap((c) => splitSetCookieString(c));
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
//#endregion
//#region node_modules/@tanstack/router-core/dist/esm/ssr/headers.js
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
//#endregion
//#region node_modules/@tanstack/start-client-core/dist/esm/constants.js
var TSS_FORMDATA_CONTEXT = "__TSS_CONTEXT";
var TSS_SERVER_FUNCTION = Symbol.for("TSS_SERVER_FUNCTION");
var TSS_SERVER_FUNCTION_FACTORY = Symbol.for("TSS_SERVER_FUNCTION_FACTORY");
var X_TSS_SERIALIZED = "x-tss-serialized";
var X_TSS_RAW_RESPONSE = "x-tss-raw";
/** Content-Type for multiplexed framed responses (RawStream support) */
var TSS_CONTENT_TYPE_FRAMED = "application/x-tss-framed";
/**
 * Frame types for binary multiplexing protocol.
 */
var FrameType = {
  JSON: 0,
  CHUNK: 1,
  END: 2,
  ERROR: 3,
};
/** Full Content-Type header value with version parameter */
var TSS_CONTENT_TYPE_FRAMED_VERSIONED = `${TSS_CONTENT_TYPE_FRAMED}; v=1`;
//#endregion
//#region node_modules/@tanstack/start-client-core/dist/esm/safeObjectMerge.js
function isSafeKey(key) {
  return key !== "__proto__" && key !== "constructor" && key !== "prototype";
}
/**
 * Merge target and source into a new null-proto object, filtering dangerous keys.
 */
function safeObjectMerge(target, source) {
  const result = Object.create(null);
  if (target) {
    for (const key of Object.keys(target)) if (isSafeKey(key)) result[key] = target[key];
  }
  if (source && typeof source === "object") {
    for (const key of Object.keys(source)) if (isSafeKey(key)) result[key] = source[key];
  }
  return result;
}
/**
 * Create a null-prototype object, optionally copying from source.
 */
function createNullProtoObject(source) {
  if (!source) return Object.create(null);
  const obj = Object.create(null);
  for (const key of Object.keys(source)) if (isSafeKey(key)) obj[key] = source[key];
  return obj;
}
//#endregion
//#region node_modules/@tanstack/start-storage-context/dist/esm/async-local-storage.js
var GLOBAL_STORAGE_KEY = Symbol.for("tanstack-start:start-storage-context");
var globalObj = globalThis;
if (!globalObj[GLOBAL_STORAGE_KEY]) globalObj[GLOBAL_STORAGE_KEY] = new AsyncLocalStorage();
var startStorage = globalObj[GLOBAL_STORAGE_KEY];
async function runWithStartContext(context, fn) {
  return startStorage.run(context, fn);
}
function getStartContext(opts) {
  const context = startStorage.getStore();
  if (!context && opts?.throwIfNotFound !== false)
    throw new Error(
      `No Start context found in AsyncLocalStorage. Make sure you are using the function within the server runtime.`,
    );
  return context;
}
//#endregion
//#region node_modules/@tanstack/start-client-core/dist/esm/getStartOptions.js
var getStartOptions = () => getStartContext().startOptions;
//#endregion
//#region node_modules/@tanstack/start-client-core/dist/esm/getStartContextServerOnly.js
var getStartContextServerOnly = getStartContext;
//#endregion
//#region node_modules/@tanstack/start-client-core/dist/esm/createServerFn.js
var createServerFn = (options, __opts) => {
  const resolvedOptions = __opts || options || {};
  if (typeof resolvedOptions.method === "undefined") resolvedOptions.method = "GET";
  const res = {
    options: resolvedOptions,
    middleware: (middleware) => {
      const newMiddleware = [...(resolvedOptions.middleware || [])];
      middleware.map((m) => {
        if (TSS_SERVER_FUNCTION_FACTORY in m) {
          if (m.options.middleware) newMiddleware.push(...m.options.middleware);
        } else newMiddleware.push(m);
      });
      const res = createServerFn(void 0, {
        ...resolvedOptions,
        middleware: newMiddleware,
      });
      res[TSS_SERVER_FUNCTION_FACTORY] = true;
      return res;
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
          const result = await executeMiddleware(resolvedMiddleware, "client", {
            ...extractedFn,
            ...newOptions,
            data: opts?.data,
            headers: opts?.headers,
            signal: opts?.signal,
            fetch: opts?.fetch,
            context: createNullProtoObject(),
          });
          const redirect = parseRedirect(result.error);
          if (redirect) throw redirect;
          if (result.error) throw result.error;
          return result.result;
        },
        {
          ...extractedFn,
          method: resolvedOptions.method,
          __executeServer: async (opts) => {
            const startContext = getStartContextServerOnly();
            const serverContextAfterGlobalMiddlewares = startContext.contextAfterGlobalMiddlewares;
            return await executeMiddleware(resolvedMiddleware, "server", {
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
  const fun = (options) => {
    return createServerFn(void 0, {
      ...resolvedOptions,
      ...options,
    });
  };
  return Object.assign(fun, res);
};
async function executeMiddleware(middlewares, env, opts) {
  let flattenedMiddlewares = flattenMiddlewares([
    ...(getStartOptions()?.functionMiddleware || []),
    ...middlewares,
  ]);
  if (env === "server") {
    const startContext = getStartContextServerOnly({ throwIfNotFound: false });
    if (startContext?.executedRequestMiddlewares)
      flattenedMiddlewares = flattenedMiddlewares.filter(
        (m) => !startContext.executedRequestMiddlewares.has(m),
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
          const result = await callNextMiddleware({
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
          if (result.error) throw result.error;
          return result;
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
    middleware.forEach((m) => {
      if (m.options.middleware) recurse(m.options.middleware, depth + 1);
      if (!seen.has(m)) {
        seen.add(m);
        flattened.push(m);
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
//#endregion
export {
  redirect as _,
  runWithStartContext as a,
  FrameType as c,
  TSS_SERVER_FUNCTION as d,
  X_TSS_RAW_RESPONSE as f,
  isResolvedRedirect as g,
  isRedirect as h,
  getStartContext as i,
  TSS_CONTENT_TYPE_FRAMED_VERSIONED as l,
  mergeHeaders as m,
  flattenMiddlewares as n,
  createNullProtoObject as o,
  X_TSS_SERIALIZED as p,
  getStartOptions as r,
  safeObjectMerge as s,
  createServerFn as t,
  TSS_FORMDATA_CONTEXT as u,
};
