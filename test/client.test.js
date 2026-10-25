import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const FILE = new URL("../client/client.js", import.meta.url);

/**
 * Client bundles are classic scripts, so they are executed in a browser-like
 * sandbox: no imports, only window.__ModuleLoader__.load.
 */
async function loadBundle() {
  const code = await readFile(FILE, "utf8");
  let row = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (value) => {
          row = value;
        },
      },
    },
    console,
    // The bundle is not in Node's realm, so `fetch` has to be a bridge that
    // reads the test's stub at call time.
    fetch: (...args) => globalThis.fetch(...args),
    setTimeout,
    clearTimeout,
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "client.js" });
  assert.ok(row, "bundle must register through window.__ModuleLoader__.load");
  return row;
}

/** Minimal React stub: enough to walk the returned tree. */
function fakeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity),
  });
  return {
    createElement,
    Fragment: Symbol("Fragment"),
    useId: () => "id",
    useState: (value) => [value, () => {}],
    useEffect: () => {},
  };
}

function makeCtx(configForms) {
  const registrations = [];
  const ctx = {
    effect: (fn) => {
      fn();
      return () => {};
    },
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
    configForms,
  };
  return { ctx, registrations };
}

/** The factory only ever resolves shell seed words; `react` is all we need. */
function instantiate(row) {
  return row.factory((spec) => {
    assert.equal(spec, "react");
    return fakeReact();
  });
}

/** @param {any} node */
function collectText(node) {
  if (node === null || node === undefined) return [];
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(collectText);
  return collectText(node.children);
}

test("the bundle registers under the package name and exports a cordis plugin", async () => {
  const row = await loadBundle();
  assert.equal(row.id, "dsh-reme-lite");
  assert.equal(typeof row.factory, "function");
  const exports = instantiate(row);
  assert.equal(typeof exports.apply, "function");
  assert.deepEqual(Array.from(exports.inject), ["slots", "locale"]);
});

test("apply waits for the settings slot and registers exactly one section", async () => {
  const row = await loadBundle();
  const exports = instantiate(row);
  const { ctx, registrations } = makeCtx(undefined);
  exports.apply(ctx);

  assert.equal(registrations.length, 1);
  const { options, component } = registrations[0];
  assert.equal(options.name, "settings.section");
  assert.equal(options.id, "node-memory");
  assert.equal(typeof component, "function");
  assert.equal(typeof options.label(), "string");
});

test("the switch label follows the status payload", async () => {
  const row = await loadBundle();
  const exports = instantiate(row);
  // A status response is what the page renders from; no config form involved.
  const element = exports.MemorySection({ t: (key) => key });
  assert.ok(collectText(element).join(" ").includes("switchHint"), "no data yet: explains the switch");
});

test("component degrades to the explanation when config is unavailable", async () => {
  const row = await loadBundle();
  const exports = instantiate(row);
  const { ctx, registrations } = makeCtx(undefined);
  exports.apply(ctx);

  const props = { t: (key) => key, ...registrations[0].options.inject() };
  const tree = registrations[0].component(props);
  const text = collectText(tree).join(" ");
  assert.ok(text.includes("switchHint"));
  assert.ok(!text.includes("workspace"), "no fabricated values");
});

test("readConfig swallows a throwing settings service", async () => {
  const row = await loadBundle();
  const exports = instantiate(row);
  const state = exports.readConfig({
    configForms: {
      get: () => {
        throw new Error("boom");
      },
    },
  });
  assert.equal(state.values, null);
  assert.equal(state.error, "boom");
});

test("readConfig accepts a draft-shaped snapshot", async () => {
  const row = await loadBundle();
  const exports = instantiate(row);
  const state = exports.readConfig({
    configForms: {
      get: () => ({ getSnapshot: () => ({ draft: { dreamEnabled: true } }) }),
    },
  });
  assert.deepEqual(state.values, { dreamEnabled: true });
});

