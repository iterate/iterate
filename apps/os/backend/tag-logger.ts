import safeStringify from "safe-stringify";

const appStage = process.env.VITE_APP_STAGE || process.env.APP_STAGE;

/* eslint-disable no-console -- This is the logger wrapper, console usage is intentional */
export const logger = appStage?.match(/pro?d/)
  ? {
      debug: (...args: unknown[]) => console.info("[DEBUG]" + safeStringify(args)),
      info: (...args: unknown[]) => console.info("[INFO]" + safeStringify(args)),
      warn: (...args: unknown[]) => console.info("[WARN]" + safeStringify(args)),
      error: (...args: unknown[]) => console.info("[ERROR]" + safeStringify(args)),
    }
  : {
      debug: (...args: unknown[]) => console.debug(...args),
      info: (...args: unknown[]) => console.info(...args),
      warn: (...args: unknown[]) => console.warn(...args),
      error: (...args: unknown[]) => console.error(...args),
    };
