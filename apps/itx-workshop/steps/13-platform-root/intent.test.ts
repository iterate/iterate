// Intent: the platform capability root — a STATELESS, read-only context at the
// root of the chain. It is not a Durable Object and not a StreamProcessor; it is
// constructed in code and answers the same itx protocol. It serves the project
// CATALOG as capabilities (projects.list / projects.get), it is the parent a
// project context resolves against on a miss, and it is read-only: you cannot
// provide into it (it has no log), and it has no parent of its own.
//
//   npm run dev
//   node --experimental-strip-types steps/13-platform-root/intent.test.ts

import { connect } from "../../client-lib.ts";

const WS = (process.env.ITX_BASE ?? "http://127.0.0.1:8787").replace(/^http/, "ws");
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const rootUrl = `${WS}/steps/13-platform-root`;
const projectUrl = `${WS}/steps/11-chain?project=alice`;

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};
/** Resolves true iff `fn` rejects — the call was refused, as it should be. */
async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function main() {
  // The global root, scoped to alice's access (she reaches "alice" + "shared").
  using root = connect<any>(rootUrl, bearer("alice-token"));

  // CATALOG: a project-agnostic capability on the root. list() the projects you
  // can reach; get(id) narrows into one (here, to its context ref).
  const list = await root.projects.list();
  check(
    "projects.list() returns the principal's accessible projects",
    Array.isArray(list) &&
      list.includes("alice") &&
      list.includes("shared") &&
      !list.includes("bob"),
    JSON.stringify(list),
  );

  const got = await root.projects.get("alice");
  check("projects.get(id) narrows to a project ref", got?.ref === "prj:alice", JSON.stringify(got));

  check(
    "projects.get(id) refuses a project outside your access",
    await rejects(() => root.projects.get("bob")),
  );

  // READ-ONLY: you cannot provide into the root — it has no log to append to.
  check(
    "provideCapability into the root throws (it is stateless / read-only)",
    await rejects(() =>
      root.provideCapability({ path: ["x"], capability: (async () => 1) as any }),
    ),
  );

  // CHAIN ROOT: a PROJECT context resolves against the global root on a miss, so
  // the catalog is reachable from inside a project too (the chain bottoms out here).
  using project = connect<any>(projectUrl, bearer("alice-token"));
  const fromProject = await project.invokeCapability(["projects", "list"]);
  check(
    "a project context resolves against the global root on a miss (chain bottoms out at global)",
    Array.isArray(fromProject) && fromProject.includes("alice"),
    JSON.stringify(fromProject),
  );

  console.log(`\n${failures === 0 ? "step 13 intent OK" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("intent test crashed:", e);
  process.exit(1);
});
