import { defineConfig } from "vite";

// Static build: `npm run build` outputs a self-contained /dist the GitCade build
// worker uploads as the game artifact. Relative base so the artifact server can
// serve it from /artifacts/{game}/{branch}/ without absolute-path breakage.
// `public/assets` (synced from @gitcade/library by scripts/sync-assets.mjs) is
// copied into dist automatically by Vite.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2021",
  },
});
