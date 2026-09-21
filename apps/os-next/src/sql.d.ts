/** A `.sql` file imported as its text — wrangler `rules` of type Text on the `.sql` glob in
 *  wrangler.base.jsonc and wrangler.test.jsonc: control-plane.sql, applied at boot (directory.ts
 *  `ensureDirectorySchema`). */
declare module "*.sql" {
  const text: string;
  export default text;
}
