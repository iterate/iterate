export const isProduction = ["prd", "production", "prod"].includes(import.meta.env?.VITE_APP_STAGE);
export const isNonProd = !isProduction;
