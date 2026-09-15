"use strict";

/* eslint-disable require-jsdoc */

const COMMON_PERIODS = Object.freeze(["H1", "H2"]);

const COMMON_PERIOD_LABELS = Object.freeze({
  H1: "ครึ่งปีแรก (ม.ค.–มิ.ย.)",
  H2: "ครึ่งปีหลัง (ก.ค.–ธ.ค.)",
});

const COMMON_PERIOD_SHORT_LABELS = Object.freeze({
  H1: "ครึ่งปีแรก",
  H2: "ครึ่งปีหลัง",
});

function isCommonPeriod(period) {
  return COMMON_PERIODS.includes(String(period || ""));
}

function normalizeCommonPeriod(period, fallback) {
  const clean = String(period == null ? "" : period).trim().toUpperCase();
  if (!clean) return fallback;
  if (!isCommonPeriod(clean)) {
    throw Object.assign(new Error("งวดไม่ถูกต้อง"), {status: 400});
  }
  return clean;
}

function commonPeriodLabel(period, short = false) {
  const table = short ? COMMON_PERIOD_SHORT_LABELS : COMMON_PERIOD_LABELS;
  return table[String(period || "")] || String(period || "");
}

module.exports = {
  COMMON_PERIODS,
  COMMON_PERIOD_LABELS,
  COMMON_PERIOD_SHORT_LABELS,
  commonPeriodLabel,
  isCommonPeriod,
  normalizeCommonPeriod,
};
