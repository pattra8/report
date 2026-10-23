"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  resolveLprPlate: resolveCameraPlate,
  lprSearchPlates: searchCameraPlates,
  lprCameraMappings,
} = require("../domains/lpr/plate-corrections");

const correctionRules = require("./fixtures/lpr-corrections");
const resolveLprPlate = (event, expected) =>
  resolveCameraPlate(event, expected, correctionRules);
const lprSearchPlates = (plate, expected) =>
  searchCameraPlates(plate, expected, correctionRules);

const expected = {
  plates: ["กข1000", "กค2000"],
  plateHouses: {"กข1000": ["38/90"], "กค2000": ["38/91"]},
};
const futureEpoch = Date.parse("2026-10-10T12:00:00+07:00");

test("device mappings stay scoped to camera and current authorized owner",
    () => {
      const entry = lprCameraMappings("8241", expected, correctionRules);
      const exit = lprCameraMappings("8242", expected, correctionRules);
      assert.equal(entry.length, 1);
      assert.deepEqual(entry[0],
          {detectPlateNo: "กจ2000", replacePlateNo: "กค2000"});
      // Quarantining a native rule must not erase reviewed report evidence.
      assert.equal(resolveLprPlate({plate: "8ก100", cameraId: "8241",
        direction: "entry", capturedAtEpoch: futureEpoch}, expected).plate,
      "กข1000");
      assert.equal(exit.length, 1);
      assert.deepEqual(exit[0],
          {detectPlateNo: "กจ2000", replacePlateNo: "กค2000"});
      assert.deepEqual(lprCameraMappings("8243", expected, correctionRules),
          []);
      const collision = {...expected, plates: [...expected.plates, "8ก100"]};
      assert.equal(lprCameraMappings("8241", collision, correctionRules)
          .length, 1);
      assert.deepEqual(lprCameraMappings("8241",
          {plates: [], plateHouses: {}}, correctionRules), []);
      assert.throws(() => lprCameraMappings("8241", expected, [
        {...correctionRules[0], nativeMapping: true},
        {...correctionRules[1], aliases: ["8ก100"]},
      ]), /Conflicting/);
    });

test("reviewed exact aliases resolve only on the configured camera", () => {
  for (const [alias, plate, cameraId, direction] of [
    ["ปก100", "กข1000", "8241", "entry"],
    ["8ก100", "กข1000", "8241", "entry"],
    ["กก100", "กข1000", "8241", "entry"],
    ["กจ2000", "กค2000", "8241", "entry"],
    ["กจ2000", "กค2000", "8242", "exit"],
  ]) {
    const input = {plate: alias, rawPlate: alias, cameraId, direction,
      capturedAtEpoch: futureEpoch, imagePath: "original-image.jpg"};
    const before = {...input};
    const result = resolveLprPlate(input, expected);
    assert.equal(result.plate, plate);
    assert.equal(result.reportedPlate, alias);
    assert.equal(result.rawPlate, alias);
    assert.equal(result.imagePath, input.imagePath);
    assert.equal(result.plateCorrection, "reviewed-camera-ocr");
    assert.deepEqual(input, before);
    assert.strictEqual(resolveLprPlate(result, expected), result);
  }
});

test("old events require reviewed IDs; similar or unrelated reads stay intact",
    () => {
      const input = {plate: "8ก100", cameraId: "8241", direction: "entry",
        capturedAtEpoch: Date.parse("2026-10-08T22:04:26+07:00")};
      assert.strictEqual(resolveLprPlate(input, expected), input);
      assert.equal(resolveLprPlate({...input,
        id: "reviewed-red-2",
      }, expected).plate, "กข1000");
      for (const change of [
        {plate: "8ก101"}, {cameraId: "8242"}, {direction: "exit"},
        {cameraId: "unknown"}, {plate: "5ขค3343"},
      ]) {
        const event = {...input, capturedAtEpoch: futureEpoch, ...change};
        assert.strictEqual(resolveLprPlate(event, expected), event);
      }
    });

