import { defineConfig } from "vitest/config";

// Two environments, split by extension. Node for the logic tests, jsdom for the
// component tests that render.
//
// This used to be one project with `include: ["**/*.test.ts"]`, which does not
// match `.test.tsx` — so every component test was collected by nothing and
// passed by never running. Widening the glob alone is not enough: those tests
// render React, and `environment: "node"` has no DOM. Splitting keeps the 161
// existing node tests on the environment they were written for instead of
// migrating them all to jsdom for the sake of two files.
const shared = {
  exclude: ["node_modules/**", ".next/**"],
  globals: false,
};

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    projects: [
      {
        resolve: { tsconfigPaths: true },
        test: { ...shared, name: "node", environment: "node", include: ["**/*.test.ts"] },
      },
      {
        resolve: { tsconfigPaths: true },
        test: {
          ...shared,
          name: "dom",
          environment: "jsdom",
          include: ["**/*.test.tsx"],
          // `globals: false` means testing-library cannot register its own
          // afterEach, so each render would stack on the last one's DOM.
          setupFiles: ["./vitest.setup.dom.ts"],
        },
      },
    ],
  },
});
