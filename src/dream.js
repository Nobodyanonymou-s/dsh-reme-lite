/**
 * Consolidation ("dream") material.
 *
 * ReMe's `auto_dream` hands a model a batch of daily notes and asks it to
 * create / refine / correct digest nodes. We cannot assume a model is
 * reachable from inside a plugin, so the material is built here and given to
 * whoever will do the writing: an agent we spawned, the current session's
 * agent, or the user via the `memory_dream` tool. One builder, three callers.
 */

/**
 * @param {{ store: import("./store.js").MemoryStore, pendingTurns?: number, days?: number, language?: "zh" | "en" }} input
 * @returns {Promise<string>}
 */
export async function buildDreamMaterial(input) {
  const days = input.days ?? 7;
  const recent = await input.store.recentDaily(days);
  const digest = input.store.digestTitles();
  const pending = input.pendingTurns ?? 0;

  return [
    "# Consolidation material",
    "",
    `Workspace: ${input.store.root}`,
    `Indexed: ${input.store.files.length} files / ${input.store.index.size} chunks`,
    `Unflushed turns in memory: ${pending}`,
    "",
    "## Recent daily pages",
    recent.length ? recent.map((path) => `- ${path}`).join("\n") : "- (none)",
    "",
    "## Existing digest nodes",
    digest.length ? digest.map((path) => `- ${path}`).join("\n") : "- (none)",
    "",
    "## Rules",
    DREAM_RULES,
    "",
    kindRules(input.language),
  ].join("\n");
}

export const DREAM_RULES = [
  "1. Read only the recent daily pages you need; do not load the whole workspace.",
  "2. Extract what will still matter next month: preferences, decisions,",
  "   procedures, entities. Drop one-off chatter.",
  "3. Create or merge digest nodes with memory_write: digest/personal,",
  "   digest/procedure, digest/wiki. One topic per node.",
  "4. Every digest node cites its sources with [[daily/YYYY-MM-DD]] links.",
  "5. If a new fact contradicts an existing digest node, correct that node",
  "   instead of adding a second, conflicting one.",
  "6. Prefer few good nodes over many thin ones. Deleting nothing is fine:",
  "   adding one correct node beats rewriting five.",
].join("\n");

/**
 * How a node earns its colour. Written for a model that reads it once, so it is
 * an ordered decision list with concrete trigger phrases, not a taxonomy.
 * Order == severity: the first match wins. Both languages carry the same rules;
 * the trigger phrases are language-specific on purpose.
 * @typedef {"zh" | "en"} Language
 */

/** @type {Record<Language, string>} */
const KIND_RULES_TEXT = {
  zh: [
    "## 标注规则（决定热力图颜色）",
    "",
    "按顺序判一次，命中即停。拿不准就绿。宁可漏标，不可滥标。",
    "",
    "1. **红 conflict** — 新材料与已有节点矛盾（同一事实两个值：日期、端口、人名、偏好；",
    "   或旧结论已被推翻）。修正旧节点并标红，不要新建第二个。红的作用是让人看见，",
    "   不是让人难堪：正文写清「原来是什么、现在是什么、因为什么」。",
    "2. **紫 user-declared** — 用户**本人**用强调、决定或纠正的方式表达过：",
    "   「记住」「这个重要」「一定要」「以后都这样」「我决定」「就按这个来」「不是…是…」。",
    "   只认用户原话或其直接改写；不要把自己的推断、也不要替用户升级成紫。",
    "3. **蓝 notable** — 你判断半年后还想知道的：决策与理由、踩过的坑、可复用的步骤、",
    "   稳定的偏好与边界、人与组织的关系。一次性状态、临时情绪、随手能查到的公共常识都不算。",
    "   蓝靠校准：用户把蓝当噪音（「这也记？」）就提高门槛；用户抱怨漏记再放宽。",
    "4. **绿 normal** — 其余全部。默认值，不写 kind。",
    "",
    "标了非绿时，在正文末尾加一行理由，让颜色可追溯：",
    "`> 标紫：用户 10-25 原话「以后都按周五发版」`",
    "`> 标红：原记 23:00，今日改口 22:30`",
  ].join("\n"),
  en: [
    "## Labelling rules (they decide the heatmap colour)",
    "",
    "Decide once, in order; the first match wins. When unsure, use green. Missing a colour is cheaper than inventing one.",
    "",
    "1. **red conflict** — the new material contradicts an existing node (one fact, two values:",
    "   a date, a port, a person, a preference; or an old conclusion has been overturned).",
    "   Correct the old node and mark it red; do not add a second node. Red exists to be seen,",
    "   not to assign blame — the body says what it used to be, what it is now, and why.",
    "2. **purple user-declared** — the user **themselves** stressed it, decided it, or corrected it:",
    '   "remember this", "this matters", "always", "from now on", "I decided", "let\'s do it this way",',
    '   "it\'s not X, it\'s Y". Only their own words or a direct paraphrase. Never promote your own',
    "   inference to purple, and never decide on the user's behalf what matters.",
    "3. **blue notable** — you judge it worth knowing in six months: decisions and their reasons,",
    "   traps you fell into, reusable procedures, stable preferences and boundaries, people and how",
    "   they relate. One-off states, passing moods, and public facts you could look up do not count.",
    "   Blue is calibrated, not defined: if the user treats blue as noise (\"why is this saved?\"),",
    "   raise the bar; if they complain about missing memories, lower it.",
    "4. **green normal** — everything else. The default; do not write `kind`.",
    "",
    "For any non-green node, end the body with one line of justification so the colour stays auditable:",
    '`> purple: user said on 10-25, "we ship on Fridays from now on"`',
    "`> red: was 23:00, changed to 22:30 today`",
  ].join("\n"),
};

/**
 * @param {Language} [language]
 */
export function kindRules(language = "zh") {
  return KIND_RULES_TEXT[language === "en" ? "en" : "zh"];
}

/** @deprecated kept for imports that predate the language split. */
export const KIND_RULES = KIND_RULES_TEXT.zh;

/**
 * The prompt used when a background agent performs the consolidation itself.
 * Kept here so the tool output and the scheduled task agree on the rules.
 * @param {string} material
 */
export function dreamPrompt(material) {
  return [
    "You are consolidating long-term memory. Work in the files, then report.",
    "",
    material,
    "",
    "When you are done, reply with a short list of files you created or changed.",
    "Do not ask questions; make the smallest useful set of edits.",
  ].join("\n");
}
