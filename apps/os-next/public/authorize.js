// public/authorize.js — the consent page's script: a capnweb client of /api like any app, over ONE
// WebSocket the session cookie rides in on (capnweb.js beside it is the fork's browser bundle,
// copied by scripts/build.ts). `consent.describe` says what to show — the client, the signed-in
// person, their projects and organizations, the scopes asked for with what each means — and this
// renders one of two pages. A person with no project yet gets the onboarding step first (like
// apps/auth's): their organization's name and their first project's slug, one form, Continue. Then
// the consent page: iterate ⇄ the client, who is signed in, the permissions, the projects as an
// either/or — one checkbox for every project now and later, else the ones ticked — with "New
// project" (in one of the person's organizations, or in a new one named right there: `createOrg`,
// then `projects.create`, then the refreshed description with every choice kept). Approve is
// `consent.approve` with the projects and scopes left ticked, and ends in the client's redirect.
// Consent is task-based: every scope but `iterate` may be unticked, and the grant carries what stays
// ticked. Plain DOM, no framework: `state` is the one source of truth — events change it, `render`
// draws it, nothing is read back out of the DOM — and the roles and strings here are what
// specs/auth.spec.ts drives; every bit of motion is issuer.css's.
import { newWebSocketRpcSession } from "./capnweb.js";

const card = document.getElementById("consent");
const query = location.search;
const loginAgain = `/login?next=${encodeURIComponent(`/authorize${query}`)}`;
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
    // The first view sets the projects default: an app that asked to manage the person's
    // organizations (the dash) is an account app — every current and future project, unless the
    // client is bound to one project. Other apps start with the listed projects ticked one by one.
    state.all =
      !view.projectBound && view.scopes.some((scope) => scope.name === "organizations:write");
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
/** One action at a time: the form's buttons go quiet for the round trips (no re-render — what the
 *  person is typing meanwhile stays put), then the page renders the answer once. Switch account,
 *  outside the form and built once, stays live. A session this transport no longer carries sends
 *  the browser to sign in again; anything else is shown where the person acted. */
async function act(action) {
  if (state.busy) return;
  state.busy = true;
  state.error = null;
  for (const button of card.querySelectorAll("#consent-form button, #onboarding-form button"))
    button.disabled = true;
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
    try {
      if (!draft.org) draft.org = (await api.createOrg(draft.newOrg || "")).id;
      // the new project's root context is the platform's to hold, not this page's
      (await api.projects.create({ project: draft.slug, orgId: draft.org }))[Symbol.dispose]();
      state.creating = false;
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
    host.hidden = !view.projectHostnameBase;
    host.textContent = `Your project will be hosted at ${draft.slug || "my-project"}.${view.projectHostnameBase}`;
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
const mark = () => el("img", { class: "issuer-mark", src: "/iterate-logo.svg", alt: "" });

/** The onboarding step — a person with no project yet: their organization (its name; or, once
 *  they have one — a refused first try made it — the choice of it) and their first project's
 *  slug, one form; Continue makes both and the consent page follows. */
function renderOnboarding(view) {
  document.title = "Create a project — iterate";
  const { fields, slugField } = projectFields(view, { follow: true });
  const form = el("form", { id: "onboarding-form" });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    createProject();
  });
  form.append(
    ...fields,
    slugField,
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
    el("header", {}, mark(), el("h1", { text: "Create a project" })),
    signedInAs(view.email, view.picture),
    form,
  );
}

/** A request the authorization server refused outright (no client to send the person back to):
 *  the reason, and the way back to iterate. */
function renderInvalid(view) {
  document.title = "Invalid authorization request — iterate";
  card.className = "issuer-card";
  card.replaceChildren(
    mark(),
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
  if (!view.projectBound && !view.projects.length) return renderOnboarding(view);
  const { clientName, email, picture, projects, orgs, projectBound, scopes, denyLocation } = view;
  document.title = `Authorize ${clientName} — iterate`;
  const names = new Map(orgs.map((org) => [org.id, org.name]));
  const orgIds = [...new Set(projects.map((project) => project.orgId))];
  const form = el("form", { id: "consent-form" });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    approve();
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
  const status = el("p", { class: "muted", role: "status" });
  const approveButton = el("button", { class: "primary", type: "submit", text: "Approve" });

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
  const list = el("fieldset", { class: "consent-projects", "aria-label": "Projects it may reach" });
  const boxes = [];
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
            // the box carries the id (what the grant names); the person reads the slug
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
            boxes.push(box);
            return el(
              "label",
              { class: "consent-project" },
              box,
              el("span", { text: project.slug }),
            );
          }),
      ),
    );
  }
  if (projectBound && !projects.length)
    list.append(el("p", { class: "muted", text: "You do not have access to this app’s project." }));
  // The list as the state says: with "all" on, every box ticked and the list parked (its own
  // ticks kept in `excluded` for when it comes back); else each box its own tick, and the count.
  const show = () => {
    if (all) all.checked = state.all;
    for (const box of boxes) box.checked = state.all || !state.excluded.has(box.value);
    list.disabled = state.all;
    const count = boxes.filter((box) => box.checked).length;
    // the count of ticked projects; with "all" ticked the checkbox says it, so nothing else does
    status.hidden = !projects.length || state.all;
    status.textContent = `${count} selected`;
    approveButton.disabled = state.busy || (!state.all && count === 0);
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
    const { fields, slugField } = projectFields(view, { follow: false });
    const createButton = el("button", { type: "button", text: "Create project" });
    createButton.addEventListener("click", createProject);
    create = el(
      "section",
      { class: "consent-create", "aria-label": "New project" },
      el("h2", { text: "New project" }),
      el("div", { class: "consent-fields" }, slugField, ...fields),
      createButton,
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
          approveButton,
        ),
      ),
    ].filter(Boolean),
  );

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

act(refresh);
