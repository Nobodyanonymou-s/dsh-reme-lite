/**
 * Browser half. CLASSIC SCRIPT, not an ES module: DSH loads client bundles via
 * <script src>, and the only legal entry is `window.__ModuleLoader__.load`.
 * `require()` resolves shell seed words (`react`); nothing else is importable.
 *
 * The page shows the scheduled-consolidation state and a GitHub-style heatmap
 * of memory activity. Data comes from `/node-memory/status.json`, served by the
 * Host half — the browser cannot read the Markdown workspace itself.
 */
window.__ModuleLoader__.load({
  id: "dsh-reme-lite",
  factory: (require) => {
    const React = require("react");
    const module = { exports: {} };
    const NS = "node-memory";
    const STATUS_URL = "/node-memory/status.json";
    const SETTINGS_URL = "/node-memory/settings";
    const WEEKS = 26;

    /** Heatmap colours, one per memory kind. */
    const COLORS = {
      normal: "#2da44e",
      notable: "#4a9eff",
      "user-declared": "#a371f7",
      conflict: "#f85149",
      empty: "rgba(127,127,127,0.12)",
    };

    const DICT = {
      zh: {
        title: "记忆",
        switchOn: "定时整理：开",
        switchOff: "定时整理：关",
        switchHint: "开关在「插件」页的配置卡里（dreamEnabled）。关闭只暂停，不删除历史。",
        normal: "普通",
        notable: "值得记",
        "user-declared": "你明确说的",
        conflict: "冲突",
        empty: "无记录",
        loading: "读取记忆统计…",
        failed: "读不到统计（宿主未提供 /node-memory/status.json）。",
        days: "天有记录",
        nodes: "条记忆",
        entries: "条记忆",
        workspace: "工作区",
        language: "工作语言",
        langAuto: "跟随系统",
        languageNote: "新会话生效",
        langReadOnly: "语言在「插件」页的配置卡里修改（此处只读）。",
        lastRun: "上次整理",
        never: "从未",
      },
      en: {
        title: "Memory",
        switchOn: "Consolidation: on",
        switchOff: "Consolidation: off",
        switchHint: "The switch lives in the Plugins page config card (dreamEnabled). Off only pauses; history is kept.",
        normal: "normal",
        notable: "notable",
        "user-declared": "you said so",
        conflict: "conflict",
        empty: "no record",
        loading: "Reading memory statistics…",
        failed: "Statistics unavailable (host did not serve /node-memory/status.json).",
        days: "days recorded",
        nodes: "entries",
        entries: "entries",
        workspace: "workspace",
        language: "Working language",
        langAuto: "Follow system",
        languageNote: "takes effect in a new session",
        langReadOnly: "Change the language in the Plugins config card (read-only here).",
        lastRun: "last consolidation",
        never: "never",
      },
    };

    const style = {
      root: { display: "flex", flexDirection: "column", gap: "14px", padding: "4px 0" },
      row: { display: "flex", gap: "12px", alignItems: "center", fontSize: "13px" },
      hint: { fontSize: "12px", lineHeight: "1.6", opacity: 0.7, margin: 0 },
      grid: { display: "flex", gap: "3px", alignItems: "flex-start", overflowX: "auto" },
      column: { display: "flex", flexDirection: "column", gap: "3px" },
      cell: { width: "11px", height: "11px", borderRadius: "2px" },
      legend: { display: "flex", gap: "10px", flexWrap: "wrap", fontSize: "12px", opacity: 0.8 },
      swatch: { width: "10px", height: "10px", borderRadius: "2px", display: "inline-block", marginRight: "5px" },
      key: { opacity: 0.65 },
      select: { fontSize: "12px", padding: "2px 6px", borderRadius: "4px", background: "transparent", color: "inherit", border: "1px solid rgba(127,127,127,0.35)" },
    };

    /** @param {string} date */
    function dayKey(date) {
      return String(date).slice(0, 10);
    }

    /**
     * Lay the day list out as GitHub does: columns are weeks, rows are
     * weekdays (Sunday first). Pure, so it is testable without a DOM.
     * @param {{ date: string, total: number, kind: string }[]} days
     * @param {number} weeks
     * @param {Date} today
     */
    function heatmapColumns(days, weeks, today) {
      /** @type {Map<string, any>} */
      const byDate = new Map();
      for (const day of days || []) byDate.set(dayKey(day.date), day);

      const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const start = new Date(end);
      start.setDate(start.getDate() - (weeks * 7 - 1) - end.getDay());

      /** @type {any[][]} */
      const columns = [];
      const cursor = new Date(start);
      for (let week = 0; week <= weeks; week += 1) {
        /** @type {any[]} */
        const column = [];
        for (let weekday = 0; weekday < 7; weekday += 1) {
          const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(
            cursor.getDate(),
          ).padStart(2, "0")}`;
          const entry = byDate.get(key);
          column.push({
            date: key,
            kind: entry ? entry.kind : "empty",
            total: entry ? entry.total : 0,
            future: cursor > end,
          });
          cursor.setDate(cursor.getDate() + 1);
        }
        columns.push(column);
      }
      return columns;
    }

    /** @param {{ columns: any[][], t: (k: string) => string }} props */
    function Heatmap(props) {
      const t = props.t;
      return React.createElement(
        "div",
        { style: style.grid },
        props.columns.map((column, weekIndex) =>
          React.createElement(
            "div",
            { key: `w${weekIndex}`, style: style.column },
            column.map((cell) =>
              React.createElement("div", {
                key: cell.date,
                title: `${cell.date} · ${cell.total} ${t("nodes")} · ${t(cell.kind)}`,
                style: {
                  ...style.cell,
                  background: cell.future ? "transparent" : COLORS[cell.kind],
                  opacity: cell.future ? 0 : cell.kind === "empty" ? 0.55 : 1,
                },
              }),
            ),
          ),
        ),
      );
    }

    /** @param {{ t: (k: string) => string }} props */
    function Legend(props) {
      const t = props.t;
      const order = ["normal", "notable", "user-declared", "conflict", "empty"];
      return React.createElement(
        "div",
        { style: style.legend },
        order.map((kind) =>
          React.createElement(
            "span",
            { key: kind },
            React.createElement("span", { style: { ...style.swatch, background: COLORS[kind] } }),
            t(kind),
          ),
        ),
      );
    }

    /** @param {any} props */
    function MemorySection(props) {
      const t = props.t;
      const stateHook = React.useState ? React.useState(null) : [null, () => {}];
      const status = stateHook[0];
      const setStatus = stateHook[1];
      const failHook = React.useState ? React.useState(false) : [false, () => {}];
      const failed = failHook[0];
      const setFailed = failHook[1];
      const busyHook = React.useState ? React.useState(false) : [false, () => {}];
      const busy = busyHook[0];
      const setBusy = busyHook[1];

      const load = () => {
        fetch(STATUS_URL, { cache: "no-store" })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
          .then((data) => {
            setStatus(data);
            setFailed(false);
          })
          .catch(() => setFailed(true));
      };

      if (React.useEffect) {
        React.useEffect(() => {
          load();
        }, []);
      }

      // One write path for every control: the Host persists the change, then
      // answers with the fresh status so the page never guesses what happened.
      const update = (patch) => {
        setBusy(true);
        fetch(SETTINGS_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
          .then((data) => {
            if (data && data.status) setStatus(data.status);
            else load();
            setFailed(false);
          })
          .catch(() => setFailed(true))
          .finally(() => setBusy(false));
      };

      const settings = (status && status.settings) || null;
      const task = status && status.task ? status.task : null;
      const language = (settings && settings.language) || "auto";
      const enabled = settings && typeof settings.dreamEnabled === "boolean" ? settings.dreamEnabled : null;
      const children = [];

      children.push(
        React.createElement(
          "div",
          { key: "lang", style: style.row },
          React.createElement("span", { style: style.key }, t("language")),
          React.createElement(
            "select",
            {
              value: language,
              disabled: busy || !settings,
              style: style.select,
              onChange: (event) => update({ language: event.target.value }),
            },
            React.createElement("option", { key: "auto", value: "auto" }, t("langAuto")),
            React.createElement("option", { key: "zh", value: "zh" }, "中文"),
            React.createElement("option", { key: "en", value: "en" }, "English"),
          ),
          React.createElement("span", { style: style.hint }, t("languageNote")),
        ),
      );

      children.push(
        React.createElement(
          "label",
          { key: "dream", style: { ...style.row, cursor: "pointer" } },
          React.createElement("input", {
            type: "checkbox",
            checked: enabled === true,
            disabled: busy || enabled === null,
            onChange: (event) => update({ dreamEnabled: event.target.checked }),
          }),
          React.createElement("span", null, enabled === null ? t("switchHint") : enabled ? t("switchOn") : t("switchOff")),
        ),
      );

      if (failed) {
        children.push(React.createElement("p", { key: "fail", style: style.hint }, t("failed")));
      } else if (!status) {
        children.push(React.createElement("p", { key: "loading", style: style.hint }, t("loading")));
      } else {
        children.push(
          React.createElement(
            "div",
            { key: "summary", style: style.row },
            React.createElement("span", null, `${status.total} ${t("entries")}`),
            React.createElement("span", null, `${status.days.length} ${t("days")}`),
            task
              ? React.createElement(
                  "span",
                  null,
                  `${t("lastRun")}: ${task.lastRunAt ? String(task.lastRunAt).slice(0, 10) : t("never")}`,
                )
              : null,
          ),
          React.createElement(
            "p",
            { key: "ws", style: style.hint },
            `${t("workspace")}: ${status.workspace}`,
          ),
        );
        children.push(
          React.createElement(Heatmap, { key: "heat", columns: heatmapColumns(status.days, WEEKS, new Date()), t }),
        );
        children.push(React.createElement(Legend, { key: "legend", t }));
      }

      return React.createElement("div", { style: style.root }, children);
    }

    /**
     * Read the Host config through the settings form service when available.
     * @param {any} ctx
     */
    function readConfig(ctx) {
      try {
        const forms = ctx.configForms;
        if (!forms || typeof forms.get !== "function") return { values: null };
        const form = forms.get(NS);
        if (!form || typeof form.getSnapshot !== "function") return { values: null };
        const snapshot = form.getSnapshot();
        const values = (snapshot && (snapshot.values || snapshot.value || snapshot.draft)) || null;
        return { values };
      } catch (error) {
        return { values: null, error: error && error.message ? error.message : String(error) };
      }
    }

    /**
     * The settings form exposes edit/save; without them the dropdown stays
     * read-only rather than pretending to write a setting it cannot.
     * @param {any} ctx
     */
    function formActions(ctx) {
      try {
        const forms = ctx.configForms;
        if (!forms || typeof forms.get !== "function") return null;
        const form = forms.get(NS);
        if (!form) return null;
        const actions = typeof form.actions === "function" ? form.actions() : form;
        if (!actions) return null;
        return {
          edit: typeof actions.edit === "function" ? actions.edit : null,
          save: typeof actions.save === "function" ? actions.save : null,
        };
      } catch {
        return null;
      }
    }

    const inject = ["slots", "locale"];

    /** @param {any} ctx */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, DICT), `${NS}:dict`);
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              {
                name: "settings.section",
                id: NS,
                order: 60,
                label: () => t("title"),
                locale: NS,
                inject: () => ({}),
              },
              MemorySection,
            ),
          ),
        `${NS}:page`,
      );
    }

    module.exports.NS = NS;
    module.exports.apply = apply;
    module.exports.inject = inject;
    module.exports.MemorySection = MemorySection;
    module.exports.Heatmap = Heatmap;
    module.exports.Legend = Legend;
    module.exports.heatmapColumns = heatmapColumns;
    module.exports.readConfig = readConfig;
    module.exports.formActions = formActions;
    module.exports.COLORS = COLORS;
    return module.exports;
  },
});
