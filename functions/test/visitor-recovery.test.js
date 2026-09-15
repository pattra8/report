"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const {
  recoverVisitorIntakeOcr,
  resolveVisitorIntakeLogId,
  buildVisitorIntakeReply,
  shouldReplyVisitorIntakeNow,
} = require("../index").__visitorTest;
const {
  canRetryVisitorImage,
  mergeVisitorEvidence,
  nextVisitorOcrRetryAt,
} = require("../domains/visitors/image-analysis");
const Timestamp = admin.firestore.Timestamp;
const FieldValue = admin.firestore.FieldValue;

/**
 * Minimal serialized Firestore transaction double; applies writes at commit.
 * @param {Object} initial Synthetic document map.
 * @return {Object}
 */
function memoryStore(initial) {
  const docs = new Map(Object.entries(initial));
  let tail = Promise.resolve();
  let ids = 0;
  const store = {
    docs,
    collection: (name) => ({doc: (id = `auto-${++ids}`) => ({
      path: `${name}/${id}`, id,
    })}),
    runTransaction: (fn) => {
      const run = tail.then(async () => {
        const writes = [];
        const tx = {
          get: async (ref) => ({exists: docs.has(ref.path),
            data: () => docs.get(ref.path)}),
          update: (ref, patch) => writes.push([ref, patch]),
          set: (ref, patch) => writes.push([ref, patch]),
        };
        const result = await fn(tx);
        for (const [ref, patch] of writes) {
          const next = {...docs.get(ref.path)};
          for (const [key, value] of Object.entries(patch)) {
            if (value instanceof FieldValue &&
                value.isEqual(FieldValue.delete())) delete next[key];
            else if (value instanceof FieldValue &&
                value.isEqual(FieldValue.serverTimestamp())) {
              next[key] = Timestamp.now();
            } else next[key] = value;
          }
          docs.set(ref.path, next);
        }
        return result;
      });
      tail = run.catch(() => {});
      return run;
    },
  };
  return store;
}

/**
 * Synthetic visitor fixture, never based on a production record.
 * @param {Object} patch Optional overrides.
 * @return {Object}
 */
function record(patch = {}) {
  return {
    houseNo: "38/1", purposeText: "test delivery", status: "partial",
    createdAt: Timestamp.fromMillis(1000),
    updatedAt: Timestamp.fromMillis(2000),
    ocrRetryAt: Timestamp.fromMillis(Date.now() - 1000),
    ocr: {personName: "Synthetic Visitor", documentNumber: "TEST"},
    images: [{messageId: "photo-a", storagePath: "synthetic/photo-a.jpg",
      kind: "other", analysis: null, analysisFailed: true,
      analysisAttempts: 3,
      expiresAt: Timestamp.fromMillis(Date.now() + 86400000),
      downloadToken: "synthetic-token"}],
    ...patch,
  };
}
const vehicle = {imageKind: "vehicle", vehiclePlate: "กข 1234",
  vehicleType: "motorcycle", confidence: 0.95};

/**
 * Runs one recovery against an in-memory store.
 * @param {Object} data Fixture.
 * @param {Function} analyze Fake OCR.
 * @return {Promise<Object>}
 */
async function recover(data, analyze = async () => vehicle) {
  const path = "visitor_intake_logs/test";
  const store = memoryStore({[path]: data});
  const ref = store.collection("visitor_intake_logs").doc("test");
  const result = await recoverVisitorIntakeOcr(
      ref, Date.now(), {store, analyze});
  return {result, data: store.docs.get(path), store, ref};
}

test("recovery restores evidence and retains original metadata", async () => {
  const before = record();
  const {result, data} = await recover(before);
  assert.equal(result, true);
  assert.equal(data.status, "complete");
  assert.equal(data.vehicleCapture.plateText, "กข 1234");
  assert.deepEqual(data.ocr, before.ocr);
  for (const key of ["houseNo", "purposeText", "createdAt", "updatedAt"]) {
    assert.deepEqual(data[key], before[key]);
  }
  assert.equal(data.images.length, 1);
  assert.equal(data.images[0].downloadToken, "synthetic-token");
  assert.equal(data.images[0].analysisAttempts, 4);
  assert.equal(data.images[0].analysisPending, false);
  assert.equal(data.ocrRetryAt, undefined);
  assert.equal(data.ocrRecoveryLease, undefined);
  assert.ok(data.ocrRecoveredAt);
});

test("outages retry within the attempt budget", async () => {
  for (const attempts of [3, 8]) {
    const before = record();
    before.images[0].analysisAttempts = attempts;
    const {data} = await recover(before, async () => {
      throw Object.assign(new Error("Synthetic outage"), {status: 503});
    });
    assert.equal(data.images[0].analysisAttempts, attempts + 1);
    assert.equal(data.images[0].analysisPending, false);
    assert.equal(data.images[0].analysisFailed, true);
    assert.equal(!!data.ocrRetryAt, attempts < 8);
    assert.equal(data.ocrRecoveredAt, undefined);
  }
});

test("recovery skips unavailable or analyzed images", async () => {
  for (const patch of [{imagesPurged: true}, {images: []}, {
    images: [{...record().images[0], analysis: vehicle}],
  }, {
    images: [{...record().images[0], expiresAt: Timestamp.fromMillis(1)}],
  }, {
    images: [{...record().images[0], analysisRetryable: false}],
  }]) {
    const {result, data} = await recover(record(patch), async () => {
      assert.fail("OCR should not run");
    });
    assert.equal(result, false);
    assert.equal(data.ocrRetryAt, undefined);
  }
});

