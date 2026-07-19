import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const DEVICE_ID_KEY = "iterate.mobileDeviceId.v1";
const LEGACY_LOCATION_DEVICE_ID_KEY = "iterate.locationReminderDeviceId.v1";
let deviceIdPromise: Promise<string> | null = null;

export async function getMobileDeviceId(): Promise<string> {
  if (deviceIdPromise) return deviceIdPromise;
  const loading = (async () => {
    const existing =
      (await SecureStore.getItemAsync(DEVICE_ID_KEY)) ||
      (await SecureStore.getItemAsync(LEGACY_LOCATION_DEVICE_ID_KEY));
    if (existing) return existing;
    const created = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_ID_KEY, created);
    return created;
  })().catch((error) => {
    if (deviceIdPromise === loading) deviceIdPromise = null;
    throw error;
  });
  deviceIdPromise = loading;
  return loading;
}
