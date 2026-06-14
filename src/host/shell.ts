/**
 * GameShell — the host-side application chrome shared by every GitCade seed game.
 *
 * This is HOST GLUE, not game logic and not a custom behavior: the validated game
 * (game.json + config.json + src/scenes/*.json) is pure SDK + @gitcade/library
 * composition. The shell owns the things that live OUTSIDE a validated scene —
 * the screen-state machine (title → playing ⇄ paused → game-over), the HTML menu
 * overlays, the mobile touch pad, the library audio + screen-effects wiring, and a
 * per-frame HUD mirror hook.
 *
 * It deliberately persists NOTHING through raw browser stores — high scores and
 * offline progress go through `world.storage` (the SDK bridge) inside the scene's
 * parts or the game's own `main.ts`, so branch/fork switching never corrupts saves.
 *
 * The shell runs its OWN fixed-step loop (it does not call `game.start()`): that
 * lets it freeze the simulation on pause while still rendering the frozen frame
 * under the overlay, and run a `beforeFrame` hook (e.g. mirror player HP into a
 * HUD state key) every frame.
 */
import type { Game, World } from "@gitcade/sdk";
import { LibraryAudioPlayer, ScreenEffects, attachScreenEffects } from "@gitcade/library";

const FIXED_DT = 1 / 60;
const MAX_FRAME = 0.25;

type ScreenState = "title" | "playing" | "paused" | "gameover";

/** One on-screen touch button that synthesizes a keyboard event the parts already read. */
export interface TouchControl {
  /** `KeyboardEvent.code` to synthesize while pressed (e.g. "ArrowUp", "Space"). */
  code: string;
  /** Glyph shown on the button. */
  label: string;
  /** Grid cell "row / col" in the 3×3 touch pad (1-based), e.g. "1 / 2" for up. */
  cell: string;
  /** Accent color (defaults to the library indigo). */
  color?: string;
}

export interface ShellOptions {
  game: Game;
  audio: LibraryAudioPlayer;
  /** Generative music loop to start on first gesture. Omit for silence. */
  music?: "action" | "menu";
  /** Title-screen heading. */
  title: string;
  /** One-line tagline under the title. */
  tagline: string;
  /** How-to-play lines shown on the title screen. */
  howto: string[];
  /** Event name that ends a run (default "gameover"). Emitted by win-lose-conditions/timer/lives. */
  gameOverEvent?: string;
  /** Headline shown on the game-over card (e.g. "You scored 240"). */
  outcomeText?: (world: World) => string;
  /** Map of game event → screen effect, wired to the world's event bus. */
  screenFx?: Record<string, (fx: ScreenEffects, data: unknown) => void>;
  /** Touch-pad buttons (shown on coarse-pointer devices). Empty = no pad. */
  touch?: TouchControl[];
  /** Seed world.state on every (re)start, before the first frame. */
  onEnterPlay?: (world: World) => void;
  /** Runs every rendered frame (HUD mirroring, custom overlays). */
  beforeFrame?: (world: World) => void;
}

export class GameShell {
  private state: ScreenState = "title";
  private acc = 0;
  private last = 0;
  private readonly entrySceneId: string;
  private readonly opts: ShellOptions;
  private readonly world: World;
  private readonly canvas: HTMLCanvasElement;
  private readonly menu: HTMLElement;
  private readonly fx = new ScreenEffects();
  private readonly heldCodes = new Set<string>();

  constructor(opts: ShellOptions) {
    this.opts = opts;
    this.world = opts.game.world;
    this.entrySceneId = opts.game.scene.id;

    this.canvas = mustEl<HTMLCanvasElement>("game");
    this.menu = mustEl("menu");

    // Input: attach to the window (keys) + canvas (pointers), same as game.start().
    this.world.input.attach({ keyTarget: window, pointerTarget: this.canvas });

    // Screen effects: bind gameplay events → shake/flash, and drive the overlay.
    if (opts.screenFx) this.fx.bindToEvents(this.world, opts.screenFx);
    attachScreenEffects(this.fx, this.canvas, document.getElementById("fx-overlay"));

    // End-of-run: the scene's rules part emits this; we freeze and show the card.
    this.world.events.on(opts.gameOverEvent ?? "gameover", () => this.toGameOver());

    this.buildTouchPad();
    this.bindKeys();
    const pauseBtn = document.getElementById("pause-btn");
    if (pauseBtn) pauseBtn.onclick = () => this.togglePause();
    this.bindAudioGesture();
    this.showTitle();

    // Our own loop (not game.start()) so pause can freeze sim yet keep rendering.
    this.last = perfNow();
    requestAnimationFrame(this.frame);
  }

  // --- the loop ---------------------------------------------------------------

  private frame = (): void => {
    const now = perfNow();
    const dt = Math.min((now - this.last) / 1000, MAX_FRAME);
    this.last = now;

    if (this.state === "playing") {
      this.acc += dt;
      while (this.acc >= FIXED_DT && this.state === "playing") {
        this.opts.game.update(FIXED_DT);
        this.acc -= FIXED_DT;
      }
    }
    this.opts.beforeFrame?.(this.world);
    this.opts.game.render();
    requestAnimationFrame(this.frame);
  };

