import { createStart } from "@tanstack/react-start";

/**
 * Keep the Start config tiny. The oRPC SSR bridge lives in `src/orpc/client.ts`.
 *
 * Middleware docs:
 * - https://tanstack.com/start/latest/docs/framework/react/guide/middleware
 */
export const startInstance = createStart(() => ({}));
