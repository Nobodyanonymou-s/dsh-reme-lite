/**
 * Mutable settings, owned by the plugin.
 *
 * Settings live in `<workspace>/metadata/settings.json` — one owner, one file.
 * The mount `config:` block stays the bootstrap default; this file overrides it
 * once the user changes something in the UI. That ordering is deliberate: a
 * patch file is hard to edit by hand, which is exactly why the page exists.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Keys the UI may write. Anything else in the file is ignored. */
export const MUTABLE_KEYS: readonly string[] = ["language", "dreamEnabled", "dreamCron", "dreamTimeZone"];

const LANGUAGES: readonly string[] = ["auto", "zh", "en"];

export interface Settings {
  language?: string;
  dreamEnabled?: boolean;
  dreamCron?: string;
  dreamTimeZone?: string;
}

/** The config shape applySettings can override; keeps the generic return type honest. */
export interface SettingsTarget {
  language?: string;
  dreamEnabled?: boolean;
  dreamCron?: string | null;
  dreamTimeZone?: string | null;
}

export function settingsPath(root: string): string {
  return join(root, "metadata", "settings.json");
}

export async function loadSettings(root: string): Promise<Settings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath(root), "utf8"));
    return normalizeSettings(parsed);
  } catch {
    return {};
  }
}

/**
 * Reject unknown or malformed fields instead of persisting them; a typo in a
 * settings file must not silently disable memory.
 */
export function validateSettings(input: unknown): { settings: Settings; rejected: string[] } {
  const settings: Settings = {};
  const rejected: string[] = [];
  if (!input || typeof input !== "object") return { settings, rejected };

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!MUTABLE_KEYS.includes(key)) {
      rejected.push(key);
      continue;
    }
    if (key === "language") {
      if (typeof value === "string" && LANGUAGES.includes(value)) settings.language = value;
      else rejected.push(key);
      continue;
    }
    if (key === "dreamEnabled") {
      if (typeof value === "boolean") settings.dreamEnabled = value;
      else rejected.push(key);
      continue;
    }
    if (key === "dreamCron") {
      // Shape check only; the cron parser is the authority when it is used.
      if (typeof value === "string" && value.trim().split(/\s+/).length === 5) settings.dreamCron = value.trim();
      else rejected.push(key);
      continue;
    }
    if (key === "dreamTimeZone") {
      if (typeof value === "string") settings.dreamTimeZone = value.trim();
      else rejected.push(key);
    }
  }
  return { settings, rejected };
}

export function normalizeSettings(value: unknown): Settings {
  return validateSettings(value).settings;
}

/**
 * Merge and persist. Writes atomically so a crash cannot leave half a file.
 */
export async function saveSettings(root: string, patch: unknown): Promise<{ settings: Settings; rejected: string[] }> {
  const { settings: incoming, rejected } = validateSettings(patch);
  const current = await loadSettings(root);
  const next = { ...current, ...incoming };
  const target = settingsPath(root);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temporary, target);
  return { settings: next, rejected };
}

/**
 * Settings override the mount config, key by key.
 */
export function applySettings<T extends SettingsTarget>(config: T, settings: Settings): T {
  const next = { ...config };
  if (settings.language) next.language = settings.language === "en" ? "en" : settings.language === "zh" ? "zh" : next.language;
  if (typeof settings.dreamEnabled === "boolean") next.dreamEnabled = settings.dreamEnabled;
  if (settings.dreamCron) next.dreamCron = settings.dreamCron;
  if (settings.dreamTimeZone !== undefined) next.dreamTimeZone = settings.dreamTimeZone || null;
  return next;
}