  // --- state transitions ------------------------------------------------------

  private startRun(): void {
    this.opts.game.loadScene(this.entrySceneId); // resets entities + world.state
    this.opts.onEnterPlay?.(this.world);
    this.acc = 0;
    this.last = perfNow();
    this.state = "playing";
    this.hideMenu();
    this.fx.flash("#f4f4f4", 0.1);
  }

  private togglePause(): void {
    if (this.state === "playing") {
      this.state = "paused";
      this.showPause();
    } else if (this.state === "paused") {
      this.state = "playing";
      this.last = perfNow();
      this.hideMenu();
    }
  }

  private toGameOver(): void {
    if (this.state !== "playing") return;
    this.state = "gameover";
    this.fx.shake(10, 0.4, 36);
    this.showGameOver();
  }

  // --- menu rendering (HTML overlay) ------------------------------------------

  private showTitle(): void {
    const how = this.opts.howto.map((l) => `<li>${esc(l)}</li>`).join("");
    this.menu.innerHTML = `
      <div class="card">
        <h1>${esc(this.opts.title)}</h1>
        <p class="tag">${esc(this.opts.tagline)}</p>
        <ul class="howto">${how}</ul>
        <button class="primary" data-act="play">▶ Play</button>
        <p class="hint">Space / Enter to start • Esc or P to pause</p>
      </div>`;
    this.showMenu();
  }

  private showPause(): void {
    this.menu.innerHTML = `
      <div class="card">
        <h1>Paused</h1>
        <button class="primary" data-act="resume">Resume</button>
        <button data-act="title">Quit to title</button>
      </div>`;
    this.showMenu();
  }

  private showGameOver(): void {
    const outcome = this.opts.outcomeText?.(this.world) ?? "Game over";
    this.menu.innerHTML = `
      <div class="card">
        <h1>Game Over</h1>
        <p class="outcome">${esc(outcome)}</p>
        <button class="primary" data-act="play">↻ Play again</button>
        <button data-act="title">Title</button>
      </div>`;
    this.showMenu();
  }

  private showMenu(): void {
    this.menu.style.display = "grid";
    this.menu.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((b) => {
      b.onclick = () => this.onMenuAction(b.dataset.act!);
    });
  }

  private hideMenu(): void {
    this.menu.style.display = "none";
  }

  private onMenuAction(act: string): void {
    this.resumeAudio();
    if (act === "play" || act === "resume") {
      if (act === "resume") this.togglePause();
      else this.startRun();
    } else if (act === "title") {
      this.state = "title";
      this.showTitle();
    }
  }

  // --- input chrome -----------------------------------------------------------

  private bindKeys(): void {
    window.addEventListener("keydown", (e) => {
      if (e.code === "Escape" || e.code === "KeyP") {
        if (this.state === "playing" || this.state === "paused") {
          e.preventDefault();
          this.togglePause();
        }
        return;
      }
      if (e.code === "Space" || e.code === "Enter") {
        if (this.state === "title" || this.state === "gameover") {
          e.preventDefault();
          this.startRun();
        }
      }
    });
  }

  /** Build the on-screen touch pad. Each button synthesizes a real keydown/keyup. */
  private buildTouchPad(): void {
    const pad = document.getElementById("touch");
    if (!pad || !this.opts.touch || this.opts.touch.length === 0) return;
    pad.innerHTML = "";
    for (const t of this.opts.touch) {
      const b = document.createElement("button");
      b.className = "tbtn";
      b.textContent = t.label;
      b.style.gridArea = t.cell;
      if (t.color) b.style.background = t.color;
      const down = (ev: Event) => {
        ev.preventDefault();
        this.resumeAudio();
        this.synthKey("keydown", t.code);
      };
      const up = (ev: Event) => {
        ev.preventDefault();
        this.synthKey("keyup", t.code);
      };
      b.addEventListener("pointerdown", down);
      b.addEventListener("pointerup", up);
      b.addEventListener("pointercancel", up);
      b.addEventListener("pointerleave", up);
      pad.appendChild(b);
    }
  }

  private synthKey(type: "keydown" | "keyup", code: string): void {
    if (type === "keydown") {
      if (this.heldCodes.has(code)) return;
      this.heldCodes.add(code);
    } else {
      this.heldCodes.delete(code);
    }
    window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
  }

  // --- audio ------------------------------------------------------------------

  private audioStarted = false;
  private bindAudioGesture(): void {
    const go = () => this.resumeAudio();
    window.addEventListener("pointerdown", go, { once: false });
    window.addEventListener("keydown", go, { once: false });
  }

  private resumeAudio(): void {
    this.opts.audio.resume();
    if (!this.audioStarted && this.opts.music) {
      this.opts.audio.startMusic(this.opts.music);
      this.audioStarted = true;
    }
  }
}

// --- helpers ------------------------------------------------------------------

function perfNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function mustEl<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id} element in index.html`);
  return el as T;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
