"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  isReadableLprEvent,
  resolveLprPlate: resolveCameraPlate,
  parseLprTrafficEvent,
  describeUnreadableReason,
  buildSecurityAuditFlexMessage,
  matchSecurityAuditPlates,
  formatBangkokDateLabel,
  formatWeeklyThaiDateRange,
  getSecurityAuditRange,
  buildWeeklySafetyFlexMessage,
  normalizeVisitorPlate,
  normalizeVisitorVehicleType,
} = require("../index.js").__visitorTest;
const {
  stripThaiProvinceForLookup,
} = require("../domains/visitors/normalization.js");

const {auditOutageWindows, isOutageAffectedCar} =
  require("../domains/health/anpr-outages");

const correctionRules = require("./fixtures/lpr-corrections");
const resolveLprPlate = (event, expected) =>
  resolveCameraPlate(event, expected, correctionRules);

// Exercise the real report builder with only its I/O boundaries stubbed.
const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
const start = source.indexOf("async function buildSecurityAuditReport(");
const reportSource = source.slice(start, source.indexOf("\n/**", start));
const trafficStart = source.indexOf(
    "async function buildSecurityAuditTrafficSlice(");
const trafficSource = source.slice(trafficStart,
    source.indexOf("\n/**", trafficStart));

/**
 * Builds a report without any production reads or LINE sends.
 * @param {Array<string>} cameraPlates Camera Visitor plates.
 * @param {Array<string>} loggedPlates Guard Visitor plates.
 * @param {Object} expected Resident registry.
 * @param {Object[]} statuses Camera outage histories.
 * @return {Promise<Object>}
 */
async function reportFor(cameraPlates, loggedPlates,
    expected = {plates: [], plateHouses: {}}, statuses = []) {
  const range = getSecurityAuditRange("2026-10-04", 7, 0, 19, 0);
  // Entries are a plate string or {plate, at} with `at` = ms after start.
  // Bare strings put guard logs 2 h after camera reads, so the exact-match
  // tests below never trigger misread pairing (it has its own tests).
  const at = (entry, fallback) => range.startEpoch +
    (typeof entry === "string" ? fallback : entry.at);
  const plateOf = (entry) => typeof entry === "string" ? entry : entry.plate;
  const docs = loggedPlates.map((entry, i) => ({
    id: String(i),
    data: () => ({
      createdAt: {toMillis: () => at(entry, 2 * 60 * 60 * 1000)},
      vehicleCapture: {plateText: plateOf(entry), vehicleType: "รถยนต์"},
    }),
  }));
  const query = {
    where: () => query,
    limit: () => query,
    get: async () => ({docs}),
  };
  const trafficDocs = cameraPlates.map((entry) => ({data: () => ({
    ...(typeof entry === "string" ? {} : entry),
    plate: plateOf(entry),
    capturedAtEpoch: at(entry, 1000),
  }), id: entry.id || ""}));
  const trafficQuery = {
    where: () => trafficQuery,
    get: async () => ({docs: trafficDocs}),
  };
  const context = vm.createContext({
    getSecurityAuditRange,
    isReadableLprEvent,
    resolveLprPlate,
    buildExpectedLprState: async () => expected,
    attachVehicleProfiles: async (rows) => rows,
    formatBangkokHm: () => "07:00",
    lprEventImageUrl: () => "",
    getSecurityShiftOfficerName: async () => "",
    db: {
      collection: (name) => name === "test_lpr" ? trafficQuery :
        name === "test_status" ? {doc: (id) => id} : query,
      getAll: async () => statuses.map((status) =>
        ({exists: true, data: () => status})),
    },
    auditOutageWindows,
    isOutageAffectedCar,
    LPR_AGENT_C_STATUS_COLLECTION: "test_status",
    LPR_TRAFFIC_EVENTS_COLLECTION: "test_lpr",
    VISITOR_INTAKE_COLLECTION: "test_visitors",
    normalizeVisitorPlate,
    normalizeVisitorVehicleType,
    stripThaiProvinceForLookup,
    matchSecurityAuditPlates,
    visitorReportPurposeLabel: () => "แขก",
  });
  vm.runInContext(trafficSource, context);
  vm.runInContext(reportSource, context);
  return context.buildSecurityAuditReport("2026-10-04");
}

