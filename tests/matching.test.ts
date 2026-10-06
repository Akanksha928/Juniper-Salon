import assert from "node:assert/strict";
import { test } from "node:test";
import { findMatchingClients } from "../src/activities";
import { matchClients, weekdayOf } from "../src/matching";
import type { Slot, WaitlistEntry } from "../src/types";

// 2026-10-05 is a Monday.
const MONDAY_2PM = { stylist: "Maya", service: "Cut & style", date: "2026-10-05", time: "14:00" };
const WEEKDAYS_9_TO_5 = [{ days: ["Mon", "Tue", "Wed", "Thu", "Fri"] as const, from: "09:00", to: "17:00" }];

function entry(id: string, overrides: Partial<WaitlistEntry> = {}): WaitlistEntry {
  return {
    clientId: id,
    name: `Client ${id}`,
    phone: `+1555010000${id}`,
    service: "Cut & style",
    availability: WEEKDAYS_9_TO_5.map((w) => ({ ...w, days: [...w.days] })),
    joinedAt: "2026-09-01",
    ...overrides,
  };
}

const ids = (entries: WaitlistEntry[]) => entries.map((e) => e.clientId);

test("weekdays are read from the slot date", () => {
  assert.equal(weekdayOf("2026-10-05"), "Mon");
  assert.equal(weekdayOf("2026-10-10"), "Sat");
});

test("only clients who want the slot's service match", () => {
  const entries = [entry("1"), entry("2", { service: "Color refresh" }), entry("3", { service: "Blowout" })];
  assert.deepEqual(ids(matchClients(MONDAY_2PM, entries)), ["1"]);
});

test("only clients available on that day and time match", () => {
  const entries = [
    entry("1"),
    entry("2", { availability: [{ days: ["Sat", "Sun"], from: "09:00", to: "17:00" }] }), // wrong day
    entry("3", { availability: [{ days: ["Mon"], from: "15:00", to: "19:00" }] }), // too late
    entry("4", { availability: [{ days: ["Mon"], from: "09:00", to: "14:00" }] }), // ends as slot starts
    entry("5", { availability: [{ days: ["Mon"], from: "14:00", to: "15:00" }] }), // starts as slot starts
    entry("6", {
      availability: [
        { days: ["Tue"], from: "09:00", to: "17:00" },
        { days: ["Mon"], from: "13:00", to: "16:00" }, // any window can match
      ],
    }),
  ];
  assert.deepEqual(ids(matchClients(MONDAY_2PM, entries)), ["1", "5", "6"]);
});

test("clients with no preference or a preference for this stylist match", () => {
  const entries = [
    entry("1"),
    entry("2", { preferredStylist: "Maya" }),
    entry("3", { preferredStylist: "Jordan" }),
  ];
  assert.deepEqual(ids(matchClients(MONDAY_2PM, entries)), ["1", "2"]);
  assert.deepEqual(ids(matchClients({ ...MONDAY_2PM, stylist: "Jordan" }, entries)), ["1", "3"]);
});

test("matches are sorted by earliest join date", () => {
  const entries = [
    entry("1", { joinedAt: "2026-09-20" }),
    entry("2", { joinedAt: "2026-08-02" }),
    entry("3", { joinedAt: "2026-09-03" }),
  ];
  assert.deepEqual(ids(matchClients(MONDAY_2PM, entries)), ["2", "3", "1"]);
});

test("no matches returns an empty list", () => {
  const entries = [entry("1", { service: "Blowout" }), entry("2", { preferredStylist: "Lena" })];
  assert.deepEqual(matchClients(MONDAY_2PM, entries), []);
  assert.deepEqual(matchClients(MONDAY_2PM, []), []);
});

test("findMatchingClients matches different people for different slots", async () => {
  const slot = (overrides: Partial<Slot>): Slot => ({ slotId: "s", ...MONDAY_2PM, ...overrides });
  const names = async (s: Slot) => (await findMatchingClients(s)).map((c) => c.name);

  assert.deepEqual(await names(slot({ time: "17:00" })), ["Daniel Kim", "Grace Liu"]);
  assert.deepEqual(await names(slot({ stylist: "Jordan", time: "17:00" })), ["Mei Chen", "Grace Liu"]);
  assert.deepEqual(await names(slot({ stylist: "Lena", service: "Blowout", time: "09:00" })), ["Sam Okafor"]);
  assert.deepEqual(await names(slot({ stylist: "Lena", service: "Color refresh", time: "10:00" })), []);
  // Only the fields the Workflow needs leave the Activity.
  const [first] = await findMatchingClients(slot({ time: "17:00" }));
  assert.deepEqual(Object.keys(first).sort(), ["clientId", "name", "phone"]);
});
