// on-behalf-of.ts — WHO A SCRIPT RUNS FOR. A run (`itx/run-requested`) is executed as the kernel:
// loaded code speaks for the project, and the request event names who asked (iterate-context-
// durable-object.ts `#executeRun`). So what the script writes would be nobody's. The runner signs the
// requester into the run's cause (`Cause.onBehalfOf`), which rides the script's calls unread, as the
// rest of a cause does, and every append verifies it into `source.onBehalfOf` (context/built-ins.ts).
//
// ATTRIBUTION, NOT AUTHORITY: the script still calls as loaded code (`principal: null, app: true`),
// and `source.principal` keeps meaning "this principal's authority made the call". SIGNED because a
// cause is anyone's to write (cause.ts: "forging it can only make the forger's own request deeper"),
// and a name is worth forging. Scoped to the project and the run, and expiring once the run's
// deadline has passed, so a token a script leaks names nobody for long. Never stored: an event keeps
// what the token proves, `{ principal, grant, run }`, never the token.
import type { Principal } from "iterate/principal";
import { RUN_DEADLINE_MS } from "iterate/stream/run";
import { z } from "zod";
import { signClaims, verifyClaims } from "./caller.ts";

/** Who a script's writes are for: the person who asked for the run, the grant they asked through,
 *  and the request itself (`<path>@<offset>`). */
export type OnBehalfOf = { principal: Principal; grant?: string; run: string };

const Claims = z.object({
  onBehalfOf: z.object({
    principal: z.object({
      actor: z.string(),
      email: z.string().optional(),
      impersonatedBy: z.object({ actor: z.string(), email: z.string() }).optional(),
    }),
    grant: z.string().optional(),
    run: z.string(),
  }),
  project: z.string(),
  expiresAt: z.number(),
});

/** The token the runner puts in a run's cause: `onBehalfOf` for `project`, until a minute past
 *  the run's deadline. */
export function mintOnBehalfOf(
  onBehalfOf: OnBehalfOf,
  project: string,
  secret: string,
  now: number,
): Promise<string> {
  return signClaims({ onBehalfOf, project, expiresAt: now + RUN_DEADLINE_MS + 60_000 }, secret);
}

/** What a cause's token proves, for a write in `project` at `now`; nothing for a missing, forged,
 *  expired or other project's token, which are all the same answer: the write is the project's. */
export async function verifyOnBehalfOf(
  token: string | undefined,
  project: string,
  secret: string,
  now: number,
): Promise<OnBehalfOf | undefined> {
  if (!token) return undefined;
  const claims = Claims.safeParse(await verifyClaims(token, secret));
  if (!claims.success || claims.data.project !== project || claims.data.expiresAt < now)
    return undefined;
  return claims.data.onBehalfOf;
}
