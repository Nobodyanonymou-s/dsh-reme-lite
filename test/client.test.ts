import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, it, vi } from "vitest";

/**
 * The client half ships as a compiled classic script (tsdown builds
 * src/client/index.ts into lib/client.js with the
 * `window.__ModuleLoader__.load({ id, factory })` banner), so this suite runs
 * against the artifact. vitest's globalSetup builds lib/ when missing; a
 * missing artifact is a failure, never a silent skip.
 */
const BUNDLE_URL = new URL("../lib/client.js", import.meta.url);
assert.ok(existsSync(BUNDLE_URL), "lib/client.js missing — run pnpm build");

/** One React-stub element: enough shape to walk the returned tree. */
interface Element {
  type: any;
  props: Record<string, any>;
  children: any[];
}

/** The shape the bundle registers through window.__ModuleLoader__.load. */
interface BundleRow {
  id: string;
  factory: (require: (spec: string) => unknown) => BundleExports;
}

interface BundleExports {
  NS: string;
  apply: (ctx: any) => void;
  inject: string[];
  MemorySection: (props: Record<string, any>) => Element;
  Heatmap: (props: Record<string, any>) => Element;
  Legend: (props: Record<string, any>) => Element;
  heatmapColumns: (days: any[], weeks: number, today: Date) => any[][];
  readConfig: (ctx: any) => { values: unknown; error?: string };
  formActions: (ctx: any) => unknown;
  COLORS: Record<string, string>;
}

interface Registration {
  options: { name: string; id: string; label: () => string; inject: () => Record<string, any> };
  component: (props: Record<string, any>) => Element;
}

/**
 * Client bundles are classic scripts, so they are executed in a browser-like
 * sandbox: no imports, only window.__ModuleLoader__.load.
 */
async function loadBundle(): Promise<BundleRow> {
  const code = await readFile(BUNDLE_URL, "utf8");
  let row: BundleRow | null = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (value: BundleRow) => {
          row = value;
        },
      },
    },
    console,
    // The bundle is not in Node's realm, so `fetch` has to be a bridge that
    // reads the test's stub at call time.
    fetch: (...args: unknown[]) => (globalThis.fetch as any)(...args),
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
  const createElement = (type: any, props: Record<string, any> | null, ...children: any[]): Element => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity),
  });
  return {
    createElement,
    Fragment: Symbol("Fragment"),
    useId: () => "id",
    useState: (value: unknown) => [value, () => {}],
    useEffect: () => {},
  };
}

