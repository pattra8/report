"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");

const {
  parkingPeriodsFrom,
  inferParkingMonths,
  splitSlipAmount,
  nextParkingStart,
  allocateParkingMonths,
  parkingArrears,
  parseMemoPeriod,
} = require("../domains/payments/parking-period");

test("consecutive parking months roll into the next year", () => {
  assert.deepEqual(parkingPeriodsFrom("2026-09", 1), ["2026-09"]);
  assert.deepEqual(parkingPeriodsFrom("2026-10", 6), [
    "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03",
  ]);
});

test("bad period keys and month counts produce no periods", () => {
  assert.deepEqual(parkingPeriodsFrom("2026-13", 2), []);
  assert.deepEqual(parkingPeriodsFrom("", 2), []);
  assert.deepEqual(parkingPeriodsFrom("2026-09", 0), []);
  assert.deepEqual(parkingPeriodsFrom("2026-09", 13), []);
});

test("round amounts map to whole months for the paying house", () => {
  assert.equal(inferParkingMonths(600, 600, 21).months, 1);
  assert.equal(inferParkingMonths(1200, 600, 21).months, 2);
  assert.equal(inferParkingMonths(3600, 600, 21).months, 6);
});

test("satang that matches the house is read as the house marker", () => {
  const six = inferParkingMonths(3600.45, 600, 45);
  assert.equal(six.months, 6);
  assert.equal(six.houseMarker, 45);
  assert.equal(six.auto, true);
});

test("satang that does not match the house is never auto-assigned", () => {
  const mismatch = inferParkingMonths(600.15, 600, 45);
  assert.equal(mismatch.auto, false);
  assert.equal(mismatch.months, 0);
  assert.equal(mismatch.reason, "satang-house-mismatch");
});

test("amounts that are not whole months go to manual review", () => {
  assert.equal(inferParkingMonths(800, 600, 43).reason, "not-a-whole-month");
  assert.equal(inferParkingMonths(0, 600, 43).reason, "bad-amount");
  assert.equal(inferParkingMonths(7800, 600, 43).reason, "out-of-range");
});

test("a split adds back up to exactly what was transferred", () => {
  const rows = splitSlipAmount(3600.45, 45, 6);
  assert.deepEqual(rows, [60045, 60000, 60000, 60000, 60000, 60000]);
  assert.equal(rows.reduce((a, b) => a + b, 0), 360045);
});

test("a single month keeps the transferred amount untouched", () => {
  assert.deepEqual(splitSlipAmount(600.15, 45, 1), [60015]);
});

test("an uneven split leaves the remainder on the first month", () => {
  const rows = splitSlipAmount(1000, 45, 3);
  assert.deepEqual(rows, [33334, 33333, 33333]);
  assert.equal(rows.reduce((a, b) => a + b, 0), 100000);
});

test("a house with no parking history starts from this month", () => {
  assert.equal(nextParkingStart([], "2026-09"), "2026-09");
});

test("a prepaid house starts after the last month it already holds", () => {
  const taken = ["2026-09", "2026-10", "2026-11"];
  assert.equal(nextParkingStart(taken, "2026-09"), "2026-12");
});

test("months already behind us never pull the start date backwards", () => {
  assert.equal(nextParkingStart(["2026-01", "2026-02"], "2026-09"), "2026-09");
});

test("a run that ends in December rolls into the next year", () => {
  assert.equal(nextParkingStart(["2026-12"], "2026-09"), "2027-01");
});

test("an unusable current month yields no start", () => {
  assert.equal(nextParkingStart([], "nope"), "");
});

test("a payment settles the oldest unpaid month before buying ahead", () => {
  // House 38/8: paid Jan, nothing since, transfers 600 in September. The
  // months it skipped come first — buying September while February is open is
  // what produced "ชำระแล้วถึง ก.ย." over seven unpaid months.
  assert.deepEqual(
      allocateParkingMonths(["2026-01"], "2026-09", 1), ["2026-02"]);
});

