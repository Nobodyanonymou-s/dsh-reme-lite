/**
 * Five-field cron, no dependencies, timezone-aware.
 *
 * ReMe's `dreamCron` / `timezone` pair is the contract being reproduced:
 * "0 23 * * *" in `Asia/Shanghai` means 23:00 Beijing time, not 23:00 on
 * whatever machine happens to run the host.
 *
 * Matching follows Vixie cron: when BOTH day-of-month and day-of-week are
 * restricted, a date matches if EITHER matches.
 */

/** @typedef {{ minutes: Set<number>, hours: Set<number>, days: Set<number>, months: Set<number>, weekdays: Set<number>, domRestricted: boolean, dowRestricted: boolean }} CronFields */

/**
 * @param {string} field
 * @param {number} minimum
 * @param {number} maximum
 * @param {{ allowSeven?: boolean }} [options]
 * @returns {{ values: Set<number>, restricted: boolean }}
 */
function parseField(field, minimum, maximum, options = {}) {
  const allowSeven = options.allowSeven ?? false;
  const values = new Set();
  let restricted = false;

  for (const part of field.split(",")) {
    const text = part.trim();
    if (!text) throw new Error(`empty cron field part in "${field}"`);

    const [rangeText, stepText] = text.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid cron step "${text}"`);
    }

    let start;
    let end;
    if (rangeText === "*") {
      start = minimum;
      end = maximum;
    } else if (rangeText.includes("-")) {
      const [a, b] = rangeText.split("-");
      start = Number(a);
      end = Number(b);
      restricted = true;
    } else {
      start = Number(rangeText);
      end = stepText === undefined ? start : maximum;
      restricted = true;
    }

    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error(`invalid cron value "${text}"`);
    }
    if (start < minimum || end > maximum || start > end) {
      throw new Error(`cron value out of range "${text}" (${minimum}-${maximum})`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(allowSeven && value === 7 ? 0 : value);
    }
  }

  return { values, restricted };
}

/**
 * @param {string} expression
 * @returns {CronFields}
 */
export function parseCron(expression) {
  const parts = String(expression ?? "").trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron needs 5 fields, got ${parts.length}: "${expression}"`);
  }
  const minutes = parseField(parts[0], 0, 59);
  const hours = parseField(parts[1], 0, 23);
  const days = parseField(parts[2], 1, 31);
  const months = parseField(parts[3], 1, 12);
  const weekdays = parseField(parts[4], 0, 6, { allowSeven: true });
  return {
    minutes: minutes.values,
    hours: hours.values,
    days: days.values,
    months: months.values,
    weekdays: weekdays.values,
    domRestricted: days.restricted,
    dowRestricted: weekdays.restricted,
  };
}

/**
 * @param {string} expression
 */
export function isValidCron(expression) {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/** @typedef {{ year: number, month: number, day: number, hour: number, minute: number }} Civil */

/**
 * Wall-clock parts of an instant in a timezone.
 * @param {Date} date
 * @param {string} [timeZone]
 * @returns {Civil}
 */
export function toCivil(date, timeZone) {
  if (!timeZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  /** @type {Record<string, string>} */
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Some engines render midnight as "24" even with h23; normalise it.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/**
 * Offset of a timezone at an instant, in minutes east of UTC.
 * @param {number} utcMs
 * @param {string} timeZone
 */
function offsetMinutesAt(utcMs, timeZone) {
  const civil = toCivil(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute);
  return Math.round((asUtc - utcMs) / 60000);
}

/**
 * @param {Civil} civil
 * @param {string} [timeZone]
 * @returns {Date}
 */
export function fromCivil(civil, timeZone) {
  if (!timeZone) {
    return new Date(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute, 0, 0);
  }
  const naive = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute, 0, 0);
  let instant = naive - offsetMinutesAt(naive, timeZone) * 60000;
  // One correction pass handles a DST boundary between the guess and the answer.
  const second = toCivil(new Date(instant), timeZone);
  if (
    second.hour !== civil.hour ||
    second.minute !== civil.minute ||
    second.day !== civil.day
  ) {
    instant = naive - offsetMinutesAt(instant, timeZone) * 60000;
  }
  return new Date(instant);
}

/** @param {Civil} civil */
function nextMinute(civil) {
  const next = { ...civil, minute: civil.minute + 1 };
  if (next.minute < 60) return next;
  next.minute = 0;
  return nextHour(next);
}

/** @param {Civil} civil */
function nextHour(civil) {
  const next = { ...civil, minute: 0, hour: civil.hour + 1 };
  if (next.hour < 24) return next;
  next.hour = 0;
  return nextDay(next);
}

/** @param {Civil} civil */
function nextDay(civil) {
  const next = { ...civil, hour: 0, minute: 0, day: civil.day + 1 };
  const daysInMonth = new Date(Date.UTC(next.year, next.month, 0)).getUTCDate();
  if (next.day <= daysInMonth) return next;
  next.day = 1;
  return nextMonth(next);
}

/** @param {Civil} civil */
function nextMonth(civil) {
  const next = { ...civil, day: 1, hour: 0, minute: 0, month: civil.month + 1 };
  if (next.month <= 12) return next;
  next.month = 1;
  next.year += 1;
  return next;
}

/**
 * @param {CronFields} fields
 * @param {Civil} civil
 */
function dayMatches(fields, civil) {
  const date = new Date(Date.UTC(civil.year, civil.month - 1, civil.day));
  const weekday = date.getUTCDay();
  const dom = fields.days.has(civil.day);
  const dow = fields.weekdays.has(weekday);
  if (fields.domRestricted && fields.dowRestricted) return dom || dow;
  if (fields.domRestricted) return dom;
  if (fields.dowRestricted) return dow;
  return true;
}

/**
 * Next instant strictly after `from` that matches the expression.
 * Returns null if nothing matches within five years (bad expression).
 * @param {string} expression
 * @param {{ from?: Date, timeZone?: string }} [options]
 * @returns {Date | null}
 */
export function nextRun(expression, options = {}) {
  const { from = new Date(), timeZone } = options;
  const fields = parseCron(expression);
  let civil = toCivil(from, timeZone);
  civil = nextMinute(civil);

  for (let guard = 0; guard < 200000; guard += 1) {
    if (!fields.months.has(civil.month)) {
      civil = nextMonth(civil);
      continue;
    }
    if (!dayMatches(fields, civil)) {
      civil = nextDay(civil);
      continue;
    }
    if (!fields.hours.has(civil.hour)) {
      civil = nextHour(civil);
      continue;
    }
    if (!fields.minutes.has(civil.minute)) {
      civil = nextMinute(civil);
      continue;
    }
    const instant = fromCivil(civil, timeZone);
    if (instant.getTime() > from.getTime()) return instant;
    civil = nextMinute(civil);
  }
  return null;
}

/**
 * Human-readable summary for logs and status output.
 * @param {string} expression
 * @param {{ from?: Date, timeZone?: string }} [options]
 */
export function describeNextRun(expression, options = {}) {
  try {
    const next = nextRun(expression, options);
    if (!next) return "no upcoming run";
    const civil = toCivil(next, options.timeZone);
    const pad = (n) => String(n).padStart(2, "0");
    return `${civil.year}-${pad(civil.month)}-${pad(civil.day)} ${pad(civil.hour)}:${pad(civil.minute)}${
      options.timeZone ? ` (${options.timeZone})` : ""
    }`;
  } catch (error) {
    return `invalid schedule: ${error instanceof Error ? error.message : String(error)}`;
  }
}
