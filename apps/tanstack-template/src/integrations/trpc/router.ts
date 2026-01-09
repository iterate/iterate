import { createTRPCRouter, publicProcedure } from './init.ts'

export const trpcRouter = createTRPCRouter({
  hello: publicProcedure.query(() => ({ message: 'Hello from tRPC!' })),
})

export type TRPCRouter = typeof trpcRouter
