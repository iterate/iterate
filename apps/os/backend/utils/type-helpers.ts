import { z } from "zod/v4";

export type Branded<Brand extends string, Value = string> = Value & z.$brand<Brand>;

// Create a proper recursive schema for JSONSerializable
export const JSONSerializable: z.ZodType<JSONSerializable> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.undefined(),
    z.array(JSONSerializable),
    z.record(z.string(), JSONSerializable),
  ]),
);

export interface JSONSerializableArray extends ReadonlyArray<JSONSerializable> {}
export interface JSONSerializableObject {
  readonly [key: string]: JSONSerializable;
}

type JSONPrimitive = string | number | boolean | null | undefined;

export type JSONSerializable = JSONPrimitive | JSONSerializableArray | JSONSerializableObject;

// For stricter typing, you can add a validator type:
export type DeepJSONSerializable<T> = T extends JSONPrimitive
  ? T
  : T extends Array<infer U>
    ? Array<DeepJSONSerializable<U>>
    : T extends object
      ? { [K in keyof T]: DeepJSONSerializable<T[K]> }
      : never;

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// Create a Zod schema constrained to infer type T, failing at compile-time if mismatch
export function createZodSchemaThatSatisfies<T>() {
  return <Z extends z.ZodType<T>>(zodSchema: Z): Z => zodSchema;
}

/**
 * `path.join` but for url pathnames.
 * It also removes extra slashes and trailing slashes.
 * Only works with pathnames, not urls.
 * @example
 * joinPathname("a/", "/b/c/", something ? "d" : null);
 * //   ^? "/a/b/c"
 */
