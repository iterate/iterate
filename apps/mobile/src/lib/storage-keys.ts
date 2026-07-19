export function lastProjectStorageKey(baseUrl: string, auth: { clientId: string; issuer: string }) {
  return `iterate.lastProject.${storageSegment(baseUrl)}.${storageSegment(auth.issuer)}.${storageSegment(auth.clientId)}`;
}

function storageSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9]+/g, "_");
}
