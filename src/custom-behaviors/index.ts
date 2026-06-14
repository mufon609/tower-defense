import type { Registry, SystemFn, World } from "@gitcade/sdk";
import { num, str } from "@gitcade/sdk";

/**
 * Tower Defense's two custom systems. Both are written param-driven — every
 * balance value arrives via `$cfg` from config.json, none is hardcoded here — so
 * Tower Defense keeps 100% of its balance in config.json (the governance-flagship
 * requirement). Logged in games/LIBRARY-GAPS.md as generalization candidates
 * ("tap/click-to-place build system" and "event-driven economy/objective
 * counters").
 *
 * RESTART SAFETY: `loadScene` clears `world.state` and entities but NOT the event
 * bus, so a listener re-attached on every run would double-fire. Both systems
 * attach their listeners exactly once per World (see `attachOnce`) and read live
 * `world.state` on each event, so a "Play again" never double-counts.
 */

const ATTACHED = new WeakMap<World, Set<string>>();
function attachOnce(world: World, key: string, attach: () => void): void {
  let set = ATTACHED.get(world);
  if (!set) ATTACHED.set(world, (set = new Set()));
  if (set.has(key)) return;
  set.add(key);
  attach();
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Stamp the current upgraded range/cooldown onto a tower definition's turret. */
function stampDef(def: Record<string, unknown>, range: number, cooldown: number): void {
  const behaviors = (def.behaviors ?? []) as Array<{ type: string; params: Record<string, unknown> }>;
  for (const b of behaviors) {
    if (b.type === "ai-aim-and-fire") {
      b.params.range = range;
      b.params.cooldown = cooldown;
    }
  }
}

/** Re-stamp every live tower when an upgrade is bought (so upgrades are global). */
function restampTowers(world: World, towerTag: string, range: number, cooldown: number): void {
  for (const t of world.query(towerTag)) {
    for (const b of t.behaviors) {
      if (b.type === "ai-aim-and-fire") {
        (b.params as Record<string, unknown>).range = range;
        (b.params as Record<string, unknown>).cooldown = cooldown;
      }
    }
  }
}

/**
 * `tower-build` — consume a placement request (set by a map tap), validate funds
 * and the grid cell, and spawn an upgraded tower. Seeds the upgrade-affected
 * stats (`rangeKey`/`cooldownKey`/`bountyBonusKey`) from their `$cfg` base on the
 * first tick so the `upgrade-tree` can raise them.
 *
 * Params: `requestKey`, `currencyKey`, `towerCost` ($cfg), `tileSize` (structural),
 * `rangeKey`/`cooldownKey`/`bountyBonusKey`, `baseRange`/`baseCooldown` ($cfg),
 * `minCooldown` ($cfg), `towerTag`, `prototype` (tower entity-def), `stateKey`.
 */
export const towerBuild: SystemFn = (world, params) => {
  const reqKey = str(params, "requestKey", "placeRequest");
  const currencyKey = str(params, "currencyKey", "gold");
  const cost = num(params, "towerCost", 0);
  const tile = num(params, "tileSize", 48);
  const rangeKey = str(params, "rangeKey", "towerRange");
  const cooldownKey = str(params, "cooldownKey", "towerCooldown");
  const bountyBonusKey = str(params, "bountyBonusKey", "bountyBonus");
  const minCooldown = num(params, "minCooldown", 0.1);
  const towerTag = str(params, "towerTag", "tower");
  const stateKey = str(params, "stateKey", "__towerBuild");

  // Seed upgrade-affected stats once per run (idempotent; survives restart).
  const s = (world.state[stateKey] ??= { seeded: false }) as { seeded: boolean };
  if (!s.seeded) {
    s.seeded = true;
    if (typeof world.state[rangeKey] !== "number") world.state[rangeKey] = num(params, "baseRange", 0);
    if (typeof world.state[cooldownKey] !== "number") world.state[cooldownKey] = num(params, "baseCooldown", 0);
    if (typeof world.state[bountyBonusKey] !== "number") world.state[bountyBonusKey] = 0;
  }
  // Make upgrades global: re-stamp all towers when one is purchased (attach once).
  attachOnce(world, "upgrade-restamp", () => {
    world.events.on("upgrade-purchased", () => {
      const range = (world.state[rangeKey] as number) ?? 0;
      const cd = Math.max(minCooldown, (world.state[cooldownKey] as number) ?? 0);
      restampTowers(world, towerTag, range, cd);
    });
  });

  const req = world.state[reqKey] as { x: number; y: number } | null | undefined;
  if (!req || typeof req.x !== "number") return;
  world.state[reqKey] = null;

  const gold = (world.state[currencyKey] as number) ?? 0;
  if (gold < cost) {
    world.audio.play("lose");
    world.events.emit("build-denied", { reason: "funds" });
    return;
  }

  // Snap the tap to the centre of a grid cell.
  const gx = Math.floor(req.x / tile) * tile + tile / 2;
  const gy = Math.floor(req.y / tile) * tile + tile / 2;
  const occupied = world
    .query(towerTag)
    .some((t) => Math.abs(t.cx - gx) < tile * 0.5 && Math.abs(t.cy - gy) < tile * 0.5);
  if (occupied) {
    world.events.emit("build-denied", { reason: "occupied" });
    return;
  }

  const def = clone(params.prototype) as Record<string, unknown>;
  const size = (def.size ?? {}) as { w?: number; h?: number };
  const w = size.w ?? tile;
  const h = size.h ?? tile;
  def.position = { x: gx - w / 2, y: gy - h / 2 };
  stampDef(def, (world.state[rangeKey] as number) ?? 0, Math.max(minCooldown, (world.state[cooldownKey] as number) ?? 0));

  world.state[currencyKey] = gold - cost;
  const tower = world.spawn(def as never);
  world.audio.play("collect");
  world.events.emit("tower-placed", { id: tower.id, x: gx, y: gy });
};

/**
 * `creep-accounting` — the objective economy AND the self-consistent win signal.
 * Attaches once per World and, on each creep death/leak, awards the bounty
 * (+ the `bountyBonus` upgrade) and ratchets the `resolved`/`leaked` counters that
 * `win-lose-conditions` reads.
 *
 * TD2 — WIN is derived, never hand-computed. The old design won on
 * `resolved >= totalCreeps`, where `totalCreeps` was a standalone constant in
 * config.json that duplicated Σ waveSizeFor(1..maxWaves). That constant was
 * DECOUPLED from the spawner: any community rebalance of `waveSize` /
 * `waveSizeGrowth` / `maxWaves` that forgot to recompute it would either win early
 * or — if the true spawn count dropped below the constant — cap `resolved` under
 * the threshold so NEITHER win nor lose ever fired (a softlock bricking the
 * governance flagship). The fix removes the duplicate and drives the win off the
 * spawner's OWN signal:
 *   - the `wave-spawner` emits `waves-complete` exactly once, after the FINAL wave
 *     is fully spawned and the field is cleared — it cannot desync from
 *     waveSize/waveSizeGrowth/maxWaves because the same spawner computes both;
 *   - we additionally require the LIVE creep count to be 0 (the structural truth
 *     "no creeps remain alive") and that the player has not already lost.
 * When all three hold we publish the number of waves actually cleared into
 * `clearedKey`; `win-lose-conditions` then wins on `clearedWaves >= $cfg.maxWaves`.
 * Both sides reference the SAME spawner config, so no config edit can decouple the
 * win from the wave math. This preserves the original semantics exactly (survive
 * every wave, with leaks under `maxLeak`, to win) without any duplicated total.
 *
 * Params: `currencyKey`, `bounty` ($cfg), `bountyBonusKey`, `resolvedKey`,
 * `leakedKey`, `killEvent`, `leakEvent`, `creepTag`, `waveKey`, `clearedKey`,
 * `wavesCompleteEvent`, `stateKey`.
 */
export const creepAccounting: SystemFn = (world, params) => {
  const currencyKey = str(params, "currencyKey", "gold");
  const bounty = num(params, "bounty", 0);
  const bountyBonusKey = str(params, "bountyBonusKey", "bountyBonus");
  const resolvedKey = str(params, "resolvedKey", "resolved");
  const leakedKey = str(params, "leakedKey", "leaked");
  const killEvent = str(params, "killEvent", "creep-killed");
  const leakEvent = str(params, "leakEvent", "creep-leaked");
  // Win-derivation wiring (TD2). All strings — no balance literals here.
  const creepTag = str(params, "creepTag", "creep");
  const waveKey = str(params, "waveKey", "wave");
  const clearedKey = str(params, "clearedKey", "clearedWaves");
  const wavesCompleteEvent = str(params, "wavesCompleteEvent", "waves-complete");
  // Private scratch flag on world.state, so a `loadScene` ("Play again") clears it
  // and the restarted spawner re-emits `waves-complete` for the new run.
  const completeFlagKey = "__wavesComplete";

  attachOnce(world, "creep-accounting", () => {
    const bump = (key: string, by: number): void => {
      world.state[key] = ((world.state[key] as number) ?? 0) + by;
    };
    world.events.on(killEvent, () => {
      bump(currencyKey, bounty + ((world.state[bountyBonusKey] as number) ?? 0));
      bump(resolvedKey, 1);
    });
    world.events.on(leakEvent, () => {
      bump(leakedKey, 1);
      bump(resolvedKey, 1);
    });
    // The spawner's authoritative "every wave has now been spawned" signal.
    world.events.on(wavesCompleteEvent, () => {
      world.state[completeFlagKey] = true;
    });
  });

  // Self-consistent win: all waves spawned AND the field is empty AND not already
  // lost. `win-lose-conditions` (which runs after this system) reads `clearedKey`.
  // Guarded by `gameOver` so a leak that reached `maxLeak` (checked there, ordered
  // before the win condition) takes precedence and this never overrides a loss.
  if (
    !world.state.gameOver &&
    world.state[completeFlagKey] === true &&
    world.query(creepTag).length === 0
  ) {
    world.state[clearedKey] = (world.state[waveKey] as number) ?? 0;
  }
};

export function registerCustomBehaviors(registry: Registry): void {
  registry.registerSystem("tower-build", towerBuild);
  registry.registerSystem("creep-accounting", creepAccounting);
}
