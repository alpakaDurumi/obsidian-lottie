import {
  App,
  Component,
  MarkdownRenderChild,
  MarkdownView,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
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

/** File extension claimed for `![[…]]` embeds. */
const EXTENSION = "json";

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

/** A Lottie document is a JSON object with a layer list and a frame range. */
function isLottieJson(text: string): boolean {
  try {
    const doc: unknown = JSON.parse(text);
    return (
      typeof doc === "object" &&
      doc !== null &&
      Array.isArray((doc as { layers?: unknown }).layers) &&
      typeof (doc as { fr?: unknown }).fr === "number" &&
      typeof (doc as { op?: unknown }).op === "number"
    );
  } catch {
    return false;
  }
}

/**
 * Remembers which `.json` files are Lottie documents, so the embed creator —
 * which has to answer synchronously — can leave everything else to Obsidian.
 * Files are classified in the background after startup and re-checked as
 * they change; an unknown file is assumed to be Lottie until read.
 */
class LottieIndex extends Component {
  private known = new Map<string, boolean>();

  constructor(private app: App) {
    super();
  }

  onload(): void {
    const { vault } = this.app;
    this.registerEvent(vault.on("create", (file) => void this.classify(file)));
    this.registerEvent(vault.on("modify", (file) => void this.classify(file)));
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
    return this.known.get(file.path);
  }

  remember(file: TFile, lottie: boolean): void {
    this.known.set(file.path, lottie);
  }

  private async classify(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== EXTENSION) return;
    try {
      this.known.set(file.path, isLottieJson(await this.app.vault.cachedRead(file)));
    } catch {
      this.known.delete(file.path);
    }
  }
}

let nextCanvasId = 0;

class LottieEmbed extends MarkdownRenderChild {
  private canvas: Canvas | null = null;
  private animation: LottieAnimation | null = null;
  private picture: Picture | null = null;
  /** The animation's own dimensions, before any alias size is applied. */
  private nativeSize: { width: number; height: number } | null = null;
  private observer: IntersectionObserver | null = null;
  private aliasObserver: MutationObserver | null = null;
  private started = false;
  private tornDown = false;

  constructor(
    containerEl: HTMLElement,
    private plugin: LottiePlugin,
    private file: TFile,
  ) {
    super(containerEl);
  }

