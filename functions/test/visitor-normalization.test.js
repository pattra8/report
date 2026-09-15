"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");

const {
  maskDocumentNumber,
  normalizeDocumentNumber,
  normalizeThaiProvince,
  normalizeVisitorName,
  normalizeVisitorPlate,
  normalizeVisitorVehicleType,
  stripThaiProvinceForLookup,
} = require("../domains/visitors/normalization");

test("visitor identity normalization preserves display contract", () => {
  assert.equal(normalizeVisitorName("  สมชาย   ใจดี  "), "สมชาย ใจดี");
  assert.equal(normalizeThaiProvince("กรุงเทพมหานคร"), "กรุงเทพ");
  assert.equal(
      normalizeVisitorPlate("7ขข1159 จังหวัดกรุงเทพมหานคร"),
      "7ขข 1159 กรุงเทพ",
  );
  assert.equal(stripThaiProvinceForLookup("7ขข 1159 กรุงเทพ"), "7ขข1159");
});

test("visitor document normalization and masking remain deterministic", () => {
  assert.equal(normalizeDocumentNumber("1-2345-67890-12-3"), "1234567890123");
  assert.equal(maskDocumentNumber("1234567890123"), "*********0123");
  assert.equal(maskDocumentNumber("123"), "");
});

test("visitor vehicle categories preserve committee-facing labels", () => {
  assert.equal(normalizeVisitorVehicleType("garbage_truck"), "รถขยะ");
  assert.equal(normalizeVisitorVehicleType("motorcycle"), "รถมอเตอร์ไซค์");
  assert.equal(normalizeVisitorVehicleType("pickup"), "รถยนต์");
});
