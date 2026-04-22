import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "apps/trace-parser",
      "packages/db",
      "packages/adapters/codex-local",
      "packages/adapters/opencode-local",
      "server",
      "ui",
      "cli",
    ],
  },
});