test("reviewed resident OCR errors do not reduce either shift's guard score",
    async () => {
      const expected = {
        plates: ["กข1000", "กค2000"],
        plateHouses: {"กข1000": ["38/90"], "กค2000": ["38/91"]},
      };
      const logged = ["กข100", "กข200", "กข300", "กข400", "กข500"];
      const first = await reportFor([...logged, "11111", {
        id: "reviewed-red-2",
        plate: "8ก100", cameraId: "8241", direction: "entry", at: 1000,
      }], logged, expected);
      assert.equal(first.percent, 100);
      assert.equal(first.carTotal, 5);
      assert.equal(first.uncheckedCars, 0);
      assert.equal(first.unreadable, 1);
      const second = await reportFor([...logged.slice(0, 3), "5ขค3343", {
        id: "reviewed-red-3",
        plate: "กก100", cameraId: "8241", direction: "entry", at: 1000,
      }, {
        id: "reviewed-white-entry",
        plate: "กจ2000", cameraId: "8241", direction: "entry", at: 1000,
      }], logged.slice(0, 3), expected);
      assert.equal(second.percent, 75);
      assert.equal(second.carTotal, 4);
      assert.equal(second.uncheckedCars, 1);
      assert.deepEqual(Array.from(second.missingPlates), ["5ขค 3343"]);
    });

test("no-plate placeholders never penalize guards, including old events",
    async () => {
      for (const rawPlate of ["11111", "UnKnown-11111"]) {
        const event = {plate: "11111", rawPlate, confidence: "61", at: 1000};
        assert.equal(isReadableLprEvent(event), false);
        assert.equal(describeUnreadableReason(event),
            "ป้ายอ่านไม่ออก/ไม่มีป้าย");
        const report = await reportFor(["กข100", "กข200", event], ["กข100"]);
        assert.equal(report.carTotal, 2);
        assert.equal(report.uncheckedCars, 1);
        assert.equal(report.percent, 50);
        assert.equal(report.unreadable, 1);
        assert.deepEqual(Array.from(report.missingPlates), ["กข 200"]);
        const parsed = parseLprTrafficEvent(
            "<eventType>ANPR</eventType>" +
            `<licensePlate>${rawPlate}</licensePlate>` +
            "<confidenceLevel>61</confidenceLevel>");
        assert.equal(parsed.rawPlate, rawPlate);
        assert.equal(parsed.plate, "");
      }
      assert.equal(isReadableLprEvent(
          {plate: "กข11111", confidence: "61"}), true);
      const report = await reportFor(["11111"], []);
      assert.equal(report.carTotal, 0);
      assert.equal(report.percent, null);
    });

test("unchecked stat counts known LPR cars even during partial outages",
    async () => {
      for (const [camera, logged, expected] of [
        [[], [], "ไม่ทราบ"],
        [[], ["กข100"], "0 คัน"],
        [["กข100"], ["กข200"], "1 คัน"],
        [["กข100", "กข200"], ["กข100"], "1 คัน"],
        [["กข100"], ["กข100"], "0 คัน"],
      ]) {
        const card = buildSecurityAuditFlexMessage(
            await reportFor(camera, logged));
        const boxes = [];
        const visit = (node) => {
          if (!node || typeof node !== "object") return;
          if (node.type === "box" && Array.isArray(node.contents) &&
              node.contents.some(
                  (child) => child.text === "ไม่ได้ตรวจบัตร")) boxes.push(node);
          Object.values(node).forEach((child) => {
            if (Array.isArray(child)) child.forEach(visit);
            else visit(child);
          });
        };
        visit(card);
        assert.equal(boxes.length, 1);
        const value = boxes[0].contents.find(
            (child) => child.type === "text" &&
              child.text !== "ไม่ได้ตรวจบัตร");
        assert.equal(value.text, expected);
        const label = boxes[0].contents.find(
            (child) => child.text === "ไม่ได้ตรวจบัตร");
        assert.equal(boxes[0].contents[0], label, "label reads first");
        if (expected === "ไม่ทราบ") {
          assert.ok(!JSON.stringify(boxes[0]).includes("0 คัน"));
          assert.equal(value.color, "#8D7A66", "muted grey, not a tier color");
        }
      }
    });

