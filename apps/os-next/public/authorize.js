// Two-step consent over one authenticated RPC session. Project and permission choices
// live in state, so editing the selection never drops a choice or creates another grant.
import { newWebSocketRpcSession } from "./capnweb.js";

const card = document.getElementById("consent");
const query = location.search;
const loginAgain = `/login?next=${encodeURIComponent(`/oauth2/auth${query}`)}`;
/** The session, pipelined: the first call rides the socket's own round trip. A transport that
 *  carries no session (the cookie gone, the grant ended) rejects every call UNAUTHENTICATED. */
const api = newWebSocketRpcSession(
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api`,
).authenticate({ type: "from-server-cookie" });
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
/** The directory's slugging: lowercase, anything but a-z, 0-9 and dashes → a dash. As a slug is
 *  typed that is all; a slug proposed from a name also has its runs collapsed and its ends trimmed. */
const slugOf = (text, { proposed = false } = {}) => {
  const slug = text.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return proposed ? slug.replace(/-+/g, "-").replace(/^-+|-+$/g, "") : slug;
};

const state = {
  view: null,
  step: "projects",
  /** every project now and later — the list is parked (its ticks kept) while this is on */
  all: false,
  /** the projects unticked; a created project starts ticked */
  excluded: new Set(),
  /** the optional scopes unticked */
  declined: new Set(),
  /** the New project form is open */
  creating: false,
  /** the project form's fields: the slug (following the organization's name until the person
   *  edits it), the organization chosen (`""` = a new one, named in `newOrg`) — the one the last
   *  create made or used stays chosen, so a retry after a refused slug lands in the same one */
  draft: { slug: "", follows: true, org: "", newOrg: "" },
  error: null,
  busy: false,
};

/** Leave for the client's redirect, or for sign-in: a navigation, so nothing after it runs. */
function leave(location_) {
  location.assign(location_);
  return new Promise(() => {});
}
/** Ask the platform what to show and fold it into the state. */
async function refresh() {
  const view = await api.consent.describe(query);
  if (view.kind === "redirect") return leave(view.location);
  if (!state.view && view.kind === "consent") {
    // Default to all current and future projects; project-bound clients keep their ceiling.
    state.all = !view.projectBound;
    // The project form's first draft: the person's first organization, or — with none yet — a
    // new one named from their name or email (apps/auth's heuristic); the onboarding step's slug
    // starts by following that name.
    state.draft.org = view.orgs[0]?.id || "";
    if (!view.orgs.length) state.draft.newOrg = view.suggestedOrganizationName;
    if (!view.projectBound && !view.projects.length)
      state.draft.slug = slugOf(chosenOrgName(view), { proposed: true });
  }
  state.view = view;
}
/** The name of the organization the draft names — chosen from the list, or typed. */
const chosenOrgName = (view) =>
  state.draft.org
    ? view.orgs.find((org) => org.id === state.draft.org)?.name || ""
    : state.draft.newOrg;
/** Disable controls while an action is pending, preserving its choices until the answer renders.
 *  An expired session returns to sign-in; other failures appear beside the action. */
async function act(action) {
  if (state.busy) return;
  state.busy = true;
  state.error = null;
  for (const control of card.querySelectorAll("button, input, select")) control.disabled = true;
  try {
    await action();
  } catch (error) {
    if (error?.code === "UNAUTHENTICATED") return leave(loginAgain);
    state.error = error?.message || String(error);
  }
  state.busy = false;
  render();
}
/** Approve with the projects ticked (`["*"]` = every current and future project) and the scopes
 *  left ticked; the answer is the client's redirect, or a refusal to show. */
const approve = () =>
  act(async () => {
    const { projects, scopes } = state.view;
    const result = await api.consent.approve({
      query,
      projects: state.all
        ? ["*"]
        : projects.filter((p) => !state.excluded.has(p.id)).map((p) => p.id),
      scopes: scopes
        .filter((scope) => scope.required || !state.declined.has(scope.name))
        .map((scope) => scope.name),
    });
    if ("redirectTo" in result) return leave(result.redirectTo);
    state.error = result.error;
  });
/** Create the drafted project — in the organization chosen, or in a new one named with it: the
 *  one place the consent flow creates an organization. A refused slug after a new organization was
 *  made keeps that organization chosen, and the refreshed description shows it either way. */
const createProject = () =>
  act(async () => {
    const { draft } = state;
    // an empty project name is refused before a new organization is made for it
    if (!draft.slug.trim()) {
      state.error = "Enter a project name.";
      return;
    }
    const onboarding = !state.view.projects.length;
    try {
      if (!draft.org) draft.org = (await api.createOrg(draft.newOrg || "")).id;
      // the new project's root context is the platform's to hold, not this page's
      (await api.projects.create({ project: draft.slug, orgId: draft.org }))[Symbol.dispose]();
      state.creating = false;
      if (onboarding) state.step = "permissions";
      Object.assign(draft, { slug: "", follows: true, newOrg: "" });
    } catch (error) {
      if (error?.code === "UNAUTHENTICATED") throw error;
      state.error = error?.message || String(error);
    }
    await refresh();
  });

/** The project form's fields, drawn from the draft and writing back to it: the slug (lowercased as
 *  it is typed, anything else becoming a dash; `follow` makes it follow the organization's name
 *  until the person edits it) with the line saying where the project will live, and the
 *  organization — one of the person's (a select, the drafted one chosen) or a new one named right
 *  there, its name field opening for "New organization…" alone; with no organization yet, the
 *  name field alone. */
function projectFields(view, { follow }) {
  const { draft } = state;
  const slug = el("input", {
    type: "text",
    name: "slug",
    placeholder: "my-project",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
  });
  const host = el("span", { class: "muted consent-host" });
  const showSlug = () => {
    slug.value = draft.slug;
    // the project's address under this deployment's ingress routing (project-ingress.ts): a
    // subdomain of the wildcard, or a path on this very origin; none ⇒ the line stays hidden
    const routing = view.ingressRouting;
    host.hidden = !routing;
    host.textContent = !routing
      ? ""
      : routing.type === "subdomains"
        ? `Your project will be hosted at ${draft.slug || "my-project"}.${routing.hostname}`
        : `Your project will be hosted at ${location.origin}/projects/${draft.slug || "my-project"}/`;
  };
  slug.addEventListener("input", () => {
    draft.slug = slugOf(slug.value);
    draft.follows = false;
    showSlug();
  });
  const followName = () => {
    if (follow && draft.follows) draft.slug = slugOf(chosenOrgName(view), { proposed: true });
    showSlug();
  };
  const name = el("input", {
    type: "text",
    name: "new-org",
    autocomplete: "organization",
    placeholder: "Acme",
  });
  name.value = draft.newOrg;
  name.addEventListener("input", () => {
    draft.newOrg = name.value;
    followName();
  });
  const nameField = el("label", {}, "Organization name ", name);
  const fields = [];
  if (view.orgs.length) {
    const select = el("select", { name: "org" });
    for (const org of view.orgs) select.append(el("option", { value: org.id, text: org.name }));
    select.append(el("option", { value: "", text: "New organization…" }));
    select.value = draft.org;
    const reveal = () => (nameField.hidden = draft.org !== "");
    select.addEventListener("change", () => {
      draft.org = select.value;
      reveal();
      followName();
    });
    reveal();
    fields.push(el("label", {}, "Organization ", select));
  }
  fields.push(nameField);
  showSlug();
  // the hostname line sits beside the label, not in it: the field's name stays "Project slug"
  const slugField = el("div", {}, el("label", {}, "Project slug ", slug), host);
  return { fields, slugField };
}
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
      el("button", { class: "quiet", type: "submit", text: "Switch account" }),
    ),
  );
};

/** A request the authorization server refused outright (no client to send the person back to):
 *  the reason, and the way back to iterate. */
function renderInvalid(view) {
  document.title = "Invalid authorization request — iterate";
  card.className = "issuer-card";
  card.replaceChildren(
    el("img", { class: "issuer-mark", src: "/iterate-logo.svg", alt: "" }),
    el("h1", { text: "Invalid authorization request" }),
    el("p", { text: `The app's request could not be accepted: ${view.description}.` }),
    el("p", { class: "muted", text: "Nothing was granted. Go back to the app and try again." }),
    el("p", {}, el("a", { class: "button", href: "/", text: "Back to iterate" })),
  );
}

