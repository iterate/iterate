interface Todo {
  done: boolean;
  id: number;
  title: string;
}

const todos: Todo[] = [{ done: false, id: 1, title: "Ship a small Worker" }];
let nextId = 2;

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
  const items = todos
    .map(
      (todo) => `
        <li>
          <form method="post" action="/todos/${todo.id}/toggle">
            <button type="submit" aria-label="Toggle ${escapeHtml(todo.title)}">${todo.done ? "☑" : "☐"}</button>
            ${todo.done ? `<s>${escapeHtml(todo.title)}</s>` : escapeHtml(todo.title)}
          </form>
        </li>`,
    )
    .join("");
  return `<!doctype html>
    <html lang="en">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Todo</title></head>
      <body>
        <main>
          <h1>Todo</h1>
          <form method="post" action="/todos">
            <label>New todo <input name="title" required maxlength="200"></label>
            <button type="submit">Add</button>
          </form>
          <ul>${items}</ul>
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
    if (request.method === "POST" && url.pathname === "/todos") {
      const title = String((await request.formData()).get("title") ?? "")
        .trim()
        .slice(0, 200);
      if (title !== "") todos.push({ done: false, id: nextId++, title });
      return Response.redirect(new URL("/", request.url), 303);
    }
    const toggle = url.pathname.match(/^\/todos\/(\d+)\/toggle$/);
    if (request.method === "POST" && toggle) {
      const todo = todos.find((candidate) => candidate.id === Number(toggle[1]));
      if (todo) todo.done = !todo.done;
      return Response.redirect(new URL("/", request.url), 303);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler;