test("missing LPR scores logged cars without adding source notes",
    async () => {
      for (const count of [9, 4, 17]) {
        const report = await reportFor([], Array.from({length: count},
            (_, i) => `กข${i + 100}`));
        assert.equal(report.carTotal, count);
        assert.equal(report.checkedCars, count);
        assert.equal(report.lprCarTotal, 0);
        assert.equal(report.percent, 100);
        assert.equal(report.assessmentAvailable, true);
        const card = JSON.stringify(buildSecurityAuditFlexMessage(report));
        assert.ok(card.includes(`"text":"100%"`));
        assert.ok(!card.includes("คำนวณจากรถที่พบใน LPR"));
        assert.ok(!card.includes("คันจากบันทึก รปภ."));
        assert.ok(!card.includes(`"text":"0%"`));
        assert.ok(!card.includes("ไม่มีทะเบียนที่ค้างตรวจ"));
      }
    });

test("unrelated logged plates cannot cancel genuinely unchecked LPR cars",
    async () => {
      const report = await reportFor(["กข100", "กข200"],
          ["กข100", "กข300", "กข400"]);
      assert.equal(report.carTotal, 4);
      assert.equal(report.checkedCars, 3);
      assert.equal(report.uncheckedCars, 1);
      assert.equal(Array.from(report.missingPlates)[0], "กข 200");
      assert.equal(report.percent, 75);
      assert.equal(report.assessmentAvailable, true);
      const card = JSON.stringify(buildSecurityAuditFlexMessage(report));
      assert.ok(card.includes(`"text":"75%"`));
      assert.ok(card.includes("กข 200"));
      assert.ok(!card.includes("คันจากบันทึก รปภ."));
    });

test("duplicates and normalized plates count once with consistent totals",
    async () => {
      const report = await reportFor(["กข100", "กข100", "กข200"],
          ["กข 100", "กข100"]);
      assert.equal(report.carTotal, 2);
      assert.equal(report.checkedCars, 1);
      assert.equal(report.uncheckedCars, 1);
      assert.equal(report.percent, 50);
      assert.ok(JSON.stringify(buildSecurityAuditFlexMessage(report))
          .includes(`"text":"50%"`));
    });

test("valid zero and complete checks still show real 0% and 100%", async () => {
  for (const logged of [[], ["กข100"]]) {
    const report = await reportFor(["กข100"], logged);
    const percent = logged.length ? 100 : 0;
    assert.equal(report.percent, percent);
    assert.ok(JSON.stringify(buildSecurityAuditFlexMessage(report))
        .includes(`"text":"${percent}%"`));
  }
});

test("empty shifts have no performance denominator", async () => {
  const report = await reportFor([], []);
  assert.equal(report.carTotal, 0);
  assert.equal(report.percent, null);
});

test("night shift spans Bangkok midnight with the correct date", () => {
  const range = getSecurityAuditRange("2026-10-03", 19, 0, 7, 0);
  assert.equal(range.startEpoch, Date.parse("2026-10-03T19:00:00+07:00"));
  assert.equal(range.endEpoch, Date.parse("2026-10-04T07:00:00+07:00"));
});


test("weekly Flex cannot turn an unavailable guard score into 0%", () => {
  const card = buildWeeklySafetyFlexMessage({
    checkPercent: null,
    assessmentAvailable: false,
    busiestHour: null,
    dateLabel: "test",
    purposes: [],
  });
  assert.ok(JSON.stringify(card).includes("ประเมินไม่ได้"));
  assert.ok(!JSON.stringify(card).includes(`"text":"0%"`));
});


test("duplicate unmatched LPR rows do not inflate unchecked totals",
    async () => {
      const report = await reportFor(["กข100", "กข 100"], []);
      assert.equal(report.carTotal, 1);
      assert.equal(report.uncheckedCars, 1);
      assert.equal(report.missingPlates.length, 1);
    });

/**
 * Minimal report for card-only tests (no I/O).
 * @param {number} total Visitor cars seen by LPR.
 * @param {number} checked Cars with a logged card check.
 * @param {Object} [extra] Field overrides.
 * @return {Object}
 */
function cardReport(total, checked, extra = {}) {
  const plates = Array.from({length: total - checked},
      (_, i) => `กข ${1000 + i}`);
  return {
    reportDate: "2026-10-04",
    windowLabel: "07:00–19:00",
    shift: "day",
    carTotal: total,
    lprCarTotal: total,
    checkedCars: checked,
    uncheckedCars: total - checked,
    assessmentAvailable: true,
    percent: Math.round((checked / total) * 100),
    missingPlates: plates,
    motorcycleCount: 6,
    ...extra,
  };
}

