import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // The git-heavy cache/integration tests take several seconds each and can
    // exceed the 5s default under full parallel load — looking like flaky
    // "contention" when it is really a timeout. Set it here (not only in the
    // package.json script flags) so a bare `vitest run` is robust too.
    testTimeout: 15000,
  },
});
