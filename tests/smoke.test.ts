import { describe, it, expect } from "vitest";
import { createGame } from "@gitcade/sdk";
import { createLibraryRegistry } from "@gitcade/library";
import manifest from "../game.json";
import config from "../config.json";
import main from "../src/scenes/main.json";
import { registerCustomBehaviors } from "../src/custom-behaviors/index.js";

type Cfg = Record<string, number>;

/**
 * The headless smoke boot `gitcade validate` defers to (Tower Defense uses the
 * custom `tower-build` + `creep-accounting` systems). It exercises the whole loop
 * headlessly AND locks the TD2 invariant: the WIN is derived from the spawner
 * config (maxWaves + the live creep count), never a hand-computed creep total — so
 * a community rebalance of the wave params can neither win early nor softlock.
 */

/** Σ of the spawner's own wave-size formula over every wave — the TRUE creep
 * total for a given config. This is the number the old `totalCreeps` constant
 * duplicated by hand; here it is computed FROM config so the test cannot desync. */
function totalCreepsFor(cfg: Cfg): number {
  let sum = 0;
  for (let w = 1; w <= cfg.maxWaves; w++) {
    sum += Math.max(0, Math.round(cfg.waveSize + cfg.waveSizeGrowth * (w - 1)));
  }
  return sum;
}

function boot(cfg: Cfg) {
  const registry = createLibraryRegistry();
  registerCustomBehaviors(registry);
  const game = createGame({ manifest, config: cfg, scenes: [main] }, { canvas: null, registry });
  return { game, w: game.world };
}

// A spread of turret spots hugging the L-shaped path; enough firepower (+ upgrades)
// to clear the default difficulty. Distinct 40px grid cells.
const TOWER_SPOTS = [
  { x: 60, y: 170 }, { x: 140, y: 170 }, { x: 180, y: 170 },
  { x: 180, y: 230 }, { x: 180, y: 270 },
  { x: 260, y: 360 }, { x: 340, y: 360 }, { x: 420, y: 360 }, { x: 500, y: 360 },
  { x: 520, y: 400 }, { x: 520, y: 450 },
  { x: 620, y: 450 }, { x: 700, y: 450 }, { x: 780, y: 450 },
];
const UPGRADES = ["firerate", "range", "bounty"];

/** Drive a competent auto-player to game-over: build towers as gold allows and
 * sink surplus into upgrades. Deterministic (no gameplay RNG). */
function autoWin(cfg: Cfg, maxFrames = 40000) {
  const { game, w } = boot(cfg);
  let spot = 0;
  let upg = 0;
  let f = 0;
  while (!w.state.gameOver && f < maxFrames) {
    const gold = (w.state.gold as number) ?? 0;
    if (spot < TOWER_SPOTS.length && gold >= cfg.towerCost && !w.state.placeRequest) {
      w.state.placeRequest = TOWER_SPOTS[spot++];
    } else if (gold >= cfg.upgradeFirerateCost) {
      w.state.upgradeRequest = UPGRADES[upg++ % UPGRADES.length];
    }
    game.stepFrames(10);
    f += 10;
  }
  return { w, frames: f };
}

describe("tower-defense smoke", () => {
  it("spawns creeps, places a turret on tap, and runs without throwing", () => {
    const { game, w } = boot(config as Cfg);

    // Let the first wave begin.
    game.stepFrames(200);
    expect(w.query("creep").length).toBeGreaterThan(0);

    // Simulate a map tap → the build system spends gold and spawns a turret.
    const goldBefore = w.state.gold as number;
    w.state.placeRequest = { x: 300, y: 300 };
    game.stepFrames(5);
    expect(w.query("tower").length).toBe(1);
    expect(w.state.gold).toBe(goldBefore - (config as Cfg).towerCost);

    // Run the round out a bit; the turret fires and the loop stays stable.
    expect(() => game.stepFrames(500)).not.toThrow();
    expect(w.frame).toBe(705);
  });

  // ---- TD2: the win is self-consistent with the spawner config ----

  it("has NO standalone win total in config (the TD2 duplicate is gone)", () => {
    // The win must be derived from maxWaves + the live creep count, not a
    // hand-computed constant that can desync on a rebalance.
    expect(config).not.toHaveProperty("totalCreeps");
    expect(config).toHaveProperty("maxWaves");
  });

  it("WINS the default config by clearing every wave the spawner actually makes", () => {
    const cfg = config as Cfg;
    const { w } = autoWin(cfg);
    expect(w.state.gameOver).toBe(true);
    expect(w.state.outcome).toBe("win");
    expect(w.state.winner).toBe("player");
    // Win fired off maxWaves, not a constant.
    expect(w.state.clearedWaves).toBe(cfg.maxWaves);
    expect(w.state.wave).toBe(cfg.maxWaves);
    // INVARIANT: the win corresponds to the spawner's REAL total (Σ over the wave
    // formula), computed from config — proving win ↔ config coupling, no duplicate.
    expect(w.state.resolved).toBe(totalCreepsFor(cfg));
    expect(((w.state.leaked as number) ?? 0) < cfg.maxLeak).toBe(true);
  });

  it("footgun closed (REBALANCE UP): more/bigger waves win correctly — no premature win", () => {
    // Raise the spawn count WITHOUT touching any win value (there is none to touch).
    // Under the old `totalCreeps:140` constant this would have won EARLY at 140
    // resolved; the derived win must hold until ALL waves are truly cleared.
    const cfg: Cfg = { ...(config as Cfg), maxWaves: 12, waveSize: 7 };
    const trueTotal = totalCreepsFor(cfg); // 7+9+...+29 = 216, well past 140
    expect(trueTotal).toBeGreaterThan(140);
    const { w } = autoWin(cfg, 60000);
    expect(w.state.outcome).toBe("win");
    expect(w.state.clearedWaves).toBe(cfg.maxWaves);
    expect(w.state.resolved).toBe(trueTotal); // not 140 → no premature win
  });

  it("footgun closed (REBALANCE DOWN): fewer/smaller waves win correctly — no softlock", () => {
    // Lower the spawn count WITHOUT touching any win value. Under the old constant
    // `resolved` would cap at 24 < 140 so NEITHER win nor lose could ever fire — a
    // softlock. The derived win fires as soon as the (few) waves are cleared.
    const cfg: Cfg = { ...(config as Cfg), maxWaves: 4, waveSize: 3 };
    const trueTotal = totalCreepsFor(cfg); // 3+5+7+9 = 24
    expect(trueTotal).toBeLessThan(140);
    const { w } = autoWin(cfg, 20000);
    expect(w.state.outcome).toBe("win");
    expect(w.state.clearedWaves).toBe(cfg.maxWaves);
    expect(w.state.resolved).toBe(trueTotal);
  });

  it("LOSE still fires on a creep leak (no spurious win), default config", () => {
    // Build nothing → creeps leak → lose at maxLeak. The derived win must NOT fire
    // (waves never finish cleared with an empty field while losing).
    const cfg = config as Cfg;
    const { game, w } = boot(cfg);
    let f = 0;
    while (!w.state.gameOver && f < 40000) {
      game.stepFrames(50);
      f += 50;
    }
    expect(w.state.gameOver).toBe(true);
    expect(w.state.outcome).toBe("lose");
    expect(w.state.winner).toBe("creeps");
    expect(w.state.leaked as number).toBeGreaterThanOrEqual(cfg.maxLeak);
  });
});
