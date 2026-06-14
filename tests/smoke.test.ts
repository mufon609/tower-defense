import { describe, it, expect } from "vitest";
import { createGame } from "@gitcade/sdk";
import { createLibraryRegistry } from "@gitcade/library";
import manifest from "../game.json";
import config from "../config.json";
import main from "../src/scenes/main.json";
import { registerCustomBehaviors } from "../src/custom-behaviors/index.js";

/**
 * The headless smoke boot `gitcade validate` defers to (Tower Defense uses the
 * custom `tower-build` + `creep-accounting` systems). Exercises the whole loop
 * headlessly: creeps spawn and walk the path, a placed turret spends gold and
 * shoots, and the economy/objective counters tick — all without throwing.
 */
describe("tower-defense smoke", () => {
  it("spawns creeps, places a turret on tap, and runs without throwing", () => {
    const registry = createLibraryRegistry();
    registerCustomBehaviors(registry);
    const game = createGame({ manifest, config, scenes: [main] }, { canvas: null, registry });
    const w = game.world;

    // Let the first wave begin.
    game.stepFrames(200);
    expect(w.query("creep").length).toBeGreaterThan(0);

    // Simulate a map tap → the build system spends gold and spawns a turret.
    const goldBefore = w.state.gold as number;
    w.state.placeRequest = { x: 300, y: 300 };
    game.stepFrames(5);
    expect(w.query("tower").length).toBe(1);
    expect(w.state.gold).toBe(goldBefore - (config as Record<string, number>).towerCost);

    // Run the round out a bit; the turret fires and the loop stays stable.
    expect(() => game.stepFrames(500)).not.toThrow();
    expect(w.frame).toBe(705);
  });
});
