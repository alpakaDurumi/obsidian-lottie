import {
  App,
  Component,
  FileView,
  MarkdownRenderChild,
  MarkdownView,
  Plugin,
  PluginSettingTab,
  type SettingDefinitionItem,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
  debounce,
  setIcon,
} from "obsidian";
import ThorVG, {
  type Canvas,
  type LottieAnimation,
  type Picture,
  type RendererType,
  type ThorVGNamespace,
} from "@thorvg/webcanvas";
import thorvgWasm from "thorvg-wasm";

/**
 * The size an `![[…|300]]` or `![[…|300x200]]` alias asks for.
 *
 * Obsidian parses the alias itself and puts the result on the embed container
 * as `width`/`height` attributes — in reading view through the markdown node's
 * hProperties, in Live Preview through the widget's applyTitle(). For images it
 * then copies them onto the `<img>`; nothing does that for our canvas, so the
 * attributes are read back here. A missing or unparsable size leaves them off.
 */
function requestedSize(el: HTMLElement): { width: number; height: number } {
  const read = (name: string) => {
    const value = Number.parseInt(el.getAttribute(name) ?? "", 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  return { width: read("width"), height: read("height") };
}

/** Alignment keywords understood in an embed's alias. */
const ALIGNMENTS = ["left", "center", "right"] as const;
type Alignment = (typeof ALIGNMENTS)[number];

/**
 * The alignment an `![[…|center]]` alias asks for, or null for none.
 *
 * Anything Obsidian could not read as a size is left in `alt`, `|`-separated
 * and otherwise untouched — `![[a.json|center|border]]` arrives as
 * `"center|border"`, and a plain embed arrives as the file name. Alignment is
 * therefore matched against whole segments, so a file called `centerpiece.json`
 * is not mistaken for a flag, and unknown segments are ignored.
 *
 * When several alignments are given the last one wins, as a later CSS
 * declaration overrides an earlier one — and as Obsidian's own alias parser
 * already works, reading the size from the last segment. Resolving it here
 * rather than in the stylesheet keeps the outcome from depending on the order
 * the rules happen to sit in.
 */
function requestedAlignment(el: HTMLElement): Alignment | null {
  let alignment: Alignment | null = null;
  for (const segment of el.getAttribute("alt")?.split("|") ?? []) {
    const token = segment.trim().toLowerCase();
    alignment = ALIGNMENTS.find((value) => value === token) ?? alignment;
  }
  return alignment;
}

/**
 * A segment of an alias that is an instruction and not words: an alignment
 * keyword, or a size (`300`, `300x200`) that Obsidian left in `alt` because it
 * was not the last segment.
 */
function isFlag(segment: string): boolean {
  return (
    /^\d+(x\d+)?$/i.test(segment) || ALIGNMENTS.some((value) => value === segment.toLowerCase())
  );
}

/**
 * The text an embed gives to assistive technology, or null if it gives none.
 * That is its alias without the flags. A plain embed arrives with its own
 * `src` in `alt`, which is a file name and not a description, so it is left out.
 */
function accessibleName(el: HTMLElement): string | null {
  const src = el.getAttribute("src");
  const words = (el.getAttribute("alt") ?? "")
    .split("|")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== src && !isFlag(segment));
  return words.join(", ") || null;
}

/** File extension claimed for `![[…]]` embeds. */
const EXTENSION = "json";

/** Language of the code blocks that hold an animation's JSON directly. */
const CODE_BLOCK_LANGUAGE = "lottie";

interface LottieSettings {
  renderer: RendererType;
}

const DEFAULT_SETTINGS: LottieSettings = {
  renderer: "sw",
};

const RENDERER_LABELS: Record<RendererType, string> = {
  sw: "Software",
  gl: "WebGL",
  wg: "WebGPU",
};

/** How far outside the window an animation still counts as worth drawing. */
const NEAR_SCREEN = 200;

/**
 * Device pixels per CSS pixel, damped as ThorVG damps it: a 2x display costs
 * four times the pixels for rather less than four times the detail, so it is
 * met most of the way rather than all of it.
 */
function pixelRatio(): number {
  return 1 + (window.devicePixelRatio - 1) * 0.75;
}

// Obsidian's embed registry is not in the public typings, but it is the one
// hook every embed path goes through — reading view, Live Preview and hover
// popovers all end up in `embedRegistry.getEmbedCreator(file)`. A Markdown
// post-processor only ever sees the reading-view pass. A creator that returns
// null hands the embed back to Obsidian's own generic file card.
interface EmbedContext {
  app: App;
  containerEl: HTMLElement;
  linktext: string;
  sourcePath: string;
  displayMode?: boolean;
  showInline?: boolean;
  depth: number;
}

type EmbedCreator = (
  ctx: EmbedContext,
  file: TFile,
  subpath: string,
) => (Component & { loadFile(): Promise<void> }) | null;

interface EmbedRegistry {
  registerExtension(extension: string, creator: EmbedCreator): void;
  unregisterExtension(extension: string): void;
  isExtensionRegistered(extension: string): boolean;
}

function embedRegistry(app: App): EmbedRegistry {
  return (app as App & { embedRegistry: EmbedRegistry }).embedRegistry;
}

// Left alone, @thorvg/webcanvas fetches thorvg.wasm from unpkg at runtime. The
// binary is inlined into main.js instead (see esbuild.config.mjs) and handed
// over as a blob URL, so nothing is downloaded and this works offline. The URL
// outlives individual engines, since switching renderers reloads the module.
let wasmUrl: string | null = null;

function wasmBlobUrl(): string {
  if (!wasmUrl) {
    wasmUrl = URL.createObjectURL(new Blob([thorvgWasm], { type: "application/wasm" }));
  }
  return wasmUrl;
}

interface Size {
  width: number;
  height: number;
}

/**
 * The size a Lottie document was drawn for, or null if the text is not one.
 *
 * A Lottie is a JSON object with a layer list and a frame range; `w` and `h`
 * are the canvas it was authored against. Reading them here lets an embed take
 * up its space before the animation has loaded. Without that an embed is a
 * point on the line until it draws, and a note full of them shuffles as they
 * appear — which also leaves nothing able to say which of them are on screen.
 *
 * A file missing the two is still an animation, only one that cannot be
 * measured until ThorVG has read it; it gets a zero size.
 */
function lottieSize(text: string): Size | null {
  try {
    const doc: unknown = JSON.parse(text);
    if (typeof doc !== "object" || doc === null) return null;
    const { layers, fr, op, w, h } = doc as Record<string, unknown>;
    if (!Array.isArray(layers) || typeof fr !== "number" || typeof op !== "number") return null;
    const measured = typeof w === "number" && typeof h === "number" && w > 0 && h > 0;
    return measured ? { width: w, height: h } : { width: 0, height: 0 };
  } catch {
    return null;
  }
}

/**
 * Remembers which `.json` files are Lottie documents and how large they are,
 * so the embed creator — which has to answer synchronously — can leave
 * everything else to Obsidian. Files are classified in the background after
 * startup and re-checked as they change; an unknown file is assumed to be
 * Lottie until read.
 */
class LottieIndex extends Component {
  /** Null for a `.json` that is not an animation, missing while unread. */
  private known = new Map<string, Size | null>();
  /** Reads in flight, so embeds of one file opening together share one. */
  private reading = new Map<string, Promise<Size | null>>();

  /**
   * @param onModified Called after a `.json` has been re-classified, so an
   *   embed already showing that file can pick the new contents up.
   */
  constructor(
    private app: App,
    private onModified: (file: TFile) => void,
  ) {
    super();
  }

  onload(): void {
    const { vault } = this.app;
    this.registerEvent(vault.on("create", (file) => void this.classify(file)));
    this.registerEvent(
      vault.on("modify", (file) => {
        void this.classify(file).then(() => {
          if (file instanceof TFile && file.extension === EXTENSION) this.onModified(file);
        });
      }),
    );
    this.registerEvent(vault.on("delete", (file) => this.known.delete(file.path)));
    this.registerEvent(
      vault.on("rename", (file, oldPath) => {
        const was = this.known.get(oldPath);
        this.known.delete(oldPath);
        if (was !== undefined) this.known.set(file.path, was);
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      for (const file of vault.getFiles()) void this.classify(file);
    });
  }

  /** `undefined` while the file has not been read yet. */
  isLottie(file: TFile): boolean | undefined {
    const known = this.known.get(file.path);
    return known === undefined ? undefined : known !== null;
  }

  /** The same answer, reading the file now if nothing has read it yet. */
  async ensure(file: TFile): Promise<Size | null> {
    const known = this.known.get(file.path);
    if (known !== undefined) return known;
    const reading = this.reading.get(file.path) ?? this.read(file);
    this.reading.set(file.path, reading);
    try {
      return await reading;
    } finally {
      this.reading.delete(file.path);
    }
  }

  remember(file: TFile, size: Size | null): void {
    this.known.set(file.path, size);
  }

  private async read(file: TFile): Promise<Size | null> {
    try {
      const size = lottieSize(await this.app.vault.cachedRead(file));
      this.known.set(file.path, size);
      return size;
    } catch {
      this.known.delete(file.path);
      return null;
    }
  }

  private async classify(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== EXTENSION) return;
    await this.read(file);
  }
}

let nextCanvasId = 0;

/**
 * Binds ThorVG to a canvas that may belong to a popout window. It resolves its
 * selector against the main window's document, so the element is moved there
 * for the call and put straight back; from then on ThorVG holds it by
 * reference. Both steps run without yielding, so nothing is painted between.
 */
function bindCanvas(
  TVG: ThorVGNamespace,
  el: HTMLCanvasElement,
  width: number,
  height: number,
): Canvas {
  if (!el.id) el.id = `lottie-thorvg-${nextCanvasId++}`;
  const parent = el.parentElement;
  const next = el.nextSibling;
  window.document.body.appendChild(el);
  try {
    return new TVG.Canvas(`#${el.id}`, { width, height });
  } finally {
    if (parent) parent.insertBefore(el, next);
    else el.remove();
  }
}

/**
 * Atlas bounds in device pixels. It starts at a size that holds one modest
 * animation, since most notes have one, and doubles from there. The ceiling is
 * memory rather than any browser limit: a canvas costs four bytes a pixel, so
 * 4096 square is already 67MB.
 */
const ATLAS_MIN = 512;
const ATLAS_MAX = 4096;

/**
 * How long one frame may spend taking in animations that have just come into
 * view. Parsing a Lottie is the expensive part of that and a scroll can bring a
 * dozen at once; a quarter of a 60Hz frame leaves the rest for drawing.
 */
const ADMIT_BUDGET_MS = 1000 / 60 / 4;

/** A rectangle given back, handed whole to the next slot of the same size. */
interface Patch {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An animation waiting its turn to be loaded. */
interface Pending {
  json: string;
  target: HTMLCanvasElement;
  /** Answers false if whoever asked has given up in the meantime. */
  wanted: () => boolean;
  settle: (slot: Slot | null) => void;
}

/**
 * One animation's place on the shared canvas, and the canvas it is copied to.
 * Sizes and offsets are in device pixels: the shared canvas has ThorVG's own
 * scaling turned off, so they can be handed straight to drawImage.
 */
class Slot {
  x = 0;
  y = 0;
  /** Where the animation has got to, in frames; fractional between frames. */
  frame = 0;
  /** Off screen: still loaded and still placed, but out of the scene. */
  visible = false;
  /** When it was last on screen, so the stalest can be evicted first. */
  seen = 0;
  /** Set if ThorVG refused a frame, so one bad animation stops only itself. */
  stalled = false;
  /** Set once the player has let it go, whether asked to or to make room. */
  released = false;

  /** Where the pixels are copied to, when a player copies them. */
  target: CanvasRenderingContext2D | null = null;
  /** The animation's own ThorVG canvas, when it draws into one. */
  canvas: Canvas | null = null;

  constructor(
    private player: Player,
    readonly animation: LottieAnimation,
    readonly picture: Picture,
    readonly targetEl: HTMLCanvasElement,
    /** The size ThorVG read out of the file, before it was scaled to fit. */
    readonly native: Size,
    public width: number,
    public height: number,
    readonly frames: number,
    readonly fps: number,
  ) {}

  show(): void {
    this.player.show(this);
  }

  hide(): void {
    this.player.hide(this);
  }

  resize(width: number, height: number): void {
    this.player.resize(this, width, height);
  }

  release(): void {
    this.player.release(this);
  }
}

/**
 * Everything the two players share: which animations are loaded, when they
 * are let in, and the single frame loop that advances them all. What differs
 * is where the pixels are drawn and how they reach the screen.
 */
abstract class Player {
  /** Everything loaded, on screen or not. */
  protected slots: Slot[] = [];
  private queue: Pending[] = [];
  private frameId: number | null = null;
  private lastTick = 0;

  constructor(protected TVG: ThorVGNamespace) {}

  /** Gives the slot somewhere to draw, or answers false if there is no room. */
  protected abstract place(slot: Slot): boolean;
  /** Takes that away, before the slot is placed again or forgotten. */
  protected abstract displace(slot: Slot): void;
  /** The slot has come on screen, or gone off it. */
  protected abstract enter(slot: Slot): void;
  protected abstract leave(slot: Slot): void;
  /** Draws one frame of everything on screen. */
  protected abstract paint(onScreen: Slot[]): void;
  /** Frees whatever the player itself holds, after its slots are gone. */
  protected abstract dispose(): void;

  /** A broken player is replaced, never repaired. */
  broken = false;

  /** Stops drawing permanently. */
  halt(): void {
    this.broken = true;
    this.stop();
  }

  /**
   * Queues an animation to be loaded and given a place, and answers with its
   * slot once it has one — or with null if it was refused or is no longer
   * wanted by the time its turn comes.
   */
  acquire(json: string, target: HTMLCanvasElement, wanted: () => boolean): Promise<Slot | null> {
    return new Promise((settle) => {
      this.queue.push({ json, target, wanted, settle });
      this.start();
    });
  }

  /** The animation is on screen again, so the next frame draws it. */
  show(slot: Slot): void {
    if (slot.visible || slot.released) return;
    slot.visible = true;
    slot.seen = performance.now();
    this.enter(slot);
    this.start();
  }

  /** Off screen. It keeps its place, and its canvas keeps the last frame. */
  hide(slot: Slot): void {
    if (!slot.visible || slot.released) return;
    slot.visible = false;
    slot.seen = performance.now();
    this.leave(slot);
  }

  resize(slot: Slot, width: number, height: number): void {
    const next = { width: Math.max(1, width), height: Math.max(1, height) };
    if (slot.released || (next.width === slot.width && next.height === slot.height)) return;
    this.displace(slot);
    slot.width = next.width;
    slot.height = next.height;
    if (!this.place(slot)) this.release(slot);
  }

  release(slot: Slot): void {
    const at = this.slots.indexOf(slot);
    if (at < 0) return;
    this.slots.splice(at, 1);
    slot.released = true;
    try {
      if (slot.visible) this.leave(slot);
      this.displace(slot);
      slot.animation.dispose();
    } catch (error) {
      console.error("Lottie: failed to release an animation", error);
    }
  }

  /** Frees the ThorVG objects. Must run while their engine is still alive. */
  destroy(): void {
    this.stop();
    for (const pending of this.queue.splice(0)) pending.settle(null);
    try {
      for (const slot of this.slots.splice(0)) {
        slot.released = true;
        this.displace(slot);
        slot.animation.dispose();
      }
      this.dispose();
    } catch (error) {
      console.error("Lottie: failed to tear the player down", error);
    }
  }

  /**
   * Loads queued animations until this frame's budget is spent. One always goes
   * through, so a file heavier than the whole budget still gets in eventually.
   */
  private admit(): void {
    const started = performance.now();
    while (this.queue.length) {
      const pending = this.queue.shift();
      if (!pending) break;
      pending.settle(pending.wanted() ? this.load(pending) : null);
      if (performance.now() - started > ADMIT_BUDGET_MS) break;
    }
  }

  private load({ json, target }: Pending): Slot | null {
    const animation = new this.TVG.LottieAnimation();
    try {
      animation.load(json);
      const picture = animation.picture;
      if (!picture) throw new Error("ThorVG could not load the animation");

      const info = animation.info();
      // Read before the picture is scaled to its slot: from then on size()
      // gives back what it was set to, not what the file said.
      const native = picture.size();
      const slot = new Slot(
        this,
        animation,
        picture,
        target,
        native,
        Math.max(1, target.width),
        Math.max(1, target.height),
        Math.max(1, info?.totalFrames ?? 1),
        info?.fps || 60,
      );

      if (!this.place(slot)) {
        animation.dispose();
        return null;
      }
      this.slots.push(slot);
      return slot;
    } catch (error) {
      console.error("Lottie:", error);
      animation.dispose();
      return null;
    }
  }

  private start(): void {
    if (this.frameId !== null) return;
    this.lastTick = 0;
    this.frameId = window.requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.frameId === null) return;
    window.cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }

  /**
   * One loop and one render for every animation on screen; ThorVG's own play()
   * would drive a frame loop each. Off-screen slots keep counting so that one
   * scrolled back into view has moved on with the rest, but they are not asked
   * to draw. With nothing on screen at all the loop stops, and time with it.
   */
  private tick = (now: number): void => {
    this.frameId = window.requestAnimationFrame(this.tick);
    const elapsed = this.lastTick ? (now - this.lastTick) / 1000 : 0;
    this.lastTick = now;

    this.admit();

    for (const slot of this.slots) {
      if (slot.stalled) continue;
      // ThorVG treats a frame it is already showing as a failure, and the first
      // tick of a new slot asks for exactly that.
      const frame = (slot.frame + slot.fps * elapsed) % slot.frames;
      if (frame === slot.frame) continue;
      slot.frame = frame;
      if (!slot.visible) continue;
      try {
        slot.animation.frame(frame);
      } catch (error) {
        slot.stalled = true;
        console.error("Lottie: could not advance an animation", error);
      }
    }

    const onScreen = this.slots.filter((slot) => slot.visible);
    if (!onScreen.length && !this.queue.length) {
      this.stop();
      return;
    }

    try {
      this.paint(onScreen);
    } catch (error) {
      console.error("Lottie: frame failed", error);
      this.stop();
    }
  };
}

/**
 * Draws every animation on screen onto one canvas, then copies each into the
 * plain 2D canvas its embed owns.
 *
 * Chromium keeps sixteen WebGL contexts per process and kills the oldest —
 * possibly another plugin's — to make room. Binding one canvas for the whole
 * vault sidesteps that ceiling: a 2D canvas costs nothing, so a note may hold
 * as many as it likes.
 */
class AtlasPlayer extends Player {
  /** Drops the context-loss listeners on dispose, instead of a flag each checks. */
  private stopListening = new AbortController();
  /** Rows of the atlas; each takes slots no taller than itself. */
  private rows: { y: number; height: number; cursor: number }[] = [];
  private spare: Patch[] = [];
  private atlas = { width: ATLAS_MIN, height: ATLAS_MIN };

  private constructor(
    TVG: ThorVGNamespace,
    private hostEl: HTMLCanvasElement,
    private canvas: Canvas,
  ) {
    super(TVG);
  }

  /**
   * ThorVG resolves its selector against the main window's document, so the
   * canvas it is bound to has to live there — whatever window an embed is in.
   *
   * `lost` and `restored` hear the graphics context go and come back. Chromium
   * keeps sixteen of them and gives a page asking for one whichever it can
   * spare, which may be this one; a GPU reset takes it as readily.
   */
  static create(
    TVG: ThorVGNamespace,
    context: { lost: () => void; restored: () => void },
  ): AtlasPlayer {
    const host = window.document.body.createDiv({
      cls: "lottie-thorvg-host",
      attr: { "aria-hidden": "true" },
    });
    const el = host.createEl("canvas", { attr: { id: `lottie-thorvg-${nextCanvasId++}` } });
    try {
      const canvas = new TVG.Canvas(`#${el.id}`, {
        width: ATLAS_MIN,
        height: ATLAS_MIN,
        enableDevicePixelRatio: false,
      });
      const player = new AtlasPlayer(TVG, el, canvas);
      const { signal } = player.stopListening;
      el.addEventListener(
        "webglcontextlost",
        (event) => {
          // Saying we mean to recover is what makes the browser try; left
          // alone it never offers the context back at all.
          event.preventDefault();
          context.lost();
        },
        { signal },
      );
      el.addEventListener("webglcontextrestored", () => context.restored(), { signal });
      return player;
    } catch (error) {
      host.remove();
      throw error;
    }
  }

  protected enter(slot: Slot): void {
    this.canvas.add(slot.picture);
  }

  protected leave(slot: Slot): void {
    this.canvas.remove(slot.picture);
  }

  protected dispose(): void {
    this.stopListening.abort();
    this.canvas.destroy();
    this.hostEl.parentElement?.remove();
  }

  /**
   * Finds the slot a rectangle, growing or making room if it has to. Fails
   * rather than throwing, so the caller has to decide what to show instead.
   */
  protected place(slot: Slot): boolean {
    slot.target ??= slot.targetEl.getContext("2d");
    if (!slot.target) return false;
    if (this.fit(slot)) return true;
    while (this.grow()) if (this.fit(slot)) return true;

    // Full. Animations that are off screen go first: nothing is drawing them,
    // and coming back costs them only a reload.
    while (this.evict()) if (this.fit(slot)) return true;

    // Everything left is on screen. Halving takes a quarter of the room each
    // time — softer, but it moves. This is also the way in for an animation
    // asked to be larger than the atlas will ever be.
    while (Math.min(slot.width, slot.height) > 2) {
      slot.width = Math.round(slot.width / 2);
      slot.height = Math.round(slot.height / 2);
      if (this.fit(slot)) return true;
    }

    console.warn(`Lottie: no room on the atlas for ${slot.width}×${slot.height}`);
    return false;
  }

  protected displace(slot: Slot): void {
    this.spare.push({ x: slot.x, y: slot.y, width: slot.width, height: slot.height });
    if (this.slots.length) return;
    // Nothing left to draw: the atlas goes back to nothing with it.
    this.rows = [];
    this.spare = [];
    this.atlas = { width: ATLAS_MIN, height: ATLAS_MIN };
    this.canvas.resize(ATLAS_MIN, ATLAS_MIN);
  }

  protected paint(onScreen: Slot[]): void {
    this.canvas.update().render();
    for (const slot of onScreen) {
      const { width, height } = slot.targetEl;
      slot.target?.clearRect(0, 0, width, height);
      slot.target?.drawImage(
        this.hostEl,
        slot.x,
        slot.y,
        slot.width,
        slot.height,
        0,
        0,
        width,
        height,
      );
    }
  }

  /**
   * A released rectangle of the same size is handed back first — scrolling a
   * note of one animation passes the same few rectangles round, so the atlas
   * stops growing. Otherwise the slot joins a row tall enough to take it, or
   * opens a new row below the last.
   */
  private fit(slot: Slot): boolean {
    const spare = this.spare.findIndex(
      (patch) => patch.width === slot.width && patch.height === slot.height,
    );
    if (spare >= 0) {
      const patch = this.spare.splice(spare, 1)[0];
      return this.settle(slot, patch.x, patch.y);
    }

    for (const row of this.rows) {
      if (row.height >= slot.height && row.cursor + slot.width <= this.atlas.width) {
        const x = row.cursor;
        row.cursor += slot.width;
        return this.settle(slot, x, row.y);
      }
    }

    const bottom = this.rows.reduce((y, row) => Math.max(y, row.y + row.height), 0);
    if (slot.width > this.atlas.width || bottom + slot.height > this.atlas.height) return false;
    this.rows.push({ y: bottom, height: slot.height, cursor: slot.width });
    return this.settle(slot, 0, bottom);
  }

  private settle(slot: Slot, x: number, y: number): boolean {
    slot.x = x;
    slot.y = y;
    slot.picture.size(slot.width, slot.height);
    slot.picture.translate(x, y);
    return true;
  }

  /** Doubles the shorter side and lays everything out again. */
  private grow(): boolean {
    const { width, height } = this.atlas;
    if (width >= ATLAS_MAX && height >= ATLAS_MAX) return false;
    if (width <= height) this.atlas.width = Math.min(ATLAS_MAX, width * 2);
    else this.atlas.height = Math.min(ATLAS_MAX, height * 2);

    this.canvas.resize(this.atlas.width, this.atlas.height);
    this.rows = [];
    this.spare = [];
    // Tallest first, which is what shelf packing wants.
    for (const slot of [...this.slots].sort((a, b) => b.height - a.height)) this.fit(slot);
    return true;
  }

  /** Drops whichever animation has been off screen longest. */
  private evict(): boolean {
    let stalest: Slot | null = null;
    for (const slot of this.slots) {
      if (slot.visible) continue;
      if (!stalest || slot.seen < stalest.seen) stalest = slot;
    }
    if (!stalest) return false;
    stalest.release();
    return true;
  }
}

/**
 * Gives each animation a ThorVG canvas of its own, bound to the canvas its
 * embed holds, so the pixels land where they are shown.
 *
 * The software backend reads its whole canvas back through putImageData every
 * frame, so pooling animations onto one atlas would mean reading its empty
 * space too, and copying every animation a second time to get it out. It also
 * has no context to save: a software canvas costs nothing scarce.
 */
class DirectPlayer extends Player {
  protected enter(): void {}
  protected leave(): void {}
  protected dispose(): void {}

  /**
   * Here ThorVG applies the display's pixel ratio itself, as it does the sizing
   * of the element, so this side of the plugin works in CSS pixels — unlike the
   * atlas, which counts device pixels because it has to index into them.
   */
  protected place(slot: Slot): boolean {
    const ratio = pixelRatio();
    const width = Math.max(1, Math.round(slot.width / ratio));
    const height = Math.max(1, Math.round(slot.height / ratio));
    try {
      if (!slot.canvas) {
        slot.canvas = bindCanvas(this.TVG, slot.targetEl, width, height);
        slot.canvas.add(slot.picture);
      } else {
        slot.canvas.resize(width, height);
      }
      slot.picture.size(width, height);
      return true;
    } catch (error) {
      console.error("Lottie: could not give an animation a canvas", error);
      return false;
    }
  }

  /** A resize keeps the canvas; only letting the slot go destroys it. */
  protected displace(slot: Slot): void {
    if (!slot.released) return;
    slot.canvas?.destroy();
    slot.canvas = null;
  }

  protected paint(onScreen: Slot[]): void {
    for (const slot of onScreen) slot.canvas?.update().render();
  }
}

/**
 * A canvas is only pixels, so a screen reader can say nothing about it unless
 * it is given a role and a name. With no name it is decoration, and is hidden.
 */
function describeCanvas(el: HTMLCanvasElement, name: string | null): void {
  if (name) {
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", name);
    el.removeAttribute("aria-hidden");
  } else {
    el.removeAttribute("role");
    el.removeAttribute("aria-label");
    el.setAttribute("aria-hidden", "true");
  }
}

function createCanvas(parent: HTMLElement, name: string | null): HTMLCanvasElement {
  const el = parent.createEl("canvas");
  describeCanvas(el, name);
  return el;
}

/**
 * An embed inside a note, or the view a `.json` opens in. The plugin tracks
 * these so it can free them before tearing the engine down, and reload them
 * when the file changes.
 */
interface LottieSurface {
  /** Null for a code block, which has no file, and for a view between files. */
  readonly file: TFile | null;
  /** Gives up the animation's slot, leaving the surface able to take another. */
  release(): void;
  /** Re-reads the file and shows it again. */
  redraw(): Promise<void>;
}

/** What reading an animation yields: its text, and its size if it is one. */
interface Reading {
  json: string;
  size: Size | null;
}

/**
 * An animation shown inline in a note. The kinds of embed differ in where the
 * JSON comes from and in what is shown when it is not a Lottie document, and
 * share everything else.
 */
abstract class LottieEmbed extends MarkdownRenderChild implements LottieSurface {
  private canvasEl: HTMLCanvasElement | null = null;
  private slot: Slot | null = null;
  /** The animation's own dimensions, before any alias size is applied. */
  private nativeSize: Size | null = null;
  private observer: IntersectionObserver | null = null;
  private aliasObserver: MutationObserver | null = null;
  private onScreen = false;
  private attaching = false;
  private tornDown = false;

  abstract readonly file: TFile | null;
  /** What the embed is called in an error message. */
  protected abstract readonly name: string;

  constructor(
    containerEl: HTMLElement,
    protected plugin: LottiePlugin,
  ) {
    super(containerEl);
  }

  /** The size from the cheapest place there is, so the note can be laid out first. */
  protected abstract measure(): Promise<Size | null>;
  /** Reads the animation afresh. */
  protected abstract read(): Promise<Reading>;
  /** Fills the container in place of an animation, for a source that is not one. */
  protected abstract fillNotLottie(el: HTMLElement): void;

  // Called by Obsidian's embed loader, or by the code block processor, once
  // the component is attached.
  async loadFile(): Promise<void> {
    this.plugin.surfaces.add(this);
    this.containerEl.empty();
    this.containerEl.addClass("lottie-thorvg");
    this.containerEl.dataset.renderer = this.plugin.settings.renderer;

    // Take the space before anything is drawn. Everything below turns on
    // whether the embed is on screen, and an embed that has not drawn has no
    // position worth asking about — nor can its neighbours have one while it
    // sits between them with no size.
    const size = await this.measure();
    if (this.tornDown) return;
    if (!size) {
      this.showNotLottie();
      return;
    }
    this.nativeSize = size;
    this.applyAlias();

    this.observer = new IntersectionObserver(
      (entries) => {
        this.onScreen = entries.some((entry) => entry.isIntersecting);
        if (!this.onScreen) {
          this.slot?.hide();
          return;
        }
        // The slot outlives scrolling, so this is usually free. It is gone only
        // if the player had to take it back to make room for something else.
        if (this.slot && !this.slot.released) this.slot.show();
        else void this.attach();
      },
      // Slack either side, so an animation just past the edge keeps playing
      // rather than stopping and starting as the note is scrolled.
      { rootMargin: `${NEAR_SCREEN}px` },
    );
    this.observer.observe(this.containerEl);

    // Editing the alias in Live Preview does not rebuild the widget: Obsidian
    // reuses the DOM and just rewrites these attributes. For an image it also
    // re-applies them to the <img>, but nothing tells a foreign child, so the
    // change has to be picked up from the container itself.
    this.aliasObserver = new MutationObserver(() => this.applyAlias());
    this.aliasObserver.observe(this.containerEl, {
      attributes: true,
      attributeFilter: ["width", "height", "alt"],
    });
  }

  onunload(): void {
    this.plugin.surfaces.delete(this);
    this.teardown();
  }

  /** Retires the embed permanently; it will not draw again. */
  teardown(): void {
    if (this.tornDown) return;
    this.tornDown = true;
    this.observer?.disconnect();
    this.aliasObserver?.disconnect();
    this.release();
  }

  release(): void {
    this.detach();
  }

  /**
   * Reloads after the file changed on disk, the way Obsidian's own embeds do.
   * Text that is not JSON at all is left alone rather than replacing a working
   * animation, since an editor saving over the file can be caught mid-write;
   * JSON that is simply no longer an animation is a real change and gets the
   * file card.
   */
  async redraw(): Promise<void> {
    // Already reloading — a redraw asked for while attach() is in flight would
    // only redo its read and parse, then find attach()'s own guard and stop.
    if (this.tornDown || this.attaching) return;
    try {
      const { size } = await this.read();
      if (!size) {
        this.detach();
        this.showNotLottie();
        return;
      }
      if (size.width > 0) {
        this.nativeSize = size;
        this.place();
      }
      this.detach();
      if (this.onScreen) await this.attach();
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Sizes the canvas the animation is painted into. Called before anything is
   * drawn, so the note is laid out as it will be, and again whenever the alias
   * or the animation's own size says something different.
   */
  private place(): void {
    const native = this.nativeSize;
    if (!native || native.width <= 0 || native.height <= 0 || this.tornDown) return;

    const { drawWidth, drawHeight } = this.drawSize(native.width, native.height);
    const ratio = pixelRatio();
    const el = this.ensureCanvas();

    el.width = Math.max(1, Math.round(drawWidth * ratio));
    el.height = Math.max(1, Math.round(drawHeight * ratio));
    el.style.width = `${drawWidth}px`;
    el.style.height = `${drawHeight}px`;
    this.slot?.resize(el.width, el.height);
  }

  private applyAlias(): void {
    const alignment = requestedAlignment(this.containerEl);
    if (alignment) this.containerEl.dataset.align = alignment;
    else delete this.containerEl.dataset.align;
    if (this.canvasEl) describeCanvas(this.canvasEl, accessibleName(this.containerEl));
    this.place();
  }

  private ensureCanvas(): HTMLCanvasElement {
    this.canvasEl ??= createCanvas(this.containerEl, accessibleName(this.containerEl));
    return this.canvasEl;
  }

  /** Asks the player for a slot, which loads the animation to fill it. */
  private async attach(): Promise<void> {
    if (this.attaching || this.tornDown) return;
    this.attaching = true;
    try {
      const { json, size } = await this.read();
      if (!size) {
        this.showNotLottie();
        return;
      }
      // A file with no size of its own could not be laid out until now.
      if (size.width > 0 && !this.nativeSize?.width) {
        this.nativeSize = size;
        this.place();
      }

      const player = await this.plugin.ensurePlayer();
      // The awaits above give the note time to close, or to scroll away.
      if (this.tornDown || !this.onScreen) return;

      // A Lottie that never said how large it is has had no canvas to lay out
      // with. It gets one at whatever size, and ThorVG's answer sizes it after.
      const slot = await player.acquire(
        json,
        this.ensureCanvas(),
        () => this.onScreen && !this.tornDown,
      );
      if (!slot) return;
      if (this.tornDown) {
        slot.release();
        return;
      }

      this.slot = slot;
      if (!this.nativeSize?.width) {
        this.nativeSize = slot.native;
        this.place();
      }
      if (this.onScreen) slot.show();
    } catch (error) {
      this.fail(error);
    } finally {
      this.attaching = false;
    }
  }

  /** Gives the animation up permanently. The canvas keeps its last frame. */
  private detach(): void {
    this.slot?.release();
    this.slot = null;
  }

  /**
   * Picks the size to draw at, following the rules images get here: a width
   * alone scales by aspect ratio (enlarging if asked), a width and a height
   * stretch to exactly that, and no size at all draws at the animation's own
   * dimensions. Obsidian's parser cannot produce a height without a width, so
   * that case does not arise.
   */
  private drawSize(width: number, height: number): { drawWidth: number; drawHeight: number } {
    const asked = requestedSize(this.containerEl);
    if (asked.width && asked.height) {
      return { drawWidth: asked.width, drawHeight: asked.height };
    }
    if (asked.width) {
      return {
        drawWidth: asked.width,
        drawHeight: Math.round((height * asked.width) / width),
      };
    }
    return { drawWidth: Math.round(width), drawHeight: Math.round(height) };
  }

  private showNotLottie(): void {
    this.detach();
    this.observer?.disconnect();
    this.containerEl.empty();
    this.canvasEl = null;
    this.fillNotLottie(this.containerEl);
  }

  private fail(error: unknown): void {
    console.error("Lottie:", error);
    this.detach();
    this.containerEl.empty();
    this.canvasEl = null;
    this.containerEl.createDiv({
      cls: "lottie-thorvg-error",
      text: `Could not render ${this.name}`,
    });
  }
}

/** An embed of a `.json` file, as in `![[a.json]]`. */
class FileEmbed extends LottieEmbed {
  constructor(
    containerEl: HTMLElement,
    plugin: LottiePlugin,
    readonly file: TFile,
  ) {
    super(containerEl, plugin);
  }

  protected get name(): string {
    return this.file.name;
  }

  protected measure(): Promise<Size | null> {
    return this.plugin.index.ensure(this.file);
  }

  protected async read(): Promise<Reading> {
    const json = await this.plugin.app.vault.cachedRead(this.file);
    const size = lottieSize(json);
    this.plugin.index.remember(this.file, size);
    return { json, size };
  }

  /**
   * A `.json` that is not a Lottie document gets the same card Obsidian shows
   * for any other file. From now on the index knows the file, so the next
   * render skips this component entirely and Obsidian draws its own card.
   */
  protected fillNotLottie(el: HTMLElement): void {
    el.removeClass("lottie-thorvg");
    delete el.dataset.renderer;
    delete el.dataset.align;
    el.addClasses(["file-embed", "mod-generic"]);
    const title = el.createDiv({ cls: "file-embed-title" });
    setIcon(title.createSpan({ cls: "file-embed-icon" }), "file");
    title.appendText(this.file.name);
  }
}

/** A `lottie` code block, whose animation is the text of the block itself. */
class BlockEmbed extends LottieEmbed {
  readonly file = null;
  protected readonly name = "lottie code block";
  private readonly size: Size | null;

  constructor(
    containerEl: HTMLElement,
    plugin: LottiePlugin,
    private text: string,
  ) {
    super(containerEl, plugin);
    this.size = lottieSize(text);
  }

  protected measure(): Promise<Size | null> {
    return Promise.resolve(this.size);
  }

  protected read(): Promise<Reading> {
    return Promise.resolve({ json: this.text, size: this.size });
  }

  protected fillNotLottie(el: HTMLElement): void {
    el.createDiv({ cls: "lottie-thorvg-error", text: "Not a Lottie animation" });
  }
}

/** View type opening a `.json` animation on its own tab. */
const VIEW_TYPE = "lottie";

/**
 * The tab a `.json` opens in. Without a view registered for the extension
 * Obsidian hands the file to the operating system, which is how clicking a
 * Lottie file in the explorer ends up in a text editor.
 *
 * Registration is per extension, so this claims every `.json`. One that is not
 * an animation gets a note saying so and a way to open it outside Obsidian —
 * the behaviour it had before.
 */
class LottieView extends FileView implements LottieSurface {
  private canvasEl: HTMLCanvasElement | null = null;
  private slot: Slot | null = null;
  private nativeSize: Size | null = null;
  private visibility: IntersectionObserver | null = null;
  private attaching = false;
  /** Whether the pane is on screen; a background tab must not burn frames. */
  private onScreen = true;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: LottiePlugin,
  ) {
    super(leaf);
  }

  protected async onOpen(): Promise<void> {
    // A tab that is not in front has no layout, so this covers both the
    // background-tab case and a pane split off to the side, which stays on
    // screen and keeps playing.
    this.visibility = new IntersectionObserver((entries) => {
      this.onScreen = entries.some((entry) => entry.isIntersecting);
      if (!this.onScreen) {
        this.slot?.hide();
        return;
      }
      if (this.slot && !this.slot.released) this.slot.show();
      else void this.attach();
    });
    this.visibility.observe(this.contentEl);
  }

  protected async onClose(): Promise<void> {
    this.visibility?.disconnect();
    this.visibility = null;
    this.plugin.surfaces.delete(this);
    this.release();
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getIcon(): string {
    return "play-circle";
  }

  getDisplayText(): string {
    return this.file?.basename ?? "Lottie";
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.plugin.surfaces.add(this);
    await this.show(file);
  }

  async onUnloadFile(): Promise<void> {
    this.plugin.surfaces.delete(this);
    this.release();
  }

  release(): void {
    this.detach();
  }

  async redraw(): Promise<void> {
    // Already reloading — see LottieEmbed.redraw() for why this is skipped.
    if (this.attaching) return;
    if (this.file) await this.show(this.file);
  }

  // The animation is drawn at the size it is shown at, so a resized pane needs
  // it drawn again rather than scaled.
  onResize(): void {
    this.fit();
  }

  private async show(file: TFile): Promise<void> {
    this.detach();
    const content = this.contentEl;
    content.empty();
    this.canvasEl = null;
    content.addClass("lottie-thorvg-view");

    const size = await this.plugin.index.ensure(file);
    if (this.file !== file) return;
    if (!size) {
      this.showNotAnimation(file);
      return;
    }

    this.nativeSize = size.width > 0 ? size : null;
    this.canvasEl = createCanvas(content, file.name);
    this.fit();
    await this.attach();
  }

  private async attach(): Promise<void> {
    const file = this.file;
    if (this.attaching || !file || !this.canvasEl || !this.onScreen) return;
    this.attaching = true;
    try {
      const json = await this.app.vault.cachedRead(file);
      const size = lottieSize(json);
      this.plugin.index.remember(file, size);
      if (!size) {
        this.detach();
        this.contentEl.empty();
        this.canvasEl = null;
        this.showNotAnimation(file);
        return;
      }

      const player = await this.plugin.ensurePlayer();
      if (this.file !== file || !this.onScreen || !this.canvasEl) return;

      const slot = await player.acquire(
        json,
        this.canvasEl,
        () => this.file === file && this.onScreen,
      );
      if (!slot) return;
      if (this.file !== file) {
        slot.release();
        return;
      }

      this.slot = slot;
      if (!this.nativeSize) {
        this.nativeSize = slot.native;
        this.fit();
      }
      if (this.onScreen) slot.show();
    } catch (error) {
      console.error("Lottie:", error);
      this.contentEl.empty();
      this.canvasEl = null;
      this.contentEl.createDiv({
        cls: "lottie-thorvg-error",
        text: `Could not render ${file.name}`,
      });
    } finally {
      this.attaching = false;
    }
  }

  private detach(): void {
    this.slot?.release();
    this.slot = null;
  }

  /** Scales the animation to fill the pane, keeping its proportions. */
  private fit(): void {
    const { nativeSize, canvasEl } = this;
    if (!nativeSize || !canvasEl) return;

    const pane = this.contentEl.getBoundingClientRect();
    if (pane.width < 1 || pane.height < 1) return;

    const scale = Math.min(pane.width / nativeSize.width, pane.height / nativeSize.height);
    const width = Math.max(1, Math.round(nativeSize.width * scale));
    const height = Math.max(1, Math.round(nativeSize.height * scale));
    const ratio = pixelRatio();

    canvasEl.width = Math.max(1, Math.round(width * ratio));
    canvasEl.height = Math.max(1, Math.round(height * ratio));
    canvasEl.style.width = `${width}px`;
    canvasEl.style.height = `${height}px`;
    this.slot?.resize(canvasEl.width, canvasEl.height);
  }

  private showNotAnimation(file: TFile): void {
    const box = this.contentEl.createDiv({ cls: "lottie-thorvg-notice" });
    box.createEl("p", { text: `${file.name} is not a Lottie animation.` });
    box
      .createEl("button", { text: "Open in default app" })
      .addEventListener("click", () => {
        // Not in the public typings, but it is what Obsidian itself calls for
        // a file no view can open.
        (this.app as App & { openWithDefaultApp(path: string): void }).openWithDefaultApp(
          file.path,
        );
      });
  }
}

export default class LottiePlugin extends Plugin {
  settings: LottieSettings = { ...DEFAULT_SETTINGS };

  /** Every embed and view currently holding an animation. */
  readonly surfaces = new Set<LottieSurface>();

  index!: LottieIndex;

  /**
   * Where the plugin is in the life of its ThorVG engine. Starting one is
   * asynchronous, and everything that ends it — switching backend, unloading —
   * can be asked for while it is still starting, so no transition assumes what
   * it will find: each queues on the last and reads this when its turn comes.
   */
  private state: "idle" | "starting" | "ready" | "stopping" = "idle";
  private queue: Promise<unknown> = Promise.resolve();
  /** ThorVG fixes its backend at init(), so the two live and die together. */
  private engine: ThorVGNamespace | null = null;
  private player: Player | null = null;

  async onload(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<LottieSettings>,
    );
    this.addSettingTab(new LottieSettingTab(this.app, this));
    // A burst of saves from an external editor collapses into one reload. The
    // paths are collected rather than passed through the debouncer, which
    // would keep only the last file of a batch.
    const changed = new Set<TFile>();
    const flush = debounce(() => {
      for (const file of changed) this.redrawSurfacesOf(file);
      changed.clear();
    }, 150, true);
    this.index = this.addChild(
      new LottieIndex(this.app, (file) => {
        changed.add(file);
        flush();
      }),
    );

    const registry = embedRegistry(this.app);
    // registerExtension throws on a duplicate, and a plugin that failed to
    // unload cleanly (or another plugin) may already hold the extension.
    if (registry.isExtensionRegistered(EXTENSION)) registry.unregisterExtension(EXTENSION);
    registry.registerExtension(EXTENSION, (ctx, file) =>
      this.index.isLottie(file) === false ? null : new FileEmbed(ctx.containerEl, this, file),
    );
    this.register(() => registry.unregisterExtension(EXTENSION));

    // Opening a `.json` from the file explorer: without this Obsidian passes
    // the file to the operating system.
    this.registerView(VIEW_TYPE, (leaf) => new LottieView(leaf, this));
    this.registerExtensions([EXTENSION], VIEW_TYPE);

    this.registerMarkdownCodeBlockProcessor(CODE_BLOCK_LANGUAGE, async (source, el, ctx) => {
      const block = new BlockEmbed(el, this, source);
      ctx.addChild(block);
      await block.loadFile();
    });

    // When the plugin is (re)enabled while notes are already open, Live
    // Preview keeps the widgets the previous instance built — canvases with no
    // player behind them. Rebuild those views so they pick this instance up.
    // At startup layoutReady is still false and views render after plugins
    // load anyway, so nothing needs doing then.
    if (this.app.workspace.layoutReady) await this.rebuildMarkdownViews();
  }

  // Obsidian calls onunload() without awaiting it, so the engine is left to
  // finish shutting down on its own.
  onunload(): void {
    void this.transition(() => this.stopEngine());
  }

  /**
   * The software backend paints straight into the canvas each embed holds; the
   * GPU ones pool onto a single canvas, which is what keeps them under
   * Chromium's ceiling on rendering contexts.
   */
  ensurePlayer(): Promise<Player> {
    return this.transition(() => this.startEngine());
  }

  async setRenderer(renderer: RendererType): Promise<void> {
    if (renderer === this.settings.renderer) return;
    this.settings.renderer = renderer;
    await this.saveData(this.settings);

    // The engine has to go for the next one to pick a different backend. Notes
    // are rebuilt, which recreates their embeds; open Lottie views survive the
    // switch and show themselves again. Clicking through the dropdown fires one
    // of these per choice, and two rebuilds at once leave CodeMirror reading a
    // state it has already replaced, taking the note's embeds down with it — so
    // this waits its turn like every other change of engine.
    await this.transition(async () => {
      await this.stopEngine();
      await this.rebuildMarkdownViews();
      this.redrawAllSurfaces();
    });
  }

  /**
   * Nothing can be drawn until a context comes back, and everything ThorVG had
   * on the old one went with it, so the engine is only standing for as long as
   * it takes to tear it down. Marking that rather than tearing down here leaves
   * the decision to whoever asks next, which is how every other transition
   * works — and tearing down here would abort this player's own context
   * listeners before the browser has a chance to use them to tell us it's back.
   */
  private onContextLost(): void {
    console.warn("Lottie: the graphics context was lost");
    this.player?.halt();
  }

  /**
   * Retrying is the browser's job rather than ours: it attempts a new context
   * every second while the canvas is in a visible document, and gives back one
   * evicted for room as soon as there is room. This is it saying it has.
   */
  private onContextRestored(): void {
    void this.transition(async () => {
      await this.stopEngine();
      this.redrawAllSurfaces();
    });
  }

  /** Tells everything currently tracked to reload, which lazily rebuilds the
   *  engine too: the first redraw() to ask for a player builds it, and the
   *  rest just get the one that built. */
  private redrawAllSurfaces(): void {
    for (const surface of this.surfaces) void surface.redraw();
  }

  /** Runs one change of engine, once the one before it has finished. */
  private transition<T>(step: () => Promise<T>): Promise<T> {
    const next = this.queue.then(step);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async startEngine(): Promise<Player> {
    let healing = false;
    if (this.state === "ready" && this.player) {
      if (!this.player.broken) return this.player;
      // Draws nothing any more, so it goes before a new one goes up.
      await this.stopEngine();
      healing = true;
    }

    this.state = "starting";
    try {
      const backend = this.settings.renderer;
      const engine = await ThorVG.init({
        renderer: backend,
        locateFile: () => wasmBlobUrl(),
      });
      this.engine = engine;
      this.player =
        backend === "sw"
          ? new DirectPlayer(engine)
          : AtlasPlayer.create(engine, {
              lost: () => this.onContextLost(),
              restored: () => this.onContextRestored(),
            });
      this.state = "ready";
      // stopEngine() above released every surface's slot; the caller is about
      // to reattach itself, but the rest need telling too.
      if (healing) this.redrawAllSurfaces();
      return this.player;
    } catch (error) {
      this.engine = null;
      this.player = null;
      this.state = "idle";
      throw error;
    }
  }

  /**
   * Gives up every animation, then the player, then the engine — in that
   * order. webcanvas zeroes an object's finalizer token only after its native
   * free succeeds, so a dispose() against a terminated module leaves a
   * finalizer that later fires into whatever module has replaced it.
   */
  private async stopEngine(): Promise<void> {
    if (this.state === "idle") return;

    this.state = "stopping";
    for (const surface of this.surfaces) surface.release();
    try {
      this.player?.destroy();
      this.engine?.term();
    } catch (error) {
      console.error("Lottie: failed to stop the engine", error);
    }
    this.player = null;
    this.engine = null;
    this.state = "idle";
  }

  private redrawSurfacesOf(file: TFile): void {
    for (const surface of this.surfaces) {
      if (surface.file === file) void surface.redraw();
    }
  }

  private async rebuildMarkdownViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView) {
        // rebuildView() is what Obsidian itself uses; it is not in the public
        // typings. (setViewState(getViewState()) looks equivalent but is a no-op.)
        await (leaf as typeof leaf & { rebuildView(): Promise<void> }).rebuildView();
      }
    }
  }
}

class LottieSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: LottiePlugin,
  ) {
    super(app, plugin);
  }

  /**
   * The renderer is drawn by a render callback rather than bound to its key
   * with `control`: a bound control only stores the new value, while a switch
   * has to go through setRenderer() to restart the engine.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Renderer",
        desc: "What draws the animations. WebGL and WebGPU use the graphics card and are faster for demanding animations; go back to Software if one will not play or looks wrong.",
        render: (setting) => {
          setting.addDropdown((dropdown) => {
            for (const [value, label] of Object.entries(RENDERER_LABELS)) {
              dropdown.addOption(value, label);
            }
            dropdown
              .setValue(this.plugin.settings.renderer)
              .onChange((value) => void this.plugin.setRenderer(value as RendererType));
          });
        },
      },
    ];
  }
}
