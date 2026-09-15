"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");

const {
  parkingPeriodsFrom,
  inferParkingMonths,
  splitSlipAmount,
  nextParkingStart,
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
