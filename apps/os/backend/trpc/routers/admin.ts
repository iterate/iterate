import { z } from "zod/v4";
import { and, eq, ilike, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, adminProcedure, protectedProcedure } from "../trpc.ts";
import * as schema from "../../db/schema.ts";
import { user, billingAccount } from "../../db/schema.ts";
import { getStripe } from "../../integrations/stripe/stripe.ts";
import { queuer } from "../../outbox/outbox-queuer.ts";
import { outboxClient } from "../../outbox/client.ts";

export const adminRouter = router({
  // Impersonate a user (creates a session as that user)
  impersonate: adminProcedure
    .input(
      z.object({
        userId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // This would typically integrate with better-auth's admin plugin
      // For now, return the user info that would be impersonated
      const targetUser = await ctx.db.query.user.findFirst({
        where: eq(user.id, input.userId),
      });

      if (!targetUser) {
        throw new Error("User not found");
      }

      return {
        message: "Impersonation would be handled via Better Auth admin plugin",
        targetUser: {
          id: targetUser.id,
          email: targetUser.email,
          name: targetUser.name,
        },
      };
    }),

  // Stop impersonating
  stopImpersonating: protectedProcedure.mutation(async ({ ctx: _ctx }) => {
    // This would integrate with better-auth's admin plugin
    return {
      message: "Stop impersonation would be handled via Better Auth admin plugin",
    };
  }),

  // List all users (admin only)
  listUsers: adminProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;

      const users = await ctx.db.query.user.findMany({
        limit,
        offset,
        orderBy: (u, { desc }) => [desc(u.createdAt)],
      });

      return users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        image: u.image,
        role: u.role,
        createdAt: u.createdAt,
      }));
    }),

  // List all organizations (admin only)
  listOrganizations: adminProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;

      const orgs = await ctx.db.query.organization.findMany({
        limit,
        offset,
        orderBy: (o, { desc }) => [desc(o.createdAt)],
        with: {
          projects: true,
          members: {
            with: {
              user: true,
            },
          },
        },
      });

      return orgs.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        projectCount: o.projects.length,
        memberCount: o.members.length,
        createdAt: o.createdAt,
      }));
    }),

  // Get session info for debugging
  sessionInfo: protectedProcedure.query(async ({ ctx }) => {
    return {
      user: {
        id: ctx.user.id,
        email: ctx.user.email,
        name: ctx.user.name,
        role: ctx.user.role,
      },
      session: ctx.session
        ? {
            expiresAt: ctx.session.session.expiresAt,
            ipAddress: ctx.session.session.ipAddress,
            userAgent: ctx.session.session.userAgent,
            impersonatedBy: ctx.session.session.impersonatedBy,
          }
        : null,
    };
  }),

  chargeUsage: adminProcedure
    .input(
      z.object({
        organizationId: z.string(),
        units: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const account = await ctx.db.query.billingAccount.findFirst({
        where: eq(billingAccount.organizationId, input.organizationId),
      });

      if (!account?.stripeCustomerId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Organization has no billing account or Stripe customer",
        });
      }

      const stripe = getStripe();

      const meterEvent = await stripe.v2.billing.meterEvents.create({
        event_name: "test_usage_units",
        payload: {
          stripe_customer_id: account.stripeCustomerId,
          value: String(input.units),
        },
      });

      return {
        success: true,
        units: input.units,
        costCents: input.units,
        meterEventId: meterEvent.identifier,
        stripeCustomerId: account.stripeCustomerId,
      };
    }),

  impersonationInfo: protectedProcedure.query(async ({ ctx }) => {
    const impersonatedBy = ctx?.session?.session.impersonatedBy || undefined;
    const isAdmin = ctx?.user?.role === "admin" || undefined;
    return { impersonatedBy, isAdmin };
  }),

  searchUsersByEmail: adminProcedure
    .input(z.object({ searchEmail: z.string() }))
    .query(async ({ ctx, input }) => {
      const users = await ctx.db.query.user.findMany({
        where: ilike(schema.user.email, `%${input.searchEmail}%`),
        columns: { id: true, email: true, name: true },
        limit: 10,
      });
      return users;
    }),

  findUserByEmail: adminProcedure
    .input(z.object({ email: z.string() }))
    .query(async ({ ctx, input }) => {
      const foundUser = await ctx.db.query.user.findFirst({
        where: eq(user.email, input.email.toLowerCase()),
      });
      return foundUser;
    }),

  getProjectOwner: adminProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const project = await ctx.db.query.project.findFirst({
        where: eq(schema.project.id, input.projectId),
      });

      if (!project) {
        throw new Error("Project not found");
      }

      const ownerMembership = await ctx.db.query.organizationUserMembership.findFirst({
        where: and(
          eq(schema.organizationUserMembership.organizationId, project.organizationId),
          eq(schema.organizationUserMembership.role, "owner"),
        ),
        with: { user: true },
      });

      if (!ownerMembership) {
        throw new Error("Organization owner not found");
      }

      return {
        userId: ownerMembership.user.id,
        email: ownerMembership.user.email,
        name: ownerMembership.user.name,
      };
    }),

  setUserRole: adminProcedure
    .input(
      z.object({
        userId: z.string(),
        role: z.enum(["user", "admin"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.id && input.role !== "admin") {
        throw new Error("You cannot remove your own admin role");
      }

      const targetUser = await ctx.db.query.user.findFirst({
        where: eq(user.id, input.userId),
      });

      if (!targetUser) {
        throw new Error("User not found");
      }

      await ctx.db.update(user).set({ role: input.role }).where(eq(user.id, input.userId));

      return {
        userId: input.userId,
        email: targetUser.email,
        name: targetUser.name,
        role: input.role,
      };
    }),

  outbox: {
    poke: adminProcedure
      .input(z.object({ message: z.string() }))
      .mutation(async ({ ctx, input }) => {
        return ctx.db.transaction(async (tx) => {
          const result = await tx.execute(sql`select now()::text as now`);
          const rows = result.rows as { now: string }[];
          const dbtime = rows[0]?.now ?? new Date().toISOString();
          const reply = `You used ${input.message.split(" ").length} words, well done.`;
          return ctx.sendTrpc(tx, { dbtime, reply });
        });
      }),
    pokeOutboxClientDirectly: adminProcedure
      .input(z.object({ message: z.string() }))
      .mutation(async ({ ctx, input }) => {
        await outboxClient.sendTx(ctx.db, "testing:poke", async (tx) => {
          const result = await tx.execute(sql`select now()::text as now`);
          const rows = result.rows as { now: string }[];
          const dbtime = String(rows[0]?.now ?? new Date().toISOString());
          return {
            payload: { dbtime, message: `${input.message} at ${new Date().toISOString()}` },
          };
        });
        return { done: true };
      }),
    peek: adminProcedure
      .input(
        z
          .object({
            limit: z.number().optional(),
            offset: z.number().optional(),
            minReadCount: z.number().optional(),
          })
          .optional(),
      )
      .query(async ({ ctx, input }) => {
        return await queuer.peekQueue(ctx.db, input);
      }),
    peekArchive: adminProcedure
      .input(
        z
          .object({
            limit: z.number().optional(),
            offset: z.number().optional(),
            minReadCount: z.number().optional(),
          })
          .optional(),
      )
      .query(async ({ ctx, input }) => {
        return await queuer.peekArchive(ctx.db, input);
      }),
    process: adminProcedure.mutation(async ({ ctx }) => {
      return await queuer.processQueue(ctx.db);
    }),
    listEvents: adminProcedure
      .input(
        z
          .object({
            limit: z.number().min(1).max(200).default(25),
            offset: z.number().min(0).default(0),
            sortDirection: z.enum(["asc", "desc"]).default("desc"),
            eventName: z.string().optional(),
            consumerName: z.string().optional(),
            consumerStatus: z.enum(["pending", "success", "retrying", "failed"]).optional(),
            statusMode: z.enum(["some", "all"]).default("some"),
            ageMinMs: z.number().optional(),
            ageMaxMs: z.number().optional(),
            readCountMin: z.number().optional(),
            readCountMax: z.number().optional(),
            resolutionMinMs: z.number().optional(),
            resolutionMaxMs: z.number().optional(),
            payloadContains: z
              .string()
              .transform((val, ctx) => {
                try {
                  JSON.parse(val) as {};
                  return val;
                } catch {
                  ctx.addIssue({ code: "custom", message: "Invalid JSON" });
                  return z.NEVER;
                }
              })
              .optional(),
          })
          .optional(),
      )
      .query(async ({ ctx, input }) => {
        const limit = input?.limit ?? 25;
        const offset = input?.offset ?? 0;
        const sortDir = input?.sortDirection ?? "desc";

        // Build WHERE clauses for the event
        const eventWheres: ReturnType<typeof sql>[] = [];
        if (input?.eventName) {
          eventWheres.push(sql`e.name = ${input.eventName}`);
        }
        if (input?.payloadContains) {
          eventWheres.push(sql`e.payload @> ${input.payloadContains}::jsonb`);
        }
        if (input?.ageMinMs) {
          eventWheres.push(
            sql`e.created_at <= now() - interval '1 millisecond' * ${input.ageMinMs}`,
          );
        }
        if (input?.ageMaxMs) {
          eventWheres.push(
            sql`e.created_at >= now() - interval '1 millisecond' * ${input.ageMaxMs}`,
          );
        }

        // Consumer-level filters: we filter events that have matching consumers
        const hasConsumerFilters =
          input?.consumerName ||
          input?.consumerStatus ||
          input?.readCountMin !== undefined ||
          input?.readCountMax !== undefined ||
          input?.resolutionMinMs !== undefined ||
          input?.resolutionMaxMs !== undefined;

        if (hasConsumerFilters) {
          const consumerWheres: ReturnType<typeof sql>[] = [];
          if (input?.consumerName) {
            consumerWheres.push(sql`cm.message->>'consumer_name' = ${input.consumerName}`);
          }
          if (input?.consumerStatus) {
            consumerWheres.push(
              sql`coalesce(cm.message->>'status', 'pending') = ${input.consumerStatus}`,
            );
          }
          if (input?.readCountMin !== undefined) {
            consumerWheres.push(sql`cm.read_ct >= ${input.readCountMin}`);
          }
          if (input?.readCountMax !== undefined) {
            consumerWheres.push(sql`cm.read_ct <= ${input.readCountMax}`);
          }
          if (input?.resolutionMinMs !== undefined) {
            consumerWheres.push(
              sql`(cm.message->>'status' in ('success', 'failed') and extract(epoch from (cm.vt - cm.enqueued_at)) * 1000 >= ${input.resolutionMinMs})`,
            );
          }
          if (input?.resolutionMaxMs !== undefined) {
            consumerWheres.push(
              sql`(cm.message->>'status' in ('success', 'failed') and extract(epoch from (cm.vt - cm.enqueued_at)) * 1000 <= ${input.resolutionMaxMs})`,
            );
          }

          const consumerWhereSql = consumerWheres.length
            ? sql.join(consumerWheres, sql` and `)
            : sql`true`;
          const quantifier = input?.statusMode === "all" ? sql`not exists` : sql`exists`;
          const subqueryCondition =
            input?.statusMode === "all"
              ? sql`
                select 1 from all_consumers cm
                where (cm.message->>'event_id')::bigint = e.id
                  and not (${consumerWhereSql})
              `
              : sql`
                select 1 from all_consumers cm
                where (cm.message->>'event_id')::bigint = e.id
                  and ${consumerWhereSql}
              `;

          eventWheres.push(sql`${quantifier} (${subqueryCondition})`);
        }

        const whereSql = eventWheres.length
          ? sql`where ${sql.join(eventWheres, sql` and `)}`
          : sql``;

        const orderSql = sortDir === "asc" ? sql`order by e.id asc` : sql`order by e.id desc`;

        const allConsumersSql = sql`
          select msg_id, enqueued_at, vt, read_ct, message
          from pgmq.q_consumer_job_queue
          union all
          select msg_id, enqueued_at, vt, read_ct, message
          from pgmq.a_consumer_job_queue
        `;

        // Main query: get events with their consumer messages as a JSON array
        const result = await ctx.db.execute(sql`
          with all_consumers as (${allConsumersSql})
          select
            e.id,
            e.name,
            e.payload,
            e.created_at as "createdAt",
            e.updated_at as "updatedAt",
            coalesce(
              (
                select json_agg(
                  json_build_object(
                    'msg_id', ac.msg_id,
                    'enqueued_at', ac.enqueued_at,
                    'vt', ac.vt,
                    'read_ct', ac.read_ct,
                    'message', ac.message
                  )
                  order by ac.msg_id
                )
                from all_consumers ac
                where (ac.message->>'event_id')::bigint = e.id
              ),
              '[]'::json
            ) as consumers
          from outbox_event e
          ${whereSql}
          ${orderSql}
          limit ${limit}
          offset ${offset}
        `);
        const rows = result.rows as {
          id: number;
          name: string;
          payload: Record<string, unknown>;
          createdAt: string;
          updatedAt: string;
          consumers: Array<{
            msg_id: number | string;
            enqueued_at: string;
            vt: string;
            read_ct: number;
            message: Record<string, unknown>;
          }>;
        }[];

        // Also get a total count for pagination
        const countRows = (
          await ctx.db.execute(sql`
          with all_consumers as (${allConsumersSql})
          select count(*)::int as total from outbox_event e ${whereSql}
        `)
        ).rows as { total: number }[];
        const total = countRows[0]?.total ?? 0;

        // Get distinct event names for filter dropdowns
        const eventNamesRows = (
          await ctx.db.execute(sql`select distinct name from outbox_event order by name`)
        ).rows as { name: string }[];
        const eventNames = eventNamesRows.map((r) => r.name);

        // Get distinct consumer names
        const consumerNamesRows = (
          await ctx.db.execute(sql`
          with all_consumers as (${allConsumersSql})
          select distinct message->>'consumer_name' as name
          from all_consumers
          where message->>'consumer_name' is not null
          order by name
        `)
        ).rows as { name: string }[];
        const consumerNames = consumerNamesRows.map((r) => r.name);

        return { events: rows, total, eventNames, consumerNames };
      }),
  },
});
