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
 * `creep-accounting` — the objective economy. Attaches once per World and, on each
 * creep death/leak, awards the bounty (+ the `bountyBonus` upgrade) and ratchets
 * the `resolved`/`leaked` counters that `win-lose-conditions` reads. No per-tick
 * work after attaching.
 *
 * Params: `currencyKey`, `bounty` ($cfg), `bountyBonusKey`, `resolvedKey`,
 * `leakedKey`, `killEvent`, `leakEvent`, `stateKey`.
 */
export const creepAccounting: SystemFn = (world, params) => {
  const currencyKey = str(params, "currencyKey", "gold");
  const bounty = num(params, "bounty", 0);
  const bountyBonusKey = str(params, "bountyBonusKey", "bountyBonus");
  const resolvedKey = str(params, "resolvedKey", "resolved");
  const leakedKey = str(params, "leakedKey", "leaked");
  const killEvent = str(params, "killEvent", "creep-killed");
  const leakEvent = str(params, "leakEvent", "creep-leaked");

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
  });
};

export function registerCustomBehaviors(registry: Registry): void {
  registry.registerSystem("tower-build", towerBuild);
  registry.registerSystem("creep-accounting", creepAccounting);
}
