// public/authorize.js — the consent page's script. /authorize.json (control-plane.ts) describes the
// request — the client, the signed-in person, their projects and organizations, the scopes asked
// for — and this renders one of two pages. A person with no project yet gets the onboarding step
// first (like apps/auth's): their organization's name and their first project's slug, one form,
// Continue. Then the consent page: iterate ⇄ the client, who is signed in, the permissions, the
// projects as an either/or — one checkbox for every project now and later, else the ones ticked —
// with "New project" (in one of the person's organizations, or in a new one named right there)
// posting to /authorize and answering the refreshed description with every choice kept. Approve
// posts the projects and scopes left ticked and ends in the client's redirect. Consent is
// task-based: every scope but `iterate` may be unticked, and the grant carries what stays ticked.
// Plain DOM, no framework — the roles and strings here are what specs/auth.spec.ts drives; every
// bit of motion is issuer.css's.
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
    /** the New project form is open */
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
  /** One action at a time: the form's buttons go quiet for the round trip (no re-render — what the
   *  person is typing meanwhile stays put), then the page renders the answer once. Switch account,
   *  outside the form and built once, stays live. */
  async function act(body) {
    if (state.busy) return;
    state.busy = true;
    state.error = null;
    for (const button of card.querySelectorAll("#consent-form button, #onboarding-form button"))
      button.disabled = true;
    const data = await call("POST", body);
    apply(data);
    state.busy = false;
    // a project created closes the form; a refused one keeps it open, with what was typed
    if (body.action === "create-project" && !data.error) state.creating = false;
    render();
  }

  /** The project field — a slug, the project's id and its hostname's label: lowercased as it is
   *  typed, anything but a-z, 0-9 and dashes becoming a dash (the directory slugs it the same way)
   *  — with the line saying where the project will live. What was typed survives a re-render (a
   *  refused create answers while the person may already be correcting a field). */
  const slugField = (base) => {
    const input = el("input", {
      type: "text",
      name: "slug",
      placeholder: "my-project",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
    });
    input.value = card.querySelector('[name="slug"]')?.value || "";
    const host = el("span", { class: "muted consent-host" });
    const show = () => {
      const slug = input.value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      if (slug !== input.value) input.value = slug;
      host.hidden = !base;
      host.textContent = `Your project will be hosted at ${slug || "my-project"}.${base}`;
    };
    input.addEventListener("input", show);
    show();
    const set = (value) => {
      input.value = value;
      show();
    };
    // the hostname line sits beside the label, not in it: the field's name stays "Project slug"
    return { input, set, field: el("div", {}, el("label", {}, "Project slug ", input), host) };
  };
  /** The directory's slugging, for a slug proposed from a name: lowercase, anything else → a dash,
   *  runs collapsed, ends trimmed. */
  const slugOf = (name) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
  /** Which organization a project goes to: one of the person's (a select — the one the last create
   *  made or used comes first, so a refused create's retry lands where the first try went) or a new
   *  one named right there, its name field opening for "New organization…" alone. With no
   *  organization yet, the name field alone — filled with the suggestion when `suggest`. `value()`
   *  is what /authorize's create-project takes; `chosenName()` is what a slug may follow. */
  const orgChoice = (view, { suggest }) => {
    const previous = {
      select: card.querySelector('[name="org"]'),
      name: card.querySelector('[name="new-org"]'),
    };
    const previousName =
      previous.select && previous.select.value
        ? previous.select.selectedOptions[0].textContent
        : (previous.name?.value ?? null);
    const name = el("input", {
      type: "text",
      name: "new-org",
      autocomplete: "organization",
      placeholder: "Acme",
    });
    name.value = previous.name
      ? previous.name.value
      : suggest
        ? view.suggestedOrganizationName
        : "";
    const nameField = el("label", {}, "Organization name ", name);
    if (!view.orgs.length)
      return {
        name,
        previousName,
        fields: [nameField],
        value: () => ({ newOrg: name.value }),
        chosenName: () => name.value,
      };
    const select = el("select", { name: "org" });
    for (const candidate of view.orgs)
      select.append(el("option", { value: candidate.id, text: candidate.name }));
    select.append(el("option", { value: "", text: "New organization…" }));
    select.value = previous.select ? previous.select.value : state.lastOrgId || view.orgs[0].id;
    const reveal = () => (nameField.hidden = select.value !== "");
    select.addEventListener("change", reveal);
    reveal();
    return {
      name,
      select,
      previousName,
      fields: [el("label", {}, "Organization ", select), nameField],
      value: () => (select.value ? { org: select.value } : { newOrg: name.value }),
      chosenName: () =>
        select.value
          ? view.orgs.find((candidate) => candidate.id === select.value)?.name || ""
          : name.value,
    };
  };
  const errorLine = () =>
    state.error ? el("p", { role: "alert", "data-type": "error", text: state.error }) : null;
  /** Who is signed in — the person's picture (or initial), the address, Switch account. */
  const signedInAs = (email, picture) => {
    const initial = el("span", {
      class: "consent-avatar",
      "aria-hidden": "true",
      text: email.slice(0, 1).toUpperCase(),
    });
    return el(
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
    );
  };

  /** The onboarding step — a person with no project yet: their organization (its name; or, once
   *  they have one — a refused first try made it — the choice of it) and their first project's
   *  slug, one form; Continue posts both and the consent page follows. Both start filled the way
   *  apps/auth fills them: the name from the person's display name or email, the slug from the
   *  name — following it until the person edits the slug (then it is theirs, even emptied), and a
   *  refused create keeps what was typed. */
  function renderOnboarding(view) {
    document.title = "Create a project — iterate";
    const shownSlug = card.querySelector('[name="slug"]');
    const org = orgChoice(view, { suggest: true });
    const project = slugField(view.projectHostnameBase);
    let follows = !shownSlug || shownSlug.value === slugOf(org.previousName || "");
    const follow = () => {
      if (follows) project.set(slugOf(org.chosenName()));
    };
    follow();
    org.name.addEventListener("input", follow);
    org.select?.addEventListener("change", follow);
    project.input.addEventListener("input", () => {
      follows = false;
    });
    const form = el("form", { id: "onboarding-form" });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      act({ action: "create-project", project: project.input.value, ...org.value() });
    });
    form.append(
      ...org.fields,
      project.field,
      el(
        "footer",
        {},
        errorLine(),
        el(
          "div",
          { class: "consent-actions" },
          el("a", { class: "button", href: view.denyLocation, text: "Cancel" }),
          el("button", { class: "primary", type: "submit", text: "Continue" }),
        ),
      ),
    );
    card.replaceChildren(
      el(
        "header",
        {},
        el("img", { class: "issuer-mark", src: "/iterate-logo.svg", alt: "" }),
        el("h1", { text: "Create a project" }),
      ),
      signedInAs(view.email, view.picture),
      form,
    );
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
    if (!view.projectBound && !view.projects.length) return renderOnboarding(view);
    const { clientName, email, picture, projects, orgs, projectBound, scopes, denyLocation } = view;
    document.title = `Authorize ${clientName} — iterate`;
    const names = new Map(orgs.map((org) => [org.id, org.name]));
    const orgIds = [...new Set(projects.map((project) => project.orgId))];
    const ticked = (id) => state.all || !state.excluded.has(id);
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

    // Which projects — an either/or, one checkbox: every project now and later, or the ones
    // ticked in the list below it (a client bound to one project has no such choice)
    const all = projectBound
      ? null
      : el("input", {
          type: "checkbox",
          name: "all",
          value: "1",
          "aria-label": "All my projects, now and future",
        });
    if (all) all.checked = state.all;
    const future = all
      ? el(
          "label",
          { class: "consent-future" },
          all,
          el(
            "span",
            {},
            el("strong", { text: "All my projects, now and future" }),
            el("span", { class: "muted", text: "Includes projects you create or join later." }),
          ),
        )
      : null;
    const list = el("fieldset", {
      class: "consent-projects",
      "aria-label": "Projects it may reach",
    });
    for (const orgId of orgIds) {
      const orgName = names.get(orgId) || orgId;
      list.append(
        el(
          "section",
          { class: "consent-org", "aria-label": orgName },
          // the organization's name only when there is more than one to tell apart
          orgIds.length > 1 ? el("h3", { text: orgName }) : null,
          ...projects
            .filter((project) => project.orgId === orgId)
            .map((project) => {
              const box = el("input", {
                type: "checkbox",
                name: "project",
                value: project.id,
                "aria-label": `${project.id} in ${orgName}`,
              });
              box.checked = ticked(project.id);
              return el(
                "label",
                { class: "consent-project" },
                box,
                el("span", { text: project.id }),
              );
            }),
        ),
      );
    }
    if (projectBound && !projects.length)
      list.append(
        el("p", { class: "muted", text: "You do not have access to this app’s project." }),
      );

    // New project — in one of the person's organizations, or in a new one named right here: the
    // only place the consent flow creates an organization.
    const creating = !projectBound && state.creating;
    const add = projectBound
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
      const project = slugField(view.projectHostnameBase);
      const org = orgChoice(view, { suggest: false });
      const createProject = el("button", { type: "button", text: "Create project" });
      createProject.addEventListener("click", () =>
        act({ action: "create-project", project: project.input.value, ...org.value() }),
      );
      create = el(
        "section",
        { class: "consent-create", "aria-label": "New project" },
        el("h2", { text: "New project" }),
        el("div", { class: "consent-fields" }, project.field, ...org.fields),
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
        future,
        list,
        create,
        el(
          "footer",
          {},
          errorLine(),
          el(
            "div",
            { class: "consent-actions" },
            el("a", { class: "button", href: denyLocation, text: "Cancel" }),
            approve,
          ),
        ),
      ].filter(Boolean),
    );

    // The boxes are the state: every change re-reads them. "All my projects" parks the list — the
    // ticks come back when it is unticked.
    const boxes = () => Array.from(form.querySelectorAll('input[name="project"]'));
    // parked ticks are in the boxes' own (organization-grouped) order, never the projects array's
    let parked = state.all ? boxes().map((box) => !state.excluded.has(box.value)) : null;
    const sync = () => {
      // no either/or (the client's one project): the default stands
      const every = all ? all.checked : state.all;
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
      // the count of ticked projects; with "all" ticked the checkbox says it, so nothing else does
      status.hidden = !projects.length || every;
      status.textContent = `${count} selected`;
      approve.disabled = state.busy || (!every && count === 0);
      for (const button of form.querySelectorAll("button[type=button]"))
        button.disabled = state.busy;
    };
    form.addEventListener("change", sync);
    sync();

    // The hero (iterate ⇄ the client: its picture — /client-icon — or its initials) and who is
    // signed in are built once; every later render swaps the form alone, so the entrance in
    // issuer.css plays once and the pictures stay put.
    const shown = card.querySelector("#consent-form");
    if (shown) return shown.replaceWith(form);
    form.classList.add("consent-enter");
    card.replaceChildren(
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
      signedInAs(email, picture),
      form,
    );
  }

  call("GET").then((data) => {
    apply(data);
    render();
  });
})();
