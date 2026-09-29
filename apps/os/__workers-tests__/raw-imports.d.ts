/** A text file imported as its source (vite's `?raw`, what the Workers suite bundles with): the
 *  agents app's rows (../agents) read the agents package's source files from
 *  packages/agents this way (e2e/agents-source.ts): the tests tsconfig typechecks them from here. */
declare module "*?raw" {
  const source: string;
  export default source;
}
