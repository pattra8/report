"use strict";

/**
 * Decides if an image starts a fresh visitor record.
 * @param {Object} currentLog Current intake record.
 * @return {boolean}
 */
function shouldStartNewVisitorImageLog(currentLog) {
  if (!currentLog) return false;
  if (currentLog.status === "complete") return true;
  const images = Array.isArray(currentLog.images) ? currentLog.images : [];
  const analyzedImages = images.filter((image) =>
    image && image.analysisPending !== true && image.kind !== "pending");
  return Boolean(
      currentLog.houseNo &&
      currentLog.purposeText &&
      analyzedImages.length >= 2,
  );
}

/**
 * Decides if a text message starts a fresh visitor record.
 * @param {Object} currentLog Current intake record.
 * @param {Object} parsed Parsed incoming message.
 * @return {boolean}
 */
function shouldStartNewVisitorLog(currentLog, parsed) {
  if (!currentLog || !parsed || !parsed.houseNo) return false;
  if (currentLog.houseNo && parsed.houseNo !== currentLog.houseNo) return true;
  if (currentLog.status !== "complete") return false;
  return parsed.houseNo !== currentLog.houseNo ||
    Boolean(parsed.purposeText && currentLog.purposeText);
}

/**
 * Recomputes visitor intake status from aggregate data.
 * @param {Object} data Visitor intake aggregate.
 * @return {string}
 */
function getVisitorIntakeStatus(data) {
  const images = Array.isArray(data.images) ? data.images : [];
  const hasDocument = images.some((image) =>
    ["document", "document_vehicle"].includes(image.kind)) ||
    Boolean(data.ocr && (
      data.ocr.personName ||
      data.ocr.thaiPersonName ||
      data.ocr.englishPersonName ||
      data.ocr.documentNumber
    ));
  const hasPlate = Boolean(
      data.vehicleCapture && data.vehicleCapture.plateText,
  );
  if (!data.houseNo || !data.purposeText) return "pending_text";
  if (data.intakeException) return "partial";
  if (hasDocument && hasPlate) return "complete";
  if (hasDocument || hasPlate) return "partial";
  return "pending_image";
}

/**
 * Applies the hourly cooldown for a LINE outage notice.
 * @param {number} lastAttemptEpoch
 * @param {number} nowEpoch
 * @param {number} cooldownMs
 * @return {boolean}
 */
function shouldAttemptVisitorOutageNotice(lastAttemptEpoch, nowEpoch,
    cooldownMs = 60 * 60 * 1000) {
  const last = Number(lastAttemptEpoch || 0);
  const now = Number(nowEpoch || Date.now());
  return !last || now - last >= cooldownMs;
}

module.exports = {
  getVisitorIntakeStatus,
  shouldAttemptVisitorOutageNotice,
  shouldStartNewVisitorImageLog,
  shouldStartNewVisitorLog,
};
