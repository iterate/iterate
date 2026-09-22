import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["src/next/**/*.test.{ts,tsx}"] } });
