/**
 * Storage adapter selection — the ONLY persistence path a GitCade ecosystem game
 * may use (the raw browser key-value stores fail validation by design).
 *
 * In production the game runs in an opaque-origin iframe where the raw browser
 * stores throw; it uses {@link BridgeStorage} to post saves to the GitCade parent
 * page, which persists them namespaced by `gameSlug + branch` (Phase 4B implements
 * that parent side). Standalone (`npm run dev`, or any non-GitCade host) it falls
 * back to the in-memory dev-shim. Either way the game only ever talks to
 * `world.storage`, so no game code changes between the two.
 */
import { MemoryStorage, BridgeStorage, type StorageAdapter } from "@gitcade/sdk";

export function makeStorage(gameSlug: string): StorageAdapter {
  if (typeof window !== "undefined" && window.parent && window.parent !== window) {
    try {
      const branch = (window as unknown as { __GITCADE_BRANCH?: string }).__GITCADE_BRANCH ?? "main";
      return new BridgeStorage({ parent: window.parent, host: window, gameSlug, branch });
    } catch {
      /* fall through to the dev shim */
    }
  }
  return new MemoryStorage();
}