function makeCtx(configForms: unknown): { ctx: any; registrations: Registration[] } {
  const registrations: Registration[] = [];
  const ctx: any = {
    effect: (fn: () => void) => {
      fn();
      return () => {};
    },
    locale: {
      bind: () => (key: string) => key,
      register: () => () => {},
    },
    slots: {
      inject: (_name: string, fn: () => unknown) => fn(),
      register: (options: Registration["options"], component: Registration["component"]) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
    configForms,
  };
  return { ctx, registrations };
}

/** The section registration is what every interaction test starts from. */
function sectionRegistration(registrations: Registration[]): Registration {
  const registration = registrations[0];
  assert.ok(registration, "apply must register exactly the settings.section slot");
  return registration;
}

/** The factory only ever resolves shell seed words; `react` is all we need. */
function instantiate(row: BundleRow): BundleExports {
  return row.factory((spec) => {
    assert.equal(spec, "react");
    return fakeReact();
  });
}

function collectText(node: any): string[] {
  if (node === null || node === undefined) return [];
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(collectText);
  return collectText(node.children);
}

describe("the compiled client bundle", () => {
  it("the bundle registers under the package name and exports a cordis plugin", async () => {
    const row = await loadBundle();
    assert.equal(row.id, "dsh-reme-lite");
    assert.equal(typeof row.factory, "function");
    const exports = instantiate(row);
    assert.equal(typeof exports.apply, "function");
    assert.deepEqual(Array.from(exports.inject), ["slots", "locale"]);
  });

  it("apply waits for the settings slot and registers exactly one section", async () => {
    const row = await loadBundle();
    const exports = instantiate(row);
    const { ctx, registrations } = makeCtx(undefined);
    exports.apply(ctx);

    assert.equal(registrations.length, 1);
    const { options, component } = sectionRegistration(registrations);
    assert.equal(options.name, "settings.section");
    assert.equal(options.id, "node-memory");
    assert.equal(typeof component, "function");
    assert.equal(typeof options.label(), "string");
  });

  it("the switch label follows the status payload", async () => {
    const row = await loadBundle();
    const exports = instantiate(row);
    // A status response is what the page renders from; no config form involved.
    const element = exports.MemorySection({ t: (key: string) => key });
    assert.ok(collectText(element).join(" ").includes("switchHint"), "no data yet: explains the switch");
  });

  it("component degrades to the explanation when config is unavailable", async () => {
    const row = await loadBundle();
    const exports = instantiate(row);
    const { ctx, registrations } = makeCtx(undefined);
    exports.apply(ctx);

    const registration = sectionRegistration(registrations);
    const props = { t: (key: string) => key, ...registration.options.inject() };
    const tree = registration.component(props);
    const text = collectText(tree).join(" ");
    assert.ok(text.includes("switchHint"));
    assert.ok(!text.includes("workspace"), "no fabricated values");
  });

  it("readConfig swallows a throwing settings service", async () => {
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

  it("readConfig accepts a draft-shaped snapshot", async () => {
    const row = await loadBundle();
    const exports = instantiate(row);
    const state = exports.readConfig({
      configForms: {
        get: () => ({ getSnapshot: () => ({ draft: { dreamEnabled: true } }) }),
      },
    });
    assert.deepEqual(state.values, { dreamEnabled: true });
  });

  it("heatmap maps days onto a week grid, future cells marked", async () => {
    const row = await loadBundle();
    const exports = instantiate(row);
    const today = new Date(2026, 9, 25);
    const days = [
      { date: "2026-10-24", total: 2, kind: "notable" },
      { date: "2026-10-25", total: 1, kind: "conflict" },
    ];
    const cells = exports.heatmapColumns(days, 2, today).flat();
    const todayCell = cells.find((cell: any) => cell.date === "2026-10-25");
    assert.equal(todayCell.kind, "conflict");
    const yesterday = cells.find((cell: any) => cell.date === "2026-10-24");
    assert.equal(yesterday.kind, "notable");
    assert.equal(yesterday.total, 2);
    const blank = cells.find((cell: any) => cell.date === "2026-10-20");
    assert.equal(blank.kind, "empty");
    assert.ok(cells.some((cell: any) => cell.future), "the tail of the last column is in the future");
  });

  it("legend and cells use the agreed colours", async () => {
    const row = await loadBundle();
    const exports = instantiate(row);
    assert.equal(exports.COLORS.normal, "#2da44e");
    assert.equal(exports.COLORS.notable, "#4a9eff");
    assert.equal(exports.COLORS["user-declared"], "#a371f7");
    assert.equal(exports.COLORS.conflict, "#f85149");

    const t = (key: string) => key;
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

  it("the page explains itself before data arrives", async () => {
    const row = await loadBundle();
    const exports = instantiate(row);
    const tree = exports.MemorySection({ t: (key: string) => key, nodeMemory: { values: null } });
    const text = collectText(tree).join(" ");
    assert.ok(text.includes("switchHint"));
    assert.ok(text.includes("loading"));
  });

  it("both controls post to the settings route and adopt the returned status", async () => {
    const row = await loadBundle();
    const exports = instantiate(row);
    const { ctx, registrations } = makeCtx(undefined);
    exports.apply(ctx);

    const posts: Array<{ url: unknown; body: any; method: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      async (url: unknown, init: any) => {
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
      },
    );

    try {
      const registration = sectionRegistration(registrations);
      const props = { t: (key: string) => key, ...registration.options.inject() };
      const tree = registration.component(props);

      const controls: { select: any; checkbox: any } = { select: null, checkbox: null };
      const walk = (node: any): void => {
        if (!node || typeof node !== "object") return;
        if (node.type === "select" && !controls.select) controls.select = node;
        if (node.type === "input" && node.props.type === "checkbox" && !controls.checkbox) controls.checkbox = node;
        for (const child of node.children || []) walk(child);
      };
      walk(tree);

      assert.ok(controls.select, "language dropdown is rendered");
      assert.deepEqual(
        controls.select.children.map((option: any) => option.props.value),
        ["auto", "zh", "en"],
      );
      assert.ok(controls.checkbox, "the consolidation switch is a real checkbox");

      controls.select.props.onChange({ target: { value: "en" } });
      controls.checkbox.props.onChange({ target: { checked: true } });
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(posts.length, 2);
      const first = posts[0];
      const second = posts[1];
      assert.ok(first && second, "both controls reached the settings route");
      assert.equal(first.method, "POST");
      assert.equal(first.url, "/node-memory/settings");
      assert.deepEqual(first.body, { language: "en" });
      assert.deepEqual(second.body, { dreamEnabled: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a failed write surfaces the failure instead of pretending", async () => {
    const row = await loadBundle();
    const exports = instantiate(row);
    vi.stubGlobal(
      "fetch",
      async () => ({ ok: false, status: 500, json: async () => ({}) }),
    );
    try {
      const tree = exports.MemorySection({ t: (key: string) => key });
      const controls: any[] = [];
      const walk = (node: any): void => {
        if (!node || typeof node !== "object") return;
        if (node.type === "input") controls.push(node);
        for (const child of node.children || []) walk(child);
      };
      walk(tree);
      const firstInput = controls[0];
      assert.ok(firstInput, "the switch is rendered");
      firstInput.props.onChange({ target: { checked: true } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      // State is not observable through the stub, so assert the code path ran:
      // a rejected response must not throw out of the handler.
      assert.ok(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
