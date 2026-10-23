"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {nextAnprOutageState, auditOutageWindows, isOutageAffectedCar} =
  require("../domains/health/anpr-outages");

test("quiet roads do not create an outage", () => {
  assert.equal(nextAnprOutageState({}, {
    nowEpoch: 10000, lastEventEpoch: 100, probeOk: true,
  }).activeAnprOutage, null);
});

test("confirmed stale events open a window from the last real capture", () => {
  const state = nextAnprOutageState({}, {
    nowEpoch: 10000, lastEventEpoch: 100, eventStale: true, probeOk: true,
  });
  assert.equal(state.activeAnprOutage.startEpoch, 100);
  const quiet = nextAnprOutageState(state, {
    nowEpoch: 20000, lastEventEpoch: 100, probeOk: true,
  });
  assert.deepEqual(quiet.activeAnprOutage, state.activeAnprOutage);
  const recovered = nextAnprOutageState(quiet, {
    nowEpoch: 30000, lastEventEpoch: 25000, probeOk: true,
  });
  assert.equal(recovered.activeAnprOutage, null);
  assert.equal(recovered.anprOutageWindows[0].endEpoch, 25000);
});

test("physical outage needs a new event after probe recovery", () => {
  const state = nextAnprOutageState({physicalFailureSinceEpoch: 1000}, {
    nowEpoch: 5000, lastEventEpoch: 100, physicalFailure: true,
    probeOk: false,
  });
  assert.equal(state.activeAnprOutage.startEpoch, 1000);
  const stillDown = nextAnprOutageState(state, {
    nowEpoch: 6000, lastEventEpoch: 5500, probeOk: false,
  });
  assert.ok(stillDown.activeAnprOutage);
  assert.equal(nextAnprOutageState(stillDown, {
    nowEpoch: 7000, lastEventEpoch: 5500, probeOk: true,
  }).activeAnprOutage, null);
});

test("historical windows only forgive overlapping shifts", () => {
  const windows = auditOutageWindows([{anprOutageWindows: [
    {startEpoch: 10, endEpoch: 25}, {startEpoch: 60, endEpoch: 70},
  ]}], {startEpoch: 20, endEpoch: 50});
  assert.equal(windows.length, 1);
  assert.equal(isOutageAffectedCar({firstEpoch: 24}, windows), true);
  assert.equal(isOutageAffectedCar({firstEpoch: 25}, windows), false);
  assert.equal(isOutageAffectedCar({firstEpoch: NaN}, windows), false);
});