test("registered aliases and changed or ambiguous ownership never remap",
    () => {
      const input = {plate: "กจ2000", cameraId: "8241", direction: "entry",
        capturedAtEpoch: futureEpoch};
      for (const registry of [
        {plates: ["กค2000", "กจ2000"],
          plateHouses: {...expected.plateHouses, "กจ2000": ["38/92"]}},
        {plates: [], plateHouses: {}},
        {plates: ["กค2000"], plateHouses: {"กค2000": ["38/92"]}},
        {plates: ["กค2000"], plateHouses: {"กค2000": ["38/91", "38/92"]}},
      ]) {
        assert.strictEqual(resolveLprPlate(input, registry), input);
      }
      assert.deepEqual(lprSearchPlates("กข1000", expected),
          ["กข1000", "ปก100", "8ก100", "กก100"]);
      const collision = {...expected, plates: [...expected.plates, "8ก100"]};
      assert.ok(!lprSearchPlates("กข1000", collision).includes("8ก100"));
    });

test("plate and house searches merge corrected history, filtering candidates",
    async () => {
      const source = fs.readFileSync(path.join(__dirname, "../index.js"),
          "utf8");
      const events = [
        {id: "canonical", plate: "กข1000", direction: "exit"},
        {id: "reviewed-red-2", plate: "8ก100",
          cameraId: "8241", direction: "entry",
          capturedAtEpoch: Date.parse("2026-10-08T22:04:26+07:00")},
        {id: "future", plate: "ปก100", cameraId: "8241", direction: "entry"},
        {id: "wrong-camera", plate: "8ก100", cameraId: "8242",
          direction: "exit"},
        {id: "unreviewed-old", plate: "8ก100", cameraId: "8241",
          direction: "entry", capturedAtEpoch: futureEpoch - 86400000},
      ].map((event) => ({capturedAtEpoch: futureEpoch, ...event}));
      let queryPlates = [];
      const query = {
        where: (field, op, plates) => {
          assert.equal(field, "plate");
          assert.equal(op, "in");
          queryPlates = plates;
          return query;
        },
        get: async () => ({docs: events
            .filter((event) => queryPlates.includes(event.plate))
            .map((event) => ({id: event.id, data: () => event}))}),
      };
      const context = vm.createContext({
        resolveLprPlate, lprSearchPlates,
        buildExpectedLprState: async () => expected,
        db: {collection: () => query},
        LPR_TRAFFIC_EVENTS_COLLECTION: "test_lpr",
        normalizePlateArray: (values) => values.map((v) => v.replace(/-/g, "")),
        normalizeHouseNo: (value) => value,
        isReadableLprEvent: (event) => Boolean(event.plate),
        formatBangkokHm: () => "12:00",
        formatBangkokDateLabel: () => "10 ต.ค. 2026",
        displayPlate: (plate) => plate,
        lprEventImageUrl: () => "original-image",
        attachVehicleProfiles: async (rows) => rows,
      });
      for (const name of ["buildPlateSearchReport", "buildHouseSearchReport"]) {
        const start = source.indexOf(`async function ${name}(`);
        vm.runInContext(source.slice(start, source.indexOf("\n/**", start)),
            context);
      }
      const plateReport = await context.buildPlateSearchReport("กข-1000");
      assert.equal(plateReport.summary.totalEvents, 3);
      assert.equal(plateReport.summary.resident, true);
      const houseReport = await context.buildHouseSearchReport("38/90");
      const results = houseReport.dateGroups.flatMap((group) => group.events);
      assert.equal(results.length, 3);
      assert.ok(results.every((event) => event.plate === "กข1000"));
      assert.equal(results.filter((event) => event.plateCorrection).length, 2);
      assert.ok(results.some((event) => event.reportedPlate === "8ก100"));
    });
