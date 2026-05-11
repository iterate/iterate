/**
 * Serializable metadata that identifies an app.
 */
export interface AppManifest {
  packageName: string;
  version: string;
  slug: string;
  description: string;
}

/**
 * Runtime context shared by app-style runtimes.
 */
export interface AppContext<TManifest extends AppManifest = AppManifest, TConfig = unknown> {
  manifest: TManifest;
  config: TConfig;
  rawRequest?: Request;
}
