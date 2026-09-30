// apps/os's generated modules (its scripts/build.ts), which the apps/os source the suites import
// reads. `pnpm e2e` builds the whole worker before vitest starts; `e2e:run` against a deployment
// builds nothing else.
import { build } from "../apps/os/scripts/build.ts";

export default async function setup(): Promise<void> {
  await build();
}
