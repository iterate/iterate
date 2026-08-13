import { slugify } from "@iterate-com/shared/slugify";
import type { TestInfo } from "@playwright/test";
import type { Plugin } from "middlewright";

const ENVIRONMENT_VARIABLE = "PLAYWRIGHT_SCREENSHOT";
const occurrencesByTest = new WeakMap<TestInfo, Map<string, number>>();

export const screenshot = (): Plugin => {
  const matchers = parseMatchers(process.env[ENVIRONMENT_VARIABLE] || "");

  if (!matchers.length || process.env.PWDEBUG) return { name: "screenshot" };

  return {
    name: "screenshot",
    middleware: async (context, next) => {
      const locatorDescription = context.locator.toString();
      const matches = matchers.some((matcher) => matcher.test(locatorDescription));
      const result = await next();

      if (matches) {
        const occurrences = occurrencesByTest.get(context.testInfo) || new Map<string, number>();
        occurrencesByTest.set(context.testInfo, occurrences);
        const locatorSlug = slugify(locatorDescription, { maxLength: 160 });
        const occurrence = (occurrences.get(locatorSlug) || 0) + 1;
        occurrences.set(locatorSlug, occurrence);
        const screenshotSlug = occurrence === 1 ? locatorSlug : `${locatorSlug}-${occurrence}`;
        const path = context.testInfo.outputPath(`${screenshotSlug}.png`);
        await context.page.screenshot({ fullPage: true, path });
        await context.testInfo.attach(screenshotSlug, { contentType: "image/png", path });
      }

      return result;
    },
  };
};

const parseMatchers = (value: string) =>
  value
    .split(";")
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map((pattern, index) => {
      try {
        return new RegExp(pattern);
      } catch (error) {
        throw new Error(
          `Invalid ${ENVIRONMENT_VARIABLE} regex at position ${index + 1}: ${pattern}`,
          { cause: error },
        );
      }
    });
