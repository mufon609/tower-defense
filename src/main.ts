/**
 * Tower Defense bootstrap (host glue). The GAME is data — game.json + config.json
 * + src/scenes/main.json composing @gitcade/library + SDK parts and two custom
 * systems (`tower-build`, `creep-accounting`). 100% of the balance is in
 * config.json; this file only wires input/UI to the runtime + the shared GameShell:
 *   - tap the map → set `world.state.placeRequest` (the build system does the rest)
 *   - the upgrade bar → set `world.state.upgradeRequest` (the upgrade-tree applies it)
 */
import { createGame } from "@gitcade/sdk";
import { createLibraryRegistry, LibraryAudioPlayer } from "@gitcade/library";
import manifest from "../game.json";
import config from "../config.json";
import main from "./scenes/main.json";
import { registerCustomBehaviors } from "./custom-behaviors/index.js";
import { GameShell } from "./host/shell.js";
import { makeStorage } from "./host/storage.js";

const registry = createLibraryRegistry();
registerCustomBehaviors(registry);

const audio = new LibraryAudioPlayer();
const canvas = document.getElementById("game") as HTMLCanvasElement;
const menu = document.getElementById("menu") as HTMLElement;
const game = createGame(
  { manifest, config, scenes: [main] },
  { canvas, registry, audio, storage: makeStorage(manifest.slug) },
);
const world = game.world;
const playing = () => menu.style.display === "none";

// Tap/click the map to request a tower at that world position (only while playing).
canvas.addEventListener("pointerdown", (e) => {
  if (!playing()) return;
  const rect = canvas.getBoundingClientRect();
  world.state.placeRequest = {
    x: (e.clientX - rect.left) * (800 / rect.width),
    y: (e.clientY - rect.top) * (600 / rect.height),
  };
});

// The upgrade bar → upgrade-tree requests.
document.querySelectorAll<HTMLButtonElement>("#tdbar button[data-up]").forEach((b) => {
  b.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (playing()) world.state.upgradeRequest = b.dataset.up!;
  });
});

new GameShell({
  game,
  audio,
  music: "action",
  title: "TOWER DEFENSE",
  tagline: "Hold the line for 10 waves.",
  howto: [
    "Tap the map to build a turret (50 gold)",
    "Each kill pays a bounty — spend it on the upgrade bar",
    "Let 15 creeps leak and you lose; clear all 10 waves to win",
  ],
  gameOverEvent: "gameover",
  outcomeText: (w) => {
    const won = w.state.outcome === "win";
    return `${won ? "The line held! 🛡️" : "Overrun"}  •  Wave ${num(w.state.wave)}  •  Leaked ${num(w.state.leaked)}`;
  },
  screenFx: {
    "creep-killed": (fx) => fx.shake(3, 0.1, 50),
    "creep-leaked": (fx) => fx.flash("#b13e53", 0.18),
    gameover: (fx) => fx.shake(12, 0.45, 36),
  },
  onEnterPlay: (w) => {
    w.state.leaked = 0;
    w.state.resolved = 0;
  },
});

function num(v: unknown): number {
  return typeof v === "number" ? Math.round(v) : 0;
}
