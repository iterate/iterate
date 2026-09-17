// The presence facet's modules (src/client/presence/, the e2e fixtures' demo processor; bundled by scripts/build.ts as
// presence-processor-source.js, gitignored); this declaration lets `tsc` and knip resolve the import
// without a build.
declare const presenceProcessorSource: { "cap.js": string };
export default presenceProcessorSource;
