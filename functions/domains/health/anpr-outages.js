"use strict";

const RETENTION_MS = 35 * 24 * 60 * 60 * 1000;

/**
 * Keeps confirmed outage windows open until a genuinely newer ANPR event.
 * Quiet roads never open or close a window on their own.
 * @param {Object} previous Persisted camera status.
 * @param {Object} observation Current probe and event evidence.
 * @return {Object} Fields to merge into the camera status document.
 */
function nextAnprOutageState(previous, observation) {
  const {nowEpoch, lastEventEpoch, eventStale, physicalFailure,
    probeOk} = observation;
  let activeAnprOutage = previous.activeAnprOutage || null;
  const anprOutageWindows = (previous.anprOutageWindows || [])
      .filter((window) => window.endEpoch > nowEpoch - RETENTION_MS);
  if (activeAnprOutage && probeOk &&
      lastEventEpoch > activeAnprOutage.lastEventEpoch &&
      lastEventEpoch >= activeAnprOutage.startEpoch) {
    anprOutageWindows.push({...activeAnprOutage, endEpoch: lastEventEpoch});
    activeAnprOutage = null;
  }
  if (!activeAnprOutage && (eventStale || physicalFailure)) {
    activeAnprOutage = {
      startEpoch: eventStale && lastEventEpoch ? lastEventEpoch :
        Number(previous.physicalFailureSinceEpoch || nowEpoch),
      lastEventEpoch,
      detectedEpoch: nowEpoch,
    };
  }
  return {
    activeAnprOutage,
    anprOutageWindows: anprOutageWindows.slice(-256),
  };
}

/**
 * Reads bounded outage history plus any active outage overlapping a shift.
 * @param {Object[]} statuses Camera status documents.
 * @param {Object} range Report epoch range.
 * @return {Object[]} Outage windows overlapping the report.
 */
function auditOutageWindows(statuses, range) {
  return statuses.flatMap((status) => {
    const windows = [...(status.anprOutageWindows || [])];
    if (status.activeAnprOutage) {
      windows.push({...status.activeAnprOutage, endEpoch: Infinity});
    }
    return windows;
  }).filter((window) => window.startEpoch < range.endEpoch &&
    window.endEpoch > range.startEpoch);
}

/**
 * Grants the guard the benefit of the doubt only for captures in outages.
 * A healthy unmatched car stays in the unchecked list.
 * @param {Object} row Aggregated traffic row.
 * @param {Object[]} windows Confirmed outage windows for either camera.
 * @return {boolean}
 */
function isOutageAffectedCar(row, windows) {
  const epochs = row.eventEpochs || [row.firstEpoch];
  return epochs.some((epoch) => Number.isFinite(epoch) &&
    windows.some((window) => epoch >= window.startEpoch &&
      epoch < window.endEpoch));
}

module.exports = {
  auditOutageWindows,
  isOutageAffectedCar,
  nextAnprOutageState,
};
