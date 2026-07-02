// TYPECHECK-ONLY SHIM for `~/request-context.ts`.
//
// The itx auth import graph (`~/auth.ts` →
// `~/auth/auth-worker-service.ts`) type-imports `RequestContext` from
// apps/os's request-context module. That module also carries TanStack Start
// `Register` module augmentations that are wrong for this standalone app's
// program: they force apps/os's server request context onto this app's
// `handler.fetch`, and they augment apps/os's own copy of
// `@tanstack/react-start`, which is a different pnpm peer-variant than this
// app's and fails to resolve here (TS2664).
//
// tsconfig.json maps the exact specifier `~/request-context.ts` to this file
// instead. It only needs the slice the auth import graph actually uses
// (`Pick<RequestContext, "config">`). The import is type-only, so nothing
// changes at runtime.
import type { AppConfig } from "~/config.ts";

export type RequestContext = {
  config: AppConfig;
};
