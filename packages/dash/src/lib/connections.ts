/** A new integration connection's name: short and random. It names the connection's secret
 *  (`/secrets/<provider>-<name>`) and a project app's webhook URL for life. */
export function freshConnectionName() {
  return crypto.randomUUID().slice(0, 8);
}
