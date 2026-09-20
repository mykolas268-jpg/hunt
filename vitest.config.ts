import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: { globals: true, environment: "node", include: ["**/*.test.ts"] },
  resolve: {
    alias: { "~": fileURLToPath(new URL("./app", import.meta.url)) },
  },
});
