// The app's ONE doorway to secure key-value storage. Native re-exports
// expo-secure-store untouched (Keychain, Face ID on authenticated reads). Web
// gets a dev/spec-grade stand-in — expo-secure-store's web build is an EMPTY
// module, so without this every SecureStore-backed feature is dead in a
// browser: localStorage holds the values, and a read with
// `requireAuthentication` first asks `window.confirm(authenticationPrompt)`,
// the Face ID stand-in a playwright spec (or a human dev) answers. This is
// deliberately NOT secure — the web build exists for review, specs, and dev,
// never as a real approver surface; iOS behavior is byte-identical to before.

import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

export type SecureStoreOptions = {
  requireAuthentication?: boolean;
  authenticationPrompt?: string;
};

const WEB_PREFIX = "iterate.secure-store.";

export async function getItemAsync(
  key: string,
  options: SecureStoreOptions = {},
): Promise<string | null> {
  if (Platform.OS !== "web") return SecureStore.getItemAsync(key, options);
  const value = localStorage.getItem(WEB_PREFIX + key);
  if (value !== null && options.requireAuthentication) {
    const approved = window.confirm(options.authenticationPrompt || "Unlock secure storage?");
    if (!approved) throw new Error("Authentication was cancelled.");
  }
  return value;
}

export async function setItemAsync(
  key: string,
  value: string,
  options: SecureStoreOptions = {},
): Promise<void> {
  if (Platform.OS !== "web") return SecureStore.setItemAsync(key, value, options);
  localStorage.setItem(WEB_PREFIX + key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  if (Platform.OS !== "web") return SecureStore.deleteItemAsync(key);
  localStorage.removeItem(WEB_PREFIX + key);
}
