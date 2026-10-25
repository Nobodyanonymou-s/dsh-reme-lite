import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applySettings, loadSettings, saveSettings, settingsPath, validateSettings } from "../src/settings.js";

async function workspace() {
  return mkdtemp(join(tmpdir(), "mem-settings-"));
}

test("only known, well-formed fields survive validation", () => {
  const { settings, rejected } = validateSettings({
    language: "en",
    dreamEnabled: true,
    dreamCron: "0 23 * * *",
    dreamTimeZone: "Asia/Shanghai",
    workspace: "/etc",
    dreamEnabledTypo: true,
  });
  assert.deepEqual(settings, {
    language: "en",
    dreamEnabled: true,
    dreamCron: "0 23 * * *",
    dreamTimeZone: "Asia/Shanghai",
  });
  assert.deepEqual(rejected.sort(), ["dreamEnabledTypo", "workspace"], "unknown keys are reported, not stored");
});

test("malformed values are rejected individually", () => {
  const { settings, rejected } = validateSettings({
    language: "fr",
    dreamEnabled: "yes",
    dreamCron: "0 23 * *",
  });
  assert.deepEqual(settings, {});
  assert.deepEqual(rejected.sort(), ["dreamCron", "dreamEnabled", "language"]);
});

test("a missing or corrupt file reads as empty settings", async () => {
  const root = await workspace();
  assert.deepEqual(await loadSettings(root), {});
});

test("save merges over what is already stored and is atomic", async () => {
  const root = await workspace();
  await saveSettings(root, { language: "en" });
  const { settings } = await saveSettings(root, { dreamEnabled: true });
  assert.deepEqual(settings, { language: "en", dreamEnabled: true });

  const raw = JSON.parse(await readFile(settingsPath(root), "utf8"));
  assert.deepEqual(raw, { language: "en", dreamEnabled: true });
  assert.ok(!(await readFile(`${settingsPath(root)}.tmp`, "utf8").catch(() => null)), "no temp file left behind");
});

test("settings override the mount config key by key", () => {
  const base = {
    language: "zh",
    dreamEnabled: false,
    dreamCron: "0 23 * * *",
    dreamTimeZone: "Asia/Shanghai",
    workspace: "C:/mem",
  };
  const merged = applySettings(base, { language: "en", dreamEnabled: true, dreamTimeZone: "" });
  assert.equal(merged.language, "en");
  assert.equal(merged.dreamEnabled, true);
  assert.equal(merged.dreamTimeZone, null, "an empty zone means local time");
  assert.equal(merged.workspace, "C:/mem", "untouched keys survive");
  assert.equal(base.language, "zh", "the input is not mutated");
});

test("auto is a valid stored value, not a resolved language", () => {
  const { settings } = validateSettings({ language: "auto" });
  assert.equal(settings.language, "auto");
  // applySettings keeps the resolved value when the stored one is auto.
  const merged = applySettings({ language: "zh" }, { language: "auto" });
  assert.equal(merged.language, "zh");
});
