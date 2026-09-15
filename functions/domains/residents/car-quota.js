"use strict";

const DEFAULT_CAR_QUOTA = 3;
const CAR_QUOTA_BY_HOUSE = new Map([
  ["38/19", 4],
  ["38/41", 5],
]);

/**
 * Parses a resident quota value into a positive integer.
 * @param {*} value Candidate quota.
 * @return {number|null}
 */
function parseCarQuota(value) {
  if (value === null || value === undefined || value === "") return null;
  const quota = Number(value);
  return Number.isInteger(quota) && quota > 0 ? quota : null;
}

/**
 * Returns the resident override, house exception, or default quota.
 * @param {*} houseNo House identifier.
 * @param {Object} residentData Resident record.
 * @return {number}
 */
function getCarQuota(houseNo, residentData = {}) {
  const residentQuota = parseCarQuota(
      residentData.car_quota || residentData.carQuota,
  );
  if (residentQuota) return residentQuota;
  const normalizedHouseNo = String(houseNo || "").trim().replace(/\s+/g, "");
  return CAR_QUOTA_BY_HOUSE.get(normalizedHouseNo) || DEFAULT_CAR_QUOTA;
}

module.exports = {
  DEFAULT_CAR_QUOTA,
  getCarQuota,
  parseCarQuota,
};

