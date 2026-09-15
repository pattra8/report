"use strict";

/**
 * Converts a live probe and its failure streak into a stable UI status.
 * @param {boolean} ok
 * @param {number} consecutiveFailures
 * @return {"online"|"warning"|"offline"}
 */
function probeStatus(ok, consecutiveFailures = 0) {
  if (ok) return "online";
  return Number(consecutiveFailures || 0) >= 3 ? "offline" : "warning";
}

/**
 * Detects a likely stuck ANPR event pipeline without treating quiet traffic as
 * an outage. A camera is stale only when its peer is still actively producing
 * events and enough peer events have arrived since this camera's last event.
 * @param {Object} input
 * @param {number} input.nowEpoch
 * @param {number} input.lastEventEpoch
 * @param {number} input.peerLastEventEpoch
 * @param {number} input.peerEventsSince
 * @param {number} input.warningAfterMs
 * @param {number} input.offlineAfterMs
 * @param {number} input.peerActiveWithinMs
 * @param {number} input.minimumPeerEvents
 * @return {"online"|"warning"|"offline"|"unknown"}
 */
function anprEventStatus({
  nowEpoch = Date.now(),
  lastEventEpoch = 0,
  peerLastEventEpoch = 0,
  peerEventsSince = 0,
  warningAfterMs = 2 * 60 * 60 * 1000,
  offlineAfterMs = 4 * 60 * 60 * 1000,
  peerActiveWithinMs = 30 * 60 * 1000,
  minimumPeerEvents = 5,
} = {}) {
  const now = Number(nowEpoch || Date.now());
  const last = Number(lastEventEpoch || 0);
  const peerLast = Number(peerLastEventEpoch || 0);
  if (!last || !peerLast) return "unknown";
  const age = Math.max(0, now - last);
  if (age < warningAfterMs) return "online";
  const peerAge = Math.max(0, now - peerLast);
  if (peerAge > peerActiveWithinMs ||
      Number(peerEventsSince || 0) < minimumPeerEvents) {
    return "unknown";
  }
  return age >= offlineAfterMs ? "offline" : "warning";
}

/**
 * Accumulates peer-camera activity while this camera's event heartbeat is
 * unchanged. Sequence counters let the health probe avoid rescanning traffic
 * event documents on every run.
 * @param {Object} input
 * @return {number}
 */
function accumulatePeerEvents({
  lastEventEpoch = 0,
  observedLastEventEpoch = 0,
  peerEventSequence = 0,
  observedPeerEventSequence = 0,
  previousPeerEvents = 0,
} = {}) {
  if (Number(lastEventEpoch || 0) > Number(observedLastEventEpoch || 0)) {
    return 0;
  }
  const delta = Math.max(0,
      Number(peerEventSequence || 0) -
      Number(observedPeerEventSequence || 0));
  return Number(previousPeerEvents || 0) + delta;
}

/**
 * Converts a scheduler heartbeat into a stable UI status.
 * @param {number} lastRunEpoch
 * @param {number} nowEpoch
 * @param {number} warningAfterMs
 * @param {number} offlineAfterMs
 * @return {"online"|"warning"|"offline"|"unknown"}
 */
function heartbeatStatus(lastRunEpoch, nowEpoch, warningAfterMs,
    offlineAfterMs) {
  const last = Number(lastRunEpoch || 0);
  if (!last) return "unknown";
  const age = Math.max(0, Number(nowEpoch || Date.now()) - last);
  if (age >= offlineAfterMs) return "offline";
  if (age >= warningAfterMs) return "warning";
  return "online";
}

/**
 * Returns one overall state, weighted by the most serious child state.
 * @param {string[]} statuses
 * @return {"online"|"warning"|"offline"|"unknown"}
 */
function overallStatus(statuses = []) {
  if (statuses.includes("offline")) return "offline";
  if (statuses.includes("warning")) return "warning";
  if (statuses.length && statuses.every((value) => value === "online")) {
    return "online";
  }
  return "unknown";
}

/**
 * Combines LINE's official incident feed with live OA API probes.
 * @param {Object} input
 * @param {boolean} input.hasIncident
 * @param {boolean} input.isMonitoring
 * @param {boolean} input.statusPageOk
 * @param {boolean} input.botApiOk
 * @param {boolean} input.webhookApiOk
 * @param {boolean} input.webhookActive
 * @return {"online"|"warning"|"offline"}
 */
function lineMessagingStatus({
  hasIncident = false,
  isMonitoring = false,
  statusPageOk = false,
  botApiOk = false,
  webhookApiOk = false,
  webhookActive = false,
} = {}) {
  if (hasIncident) return "offline";
  if (!botApiOk && !webhookApiOk) return "offline";
  if (isMonitoring) return "warning";
  if (!statusPageOk || !botApiOk || !webhookApiOk || !webhookActive) {
    return "warning";
  }
  return "online";
}

module.exports = {
  accumulatePeerEvents,
  anprEventStatus,
  heartbeatStatus,
  lineMessagingStatus,
  overallStatus,
  probeStatus,
};
