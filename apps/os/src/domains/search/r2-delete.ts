/**
 * Delete one R2 object without issuing a delete for an expected missing key.
 *
 * The Workers R2 binding treats delete as idempotent from application code,
 * but Cloudflare Observability still records an internal error span (10007)
 * when the key is absent. Expected absence must not pollute the error signal,
 * so callers first turn it into the explicitly modelled `head() === null`
 * outcome. Real HEAD or DELETE failures still reject unchanged.
 */
export async function deleteR2ObjectIfPresent(
  bucket: {
    delete(key: string): Promise<void>;
    head(key: string): Promise<unknown | null>;
  },
  key: string,
): Promise<boolean> {
  if ((await bucket.head(key)) === null) return false;
  await bucket.delete(key);
  return true;
}
