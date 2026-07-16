// Phone-runnable slice of the shared itx example catalogue
// (apps/os/src/itx/examples.ts — the same data that powers the web REPL's
// Examples panel). "Phone-runnable" means project-scoped (a project itx is
// what this app always holds — no session/agent context here) and
// executable via capabilityHost.runScript (see run-example.ts): no local JS
// eval on-device, so live-session-only entries (a real provideCapability
// object living in a browser tab) are excluded by construction, not by a
// maintained id list.

import { ITX_EXAMPLES, type ItxExample } from "../../../os/src/itx/examples.ts";

export function phoneRunnableExamples(): ItxExample[] {
  return ITX_EXAMPLES.filter(
    (example) => example.context === "project" && example.runtimes.includes("run-script"),
  );
}
