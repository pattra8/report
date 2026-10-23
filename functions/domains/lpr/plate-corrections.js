"use strict";

// Reviewed OCR errors only. Historical corrections are pinned to reviewed
// event IDs; future reads use the same exact plate/camera/direction rules.
// This changes report interpretation, never the stored camera evidence.
const RULES = [
  {
    plate: "ฎ6248",
    house: "38/60",
    cameraId: "8241",
    direction: "entry",
    // Quarantined on 2026-10-16: investigate cross-vehicle native output.
    // Camera access uses reviewed allowlist aliases; report rules stay active.
    nativeMapping: false,
    aliases: ["ปฎ648", "8ฎ648", "ฎฎ648"],
    reviewedIds: [
      "de3e7502b354ba9a4491c94290abfb9876bcc38c",
      "0a2f2d7289a7cd9f273ca1e19d378cbc992c4c75",
      "47d635e0a5e8bbd07cc566809093c47fff5f6775",
    ],
  },
  {
    plate: "ฆว3818",
    house: "38/18",
    cameraId: "8241",
    direction: "entry",
    aliases: ["ฆจ3818"],
    reviewedIds: [
      "051e23b681fd1bcba605c9c1bf34f148d1cd32a3",
      "801639a359156c8ea7b9e064f5ea650bb9fc4f85",
    ],
  },
  {
    plate: "ฆว3818",
    house: "38/18",
    cameraId: "8242",
    direction: "exit",
    aliases: ["ฆจ3818"],
    reviewedIds: ["46ce6349ec8a6948b484c88c6d6e7285f0265273"],
  },
];
const FUTURE_READS_FROM = Date.parse("2026-10-10T00:00:00+07:00");

/**
 * Exact registered plates win. Corrections require the canonical plate to
 * remain assigned solely to its reviewed house in the current registry.
 * @param {Object} rule
 * @param {Object} expected
 * @return {boolean}
 */
function isActive(rule, expected) {
  const houses = expected.plateHouses && expected.plateHouses[rule.plate];
  return (expected.plates || []).includes(rule.plate) &&
    Array.isArray(houses) && houses.length === 1 && houses[0] === rule.house;
}

/**
 * Resolves one camera read for reports while preserving all raw evidence.
 * @param {Object} event
 * @param {Object} expected Current resident plate registry.
 * @param {Array<Object>} rules Reviewed correction policy.
 * @return {Object}
 */
function resolveLprPlate(event, expected, rules = RULES) {
  if (!event || (expected.plates || []).includes(event.plate)) return event;
  const rule = rules.find((item) => isActive(item, expected) &&
    item.aliases.includes(event.plate) &&
    item.cameraId === String(event.cameraId || "") &&
    item.direction === event.direction &&
    (item.reviewedIds.includes(event.id) ||
      Number(event.capturedAtEpoch) >= FUTURE_READS_FROM));
  if (!rule) return event;
  return {
    ...event,
    plate: rule.plate,
    reportedPlate: event.plate,
    plateCorrection: "reviewed-camera-ocr",
  };
}

/**
 * Includes stored aliases in a canonical plate search. Callers must resolve
 * and filter the returned events: a query candidate is not a correction.
 * @param {string} plate
 * @param {Object} expected
 * @param {Array<Object>} rules Reviewed correction policy.
 * @return {string[]}
 */
function lprSearchPlates(plate, expected, rules = RULES) {
  const registered = new Set(expected.plates || []);
  return [...new Set([plate, ...rules
      .filter((rule) => rule.plate === plate && isActive(rule, expected))
      .flatMap((rule) => rule.aliases)
      .filter((alias) => !registered.has(alias))])];
}

/**
 * Builds exact device-side replacements from the same reviewed policy.
 * Never grant an alias belonging to a registered vehicle, and fail closed
 * if two active rules would replace one alias with different plates.
 * @param {string} cameraId
 * @param {Object} expected
 * @param {Array<Object>} rules
 * @return {Array<Object>}
 */
function lprCameraMappings(cameraId, expected, rules = RULES) {
  const registered = new Set(expected.plates || []);
  const mappings = new Map();
  rules.filter((rule) => rule.nativeMapping !== false &&
    rule.cameraId === String(cameraId) &&
    isActive(rule, expected)).forEach((rule) => {
    rule.aliases.filter((alias) => !registered.has(alias)).forEach((alias) => {
      if (mappings.has(alias) && mappings.get(alias) !== rule.plate) {
        throw new Error("Conflicting reviewed LPR mapping");
      }
      mappings.set(alias, rule.plate);
    });
  });
  return Array.from(mappings, ([detectPlateNo, replacePlateNo]) =>
    ({detectPlateNo, replacePlateNo}));
}

module.exports = {resolveLprPlate, lprSearchPlates, lprCameraMappings};