function render() {
  const view = state.view;
  if (!view) {
    // nothing to draw yet: a first description that failed (the socket dropped, the platform
    // refused) shows where "Loading…" was, with the way to try again — a fresh load, since the
    // socket is opened once, at the top
    if (state.error)
      card
        .querySelector("header")
        ?.replaceChildren(
          el("h1", { text: "Authorize" }),
          errorLine(),
          el("p", {}, el("a", { class: "button", href: location.href, text: "Try again" })),
        );
    return;
  }
  if (view.kind === "invalid") return renderInvalid(view);
  const { clientName, email, picture, projects, orgs, projectBound, scopes, denyLocation } = view;
  document.title = `Authorize ${clientName} — iterate`;
  const onboarding = !projectBound && !projects.length;
  const reviewing = state.step === "permissions" && !onboarding;
  const names = new Map(orgs.map((org) => [org.id, org.name]));
  const form = el("form", { id: "consent-form" });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (reviewing) approve();
    else if (onboarding || event.submitter?.value === "create") createProject();
    else {
      state.step = "permissions";
      state.error = null;
      render();
    }
  });

  // the permissions, as the platform describes them: a required one is ticked and stays so
  const permissionRows = scopes.map(({ name, title, note, required }) => {
    const box = el("input", { type: "checkbox", name: "scope", value: name, "aria-label": title });
    box.checked = required || !state.declined.has(name);
    box.disabled = required;
    box.addEventListener("change", () =>
      box.checked ? state.declined.delete(name) : state.declined.add(name),
    );
    return el(
      "label",
      { class: "consent-scope" },
      box,
      el("span", {}, el("strong", { text: title }), el("span", { class: "muted", text: note })),
    );
  });
  const approveButton = el("button", {
    class: "primary",
    type: "submit",
    form: "consent-form",
    text: reviewing ? "Authorize" : "Review permissions",
  });

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
  const list = el("fieldset", { class: "consent-projects", "aria-label": "Projects it may reach" });
  if (all)
    list.append(el("label", { class: "consent-project" }, all, "All my projects, now and future"));
  const boxes = projects.map((project) => {
    const orgName = names.get(project.orgId) || project.orgId;
    const box = el("input", {
      type: "checkbox",
      name: "project",
      value: project.id,
      "aria-label": `${project.slug} in ${orgName}`,
    });
    box.addEventListener("change", () => {
      if (box.checked) state.excluded.delete(project.id);
      else state.excluded.add(project.id);
      show();
    });
    list.append(
      el(
        "label",
        { class: "consent-project" },
        box,
        el(
          "span",
          { class: "consent-project-name" },
          el("span", { class: "consent-slug", text: project.slug }),
          el("span", { class: "muted", text: orgName }),
        ),
      ),
    );
    return box;
  });
  if (projectBound && !projects.length)
    list.append(el("p", { class: "muted", text: "You do not have access to this app’s project." }));
  // Choosing all parks the individual choices, so narrowing access restores them.
  const show = () => {
    if (all) all.checked = state.all;
    for (const box of boxes) {
      box.checked = state.all || !state.excluded.has(box.value);
      box.disabled = state.all;
    }
    const hasSelection = state.all || boxes.some((box) => box.checked);
    approveButton.disabled = state.busy || (!onboarding && !hasSelection);
  };
  all?.addEventListener("change", () => {
    state.all = all.checked;
    show();
  });
  show();

  // New project — in one of the person's organizations, or in a new one named right here: the
  // only place the consent flow creates an organization.
  const creating = !projectBound && state.creating;
  const add = projectBound
    ? null
    : el(
        "button",
        { class: "consent-project consent-add", type: "button", "aria-expanded": String(creating) },
        el("span", { "aria-hidden": "true", text: "+" }),
        "New project",
      );
  add?.addEventListener("click", () => {
    state.creating = !creating;
    render();
  });
  if (add) list.append(add);
  let create = null;
  if (creating) {
    const { fields, slugField } = projectFields(view, { follow: false });
    const createButton = el("button", {
      type: "submit",
      name: "action",
      value: "create",
      text: "Create project",
    });
    create = el(
      "section",
      { class: "consent-create", "aria-label": "New project" },
      el("h2", { text: "New project" }),
      el("div", { class: "consent-fields" }, slugField, ...fields),
      createButton,
    );
  }

  if (reviewing) {
    form.append(
      el("h2", { tabindex: "-1", text: "Review permissions" }),
      el(
        "section",
        { class: "consent-permissions", "aria-label": "Permissions" },
        ...permissionRows,
      ),
    );
  } else if (onboarding) {
    const { fields, slugField } = projectFields(view, { follow: true });
    form.append(
      el("h2", { tabindex: "-1", text: "Create a project" }),
      el("div", { class: "consent-onboarding" }, ...fields, slugField),
    );
  } else {
    form.append(
      ...[el("h2", { tabindex: "-1", text: "Select projects" }), list, create].filter(Boolean),
    );
  }
  const summary = el("section", { class: "consent-summary", "aria-label": "Selected projects" });
  if (reviewing) {
    const edit = el("button", {
      type: "button",
      text: "Edit",
      "aria-label": "Edit selected projects",
    });
    edit.addEventListener("click", () => {
      state.step = "projects";
      state.error = null;
      render();
    });
    summary.append(
      el("div", { class: "consent-section-heading" }, el("h2", { text: "Project access" }), edit),
      ...(state.all
        ? [el("p", {}, el("strong", { text: "All my projects, now and future" }))]
        : projects
            .filter((project) => !state.excluded.has(project.id))
            .map((project) =>
              el(
                "div",
                { class: "consent-selected" },
                el("strong", { class: "consent-slug", text: project.slug }),
                el("span", { class: "muted", text: names.get(project.orgId) || project.orgId }),
              ),
            )),
    );
  }
  const panel = el(
    "div",
    { class: "consent-panel" },
    form,
    el(
      "aside",
      { class: "consent-sidebar" },
      signedInAs(email, picture),
      reviewing ? summary : null,
      el(
        "div",
        { class: "consent-footer" },
        errorLine(),
        el(
          "div",
          { class: "consent-actions" },
          approveButton,
          el("a", { class: "button", href: denyLocation, text: "Cancel" }),
        ),
      ),
    ),
  );
  const shown = card.querySelector(".consent-panel");
  if (shown) {
    shown.replaceWith(panel);
    form.querySelector("h2")?.focus();
    return;
  }
  card.replaceChildren(
    el(
      "header",
      { class: "consent-header" },
      el(
        "div",
        { class: "consent-hero", "aria-hidden": "true" },
        el("span", { class: "consent-tile" }, el("img", { src: "/iterate-logo.svg", alt: "" })),
        el("span", { class: "consent-arrow", text: "⇄" }),
        el("span", { class: "consent-tile", text: clientName.slice(0, 2).toUpperCase() }),
      ),
      el("h1", { text: `${clientName} wants to access your account` }),
    ),
    panel,
  );
}

act(refresh);
