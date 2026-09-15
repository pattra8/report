"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");

const {
  commonSlipAmount,
  normalizeOptionalReceiptEmail,
} = require("../domains/payments/public-slip-policy");

test("common slip amount encodes the house suffix", () => {
  assert.equal(commonSlipAmount(9600, 1), 9600.01);
  assert.equal(commonSlipAmount(9600, 38), 9600.38);
  assert.equal(commonSlipAmount(9600, 68), 9600.68);
});

test("optional receipt email accepts empty and normalizes valid input", () => {
  assert.equal(normalizeOptionalReceiptEmail(""), "");
  assert.equal(
      normalizeOptionalReceiptEmail(" Resident@Example.COM "),
      "resident@example.com",
  );
  assert.throws(
      () => normalizeOptionalReceiptEmail("not-an-email"),
      /อีเมลไม่ถูกต้อง/,
  );
});
