"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {
  accumulatePeerEvents,
  anprEventStatus,
  heartbeatStatus,
  lineMessagingStatus,
  overallStatus,
  probeStatus,
} = require("../domains/health/status-policy");

test("peer accumulator resets after this camera sends an event", () => {
  assert.equal(accumulatePeerEvents({
    lastEventEpoch: 200,
    observedLastEventEpoch: 100,
    peerEventSequence: 20,
    observedPeerEventSequence: 10,
    previousPeerEvents: 5,
  }), 0);
});

test("peer activity accumulator adds only new peer events", () => {
  assert.equal(accumulatePeerEvents({
    lastEventEpoch: 100,
    observedLastEventEpoch: 100,
    peerEventSequence: 14,
    observedPeerEventSequence: 10,
    previousPeerEvents: 3,
  }), 7);
});

test("ANPR freshness ignores quiet roads and requires peer activity", () => {
  const now = 10 * 60 * 60 * 1000;
  const stale = now - 3 * 60 * 60 * 1000;
  assert.equal(anprEventStatus({
    nowEpoch: now,
    lastEventEpoch: stale,
    peerLastEventEpoch: now - 10 * 60 * 1000,
    peerEventsSince: 4,
  }), "unknown");
  assert.equal(anprEventStatus({
    nowEpoch: now,
    lastEventEpoch: stale,
    peerLastEventEpoch: now - 40 * 60 * 1000,
    peerEventsSince: 8,
  }), "unknown");
});

test("ANPR freshness warns and escalates when the peer stays active", () => {
  const now = 10 * 60 * 60 * 1000;
  const activePeer = now - 5 * 60 * 1000;
  assert.equal(anprEventStatus({
    nowEpoch: now,
    lastEventEpoch: now - 90 * 60 * 1000,
    peerLastEventEpoch: activePeer,
    peerEventsSince: 6,
  }), "warning");
  assert.equal(anprEventStatus({
    nowEpoch: now,
    lastEventEpoch: now - 5 * 60 * 60 * 1000,
    peerLastEventEpoch: activePeer,
    peerEventsSince: 6,
  }), "offline");
});

test("ANPR freshness stays online while this camera is recent", () => {
  const now = 10 * 60 * 60 * 1000;
  assert.equal(anprEventStatus({
    nowEpoch: now,
    lastEventEpoch: now - 20 * 60 * 1000,
    peerLastEventEpoch: now - 5 * 60 * 1000,
    peerEventsSince: 10,
  }), "online");
});

test("probe status tolerates two transient failures", () => {
  assert.equal(probeStatus(true, 9), "online");
  assert.equal(probeStatus(false, 1), "warning");
  assert.equal(probeStatus(false, 2), "warning");
  assert.equal(probeStatus(false, 3), "offline");
});

test("heartbeat status uses warning and offline thresholds", () => {
  const now = 1000000;
  assert.equal(heartbeatStatus(0, now, 10000, 20000), "unknown");
  assert.equal(heartbeatStatus(now - 5000, now, 10000, 20000), "online");
  assert.equal(heartbeatStatus(now - 15000, now, 10000, 20000),
      "warning");
  assert.equal(heartbeatStatus(now - 25000, now, 10000, 20000),
      "offline");
});

test("overall status reports the most serious child", () => {
  assert.equal(overallStatus(["online", "online"]), "online");
  assert.equal(overallStatus(["online", "warning"]), "warning");
  assert.equal(overallStatus(["online", "offline"]), "offline");
  assert.equal(overallStatus(["online", "unknown"]), "unknown");
});

test("LINE incident reports Messaging API as offline", () => {
  assert.equal(lineMessagingStatus({
    hasIncident: true,
    statusPageOk: true,
    botApiOk: true,
    webhookApiOk: true,
    webhookActive: true,
  }), "offline");
});

test("LINE status is online only when every probe is healthy", () => {
  const healthy = {
    statusPageOk: true,
    botApiOk: true,
    webhookApiOk: true,
    webhookActive: true,
  };
  assert.equal(lineMessagingStatus(healthy), "online");
  assert.equal(lineMessagingStatus({...healthy, statusPageOk: false}),
      "warning");
  assert.equal(lineMessagingStatus({...healthy, botApiOk: false}), "warning");
  assert.equal(lineMessagingStatus({...healthy, webhookApiOk: false}),
      "warning");
  assert.equal(lineMessagingStatus({...healthy, webhookActive: false}),
      "warning");
});

test("LINE monitoring is warning while a confirmed outage is offline", () => {
  const healthy = {
    statusPageOk: true,
    botApiOk: true,
    webhookApiOk: true,
    webhookActive: true,
  };
  assert.equal(lineMessagingStatus({...healthy, isMonitoring: true}),
      "warning");
  assert.equal(lineMessagingStatus({...healthy, hasIncident: true}),
      "offline");
  assert.equal(lineMessagingStatus({
    ...healthy,
    botApiOk: false,
    webhookApiOk: false,
  }), "offline");
});


test("ANPR warns at one hour and escalates at two hours", () => {
  const now = 10 * 3600000;
  const input = {nowEpoch: now, peerLastEventEpoch: now, peerEventsSince: 5};
  assert.equal(anprEventStatus({...input,
    lastEventEpoch: now - 3599999}), "online");
  assert.equal(anprEventStatus({...input,
    lastEventEpoch: now - 3600000}), "warning");
  assert.equal(anprEventStatus({...input,
    lastEventEpoch: now - 7200000}), "offline");
});
