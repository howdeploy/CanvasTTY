import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { layoutNineSliceFrame, layoutTiledFrame, pixelSkinArtworkBounds, pixelSkinControlLayout, pixelSkinSurfaceBounds, skinDetailLevel } from "../src/renderer/src/features/skins/SkinLayout.ts";
import { createSakuraSkin } from "../src/renderer/src/features/skins/skinSchema.ts";
import { SkinScheduler } from "../src/renderer/src/features/skins/SkinScheduler.ts";
import {
  pixelSkinAssetFilename,
  pixelSkinStateForSession,
  resolvePixelSkinAsset
} from "../src/renderer/src/features/skins/skinCatalog.ts";
import { needsGoldMinimalWorkingMarker, resolvePixelSkinViewAsset } from "../src/renderer/src/features/skins/skinViewAssets.ts";
import { expandedPixelSkinCardBounds, PIXEL_SKIN_MIN_CARD_SIZE } from "../src/renderer/src/features/skins/pixelSkinCardGeometry.ts";

const skin = createSakuraSkin("/sakura-frame.png");

test("tiled frame repeats edges and crops final tile without stretching corners", () => {
  const operations = layoutTiledFrame(skin.frame, 421, 277);
  assert.equal(operations.length > 10, true);
  const corners = operations.slice(-4);
  assert.deepEqual(corners.map(({ destination }) => [destination.x, destination.y]), [
    [0, 0], [353, 0], [0, 219], [353, 219]
  ]);
  assert.ok(corners.every(({ destination }) => destination.width === 68 && destination.height === 58));
  const top = operations.filter(({ destination }) => destination.y === 12);
  assert.equal(top.reduce((sum, { destination }) => sum + destination.width, 0), 421 - 2 * 68);
  assert.ok(top.at(-1).destination.width < skin.frame.tileLength);
  assert.ok(top.at(-1).source.width < skin.frame.edges[0].width);
  assert.deepEqual(layoutTiledFrame(skin.frame, 0, 300), []);
});

test("detail selection follows the setting and only F4 temporarily selects master", () => {
  for (const preferred of ["minimal", "detailed"]) {
    assert.equal(skinDetailLevel(preferred, false), preferred);
    assert.equal(skinDetailLevel(preferred, true), "master");
    assert.equal(skinDetailLevel(preferred, false), preferred);
  }
  assert.equal(skinDetailLevel("minimal", true), "master");
  assert.equal(skinDetailLevel("detailed", false), "detailed");
});

test("pixel controls fit the artwork plaques at every detail level", () => {
  const plaques = {
    sakura: { minimal: [72.5, 7.3, 16, 3.5], detailed: [70.5, 9.1, 16, 4.6], master: [69.4, 9.1, 17.9, 5.3] },
    matrix: { minimal: [75, 7.9, 17, 4], detailed: [75, 7.9, 17, 4], master: [75.5, 6.1, 16.5, 4.6] },
    "forest-cabin": { minimal: [77.4, 9.5, 16, 3.8], detailed: [76.5, 9.3, 15.5, 5.2], master: [76, 14.5, 16.5, 6.1] },
    "gold-black": { minimal: [79, 10, 14, 3.4], detailed: [79, 9.9, 14.2, 3.8], master: [75, 9.2, 13, 3.8] },
    cat: { minimal: [74, 10, 19, 3.9], detailed: [70, 9.3, 23.5, 4.7], master: [69.2, 9.4, 24.9, 5] },
    "gothic-eclipse": { minimal: [77.8, 7.5, 14.5, 6], detailed: [77.8, 7.5, 14.5, 6], master: [77.8, 7.5, 14.5, 6] }
  };
  for (const [theme, levels] of Object.entries(plaques)) {
    for (const [detail, [x, y, width, height]] of Object.entries(levels)) {
      for (const [cardWidth, cardHeight] of [[800, 500], [320, 240]]) {
        const controls = pixelSkinControlLayout(theme, detail, cardWidth, cardHeight);
        const art = pixelSkinArtworkBounds(theme, detail);
        assert.equal(controls.left, cardWidth * (x / 100 - art.x) / art.width);
        assert.equal(controls.top, cardHeight * (y / 100 - art.y) / art.height);
        assert.equal(controls.width, cardWidth * width / 100 / art.width);
        assert.equal(controls.height, cardHeight * height / 100 / art.height);
        assert.ok(controls.buttonSize > 0 && controls.buttonSize <= 22);
        assert.ok(controls.buttonSize + 4 <= controls.height);
        assert.ok(controls.buttonSize * 2 + 14 <= controls.width);
        assert.ok(controls.fontSize * 1.23 <= controls.buttonSize);
      }
    }
  }
  const custom = pixelSkinControlLayout("pixel:custom", "minimal", 320, 240);
  assert.ok(custom.buttonSize * 2 + 14 <= custom.width);
  assert.deepEqual(pixelSkinArtworkBounds("pixel:custom", "master"), { x: 0, y: 0, width: 1, height: 1 });
});