export const joinPathname = (...paths: (string | undefined | null)[]) =>
  (
    "/" +
    paths
      .filter((p) => typeof p === "string")
      .map((p) => p.replace(/^\//, "").replace(/\/$/, ""))
      .join("/")
  ).replace(/\/+/g, "/");

/**
 * Removes a trailing slash from a url pathname.
 * @example
 * removeTrailingSlash("/a/b/c/");
 * //   ^? "/a/b/c"
 */
export const removeTrailingSlash = (url: string) => (url === "/" ? "/" : url.replace(/\/$/, ""));

/**
 * Creates a url object from an origin and a pathname.
 * @example
 * createUrl("https://example.com/", "/a/b/c/");
 * //   ^? URL {"https://example.com/a/b/c"}
 */
export const createUrl = (origin: string, path: string) => {
  const url = new URL(origin);
  url.pathname = joinPathname(path);
  return removeTrailingSlash(url.toString());
};

/**
 * Rewrites the pathname of a request.
 * @example
 * rewritePathname(new Request("https://example.com/a/b/c/"), "/d/e/f/");
 * //   ^? Request {"https://example.com/d/e/f/"}
 */
export const rewritePathname = (request: Request, path: string) => {
  const url = new URL(request.url);
  url.pathname = path;
  return new Request(url.toString(), request);
};

/**
 * Removes a prefix from the pathname of a request.
 * Useful for removing the binding prefix path from a proxy request.
 * @example
 * removePathPrefix(new Request("https://example.com/proxy/b/c/"), "/proxy");
 * //   ^? Request {"https://example.com/b/c/"}
 */
export const removePathPrefix = (request: Request, prefix: string) => {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(prefix, "");
  return new Request(url.toString(), request);
};

/**
 * Async version of `Object.fromEntries`.
 * @example
 * mapArrayIntoObject([1, 2, 3], async (value, index) => [value.toString(), value]);
 * //   ^? Promise<{ "1": 1, "2": 2, "3": 3 }>
 */
export const mapArrayIntoObject = async <T, U>(
  array: T[],
  fn: (value: T, index: number) => Promise<[string, U]> | [string, U],
) =>
  Object.fromEntries(await Promise.all(array.map(async (value, index) => await fn(value, index))));

// We're not 100% sure what Cloudflare's actual max length is. It's likely 63
// characters because that matches the subdomain length restriction, but we keep
// it conservative at 50 just in case.
export const MAX_LENGTH = 50;

/**
 * Shortens a Cloudflare resource name to comply with the MAX_LENGTH
 * limitation. If the provided name exceeds the limit, it is truncated
 * and the last 6 characters are replaced with a deterministic
 * alphanumeric hash.
 */
export const shortenCloudflareName = (name: string): string => {
  if (name.length <= MAX_LENGTH) {
    return name;
  }
  const truncated = name.slice(0, MAX_LENGTH - 6);
  const hash = stringToHash(name);
  return truncated + hash;
};

/**
 * Creates a 6-character alphanumeric hash from a string using browser-compatible
 * Web Crypto API.
 */
export const stringToHash = (value: string): string => {
  // Use a simple deterministic algorithm that works in both browser and Cloudflare Workers
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }

  // Convert to alphanumeric string (base36 encoding)
  // Take absolute value first to handle negative numbers
  const hashStr = Math.abs(hash).toString(36);

  // Ensure it's exactly 6 characters by padding or truncating
  return hashStr.padStart(6, "0").slice(-6);
};

export function tryParseJson<T>(json: string): T | null {
  try {
    return JSON.parse(json);
  } catch (_error) {
    return null;
  }
}

/**
 * Converts a intersection type into a single pretty object.
 * @example
 * type A = { a: 1; b: 2 };
 * type B = { b: 3; c: 4 };
 * type C = A & B;
 * type D = Prettify<C>;
 * //   ^? { a: 1; b: 3; c: 4 }
 */
export type Prettify<Type> = Type extends (...args: any[]) => any
  ? Type
  : Extract<
      {
        [Key in keyof Type]: Type[Key];
      },
      Type
    >;

/**
 * Throws an error if the input is not exhaustive. Used as default case in switch statements.
 * @example
 * switch (x) {
 *   case "a":
 *     break;
 *   default:
 *     exhaustiveMatchingGuard(x);
 */
export function exhaustiveMatchingGuard(x: never): never {
  throw new Error(`Exhaustive matching guard triggered: ${JSON.stringify(x, null, 2)}`);
}

/**
 * Try to parse a value as JSON, returning the original value if parsing fails.
 */
export function tryParseJSON(value: unknown): unknown {
  try {
    return JSON.parse(value as string);
  } catch (_error) {
    return value;
  }
}

/**
 * Ensures a value is a string.
 */
export function ensureString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

// Helper function to recursively search through all properties of an object
export const fulltextSearchInObject = (obj: any, searchTerm: string): boolean => {
  if (!obj || !searchTerm) {
    return true;
  }

  const lowerSearchTerm = searchTerm.toLowerCase();

  const searchRecursive = (value: any): boolean => {
    if (value === null || value === undefined) {
      return false;
    }

    if (typeof value === "string") {
      return value.toLowerCase().includes(lowerSearchTerm);
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return value.toString().toLowerCase().includes(lowerSearchTerm);
    }

    if (Array.isArray(value)) {
      return value.some((item) => searchRecursive(item));
    }

    if (typeof value === "object") {
      return Object.values(value).some((prop) => searchRecursive(prop));
    }

    return false;
  };

  return searchRecursive(obj);
};

export function getOrigin(req: Request): string {
  const requestUrl = new URL(req.url);
  const protocol = req.headers.get("x-forwarded-proto") || requestUrl.protocol;
  const host = requestUrl.host;
  const origin = `${protocol}${protocol.endsWith(":") ? "" : ":"}//${host}`;
  return origin;
}

/**
 * A way to backwards-compatibly deprecate a type. The `old` type will still be accepted at runtime, but at compile time
 * will cause a type error unless the `deprecated: true` prop is passed too. You have to implement an `upgrade` function
 * which converts `old` into `new`. The `new` type is the parsed output type.
 *
 * @example
 * const User = backcompat({
 *   new: z.object({firstName: z.string(), lastName: z.string()}),
 *   old: z.object({fullName: z.string()}),
 *   upgrade: old => {
 *     const names = old.fullName.split(' ')
 *     return {firstName: names.slice(0, -1).join(' '), lastName: names[names.length - 1]}
 *   },
 * })
 */
export const backcompat = <T, U>(params: {
  new: z.ZodType<T>;
  old: z.ZodType<U>;
  upgrade: (old: U) => T;
}) => {
  return z.union([
    params.new,
    (params.old as z.ZodType<U & { deprecated: true }>).transform(params.upgrade),
  ]);
};

/**
 * A Result type for explicit error handling.
 * This type represents the outcome of an operation that can either succeed or fail.
 *
 * @example
 * function divide(a: number, b: number): Result<number> {
 *   if (b === 0) {
 *     return { success: false, error: "Division by zero" };
 *   }
 *   return { success: true, data: a / b };
 * }
 */
export type Result<T, E = string> = { success: true; data: T } | { success: false; error: E };
