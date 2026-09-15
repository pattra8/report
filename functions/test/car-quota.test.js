"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_CAR_QUOTA,
  getCarQuota,
  parseCarQuota,
} = require("../domains/residents/car-quota");

test("car quota parser accepts only positive integers", () => {
  assert.equal(parseCarQuota("4"), 4);
  assert.equal(parseCarQuota(1), 1);
  assert.equal(parseCarQuota(0), null);
  assert.equal(parseCarQuota(2.5), null);
  assert.equal(parseCarQuota(""), null);
});

test("resident car quota precedence remains stable", () => {
  assert.equal(getCarQuota("38/19", {car_quota: 6}), 6);
  assert.equal(getCarQuota("38 / 19"), 4);
  assert.equal(getCarQuota("38/41"), 5);
  assert.equal(getCarQuota("38/8"), DEFAULT_CAR_QUOTA);
});

