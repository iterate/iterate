interface Entry {
  message: string;
  name: string;
}

const entries: Entry[] = [];

function escapeHtml(value: string): string {
  const replacements: Record<string, string> = {
    '"': "&quot;",
    "&": "&amp;",
    "'": "&#39;",
    "<": "&lt;",
    ">": "&gt;",
  };
  return value.replace(/[&<>"']/g, (character) => replacements[character] ?? character);
}

function page(): string {
  const signatures =
    entries.length === 0
      ? "<p>Nobody has signed yet.</p>"
      : entries
          .toReversed()
          .map(
            (entry) =>
              `<article><h2>${escapeHtml(entry.name)}</h2><p>${escapeHtml(entry.message)}</p></article>`,
          )
          .join("");
  return `<!doctype html>
    <html lang="en">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Guestbook</title></head>
      <body>
        <main>
          <h1>Guestbook</h1>
          <form method="post" action="/sign">
            <label>Name <input name="name" required maxlength="80"></label>
            <label>Message <input name="message" required maxlength="500"></label>
            <button type="submit">Sign</button>
          </form>
          <section aria-label="Signatures">${signatures}</section>
        </main>
      </body>
    </html>`;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (request.method === "POST" && url.pathname === "/sign") {
      const data = await request.formData();
      const name = String(data.get("name") ?? "")
        .trim()
        .slice(0, 80);
      const message = String(data.get("message") ?? "")
        .trim()
        .slice(0, 500);
      if (name !== "" && message !== "") entries.push({ message, name });
      return Response.redirect(new URL("/", request.url), 303);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler;
