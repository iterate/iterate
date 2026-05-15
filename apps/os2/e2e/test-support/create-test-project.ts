import {
  createAdminOs2Client,
  requireBaseUrl,
  type Os2Client,
  uniqueSuffix,
} from "./os2-client.ts";

type TestProject = Awaited<ReturnType<Os2Client["projects"]["create"]>>;

export interface TestProjectHandle extends AsyncDisposable {
  baseUrl: string;
  client: Os2Client;
  project: TestProject;
  updateConfig(input: {
    customHostname?: string | null;
    externalEgressProxyUrl?: string | null;
  }): Promise<TestProject>;
}

export async function createTestProject(opts?: {
  baseUrl?: string;
  cleanup?: boolean;
  customHostname?: string | null;
  externalEgressProxyUrl?: string | null;
  slugPrefix?: string;
}): Promise<TestProjectHandle> {
  const baseUrl = opts?.baseUrl ?? requireBaseUrl();
  const client = createAdminOs2Client(baseUrl);
  const slugPrefix = opts?.slugPrefix ?? "os2-e2e";
  let project = await client.projects.create({
    slug: `${slugPrefix}-${uniqueSuffix()}`,
  });

  if (opts?.customHostname !== undefined || opts?.externalEgressProxyUrl !== undefined) {
    project = await client.projects.updateConfig({
      id: project.id,
      customHostname: opts.customHostname,
      externalEgressProxyUrl: opts.externalEgressProxyUrl,
    });
  }

  let disposed = false;
  return {
    baseUrl,
    client,
    get project() {
      return project;
    },
    async updateConfig(input) {
      project = await client.projects.updateConfig({
        id: project.id,
        customHostname: input.customHostname,
        externalEgressProxyUrl: input.externalEgressProxyUrl,
      });
      return project;
    },
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      disposed = true;
      if (opts?.cleanup === false) return;
      await client.projects.remove({ id: project.id }).catch(() => undefined);
    },
  };
}
