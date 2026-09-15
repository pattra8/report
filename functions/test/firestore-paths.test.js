"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");

const paths = require("../platform/firestore-paths");

test("Firestore path registry is immutable and contains unique values", () => {
  const values = Object.values(paths);
  assert.equal(Object.isFrozen(paths), true);
  assert.equal(new Set(values).size, values.length);
});

test("configuration paths and collection names use distinct shapes", () => {
  for (const [name, value] of Object.entries(paths)) {
    assert.equal(typeof value, "string");
    assert.notEqual(value, "");
    if (name.endsWith("_CONFIG_PATH")) {
      assert.match(value, /^system_config\/[a-z0-9_]+$/);
    } else {
      assert.doesNotMatch(value, /\//);
    }
  }
});

