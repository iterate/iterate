import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { fakeEventsService } from "../fake-events-service.ts";
import {
  type AnyDeployment,
  parseDeploymentConfig,
  parseDeploymentLocator,
} from "./deployment-provider-factory.ts";

export class DeploymentRuntimeRegistry {
  private readonly deployments = new Map<string, AnyDeployment>();
  private hydrationPromise: Promise<void> | null = null;
  private readonly inFlightHydrations = new Map<string, Promise<AnyDeployment | null>>();

  constructor(
    private readonly loadRows: () => Array<typeof schema.deploymentsTable.$inferSelect> = () =>
      db.select().from(schema.deploymentsTable).all(),
  ) {}

  /**
   * Returns the live deployment instance for a slug if one already exists in
   * the in-memory registry.
   */
  get(slug: string): AnyDeployment | undefined {
    return this.deployments.get(slug);
  }

  set(params: { slug: string; deployment: AnyDeployment }): AnyDeployment {
    this.deployments.set(params.slug, params.deployment);
    return params.deployment;
  }

  list(): AnyDeployment[] {
    return [...this.deployments.values()];
  }

  delete(slug: string): void {
    this.deployments.delete(slug);
  }

  async ensureHydrated(): Promise<void> {
    this.hydrationPromise ??= this.hydrateAll();
    await this.hydrationPromise;
  }

  /**
   * Rehydrates one deployment object from a sqlite row.
   *
   * If the row already has a saved locator, this reconnects the in-memory
   * deployment object immediately.
   */
  async hydrateFromRow(
    row: typeof schema.deploymentsTable.$inferSelect,
  ): Promise<AnyDeployment | null> {
    const existing = this.get(row.slug);
    if (existing) {
      await fakeEventsService.ensureSubscribed({ slug: row.slug, deployment: existing });
      return existing;
    }

    const inFlight = this.inFlightHydrations.get(row.slug);
    if (inFlight) {
      return await inFlight;
    }

    const hydration = this.hydrateKnownProviderRow(row).finally(() => {
      this.inFlightHydrations.delete(row.slug);
    });
    this.inFlightHydrations.set(row.slug, hydration);
    return await hydration;
  }

  private async hydrateAll(): Promise<void> {
    const rows = this.loadRows();
    for (const row of rows) {
      await this.hydrateFromRow(row).catch((error) => {
        console.warn(
          `[deployment-registry] failed to hydrate ${row.slug}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  private async hydrateKnownProviderRow(
    row: typeof schema.deploymentsTable.$inferSelect,
  ): Promise<AnyDeployment | null> {
    if (row.provider === "docker") {
      const config = parseDeploymentConfig({
        provider: "docker",
        opts: row.opts,
      });
      const locator = row.deploymentLocator
        ? parseDeploymentLocator({
            provider: "docker",
            locator: row.deploymentLocator,
          })
        : null;
      if (!locator) {
        return null;
      }
      const deployment = await Deployment.connect({
        provider: config.provider,
        locator,
      }).catch(() => null);
      if (!deployment) {
        return null;
      }
      this.set({ slug: row.slug, deployment });
      await fakeEventsService.ensureSubscribed({ slug: row.slug, deployment });
      return deployment;
    }

    const config = parseDeploymentConfig({
      provider: "fly",
      opts: row.opts,
    });
    const locator = row.deploymentLocator
      ? parseDeploymentLocator({
          provider: "fly",
          locator: row.deploymentLocator,
        })
      : null;
    if (!locator) {
      return null;
    }
    const deployment = await Deployment.connect({
      provider: config.provider,
      locator,
    }).catch(() => null);
    if (!deployment) {
      return null;
    }
    this.set({ slug: row.slug, deployment });
    await fakeEventsService.ensureSubscribed({ slug: row.slug, deployment });
    return deployment;
  }
}

export const deploymentRuntimeRegistry = new DeploymentRuntimeRegistry();
