// public/authorize.js — the consent page's script. /authorize.json (control-plane.ts) describes the
// request — the client, the signed-in person, their projects and organizations, the scopes asked
// for — and this renders the card; creating an organization or a project posts to /authorize and
// answers the refreshed description with every choice kept; Approve posts the projects and scopes
// left ticked and ends in the client's redirect. Consent is task-based: every scope but `iterate`
// may be unticked, and the grant carries what stays ticked. Plain DOM, no framework — the roles and
// strings here are what specs/auth.spec.ts drives.
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
    setupOpen: false,
    selectedOrgId: null,
    /** the create action that just went through — its field starts empty on the next render */
    consumed: null,
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
      .catch(() => ({ error: `Iterate answered ${response.status}. Try again.` }));
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
    if (data.orgId) state.selectedOrgId = data.orgId;
    if (!data.view) return;
    if (data.view.kind === "redirect") {
      location.assign(data.view.location);
      return;
    }
    state.view = data.view;
  }
  /** One action at a time: the buttons go quiet for the round trip (no re-render — what the person
   *  is typing meanwhile stays put), then the page renders the answer once. */
  async function act(body) {
    if (state.busy) return;
    state.busy = true;
    state.error = null;
    for (const button of card.querySelectorAll("button")) button.disabled = true;
    // the create section stays open after a create unless that create made the first project
    if (body.action !== "approve") state.setupOpen = state.view.projects.length > 0;
    const data = await call("POST", body);
    apply(data);
    state.busy = false;
    // a create that went through empties its field; a refused one keeps what was typed
    state.consumed = data.error ? null : body.action;
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
    const { clientName, email, projects, orgs, projectBound, scopes, denyLocation } = view;
    document.title = `Authorize ${clientName} — Iterate`;
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
    const approve = el("button", { type: "submit", text: "Approve" });
    const list = el("fieldset", {
      class: "consent-projects",
      "aria-label": "Projects it may reach",
    });
    if (projects.length)
      for (const orgId of orgIds) {
        const group = projects.filter((project) => project.orgId === orgId);
        const orgName = names.get(orgId) || orgId;
        list.append(
          el(
            "section",
            { class: "consent-org", "aria-label": orgName },
            el(
              "h3",
              {},
              orgName,
              el("span", {
                class: "muted",
                text: `${group.length} ${group.length === 1 ? "project" : "projects"}`,
              }),
            ),
            ...group.map((project) => {
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
                el("strong", { text: project.id }),
              );
            }),
          ),
        );
      }
    else
      list.append(
        el("p", {
          class: "muted",
          text: projectBound
            ? "You do not have access to this app’s project."
            : "Create your first organization and project below, then approve access.",
        }),
      );
    const all =
      !projectBound && projects.length
        ? el("input", {
            type: "checkbox",
            name: "all",
            value: "1",
            "aria-label": "All my current and future projects",
          })
        : null;
    if (all) all.checked = state.all;

    // what is typed into the create section survives a re-render (a create answers while the
    // person may already be filling the next field)
    const typed = (name) => card.querySelector(`[name="${name}"]`)?.value || "";
    const setup = projectBound ? null : el("details", { class: "consent-create" });
    if (setup) {
      const orgName = el("input", { type: "text", name: "org-name" });
      orgName.value = state.consumed === "create-org" ? "" : typed("org-name");
      const createOrg = el("button", { type: "button", text: "Create organization" });
      createOrg.addEventListener("click", () => act({ action: "create-org", name: orgName.value }));
      setup.append(
        el(
          "summary",
          {},
          el("h2", {
            text: orgs.length
              ? "Create a project or organization"
              : "Create your first organization",
          }),
        ),
        el("label", {}, "Organization name ", orgName),
        createOrg,
      );
      if (orgs.length) {
        const org = el("select", { name: "org" });
        for (const candidate of orgs) {
          const option = el("option", { value: candidate.id, text: candidate.name });
          option.selected = candidate.id === (state.selectedOrgId || typed("org") || orgs[0].id);
          org.append(option);
        }
        const projectName = el("input", { type: "text", name: "project-name" });
        projectName.value = state.consumed === "create-project" ? "" : typed("project-name");
        const createProject = el("button", { type: "button", text: "Create project" });
        createProject.addEventListener("click", () =>
          act({ action: "create-project", org: org.value, project: projectName.value }),
        );
        setup.append(
          el("label", {}, "Organization ", org),
          el("label", {}, "Project name ", projectName),
          createProject,
        );
      }
      setup.open = state.setupOpen || !projects.length;
    }

    form.append(
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
        projects.length > 1
          ? el(
              "div",
              {},
              el("button", {
                class: "consent-quiet",
                type: "button",
                "data-select": "all",
                text: "Select all",
              }),
              el("button", {
                class: "consent-quiet",
                type: "button",
                "data-select": "none",
                text: "Clear",
              }),
            )
          : null,
      ),
      list,
      all
        ? el(
            "label",
            { class: "consent-future" },
            all,
            el(
              "span",
              {},
              el("strong", { text: "All my current and future projects" }),
              el("span", { class: "muted", text: "Include projects you create or join later." }),
            ),
          )
        : null,
      el("p", {
        class: "muted",
        text: "This app can read and make changes in the projects you grant it.",
      }),
      setup,
      el(
        "footer",
        {},
        state.error ? el("p", { role: "alert", "data-type": "error", text: state.error }) : null,
        el(
          "div",
          { class: "consent-actions" },
          el("a", { href: denyLocation, text: "Cancel" }),
          approve,
        ),
      ),
    );

    // The checkboxes are the state: every change re-reads them. "Every project" parks the list —
    // the ticks come back when it is unticked.
    const boxes = () => Array.from(form.querySelectorAll('input[name="project"]'));
    // parked ticks are in the boxes' own (organization-grouped) order, never the projects array's
    let parked = state.all ? boxes().map((box) => !state.excluded.has(box.value)) : null;
    const sync = () => {
      const every = Boolean(all && all.checked);
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
      status.textContent = every ? "All current and future projects" : `${count} selected`;
      approve.disabled = state.busy || (!every && count === 0);
      for (const button of form.querySelectorAll("button[type=button]"))
        button.disabled = state.busy;
    };
    form.addEventListener("change", sync);
    for (const button of form.querySelectorAll("[data-select]"))
      button.addEventListener("click", () => {
        for (const box of boxes()) box.checked = button.getAttribute("data-select") === "all";
        sync();
      });
    sync();

    card.replaceChildren(
      el(
        "header",
        {},
        el(
          "div",
          { class: "consent-app" },
          el("span", {
            class: "consent-avatar",
            "aria-hidden": "true",
            text: clientName.slice(0, 2).toUpperCase(),
          }),
          el(
            "div",
            {},
            el("span", { class: "consent-badge", text: "Project access" }),
            el("h1", { text: `Authorize ${clientName}` }),
          ),
        ),
        el("p", {
          class: "muted",
          text: projectBound
            ? "Review access to this app’s project."
            : "Choose which projects this app can use.",
        }),
      ),
      el(
        "section",
        { class: "consent-account", "aria-label": "Signed-in account" },
        el("span", {
          class: "consent-avatar",
          "aria-hidden": "true",
          text: email.slice(0, 1).toUpperCase(),
        }),
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
