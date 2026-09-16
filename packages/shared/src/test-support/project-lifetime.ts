import { Lifetime } from "../lifetime.ts";

/** Test-created projects use the same creation metadata available to any caller. */
export function testProjectMetadata(): { lifetime?: Lifetime } {
  const raw = process.env.TEST_PROJECT_LIFETIME;
  return raw ? { lifetime: Lifetime.parse(JSON.parse(raw)) } : {};
}

/** The playground has arbitrary project namespaces rather than Auth projects. */
export function testStreamProjectId(): string {
  const group = testProjectMetadata().lifetime?.group;
  return group ? `ephemeral-${group.replaceAll("/", "-")}` : "default";
}
