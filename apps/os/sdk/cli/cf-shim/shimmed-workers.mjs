// This is a file that will be loaded in place of cloudflare:workers when running the CLI.
export const env = process.env;
export const waitUntil = (promise) => void promise;
export class DurableObject {
  constructor() {
    throw new Error(`DurableObject should not be instantiated in the CLI`);
  }
}
