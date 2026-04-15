import { createStart } from "@tanstack/react-start";

/**
 * Keep Start config tiny. Request context is now provided by the documented
 * `src/server.ts` entrypoint instead of a middleware workaround.
 *
 * Server entry docs:
 * - https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point
 */
export const startInstance = createStart(() => ({}));