test("a multi-month transfer fills the whole gap in order", () => {
  assert.deepEqual(
      allocateParkingMonths(["2026-01"], "2026-09", 6),
      ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"]);
});

test("a gap shorter than the transfer runs on from this month", () => {
  // Two months owed (Feb, Mar), six paid for: settle both, then Apr..Jul are
  // already held, so the remainder starts at the current month.
  const taken = ["2026-01", "2026-04", "2026-05", "2026-06", "2026-07",
    "2026-08"];
  assert.deepEqual(allocateParkingMonths(taken, "2026-09", 4),
      ["2026-02", "2026-03", "2026-09", "2026-10"]);
});

test("a house that owes nothing simply prepays forward", () => {
  const taken = ["2026-07", "2026-08", "2026-09"];
  assert.deepEqual(allocateParkingMonths(taken, "2026-09", 2),
      ["2026-10", "2026-11"]);
});

test("months before the first record are missing data, not arrears", () => {
  // The committee is still entering old slips, so nothing before the house's
  // own first record may be sold as an unpaid month.
  assert.deepEqual(allocateParkingMonths(["2026-06"], "2026-09", 2),
      ["2026-07", "2026-08"]);
  assert.deepEqual(parkingArrears(["2026-06"], "2026-09"),
      ["2026-07", "2026-08"]);
});

test("a house with no history at all starts from this month", () => {
  assert.deepEqual(allocateParkingMonths([], "2026-09", 2),
      ["2026-09", "2026-10"]);
  assert.deepEqual(parkingArrears([], "2026-09"), []);
});

test("allocation never resells a month the house already holds", () => {
  const taken = ["2026-01", "2026-03", "2026-09"];
  const got = allocateParkingMonths(taken, "2026-09", 4);
  assert.deepEqual(got, ["2026-02", "2026-04", "2026-05", "2026-06"]);
  assert.equal(got.some((period) => taken.includes(period)), false);
});

test("arrears for house 38/8 are the seven months it skipped", () => {
  assert.deepEqual(parkingArrears(["2026-01", "2026-09"], "2026-09"), [
    "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07",
    "2026-08",
  ]);
});

test("bad allocation input yields no months", () => {
  assert.deepEqual(allocateParkingMonths(["2026-01"], "nope", 1), []);
  assert.deepEqual(allocateParkingMonths(["2026-01"], "2026-09", 0), []);
  assert.deepEqual(allocateParkingMonths(["2026-01"], "2026-09", 13), []);
});

test("the memo on the real 38/8 slip names February", () => {
  // The slip that started all this: "Memo: ค่าจอดรถ feb 2026".
  assert.equal(parseMemoPeriod("ค่าจอดรถ feb 2026", "2026-09"), "2026-02");
});

test("Thai months in a memo are read in every usual spelling", () => {
  assert.equal(parseMemoPeriod("ค่าจอดรถ ก.พ. 2026", "2026-09"), "2026-02");
  assert.equal(parseMemoPeriod("ค่าจอด กพ 2026", "2026-09"), "2026-02");
  assert.equal(
      parseMemoPeriod("ค่าจอดรถ กุมภาพันธ์ 2026", "2026-09"), "2026-02");
  assert.equal(parseMemoPeriod("ค่าจอดรถเดือนมีนาคม", "2026-09"), "2026-03");
});

test("Buddhist years are converted, not taken at face value", () => {
  assert.equal(parseMemoPeriod("ค่าจอดรถ ก.พ. 2569", "2026-09"), "2026-02");
  assert.equal(parseMemoPeriod("ค่าจอดรถ ก.พ. 69", "2026-09"), "2026-02");
  assert.equal(parseMemoPeriod("ค่าจอดรถ ก.พ. 26", "2026-09"), "2026-02");
});

test("English months, long and short, both read", () => {
  assert.equal(
      parseMemoPeriod("parking fee FEBRUARY 2026", "2026-09"), "2026-02");
  assert.equal(parseMemoPeriod("parking Sept 2026", "2026-09"), "2026-09");
  assert.equal(parseMemoPeriod("DEC 2026 parking", "2026-09"), "2026-12");
});

test("a memo with no year means the year in progress", () => {
  assert.equal(parseMemoPeriod("ค่าจอดรถ ก.พ.", "2026-09"), "2026-02");
});

test("a memo naming no month yields nothing", () => {
  assert.equal(parseMemoPeriod("ค่าจอดรถ", "2026-09"), "");
  assert.equal(parseMemoPeriod("", "2026-09"), "");
  assert.equal(parseMemoPeriod("โอนค่าส่วนกลาง 600", "2026-09"), "");
});

test("two different months in one memo are refused, not guessed", () => {
  assert.equal(parseMemoPeriod("ค่าจอดรถ ม.ค. และ ก.พ.", "2026-09"), "");
});

test("a month far outside the plausible window is a misread", () => {
  // A reference number that happens to contain "จ.ค. 2003" must not become a
  // period; neither must a month years ahead.
  assert.equal(parseMemoPeriod("ค่าจอดรถ ม.ค. 2003", "2026-09"), "");
  assert.equal(parseMemoPeriod("ค่าจอดรถ ม.ค. 2030", "2026-09"), "");
});

test("bad current period yields nothing", () => {
  assert.equal(parseMemoPeriod("ค่าจอดรถ feb 2026", "nope"), "");
});