test("nine-slice keeps corner proportions and fills each resized rail", () => {
  const operations = layoutNineSliceFrame(1536, 1024, 600, 320, 220, 220);
  assert.equal(operations.length, 8);
  const [top, bottom, left, right, ...corners] = operations;
  assert.deepEqual([top.destination.x, top.destination.y], [68.75, 0]);
  assert.deepEqual([top.destination.width, top.destination.height], [462.5, 68.75]);
  assert.deepEqual([bottom.destination.y, bottom.destination.height], [251.25, 68.75]);
  assert.deepEqual([left.destination.x, left.destination.width], [0, 68.75]);
  assert.deepEqual([right.destination.x, right.destination.width], [531.25, 68.75]);
  assert.ok(corners.every(({ source, destination }) =>
    Math.abs(source.width / source.height - destination.width / destination.height) < 0.0001));
  assert.deepEqual(layoutNineSliceFrame(1536, 1024, 0, 320), []);
});

test("every built-in terminal opening remains inside its cropped artwork", () => {
  for (const theme of ["sakura", "matrix", "forest-cabin", "gold-black", "cat", "gothic-eclipse"]) {
    for (const detail of ["minimal", "detailed", "master"]) {
      const opening = pixelSkinSurfaceBounds(theme, detail, 1200, 800);
      assert.ok(opening.left > 0 && opening.left < opening.right && opening.right < 1200, `${theme}/${detail} horizontal`);
      assert.ok(opening.top > 0 && opening.top < opening.bottom && opening.bottom < 800, `${theme}/${detail} vertical`);
    }
  }
  for (const detail of ["minimal", "detailed", "master"]) {
    const opening = pixelSkinSurfaceBounds("cat", detail, 1200, 800);
    assert.ok(opening.right - opening.left >= 900, `cat/${detail} fills the illustrated opening`);
  }
  for (const detail of ["minimal", "detailed"]) {
    const opening = pixelSkinSurfaceBounds("sakura", detail, 1200, 800);
    assert.ok(opening.bottom <= 730, `sakura/${detail} clears the bottom rail`);
  }
  for (const detail of ["minimal", "detailed", "master"]) {
    const opening = pixelSkinSurfaceBounds("gothic-eclipse", detail, 1536, 1024);
    assert.ok(opening.right - opening.left >= 1000, `gothic-eclipse/${detail} fills the illustrated opening`);
    assert.ok(opening.bottom >= 900 && opening.bottom < 920, `gothic-eclipse/${detail} clears the bottom rail`);
  }
  assert.ok(pixelSkinSurfaceBounds("sakura", "detailed", 1200, 800).bottom <= 645,
    "sakura/detailed terminal output clears the bottom blossoms");
});

