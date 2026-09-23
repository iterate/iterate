/** A text file imported as its source (vite's `?raw`, what the workers lane bundles with): the
 *  agents app's revive rows (../agents/__workers-tests__) seed the with-agents config worker from
 *  configs-next this way — the tests tsconfig typechecks that tree from here. */
declare module "*?raw" {
  const source: string;
  export default source;
}
