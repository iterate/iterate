import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { issuerRequestContext } from "./issuer-request-context.server.ts";
import { loginSearchOf } from "./login-search.ts";
import { loginState } from "./login.server.ts";
import { createConsentProject, describeConsent, NewConsentProject } from "./consent-page.server.ts";
import { appConfigOf, platformAddressesOf } from "./app-config.ts";

/** A server function's input, parsed. Start answers a thrown validation error with a 500 and an
 *  error log; input that does not parse is the caller's mistake, so it is a plain 400. */
function inputOf<T>(schema: z.ZodType<T>) {
  return (input: unknown) => {
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      throw new Response(`Invalid input: ${z.prettifyError(parsed.error)}`, { status: 400 });
    return parsed.data;
  };
}

export const getLandingState = createServerFn({ method: "GET" }).handler(async () => {
  const request = getRequest();
  const { env } = issuerRequestContext();
  setResponseHeader("cache-control", "no-store");
  return {
    issuer: platformAddressesOf(env, request).platformOrigin,
    dash: appConfigOf(env).urls.dash || null,
  };
});

export const getLoginState = createServerFn({ method: "GET" })
  .inputValidator(loginSearchOf)
  .handler(async ({ data }) => {
    const incoming = getRequest();
    const url = new URL("/login", incoming.url);
    for (const [name, value] of Object.entries(data)) {
      if (value) url.searchParams.set(name, value);
    }
    const { env, ctx } = issuerRequestContext();
    setResponseHeader("cache-control", "no-store");
    return loginState(new Request(url, incoming), env, ctx);
  });

export const getConsent = createServerFn({ method: "GET" })
  .inputValidator(inputOf(z.object({ authorization: z.string() })))
  .handler(async ({ data }) => {
    const { env, ctx } = issuerRequestContext();
    setResponseHeader("cache-control", "no-store");
    return describeConsent(getRequest(), env, ctx, data.authorization);
  });

export const createProjectForConsent = createServerFn({ method: "POST" })
  .inputValidator(inputOf(NewConsentProject))
  .handler(async ({ data }) => {
    const { env, ctx } = issuerRequestContext();
    return createConsentProject(getRequest(), env, ctx, data);
  });

/** Every server function the issuer serves; the Worker admits no other `/_serverFn/` path. */
export const issuerServerFunctions = [
  getLandingState,
  getLoginState,
  getConsent,
  createProjectForConsent,
];
