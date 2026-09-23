// public/login.js — the sign-in page's script. /login.json (issuer-pages.ts) says who is signed in,
// whether a code is on its way (and to whom), what went wrong with the last post, and which
// sign-ins this deployment offers; this renders that. Signing in itself is plain form posts to
// /login — the email and the password; or the email, then the mailed code — or the link to
// the configured identity provider (Google or Cloudflare); no script in the redirect flow.
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
  const providers = [
    { name: "Google", href: state.google, logo: "/google-logo.svg" },
    { name: "Cloudflare", href: state.cloudflare, logo: "/cloudflare-logo.svg" },
  ].filter((provider) => provider.href);
  const alternatives = providers.length
    ? [
        (state.password || state.emailSignIn || state.codeSentTo) &&
          el("div", { class: "login-divider", text: "or continue with" }),
        el(
          "div",
          { class: "login-providers" },
          ...providers.map((provider) =>
            el(
              "a",
              {
                class: "button provider-login",
                href: provider.href,
                "aria-label": `Continue with ${provider.name}`,
              },
              el("img", { src: provider.logo, alt: "", width: "20", height: "20" }),
              provider.name,
            ),
          ),
        ),
      ]
    : [];
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
      ...alternatives,
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
  if (state.password || state.emailSignIn) {
    let usePassword = state.password && (!state.emailSignIn || state.passwordSelected);
    const email = emailField();
    const password = state.password
      ? el("input", {
          type: "password",
          name: "password",
          autocomplete: "current-password",
          required: "",
        })
      : null;
    const passwordLabel = password && el("label", {}, "Password ", password);
    const submit = el("button", { class: "primary", type: "submit" });
    const toggle =
      state.emailSignIn && state.password ? el("button", { class: "quiet", type: "button" }) : null;
    const updateMethod = () => {
      if (password) {
        // Hidden password fields must not validate or post when requesting an email code.
        password.disabled = !usePassword;
        passwordLabel.hidden = !usePassword;
      }
      submit.textContent = usePassword ? "Sign in" : "Send me a code";
      if (toggle)
        toggle.textContent = usePassword ? "Use email code instead" : "Use password instead";
    };
    if (toggle)
      toggle.addEventListener("click", () => {
        usePassword = !usePassword;
        updateMethod();
        (usePassword ? password : email.querySelector("input")).focus();
      });
    updateMethod();
    options.push(
      el(
        "form",
        { method: "post", action: "/login" },
        next(),
        email,
        passwordLabel,
        submit,
        toggle,
      ),
    );
  }
  options.push(...alternatives);
  if (!state.password && !state.emailSignIn && !state.google && !state.cloudflare)
    options.push(el("p", { text: "Sign-in is not configured for this deployment." }));
  show(...options);
})();
