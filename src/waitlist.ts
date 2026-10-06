import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Availability, WaitlistEntry, Weekday } from "./types";

// Demo waitlist, one row per client. In production this is the salon's
// Google Sheet. It's read fresh on every call, so edits apply to the next
// cancellation without a restart.
export const WAITLIST_CSV = process.env.WAITLIST_CSV ?? path.resolve(__dirname, "../data/waitlist.csv");

const COLUMNS = ["name", "phone", "service", "availability", "preferred_stylist", "joined"] as const;
const DAYS: Weekday[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export async function loadWaitlist(file = WAITLIST_CSV): Promise<WaitlistEntry[]> {
  return parseWaitlist(await readFile(file, "utf8"));
}

// Throws with the row number and what's wrong, so a bad edit is easy to fix.
export function parseWaitlist(text: string): WaitlistEntry[] {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, "")); // Excel may add a BOM
  const columns = (header ?? []).map((h) => h.trim().toLowerCase());
  const missing = COLUMNS.filter((c) => !columns.includes(c));
  if (missing.length) throw new Error(`Waitlist CSV is missing column(s): ${missing.join(", ")}`);

  return rows
    .map((cells, index) => ({ cells, row: index + 2 })) // row 1 is the header
    .filter(({ cells }) => cells.some((cell) => cell.trim()))
    .map(({ cells, row }) => {
      const get = (column: (typeof COLUMNS)[number]) => (cells[columns.indexOf(column)] ?? "").trim();
      try {
        for (const column of ["name", "phone", "service", "availability", "joined"] as const) {
          if (!get(column)) throw new Error(`"${column}" is empty`);
        }
        return {
          clientId: `w${row - 1}`,
          name: get("name"),
          phone: get("phone"),
          service: get("service"),
          availability: parseAvailability(get("availability")),
          availabilityText: get("availability"),
          preferredStylist: get("preferred_stylist") || undefined,
          joinedAt: parseDate(get("joined")),
        };
      } catch (error) {
        throw new Error(`Waitlist CSV row ${row}: ${(error as Error).message}`);
      }
    });
}

// "Mon-Fri 09:00-17:00", "Tue,Thu 10:00-16:00", or several windows joined
// with ";" like "Sat,Sun 10:00-18:00; Mon 17:00-21:00".
export function parseAvailability(text: string): Availability[] {
  return text
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(.+?)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(part);
      if (!match) throw new Error(`can't read availability "${part}" (expected e.g. "Mon-Fri 09:00-17:00")`);
      const [, dayText, from, to] = match;
      const range = { days: parseDays(dayText), from: padTime(from), to: padTime(to) };
      if (range.from >= range.to) throw new Error(`availability "${part}" ends before it starts`);
      return range;
    });
}

function parseDays(text: string): Weekday[] {
  const days = new Set<Weekday>();
  for (const piece of text.split(",").map((p) => p.trim())) {
    const [start, end] = piece.split("-").map(dayIndex);
    if (end === undefined) {
      days.add(DAYS[start]);
      continue;
    }
    for (let i = start; ; i = (i + 1) % 7) {
      days.add(DAYS[i]); // ranges may wrap, e.g. Sat-Mon
      if (i === end) break;
    }
  }
  return DAYS.filter((d) => days.has(d));
}

function dayIndex(text: string): number {
  const index = DAYS.findIndex((d) => d.toLowerCase() === text.trim().slice(0, 3).toLowerCase());
  if (index < 0) throw new Error(`"${text.trim()}" isn't a day (use Mon, Tue, …)`);
  return index;
}

function padTime(time: string): string {
  const [hours, minutes] = time.split(":").map(Number);
  if (hours > 24 || minutes > 59) throw new Error(`"${time}" isn't a time`);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

// Accepts 2026-08-14, or 8/14/2026 as Excel tends to save it.
function parseDate(text: string): string {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  const parts = iso ? [iso[1], iso[2], iso[3]] : us ? [us[3], us[1], us[2]] : undefined;
  if (!parts) throw new Error(`"${text}" isn't a date (use YYYY-MM-DD)`);
  const [year, month, day] = parts;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

// Minimal CSV: commas, quoted fields with "" escapes, and \n or \r\n lines.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}
