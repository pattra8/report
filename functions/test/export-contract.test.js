"use strict";

// Architecture contract: module extraction must preserve the deployed Firebase
// export surface. This is static on purpose; requiring index.js initializes the
// Firebase application and makes the test depend on runtime configuration.

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_EXPORTS = [
  "adminAccessMatrix",
  "adminDocumentVault",
  "authWarmPing",
  "broadcastLineAnnouncement",
  "cancelRequest",
  "dailyLprReconciliation",
  "dailyTrafficReport",
  "dailyTrafficSummary",
  "deleteBulkyWasteRequest",
  "editBulkyWasteRequest",
  "estateIssueCleanup",
  "estateIssues",
  "getLifestyleSurvey",
  "getLifestyleSurveyStats",
  "getMyBulkyWasteRequests",
  "getPendingRequests",
  "getResidentData",
  "guardAuditDaySummary",
  "guardAuditNightSummary",
  "lineFlexRoutingAdmin",
  "lineWebhook",
  "lineWebhookWorker",
  "lprAgentCEventAudit",
  "lprAgentCRun",
  "lprEventWebhook",
  "lprGuardLookup",
  "lprImageCleanup",
  "lprImageSync",
  "lprPlateSync",
  "lprReconciliation",
  "lprVehicleVision",
  "lprWatchRun",
  "manageBulkyWasteRequests",
  "managePickupRound",
  "notifyLinePrivateIssue",
  "notifyLinePublicIssue",
  "overnightSecurityReport",
  "overnightSecuritySummary",
  "pattraPay",
  "pollAction",
  "residentLprSyncBackfill",
  "residentPinAuth",
  "residentSheetSync",
  "retryPendingLprSync",
  "submitBulkyWasteRequest",
  "submitRequest",
  "systemHealthAdmin",
  "systemHealthProbe",
  "updateLifestyleSurvey",
  "updateResidentData",
  "visitorDailySummary",
  "visitorIntakeAdmin",
  "visitorIntakeCleanup",
  "visitorIntakeOcrRecovery",
  "visitorIntakeReminder",
];

/**
 * Reads statically declared deployed exports from the composition root.
 * @param {string} source JavaScript source text.
 * @return {string[]} Sorted deployed export names.
 */
function deployedExportNames(source) {
  return [...source.matchAll(/^exports\.([A-Za-z0-9_]+)\s*=/gm)]
      .map((match) => match[1])
      .filter((name) => !name.startsWith("__"))
      .sort();
}

test("Firebase deployed export surface stays stable", () => {
  const indexPath = path.join(__dirname, "..", "index.js");
  const source = fs.readFileSync(indexPath, "utf8");
  assert.deepEqual(deployedExportNames(source), EXPECTED_EXPORTS);
});
