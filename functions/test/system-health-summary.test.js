"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const policy = require("../domains/health/status-policy");
const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
const start = source.indexOf("async function buildSystemHealthSummary()");
const summarySource = source.slice(start, source.indexOf("\n/**", start));

/**
 * Exercises the dashboard response with cached production-shaped probes.
 * @param {Object} camera Cached exit probe.
 * @param {Object} reboot Optional reboot state.
 * @return {Promise<Object>} Dashboard summary.
 */
async function summaryFor(camera, reboot = {}) {
  const now = Date.now();
  const state = {
    cameras: {
      "8241": {ok: true, apiOk: true, snapshotOk: true},
      "8242": camera,
      "nvr": {ok: true, status: "online"},
    },
    lineMessaging: {status: "online"},
    firestore: {status: "online"},
    storage: {status: "online"},
    imageSync: {lastRunEpoch: now},
  };
  const emptyQuery = {
    orderBy: () => emptyQuery,
    limit: () => emptyQuery,
    get: async () => ({empty: true}),
    doc: (id) => ({id}),
  };
  const context = vm.createContext({
    ...policy,
    Date,
    SYSTEM_HEALTH_CONFIG_PATH: "state",
    SYSTEM_HEALTH_REBOOTS_COLLECTION: "reboots",
    LPR_DAILY_TRAFFIC_COLLECTION: "daily",
    LPR_OVERNIGHT_COLLECTION: "night",
    systemHealthEpoch: (value) => Number(value || 0),
    db: {
      doc: () => ({get: async () => ({exists: true, data: () => state})}),
      collection: () => emptyQuery,
      getAll: async (...refs) => refs.map((ref) => ({
        id: ref.id, exists: true,
        data: () => ref.id === "8242" ? reboot : {},
      })),
    },
  });
  vm.runInContext(summarySource, context);
  return context.buildSystemHealthSummary();
}

test("silent ANPR does not mark a responding camera or dashboard offline",
    async () => {
      for (const eventStatus of ["warning", "offline", "unknown"]) {
        const summary = await summaryFor({
          ok: true, apiOk: true, snapshotOk: true,
          status: "offline", eventStatus, peerEventsSince: 9,
          lastAnprEventEpoch: Date.now() - 3 * 3600000,
        });
        assert.equal(summary.cameras[1].status, "online");
        assert.equal(summary.cameras[1].eventStatus, eventStatus);
        assert.equal(summary.overallStatus, "online");
      }
    });

test("real probe failures still warn and escalate to offline", async () => {
  for (const [failures, expected] of [[1, "warning"], [3, "offline"]]) {
    const summary = await summaryFor({
      ok: false, consecutiveFailures: failures, eventStatus: "online",
    });
    assert.equal(summary.cameras[1].status, expected);
    assert.equal(summary.overallStatus, expected);
  }
});

test("unprobed cameras stay unknown and recent reboots remain visible",
    async () => {
      assert.equal((await summaryFor({})).cameras[1].status, "unknown");
      const summary = await summaryFor({ok: true}, {
        status: "rebooting", requestedEpoch: Date.now(),
      });
      assert.equal(summary.cameras[1].status, "rebooting");
      assert.equal(summary.overallStatus, "warning");
    });