test("master terminal openings keep output within the themed frame", async () => {
  for (const [width, height] of [[600, 400], [900, 600]]) {
    const sakura = pixelSkinSurfaceBounds("sakura", "master", width, height);
    const matrix = pixelSkinSurfaceBounds("matrix", "master", width, height);
    const forest = pixelSkinSurfaceBounds("forest-cabin", "master", width, height);
    const gold = pixelSkinSurfaceBounds("gold-black", "master", width, height);
    const cat = pixelSkinSurfaceBounds("cat", "master", width, height);
    const gothic = pixelSkinSurfaceBounds("gothic-eclipse", "master", width, height);
    for (const opening of [sakura, matrix, forest, gold, cat, gothic]) {
      assert.ok(opening.left > 0 && opening.right < width);
      assert.ok(opening.top > 0 && opening.bottom < height);
      assert.ok(opening.right - opening.left >= width * 0.45);
      assert.ok(opening.bottom - opening.top >= height * 0.4);
    }
    const forestArt = pixelSkinArtworkBounds("forest-cabin", "master");
    const goldArt = pixelSkinArtworkBounds("gold-black", "master");
    const forestCat = {
      x: width * (200 / 1536 - forestArt.x) / forestArt.width,
      y: height * (800 / 1024 - forestArt.y) / forestArt.height
    };
    const forestFireplaceX = width * (1350 / 1536 - forestArt.x) / forestArt.width;
    const goldTopOrnamentY = height * (150 / 1024 - goldArt.y) / goldArt.height;

    assert.ok(forestCat.x < forest.left && forestCat.y >= forest.bottom);
    assert.ok(forestFireplaceX >= forest.right);
    assert.ok(gold.top >= goldTopOrnamentY);
    assert.ok(gold.right - gold.left >= width * 0.75 && gold.bottom - gold.top >= height * 0.6,
      "gold-black/master should use the opening up to the dragon rail");
    assert.ok(forest.right - forest.left >= width * 0.68 && forest.bottom - forest.top >= height * 0.4);
  }

  const css = await readFile(new URL("../src/renderer/src/styles/pixelTerminalSkins.css", import.meta.url), "utf8");
  const card = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
  assert.match(css, /\.terminal-card\[data-pixel-skin="true"\] \.terminal-card__surface\s*\{[^}]*z-index:\s*2;/s);
  assert.match(css, /\.terminal-card\[data-pixel-skin="true"\] \.terminal-card__surface \.xterm-viewport\s*\{[^}]*scrollbar-width:\s*none;/s);
  assert.match(css, /\.terminal-card\[data-pixel-skin="true"\]\s*\{[^}]*background:\s*transparent;/s);
  assert.match(css, /\.terminal-card\[data-pixel-skin="true"\] \.terminal-card__header\s*\{[^}]*top:\s*var\(--pixel-skin-top-inset\);/s);
  assert.match(css, /\.terminal-card\[data-pixel-skin="true"\] \.terminal-card__surface\s*\{[^}]*inset:\s*calc\(var\(--pixel-skin-top-inset\) \+ var\(--card-header-height\)\)/s);
  assert.match(css, /\.terminal-card\[data-pixel-skin="true"\] \.terminal-card__search\s*\{[^}]*top:\s*calc\(var\(--pixel-skin-top-inset\) \+ var\(--card-header-height\) \+ 6px\);/s);
  assert.match(css, /\.terminal-card\[data-pixel-skin="true"\] \.terminal-skin-canvas\s*\{[^}]*z-index:\s*1;/s);
  assert.match(css, /\.terminal-card\[data-pixel-skin="true"\] \.terminal-card__header\s*\{[^}]*z-index:\s*4;/s);
  assert.match(css, /--pixel-skin-top-inset/);
  assert.match(css, /--pixel-skin-bottom-inset/);
  assert.match(css, /\.terminal-card__skin-drag--top\s*\{[^}]*height:\s*var\(--pixel-skin-top-inset\);/s);
  assert.match(css, /\.terminal-card\[data-pixel-skin="true"\]\s*\{[^}]*outline:\s*none;/s);
  assert.match(css, /\.terminal-card\[data-pixel-skin="true"\] \.terminal-card__summary\s*\{[^}]*inset:\s*var\(--pixel-skin-top-inset\)/s);
  assert.match(card, /skinDetailLevel\(skinDetail, forceMasterDetail \|\| session\.role === "orchestrator"\)/);
  assert.match(card, /pixelSkinSurfaceBounds\(pixelSkinTheme, pixelDetail, size\.width, size\.height, 26,\s*pixelPack\?\.apertures\[pixelDetail\] \?\? pixelPack\?\.aperture\)/);
  assert.doesNotMatch(card, /pixelDetailRef|skinDetailLevel\([^)]*zoom|pixelDetail === "overview"/);
  // Summary mode changes at the threshold; continuous artwork scaling stays in CSS.
  assert.match(card, /const summaryMode = useCameraSelector\(camera, \(current\) => current\.zoom < SUMMARY_ZOOM\);/);
  assert.match(card, /\{RESIZE_DIRECTIONS\.map/);
  assert.match(card, /detail=\{pixelDetail\}/);
  assert.match(card, /terminal-card__skin-drag--\$\{edge\}/);
  assert.match(card, /\{!pixelControls && terminalActions\}[\s\S]*<Canvas2DSkinView[\s\S]*\{pixelControls && terminalActions\}/);
  assert.match(css, /\.terminal-card\[data-pixel-skin="true"\] \.terminal-card__actions--pixel\s*\{[^}]*z-index:\s*5;/s);
  const canvas = await readFile(new URL("../src/renderer/src/features/skins/Canvas2DSkinView.tsx", import.meta.url), "utf8");
  assert.match(canvas, /data-overlay=\{transparentCenter\}/);
  assert.match(canvas, /<canvas ref=\{frameRef\} className="terminal-skin-canvas terminal-skin-canvas--frame"/);
  assert.doesNotMatch(canvas, /opaqueCenter &&/);
  assert.match(canvas, /context\.clip\("evenodd"\)/);
  assert.doesNotMatch(canvas, /overview|artworkDetail/);
  assert.match(canvas, /context\.drawImage\(image,\s*art\.x \* image\.naturalWidth/s);
  assert.match(css, /\.terminal-skin-canvas\[data-overlay="true"\]\s*\{\s*z-index:\s*3;/s);
  assert.match(canvas, /if \(canvasRef\.current\) paint\(canvasRef\.current, current\);/);
  assert.doesNotMatch(canvas, /drawSakura|sakuraAtlas|petalSprite/);
});

test("skin changes retain decoded artwork while loading, ignore stale loads and respect reduced motion", async () => {
  const source = await readFile(new URL("../src/renderer/src/features/skins/Canvas2DSkinView.tsx", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("  const canvasRef ="), source.indexOf("  return <>"));
  const slots = [], effects = [], loads = [], paints = [], fades = [];
  const canvases = [{}, {}];
  let cursor = 0, reducedMotion = false;
  const effect = (callback, dependencies) => {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
      effects.push(() => {
        previous?.cleanup?.();
        slots[index] = { dependencies, cleanup: callback() };
      });
    }
  };
  const component = runInNewContext(stripTypeScriptTypes(`(props) => {
    const { theme, status, artState, width, height, detail, surfaceBounds } = props;
    ${body}
    return [canvasRef, frameRef];
  }`), {
    useRef(initial) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = value; }];
    },
    useEffect: effect, useLayoutEffect: effect,
    isPixelSkinPackId: () => true, isPixelSkinThemeId: () => false,
    usePixelSkinPackAssets: () => ({ minimal_idle: "idle", minimal_working: "working", minimal_completed: "completed" }),
    pixelSkinStateForSession, pixelSkinSurfaceBounds,
    acquireSkinImage(url) {
      const load = { url, released: false };
      const image = new Promise((resolve, reject) => Object.assign(load, { resolve, reject }));
      loads.push(load);
      return { image, release() { load.released = true; } };
    },
    imageHasTransparentCenter: image => image.transparent,
    paint: (_canvas, state, frameOnly) => { if (!frameOnly) paints.push(state); },
    fadePreviousCanvas: canvas => fades.push(canvas),
    document: { hidden: false },
    window: { matchMedia: () => ({ matches: reducedMotion }) }
  });
  const render = status => {
    cursor = 0;
    const refs = component({ theme: "pixel:test", status, width: 1200, height: 800, detail: "minimal" });
    refs.forEach((ref, index) => { ref.current = canvases[index]; });
    effects.splice(0).forEach(callback => callback());
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const idle = { transparent: false }, working = { transparent: true };
  render("idle");
  assert.equal(paints.at(-1).image, null, "only the initial load uses the fallback");
  loads.at(-1).resolve(idle);
  await settle();
  render("idle");
  render("working");
  assert.equal(paints.at(-1).image, idle);
  assert.equal(paints.at(-1).transparentCenter, false, "loading cannot change the terminal's backing layer");
  const stale = loads.at(-1);
  render("done");
  assert.equal(stale.released, true);
  stale.resolve(working);
  loads.at(-1).reject(new Error("broken artwork"));
  await settle();
  render("done");
  assert.equal(paints.at(-1).image, idle, "stale and failed loads preserve the previous artwork");
  render("working");
  loads.at(-1).resolve(working);
  await settle();
  render("working");
  assert.equal(paints.at(-1).image, working);
  assert.equal(fades.length, 2, "only the two skin layers fade, once the replacement is ready");
  reducedMotion = true;
  render("idle");
  loads.at(-1).resolve(idle);
  await settle();
  render("idle");
  assert.equal(paints.at(-1).image, idle);
  assert.equal(fades.length, 2, "reduced motion swaps ready artwork without animation");
});

test("pixel cards grow to a readable terminal size and separate neighboring windows", () => {
  const cards = [
    { id: "left", position: { x: 100, y: 100 }, size: { width: 700, height: 430 } },
    { id: "right", position: { x: 920, y: 100 }, size: { width: 700, height: 430 } }
  ];
  const expanded = expandedPixelSkinCardBounds(cards);
  assert.deepEqual(expanded.map(({ id }) => id), ["left", "right"]);
  assert.deepEqual(expanded[0].bounds.size, PIXEL_SKIN_MIN_CARD_SIZE);
  assert.ok(expanded[1].bounds.position.x >= expanded[0].bounds.position.x + PIXEL_SKIN_MIN_CARD_SIZE.width + 40);
  assert.deepEqual(expandedPixelSkinCardBounds(expanded.map(({ id, bounds }) => ({ id, ...bounds }))), []);
  const catArt = pixelSkinArtworkBounds("cat", "master");
  assert.equal(pixelSkinSurfaceBounds("cat", "master", 1200, 800).top,
    800 * (0.185 - catArt.y) / catArt.height);
  assert.equal(pixelSkinSurfaceBounds("cat", "master", 1200, 800).left,
    1200 * (0.145 - catArt.x) / catArt.width);
});

test("asset lookup is exact by theme and status with only same-state LOD fallback", () => {
  assert.equal(pixelSkinAssetFilename("sakura", "minimal", "working"), "sakura_l1_working.avif");
  assert.equal(pixelSkinAssetFilename("forest-cabin", "master", "idle"), "forest_cabin_master_idle.avif");
  const assets = {
    "sakura_l2_working.avif": "/assets/sakura-l2-work.png",
    "sakura_l1_idle.avif": "/assets/sakura-l1-idle.png",
    "matrix_l1_completed.avif": "/assets/matrix-completed-candidate.png"
  };
  assert.deepEqual(resolvePixelSkinAsset("sakura", "master", "working", assets), {
    kind: "asset", filename: "sakura_l2_working.avif", resolvedDetail: "detailed", url: "/assets/sakura-l2-work.png"
  });
  assert.deepEqual(resolvePixelSkinAsset("sakura", "minimal", "working", assets), {
    kind: "missing", filename: "sakura_l1_working.avif"
  });
  assert.deepEqual(resolvePixelSkinAsset("matrix", "minimal", "idle", assets), {
    kind: "missing", filename: "matrix_l1_idle.avif"
  });
});

test("Gold minimal working reuses only its idle frame and adds a status marker", () => {
  const assets = {
    "gold_black_l1_idle.avif": "/assets/gold-idle.png",
    "gold_black_detailed_working.avif": "/assets/gold-detailed-working.png",
    "sakura_l1_idle.avif": "/assets/sakura-idle.png"
  };

  assert.deepEqual(resolvePixelSkinAsset("gold-black", "minimal", "working", assets), {
    kind: "missing", filename: "gold_black_l1_working.avif"
  });
  assert.deepEqual(resolvePixelSkinViewAsset("gold-black", "minimal", "working", assets), {
    kind: "asset", filename: "gold_black_l1_idle.avif", resolvedDetail: "minimal", url: "/assets/gold-idle.png"
  });
  assert.deepEqual(resolvePixelSkinViewAsset("gold-black", "detailed", "working", assets), {
    kind: "asset", filename: "gold_black_detailed_working.avif", resolvedDetail: "detailed", url: "/assets/gold-detailed-working.png"
  });
  assert.deepEqual(resolvePixelSkinViewAsset("sakura", "minimal", "working", assets), {
    kind: "missing", filename: "sakura_l1_working.avif"
  });
  assert.equal(needsGoldMinimalWorkingMarker("gold-black", "minimal", "working", assets), true);
  assert.equal(needsGoldMinimalWorkingMarker("gold-black", "minimal", "working", {}), false);
  assert.equal(needsGoldMinimalWorkingMarker("gold-black", "minimal", "idle", assets), false);
  assert.equal(needsGoldMinimalWorkingMarker("gold-black", "master", "working", assets), false);
  assert.equal(needsGoldMinimalWorkingMarker("gold-black", "minimal", "working", {
    "gold_black_l1_working.avif": "/assets/gold-working.png",
    "gold_black_l1_idle.avif": "/assets/gold-idle.png"
  }), false);
});

test("working art clears on idle, while explicit completion selects completed art", () => {
  assert.equal(pixelSkinStateForSession("working"), "working");
  for (const status of ["idle", "needs_approval", "unavailable"]) {
    assert.equal(pixelSkinStateForSession(status), "idle");
  }
  assert.equal(pixelSkinStateForSession("done"), "completed");
  assert.equal(pixelSkinStateForSession("failed"), "completed");
  assert.equal(pixelSkinStateForSession("idle", true), "completed");
  assert.equal(pixelSkinStateForSession("working", true), "working");
});

test("pilot runtime contains all three states for all bundled themes", async () => {
  const directory = new URL("../src/renderer/src/features/skins/assets/pilots/", import.meta.url);
  const files = new Set(await readdir(directory));
  const themeLevels = {
    sakura: ["l1", "l2", "master"],
    matrix: ["l1", "l2", "master"],
    forest_cabin: ["minimal", "detailed", "master"],
    gold_black: ["l1", "detailed", "master"],
    cat: ["minimal", "detailed", "master"],
    gothic_eclipse: ["minimal", "detailed", "master"]
  };
  for (const [theme, levels] of Object.entries(themeLevels)) {
    for (const level of levels) {
      for (const state of ["idle", "working", "completed"]) {
        if (theme === "gold_black" && level === "l1" && state === "working") continue;
        assert.ok(files.has(`${theme}_${level}_${state}.avif`), `${theme} ${level} ${state} asset`);
      }
    }
  }
});

test("one scheduler keeps registrations and stops static work when hidden or disposed", () => {
  const listeners = new Map();
  const documentTarget = {
    hidden: false,
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); }
  };
  const scheduler = new SkinScheduler(documentTarget);
  let firstDraws = 0;
  let secondDraws = 0;
  const first = scheduler.register(() => { firstDraws += 1; });
  const second = scheduler.register(() => { secondDraws += 1; });
  first.update(true, 0);
  second.update(true, 0);
  assert.deepEqual([firstDraws, secondDraws, scheduler.size], [1, 1, 2]);
  first.invalidate();
  assert.deepEqual([firstDraws, secondDraws], [2, 1]);
  second.update(false, 12);
  second.invalidate();
  assert.equal(secondDraws, 1);
  documentTarget.hidden = true;
  listeners.get("visibilitychange")();
  first.invalidate();
  assert.equal(firstDraws, 2);
  documentTarget.hidden = false;
  listeners.get("visibilitychange")();
  assert.deepEqual([firstDraws, secondDraws], [3, 1]);
  first.dispose();
  second.dispose();
  assert.equal(scheduler.size, 0);
  scheduler.dispose();
  assert.equal(listeners.size, 0);
});

test("Sakura atlas is a bounded raster asset", async () => {
  const image = await readFile(new URL("../src/renderer/src/features/skins/assets/sakura-frame.png", import.meta.url));
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(image.readUInt32BE(16), 1536);
  assert.equal(image.readUInt32BE(20), 1024);
  assert.ok(image.byteLength < 2_000_000);
});
