export class Container {
  constructor() {
    throw new Error(`Container should not be instantiated in the CLI`);
  }
}

export const getContainer = () => {
  throw new Error(`getContainer should not be called in the CLI`);
};
