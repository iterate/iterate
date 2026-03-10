import { beforeAll, describe, expect, test } from "vitest";
import { sql, eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { resolveLocalDockerPostgresPort } from "../../scripts/local-docker-postgres-port.ts";

/**
 * Exploring whether we can use drizzle's CTE support to run multiple
 * mutations in a single query — specifically, wrapping side-effect
 * mutations as CTEs alongside a "main" insert/update that returns typed results.
 *
 * The goal: replace multi-statement transactions with single-query CTEs
 * where the extra mutations are fire-and-forget side effects.
 *
 * What Postgres supports (raw SQL):
 *
 *   WITH detach AS (
 *     UPDATE machine SET state = 'detached' WHERE state = 'starting' RETURNING id
 *   )
 *   INSERT INTO machine (id, name, state, ...) VALUES (...)
 *   RETURNING *
 *
 * What drizzle's $with API supports:
 *   - $with(alias).as(selectQuery)  — only select queries (TypedQueryBuilder)
 *   - $with(alias, selection).as(rawSQL) — raw SQL with manually declared column types
 *
 * The question: can we use the raw SQL overload to sneak in an insert/update CTE,
 * then have the main query be a typed drizzle insert/update with .returning()?
 */

const getTestDb = () => {
  process.env.DATABASE_URL ||= `postgres://postgres:postgres@localhost:${resolveLocalDockerPostgresPort()}/os`;
  const client = postgres(process.env.DATABASE_URL, { prepare: false });
  return drizzle(client, { schema, casing: "snake_case" });
};

describe("drizzle CTE exploration", () => {
  let db: ReturnType<typeof getTestDb>;

  beforeAll(() => {
    try {
      db = getTestDb();
    } catch {
      return;
    }
  });

  test("approach 1: $with takes a select, not an insert/update — this is the limitation", () => {
    // This works — select as a CTE:
    const selectCte = db
      .$with("active_machines")
      .as(
        db
          .select({ id: schema.machine.id })
          .from(schema.machine)
          .where(eq(schema.machine.state, "active")),
      );

    // This does NOT work — insert/update don't extend TypedQueryBuilder:
    // const insertCte = db.$with("new_machine").as(
    //   db.insert(schema.machine).values({ ... }).returning()
    // );
    // ^ TypeScript error: Argument of type 'PgInsertReturning<...>' is not assignable to parameter of type 'TypedQueryBuilder<...>'

    // Verify the select CTE at least compiles
    const query = db.with(selectCte).select().from(selectCte);
    const sqlStr = query.toSQL();
    expect(sqlStr.sql).toContain("with");
  });

  test("approach 1.5: $with takes a select, not an insert/update — this is the limitation", () => {
    // This works — select as a CTE:
    const selectCte = db
      .$with("active_machines")
      .as(
        db
          .update(schema.machine)
          .set({ state: "detached" })
          .where(eq(schema.machine.state, "active")),
      );

    // This does NOT work — insert/update don't extend TypedQueryBuilder:
    // const insertCte = db.$with("new_machine").as(
    //   db.insert(schema.machine).values({ ... }).returning()
    // );
    // ^ TypeScript error: Argument of type 'PgInsertReturning<...>' is not assignable to parameter of type 'TypedQueryBuilder<...>'

    // Verify the select CTE at least compiles
    const query = db.with(selectCte).select().from(selectCte);
    const sqlStr = query.toSQL();
    expect(sqlStr.sql).toContain("with");
  });

  test("approach 2: raw SQL overload — manually declare the CTE shape", () => {
    // The second $with overload lets us pass raw SQL with a declared column selection.
    // We can sneak an UPDATE/INSERT in here as raw SQL.
    const detachCte = db
      .$with("detach", {
        id: schema.machine.id,
      })
      .as(
        sql`UPDATE ${schema.machine} SET state = 'detached' WHERE state = 'starting' AND project_id = 'fake-project' RETURNING id`,
      );

    // Now use it in a select to verify it compiles and the types work:
    const query = db.with(detachCte).select({ detachedId: detachCte.id }).from(detachCte);
    const sqlStr = query.toSQL();
    expect(sqlStr.sql).toContain("with");
    expect(sqlStr.sql).toContain("UPDATE");
    expect(sqlStr.sql).toContain("detach");
  });

  test("approach 3: raw SQL CTE side-effect + typed insert as main query", async () => {
    // The dream: detach old machines as a CTE, insert new machine as the main query,
    // get back typed results from the insert.
    //
    // Problem: db.with(cte).insert(...) — does .with() support .insert()?
    const detachCte = db
      .$with("detach", {
        id: schema.machine.id,
      })
      .as(
        sql`UPDATE ${schema.machine} SET state = 'detached' WHERE state = 'starting' AND project_id = 'fake-project-no-exist' RETURNING id`,
      );

    // Does this compile?
    const insertQuery = db
      .with(detachCte)
      .insert(schema.machine)
      .values({
        id: "mach_test_cte_exploration",
        name: "cte-test",
        type: "fly",
        projectId: "fake-project-no-exist",
        state: "starting",
        externalId: "ext-cte-test",
      })
      .returning();

    // If we got here, it compiles! Let's check the SQL shape.
    const sqlStr = insertQuery.toSQL();
    expect(sqlStr.sql).toContain("with");
    expect(sqlStr.sql).toContain("detach");
    expect(sqlStr.sql).toContain("insert");

    // Don't actually run it — we just want to verify it compiles and produces the right SQL.
    // (The project_id doesn't exist so it would FK-fail anyway.)
  });

  test("approach 4: two mutation CTEs + select as main query", async () => {
    // What if both mutations are CTEs, and the main query is a select that joins them?
    // This is closer to what our outbox system does.
    const detachCte = db
      .$with("detach", {
        id: schema.machine.id,
      })
      .as(
        sql`UPDATE ${schema.machine} SET state = 'detached' WHERE state = 'active' AND project_id = 'fake-project-no-exist' RETURNING id`,
      );

    const promoteCte = db
      .$with("promote", {
        id: schema.machine.id,
      })
      .as(
        sql`UPDATE ${schema.machine} SET state = 'active' WHERE id = 'fake-machine-no-exist' RETURNING id`,
      );

    // Use both CTEs in the main query
    const query = db
      .with(detachCte, promoteCte)
      .select({
        detachedId: detachCte.id,
      })
      .from(detachCte);

    const sqlStr = query.toSQL();
    expect(sqlStr.sql).toContain("with");
    // Should have both CTEs
    expect(sqlStr.sql).toContain("detach");
    expect(sqlStr.sql).toContain("promote");
  });

  test("approach 5: actually run a CTE with side-effect update + typed insert returning", async () => {
    // This test actually executes against the DB to verify runtime behavior.
    // We'll use the event table since it's simpler and has no FK constraints that would block us.

    const nonce = `cte_test_${Date.now()}`;

    // Side-effect CTE: a no-op update that matches nothing (just proving it runs)
    const sideEffectCte = db
      .$with("side_effect", {
        id: schema.event.id,
      })
      .as(
        sql`UPDATE ${schema.event} SET payload = payload WHERE type = 'nonexistent-type-${sql.raw(nonce)}' RETURNING id`,
      );

    // Main query: insert a new event row and get it back typed
    const result = await db
      .with(sideEffectCte)
      .insert(schema.event)
      .values({
        type: `test:cte-exploration`,
        payload: { nonce, test: true },
        externalId: nonce,
      })
      .returning();

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("test:cte-exploration");
    expect(result[0]!.payload).toEqual({ nonce, test: true });
    // Verify the result is typed — these should autocomplete:
    expect(result[0]!.id).toBeDefined();
    expect(result[0]!.createdAt).toBeDefined();

    // Clean up
    await db.delete(schema.event).where(eq(schema.event.externalId, nonce));
  });

  test("approach 6: side-effect update CTE that actually mutates + typed insert", async () => {
    // Insert a "decoy" row, then use a CTE to update it as a side effect
    // while inserting a new row as the main query.
    const nonce = `cte_mutate_${Date.now()}`;

    // Insert decoy
    const [decoy] = await db
      .insert(schema.event)
      .values({
        type: "test:cte-decoy",
        payload: { status: "original", nonce },
        externalId: `${nonce}_decoy`,
      })
      .returning();

    // CTE updates the decoy, main query inserts a new row
    const updateCte = db
      .$with("update_decoy", {
        id: schema.event.id,
      })
      .as(
        sql`UPDATE ${schema.event} SET payload = '{"status": "updated"}'::jsonb WHERE id = ${decoy!.id} RETURNING id`,
      );

    const [inserted] = await db
      .with(updateCte)
      .insert(schema.event)
      .values({
        type: "test:cte-main",
        payload: { nonce },
        externalId: `${nonce}_main`,
      })
      .returning();

    expect(inserted!.type).toBe("test:cte-main");

    // Verify the side-effect CTE actually ran
    const updatedDecoy = await db.query.event.findFirst({
      where: eq(schema.event.id, decoy!.id),
    });
    expect(updatedDecoy!.payload).toEqual({ status: "updated" });

    // Clean up
    await db.delete(schema.event).where(eq(schema.event.externalId, `${nonce}_decoy`));
    await db.delete(schema.event).where(eq(schema.event.externalId, `${nonce}_main`));
  });
});
