import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const resolvePath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // @netiflyjs/react and @netiflyjs/client ship CJS (the repo-wide
      // convention — every package builds via plain tsc). Rollup's static
      // CJS→ESM interop doesn't reliably resolve their re-export barrel
      // (index.ts re-exporting via a getter into another CJS file) for a
      // pnpm workspace symlink. Aliasing straight to TS source sidesteps
      // that: esbuild compiles it to real ESM directly, with no CJS
      // artifact in between — and as a bonus, `pnpm dev` picks up library
      // changes immediately, with no `pnpm build` step first.
      '@netiflyjs/react': resolvePath('../../packages/react/src/index.ts'),
      '@netiflyjs/client': resolvePath('../../packages/client/src/index.ts'),
    },
  },
});
