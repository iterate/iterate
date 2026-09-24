// `withItx` alone, bundled for an `itx.run` script's isolate — written by scripts/build.ts as
// with-itx-module.js (gitignored); this declaration lets `tsc` and knip resolve the import without it.
declare const withItxModule: string;
export default withItxModule;
