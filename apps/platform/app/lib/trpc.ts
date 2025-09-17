import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../../backend/trpc/root.ts";

// this has a type error for some reason
export const trpc = createTRPCReact<AppRouter>();
// This works
// export const trpc: ReturnType<typeof createTRPCReact<AppRouter>> = createTRPCReact<AppRouter>();