/**
 * Finds the header gradient start color of a card.
 * @param {Object} card
 * @return {string}
 */
function headerColor(card) {
  return card.contents.header.background.startColor;
}

test("card tier colors change at 50, 70, 80, 90 and a true 100", () => {
  const cases = [
    [cardReport(20, 20), "ยอดเยี่ยม"],
    [cardReport(20, 19), "เยี่ยมมาก"],
    [cardReport(20, 18), "เยี่ยมมาก"],
    [cardReport(20, 17), "ดีมาก"],
    [cardReport(20, 16), "ดีมาก"],
    [cardReport(20, 15), "ตรวจได้ดี"],
    [cardReport(100, 79), "ตรวจได้ดี"],
    [cardReport(100, 70), "ตรวจได้ดี"],
    [cardReport(100, 69), "เพิ่มการตรวจอีกนิด"],
    [cardReport(20, 10), "เพิ่มการตรวจอีกนิด"],
    [cardReport(20, 9), "ควรปรับปรุง"],
    [cardReport(20, 0), "ควรปรับปรุง"],
  ];
  const colors = new Set();
  for (const [report, name] of cases) {
    const card = buildSecurityAuditFlexMessage(report);
    assert.ok(JSON.stringify(card).includes(`"text":"${name}"`),
        `${report.percent}% should be ${name}`);
    colors.add(headerColor(card));
  }
  assert.equal(colors.size, 6, "six distinct header colors");
});


test("74 percent card uses positive wording and a blue header", () => {
  const card = buildSecurityAuditFlexMessage(cardReport(23, 17));
  const json = JSON.stringify(card);
  assert.ok(json.includes(`"text":"ตรวจได้ดี"`));
  assert.ok(json.includes("ขอบคุณทีม รปภ."));
  assert.ok(!json.includes("พอใช้"));
  assert.equal(headerColor(card), "#326B90");
});

test("a rounded 100% with an unchecked car never reads as complete", () => {
  const report = cardReport(200, 199, {percent: 100});
  const json = JSON.stringify(buildSecurityAuditFlexMessage(report));
  assert.ok(!json.includes(`"text":"100%"`));
  assert.ok(json.includes(`"text":"99%"`));
  assert.ok(!json.includes("ยอดเยี่ยม"));
});

test("six unchecked plates fill both rows without an overflow note", () => {
  const json = JSON.stringify(
      buildSecurityAuditFlexMessage(cardReport(20, 14)));
  assert.equal((json.match(/"text":"กข \d{4}"/g) || []).length, 6);
  assert.ok(json.includes(`"text":"กข 1005"`));
  assert.ok(!json.includes("อีก"));
});

test("unchecked plates cap at six with an overflow note", () => {
  const json = JSON.stringify(
      buildSecurityAuditFlexMessage(cardReport(12, 4)));
  assert.equal((json.match(/"text":"กข \d{4}"/g) || []).length, 6);
  assert.ok(json.includes(`"text":"อีก 2 คัน"`));
  const few = JSON.stringify(
      buildSecurityAuditFlexMessage(cardReport(12, 9)));
  assert.equal((few.match(/"text":"กข \d{4}"/g) || []).length, 3);
  assert.ok(!few.includes("อีก"));
  const none = JSON.stringify(
      buildSecurityAuditFlexMessage(cardReport(12, 12)));
  assert.ok(!none.includes("ทะเบียนที่ไม่ได้ตรวจบัตร"));
});

test("unavailable card hides plates and keeps real checked count", () => {
  const report = cardReport(27, 9, {
    assessmentAvailable: false,
    percent: null,
    missingPlates: ["กข 1"],
  });
  const json = JSON.stringify(buildSecurityAuditFlexMessage(report));
  assert.ok(json.includes("ประเมินไม่ได้"));
  assert.ok(json.includes("ข้อมูล LPR ไม่เพียงพอ"));
  assert.ok(json.includes(`"text":"9 คัน"`));
  assert.ok(!json.includes("ทะเบียนที่ไม่ได้ตรวจบัตร"));
  assert.ok(!json.includes(`"text":"0%"`));
});

