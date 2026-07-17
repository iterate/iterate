// Preserve the browser import while the experimental server host exercises
// the same contract. This does not commit the UI to a server-side cutover.
export { StreamFeedContract as BrowserFeedContract } from "../../../feed/contract.ts";
