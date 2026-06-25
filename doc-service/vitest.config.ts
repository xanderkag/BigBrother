import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // ui/ — отдельный фронтенд-пакет со своим раннером (node:test); его
    // *.test.ts backend-vitest запускать не должен (иначе Failed Suite —
    // node:test несовместим с vitest-загрузчиком).
    exclude: [...configDefaults.exclude, 'ui/**'],

    // Runs once per test file before that file's import graph is evaluated,
    // so env is set before config.ts's module-level loadConfig() runs.
    // See vitest.setup.ts for the full rationale (ESM import hoisting).
    setupFiles: ['./vitest.setup.ts'],

    // `forks` isolates each test file in its own process. pdfkit/pdf-parse
    // (pdf-text-pages.spec.ts) and other native deps can crash a shared
    // worker; per-file fork isolation keeps one bad file from poisoning the
    // run. The cost is modest for this suite size.
    pool: 'forks',
  },
});
