// Intent: the itx you get is scoped to the projects your token grants. A
// principal can open its own projects (and shared ones), and is REFUSED projects
// it has no access to; no token is refused entirely. A scoped itx then works
// normally within its project.
//
//   npm run dev
//   node --experimental-strip-types steps/08-auth/intent.test.ts

import { connect } from "../../client-lib.ts";

const WS = (process.env.ITX_BASE ?? "http://127.0.0.1:8787").replace(/^http/, "ws");
const url = (project: string) => `${WS}/steps/08-auth?project=${encodeURIComponent(project)}`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

interface ItxCore {
  list(): Promise<string[]>;
  provideCapability(path: string[], capability: any): Promise<any>;
  invoke(path: string[], args: unknown[]): Promise<any>;
}

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

// Try to open a scoped itx and make one call. Resolves true if it works, false
// if the connection is refused (401/403 → the WS upgrade fails → the call errors).
async function canOpen(token: string | null, project: string): Promise<boolean> {
  try {
    using itx = connect<ItxCore>(url(project), token ? bearer(token) : undefined);
    await Promise.race([
      itx.list(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  check("alice opens her own project", await canOpen("alice-token", "alice"));
  check("alice opens the shared project", await canOpen("alice-token", "shared"));
  check("alice is REFUSED bob's project", !(await canOpen("alice-token", "bob")));
  check("bob opens his own project", await canOpen("bob-token", "bob"));
  check("bob is REFUSED alice's project", !(await canOpen("bob-token", "alice")));
  check("no token is refused", !(await canOpen(null, "shared")));

  // A scoped itx works normally within its project.
  try {
    using itx = connect<ItxCore>(url("alice"), bearer("alice-token"));
    await itx.provideCapability(["ping"], (async () => "pong") as any);
    check(
      "a scoped itx provides + invokes within its project",
      (await itx.invoke(["ping"], [])) === "pong",
    );
  } catch (e) {
    check("a scoped itx provides + invokes within its project", false, (e as Error).message);
  }

  console.log(`\n${failures === 0 ? "step 08 intent OK" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("intent test crashed:", e);
  process.exit(1);
});
