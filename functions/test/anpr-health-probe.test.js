"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {accumulatePeerEvents, anprEventStatus} =
  require("../domains/health/status-policy");
const {nextAnprOutageState} = require("../domains/health/anpr-outages");
const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
const start = source.indexOf("async function runAgentCHealthProbe()");
const probeSource = source.slice(start, source.indexOf("\n/**", start));

test("probe records exit outage, preserves it on quiet roads, then recovers",
    async () => {
      const now = 100 * 3600000;
      const statuses = {
        "8241": {lastCaptureAtEpoch: now - 60000, eventSequence: 20},
        "8242": {
          lastCaptureAtEpoch: now - 90 * 60000,
          observedLastEventEpoch: now - 90 * 60000,
          observedPeerEventSequence: 20,
          peerEventsWhileStale: 8,
          consecutiveEventStale: 2,
        },
        "nvr": {},
      };
      const alerts = [];
      const ref = (id) => ({id, set: async (patch) => {
        statuses[id] = {...statuses[id], ...patch};
      }});
      /** Fixed probe time for the synthetic incident. */
      class Clock extends Date {
        /** @return {number} Probe epoch. */
        static now() {
          return now;
        }
      }
      const context = vm.createContext({
        Date: Clock,
        db: {
          collection: () => ({doc: ref}),
          getAll: async (...refs) => refs.map((doc) => ({id: doc.id,
            exists: true, data: () => ({...statuses[doc.id]})})),
        },
        admin: {firestore: {FieldValue: {serverTimestamp: () => now}}},
        LPR_AGENT_C_STATUS_COLLECTION: "test-status",
        LPR_CAMERAS: ["https://test:8241", "https://test:8242"],
        hikvisionFetch: async () => ({status: 200}),
        hikvisionFetchBinary: async () => ({status: 200, bytes: 2000}),
        nvrFetch: async () => ({status: 200, ok: true}),
        sendAgentCShadowAlert: async (...args) => alerts.push(args),
        accumulatePeerEvents,
        anprEventStatus,
        nextAnprOutageState,
      });
      vm.runInContext(probeSource, context);
      await context.runAgentCHealthProbe();
      assert.equal(statuses["8242"].eventStatus, "warning");
      assert.equal(statuses["8242"].activeAnprOutage.startEpoch,
          now - 90 * 60000);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0][3], true, "independent Pattra Watch alert");
      assert.ok(alerts[0][2].includes("รีบูตกล้องขาออก"));
      statuses["8241"].lastCaptureAtEpoch = now - 40 * 60000;
      await context.runAgentCHealthProbe();
      assert.equal(statuses["8242"].eventStatus, "unknown");
      assert.ok(statuses["8242"].activeAnprOutage);
      statuses["8242"].lastCaptureAtEpoch = now - 1000;
      await context.runAgentCHealthProbe();
      assert.equal(statuses["8242"].activeAnprOutage, null);
      assert.equal(statuses["8242"].anprOutageWindows.length, 1);
      assert.equal(alerts.length, 2);
      assert.equal(alerts[1][1], "RECOVERED");
      await context.runAgentCHealthProbe();
      assert.equal(alerts.length, 2, "recovery is only emitted once");
    });
