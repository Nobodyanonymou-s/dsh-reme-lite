window.__ModuleLoader__.load({
	id: "dsh-reme-lite",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		let react = require("react");
		react = __toESM(react, 1);
		// src/client/index.ts
		/**
		* Browser half. The SOURCE is a regular ES module; tsdown compiles it to the
		* classic script DSH loads via `<script src>` — the only legal entry is
		* `window.__ModuleLoader__.load`, and `require()` inside the compiled factory
		* resolves shell seed words (`react`); nothing else is importable.
		*
		* The page shows the scheduled-consolidation state and a GitHub-style heatmap
		* of memory activity. Data comes from `/node-memory/status.json`, served by the
		* Host half — the browser cannot read the Markdown workspace itself.
		*/
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
			empty: "rgba(127,127,127,0.12)"
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
				briefOn: "会话简报：开",
				briefOff: "会话简报：关",
				briefHint: "会话简报：读到状态前开关不可用（默认关）。",
				briefBudgetUnit: "字符",
				kbHead: "知识库：{n} 节点",
				kbChars: "{c} 字符",
				kbDangling: "断链 {n}",
				kbOrphans: "孤儿 {n}",
				kbNearDuplicates: "疑似重复 {n}"
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
				briefOn: "Session brief: on",
				briefOff: "Session brief: off",
				briefHint: "Session brief: the switch is unavailable until status loads (off by default).",
				briefBudgetUnit: "chars",
				kbHead: "Knowledge base: {n} nodes",
				kbChars: "{c} chars",
				kbDangling: "{n} dangling",
				kbOrphans: "{n} orphans",
				kbNearDuplicates: "{n} near-duplicates"
			}
		};
		/** Brief budget bounds; the Host clamps the same range server-side. */
		const BRIEF_BUDGET_MIN = 200;
		const BRIEF_BUDGET_MAX = 4e3;
		const BRIEF_BUDGET_DEFAULT = 900;
		/** Whole characters within [min, max]; anything unreadable falls back. Pure, so tests pin it. */
		function clampBudget(value, fallback) {
			const parsed = Math.round(Number(value));
			if (!Number.isFinite(parsed)) return fallback;
			return Math.min(BRIEF_BUDGET_MAX, Math.max(200, parsed));
		}
		const style = {
			root: {
				display: "flex",
				flexDirection: "column",
				gap: "14px",
				padding: "4px 0"
			},
			row: {
				display: "flex",
				gap: "12px",
				alignItems: "center",
				fontSize: "13px"
			},
			hint: {
				fontSize: "12px",
				lineHeight: "1.6",
				opacity: .7,
				margin: 0
			},
			grid: {
				display: "flex",
				gap: "3px",
				alignItems: "flex-start",
				overflowX: "auto"
			},
			column: {
				display: "flex",
				flexDirection: "column",
				gap: "3px"
			},
			cell: {
				width: "11px",
				height: "11px",
				borderRadius: "2px"
			},
			legend: {
				display: "flex",
				gap: "10px",
				flexWrap: "wrap",
				fontSize: "12px",
				opacity: .8
			},
			swatch: {
				width: "10px",
				height: "10px",
				borderRadius: "2px",
				display: "inline-block",
				marginRight: "5px"
			},
			key: { opacity: .65 },
			select: {
				fontSize: "12px",
				padding: "2px 6px",
				borderRadius: "4px",
				background: "transparent",
				color: "inherit",
				border: "1px solid rgba(127,127,127,0.35)"
			},
			number: {
				fontSize: "12px",
				padding: "2px 6px",
				width: "72px",
				borderRadius: "4px",
				background: "transparent",
				color: "inherit",
				border: "1px solid rgba(127,127,127,0.35)"
			}
		};
		function dayKey(date) {
			return String(date).slice(0, 10);
		}
		/**
		* Lay the day list out as GitHub does: columns are weeks, rows are
		* weekdays (Sunday first). Pure, so it is testable without a DOM.
		*/
		function heatmapColumns(days, weeks, today) {
			const byDate = /* @__PURE__ */ new Map();
			for (const day of days || []) byDate.set(dayKey(day.date), day);
			const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
			const start = new Date(end);
			start.setDate(start.getDate() - (weeks * 7 - 1) - end.getDay());
			const columns = [];
			const cursor = new Date(start);
			for (let week = 0; week <= weeks; week += 1) {
				const column = [];
				for (let weekday = 0; weekday < 7; weekday += 1) {
					const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
					const entry = byDate.get(key);
					column.push({
						date: key,
						kind: entry ? entry.kind : "empty",
						total: entry ? entry.total : 0,
						future: cursor > end
					});
					cursor.setDate(cursor.getDate() + 1);
				}
				columns.push(column);
			}
			return columns;
		}
		/**
		* DICT templates own the word order, so a number is spliced in by placeholder
		* instead of concatenated by the caller.
		*/
		function fill(template, values) {
			return template.replace(/\{(\w+)\}/g, (placeholder) => {
				const value = values[placeholder.slice(1, -1)];
				return value === void 0 ? placeholder : value;
			});
		}
		/** Body size for the health line: 128400 reads as "128k", 940 stays itself. */
		function charsText(chars) {
			return chars >= 1e3 ? `${Math.round(chars / 1e3)}k` : String(chars);
		}
		/**
		* One line of knowledge-base health, e.g.
		* `知识库：34 节点 / 128k 字符 · 断链 3 · 孤儿 5 · 疑似重复 2 · 上次整理 11-08`.
		* Pure, so it is testable against the built bundle. An old Host that serves no
		* `digest` segment (or one without `nodes`) yields null and the line is simply
		* not rendered; a metric the Host could not compute is skipped rather than
		* shown as zero — absent and zero mean different things.
		*/
		function healthLine(digest, t) {
			if (!digest || typeof digest !== "object") return null;
			const segment = digest;
			const count = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
			const nodes = count(segment.nodes);
			if (nodes === null) return null;
			let head = fill(t("kbHead"), { n: String(nodes) });
			const chars = count(segment.chars);
			if (chars !== null) head += ` / ${fill(t("kbChars"), { c: charsText(chars) })}`;
			const parts = [head];
			const metric = (value, key) => {
				const n = count(value);
				if (n !== null) parts.push(fill(t(key), { n: String(n) }));
			};
			metric(segment.danglingLinks, "kbDangling");
			metric(segment.orphanNodes, "kbOrphans");
			metric(segment.nearDuplicates, "kbNearDuplicates");
			const lastDreamAt = typeof segment.lastDreamAt === "string" && segment.lastDreamAt ? String(segment.lastDreamAt).slice(5, 10) : null;
			if (lastDreamAt) parts.push(`${t("lastRun")} ${lastDreamAt}`);
			return parts.join(" · ");
		}
		function Heatmap(props) {
			const t = props.t;
			return react.default.createElement("div", { style: style.grid }, props.columns.map((column, weekIndex) => react.default.createElement("div", {
				key: `w${weekIndex}`,
				style: style.column
			}, column.map((cell) => react.default.createElement("div", {
				key: cell.date,
				title: `${cell.date} · ${cell.total} ${t("nodes")} · ${t(cell.kind)}`,
				style: {
					...style.cell,
					background: cell.future ? "transparent" : COLORS[cell.kind],
					opacity: cell.future ? 0 : cell.kind === "empty" ? .55 : 1
				}
			})))));
		}
		function Legend(props) {
			const t = props.t;
			return react.default.createElement("div", { style: style.legend }, [
				"normal",
				"notable",
				"user-declared",
				"conflict",
				"empty"
			].map((kind) => react.default.createElement("span", { key: kind }, react.default.createElement("span", { style: {
				...style.swatch,
				background: COLORS[kind]
			} }), t(kind))));
		}
		function MemorySection(props) {
			const t = props.t;
			const stateHook = typeof react.default.useState === "function" ? react.default.useState(null) : [null, () => {}];
			const status = stateHook[0];
			const setStatus = stateHook[1];
			const failHook = typeof react.default.useState === "function" ? react.default.useState(false) : [false, () => {}];
			const failed = failHook[0];
			const setFailed = failHook[1];
			const busyHook = typeof react.default.useState === "function" ? react.default.useState(false) : [false, () => {}];
			const busy = busyHook[0];
			const setBusy = busyHook[1];
			const load = () => {
				fetch(STATUS_URL, { cache: "no-store" }).then((response) => response.ok ? response.json() : Promise.reject(new Error(String(response.status)))).then((data) => {
					setStatus(data);
					setFailed(false);
				}).catch(() => setFailed(true));
			};
			if (typeof react.default.useEffect === "function") react.default.useEffect(() => {
				load();
			}, []);
			const update = (patch) => {
				setBusy(true);
				fetch(SETTINGS_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(patch)
				}).then((response) => response.ok ? response.json() : Promise.reject(new Error(String(response.status)))).then((data) => {
					if (data && data.status) setStatus(data.status);
					else load();
					setFailed(false);
				}).catch(() => setFailed(true)).finally(() => setBusy(false));
			};
			const settings = status && status.settings || null;
			const task = status && status.task ? status.task : null;
			const language = settings && settings.language || "auto";
			const enabled = settings && typeof settings.dreamEnabled === "boolean" ? settings.dreamEnabled : null;
			const briefEnabled = settings && typeof settings.briefEnabled === "boolean" ? settings.briefEnabled : null;
			const briefBudget = settings && Number.isFinite(Number(settings.briefBudget)) ? Number(settings.briefBudget) : null;
			const children = [];
			children.push(react.default.createElement("div", {
				key: "lang",
				style: style.row
			}, react.default.createElement("span", { style: style.key }, t("language")), react.default.createElement("select", {
				value: language,
				disabled: busy || !settings,
				style: style.select,
				onChange: (event) => update({ language: event.target.value })
			}, react.default.createElement("option", {
				key: "auto",
				value: "auto"
			}, t("langAuto")), react.default.createElement("option", {
				key: "zh",
				value: "zh"
			}, "中文"), react.default.createElement("option", {
				key: "en",
				value: "en"
			}, "English")), react.default.createElement("span", { style: style.hint }, t("languageNote"))));
			children.push(react.default.createElement("label", {
				key: "dream",
				style: {
					...style.row,
					cursor: "pointer"
				}
			}, react.default.createElement("input", {
				type: "checkbox",
				checked: enabled === true,
				disabled: busy || enabled === null,
				onChange: (event) => update({ dreamEnabled: event.target.checked })
			}), react.default.createElement("span", null, enabled === null ? t("switchHint") : enabled ? t("switchOn") : t("switchOff"))));
			children.push(react.default.createElement("label", {
				key: "brief",
				style: {
					...style.row,
					cursor: "pointer"
				}
			}, react.default.createElement("input", {
				type: "checkbox",
				checked: briefEnabled === true,
				disabled: busy || briefEnabled === null,
				onChange: (event) => update({ briefEnabled: event.target.checked })
			}), react.default.createElement("span", null, briefEnabled === null ? t("briefHint") : briefEnabled ? t("briefOn") : t("briefOff")), react.default.createElement("input", {
				type: "number",
				min: 200,
				max: BRIEF_BUDGET_MAX,
				step: 1,
				value: briefBudget === null ? "" : briefBudget,
				disabled: busy || briefBudget === null,
				style: style.number,
				onChange: (event) => update({ briefBudget: clampBudget(event.target.value, briefBudget ?? BRIEF_BUDGET_DEFAULT) })
			}), react.default.createElement("span", { style: style.key }, t("briefBudgetUnit"))));
			if (failed) children.push(react.default.createElement("p", {
				key: "fail",
				style: style.hint
			}, t("failed")));
			else if (!status) children.push(react.default.createElement("p", {
				key: "loading",
				style: style.hint
			}, t("loading")));
			else {
				children.push(react.default.createElement("div", {
					key: "summary",
					style: style.row
				}, react.default.createElement("span", null, `${status.total} ${t("entries")}`), react.default.createElement("span", null, `${status.days.length} ${t("days")}`), task ? react.default.createElement("span", null, `${t("lastRun")}: ${task.lastRunAt ? String(task.lastRunAt).slice(0, 10) : t("never")}`) : null), react.default.createElement("p", {
					key: "ws",
					style: style.hint
				}, `${t("workspace")}: ${status.workspace}`));
				const health = healthLine(status.digest, t);
				if (health) children.push(react.default.createElement("p", {
					key: "health",
					style: style.hint
				}, health));
				children.push(react.default.createElement(Heatmap, {
					key: "heat",
					columns: heatmapColumns(status.days, WEEKS, /* @__PURE__ */ new Date()),
					t
				}));
				children.push(react.default.createElement(Legend, {
					key: "legend",
					t
				}));
			}
			return react.default.createElement("div", { style: style.root }, children);
		}
		/**
		* Read the Host config through the settings form service when available.
		*/
		function readConfig(ctx) {
			try {
				const forms = ctx.configForms;
				if (!forms || typeof forms.get !== "function") return { values: null };
				const form = forms.get(NS);
				if (!form || typeof form.getSnapshot !== "function") return { values: null };
				const snapshot = form.getSnapshot();
				return { values: snapshot && (snapshot.values || snapshot.value || snapshot.draft) || null };
			} catch (error) {
				const failure = error;
				return {
					values: null,
					error: failure && failure.message ? failure.message : String(error)
				};
			}
		}
		/**
		* The settings form exposes edit/save; without them the dropdown stays
		* read-only rather than pretending to write a setting it cannot.
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
					save: typeof actions.save === "function" ? actions.save : null
				};
			} catch {
				return null;
			}
		}
		const inject = ["slots", "locale"];
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, DICT), `${NS}:dict`);
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: NS,
				order: 60,
				label: () => t("title"),
				locale: NS,
				inject: () => ({})
			}, MemorySection)), `${NS}:page`);
		}
		exports.BRIEF_BUDGET_MAX = BRIEF_BUDGET_MAX;
		exports.BRIEF_BUDGET_MIN = BRIEF_BUDGET_MIN;
		exports.COLORS = COLORS;
		exports.Heatmap = Heatmap;
		exports.Legend = Legend;
		exports.MemorySection = MemorySection;
		exports.NS = NS;
		exports.apply = apply;
		exports.clampBudget = clampBudget;
		exports.formActions = formActions;
		exports.healthLine = healthLine;
		exports.heatmapColumns = heatmapColumns;
		exports.inject = inject;
		exports.readConfig = readConfig;
		return module.exports;
	}
});