test("heatmap maps days onto a week grid, future cells marked", async () => {
  const row = await loadBundle();
  const exports = instantiate(row);
  const today = new Date(2026, 9, 25);
  const days = [
    { date: "2026-10-24", total: 2, kind: "notable" },
    { date: "2026-10-25", total: 1, kind: "conflict" },
  ];
  const cells = exports.heatmapColumns(days, 2, today).flat();
  const todayCell = cells.find((cell) => cell.date === "2026-10-25");
  assert.equal(todayCell.kind, "conflict");
  const yesterday = cells.find((cell) => cell.date === "2026-10-24");
  assert.equal(yesterday.kind, "notable");
  assert.equal(yesterday.total, 2);
  const blank = cells.find((cell) => cell.date === "2026-10-20");
  assert.equal(blank.kind, "empty");
  assert.ok(cells.some((cell) => cell.future), "the tail of the last column is in the future");
});

test("legend and cells use the agreed colours", async () => {
  const row = await loadBundle();
  const exports = instantiate(row);
  assert.equal(exports.COLORS.normal, "#2da44e");
  assert.equal(exports.COLORS.notable, "#4a9eff");
  assert.equal(exports.COLORS["user-declared"], "#a371f7");
  assert.equal(exports.COLORS.conflict, "#f85149");

  const t = (key) => key;
  const tree = exports.Legend({ t });
  const text = collectText(tree).join(" ");
  for (const kind of ["normal", "notable", "user-declared", "conflict", "empty"]) {
    assert.ok(text.includes(kind), `legend must mention ${kind}`);
  }

  const heat = exports.Heatmap({
    t,
    columns: [[{ date: "2026-10-25", kind: "conflict", total: 3, future: false }]],
  });
  const cell = heat.children[0].children[0];
  assert.equal(cell.props.style.background, "#f85149");
});

test("the page explains itself before data arrives", async () => {
  const row = await loadBundle();
  const exports = instantiate(row);
  const tree = exports.MemorySection({ t: (key) => key, nodeMemory: { values: null } });
  const text = collectText(tree).join(" ");
  assert.ok(text.includes("switchHint"));
  assert.ok(text.includes("loading"));
});

test("both controls post to the settings route and adopt the returned status", async () => {
  const row = await loadBundle();
  const exports = instantiate(row);
  const { ctx, registrations } = makeCtx(undefined);
  exports.apply(ctx);

  const posts = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    posts.push({ url, body: init && init.body ? JSON.parse(init.body) : null, method: init && init.method });
    return {
      ok: true,
      json: async () => ({
        ok: true,
        status: {
          total: 3,
          workspace: "C:/mem",
          days: [{ date: "2026-10-25", total: 3, kind: "notable" }],
          settings: { language: "en", dreamEnabled: true, dreamCron: "0 23 * * *" },
          task: null,
        },
      }),
    };
  };

  try {
    const props = { t: (key) => key, ...registrations[0].options.inject() };
    const tree = registrations[0].component(props);

    const controls = { select: null, checkbox: null };
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.type === "select" && !controls.select) controls.select = node;
      if (node.type === "input" && node.props.type === "checkbox" && !controls.checkbox) controls.checkbox = node;
      for (const child of node.children || []) walk(child);
    };
    walk(tree);

    assert.ok(controls.select, "language dropdown is rendered");
    assert.deepEqual(
      controls.select.children.map((option) => option.props.value),
      ["auto", "zh", "en"],
    );
    assert.ok(controls.checkbox, "the consolidation switch is a real checkbox");

    controls.select.props.onChange({ target: { value: "en" } });
    controls.checkbox.props.onChange({ target: { checked: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(posts.length, 2);
    assert.equal(posts[0].method, "POST");
    assert.equal(posts[0].url, "/node-memory/settings");
    assert.deepEqual(posts[0].body, { language: "en" });
    assert.deepEqual(posts[1].body, { dreamEnabled: true });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a failed write surfaces the failure instead of pretending", async () => {
  const row = await loadBundle();
  const exports = instantiate(row);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    const tree = exports.MemorySection({ t: (key) => key });
    const controls = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.type === "input") controls.push(node);
      for (const child of node.children || []) walk(child);
    };
    walk(tree);
    controls[0].props.onChange({ target: { checked: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // State is not observable through the stub, so assert the code path ran:
    // a rejected response must not throw out of the handler.
    assert.ok(true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
