"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");

const {
  findPaymentResident,
  paymentHouseNumber,
} = require("../domains/payments/resident-repository");

test("paymentHouseNumber accepts supported payment house forms", () => {
  assert.equal(paymentHouseNumber(8), 8);
  assert.equal(paymentHouseNumber("38/68"), 68);
  assert.equal(paymentHouseNumber("house 38/1"), 1);
  assert.equal(paymentHouseNumber("38/69"), null);
  assert.equal(paymentHouseNumber(""), null);
});

test("payment resident lookup uses one direct normal-path read", async () => {
  const calls = [];
  const residents = {
    doc: (id) => ({
      get: async () => {
        calls.push(["doc", id]);
        return {exists: true, data: () => ({name: "Resident 8"})};
      },
    }),
    get: async () => {
      calls.push(["scan"]);
      return {docs: []};
    },
  };

  const resident = await findPaymentResident(residents, 8);
  assert.deepEqual(resident, {name: "Resident 8"});
  assert.deepEqual(calls, [["doc", "38_8"]]);
});

test("findPaymentResident preserves legacy-ID fallback behavior", async () => {
  const calls = [];
  const residents = {
    doc: (id) => ({
      get: async () => {
        calls.push(["doc", id]);
        return {exists: false};
      },
    }),
    get: async () => {
      calls.push(["scan"]);
      return {
        docs: [
          {data: () => ({house_no: "38/8", name: "Legacy Resident"})},
        ],
      };
    },
  };

  const resident = await findPaymentResident(residents, "38/8");
  assert.equal(resident.name, "Legacy Resident");
  assert.deepEqual(calls, [["doc", "38_8"], ["scan"]]);
});
