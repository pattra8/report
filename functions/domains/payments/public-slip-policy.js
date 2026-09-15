"use strict";

/**
 * Normalizes an optional receipt email without accepting malformed addresses.
 * @param {*} value User-provided email.
 * @return {string}
 */
function normalizeOptionalReceiptEmail(value) {
  const email = String(value == null ? "" : value).trim().toLowerCase();
  if (!email) return "";
  if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error("อีเมลไม่ถูกต้อง"), {status: 400});
  }
  return email;
}

/**
 * Encodes the house suffix in the two decimal places of the common-fee amount.
 * @param {number} base Base common-fee amount.
 * @param {number} houseNo House suffix from 1 through 68.
 * @return {number}
 */
function commonSlipAmount(base, houseNo) {
  return Number((Number(base) + Number(houseNo) / 100).toFixed(2));
}

module.exports = {
  commonSlipAmount,
  normalizeOptionalReceiptEmail,
};
