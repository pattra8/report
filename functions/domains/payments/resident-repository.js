"use strict";

/**
 * Extracts the numeric Pattra house suffix used by payment records.
 * @param {*} value House number in numeric or 38/N form.
 * @return {number|null}
 */
function paymentHouseNumber(value) {
  const match = String(value == null ? "" : value).match(/(\d+)\s*$/);
  if (!match) return null;
  const houseNo = parseInt(match[1], 10);
  return houseNo >= 1 && houseNo <= 68 ? houseNo : null;
}

/**
 * Resolves resident defaults for a payment with one normal-path document read.
 * A full-scan fallback preserves compatibility with legacy records whose
 * document ID does not follow the current 38_N convention.
 *
 * @param {*} residents Firestore residents CollectionReference.
 * @param {*} houseValue Payment house number.
 * @return {Promise<Object|null>} Resident data or null.
 */
async function findPaymentResident(residents, houseValue) {
  const houseNo = paymentHouseNumber(houseValue);
  if (!houseNo) return null;

  const direct = await residents.doc(`38_${houseNo}`).get();
  if (direct.exists) return direct.data() || {};

  const legacy = await residents.get();
  const match = legacy.docs.find((doc) => {
    const data = doc.data() || {};
    return paymentHouseNumber(data.house_no || data.houseNo) === houseNo;
  });
  return match ? match.data() || {} : null;
}

module.exports = {
  findPaymentResident,
  paymentHouseNumber,
};

