/** Every app's root route `head`: its title, its stylesheet (a `?url` import) and, when it has
 *  one, its description. */
export function appHead(page: { title: string; stylesheet: string; description?: string }) {
  return {
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      ...(page.description ? [{ name: "description", content: page.description }] : []),
      { title: page.title },
    ],
    links: [{ rel: "stylesheet", href: page.stylesheet }],
  };
}