test("progress track is one smooth gradient fill sized by percent", () => {
  const card = buildSecurityAuditFlexMessage(cardReport(12, 9));
  const track = card.contents.body.contents.find(
      (node) => node.height === "12px" && node.layout === "horizontal");
  assert.equal(track.contents.length, 2, "fill + remainder, no segments");
  assert.equal(track.contents[0].flex, 75);
  assert.equal(track.contents[1].flex, 25);
  assert.equal(track.contents[0].background.type, "linearGradient");
  const full = buildSecurityAuditFlexMessage(cardReport(12, 12));
  const fullTrack = full.contents.body.contents.find(
      (node) => node.height === "12px" && node.layout === "horizontal");
  assert.equal(fullTrack.contents.length, 1, "100% has no remainder box");
  const none = buildSecurityAuditFlexMessage(cardReport(12, 0));
  const zeroTrack = none.contents.body.contents.find(
      (node) => node.height === "12px" && node.layout === "horizontal");
  assert.equal(zeroTrack.contents[0].type, "filler", "0% shows empty track");
});

test("card dates use the Gregorian year, not Buddhist era", () => {
  const card = buildSecurityAuditFlexMessage(cardReport(12, 9));
  const json = JSON.stringify(card);
  assert.ok(json.includes("2026"), "ค.ศ. year present");
  assert.ok(!json.includes("2569"), "no พ.ศ. year");
});

test("motorcycle section keeps the reported count in a colored summary", () => {
  const card = buildSecurityAuditFlexMessage(cardReport(20, 14, {
    motorcycleCount: 36,
  }));
  const section = card.contents.body.contents.find(
      (node) => node.backgroundColor === "#EDF2EC");
  assert.ok(section);
  assert.equal(section.contents[2].contents[0].text, "36");
  const json = JSON.stringify(section);
  assert.ok(json.includes(`"text":"มอเตอร์ไซค์"`));
  assert.ok(json.includes(`"text":"เข้า–ออกโครงการวันนี้"`));
  assert.ok(!json.includes("ตรวจแล้ว"));
  assert.ok(!json.includes("ตามที่ รปภ. แจ้ง"));
  assert.ok(!json.includes("เหตุผลที่มาติดต่อ"));
});

test("every card tier has only non-empty text and span nodes", () => {
  const reports = [
    cardReport(12, 12), cardReport(20, 19), cardReport(20, 17),
    cardReport(12, 9), cardReport(20, 12), cardReport(12, 4),
    cardReport(17, 17, {lprCarTotal: 0, visitorOnlyCars: 17}),
    cardReport(27, 9, {assessmentAvailable: false, percent: null}),
  ];
  const visit = (node, found) => {
    if (!node || typeof node !== "object") return;
    if ((node.type === "text" && !node.contents) || node.type === "span") {
      found.push(node.text);
    }
    Object.values(node).forEach((child) => {
      if (Array.isArray(child)) child.forEach((c) => visit(c, found));
      else visit(child, found);
    });
  };
  for (const report of reports) {
    const found = [];
    visit(buildSecurityAuditFlexMessage(report), found);
    assert.ok(found.length > 0);
    found.forEach((text) => assert.ok(
        typeof text === "string" && text.length > 0,
        `empty text node in ${report.percent}% card (LINE rejects it)`));
  }
});

test("star count follows its own cut-offs, not the color tier", () => {
  /**
   * Counts the lit stars in a card's header.
   * @param {Object} report
   * @return {number}
   */
  function litStars(report) {
    const json = JSON.stringify(buildSecurityAuditFlexMessage(report));
    const icons = [...json.matchAll(/security-audit-star-v1-(\w+)\.png/g)];
    return icons.reduce((sum, [, fill]) =>
      sum + (fill === "full" ? 1 : fill === "half" ? 0.5 : 0), 0);
  }
  const cases = [
    [cardReport(20, 20), 5],
    [cardReport(20, 19), 4.5],
    [cardReport(20, 18), 4.5],
    [cardReport(22, 19), 4.5],
    [cardReport(20, 17), 4.5],
    [cardReport(100, 84), 4.5],
    [cardReport(20, 16), 4.5],
    [cardReport(100, 79), 3],
    [cardReport(12, 9), 3],
    [cardReport(20, 12), 3],
    [cardReport(20, 11), 2],
    [cardReport(20, 10), 2],
    [cardReport(20, 9), 1],
    [cardReport(12, 4), 1],
    [cardReport(200, 199, {percent: 100}), 4.5],
  ];
  for (const [report, stars] of cases) {
    assert.equal(litStars(report), stars,
        `${report.percent}% (${report.checkedCars}/${report.carTotal})`);
  }
  assert.equal(litStars(cardReport(27, 9,
      {assessmentAvailable: false, percent: null})), 0);
});

