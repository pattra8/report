"use strict";

/**
 * Retry transient OCR failures against the same saved image, without replaying
 * the LINE event (which could attach it to a newer visitor session).
 * @param {Function} analyze One bounded OCR request.
 * @param {Function} onFailure Receives error and attempt, without image data.
 * @param {number} maxAttempts Maximum requests in this invocation.
 * @return {Promise<Object>}
 */
async function analyzeVisitorImageWithRetry(analyze, onFailure = () => {},
    maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return {analysis: await analyze(), attempts: attempt, failed: false};
    } catch (error) {
      onFailure(error, attempt);
      const status = Number(error.status || 0);
      const transient = !status || [408, 429].includes(status) || status >= 500;
      if (!transient || attempt === maxAttempts) {
        return {analysis: null, attempts: attempt, failed: true,
          retryable: transient};
      }
    }
  }
}

/**
 * Returns a timestamp in milliseconds for stored or serialized timestamps.
 * @param {*} value Timestamp.
 * @return {number}
 */
function visitorTimestampMs(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && (value.seconds || value._seconds)) {
    return Number(value.seconds || value._seconds) * 1000;
  }
  return typeof value === "number" ? value : Date.parse(value || "") || 0;
}

/**
 * Selects only saved, unexpired images that still need transport recovery.
 * Low-confidence analyzed images require review, not repeated model calls.
 * @param {Object} image Stored image.
 * @param {number} now Current epoch milliseconds.
 * @return {boolean}
 */
function canRetryVisitorImage(image, now) {
  return Boolean(image && image.storagePath && !image.purgedAt &&
    !image.analysis && image.analysisRetryable !== false &&
    Number(image.analysisAttempts || 0) < 9 &&
    (!image.expiresAt || visitorTimestampMs(image.expiresAt) > now));
}

/**
 * Schedules bounded, delayed recovery independently of the LINE event queue.
 * Five minutes also leaves the 240-second webhook enough time to finish.
 * @param {Object[]} images Images after an atomic merge.
 * @param {number} now Current epoch milliseconds.
 * @return {number|null}
 */
function nextVisitorOcrRetryAt(images, now) {
  const eligible = (images || []).filter((i) => canRetryVisitorImage(i, now));
  if (!eligible.length) return null;
  const attempts = Math.min(...eligible.map((i) =>
    Number(i.analysisAttempts || 0)));
  return now + 5 * 60 * 1000 * Math.pow(2, Math.floor(attempts / 3));
}

/**
 * Maps an OCR outcome without calling a transport failure an analyzed image.
 * @param {Object} outcome OCR result.
 * @return {Object}
 */
function visitorImageAnalysisPatch(outcome) {
  const analysis = outcome.analysis;
  const document = Boolean(analysis && (analysis.personName ||
    analysis.thaiPersonName || analysis.englishPersonName ||
    analysis.documentNumber));
  const vehicle = Boolean(analysis && analysis.vehiclePlate);
  const kind = analysis && analysis.confidence >= 0.55 ?
    (document && vehicle ? "document_vehicle" : analysis.imageKind) : "other";
  return {
    kind,
    analysisPending: false,
    analysisFailed: outcome.failed,
    analysisRetryable: outcome.failed && outcome.retryable !== false,
    analysis: analysis || null,
  };
}

/**
 * Fills missing evidence without erasing successful OCR or typed corrections.
 * @param {Object} current Persisted aggregate.
 * @param {Object} incoming New evidence.
 * @return {Object}
 */
function mergeVisitorEvidence(current, incoming) {
  const next = {...(current || {})};
  Object.entries(incoming || {}).forEach(([key, value]) => {
    if ((next[key] == null || next[key] === "" || next[key] === "unknown") &&
        value != null) next[key] = value;
  });
  return next;
}

module.exports = {
  analyzeVisitorImageWithRetry,
  canRetryVisitorImage,
  mergeVisitorEvidence,
  nextVisitorOcrRetryAt,
  visitorImageAnalysisPatch,
  visitorTimestampMs,
};
