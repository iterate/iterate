function productionOnlyOnce() {
  return "production";
}

export const productionLintProof: string = productionOnlyOnce() as string;
