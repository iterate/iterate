// @vitest-environment jsdom
// ⌘K's rows: how typing narrows them, and reading the sidebar's navigation off its rendered markup
// (the data-slot attributes packages/ui's sidebar.tsx stamps).
import { expect, test } from "vitest";
import {
  filterPaletteEntries,
  readSidebarNav,
  UNLABELLED_NAV_GROUP,
  withoutProjectLinks,
  type PaletteEntry,
} from "./app-shell-palette-entries.ts";

const entries = [
  row("Overview", "Pages"),
  row("MCP", "Pages"),
  row("Secrets", "Pages"),
  row("acme-site", "Projects", "Acme"),
  row("secret-garden", "Projects", "Globex"),
  row("globex-api", "Projects", "Globex"),
];

test("an empty query lists every row, grouped in order of first appearance", () => {
  expect(labels(filterPaletteEntries(entries, "  "))).toEqual([
    ["Pages", ["Overview", "MCP", "Secrets"]],
    ["Projects", ["acme-site", "secret-garden", "globex-api"]],
  ]);
});

test("matches case-insensitively anywhere in the label; a heading with no match is left out", () => {
  expect(labels(filterPaletteEntries(entries, "SITE"))).toEqual([["Projects", ["acme-site"]]]);
});

test("a label that starts with the query comes first within its heading", () => {
  expect(labels(filterPaletteEntries(entries, "g"))).toEqual([
    ["Projects", ["globex-api", "secret-garden"]],
  ]);
});

test("every term must match, in the label or the detail — not the heading", () => {
  expect(labels(filterPaletteEntries(entries, "globex secret"))).toEqual([
    ["Projects", ["secret-garden"]],
  ]);
  expect(filterPaletteEntries(entries, "pages")).toEqual([]);
});

test("nothing matches: no groups", () => {
  expect(filterPaletteEntries(entries, "zzz")).toEqual([]);
});

test("reads menu buttons and sub-buttons with their group, parent, active state and href", () => {
  const content = document.createElement("div");
  content.innerHTML = `
    <div data-slot="sidebar-group">
      <ul data-slot="sidebar-menu">
        <li data-slot="sidebar-menu-item">
          <a data-slot="sidebar-menu-button" data-active href="/projects/acme"><svg></svg><span>Overview</span></a>
        </li>
        <li data-slot="sidebar-menu-item">
          <button data-slot="sidebar-menu-button" type="button"><svg></svg><span>New agent</span></button>
        </li>
        <li data-slot="sidebar-menu-item">
          <button data-slot="sidebar-menu-button" type="button" disabled><span>Creating…</span></button>
        </li>
      </ul>
    </div>
    <div data-slot="sidebar-group">
      <div data-slot="sidebar-group-label">Your organizations</div>
      <ul data-slot="sidebar-menu">
        <li data-slot="sidebar-menu-item">
          <a data-slot="sidebar-menu-button" href="/organizations/org_1"><span>Acme</span></a>
          <ul data-slot="sidebar-menu-sub">
            <li data-slot="sidebar-menu-sub-item">
              <a data-slot="sidebar-menu-sub-button" href="/projects/acme-site"><span>acme-site</span></a>
            </li>
          </ul>
        </li>
        <li data-slot="sidebar-menu-item">
          <a data-slot="sidebar-menu-button" href="https://agents.example.com" aria-label="Agents"><svg></svg></a>
        </li>
      </ul>
    </div>
    <div data-slot="sidebar-group">
      <div data-slot="sidebar-group-label"><span>Agents</span><span>2 active or waiting</span></div>
      <ul data-slot="sidebar-menu">
        <li data-slot="sidebar-menu-item">
          <a data-slot="sidebar-menu-button" href="/projects/acme?agent=/agents/web/a"><span><svg></svg><span aria-label="Running"></span></span><span><span>Fix the build</span><span>/agents/web/a</span></span></a>
          <button type="button" data-sidebar="menu-action" aria-label="Pin agent"><svg></svg></button>
        </li>
      </ul>
    </div>
  `;
  expect(
    readSidebarNav(content).map(({ element, ...item }) => ({ tag: element.tagName, ...item })),
  ).toEqual([
    {
      tag: "A",
      label: "Overview",
      group: UNLABELLED_NAV_GROUP,
      detail: undefined,
      active: true,
      href: "http://localhost:3000/projects/acme",
    },
    {
      tag: "BUTTON",
      label: "New agent",
      group: UNLABELLED_NAV_GROUP,
      detail: undefined,
      active: false,
      href: undefined,
    },
    {
      tag: "A",
      label: "Acme",
      group: "Your organizations",
      detail: undefined,
      active: false,
      href: "http://localhost:3000/organizations/org_1",
    },
    {
      tag: "A",
      label: "acme-site",
      group: "Your organizations",
      detail: "Acme",
      active: false,
      href: "http://localhost:3000/projects/acme-site",
    },
    {
      tag: "A",
      label: "Agents",
      group: "Your organizations",
      detail: undefined,
      active: false,
      href: "https://agents.example.com/",
    },
    {
      tag: "A",
      label: "Fix the build",
      group: "Agents",
      detail: "/agents/web/a",
      active: false,
      href: "http://localhost:3000/projects/acme?agent=/agents/web/a",
    },
  ]);
});

test("a sidebar link to a project under its slug is its project row; a page at its URL stays", () => {
  const content = document.createElement("div");
  content.innerHTML = `
    <a data-slot="sidebar-menu-button" href="/projects/acme-site"><span>Overview</span></a>
    <a data-slot="sidebar-menu-sub-button" href="/projects/acme-site"><span>acme-site</span></a>
    <a data-slot="sidebar-menu-sub-button" href="/projects/globex"><span>globex</span></a>
  `;
  expect(
    withoutProjectLinks(readSidebarNav(content), [
      { label: "acme-site", href: "http://localhost:3000/projects/acme-site" },
    ]).map((item) => item.label),
  ).toEqual(["Overview", "globex"]);
});

test("a phone's sidebar sheet, closed (not mounted) or open: nothing to list", () => {
  expect(readSidebarNav(null)).toEqual([]);
  const sheet = document.createElement("div");
  sheet.dataset.mobile = "true";
  sheet.innerHTML = `<div><a data-slot="sidebar-menu-button" href="/projects/acme"><span>Overview</span></a></div>`;
  expect(readSidebarNav(sheet.firstElementChild)).toEqual([]);
});

function row(label: string, group: string, detail?: string): PaletteEntry {
  return { id: `${group}:${label}`, label, group, detail, active: false };
}

function labels(groups: ReturnType<typeof filterPaletteEntries>) {
  return groups.map(({ group, entries }) => [group, entries.map((entry) => entry.label)]);
}
