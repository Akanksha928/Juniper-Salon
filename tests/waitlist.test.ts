import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadWaitlist, parseAvailability, parseWaitlist } from "../src/waitlist";

const HEADER = "name,phone,service,availability,preferred_stylist,joined";

test("the shipped waitlist file loads", async () => {
  const entries = await loadWaitlist();
  assert.equal(entries.length, 8);
  assert.deepEqual(new Set(entries.map((e) => e.service)), new Set(["Cut & style", "Color refresh", "Blowout"]));
  const mei = entries.find((e) => e.name === "Mei Chen")!;
  assert.equal(mei.preferredStylist, "Jordan");
  assert.deepEqual(mei.availability, [
    { days: ["Sat"], from: "10:00", to: "18:00" },
    { days: ["Tue"], from: "17:00", to: "21:00" },
  ]);
  // The salon is closed Sundays and Mondays, so nobody lists them.
  assert.ok(entries.every((e) => e.availability.every((w) => !w.days.includes("Sun") && !w.days.includes("Mon"))));
  assert.equal(entries.find((e) => e.name === "Priya Shah")!.preferredStylist, undefined);
});

test("availability accepts day lists, ranges, and several windows", () => {
  assert.deepEqual(parseAvailability("Mon-Fri 9:00-17:00"), [
    { days: ["Mon", "Tue", "Wed", "Thu", "Fri"], from: "09:00", to: "17:00" },
  ]);
  assert.deepEqual(parseAvailability("tue, thu 10:00 - 16:00"), [{ days: ["Tue", "Thu"], from: "10:00", to: "16:00" }]);
  assert.deepEqual(parseAvailability("Sat-Mon 08:00-12:00")[0].days, ["Sun", "Mon", "Sat"]); // wraps
  assert.equal(parseAvailability("Sat 10:00-18:00; Mon 17:00-21:00").length, 2);
});

test("rows saved by Excel still load", () => {
  // BOM, CRLF line endings, US-style dates, a blank trailing line.
  const csv = `﻿${HEADER}\r\nAna Ruiz,(555) 010-1111,Blowout,"Mon,Wed 09:00-12:00",,8/4/2026\r\n\r\n`;
  const [ana] = parseWaitlist(csv);
  assert.equal(ana.joinedAt, "2026-08-04");
  assert.deepEqual(ana.availability[0].days, ["Mon", "Wed"]);
  assert.equal(ana.clientId, "w1");
});

test("a bad row is reported with its row number", () => {
  assert.throws(() => parseWaitlist(`name,phone,service\nAna,1,Blowout`), /missing column\(s\): availability/);
  assert.throws(
    () => parseWaitlist(`${HEADER}\nAna,1,Blowout,Mon 09:00-12:00,,2026-08-04\nBo,2,Blowout,weekdays,,2026-08-05`),
    /row 3: can't read availability "weekdays"/,
  );
  assert.throws(() => parseWaitlist(`${HEADER}\nAna,1,Blowout,Mon 09:00-12:00,,soon`), /row 2: "soon" isn't a date/);
  assert.throws(() => parseWaitlist(`${HEADER}\nAna,1,Blowout,Mon 12:00-09:00,,2026-08-04`), /ends before it starts/);
});

test("edits to the file are picked up on the next read, without a restart", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "waitlist-")), "waitlist.csv");
  await writeFile(file, `${HEADER}\nAna Ruiz,1,Blowout,Mon 09:00-12:00,,2026-08-04\n`);
  assert.deepEqual((await loadWaitlist(file)).map((e) => e.name), ["Ana Ruiz"]);

  await writeFile(file, `${HEADER}\nAna Ruiz,1,Blowout,Mon 09:00-12:00,,2026-08-04\nBo Lee,2,Blowout,Tue 09:00-12:00,Lena,2026-08-05\n`);
  assert.deepEqual((await loadWaitlist(file)).map((e) => e.name), ["Ana Ruiz", "Bo Lee"]);
});
