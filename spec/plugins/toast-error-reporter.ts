import type { Plugin } from "../playwright-plugin.ts";
import { adjustError } from "../playwright-plugin.ts";

export type ToastErrorReporterOptions = {
  /** Selector for error toasts. Default: '[data-sonner-toast][data-type="error"]' */
  selector?: string;
};

/**
 * When a locator action fails, checks for visible error toasts and appends
 * their text to the error message for easier debugging.
 */
export const toastErrorReporter = (options: ToastErrorReporterOptions = {}): Plugin => {
  const selector = options.selector ?? '[data-sonner-toast][data-type="error"]';

  return {
    name: "toast-error-reporter",

    middleware: async ({ page }, next) => {
      try {
        return await next();
      } catch (error) {
        const getToastErrors = () => page.locator(selector).allTextContents();
        const messages = await getToastErrors().catch(() => []);

        if (messages.length > 0 && error instanceof Error) {
          const info = [`Error toast(s) visible:`, ...messages.map((m) => `🍞 ${m.trim()}`)];
          adjustError(error, info, import.meta.filename, { color: 31 });
        }

        throw error;
      }
    },
  };
};
