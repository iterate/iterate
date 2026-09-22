// public/login.js — the sign-in page's script. /login.json (control-plane.ts) says who is signed in,
// whether a code is on its way (and to whom), what went wrong with the last post, and which
// sign-ins this deployment offers; this renders that. Signing in itself is plain form posts to
// /login — the email and the password; or the email, then the mailed code — or the link to
// /.auth/identity (Google); no script in the loop.
(async () => {
  const root = document.getElementById("login");
  const el = (tag, props, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined) continue;
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
    show(
      el("p", {
        role: "alert",
        "data-type": "error",
        text: error instanceof Error ? error.message : String(error),
      }),
    );
    return;
  }
  const alert = state.error
    ? el("p", { role: "alert", "data-type": "error", text: state.error })
    : null;
  const heading = document.querySelector("h1");
  if (state.signedInAs) {
    heading.textContent = "You’re signed in";
    // where to go: on to `next`, or — this page being its own destination — to the dash, where a
    // person's projects, organizations and sessions are (a deployment without one offers nothing)
    const onward =
      state.next !== "/login"
        ? el("a", { class: "button primary", href: state.next, text: "Continue" })
        : state.dash
          ? el("a", { class: "button primary", href: state.dash, text: "Go to the dash" })
          : null;
    show(
      el("p", {}, "Signed in as ", el("strong", { text: state.signedInAs }), "."),
      onward && el("p", {}, onward),
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
    heading.textContent = "Check your inbox";
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
  const emailField = () =>
    el(
      "label",
      {},
      "Email ",
      el("input", {
        type: "email",
        name: "email",
        value: state.email || "",
        autocomplete: "email",
        required: "",
        autofocus: options.length === 1 ? "" : undefined,
      }),
    );
  // ONE form for the email sign-ins: the email; the password beside it when this deployment has one
  // ("Sign in"); "Email me a code instead" when a code is offered too — a second submit of the SAME
  // form that drops the password field before it posts, so the server reads an email alone (a code
  // request), never a blank password (a wrong attempt). A code-only deployment shows the email and
  // Continue; a password-only one the email, the password and Sign in.
  if (state.password || state.emailSignIn) {
    const password = state.password
      ? el("input", {
          type: "password",
          name: "password",
          autocomplete: "current-password",
          required: "",
        })
      : null;
    const codeButton =
      state.emailSignIn && state.password
        ? el("button", {
            class: "quiet",
            type: "submit",
            formnovalidate: "",
            text: "Email me a code instead",
          })
        : null;
    if (codeButton && password)
      codeButton.addEventListener("click", () => {
        password.disabled = true; // a disabled field is not posted: this submit asks for a code
      });
    options.push(
      el(
        "form",
        { method: "post", action: "/login" },
        next(),
        emailField(),
        password && el("label", {}, "Password ", password),
        el("button", {
          class: "primary",
          type: "submit",
          text: state.password ? "Sign in" : "Continue",
        }),
        codeButton,
      ),
    );
  }
  if (state.google) {
    if (state.password || state.emailSignIn)
      options.push(el("div", { class: "login-divider", text: "or" }));
    options.push(
      el(
        "p",
        {},
        el(
          "a",
          { class: "button google-login", href: state.google },
          el("img", { src: "/google-logo.svg", alt: "", width: "20", height: "20" }),
          "Continue with Google",
        ),
      ),
    );
  }
  if (!state.password && !state.emailSignIn && !state.google)
    options.push(el("p", { text: "Sign-in is not configured for this deployment." }));
  show(...options);
})();
