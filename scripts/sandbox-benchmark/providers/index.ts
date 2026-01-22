/**
 * Provider factory and exports
 */

import type { ProviderName } from "../config.ts";
import type { SandboxProvider } from "./types.ts";
import { DaytonaProvider } from "./daytona.ts";
import { E2BProvider } from "./e2b.ts";
import { FlyProvider } from "./fly.ts";

export type {
  SandboxProvider,
  SandboxHandle,
  CreateSandboxOptions,
  BootCallback,
} from "./types.ts";

// Cached provider instances
const providers = new Map<ProviderName, SandboxProvider>();

export function getProvider(name: ProviderName): SandboxProvider {
  let provider = providers.get(name);
  if (!provider) {
    switch (name) {
      case "daytona":
        provider = new DaytonaProvider();
        break;
      case "e2b":
        provider = new E2BProvider();
        break;
      case "fly":
        provider = new FlyProvider();
        break;
      default:
        throw new Error(`Unknown provider: ${name}`);
    }
    providers.set(name, provider);
  }
  return provider;
}
