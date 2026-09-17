// public/login.js — the sign-in page's script. /login.json (control-plane.ts) says who is signed in,
// whether a code is on its way (and to whom), what went wrong with the last post, and which
// sign-ins this deployment offers; this renders that. Signing in itself is plain form posts to
// /login — the email, then the code — or the link to /.auth/identity (Google); no script in the loop.
(async () => {
  const root = document.getElementById("login");
  const el = (tag, props, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else node.setAttribute(key, value);
    }
    node.append(...children.filter(Boolean));
    return node;
  };
  const show = (...nodes) => root.replaceChildren(...nodes.filter(Boolean));
  let state;
  try {
    const response = await fetch("/login.json" + location.search, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`Sign-in is unavailable (${response.status}).`);
    state = await response.json();
  } catch (error) {
    show(el("p", { role: "alert", text: error instanceof Error ? error.message : String(error) }));
    return;
  }
  const alert = state.error ? el("p", { role: "alert", text: state.error }) : null;
  if (state.signedInAs) {
    show(
      el("p", {}, "Signed in as ", el("strong", { text: state.signedInAs }), "."),
      // nowhere to continue to when this page is its own destination
      state.next === "/login"
        ? null
        : el("p", {}, el("a", { class: "button primary", href: state.next, text: "Continue" })),
      el(
        "form",
        { method: "post", action: state.switchAccount },
        el("button", { class: "quiet", type: "submit", text: "Switch account" }),
      ),
    );
    return;
  }
  const next = () => el("input", { type: "hidden", name: "next", value: state.next });
  if (state.codeSentTo) {
    show(
      alert,
      el("p", {}, "We sent a code to ", el("strong", { text: state.codeSentTo }), "."),
      el(
        "form",
        { method: "post", action: "/login" },
        next(),
        el(
          "label",
          {},
          "Code ",
          el("input", {
            type: "text",
            name: "code",
            inputmode: "numeric",
            autocomplete: "one-time-code",
            pattern: "[0-9]{6}",
            maxlength: "6",
            required: "",
            autofocus: "",
          }),
        ),
        el("button", { class: "primary", type: "submit", text: "Continue" }),
      ),
      el(
        "form",
        { method: "post", action: "/login" },
        next(),
        el("input", { type: "hidden", name: "restart", value: "1" }),
        el("button", { class: "quiet", type: "submit", text: "Use a different email" }),
      ),
    );
    return;
  }
  const options = [alert];
  if (state.emailSignIn)
    options.push(
      el(
        "form",
        { method: "post", action: "/login" },
        next(),
        el(
          "label",
          {},
          "Email ",
          el("input", {
            type: "email",
            name: "email",
            autocomplete: "email",
            required: "",
            autofocus: "",
          }),
        ),
        el("button", { class: "primary", type: "submit", text: "Continue" }),
      ),
    );
  if (state.google)
    options.push(
      el("p", {}, el("a", { class: "button", href: state.google, text: "Continue with Google" })),
    );
  if (!state.emailSignIn && !state.google)
    options.push(el("p", { text: "Sign-in is not configured for this deployment." }));
  show(...options);
})();
