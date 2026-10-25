import assert from "node:assert/strict";
import test from "node:test";

import {
  describeNextRun,
  fromCivil,
  isValidCron,
  nextRun,
  parseCron,
  toCivil,
} from "../src/schedule.js";

/** @param {Date} date */
const iso = (date) => (date ? date.toISOString() : null);

test("rejects malformed expressions", () => {
  assert.equal(isValidCron("0 23 * *"), false);
  assert.equal(isValidCron("60 23 * * *"), false);
  assert.equal(isValidCron("*/0 * * * *"), false);
  assert.equal(isValidCron("0 23 * * *"), true);
  assert.throws(() => parseCron("0 24 * * *"), /out of range/);
});

test("plain daily cron in UTC", () => {
  const from = new Date("2026-10-25T10:00:00Z");
  const next = nextRun("0 23 * * *", { from, timeZone: "UTC" });
  assert.equal(iso(next), "2026-10-25T23:00:00.000Z");
});

test("daily cron honours the timezone, not the host clock", () => {
  const from = new Date("2026-10-25T10:00:00Z"); // 18:00 in Shanghai
  const next = nextRun("0 23 * * *", { from, timeZone: "Asia/Shanghai" });
  // 23:00 Shanghai == 15:00Z
  assert.equal(iso(next), "2026-10-25T15:00:00.000Z");
});

test("rolls to the next day when today's slot has passed", () => {
  const from = new Date("2026-10-25T15:30:00Z"); // 23:30 Shanghai
  const next = nextRun("0 23 * * *", { from, timeZone: "Asia/Shanghai" });
  assert.equal(iso(next), "2026-10-26T15:00:00.000Z");
});

test("step syntax lands on the next boundary", () => {
  const from = new Date("2026-10-25T10:07:00Z");
  const next = nextRun("*/15 * * * *", { from, timeZone: "UTC" });
  assert.equal(iso(next), "2026-10-25T10:15:00.000Z");
});

test("weekday restriction picks Monday", () => {
  const from = new Date("2026-10-25T00:00:00Z"); // Sunday 08:00 Shanghai
  const next = nextRun("0 9 * * 1", { from, timeZone: "Asia/Shanghai" });
  assert.equal(iso(next), "2026-10-26T01:00:00.000Z"); // Mon 09:00 CST
});

test("dom and dow both restricted means OR (Vixie semantics)", () => {
  const from = new Date("2026-10-25T00:00:00Z"); // Sunday
  const next = nextRun("0 0 1 * 1", { from, timeZone: "Asia/Shanghai" });
  // Monday 00:00 CST comes before the 1st of November.
  assert.equal(iso(next), "2026-10-25T16:00:00.000Z");
});

test("civil conversion round-trips through the timezone", () => {
  const date = new Date("2026-10-25T15:00:00Z");
  const civil = toCivil(date, "Asia/Shanghai");
  assert.deepEqual(civil, { year: 2026, month: 10, day: 25, hour: 23, minute: 0 });
  assert.equal(iso(fromCivil(civil, "Asia/Shanghai")), "2026-10-25T15:00:00.000Z");
});

test("describeNextRun renders a readable timestamp", () => {
  const text = describeNextRun("0 23 * * *", {
    from: new Date("2026-10-25T10:00:00Z"),
    timeZone: "Asia/Shanghai",
  });
  assert.equal(text, "2026-10-25 23:00 (Asia/Shanghai)");
  assert.match(describeNextRun("nonsense", {}), /invalid schedule/);
});
