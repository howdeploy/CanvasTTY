import assert from "node:assert/strict";
import test from "node:test";
import {
  findHomePlacement,
  homeGridPixelSize,
  homeLayoutFitsGrid,
  minimumHomeGridSize,
  placeHomeWidget,
  placementsOverlap,
  pluginWidgetId,
  resizeHomePlacement,
  updateHomePlacement
} from "../src/renderer/src/features/home/homeLayout.ts";
import { pluginHomeWidgetOptions } from "../src/renderer/src/features/home/pluginHomeWidgets.ts";

test("lists enabled and disabled plugin Home widgets beside core options", () => {
  const plugins = [{
    enabled: true,
    manifest: {
      id: "com.example.music",
      name: "Music plugin",
      contributions: [{
        id: "player",
        kind: "home-widget",
        title: "Music",
        description: "Compact player",
        entry: "index.html",
        defaultSize: { columns: 6, rows: 3 }
      }, {
        id: "library",
        kind: "canvas-app",
        title: "Library",
        entry: "library.html",
        defaultSize: { width: 800, height: 600 }
      }]
    }
  }, {
    enabled: false,
    manifest: {
      id: "com.example.weather",
      name: "Weather plugin",
      contributions: [{
        id: "forecast",
        kind: "home-widget",
        title: "Forecast",
        entry: "forecast.html",
        defaultSize: { columns: 4, rows: 2 }
      }]
    }
  }];

  assert.deepEqual(pluginHomeWidgetOptions(plugins, "en"), [{
    widgetId: "plugin:com.example.music:player",
    label: "Music",
    description: "Music plugin · Compact player",
    size: { columns: 6, rows: 3 },
    pluginEnabled: true
  }, {
    widgetId: "plugin:com.example.weather:forecast",
    label: "Forecast",
    description: "Weather plugin",
    size: { columns: 4, rows: 2 },
    pluginEnabled: false
  }]);
});

test("builds stable plugin widget ids", () => {
  assert.equal(pluginWidgetId("com.example.clock", "weekly"), "plugin:com.example.clock:weekly");
});

test("finds the first free Home grid area without overlap", () => {
  const current = [
    { widgetId: "one", column: 0, row: 0, columnSpan: 8, rowSpan: 3 },
    { widgetId: "two", column: 8, row: 0, columnSpan: 4, rowSpan: 3 }
  ];
  assert.deepEqual(findHomePlacement(current, "three", { columns: 5, rows: 2 }), {
    widgetId: "three",
    column: 0,
    row: 3,
    columnSpan: 5,
    rowSpan: 2
  });
});

test("returns null when a widget cannot fit", () => {
  assert.equal(findHomePlacement([
    { widgetId: "full", column: 0, row: 0, columnSpan: 12, rowSpan: 8 }
  ], "new", { columns: 1, rows: 1 }, { columns: 12, rows: 8 }), null);
});

test("grows Home automatically when a new widget needs spare space", () => {
  assert.deepEqual(placeHomeWidget([
    { widgetId: "full", column: 0, row: 0, columnSpan: 12, rowSpan: 8 }
  ], "new", { columns: 4, rows: 2 }, { columns: 12, rows: 8 }), {
    placement: { widgetId: "new", column: 0, row: 8, columnSpan: 4, rowSpan: 2 },
    gridSize: { columns: 12, rows: 10 }
  });
});

test("derives visible Home bounds and prevents shrinking through placed widgets", () => {
  assert.deepEqual(homeGridPixelSize({ columns: 16, rows: 12 }), { width: 1582, height: 1062 });
  assert.deepEqual(minimumHomeGridSize([
    { widgetId: "far", column: 15, row: 11, columnSpan: 4, rowSpan: 3 }
  ]), { columns: 19, rows: 14 });
});

test("rejects overlapping and out-of-bounds drag results", () => {
  const current = [
    { widgetId: "one", column: 0, row: 0, columnSpan: 6, rowSpan: 4 },
    { widgetId: "two", column: 6, row: 0, columnSpan: 6, rowSpan: 4 }
  ];
  assert.equal(updateHomePlacement(current, {
    widgetId: "one", column: 5, row: 0, columnSpan: 6, rowSpan: 4
  }), null);
  assert.equal(updateHomePlacement(current, {
    widgetId: "one", column: -1, row: 0, columnSpan: 6, rowSpan: 4
  }), null);
  assert.equal(placementsOverlap(current[0], current[1]), false);
});

test("temporarily allows Home widgets outside while keeping save validation strict", () => {
  const current = [
    { widgetId: "one", column: 0, row: 0, columnSpan: 4, rowSpan: 3 }
  ];
  const outside = {
    widgetId: "one", column: -2, row: 1, columnSpan: 4, rowSpan: 3
  };

  assert.deepEqual(updateHomePlacement(
    current,
    outside,
    { columns: 12, rows: 8 },
    { allowOutside: true }
  ), [outside]);
  assert.equal(homeLayoutFitsGrid([outside], { columns: 12, rows: 8 }), false);
  assert.equal(homeLayoutFitsGrid(current, { columns: 12, rows: 8 }), true);
});

test("resizes Home widgets from every anchored edge", () => {
  const placement = { widgetId: "one", column: 4, row: 3, columnSpan: 4, rowSpan: 3 };

  assert.deepEqual(resizeHomePlacement(placement, "nw", -2, -1), {
    widgetId: "one", column: 2, row: 2, columnSpan: 6, rowSpan: 4
  });
  assert.deepEqual(resizeHomePlacement(placement, "e", 2, 8), {
    widgetId: "one", column: 4, row: 3, columnSpan: 6, rowSpan: 3
  });
  assert.deepEqual(resizeHomePlacement(placement, "w", 2, 8), {
    widgetId: "one", column: 6, row: 3, columnSpan: 2, rowSpan: 3
  });
  assert.deepEqual(resizeHomePlacement(placement, "n", 8, 1), {
    widgetId: "one", column: 4, row: 4, columnSpan: 4, rowSpan: 2
  });
});