test("ratings use five larger icons with a real half-filled fifth star", () => {
  for (const report of [cardReport(22, 19), cardReport(20, 16),
    cardReport(20, 20), cardReport(12, 4)]) {
    const card = buildSecurityAuditFlexMessage(report);
    const icons = [];
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.type === "icon") icons.push(node);
      if (node.contents) node.contents.forEach(visit);
      if (node.header) visit(node.header);
    };
    visit(card.contents);
    assert.equal(icons.length, 5);
    icons.forEach((icon) => {
      assert.equal(icon.size, "20px");
      assert.equal(icon.aspectRatio, "1:1");
      assert.ok(icon.url.startsWith("https://firebasestorage.googleapis.com/"));
    });
    const fills = icons.map((icon) =>
      icon.url.match(/star-v1-(\w+)\.png/)[1]);
    assert.deepEqual(fills, report.percent >= 80 && report.uncheckedCars > 0 ?
      ["full", "full", "full", "full", "half"] :
      report.uncheckedCars === 0 ?
        ["full", "full", "full", "full", "full"] :
        ["full", "empty", "empty", "empty", "empty"]);
    assert.ok(!JSON.stringify(card).includes("½"));
  }
});

test("card date labels use the Gregorian year across all builders", () => {
  const label = formatBangkokDateLabel(
      Date.parse("2026-10-05T12:00:00+07:00"));
  assert.ok(label.includes("2026"), label);
  assert.ok(!label.includes("2569"), label);
  const range = formatWeeklyThaiDateRange("2026-12-29", "2027-01-04");
  assert.ok(range.includes("2026") && range.includes("2027"), range);
  assert.ok(!/25\d\d/.test(range), range);
});

test("guard-logged plates with a province match LPR plates without one",
    async () => {
      const report = await reportFor(
          ["4ฒง1808", "บร3448", "กพ6135"],
          ["4ฒง 1808 กรุงเทพ", "บร 3448 สระแก้ว", "กพ 6135 กระบี่"]);
      assert.equal(report.lprCarTotal, 3);
      assert.equal(report.checkedCars, 3);
      assert.equal(report.visitorOnlyCars, 0);
      assert.equal(report.uncheckedCars, 0);
      assert.equal(report.assessmentAvailable, true);
      assert.equal(report.percent, 100);
    });

test("misread plates pair up by edit distance and capture time", async () => {
  const min = 60000;
  // Real 5 Oct night shift: truck misread by the guard OCR (1 edit),
  // taxi misread on both sides (3 edits, 1 minute apart).
  const report = await reportFor(
      [{plate: "3ฒร4466", at: 0}, {plate: "ทพ7788", at: 150 * min},
        {plate: "ฆญ57", at: 4 * min}],
      [{plate: "3ฒร 4468 กรุงเทพ", at: min},
        {plate: "ทฬ 7882 กรุงเทพ", at: 151 * min},
        {plate: "ฆญ 57 กรุงเทพ", at: 5 * min}]);
  assert.equal(report.visitorOnlyCars, 0);
  assert.equal(report.checkedCars, 3);
  assert.equal(report.uncheckedCars, 0);
  assert.equal(report.assessmentAvailable, true);
  assert.equal(report.fuzzyMatches.length, 2);
});

