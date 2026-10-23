"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
const start = source.indexOf("async function sendAgentCShadowAlert(");
const alertSource = source.slice(start, source.indexOf("\n/**", start));

/**
 * Runs the actual sender with isolated Firestore and LINE boundaries.
 * @return {Object}
 */
function senderFixture() {
  const records = new Map();
  const sent = [];
  let fail = false;
  const ref = (id) => ({id, set: async (patch) => {
    records.set(id, {...records.get(id), ...patch});
  }});
  const context = vm.createContext({
    Date,
    db: {
      doc: () => ({get: async () => ({exists: true, data: () => ({
        enabled: false, backlogMonitorEnabled: false,
        shadowMode: false, testTargetId: "some-other-group",
      })})}),
      collection: () => ({doc: ref}),
      runTransaction: async (run) => run({
        get: async (doc) => ({exists: records.has(doc.id),
          data: () => records.get(doc.id)}),
        set: (doc, patch) => records.set(doc.id,
            {...records.get(doc.id), ...patch}),
      }),
    },
    admin: {firestore: {
      FieldValue: {increment: () => 1, serverTimestamp: () => 1},
      Timestamp: {fromMillis: (epoch) => ({toMillis: () => epoch})},
    }},
    LPR_AGENT_C_CONFIG_PATH: "config",
    LPR_AGENT_C_TEST_TARGET_ID: "pattra-watch",
    LPR_AGENT_C_ALERTS_COLLECTION: "alerts",
    vehicleProfileDocId: (id) => id,
    resolveLineTarget: async (target) => assert.equal(target, "pattra-watch"),
    sendLinePushMessages: async (target, messages) => {
      if (fail) throw new Error("synthetic LINE failure");
      sent.push({target, messages});
    },
  });
  vm.runInContext(alertSource, context);
  return {send: context.sendAgentCShadowAlert, sent,
    setFailure: (value) => {
      fail = value;
    }};
}

test("health alerts use Pattra Watch even when AI monitoring is disabled",
    async () => {
      const fixture = senderFixture();
      assert.equal(await fixture.send("incident-warning", "WARNING",
          "ANPR เงียบ", true), true);
      assert.equal(await fixture.send("incident-warning", "WARNING",
          "ANPR เงียบ", true), false);
      assert.equal(fixture.sent.length, 1);
      assert.equal(fixture.sent[0].target, "pattra-watch");
      assert.equal(await fixture.send("incident-critical", "CRITICAL",
          "ANPR เงียบ", true), true);
      assert.equal(fixture.sent.length, 2);
      assert.equal(await fixture.send("AI", "WARNING", "test"), false);
    });

test("failed LINE pushes can retry on the next probe", async () => {
  const fixture = senderFixture();
  fixture.setFailure(true);
  await assert.rejects(fixture.send("incident", "WARNING", "test", true),
      /synthetic LINE failure/);
  fixture.setFailure(false);
  assert.equal(await fixture.send("incident", "WARNING", "test", true), true);
  assert.equal(fixture.sent.length, 1);
});
