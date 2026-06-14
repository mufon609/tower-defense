/**
 * Copy the procedurally-generated art that ships inside the pinned
 * @gitcade/library into this game's public/assets, so library entities resolve
 * their sprite `src` (e.g. "assets/sprites/coin.png") when served.
 *
 * The assets are the library's, not this repo's — they are gitignored here and
 * recreated from node_modules at dev/build/test time. The GitCade build worker
 * runs this on `prebuild` from a clean clone after installing the pinned library.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = resolve(root, "node_modules/@gitcade/library/assets");
const dest = resolve(root, "public/assets");

if (!existsSync(src)) {
  console.warn(`[sync-assets] @gitcade/library assets not found at ${src} — run npm install first.`);
  process.exit(0);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[sync-assets] copied library assets -> ${dest}`);
