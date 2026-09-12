/** A caller addressed a slug that the project directory has not registered yet. */
export class ItxProspectiveProjectError extends Error {
  constructor(slug: string) {
    super(
      `project "${slug}" does not exist — create it with session.projects.get(${JSON.stringify(slug)}).create({})`,
    );
    this.name = "ItxProspectiveProjectError";
  }
}
