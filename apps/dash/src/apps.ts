/** The first-party apps the dash points at — each its own worker on its own origin, an ordinary OAuth
 *  client of the platform like the dash itself (the prd origins from the root envs.ts: agentsEnvs,
 *  notesEnvs, voiceEnvs). Nothing here is required for the dash to work; it is a directory. */
export const APPS = [
  {
    name: "Agents",
    url: "https://agents.iterate.workers.dev",
    blurb:
      "Talk to a project's agents: the feed, the scripts they run, the trace of every request.",
  },
  {
    name: "Notes",
    url: "https://notes.iterate.workers.dev",
    blurb: "A page of notes per project, kept in the project's workspace.",
  },
  {
    name: "Voice",
    url: "https://voice.iterate.com",
    blurb: "A phone in the browser: press, talk to a project's voice agent.",
  },
] as const;
