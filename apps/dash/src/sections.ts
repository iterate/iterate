// The dash's map of a project — the sections apps/os has, as ONE registry: the sidebar's project
// navigation, the breadcrumb labels, the overview's cards and the placeholder pages all read it.
// A section fills in over time; until it does, its page says where the thing lives today.
import {
  Box,
  CalendarClock,
  FolderTree,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  MessageCircle,
  Plug,
  Radio,
  Settings2,
  SquareTerminal,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { APPS } from "./apps.ts";

export type ProjectSection = {
  /** the path segment under /projects/<project>/ */
  id: string;
  label: string;
  icon: LucideIcon;
  /** one line on the overview card and the placeholder page */
  blurb: string;
  /** where this lives today, while the dash's page is a placeholder */
  today?: { label: string; href: string };
};

const agents = APPS.find((app) => app.name === "Agents")!;
const notes = APPS.find((app) => app.name === "Notes")!;

/** The project's overview: not a section, the page at /projects/<project>/. */
export const OVERVIEW = { id: "", label: "Overview", icon: LayoutDashboard } as const;

export const PROJECT_SECTIONS: readonly ProjectSection[] = [
  {
    id: "agents",
    label: "Agents",
    icon: MessageCircle,
    blurb:
      "Every agent is a conversation on its own path: the feed, the scripts it ran, the trace.",
    today: { label: "the Agents app", href: agents.url },
  },
  {
    id: "streams",
    label: "Streams",
    icon: Radio,
    blurb: "Every context is an event log — read it, follow it live, append to it.",
  },
  {
    id: "repos",
    label: "Repos",
    icon: GitBranch,
    blurb: "The project's repositories: the config repo that is its code, and the rest.",
  },
  {
    id: "workspaces",
    label: "Workspaces",
    icon: FolderTree,
    blurb: "Files and notes the project keeps, edited in place.",
    today: { label: "the Notes app", href: notes.url },
  },
  {
    id: "secrets",
    label: "Secrets",
    icon: KeyRound,
    blurb: "Keys and OAuth connections the project's code reads, never shown twice.",
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: Plug,
    blurb: "Slack, GitHub, Google and the rest: fetch functions with a credential.",
  },
  {
    id: "scheduler",
    label: "Scheduler",
    icon: CalendarClock,
    blurb: "Appends the project has scheduled for later, and what woke it last.",
  },
  {
    id: "reactivity",
    label: "Reactivity",
    icon: Zap,
    blurb: "Which events wake which processors — the project's subscriptions and rewrite rules.",
  },
  {
    id: "sandboxes",
    label: "Sandboxes",
    icon: Box,
    blurb: "Isolates the project ran its code in, and what they cost.",
  },
  {
    id: "repl",
    label: "REPL",
    icon: SquareTerminal,
    blurb: "One `itx` expression at a time, against the live project.",
  },
  {
    id: "settings",
    label: "Settings",
    icon: Settings2,
    blurb: "The project's hosts, its members, and how it is named.",
  },
];

export const sectionById = (id: string) => PROJECT_SECTIONS.find((section) => section.id === id);
