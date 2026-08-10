import { z } from "zod";

const OpenPageInput = z.strictObject({
  url: z.string().min(1),
});

export const browserCapability = {
  async openPage(input: unknown) {
    const { url } = OpenPageInput.parse(input);
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error("openPage() only accepts http and https URLs.");
    }

    const tab = await chrome.tabs.create({ active: true, url: target.href });
    if (tab.id === undefined) {
      throw new Error("Chrome opened the page without returning a tab ID.");
    }

    return { tabId: tab.id, url: target.href };
  },
};

export const browserCapabilityInstructions =
  "The user's live Chrome browser. Call itx.chrome.openPage({ url }) to open an http or https page in a new active tab.";

export const browserCapabilityTypes = `
export interface ChromeBrowser {
  openPage(input: { url: string }): Promise<{ tabId: number; url: string }>;
}
`;