  // Called by Obsidian's embed loader once the component is attached.
  async loadFile(): Promise<void> {
    this.plugin.embeds.add(this);
    this.containerEl.empty();
    this.containerEl.addClass("lottie-thorvg");
    this.containerEl.dataset.renderer = this.plugin.settings.renderer;

    const el = this.containerEl.createEl("canvas", {
      attr: { id: `lottie-thorvg-${nextCanvasId++}` },
    });

    // ThorVG addresses the canvas by CSS selector, so it has to be in the
    // document before the engine looks it up — and an animation scrolled out of
    // view has no reason to burn frames. One observer covers both.
    this.observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void this.start(el);
      else this.animation?.pause();
    });
    this.observer.observe(el);

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
    this.plugin.embeds.delete(this);
    this.teardown();
  }

  /**
   * Releases the ThorVG objects. Must run while their engine is still alive:
   * webcanvas zeroes an object's finalizer token only after its native free
   * succeeds, so a dispose() against a terminated module leaves a finalizer
   * that later fires into whatever module has replaced it.
   */
  teardown(): void {
    if (this.tornDown) return;
    this.tornDown = true;
    this.observer?.disconnect();
    this.aliasObserver?.disconnect();
    try {
      this.animation?.dispose();
      this.canvas?.destroy();
    } catch (error) {
      console.error("Lottie: failed to release an embed", error);
    }
    this.animation = null;
    this.canvas = null;
    this.picture = null;
  }

  /**
   * Applies whatever size and alignment the alias currently asks for. Safe to
   * call before the animation exists — the size is then read again on start().
   */
  private applyAlias(): void {
    const alignment = requestedAlignment(this.containerEl);
    if (alignment) this.containerEl.dataset.align = alignment;
    else delete this.containerEl.dataset.align;

    const picture = this.picture;
    const canvas = this.canvas;
    if (!picture || !canvas || this.tornDown) return;

    const native = this.nativeSize;
    if (!native) return;
    const { drawWidth, drawHeight } = this.drawSize(native.width, native.height);
    canvas.resize(drawWidth, drawHeight);
    picture.size(drawWidth, drawHeight);
    canvas.update().render();
  }

  private async start(el: HTMLCanvasElement): Promise<void> {
    if (this.started) {
      this.resume();
      return;
    }
    this.started = true;
    // In reading view the alias attributes are on the container from the
    // start, but Live Preview builds the widget, calls loadFile(), and only
    // then applies them. This runs off an IntersectionObserver callback, which
    // is later than both.
    this.applyAlias();

    try {
      const json = await this.plugin.app.vault.cachedRead(this.file);
      const lottie = isLottieJson(json);
      this.plugin.index.remember(this.file, lottie);
      if (!lottie) {
        this.showGenericCard();
        return;
      }

      const TVG = await this.plugin.engine();
      // The awaits above give the note time to close underneath us.
      if (this.tornDown) return;

      const animation = new TVG.LottieAnimation();
      animation.load(json);

      const picture = animation.picture;
      if (!picture) throw new Error("ThorVG could not load the animation");

      const { width, height } = picture.size();
      this.nativeSize = { width, height };
      const { drawWidth, drawHeight } = this.drawSize(width, height);

      const canvas = new TVG.Canvas(`#${el.id}`, {
        width: drawWidth,
        height: drawHeight,
      });
      picture.size(drawWidth, drawHeight);
      canvas.add(picture);

      this.picture = picture;
      this.animation = animation;
      this.canvas = canvas;
      this.resume();
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Picks the pixel size to draw at, following the rules images get here:
   * a width alone scales by aspect ratio (enlarging if asked), a width and a
   * height stretch to exactly that, and no size at all renders at the
   * animation's own dimensions. Obsidian's parser cannot produce a height
   * without a width, so that case does not arise.
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

  // ThorVG drives its own frame loop but leaves painting to the caller, so each
  // frame has to be pushed to the canvas here.
  private resume(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    this.animation?.play(() => canvas.update().render());
  }

  /**
   * A `.json` that is not a Lottie document gets the same card Obsidian shows
   * for any other file. From now on the index knows the file, so the next
   * render skips this component entirely and Obsidian draws its own card.
   */
  private showGenericCard(): void {
    this.observer?.disconnect();
    const el = this.containerEl;
    el.empty();
    el.removeClass("lottie-thorvg");
    delete el.dataset.renderer;
    delete el.dataset.align;
    el.addClasses(["file-embed", "mod-generic"]);
    const title = el.createDiv({ cls: "file-embed-title" });
    setIcon(title.createSpan({ cls: "file-embed-icon" }), "file");
    title.appendText(this.file.name);
  }

  private fail(error: unknown): void {
    console.error("Lottie:", error);
    this.containerEl.empty();
    this.containerEl.createDiv({
      cls: "lottie-thorvg-error",
      text: `Could not render ${this.file.name}`,
    });
  }
}

export default class LottiePlugin extends Plugin {
  settings: LottieSettings = { ...DEFAULT_SETTINGS };

  /** Backend the running engine was created with, for the settings screen. */
  activeRenderer: RendererType | null = null;

  /** Every embed currently holding ThorVG objects. */
  readonly embeds = new Set<LottieEmbed>();

  index!: LottieIndex;

  // ThorVG caches its engine on the first init() and hands the same instance
  // back to every later call, so one module is shared by all embeds and the
  // renderer stays fixed until term() clears it.
  private enginePromise: Promise<ThorVGNamespace> | null = null;

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new LottieSettingTab(this.app, this));
    this.index = this.addChild(new LottieIndex(this.app));

    const registry = embedRegistry(this.app);
    // registerExtension throws on a duplicate, and a plugin that failed to
    // unload cleanly (or another plugin) may already hold the extension.
    if (registry.isExtensionRegistered(EXTENSION)) registry.unregisterExtension(EXTENSION);
    registry.registerExtension(EXTENSION, (ctx, file) =>
      this.index.isLottie(file) === false ? null : new LottieEmbed(ctx.containerEl, this, file),
    );
    this.register(() => registry.unregisterExtension(EXTENSION));

    // When the plugin is (re)enabled while notes are already open, Live
    // Preview keeps the widgets the previous instance built — canvases with no
    // engine behind them. Rebuild those views so they pick this instance up.
    // At startup layoutReady is still false and views render after plugins
    // load anyway, so nothing needs doing then.
    if (this.app.workspace.layoutReady) await this.rebuildMarkdownViews();
  }

  async onunload(): Promise<void> {
    await this.terminateEngine();
  }

  engine(): Promise<ThorVGNamespace> {
    if (!this.enginePromise) {
      const renderer = this.settings.renderer;
      this.enginePromise = ThorVG.init({ renderer, locateFile: () => wasmBlobUrl() }).then((tvg) => {
        this.activeRenderer = renderer;
        return tvg;
      });
    }
    return this.enginePromise;
  }

  async setRenderer(renderer: RendererType): Promise<void> {
    if (renderer === this.settings.renderer) return;
    this.settings.renderer = renderer;
    await this.saveData(this.settings);

    // term() drops the cached module so the next init() can pick a different
    // backend; every open note is then rebuilt against the new engine, in both
    // reading view and Live Preview.
    await this.terminateEngine();
    await this.rebuildMarkdownViews();
  }

  /** Releases every embed's objects first, then the engine — in that order. */
  private async terminateEngine(): Promise<void> {
    for (const embed of this.embeds) embed.teardown();
    const engine = this.enginePromise;
    this.enginePromise = null;
    this.activeRenderer = null;
    if (!engine) return;
    try {
      (await engine).term();
    } catch (error) {
      console.error("Lottie: failed to terminate engine", error);
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

  display(): void {
    this.containerEl.empty();

    new Setting(this.containerEl)
      .setName("Renderer")
      .setDesc(
        "ThorVG rendering backend. WebGL and WebGPU take one GPU context per " +
          "animation, and browsers cap how many a page may hold at once.",
      )
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(RENDERER_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown.setValue(this.plugin.settings.renderer).onChange(async (value) => {
          await this.plugin.setRenderer(value as RendererType);
          this.display();
        });
      });

    const active = this.plugin.activeRenderer;
    new Setting(this.containerEl)
      .setName("Active engine")
      .setDesc(
        active
          ? `Animations are currently drawn with ${RENDERER_LABELS[active]}.`
          : "No animation has been rendered yet; the engine starts with the first one.",
      );
  }
}
