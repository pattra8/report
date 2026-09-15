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

module.exports = {
  MAX_PARKING_PERIODS,
  parseParkingPeriod,
  parkingPeriodsFrom,
  inferParkingMonths,
  splitSlipAmount,
  nextParkingStart,
};
