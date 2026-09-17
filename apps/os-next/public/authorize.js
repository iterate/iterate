// public/authorize.js — the consent page's script. /authorize.json (control-plane.ts) describes the
// request — the client, the signed-in person, their projects and organizations, the scopes asked
// for — and this renders the page: iterate ⇄ the client, who is signed in, the permissions, the
// projects. The projects are an either/or — the ones ticked, or every project now and later — with
// "New project" (in one of the person's organizations, or in a new one named right there) posting
// to /authorize and answering the refreshed description with every choice kept. Approve posts the
// projects and scopes left ticked and ends in the client's redirect. Consent is task-based: every
// scope but `iterate` may be unticked, and the grant carries what stays ticked. Plain DOM, no
// framework — the roles and strings here are what specs/auth.spec.ts drives.
(() => {
  const card = document.getElementById("consent");
  const query = location.search;
  const loginAgain = `/login?next=${encodeURIComponent(`/authorize${query}`)}`;
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
  /** A picture over a fallback: the tile keeps its text until — unless — the image has loaded. */
  const pictured = (tile, src) => {
    const image = el("img", { src, alt: "" });
    image.addEventListener("load", () => tile.replaceChildren(image), { once: true });
    return tile;
  };
  /** What each scope means to the person, as a title and a note. `iterate` is what the app is for;
   *  the rest are optional and tickable (packages/iterate/src/next/oauth-scopes.ts lists them). */
  const permissions = {
    iterate: [
      "Read and make changes in the projects you grant it",
      "Required — what the app is for.",
    ],
    account: ["See and end your sessions, and mint personal access tokens", "Optional."],
    "organizations:write": ["See all your organizations and create new ones", "Optional."],
  };
  const state = {
    view: null,
    /** projects the person unticked (a created project starts ticked); `all` parks the list */
    excluded: new Set(),
    all: false,
    /** optional scopes the person unticked */
    declined: new Set(),
    /** the New project form is open (it is, on its own, while there is no project) */
    creating: false,
    /** the organization the last create made or used — the form offers it first next time */
    lastOrgId: null,
    error: null,
    busy: false,
  };

  async function call(method, body) {
    const response = await fetch(
      method === "GET" ? `/authorize.json${query}` : `/authorize${query}`,
      {
        method,
        credentials: "same-origin",
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    const data = await response
      .json()
      .catch(() => ({ error: `iterate answered ${response.status}. Try again.` }));
    if (response.status === 401) {
      location.assign(data.login || loginAgain);
      return new Promise(() => {});
    }
    return data;
  }
  /** Fold an answer into the state: an error to show, a redirect to follow, or a fresh view. */
  function apply(data) {
    state.error = data.error || null;
    if (data.redirectTo) {
      location.assign(data.redirectTo);
      return;
    }
    if (data.orgId) state.lastOrgId = data.orgId;
    if (!data.view) return;
    if (data.view.kind === "redirect") {
      location.assign(data.view.location);
      return;
    }
    // The first view sets the projects default: an app that asked to manage the person's
    // organizations (the dash) is an account app — every current and future project, unless the
    // client is bound to one project. Other apps start with the listed projects ticked one by one.
    if (!state.view && data.view.kind === "consent")
      state.all = !data.view.projectBound && data.view.scopes.includes("organizations:write");
    state.view = data.view;
  }
  /** One action at a time: the buttons go quiet for the round trip (no re-render — what the person
   *  is typing meanwhile stays put), then the page renders the answer once. */
  async function act(body) {
    if (state.busy) return;
    state.busy = true;
    state.error = null;
    for (const button of card.querySelectorAll("button")) button.disabled = true;
    const data = await call("POST", body);
    apply(data);
    state.busy = false;
    // a project created closes the form; a refused one keeps it open, with what was typed
    if (body.action === "create-project" && !data.error) state.creating = false;
    render();
  }

  function render() {
    const view = state.view;
    if (!view) return;
    if (view.kind === "invalid") {
      card.replaceChildren(
        el(
          "header",
          {},
          el("h1", { text: "Invalid authorization request" }),
          el("p", { text: view.description }),
        ),
      );
      return;
    }
    const { clientName, email, picture, projects, orgs, projectBound, scopes, denyLocation } = view;
    document.title = `Authorize ${clientName} — iterate`;
    const names = new Map(orgs.map((org) => [org.id, org.name]));
    const orgIds = [...new Set(projects.map((project) => project.orgId))];
    const ticked = (id) => state.all || !state.excluded.has(id);
    // what is typed into the New project form survives a re-render (a refused create answers
    // while the person may already be correcting a field)
    const typed = (name) => card.querySelector(`[name="${name}"]`)?.value || "";
    const form = el("form", { id: "consent-form" });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      act({
        action: "approve",
        projects: state.all ? ["*"] : projects.filter((p) => ticked(p.id)).map((p) => p.id),
        scopes: scopes.filter((scope) => scope === "iterate" || !state.declined.has(scope)),
      });
    });

    const permissionRows = scopes.map((scope) => {
      const [title, note] = permissions[scope] || [scope, "Optional."];
      const box = el("input", {
        type: "checkbox",
        name: "scope",
        value: scope,
        "aria-label": title,
      });
      box.checked = scope === "iterate" || !state.declined.has(scope);
      box.disabled = scope === "iterate";
      return el(
        "label",
        { class: "consent-scope" },
        box,
        el("span", {}, el("strong", { text: title }), el("span", { class: "muted", text: note })),
      );
    });
    const status = el("p", { class: "muted", role: "status" });
    const approve = el("button", { class: "primary", type: "submit", text: "Approve" });

    // Which projects — an either/or: the ones ticked below, or every project now and later
    const mode = (value, text) => {
      const input = el("input", { type: "radio", name: "mode", value });
      input.checked = (value === "all") === state.all;
      return el("label", { class: "consent-mode" }, input, el("span", { text }));
    };
    const modes =
      !projectBound && projects.length
        ? el(
            "div",
            { class: "consent-modes", role: "radiogroup", "aria-label": "Which projects" },
            mode("chosen", "Chosen projects"),
            mode("all", "All my projects, now and future"),
          )
        : null;
    const list = el("fieldset", {
      class: "consent-projects",
      "aria-label": "Projects it may reach",
    });
    for (const orgId of orgIds) {
      const group = projects.filter((project) => project.orgId === orgId);
      const orgName = names.get(orgId) || orgId;
      list.append(
        el(
          "section",
          { class: "consent-org", "aria-label": orgName },
          el("h3", { text: orgName }),
          ...group.map((project) => {
            const box = el("input", {
              type: "checkbox",
              name: "project",
              value: project.id,
              "aria-label": `${project.id} in ${orgName}`,
            });
            box.checked = ticked(project.id);
            return el("label", { class: "consent-project" }, box, el("span", { text: project.id }));
          }),
        ),
      );
    }
    if (projectBound && !projects.length)
      list.append(
        el("p", { class: "muted", text: "You do not have access to this app’s project." }),
      );

    // New project — in one of the person's organizations, or in a new one named right here: the
    // only place the consent flow creates an organization. Open on its own while there is no
    // project (nothing to approve until there is one).
    const creating = !projectBound && (state.creating || !projects.length);
    const add =
      projectBound || !projects.length
        ? null
        : el(
            "button",
            { class: "consent-add", type: "button", "aria-expanded": String(creating) },
            el("span", { "aria-hidden": "true", text: "+" }),
            "New project",
          );
    add?.addEventListener("click", () => {
      state.creating = !creating;
      render();
    });
    let create = null;
    if (creating) {
      const projectName = el("input", { type: "text", name: "project-name", autocomplete: "off" });
      projectName.value = typed("project-name");
      const orgName = el("input", { type: "text", name: "org-name", autocomplete: "off" });
      orgName.value = typed("org-name");
      const orgNameField = el("label", {}, "Organization name ", orgName);
      let org = null;
      if (orgs.length) {
        org = el("select", { name: "org" });
        for (const candidate of orgs)
          org.append(el("option", { value: candidate.id, text: candidate.name }));
        org.append(el("option", { value: "", text: "New organization…" }));
        const before = card.querySelector('[name="org"]');
        org.value = before ? before.value : state.lastOrgId || orgs[0].id;
        const showOrgName = () => (orgNameField.hidden = org.value !== "");
        org.addEventListener("change", showOrgName);
        showOrgName();
      }
      const createProject = el("button", { type: "button", text: "Create project" });
      createProject.addEventListener("click", () =>
        act({
          action: "create-project",
          project: projectName.value,
          ...(org && org.value ? { org: org.value } : { newOrg: orgName.value }),
        }),
      );
      create = el(
        "section",
        { class: "consent-create", "aria-label": "New project" },
        el("h2", { text: projects.length ? "New project" : "Create your first project" }),
        el("label", {}, "Project name ", projectName),
        org ? el("label", {}, "Organization ", org) : null,
        orgNameField,
        createProject,
      );
    }

    form.append(
      ...[
        el(
          "section",
          { class: "consent-permissions", "aria-label": "Permissions" },
          el("h2", { text: "Permissions" }),
          ...permissionRows,
        ),
        el(
          "div",
          { class: "consent-project-heading" },
          el("div", {}, el("h2", { text: "Projects" }), status),
          add,
        ),
        modes,
        projects.length || projectBound ? list : null,
        create,
        el(
          "footer",
          {},
          state.error ? el("p", { role: "alert", "data-type": "error", text: state.error }) : null,
          el(
            "div",
            { class: "consent-actions" },
            el("a", { class: "button", href: denyLocation, text: "Cancel" }),
            approve,
          ),
        ),
      ].filter(Boolean),
    );

    // The boxes are the state: every change re-reads them. "All" parks the list — the ticks come
    // back when "Chosen projects" is picked again.
    const boxes = () => Array.from(form.querySelectorAll('input[name="project"]'));
    // parked ticks are in the boxes' own (organization-grouped) order, never the projects array's
    let parked = state.all ? boxes().map((box) => !state.excluded.has(box.value)) : null;
    const sync = () => {
      // no either/or (no project yet, or the client's one project): the default stands
      const every = modes
        ? form.querySelector('input[name="mode"]:checked').value === "all"
        : state.all;
      if (every && !parked) {
        parked = boxes().map((box) => box.checked);
        for (const box of boxes()) box.checked = true;
      } else if (!every && parked) {
        boxes().forEach((box, i) => (box.checked = parked[i]));
        parked = null;
      }
      state.all = every;
      state.excluded = new Set(
        boxes()
          .filter((box, i) => !(every ? parked[i] : box.checked))
          .map((box) => box.value),
      );
      state.declined = new Set(
        Array.from(form.querySelectorAll('input[name="scope"]'))
          .filter((box) => !box.checked)
          .map((box) => box.value),
      );
      const count = boxes().filter((box) => box.checked).length;
      list.disabled = every;
      status.hidden = !projects.length;
      status.textContent = every ? "All current and future projects" : `${count} selected`;
      // nothing to approve without a project: the first one is created right here
      approve.disabled = state.busy || !projects.length || (!every && count === 0);
      for (const button of form.querySelectorAll("button[type=button]"))
        button.disabled = state.busy;
    };
    form.addEventListener("change", sync);
    sync();

    const initial = el("span", {
      class: "consent-avatar",
      "aria-hidden": "true",
      text: email.slice(0, 1).toUpperCase(),
    });
    card.replaceChildren(
      // the hero: iterate ⇄ the client (its picture — /client-icon — or its initials)
      el(
        "header",
        {},
        el(
          "div",
          { class: "consent-hero", "aria-hidden": "true" },
          el("span", { class: "consent-tile" }, el("img", { src: "/iterate-logo.svg", alt: "" })),
          el("span", { class: "consent-arrow", text: "⇄" }),
          pictured(
            el(
              "span",
              { class: "consent-tile" },
              el("span", { text: clientName.slice(0, 2).toUpperCase() }),
            ),
            `/client-icon?client_id=${encodeURIComponent(view.clientId)}`,
          ),
        ),
        el("h1", { text: `Authorize ${clientName}` }),
      ),
      el(
        "section",
        { class: "consent-account", "aria-label": "Signed-in account" },
        picture ? pictured(initial, picture) : initial,
        el(
          "div",
          {},
          el("span", { class: "muted", text: "Signed in as" }),
          el("strong", { text: email }),
        ),
        el(
          "form",
          { method: "post", action: `/.auth/logout?next=${encodeURIComponent(loginAgain)}` },
          el("button", { class: "consent-quiet", type: "submit", text: "Switch account" }),
        ),
      ),
      form,
    );
  }

  call("GET").then((data) => {
    apply(data);
    render();
  });
})();
