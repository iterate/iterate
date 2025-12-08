/** wrapped fetch impl that we'll put stuff in 🔜 */
export const fetch: typeof globalThis.fetch = (input, init) => {
  return globalThis.fetch(input, init);
};
