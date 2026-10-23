"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {
  getTrafficDayRange,
  getOvernightRange,
  buildPattraWatchFlex,
} = require("../index.js").__visitorTest;

const bkk = (iso) => Date.parse(`${iso}+07:00`);

const baseReport = (overrides) => ({
  reportDate: "2026-10-23",
  uniqueCars: 38,
  residentCars: 31,
  externalCars: 2,
  unreadableDetections: 2,
  hourlyCounts: Object.assign(Array(24).fill(0), {19: 16, 20: 9, 6: 12}),
  externalPlates: [
    {plate: "1กข6620", entryTime: "19:20", exitTime: "19:48",
      directions: ["entry", "exit"]},
    {plate: "1กร5506", entryTime: "02:14", exitTime: null,
      directions: ["entry"]},
  ],
  ...overrides,
});

const texts = (node, out = []) => {
  if (!node || typeof node !== "object") return out;
  if (node.type === "text") {
    out.push(node.text || (node.contents || []).map((s) => s.text).join(""));
  }
  (node.contents || []).forEach((child) => texts(child, out));
  ["header", "body", "footer"].forEach((k) => texts(node[k], out));
  return out;
};

test("day shift range ends at 19:00 the same day", () => {
  const range = getTrafficDayRange("2026-10-22", 7, 19);
  assert.equal(range.startEpoch, bkk("2026-10-22T07:00:00"));
  assert.equal(range.endEpoch, bkk("2026-10-22T19:00:00"));
});

test("full-day range still ends at next midnight by default", () => {
  const range = getTrafficDayRange("2026-10-22", 0);
  assert.equal(range.endEpoch, bkk("2026-10-23T00:00:00"));
});

test("night shift range starts the previous evening", () => {
  const range = getOvernightRange("2026-10-23", 19, 0, 7, 0);
  assert.equal(range.startEpoch, bkk("2026-10-22T19:00:00"));
  assert.equal(range.endEpoch, bkk("2026-10-23T07:00:00"));
  assert.equal(range.crossesMidnight, true);
  assert.equal(range.shiftStartDate, "2026-10-22");
  assert.equal(range.reportDate, "2026-10-23");
});

test("same-morning overnight window does not cross midnight", () => {
  const range = getOvernightRange("2026-10-23", 0, 0, 7, 30);
  assert.equal(range.startEpoch, bkk("2026-10-23T00:00:00"));
  assert.equal(range.crossesMidnight, false);
});

test("night card shows shift start date and next-day end", () => {
  const msg = buildPattraWatchFlex(baseReport({
    startHour: 19, endHour: 7, windowLabel: "19:00–07:00",
    crossesMidnight: true, shiftStartDate: "2026-10-22",
  }), {variant: "night"});
  const all = texts(msg.contents);
  assert.ok(all.includes("สรุปรถเข้า–ออก (กะกลางคืน)"));
  assert.ok(all.includes("22 ตุลาคม 2026   ·   19:00 – 07:00 (23 ต.ค.)"));
  assert.ok(all.includes("พีค 19:00–20:00"));
  assert.ok(all.includes("รถลูกบ้าน"));
});

test("heat strip has one cell per shift hour and ticks to the end", () => {
  const msg = buildPattraWatchFlex(baseReport({
    startHour: 7, endHour: 19,
  }), {variant: "daily", windowText: "07:00–19:00"});
  const all = texts(msg.contents);
  assert.ok(all.includes("สรุปรถเข้า–ออก (กะกลางวัน)"));
  assert.ok(all.includes("23 ตุลาคม 2026   ·   07:00–19:00 น."));
  assert.deepEqual(all.filter((t) => /^\d\d$/.test(t)).slice(-5),
      ["07", "10", "13", "16", "19"]);
  const json = JSON.stringify(msg.contents);
  assert.equal((json.match(/"height":"16px"/g) || []).length, 1);
});

test("visitor rows keep missing exit as a dash and no สี prefix", () => {
  const msg = buildPattraWatchFlex(baseReport({
    startHour: 19, endHour: 7, windowLabel: "19:00–07:00",
    crossesMidnight: true, shiftStartDate: "2026-10-22",
  }), {variant: "night"});
  const all = texts(msg.contents);
  assert.ok(all.includes("02:14"));
  assert.ok(all.includes("→ —"));
  assert.ok(!all.some((t) => /สี(ขาว|ดำ|เงิน)/.test(t)));
});

test("night rows crossing midnight are not flagged as exit-before-entry",
    () => {
      const night = {startHour: 19, endHour: 7, windowLabel: "19:00–07:00",
        crossesMidnight: true, shiftStartDate: "2026-10-22"};
      const msg = buildPattraWatchFlex(baseReport({...night, externalPlates: [
        {plate: "2ขจ7731", entryTime: "23:40", exitTime: "00:35",
          directions: ["entry", "exit"]},
        {plate: "3ขพ412", entryTime: "21:30", exitTime: "20:05",
          directions: ["entry", "exit"]},
      ]}), {variant: "night"});
      const all = texts(msg.contents);
      assert.ok(all.includes("→ 00:35"));
      assert.ok(all.includes("⚠ 20:05"));
    });

test("card stays under LINE's 30 KB bubble limit with many visitors", () => {
  const externalPlates = Array.from({length: 145}, (_, i) => ({
    plate: `1กข${1000 + i}`, entryTime: "08:00", exitTime: "09:00",
    directions: ["entry", "exit"],
  }));
  const msg = buildPattraWatchFlex(baseReport({
    externalCars: 145, externalPlates, startHour: 7, endHour: 19,
  }), {variant: "daily", windowText: "07:00–19:00"});
  const bytes = Buffer.byteLength(JSON.stringify(msg.contents), "utf8");
  assert.ok(bytes <= 29000, `bubble is ${bytes} bytes`);
  assert.ok(texts(msg.contents).some((t) => /^… และอีก \d+ คัน$/.test(t)));
});
