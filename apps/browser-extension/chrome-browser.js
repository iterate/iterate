// chrome-browser.js — what this Chrome lends to the project: an RpcTarget (capnweb passes it by
// reference, so `itx.chrome.openPage(...)` on the project's root context runs HERE) with one method.
import { RpcTarget } from "./capnweb.js";

export class ChromeBrowser extends RpcTarget {
  /** Open an http(s) page in a new active tab; answers the tab's id and the URL it opened. */
  async openPage(input) {
    if (!input || typeof input.url !== "string") throw new Error("openPage() takes { url }.");
    const target = new URL(input.url);
    if (target.protocol !== "http:" && target.protocol !== "https:")
      throw new Error("openPage() only accepts http and https URLs.");
    const tab = await chrome.tabs.create({ active: true, url: target.href });
    return { tabId: tab.id, url: target.href };
  }
}
