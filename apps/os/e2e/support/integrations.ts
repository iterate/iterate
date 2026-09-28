// e2e/support/integrations.ts — connecting a project to one of the pet shop's fake providers the way
// a person does: the project facet's connect, the provider's page, and the platform's callback, which
// only a signed-in project member completes.
import { expect } from "vitest";
import { adminCredentials, openItx, workerUrl } from "./client.ts";
import { petshopBaseUrl } from "./petshop.ts";
import { oauthSession } from "./principal.ts";
import { freshDnsSafeProjectSlug, registerProject } from "./project-host.ts";

/** A catalogued project with a member, and that member's OAuth bearer (the operator's bearer is
 *  `/api`'s alone, so it completes no consent). */
export async function projectWithMember(prefix: string) {
  const slug = freshDnsSafeProjectSlug(prefix);
  const member = { email: `${slug}@example.com` };
  const projectId = await registerProject(slug, member);
  return {
    projectId,
    itx: openItx(projectId),
    memberBearer: (await oauthSession(projectId, member)).token as string,
  };
}

/** Connect, pass `choices` to the provider's page (the account a person would pick), and follow its
 *  redirect to the platform's callback: refused anonymously and to the operator, finished for the
 *  member, who lands on `next`. False when the provider is not the pet shop (a deployment whose
 *  iterate apps are real). */
export async function connectThroughProvider(
  itx: any,
  input: { provider: string; connection: string; client: "iterate" | "project" },
  choices: Record<string, string>,
  memberBearer: string,
): Promise<boolean> {
  let authorizationUrl: string;
  try {
    ({ authorizationUrl } = await itx.facets
      .get("project")
      .connectIntegration({ ...input, next: workerUrl("/") }));
  } catch (error) {
    if (String(error).includes("This deployment has no")) return false;
    throw error;
  }
  const page = new URL(authorizationUrl);
  if (page.origin !== petshopBaseUrl()) return false;
  for (const [key, value] of Object.entries(choices)) page.searchParams.set(key, value);
  const provider = await fetch(page, { redirect: "manual" });
  expect(provider, await provider.clone().text()).toMatchObject({ status: 302 });
  const callback = provider.headers.get("location")!;
  expect(await fetch(callback, { redirect: "manual" })).toMatchObject({ status: 401 });
  const operator = { authorization: `Bearer ${adminCredentials().secret}` };
  expect(await fetch(callback, { redirect: "manual", headers: operator })).toMatchObject({
    status: 401,
  });
  const done = await fetch(callback, {
    redirect: "manual",
    headers: { authorization: `Bearer ${memberBearer}` },
  });
  expect(done, await done.clone().text()).toMatchObject({ status: 303 });
  expect(done.headers.get("location")).toBe(workerUrl("/"));
  return true;
}

/** The project's connections, as its root records them (`state.integrations`). */
export async function integrationRows(itx: any) {
  return (await itx.facets.get("project").snapshot()).state.integrations;
}