test("a recovery lease prevents overlapping scheduler calls", async () => {
  const store = memoryStore({"visitor_intake_logs/test": record()});
  const ref = store.collection("visitor_intake_logs").doc("test");
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const analyze = async () => {
    calls += 1;
    await blocked;
    return vehicle;
  };
  const first = recoverVisitorIntakeOcr(ref, Date.now(), {store, analyze});
  const second = recoverVisitorIntakeOcr(ref, Date.now(), {store, analyze});
  assert.equal(await second, false);
  release();
  assert.equal(await first, true);
  assert.equal(calls, 1);
});

test("recovery preserves concurrent corrections", async () => {
  const path = "visitor_intake_logs/test";
  const store = memoryStore({[path]: record()});
  const ref = store.collection("visitor_intake_logs").doc("test");
  await recoverVisitorIntakeOcr(ref, Date.now(), {store, analyze: async () => {
    store.docs.set(path, {...store.docs.get(path),
      vehicleCapture: {plateText: "MANUAL", source: "typed_text"}});
    return vehicle;
  }});
  assert.equal(store.docs.get(path).vehicleCapture.plateText, "MANUAL");
  assert.equal(store.docs.get(path).vehicleCapture.source, "typed_text");
});

test("deleted or moved images are not resurrected by recovery", async () => {
  for (const deleted of [false, true]) {
    const path = "visitor_intake_logs/test";
    const store = memoryStore({[path]: record()});
    const ref = store.collection("visitor_intake_logs").doc("test");
    const result = await recoverVisitorIntakeOcr(ref, Date.now(), {
      store, analyze: async () => {
        if (deleted) store.docs.delete(path);
        else store.docs.set(path, {...store.docs.get(path), images: []});
        return vehicle;
      },
    });
    assert.equal(result, false);
    if (deleted) assert.equal(store.docs.has(path), false);
    else assert.deepEqual(store.docs.get(path).images, []);
  }
});

test("late replay retains its original record", async () => {
  const store = memoryStore({
    "line_webhook_events/event-a": {visitorLogId: "original"},
  });
  const id = await resolveVisitorIntakeLogId({userId: "test-user"}, Date.now(),
      {houseNo: "38/2", purposeText: "new visit"},
      {eventId: "event-a", isImage: true, store});
  assert.equal(id, "original");
  assert.equal(store.docs.size, 1);
});

test("first event atomically binds its assigned visitor record", async () => {
  const store = memoryStore({
    "line_webhook_events/event-a": {status: "queued"},
  });
  const source = {type: "group", groupId: "test-group", userId: "test-user"};
  const id = await resolveVisitorIntakeLogId(source, Date.now(), null,
      {eventId: "event-a", isImage: true, store});
  assert.equal(store.docs.get("line_webhook_events/event-a").visitorLogId, id);
  const replay = await resolveVisitorIntakeLogId(source, Date.now() + 600000,
      null, {eventId: "event-a", isImage: true, store});
  assert.equal(replay, id);
});

test("missing OCR is not confused with a missing physical photo", () => {
  const data = record();
  const reply = buildVisitorIntakeReply(data);
  assert.match(reply, /ระบบกำลังอ่านข้อมูล/);
  assert.doesNotMatch(reply, /ส่งใหม่|อ่านไม่ชัด/);
  const merged = {...data, images: [{kind: "pending", analysisPending: true}]};
  assert.equal(shouldReplyVisitorIntakeNow({}, merged,
      {houseNo: "38/1"}, "test"), false);
});

test("recovery budgets and conservative merging", () => {
  const now = Date.now();
  const image = record().images[0];
  assert.equal(canRetryVisitorImage(
      {...image, analysisAttempts: 9}, now), false);
  assert.equal(nextVisitorOcrRetryAt(
      [{...image, analysisAttempts: 9}], now), null);
  assert.ok(nextVisitorOcrRetryAt([image], now) > now + 240000);
  assert.deepEqual(mergeVisitorEvidence(
      {personName: "Kept", documentNumber: ""},
      {personName: "Other", documentNumber: "TEST"}),
  {personName: "Kept", documentNumber: "TEST"});
});

test("a crashed final attempt is made terminal instead of pending forever",
    async () => {
      const before = record();
      before.images[0].analysisAttempts = 9;
      before.images[0].analysisPending = true;
      const {result, data} = await recover(before, async () => {
        assert.fail("Attempt budget exhausted");
      });
      assert.equal(result, false);
      assert.equal(data.images[0].analysisPending, false);
      assert.equal(data.images[0].analysisFailed, true);
      assert.equal(data.ocrRetryAt, undefined);
    });

test("permanent OCR errors stop without requeueing", async () => {
  const {data} = await recover(record(), async () => {
    throw Object.assign(new Error("Synthetic denied request"), {status: 403});
  });
  assert.equal(data.images[0].analysisRetryable, false);
  assert.equal(data.images[0].analysisFailed, true);
  assert.equal(data.ocrRetryAt, undefined);
});

test("recovery retains document numbers without names", async () => {
  const {data} = await recover(record({ocr: null,
    vehicleCapture: {plateText: "กข 1234"}}), async () => ({
    imageKind: "document", documentNumber: "TEST1234", confidence: 0.95,
  }));
  assert.equal(data.ocr.documentNumber, "TEST1234");
  assert.equal(data.status, "complete");
});
