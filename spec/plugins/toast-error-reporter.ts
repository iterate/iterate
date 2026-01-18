import type { Plugin } from "../playwright-plugin.ts";

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
        // Check for error toasts
        const toasts = page.locator(selector);
        const count = await toasts.count();

        const messages: string[] = [];
        for (let i = 0; i < count; i++) {
          const text = await toasts
            .nth(i)
            .textContent()
            .catch(() => null);
          if (text) messages.push(text.trim());
        }

        if (messages.length > 0 && error instanceof Error) {
          const toastInfo = messages.map((m) => `  🍞 ${m}`).join("\n");
          error.message = `${error.message}\n\x1b[31mError toast(s) visible:\n${toastInfo}\x1b[0m`;
        }

        throw error;
      }
    },
  };
};
