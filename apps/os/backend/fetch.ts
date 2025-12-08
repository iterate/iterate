/** wrapped fetch impl that we'll put stuff in 🔜 */
export const fetch = (url: string | URL, options?: RequestInit) => {
  return globalThis.fetch(url, options);
};
