"use strict";

/**
 * Parking-fee period helpers.
 *
 * One bank transfer often covers several parking months (600 = 1 month,
 * 1,200 = 2 months, 3,600.xx = 6 months). Residents also encode their house
 * number in the satang, Pattra-Pay style: 3,600.45 means house 38/45. These
 * helpers are pure so the split can be unit tested without Firestore.
 */

const MAX_PARKING_PERIODS = 12;

/**
 * Parse "YYYY-MM" into its parts.
 * @param {string} period period key
 * @return {{year: number, month: number}|null} parsed parts, or null
 */
function parseParkingPeriod(period) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return {year, month};
}

/**
 * Build the consecutive months a multi-month transfer covers.
 * @param {string} startPeriod first month as "YYYY-MM"
 * @param {number} count how many months, 1..12
 * @return {string[]} period keys, empty when the input is unusable
 */
function parkingPeriodsFrom(startPeriod, count) {
  const start = parseParkingPeriod(startPeriod);
  const n = Number(count);
  if (!start) return [];
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARKING_PERIODS) return [];
  const periods = [];
  for (let i = 0; i < n; i += 1) {
    const monthIndex = start.month - 1 + i;
    const year = start.year + Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    periods.push(`${year}-${String(month).padStart(2, "0")}`);
  }
  return periods;
}

/**
 * Suggest how many months a transferred amount covers.
 *
 * Only an exact multiple of the monthly rate counts. The satang is treated as
 * the house marker when it matches the paying house; any other satang is left
 * alone and the caller is told not to auto-assign periods.
 *
 * @param {number} amount transferred amount in baht
 * @param {number} monthlyRate monthly parking rate in baht (e.g. 600)
 * @param {number} houseNo paying house number, 1..68
 * @return {Object} suggestion for the review UI: months, auto, houseMarker
 *   and reason.
 */
function inferParkingMonths(amount, monthlyRate, houseNo) {
  const totalSatang = Math.round(Number(amount) * 100);
  const rateSatang = Math.round(Number(monthlyRate) * 100);
  const house = Number(houseNo);
  const marker = ((totalSatang % 100) + 100) % 100;
  const reject = (reason) => ({
    months: 0, auto: false, houseMarker: null, reason,
  });

  if (!Number.isFinite(totalSatang) || totalSatang <= 0) {
    return reject("bad-amount");
  }
  if (!Number.isFinite(rateSatang) || rateSatang <= 0) {
    return reject("bad-rate");
  }

  let houseMarker = null;
  let bodySatang = totalSatang;
  if (marker > 0) {
    if (!Number.isInteger(house) || marker !== house) {
      return reject("satang-house-mismatch");
    }
    houseMarker = marker;
    bodySatang = totalSatang - marker;
  }

  if (bodySatang % rateSatang !== 0) return reject("not-a-whole-month");
  const months = bodySatang / rateSatang;
  if (months < 1 || months > MAX_PARKING_PERIODS) return reject("out-of-range");
  return {months, auto: true, houseMarker, reason: "ok"};
}

/**
 * Split one transfer across its months, in satang, without losing a cent.
 *
 * The house-marker satang and any remainder stay on the first month so the
 * rows add back up to exactly what was transferred.
 *
 * @param {number} amount transferred amount in baht
 * @param {number} houseNo paying house number, used to spot the satang marker
 * @param {number} periodCount how many months the transfer covers
 * @return {number[]} per-month amounts in satang
 */
function splitSlipAmount(amount, houseNo, periodCount) {
  const totalSatang = Math.round(Number(amount) * 100);
  const n = Number(periodCount);
  if (!Number.isFinite(totalSatang) || totalSatang <= 0) return [];
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARKING_PERIODS) return [];
  if (n === 1) return [totalSatang];

  const marker = ((totalSatang % 100) + 100) % 100;
  const hasMarker = marker > 0 && marker === Number(houseNo);
  const bodySatang = hasMarker ? totalSatang - marker : totalSatang;
  const each = Math.floor(bodySatang / n);
  const remainder = bodySatang - each * n;
  const rows = new Array(n).fill(each);
  rows[0] += remainder + (hasMarker ? marker : 0);
  return rows;
}

