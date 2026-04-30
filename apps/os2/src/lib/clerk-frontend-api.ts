export function deriveClerkFrontendApiUrl(publishableKey: string) {
  const encoded = publishableKey.replace(/^pk_(?:test|live)_/, "");
  return `https://${atob(encoded).replace(/\$/, "")}`;
}
