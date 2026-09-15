"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {
  analyzeVisitorImageWithRetry,
} = require("../domains/visitors/image-analysis");

test("OCR retries the same operation after a timeout", async () => {
  let calls = 0;
  const failures = [];
  const analysis = {imageKind: "vehicle", vehiclePlate: "TEST 1234"};
  const result = await analyzeVisitorImageWithRetry(async () => {
    calls += 1;
    if (calls === 1) throw new DOMException("Timed out", "TimeoutError");
    return analysis;
  }, (error, attempt) => failures.push([error.name, attempt]));
  assert.deepEqual(result, {analysis, attempts: 2, failed: false});
  assert.deepEqual(failures, [["TimeoutError", 1]]);
});

test("OCR bounds outages and records failure", async () => {
  let calls = 0;
  const result = await analyzeVisitorImageWithRetry(async () => {
    calls += 1;
    throw Object.assign(new Error("Unavailable"), {status: 503});
  });
  assert.equal(calls, 3);
  assert.deepEqual(result, {analysis: null, attempts: 3, failed: true,
    retryable: true});
});

test("OCR retries 429 but stops on permanent errors", async () => {
  for (const status of [400, 401, 403, 404, 429]) {
    let calls = 0;
    const result = await analyzeVisitorImageWithRetry(async () => {
      calls += 1;
      throw Object.assign(new Error("Request failed"), {status});
    });
    assert.equal(calls, status === 429 ? 3 : 1);
    assert.equal(result.failed, true);
  }
});

test("low confidence is not a transport failure", async () => {
  const analysis = {imageKind: "other", confidence: 0.1};
  assert.deepEqual(await analyzeVisitorImageWithRetry(async () => analysis), {
    analysis, attempts: 1, failed: false,
  });
});

test("concurrent calls retain independent results", async () => {
  const document = {imageKind: "document", personName: "Test Visitor"};
  const vehicle = {imageKind: "vehicle", vehiclePlate: "TEST 5678"};
  let calls = 0;
  const results = await Promise.all([
    analyzeVisitorImageWithRetry(async () => document),
    analyzeVisitorImageWithRetry(async () => {
      if (++calls < 3) throw new Error("Network timeout");
      return vehicle;
    }),
  ]);
  assert.deepEqual(results.map((r) => r.analysis), [document, vehicle]);
  assert.deepEqual(results.map((r) => r.attempts), [1, 3]);
});
