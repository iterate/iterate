import type { DeviceConfiguration } from "../firmware/config-image.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export interface DeviceE2eProvisioning {
  baseUrl?: string;
  environment: {
    ITERATE_KIT_PROJECT_API_KEY: string;
    ITERATE_KIT_PROJECT_ID: string;
    ITERATE_KIT_WIFI_PASSWORD?: string;
    ITERATE_KIT_WIFI_SSID?: string;
  };
}

/**
 * Resolves the credentials shared by the physical device and its local peer.
 *
 * In flash mode the host is about to replace the raw configuration partition,
 * so caller-supplied values (or newly generated local project credentials) are
 * authoritative. In no-flash mode the direction reverses: the bytes already
 * on the device are authoritative. Generating another local key in that mode
 * creates a particularly misleading failure in which Wi-Fi and TLS work but
 * every Cap'n Web mount is rejected.
 */
export function resolveDeviceE2eProvisioning(options: {
  environment: Environment;
  existingConfiguration?: DeviceConfiguration;
  flash: boolean;
  generateProjectApiKey(): string;
  generateProjectId(): string;
}): DeviceE2eProvisioning {
  if (!options.flash) {
    if (!options.existingConfiguration) {
      throw new Error("A no-flash device proof requires its existing provisioning partition.");
    }
    if (
      options.environment.ITERATE_KIT_PROJECT_API_KEY !== undefined &&
      options.environment.ITERATE_KIT_PROJECT_API_KEY !==
        options.existingConfiguration.iterate.projectApiKey
    ) {
      throw new Error(
        "The requested project API key differs from the no-flash device provisioning.",
      );
    }
    if (
      options.environment.ITERATE_KIT_PROJECT_ID !== undefined &&
      options.environment.ITERATE_KIT_PROJECT_ID !== options.existingConfiguration.iterate.projectId
    ) {
      throw new Error("The requested project ID differs from the no-flash device provisioning.");
    }
    if (
      options.environment.ITERATE_KIT_WIFI_PASSWORD !== undefined &&
      options.environment.ITERATE_KIT_WIFI_PASSWORD !== options.existingConfiguration.wifi.password
    ) {
      throw new Error(
        "The requested Wi-Fi password differs from the no-flash device provisioning.",
      );
    }
    if (
      options.environment.ITERATE_KIT_WIFI_SSID !== undefined &&
      options.environment.ITERATE_KIT_WIFI_SSID !== options.existingConfiguration.wifi.ssid
    ) {
      throw new Error("The requested Wi-Fi network differs from the no-flash device provisioning.");
    }
    return {
      baseUrl: options.existingConfiguration.iterate.baseUrl,
      environment: {
        ITERATE_KIT_PROJECT_API_KEY: options.existingConfiguration.iterate.projectApiKey,
        ITERATE_KIT_PROJECT_ID: options.existingConfiguration.iterate.projectId,
        ITERATE_KIT_WIFI_PASSWORD: options.existingConfiguration.wifi.password,
        ITERATE_KIT_WIFI_SSID: options.existingConfiguration.wifi.ssid,
      },
    };
  }

  return {
    environment: {
      ITERATE_KIT_PROJECT_API_KEY:
        options.environment.ITERATE_KIT_PROJECT_API_KEY ?? options.generateProjectApiKey(),
      ITERATE_KIT_PROJECT_ID:
        options.environment.ITERATE_KIT_PROJECT_ID ?? options.generateProjectId(),
      ITERATE_KIT_WIFI_PASSWORD:
        options.environment.ITERATE_KIT_WIFI_PASSWORD ??
        options.existingConfiguration?.wifi.password,
      ITERATE_KIT_WIFI_SSID:
        options.environment.ITERATE_KIT_WIFI_SSID ?? options.existingConfiguration?.wifi.ssid,
    },
  };
}
