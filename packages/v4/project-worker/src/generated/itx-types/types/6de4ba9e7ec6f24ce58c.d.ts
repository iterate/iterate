import { type OAuthHelpers } from "./955374e54dd86ab03c2e";
import { z } from "./66f12fdbe94056929e4c";
declare const BrowserPrincipal: z.ZodObject<{
    kind: z.ZodLiteral<"unverified-email">;
    email: z.ZodEmail;
}, z.core.$strict>;
export type BrowserPrincipal = z.infer<typeof BrowserPrincipal>;
export interface OptionalAuthEnv {
    PUBLIC_ORIGIN?: string;
    OAUTH_KV?: KVNamespace;
    OAUTH_PROVIDER?: OAuthHelpers;
}
type Core<Env> = {
    fetch(request: Request, env: Env, ctx: ExecutionContext, principal?: BrowserPrincipal): Promise<Response>;
};
export declare function withOptionalDemoLogin<Env extends OptionalAuthEnv>(core: Core<Env>): {
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
};
export {};
