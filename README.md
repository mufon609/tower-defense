# Tower Defense — a GitCade ecosystem game (governance flagship)

Place turrets along the creep path, spend the gold from each kill on upgrades, and
hold the line through **10 escalating waves**. This is the **governance flagship**:
**100% of its balance lives in `config.json`** — there is not a single balance
number in the scenes or behaviors, which is exactly what makes a community vote a
one-line JSON diff.

## Play

```bash
npm install
npm run dev
npm run build
npm run validate   # also proves the no-magic-numbers rule: zero balance literals
```

- **Tap / click the map** to build a turret (50 gold).
- Each kill pays a **bounty**; spend it on the **Range / Fire rate / Bounty** bar.
- Let **15** creeps leak and you lose; clear all **10** waves to win.
- **Esc / P** to pause.

## What it's composed of

| Part | Source | Role |
|---|---|---|
| `wave-spawner@1.0.0` | library system | the 10 escalating creep waves |
| `follow-path@1.0.0` | library behavior | creeps walking the fixed waypoint path |
| `ai-aim-and-fire@1.0.0` | library behavior | turrets acquiring + firing at creeps in range |
| `contact-damage` + `health-and-death` | library behaviors | turret bullets damaging creeps; creep HP + death |
| `currency@1.0.0` | library system | the gold economy |
| `upgrade-tree@1.0.0` | library system | the Range / Fire-rate / Bounty upgrades (cost growth + max levels, all `$cfg`) |
| `win-lose-conditions@1.0.0` | library system | win on all creeps resolved, lose on too many leaks |
| `trigger-zone@1.0.0` | library behavior | the exit that leaks (and removes) a creep |
| `explosion@1.0.0` | library FX | the burst on every kill |

### The two custom systems

Placement and the objective economy are the only mechanics outside the library, in
[`src/custom-behaviors/`](src/custom-behaviors/index.ts) — **`tower-build`** (turns
a map tap into an affordability-checked, grid-snapped, upgrade-stamped turret) and
**`creep-accounting`** (bounty + win/lose counters on each kill/leak). Both are
fully param-driven (every number a `$cfg`) and restart-safe, and are logged in
[`../LIBRARY-GAPS.md`](../LIBRARY-GAPS.md) as generalization candidates.

## Rebalance it — every number is here

[`config.json`](config.json) holds **all** of it — economy, towers, creeps, waves,
and the upgrade tree. Nothing to hunt for in code.

### Worked example: make towers cheaper

The canonical governance demo — cut the tower price so defenses come up faster:

```diff
// config.json
-  "towerCost": 50,
+  "towerCost": 30
```

Re-run `npm run validate` → still publishable. That one-line diff is exactly what a
passed "make towers cheaper" proposal commits to `main` automatically. Try also:

```diff
-  "creepHp": 60,         // tankier creeps
+  "creepHp": 90,
-  "maxLeak": 15,         // less forgiving
+  "maxLeak": 8
```

## Fork it

Fork on GitCade, edit `config.json`, and your rebalanced branch is one-click
playable — and one-click comparable against the original. Code MIT; procedural art
CC-BY-4.0 (from `@gitcade/library`).
