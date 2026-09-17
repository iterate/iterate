// public/login.js — the sign-in page's script. /login.json (control-plane.ts) says who is signed in
// and which sign-ins this deployment offers; this renders that. Signing in itself is a plain form
// post to /login (the email door) or a link to /.auth/identity (Google) — no script in the loop.
(async () => {
  const root = document.getElementById("login");
  const el = (tag, props, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  };
  const show = (...nodes) => root.replaceChildren(...nodes);
  let state;
  try {
    const response = await fetch("/login.json" + location.search, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`Sign-in is unavailable (${response.status}).`);
    state = await response.json();
  } catch (error) {
    show(el("p", { role: "alert", text: error instanceof Error ? error.message : String(error) }));
    return;
  }
  if (state.signedInAs) {
    show(
      el("p", {}, "Signed in as ", el("strong", { text: state.signedInAs }), "."),
      el("p", {}, el("a", { href: state.next, text: `Continue as ${state.signedInAs}` })),
      el(
        "form",
        { method: "post", action: state.switchAccount },
        el("button", { type: "submit", text: "Switch account" }),
      ),
    );
    return;
  }
  const options = [];
  if (state.emailSignIn)
    options.push(
      el(
        "form",
        { method: "post", action: "/login" },
        el("input", { type: "hidden", name: "next", value: state.next }),
        el(
          "label",
          {},
          "Email ",
          el("input", {
            type: "email",
            name: "email",
            placeholder: "you@example.com",
            required: "",
          }),
        ),
        el("button", { type: "submit", text: "Continue" }),
        el("p", { class: "muted", text: "Test sign-in: use any email. No verification." }),
      ),
    );
  if (state.google)
    options.push(el("p", {}, el("a", { href: state.google, text: "Continue with Google" })));
  if (!options.length)
    options.push(el("p", { text: "Sign-in is not configured for this deployment." }));
  show(...options);
})();