/**
 * Pick the month a new parking payment should start from.
 *
 * The first month after everything already settled or awaiting review, so a
 * resident who prepays twice does not buy the same month again. Falls back to
 * the current month when the house has no parking history.
 *
 * @param {string[]} takenPeriods periods already pending or verified
 * @param {string} currentPeriod this month as "YYYY-MM"
 * @return {string} the month to start from, or "" when nothing is usable
 */
function nextParkingStart(takenPeriods, currentPeriod) {
  const current = parseParkingPeriod(currentPeriod);
  if (!current) return "";
  const valid = (Array.isArray(takenPeriods) ? takenPeriods : [])
      .map((value) => parseParkingPeriod(value))
      .filter(Boolean)
      .map((parsed) => parsed.year * 12 + (parsed.month - 1));
  const currentIndex = current.year * 12 + (current.month - 1);
  const latest = valid.length ? Math.max(...valid) : -1;
  const startIndex = Math.max(currentIndex, latest + 1);
  const year = Math.floor(startIndex / 12);
  const month = (startIndex % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Turn a period key into a comparable month index, or -1.
 * @param {string} period period key
 * @return {number} months since year 0, or -1 when unusable
 */
function periodIndex(period) {
  const parsed = parseParkingPeriod(period);
  return parsed ? parsed.year * 12 + (parsed.month - 1) : -1;
}

/**
 * Turn a month index back into a period key.
 * @param {number} index months since year 0
 * @return {string} period key
 */
function periodFromIndex(index) {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Choose which months a payment settles: unpaid ones first, oldest first.
 *
 * A resident who has fallen behind and then transfers is paying off the
 * arrears, not buying a month in the future — so the months already skipped
 * get filled before the run carries on past today. Only gaps AFTER the house's
 * first record count: the committee is still entering historical slips, and a
 * month with no record from before the house appears in the system is missing
 * data rather than a debt (the same rule /myparking shows residents).
 *
 * Returned months are not necessarily consecutive.
 *
 * @param {string[]} takenPeriods periods already pending or verified
 * @param {string} currentPeriod this month as "YYYY-MM"
 * @param {number} count how many months the transfer covers, 1..12
 * @return {string[]} the months to settle, oldest first
 */
function allocateParkingMonths(takenPeriods, currentPeriod, count) {
  const current = periodIndex(currentPeriod);
  const n = Number(count);
  if (current < 0) return [];
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARKING_PERIODS) return [];

  const taken = new Set((Array.isArray(takenPeriods) ? takenPeriods : [])
      .map(periodIndex)
      .filter((index) => index >= 0));

  const picked = [];
  if (taken.size) {
    // Every month between the first one on record and today that the house
    // does not already hold. Anything before that first record is unknown.
    const earliest = Math.min(...taken);
    for (let i = earliest + 1; i < current && picked.length < n; i += 1) {
      if (!taken.has(i)) picked.push(i);
    }
  }

  // Then carry on from today, or from just after the furthest month held —
  // whichever is later — so prepaying twice never buys the same month.
  const latest = taken.size ? Math.max(...taken) : -1;
  let next = Math.max(current, latest + 1);
  while (picked.length < n) {
    if (!taken.has(next)) picked.push(next);
    next += 1;
  }

  return picked.sort((a, b) => a - b).map(periodFromIndex);
}

/**
 * Months the house has skipped: unpaid, older than this month, and after the
 * first month it has any record for. This is what the resident is asked about
 * before a slip is filed, and what "ชำระต่อเนื่องถึง" stops at.
 *
 * @param {string[]} takenPeriods periods already pending or verified
 * @param {string} currentPeriod this month as "YYYY-MM"
 * @return {string[]} the unpaid months, oldest first
 */
function parkingArrears(takenPeriods, currentPeriod) {
  const current = periodIndex(currentPeriod);
  if (current < 0) return [];
  const taken = new Set((Array.isArray(takenPeriods) ? takenPeriods : [])
      .map(periodIndex)
      .filter((index) => index >= 0));
  if (!taken.size) return [];
  const earliest = Math.min(...taken);
  const gaps = [];
  for (let i = earliest + 1; i < current; i += 1) {
    if (!taken.has(i)) gaps.push(i);
  }
  return gaps.map(periodFromIndex);
}

// Month names as residents actually write them in a transfer memo: Thai in
// full and abbreviated (with or without the trailing dot), and English in full
// and in the usual three letters.
const MEMO_MONTHS = [
  ["มกราคม", "ม.ค", "มค", "january", "jan"],
  ["กุมภาพันธ์", "ก.พ", "กพ", "february", "feb"],
  ["มีนาคม", "มี.ค", "มีค", "march", "mar"],
  ["เมษายน", "เม.ย", "เมย", "april", "apr"],
  ["พฤษภาคม", "พ.ค", "พค", "may"],
  ["มิถุนายน", "มิ.ย", "มิย", "june", "jun"],
  ["กรกฎาคม", "ก.ค", "กค", "july", "jul"],
  ["สิงหาคม", "ส.ค", "สค", "august", "aug"],
  ["กันยายน", "ก.ย", "กย", "september", "sept", "sep"],
  ["ตุลาคม", "ต.ค", "ตค", "october", "oct"],
  ["พฤศจิกายน", "พ.ย", "พย", "november", "nov"],
  ["ธันวาคม", "ธ.ค", "ธค", "december", "dec"],
];

/**
 * Normalise a year as written on a slip into a Gregorian year.
 *
 * Residents write 2026, 2569 (Buddhist), 26, or 69 — all meaning the same
 * year. Buddhist years run 543 ahead.
 *
 * @param {string} raw the digits found next to the month
 * @param {number} currentYear this year, Gregorian
 * @return {number} a Gregorian year, or 0 when it cannot be read
 */
function memoYear(raw, currentYear) {
  const digits = String(raw || "").trim();
  if (!/^\d{2}$|^\d{4}$/.test(digits)) return 0;
  const value = Number(digits);
  if (digits.length === 4) return value > 2400 ? value - 543 : value;
  // Two digits: 69 is Buddhist 2569, 26 is Gregorian 2026. Decide by which
  // one lands nearer to now rather than by a hard-coded cutoff.
  const asGregorian = 2000 + value;
  const asBuddhist = 2500 + value - 543;
  return Math.abs(asGregorian - currentYear) <=
    Math.abs(asBuddhist - currentYear) ? asGregorian : asBuddhist;
}

/**
 * Read the month a resident named in the transfer memo.
 *
 * A memo of "ค่าจอดรถ feb 2026" is the clearest statement of intent on the
 * whole slip, and it used to be thrown away. Returns "" unless a month is
 * unambiguous, and refuses anything far from today so a stray number in an
 * account or reference cannot be mistaken for a period.
 *
 * @param {string} memo the memo/note line read off the slip
 * @param {string} currentPeriod this month as "YYYY-MM"
 * @return {string} period key, or "" when the memo names no usable month
 */
function parseMemoPeriod(memo, currentPeriod) {
  const current = parseParkingPeriod(currentPeriod);
  if (!current) return "";
  const text = String(memo || "").toLowerCase().replace(/[_/]/g, " ");
  if (!text.trim()) return "";

  let month = 0;
  let after = "";
  for (let i = 0; i < MEMO_MONTHS.length; i += 1) {
    for (const name of MEMO_MONTHS[i]) {
      // Thai has no word boundaries, so match the name then read whatever
      // digits follow it as the year.
      const at = text.indexOf(name);
      if (at < 0) continue;
      // A longer name already matched wins (e.g. "sept" over "sep").
      if (month && month !== i + 1) return "";
      month = i + 1;
      const tail = text.slice(at + name.length, at + name.length + 8);
      const found = /^[.\s]*(\d{2,4})/.exec(tail);
      if (found && !after) after = found[1];
    }
  }
  if (!month) return "";

  const year = after ? memoYear(after, current.year) : current.year;
  if (!year) return "";
  const index = year * 12 + (month - 1);
  const currentIndex = current.year * 12 + (current.month - 1);
  // A memo may settle the recent past or buy a little ahead. Anything outside
  // that is a misread, not an instruction.
  if (index < currentIndex - 24 || index > currentIndex + 12) return "";
  return `${year}-${String(month).padStart(2, "0")}`;
}

module.exports = {
  MAX_PARKING_PERIODS,
  parseParkingPeriod,
  parkingPeriodsFrom,
  inferParkingMonths,
  splitSlipAmount,
  nextParkingStart,
  allocateParkingMonths,
  parkingArrears,
  parseMemoPeriod,
};