test("plate pairing refuses far times, big edits and reuse", () => {
  const min = 60000;
  // 3 edits but 40 minutes apart: not the same car.
  assert.equal(matchSecurityAuditPlates(
      [{plate: "ทฬ 7882", epoch: 0}],
      [{plate: "ทพ 7788", epoch: 40 * min}]).length, 0);
  // 1 edit is fine up to 30 minutes, not beyond.
  assert.equal(matchSecurityAuditPlates(
      [{plate: "3ฒร 4468", epoch: 0}],
      [{plate: "3ฒร 4466", epoch: 25 * min}]).length, 1);
  assert.equal(matchSecurityAuditPlates(
      [{plate: "3ฒร 4468", epoch: 0}],
      [{plate: "3ฒร 4466", epoch: 35 * min}]).length, 0);
  // Short plates cannot absorb more than half their length in edits.
  assert.equal(matchSecurityAuditPlates(
      [{plate: "ฆญ 57", epoch: 0}],
      [{plate: "กข 12", epoch: min}]).length, 0);
  // Completely different plates never pair.
  assert.equal(matchSecurityAuditPlates(
      [{plate: "กข 1234", epoch: 0}],
      [{plate: "ฒร 9876", epoch: min}]).length, 0);
  // One LPR plate pairs with only the closest guard plate.
  const pairs = matchSecurityAuditPlates(
      [{plate: "3ฒร 4468", epoch: 0}, {plate: "3ฒร 4469", epoch: 0}],
      [{plate: "3ฒร 4466", epoch: min}]);
  assert.equal(pairs.length, 1);
  // No timestamp, no fuzzy pairing.
  assert.equal(matchSecurityAuditPlates(
      [{plate: "3ฒร 4468", epoch: NaN}],
      [{plate: "3ฒร 4466", epoch: 0}]).length, 0);
});

test("shift pill is light for day and dark for night", () => {
  const pillOf = (shift) => {
    const card = buildSecurityAuditFlexMessage(
        cardReport(12, 9, {shift}));
    const row = card.contents.header.contents[0];
    return row.contents.find((node) => node.cornerRadius === "14px");
  };
  const day = pillOf("day");
  const night = pillOf("night");
  assert.notEqual(day.backgroundColor, night.backgroundColor);
  assert.ok(day.contents[0].text.includes("กะกลางวัน"));
  assert.ok(night.contents[0].text.includes("กะกลางคืน"));
  assert.equal(night.contents[0].color, "#FFFFFF");
  assert.equal(day.contents[0].color, "#34281F");
});


test("outage exemptions preserve real checks and healthy unmatched cars",
    async () => {
      const range = getSecurityAuditRange("2026-10-04", 7, 0, 19, 0);
      const start = range.startEpoch;
      const report = await reportFor([
        {plate: "กข100", at: 1000},
        {plate: "กข200", at: 3600000},
        {plate: "กข300", at: 9000000},
      ], ["กข100"], undefined, [{anprOutageWindows: [{
        startEpoch: start + 1800000, endEpoch: start + 7200000,
      }]}]);
      assert.equal(report.checkedCars, 1);
      assert.equal(report.excusedCars, 1);
      assert.equal(report.uncheckedCars, 1);
      assert.equal(report.carTotal, 3);
      assert.equal(report.percent, 67);
      assert.deepEqual(Array.from(report.missingPlates), ["กข 300"]);
      const card = JSON.stringify(buildSecurityAuditFlexMessage(report));
      assert.ok(card.includes("ยกเว้น 1 คันช่วง ANPR ขัดข้อง"));
      assert.ok(!card.includes("ตรวจบัตรครบทุกคัน"));
    });

test("active exit outage credits unmatched entry captures only in its window",
    async () => {
      const start = getSecurityAuditRange("2026-10-04", 7, 0, 19, 0).startEpoch;
      const report = await reportFor([
        {plate: "กข100", at: 1000, direction: "entry"},
        {plate: "กข200", at: 3600000, direction: "entry"},
      ], ["กข100"], undefined, [{activeAnprOutage: {
        startEpoch: start + 1800000, lastEventEpoch: start + 1800000,
      }}]);
      assert.equal(report.checkedCars, 1);
      assert.equal(report.excusedCars, 1);
      assert.equal(report.uncheckedCars, 0);
      assert.equal(report.percent, 100);
      const json = JSON.stringify(buildSecurityAuditFlexMessage(report));
      assert.ok(json.includes("\"text\":\"100%\""));
      assert.ok(json.includes("ยกเว้น 1 คัน"));
      assert.ok(!json.includes("ตรวจบัตรครบทุกคัน"));
    });

test("a later capture in an outage is not lost when the plate repeats",
    async () => {
      const start = getSecurityAuditRange("2026-10-04", 7, 0, 19, 0).startEpoch;
      const report = await reportFor([
        {plate: "กข100", at: 1000},
        {plate: "กข100", at: 3600000},
      ], [], undefined, [{anprOutageWindows: [{
        startEpoch: start + 1800000, endEpoch: start + 7200000,
      }]}]);
      assert.equal(report.carTotal, 1);
      assert.equal(report.checkedCars, 0);
      assert.equal(report.excusedCars, 1);
      assert.equal(report.percent, 100);
    });
