// Creates a TRPC client that can be used in vitest tests running in Node.js

import { createTRPCClient, httpBatchLink, type TRPCClient } from "@trpc/client";
import { fetch } from "../../../../fetch.ts";
import type { AppRouter } from "../../../../trpc/root";

/**
 * Configuration for creating a vitest TRPC client
 */
export interface VitestTrpcClientConfig {
  /**
   * The TRPC endpoint URL
   */
  url: string;

  /**
   * Optional authentication headers to include in all requests
   */
  authHeaders?: Record<string, string>;

  /**
   * Enable debug logging for requests and responses
   */
  log?: (...args: any[]) => void;

  /**
   * Additional headers to include in all requests
   */
  headers?: Record<string, string>;

  /**
   * Fetch options to pass to all requests
   */
  fetchOptions?: RequestInit;
}

export function makeVitestTrpcClient(config: VitestTrpcClientConfig): TRPCClient<AppRouter> {
  const {
    url,
    authHeaders = {},
    log = () => {},
    headers: additionalHeaders = {},
    fetchOptions = {},
  } = config;

  // Combine all headers
  const allHeaders = {
    ...authHeaders,
    ...additionalHeaders,
  };

  // Create custom fetch that includes our headers and logging
  const customFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const headers = new Headers(init?.headers);

    // Add our custom headers
    Object.entries(allHeaders).forEach(([key, value]) => {
      headers.set(key, value);
    });

    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || "GET";
    const body = init?.body;

    // Log request details if debug is enabled
    log(`[TRPC Request] ${method} ${url}`);
    if (body) {
      try {
        const bodyString = typeof body === "string" ? body : JSON.stringify(body);
        const parsedBody = JSON.parse(bodyString);
        log(`[TRPC Request Body]`, JSON.stringify(parsedBody, null, 2));
      } catch {
        log(`[TRPC Request Body]`, body);
      }
    }

    const startTime = Date.now();

    try {
      const response = await fetch(input, {
        ...init,
        ...fetchOptions,
        headers,
      });

      const duration = Date.now() - startTime;

      // Log the response body if it's not JSON, temporarily
      const responseClone = response.clone();
      const responseText = await responseClone.text();
      try {
        JSON.parse(responseText);
      } catch {
        console.log(`[TRPC Response didn't return JSON]`, responseText);
      }

      try {
        const responseData = JSON.parse(responseText);
        log(`[TRPC Response] ${response.status} ${response.statusText} (${duration}ms)`);
        log(`[TRPC Response Body]`, JSON.stringify(responseData, null, 2));

        // Log errors specifically
        if (!response.ok || (responseData as any).error) {
          log(`[TRPC Error] ${method} ${url} failed:`, (responseData as any).error || responseData);
        }
      } catch (_e) {
        log(
          `[TRPC Response] ${response.status} ${response.statusText} (${duration}ms) - Non-JSON response`,
        );
      }

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`[TRPC Network Error] ${method} ${url} failed after ${duration}ms:`, error);
      throw error;
    }
  };

  // Create and return the TRPC client
  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url,
        methodOverride: "POST",
        fetch: customFetch as any,
      }),
    ],
  });

  return client;
}

/**
 * Creates a TRPC client with service authentication
 *
 * @example
 * ```typescript
 * const client = makeServiceTrpcClient({
 *   url: "http://localhost:6004/api/trpc",
 *   serviceAuthToken: process.env.SERVICE_AUTH_TOKEN
 * });
 * ```
 */
// export function makeServiceTrpcClient(
//   config: VitestTrpcClientConfig & {
//     serviceAuthToken: string;
//     impersonateUserId?: string;
//     impersonateUserEmail?: string;
//   },
// ) {
//   const { serviceAuthToken, impersonateUserId, impersonateUserEmail, ...rest } = config;

//   const authHeaders: Record<string, string> = {
//     "x-iterate-service-auth-token": serviceAuthToken,
//   };

//   const baseClient = makeVitestTrpcClient({
//     ...rest,
//     authHeaders: {
//       ...authHeaders,
//       ...rest.authHeaders,
//     },
//   });

//   // If no impersonation is needed, return the base client
//   if (!impersonateUserId && !impersonateUserEmail) {
//     return baseClient;
//   }

//   // Create a proxy that adds __auth to input for all calls
//   function createImpersonationProxy(target: any, path: string[] = []): any {
//     return new Proxy(target, {
//       get(target, prop: string | symbol) {
//         if (typeof prop === "symbol") {
//           return target[prop];
//         }

//         const newPath = [...path, prop];
//         const value = target[prop];

//         // If this is a function (likely query/mutation), wrap it
//         if (typeof value === "function") {
//           return function (this: any, input?: any) {
//             // Add __auth object to input, can be overridden by the input
//             const authInput = {
//               ...input,
//               __auth: {
//                 ...(impersonateUserId && { impersonateUserId }),
//                 ...(impersonateUserEmail && { impersonateUserEmail }),
//                 ...(input?.__auth || {}),
//               },
//             };

//             return value.call(this, authInput);
//           };
//         }

//         // If this is an object, continue proxying
//         if (value && typeof value === "object") {
//           return createImpersonationProxy(value, newPath);
//         }

//         return value;
//       },
//     });
//   }

//   return createImpersonationProxy(baseClient);
// }

// export const makeTrpcClientWithMockOauth = async (_mockUserEmail: string, platformUrl: string) => {
// return makeVitestTrpcClient({
//   url: platformUrl + "/api/trpc",
//   log: process.env.DEBUG === "true" ? console.log : undefined,
// });

// // Simulating a Mock OAuth flow
// const mockOauthUrl = await trpc.integrations.loginWithOAuth.mutate({
//   integrationSlug: "mock",
//   finalRedirectUrl: platformUrl,
// });

// // we can replace `/authorize` with `/api/login` in the mock oauth url to login programmatically
// const mockLoginUrl = mockOauthUrl.replace("/authorize", "/api/login");

// const loginReq = await fetch(mockLoginUrl, {
//   method: "POST",
//   headers: {
//     "Content-Type": "application/json",
//   },
//   body: JSON.stringify({
//     email: mockUserEmail,
//     password: "test",
//   }),
// });

// const loginCookies = await loginReq
//   .json()
//   // Find the redirect url from the completed oauth flow
//   .then((data: any) => data.redirect)
//   // Request the redirect url to integrations proxy
//   .then((redirectUrl) =>
//     fetch(redirectUrl, {
//       method: "GET",
//       redirect: "manual",
//     }),
//   )
//   // Request the redirect url to the final redirect url
//   .then((res) => {
//     const nextUrl = res.headers.get("Location");
//     if (!nextUrl) {
//       throw new Error("No redirected url");
//     }
//     return fetch(nextUrl, {
//       method: "GET",
//       redirect: "manual",
//     });
//   })
//   // Get the cookies from the platform response
//   .then((res) => {
//     // @ts-ignore, not sure why its complaining about this
//     return res.headers.getSetCookie();
//   });

// // replace the trpc client with a new one that has the cookies
// const trpcWithMockOauth = makeVitestTrpcClient({
//   url: platformUrl + "/api/trpc",
//   debug: process.env.DEBUG === "true",
//   headers: {
//     Cookie: loginCookies.join("; "),
//   },
// });

// return trpcWithMockOauth;
// };
