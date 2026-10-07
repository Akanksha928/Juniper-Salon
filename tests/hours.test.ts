import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeHours,
  describeSalonTime,
  isTextingTime,
  isWithinHours,
  nextTextingTime,
  salonClock,
  salonTimeToMs,
} from "../src/shared";
import type { TextingHours } from "../src/types";

const TZ = "America/Los_Angeles";
const HOURS: TextingHours = { days: ["Tue", "Wed", "Thu", "Fri", "Sat"], from: "09:00", to: "19:00", timeZone: TZ };
const MIN = 60 * 1000;
// 2026-10-06 is a Tuesday.
const at = (date: string, time: string) => salonTimeToMs(date, time, TZ);
const clock = (ms: number) => {
  const c = salonClock(ms, TZ);
  return `${c.weekday} ${c.date} ${c.time}`;
};

test("salon times convert both ways, across a DST change", () => {
  assert.equal(new Date(at("2026-10-06", "09:00")).toISOString(), "2026-10-06T16:00:00.000Z"); // PDT
  assert.equal(new Date(at("2026-11-03", "09:00")).toISOString(), "2026-11-03T17:00:00.000Z"); // PST
  assert.equal(clock(Date.parse("2026-10-06T16:00:00Z")), "Tue 2026-10-06 09:00");
  assert.equal(salonClock(Date.parse("2026-10-06T16:00:00Z"), "Asia/Kolkata").time, "21:30");
});

test("slots must fall in opening hours", () => {
  assert.ok(isWithinHours("2026-10-06", "09:00", HOURS)); // Tuesday, opening time
  assert.ok(isWithinHours("2026-10-10", "18:45", HOURS)); // Saturday
  assert.ok(!isWithinHours("2026-10-06", "19:00", HOURS)); // closing time
  assert.ok(!isWithinHours("2026-10-06", "08:45", HOURS));
  assert.ok(!isWithinHours("2026-10-11", "12:00", HOURS)); // Sunday
  assert.ok(!isWithinHours("2026-10-12", "12:00", HOURS)); // Monday
});

test("texting is allowed only in opening hours", () => {
  assert.ok(isTextingTime(at("2026-10-06", "12:00"), HOURS));
  assert.ok(!isTextingTime(at("2026-10-06", "19:30"), HOURS));
  assert.ok(!isTextingTime(at("2026-10-11", "12:00"), HOURS));
});

test("the next texting time leaves room for the whole reply window", () => {
  const window = 15 * MIN;
  const next = (date: string, time: string) => clock(nextTextingTime(at(date, time), window, HOURS));
  assert.equal(next("2026-10-06", "12:00"), "Tue 2026-10-06 12:00"); // open now
  assert.equal(next("2026-10-06", "18:45"), "Tue 2026-10-06 18:45"); // window ends exactly at 7 PM
  assert.equal(next("2026-10-06", "18:50"), "Wed 2026-10-07 09:00"); // would end after 7 PM
  assert.equal(next("2026-10-06", "07:30"), "Tue 2026-10-06 09:00"); // before opening
  assert.equal(next("2026-10-10", "20:00"), "Tue 2026-10-13 09:00"); // Saturday night
  assert.equal(next("2026-10-11", "11:00"), "Tue 2026-10-13 09:00"); // Sunday
  assert.equal(next("2026-10-12", "23:59"), "Tue 2026-10-13 09:00"); // Monday night
  // A window longer than an opening day only has to start within hours.
  assert.equal(clock(nextTextingTime(at("2026-10-06", "18:50"), 11 * 60 * MIN, HOURS)), "Tue 2026-10-06 18:50");
});

test("hours and times read naturally", () => {
  assert.equal(describeHours(HOURS), "Tue–Sat, 9:00 AM–7:00 PM");
  assert.equal(describeHours({ days: ["Mon", "Wed"], from: "10:00", to: "16:30" }), "Mon, Wed, 10:00 AM–4:30 PM");
  assert.equal(describeSalonTime(at("2026-10-13", "09:00"), TZ), "Tue 9:00 AM");
});
