const crypto = require("crypto");

const admin = require("firebase-admin");
const {GoogleAuth} = require("google-auth-library");
const {
  resolveLprPlate,
  lprSearchPlates,
} = require("./domains/lpr/plate-corrections");
const {setGlobalOptions} = require("firebase-functions/v2");
const {
  onDocumentCreated,
  onDocumentUpdated,
} = require("firebase-functions/v2/firestore");
const {onRequest} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const {defineSecret} = require("firebase-functions/params");
const {
  prepareJsonRequest,
  sendLegacyError,
  setCorsHeaders,
} = require("./platform/http");
const {
  ISSUE_COMMENT_MAX,
  ISSUE_INTERNAL_NOTE_MAX,
  assertAttachmentSlotAvailable,
  buildIssueSubmission,
  buildIssueWatchNotice,
  formatIssueCode,
  issueBuddhistYear,
  issueError,
  issueQueueState,
  isResidentIssueEditable,
  isIssueRateLimited,
  normalizeIssuePriority,
  normalizeIssueStatus,
  normalizeIssueText,
  parseIssueUpload,
  redactIssueForAdmin,
  summarizeIssueStatuses,
  toResidentIssueView,
} = require("./domains/issues/contracts");
const {
  findPaymentResident,
  paymentHouseNumber: ppHouseNum,
} = require("./domains/payments/resident-repository");
const {
  commitPaymentVerification,
  commitGroupVerification,
} = require("./domains/payments/receipt-repository");
const {
  commonSlipAmount,
  normalizeOptionalReceiptEmail,
} = require("./domains/payments/public-slip-policy");
const {
  normalizeCommonPeriod,
} = require("./domains/payments/period-policy");
const {
  applyPaymentToPlan,
  isPlanActive,
  planProgress,
  validatePlanInput,
} = require("./domains/payments/installment-policy");
const {
  buildHouseBilling,
  redactInstallmentBalances,
} = require("./domains/payments/house-billing");
const {
  MAX_PARKING_PERIODS,
  allocateParkingMonths,
  parkingArrears,
  parseMemoPeriod,
  parseParkingPeriod,
  parkingPeriodsFrom,
  inferParkingMonths,
  splitSlipAmount,
} = require("./domains/payments/parking-period");
const {
  ADMIN_ACCESS_DEFAULTS,
  ADMIN_PERMISSION_KEYS,
  normalizeAdminPermissions,
} = require("./domains/auth/admin-access-policy");
const {
  getCarQuota,
  parseCarQuota,
} = require("./domains/residents/car-quota");
const {
  maskDocumentNumber,
  normalizeDocumentNumber,
  normalizeVisitorName,
  normalizeVisitorPlate,
  normalizeVisitorVehicleType,
  stripThaiProvinceForLookup,
  THAI_PROVINCES,
} = require("./domains/visitors/normalization");
const {
  getVisitorIntakeStatus,
  shouldAttemptVisitorOutageNotice,
  shouldStartNewVisitorImageLog,
  shouldStartNewVisitorLog,
} = require("./domains/visitors/intake-state");
const {
  analyzeVisitorImageWithRetry,
  canRetryVisitorImage,
  mergeVisitorEvidence,
  nextVisitorOcrRetryAt,
  visitorImageAnalysisPatch,
  visitorTimestampMs,
} = require("./domains/visitors/image-analysis");
const {
  accumulatePeerEvents,
  anprEventStatus,
  heartbeatStatus,
  lineMessagingStatus,
  overallStatus,
  probeStatus,
} = require("./domains/health/status-policy");
const {
  auditOutageWindows,
  isOutageAffectedCar,
  nextAnprOutageState,
} = require("./domains/health/anpr-outages");
const {
  ADMIN_ACCESS_COLLECTION,
  ADMIN_DOCUMENTS_COLLECTION,
  AUDIT_LOG_COLLECTION,
  BULKY_WASTE_COLLECTION,
  DAILY_TRAFFIC_CONFIG_PATH,
  GUARD_AUDIT_CONFIG_PATH,
  LIFESTYLE_SURVEY_COLLECTION,
  LINE_BROADCASTS_COLLECTION,
  LINE_CONFIG_PATH,
  LINE_FLEX_ROUTING_CONFIG_PATH,
  LINE_WEBHOOK_EVENTS_COLLECTION,
  LINE_TARGETS_COLLECTION,
  LPR_AGENT_C_ALERTS_COLLECTION,
  LPR_AGENT_C_AUDITS_COLLECTION,
  LPR_AGENT_C_CONFIG_PATH,
  LPR_AGENT_C_METRICS_COLLECTION,
  LPR_AGENT_C_REPORTS_COLLECTION,
  LPR_AGENT_C_STATUS_COLLECTION,
  LPR_DAILY_TRAFFIC_COLLECTION,
  LPR_MONITOR_CONFIG_PATH,
  LPR_OVERNIGHT_COLLECTION,
  LPR_RECONCILIATION_COLLECTION,
  LPR_TRAFFIC_EVENTS_COLLECTION,
  LPR_UNREADABLE_LABELS_COLLECTION,
  LPR_VEHICLE_PROFILES_COLLECTION,
  ESTATE_ISSUES_COLLECTION,
  ESTATE_ISSUE_COUNTERS_COLLECTION,
  FEATURE_USAGE_COLLECTION,
  ISSUES_ARCHIVE_COLLECTION,
  PATTRA_INSTALLMENT_PLANS_COLLECTION,
  PATTRA_PAYMENTS_COLLECTION,
  POLLS_COLLECTION,
  RESIDENTS_COLLECTION,
  RESIDENT_PIN_COLLECTION,
  RESIDENT_SIGNATURE_COLLECTION,
  SECURITY_SHIFT_CONFIG_PATH,
  SYSTEM_HEALTH_CONFIG_PATH,
  SYSTEM_HEALTH_REBOOTS_COLLECTION,
  VISITOR_DAILY_CONFIG_PATH,
  VISITOR_DAILY_REPORTS_COLLECTION,
  VISITOR_INTAKE_COLLECTION,
  VISITOR_INTAKE_CONFIG_PATH,
  VISITOR_INTAKE_SESSIONS_COLLECTION,
} = require("./platform/firestore-paths");

admin.initializeApp();

setGlobalOptions({
  maxInstances: 10,
  region: "asia-southeast1",
});

const db = admin.firestore();

const LINE_CHANNEL_SECRET = defineSecret("LINE_CHANNEL_SECRET");
const LINE_CHANNEL_ACCESS_TOKEN = defineSecret("LINE_CHANNEL_ACCESS_TOKEN");
const LPR_ADMIN_PASSWORD = defineSecret("LPR_ADMIN_PASSWORD");
const LPR_EVENT_TOKEN = defineSecret("LPR_EVENT_TOKEN");
const LPR_NVR_PASSWORD = defineSecret("LPR_NVR_PASSWORD");
const GH_TOKEN_SECRET = defineSecret("GH_TOKEN");
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

const REPORT_ISSUE_TEST_TARGET_ID = "Cc8b4fea6ca64611a006388a9c46d8bbe";
const LINE_FLEX_SANDBOX_TARGET_ID = "Cc8b4fea6ca64611a006388a9c46d8bbe";
const LINE_FLEX_SECURITY_PRODUCTION_TARGET_ID =
  "Cece0bf710254a9d48d5b738c4f2afdd7";
const LINE_FLEX_PATTRA_PAY_PRODUCTION_TARGET_ID =
  "C7e85f0564a1563a1aa681cd970c04a9d";
const LINE_FLEX_TARGETS = Object.freeze({
  sandbox: {
    key: "sandbox",
    label: "Pattra Watch",
    targetId: LINE_FLEX_SANDBOX_TARGET_ID,
  },
  securityPrd: {
    key: "security_prd",
    label: "Security Pattra 8",
    targetId: LINE_FLEX_SECURITY_PRODUCTION_TARGET_ID,
  },
  pattraVillaPrd: {
    key: "pattra_villa_prd",
    label: "Pattra Villa 8",
    targetId: LINE_FLEX_PATTRA_PAY_PRODUCTION_TARGET_ID,
  },
});
const LINE_FLEX_ROUTE_DEFAULTS = Object.freeze({
  daily: "prd",
  night: "prd",
  guardDay: "prd",
  guardNight: "prd",
  pattraPay: "sandbox",
  pattraReport: "sandbox",
});
/**
 * Returns the default LINE flex config for each flow.
 * @return {Object<string, {
 *   sandboxTargetId: string,
 *   productionTargetId: string,
 *   activeMode: string,
 * }>}
 */
function getDefaultLineFlexFlows() {
  return {
    daily: {
      sandboxTargetId: LINE_FLEX_TARGETS.sandbox.targetId,
      productionTargetId: LINE_FLEX_TARGETS.securityPrd.targetId,
      activeMode: "prd",
    },
    night: {
      sandboxTargetId: LINE_FLEX_TARGETS.sandbox.targetId,
      productionTargetId: LINE_FLEX_TARGETS.securityPrd.targetId,
      activeMode: "prd",
    },
    guardDay: {
      sandboxTargetId: LINE_FLEX_TARGETS.sandbox.targetId,
      productionTargetId: LINE_FLEX_TARGETS.securityPrd.targetId,
      activeMode: "prd",
    },
    guardNight: {
      sandboxTargetId: LINE_FLEX_TARGETS.sandbox.targetId,
      productionTargetId: LINE_FLEX_TARGETS.securityPrd.targetId,
      activeMode: "prd",
    },
    pattraPay: {
      sandboxTargetId: LINE_FLEX_TARGETS.sandbox.targetId,
      productionTargetId: LINE_FLEX_TARGETS.pattraVillaPrd.targetId,
      activeMode: "sandbox",
    },
    pattraReport: {
      sandboxTargetId: LINE_FLEX_TARGETS.sandbox.targetId,
      productionTargetId: LINE_FLEX_TARGETS.securityPrd.targetId,
      activeMode: "sandbox",
    },
  };
}
// 2026-06-24 ไม้กั้นปิดปรับปรุง — ระงับ LINE push ของ Daily/Night ชั่วคราว.
// scheduler ยังสร้าง/บันทึกรายงานตามปกติ (lineSent=false) เพื่อความต่อเนื่อง
// ของข้อมูล แต่ไม่ส่งเข้า LINE production. เปิดกลับ: ตั้งค่าเป็น false แล้ว
// deploy เฉพาะ dailyTrafficSummary,overnightSecuritySummary. Manual
// lprWatchRun ยังสั่ง push ได้ตามปกติ (ไม่ผูกกับค่านี้).
const REPORT_PUSH_PAUSED = false;
const RESIDENT_SHEET_ID = "1NU6B7Yf225JGOpgqmQVLrHJl2tvxPtRR1gbtmBjYZyo";
const RESIDENT_SHEET_RANGE = "Residents!A:G";
const ANNOUNCEMENT_CHANNEL = "line_pr";
const MAX_ANNOUNCEMENT_IMAGES = 5;
const MAX_ANNOUNCEMENT_IMAGE_BYTES = 8 * 1024 * 1024;
const RESIDENT_HEADERS = [
  "house_no",
  "name",
  "email",
  "phone",
  "deed_no",
  "zone",
  "plot",
];
const GITHUB_OWNER = "pattra8";
const GITHUB_REPO = "pattra8.github.io";
const LPR_AGENT_C_TEST_TARGET_ID = "Cc8b4fea6ca64611a006388a9c46d8bbe";
const VISITOR_INTAKE_SESSION_WINDOW_MS = 3 * 60 * 1000;
const VISITOR_INTAKE_IMAGE_RETENTION_DAYS = 90;
const VISITOR_INTAKE_METADATA_RETENTION_DAYS = 365;
const LINE_WEBHOOK_EVENT_RETENTION_DAYS = 7;
// LPR capture images are the bulk of Storage usage. Purge them after 90 days
// while keeping the lightweight event metadata, which reports still read.
const LPR_IMAGE_RETENTION_DAYS = 90;
const VERTEX_VISION_MODEL = "gemini-3-flash-preview";
const VERTEX_VISION_LOCATION = "global";
const LPR_VISION_MIN_CONFIDENCE = 0.72;
const vertexAuth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});
const FORGOT_PIN_RATE_LIMIT = 20;
const FORGOT_PIN_WINDOW_MS = 60 * 60 * 1000;
const MAX_SIGNATURE_DATA_URL_BYTES = 350 * 1024;
const LPR_CAMERAS = [
  "http://lpr.pattra8.com:8241",
  "http://lpr.pattra8.com:8242",
];
const LPR_USER = "admin";
const LPR_RETRY_BATCH_LIMIT = 25;
const MAX_ADMIN_DOCUMENT_BYTES = 15 * 1024 * 1024;
const ADMIN_DOCUMENT_TYPES = new Set(["insurance", "blueprints"]);
// ── Bulky Waste ──────────────────────────────────────────────────────────────
const MAX_BULKY_WASTE_PHOTOS = 40; // total cap across all items
const MAX_BULKY_WASTE_PHOTOS_PER_ITEM = 8;
const MAX_BULKY_WASTE_PHOTO_BYTES = 8 * 1024 * 1024;
// Simplified to two states: submitted (ส่งคำขอมา) / completed (รับของไปแล้ว).
// Legacy values still accepted for display of older docs.
const BULKY_WASTE_STATUSES = new Set(["submitted", "completed"]);
const MAX_BULKY_WASTE_ITEMS = 30;

/**
 * Gets an access token for the function service account.
 * @return {Promise<string>}
 */
async function getServiceAccountToken() {
  const response = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/" +
      "service-accounts/default/token",
      {
        headers: {
          "Metadata-Flavor": "Google",
        },
      },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Metadata token failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Calls the Google Sheets API with the function service account token.
 * @param {string} url
 * @param {Object} options
 * @return {Promise<*>}
 */
async function callSheetsApi(url, options = {}) {
  const token = await getServiceAccountToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(
        `Sheets API failed (${response.status}): ${JSON.stringify(data)}`,
    );
  }

  return data;
}

/**
 * Converts a resident record into the sheet column order.
 * @param {Object} record
 * @return {string[]}
 */
function buildResidentRow(record) {
  return RESIDENT_HEADERS.map((header) =>
    String(record[header] || "").trim().replace(/\.0$/, ""),
  );
}

/**
 * Builds a LINE text message from issue data.
 * @param {string} issueType
 * @param {Object} data
 * @return {string}
 */
function buildLineMessage(issueType, data) {
  const house = data.house || "ไม่ระบุ";
  const category = data.cat || data.category || "ไม่ระบุ";
  const title = data.title || "ไม่มีหัวข้อ";
  const description = data.desc || data.description || "-";
  const priority = data.priority === "urgent" ?
    "ด่วนมาก" :
    data.priority === "high" ? "ด่วน" : "ปกติ";
  const date = data.date || new Date().toLocaleDateString("th-TH-u-ca-gregory");

  return [
    `📢 ${issueType}`,
    `🏠 บ้านเลขที่: ${house}`,
    `🏷️ หมวดหมู่: ${category}`,
    `📌 หัวข้อ: ${title}`,
    `📝 รายละเอียด: ${description}`,
    `⚡ ระดับความเร่งด่วน: ${priority}`,
    `📅 วันที่แจ้ง: ${date}`,
    "🔗 https://pattra8.github.io/report/",
  ].join("\n");
}

/**
 * Sends a LINE push message.
 * @param {string} to
 * @param {string} text
 * @return {Promise<void>}
 */
async function sendLinePush(to, text) {
  await sendLinePushMessages(to, [
    {
      type: "text",
      text: text.slice(0, 4900),
    },
  ]);
}

/**
 * Sends one or more LINE push messages, chunked to LINE's 5-message limit.
 * @param {string} to
 * @param {Object[]} messages
 * @return {Promise<void>}
 */
async function sendLinePushMessages(to, messages) {
  const chunks = [];
  for (let index = 0; index < messages.length; index += 5) {
    chunks.push(messages.slice(index, index + 5));
  }

  for (const chunk of chunks) {
    await callLinePush(to, chunk);
  }
}

/**
 * Calls the LINE push API.
 * @param {string} to
 * @param {Object[]} messages
 * @return {Promise<void>}
 */
async function callLinePush(to, messages) {
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN.value()}`,
    },
    body: JSON.stringify({
      to,
      messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LINE push failed (${response.status}): ${body}`);
  }
}

/**
 * Parses a data URL upload from the PR admin page.
 * @param {Object} media
 * @return {{buffer: Buffer, contentType: string, extension: string}}
 */
function parseAnnouncementImage(media) {
  const dataUrl = String(media.dataUrl || "");
  const match = dataUrl.match(/^data:(image\/(?:jpeg|jpg|png));base64,(.+)$/);

  if (!match) {
    throw new Error("Only JPG and PNG images are supported right now");
  }

  const contentType = match[1] === "image/jpg" ? "image/jpeg" : match[1];
  const buffer = Buffer.from(match[2], "base64");

  if (!buffer.length || buffer.length > MAX_ANNOUNCEMENT_IMAGE_BYTES) {
    throw new Error("Image is too large");
  }

  return {
    buffer,
    contentType,
    extension: contentType === "image/png" ? "png" : "jpg",
  };
}

/**
 * Uploads announcement images to Firebase Storage and returns public URLs.
 * @param {string} announcementId
 * @param {Object[]} media
 * @param {string} storageFolder
 * @return {Promise<Object[]>}
 */
async function uploadAnnouncementImages(
    announcementId,
    media,
    storageFolder = "announcements",
) {
  const bucket = admin.storage().bucket();
  const images = Array.isArray(media) ?
    media.slice(0, MAX_ANNOUNCEMENT_IMAGES) :
    [];
  const uploaded = [];

  for (let index = 0; index < images.length; index++) {
    const parsed = parseAnnouncementImage(images[index]);
    const token = crypto.randomUUID();
    const objectPath = `${storageFolder}/${announcementId}/` +
      `${Date.now()}-${index}.${parsed.extension}`;
    const file = bucket.file(objectPath);

    await file.save(parsed.buffer, {
      resumable: false,
      metadata: {
        contentType: parsed.contentType,
        metadata: {
          firebaseStorageDownloadTokens: token,
        },
      },
    });

    const url = "https://firebasestorage.googleapis.com/v0/b/" +
      `${bucket.name}/o/${encodeURIComponent(objectPath)}?alt=media&` +
      `token=${token}`;

    uploaded.push({
      type: "image",
      url,
      storagePath: objectPath,
      contentType: parsed.contentType,
    });
  }

  return uploaded;
}

/**
 * Builds a polite LINE announcement text message.
 * @param {Object} data
 * @return {string}
 */
function buildAnnouncementText(data) {
  const title = String(data.title || "").trim();
  const category = String(data.category || "ทั่วไป").trim();
  const message = String(data.message || "").trim();
  const date = new Date().toLocaleString("th-TH-u-ca-gregory", {
    timeZone: "Asia/Bangkok",
    dateStyle: "medium",
    timeStyle: "short",
  });

  return [
    "ประชาสัมพันธ์จากนิติบุคคล Pattra Villa 8",
    `หมวดหมู่: ${category}`,
    title ? `หัวข้อ: ${title}` : "",
    message,
    `วันที่ส่ง: ${date}`,
  ].filter(Boolean).join("\n\n").slice(0, 4900);
}

/**
 * Allows only the nitibukkol resident account (38/8) to use admin workflows.
 * @param {Object} body
 * @param {string} permission
 * @return {Promise<Object>}
 */
async function verifyAdminResidentAccess(body, permission = "admin.portal") {
  const houseNo = normalizeHouseNo(
      body.adminHouseNo || body.authHouseNo || body.houseNo,
  );
  const pin = String(body.adminPin || body.authPin || body.pin || "");
  await verifyResidentPinInternal(houseNo, pin);
  const access = await getAdminAccess(houseNo);
  if (access.active && access.permissions["admin.portal"] &&
      access.permissions[permission]) {
    return access;
  }

  const err = new Error("Unauthorized");
  err.status = 403;
  throw err;
}

/**
 * Allows committee members to read shared management documents while keeping
 * all document changes restricted to the nitibukkol account.
 * @param {Object} body
 * @return {Promise<{houseNo: string, role: string, canWrite: boolean}>}
 */
async function verifyCommitteeResidentAccess(body) {
  const houseNo = normalizeHouseNo(
      body.adminHouseNo || body.authHouseNo || body.houseNo,
  );
  const pin = String(body.adminPin || body.authPin || body.pin || "");
  await verifyResidentPinInternal(houseNo, pin);
  const access = await getAdminAccess(houseNo);
  const vaultType = String(body.vaultType || "").trim();
  const canRead = access.active &&
    Boolean(access.permissions[`${vaultType}.view`]);
  if (!canRead) {
    const err = new Error("Unauthorized");
    err.status = 403;
    throw err;
  }

  return {
    houseNo,
    role: access.roleLabel,
    canWrite: Boolean(access.permissions[`${vaultType}.manage`]),
  };
}

/**
 * Loads one access record, falling back to the initial authorization matrix.
 * @param {string} houseNo
 * @return {Promise<Object>}
 */
async function getAdminAccess(houseNo) {
  const cleanHouseNo = normalizeHouseNo(houseNo);
  const docId = residentPinDocId(cleanHouseNo);
  const snap = await db.collection(ADMIN_ACCESS_COLLECTION).doc(docId).get();
  const stored = snap.exists ? snap.data() || {} : null;
  const defaults = ADMIN_ACCESS_DEFAULTS[cleanHouseNo] || {};
  const permissions = normalizeAdminPermissions(
      stored ? stored.permissions : defaults.permissions,
  );

  return {
    houseNo: cleanHouseNo,
    roleLabel: String(
        (stored && stored.roleLabel) || defaults.roleLabel || "ผู้ดูแล",
    ).trim().slice(0, 80),
    active: stored ? stored.active !== false : Boolean(defaults.permissions),
    permissions,
    isDefault: Boolean(ADMIN_ACCESS_DEFAULTS[cleanHouseNo]),
  };
}

/**
 * Keeps matrix management anchored to the current superadmin account.
 * @param {Object} body
 * @return {Promise<void>}
 */
async function verifyAccessMatrixManager(body) {
  const houseNo = normalizeHouseNo(
      body.adminHouseNo || body.authHouseNo || body.houseNo,
  );
  const pin = String(body.adminPin || body.authPin || body.pin || "");
  if (houseNo !== "38/8") {
    const err = new Error("Unauthorized");
    err.status = 403;
    throw err;
  }
  await verifyResidentPinInternal(houseNo, pin);
}

/**
 * Keeps uploaded filenames readable while preventing path traversal.
 * @param {string} fileName
 * @return {string}
 */
function sanitizeFileName(fileName) {
  const safe = String(fileName || "document")
      .normalize("NFKC")
      .replace(/[\\/:*?"<>|#%{}^~[\]`]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  return safe.slice(0, 140) || "document";
}

/**
 * Converts a browser data URL into a storage-ready payload.
 * @param {string} dataUrl
 * @return {{buffer: Buffer, contentType: string}}
 */
function parseAdminDocumentDataUrl(dataUrl) {
  const match = String(dataUrl || "")
      .match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new Error("Invalid file data");
  }
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) {
    throw new Error("Empty file");
  }
  if (buffer.length > MAX_ADMIN_DOCUMENT_BYTES) {
    throw new Error("File is too large");
  }
  return {buffer, contentType: match[1]};
}

/**
 * Validates the PR announcement send request.
 * @param {Object} body
 * @return {void}
 */
async function validateAnnouncementRequest(body) {
  await verifyAdminResidentAccess(body, "admin.announcements");
  const title = String(body.title || "").trim();
  const message = String(body.message || "").trim();
  const media = Array.isArray(body.media) ? body.media : [];

  if (!title) {
    throw new Error("Missing title");
  }

  if (!message && !media.length) {
    throw new Error("Missing message or media");
  }

  if (media.length > MAX_ANNOUNCEMENT_IMAGES) {
    throw new Error(`Maximum ${MAX_ANNOUNCEMENT_IMAGES} images`);
  }
}

/**
 * Normalizes plate inputs from strings or arrays.
 * @param {*} value
 * @return {string[]}
 */
function normalizePlateArray(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(raw
      .flatMap((item) => String(item || "").split(/[,;\n\r]+/))
      .map((item) => item.normalize("NFKC")
          .replace(/[\u200B-\u200D\uFEFF]/g, "")
          .replace(/[\s-]/g, "")
          .trim()
          .toUpperCase())
      .filter(Boolean))];
}

/**
 * Key used for a per-vehicle update timestamp.
 * @param {string} type Vehicle type: car or moto.
 * @param {string} plate License plate.
 * @return {string} Stable, normalized vehicle key.
 */
function vehicleUpdatedAtKey(type, plate) {
  const normalized = normalizePlateArray([plate])[0] || "";
  return normalized ? `${type}:${normalized}` : "";
}

/**
 * Preserves legacy house-level timestamps while migrating to per-vehicle ones.
 * @param {object} resident Resident document data.
 * @return {object} Per-vehicle ISO timestamps.
 */
function residentVehicleUpdatedAt(resident) {
  const timestamps = {...(resident.vehicle_updated_at || {})};
  const legacyTimestamp = String(resident.last_updated || "");
  if (!legacyTimestamp) return timestamps;
  normalizePlateArray(resident.cars).forEach((plate) => {
    const key = vehicleUpdatedAtKey("car", plate);
    if (key && !timestamps[key]) timestamps[key] = legacyTimestamp;
  });
  normalizePlateArray(resident.motorcycles).forEach((plate) => {
    const key = vehicleUpdatedAtKey("moto", plate);
    if (key && !timestamps[key]) timestamps[key] = legacyTimestamp;
  });
  return timestamps;
}

/**
 * Compares audit values using the same semantics as resident data.
 * Vehicle plates are unordered sets, so changing only their order is not a
 * resident-data change and should not pollute the activity log.
 * @param {string} key Resident field name.
 * @param {*} before Stored value before the update.
 * @param {*} after Normalized value submitted in the patch.
 * @return {boolean} Whether both values represent the same data.
 */
function residentAuditValuesEqual(key, before, after) {
  if (key === "cars" || key === "motorcycles") {
    const oldPlates = normalizePlateArray(before).sort();
    const newPlates = normalizePlateArray(after).sort();
    return JSON.stringify(oldPlates) === JSON.stringify(newPlates);
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    return JSON.stringify(before || []) === JSON.stringify(after || []);
  }
  const beforeText = before === undefined || before === null ? "" : before;
  const afterText = after === undefined || after === null ? "" : after;
  return String(beforeText) === String(afterText);
}

/**
 * Normalizes a house number for resident auth lookup.
 * @param {string} houseNo
 * @return {string}
 */
function normalizeHouseNo(houseNo) {
  return String(houseNo || "").trim().replace(/\s+/g, "");
}

/**
 * Converts a house number into a Firestore-safe document id.
 * @param {string} houseNo
 * @return {string}
 */
function residentPinDocId(houseNo) {
  return normalizeHouseNo(houseNo).replace(/\//g, "_");
}

/**
 * Generates a random six-digit resident PIN.
 * @return {string}
 */
function generateResidentPin() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

/**
 * Hashes a resident PIN with a per-house salt.
 * @param {string} pin
 * @param {string} salt
 * @return {string}
 */
function hashResidentPin(pin, salt) {
  return crypto
      .createHash("sha256")
      .update(`${salt}:${String(pin || "")}`)
      .digest("hex");
}

/**
 * Validates resident PIN input shape.
 * @param {string} pin
 * @return {string}
 */
function normalizeResidentPin(pin) {
  const clean = String(pin || "").trim();
  if (!/^\d{6}$/.test(clean)) {
    throw new Error("PIN must be 6 digits");
  }
  return clean;
}

/**
 * Validates an in-browser e-signature data URL before storing it.
 * @param {string} signatureDataUrl
 * @return {string}
 */
function normalizeSignatureDataUrl(signatureDataUrl) {
  const value = String(signatureDataUrl || "").trim();
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)) {
    throw new Error("Invalid signature");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_SIGNATURE_DATA_URL_BYTES) {
    throw new Error("Signature is too large");
  }
  return value;
}

/**
 * Gets the per-house resident signature document ref.
 * @param {string} houseNo
 * @return {FirebaseFirestore.DocumentReference}
 */
function getResidentSignatureRef(houseNo) {
  return db
      .collection(RESIDENT_SIGNATURE_COLLECTION)
      .doc(residentPinDocId(houseNo));
}

/**
 * Normalizes text for resident identity checks.
 * @param {string} value
 * @return {string}
 */
function normalizeIdentityText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * Normalizes phone for resident identity checks.
 * @param {string} value
 * @return {string}
 */
function normalizeIdentityPhone(value) {
  return String(value || "").replace(/\D/g, "");
}

/**
 * Checks whether a resident-provided answer matches stored resident data.
 * @param {string} stored
 * @param {string} answer
 * @param {"text"|"email"|"phone"} type
 * @return {boolean}
 */
function residentIdentityMatches(stored, answer, type) {
  if (!stored || !answer) return false;
  if (type === "phone") {
    return normalizeIdentityPhone(stored) === normalizeIdentityPhone(answer);
  }
  return normalizeIdentityText(stored) === normalizeIdentityText(answer);
}

/**
 * Escapes XML text content.
 * @param {string} value
 * @return {string}
 */
function escapeXml(value) {
  return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
}

/**
 * Parses a Digest WWW-Authenticate header into a key/value object.
 * @param {string} header
 * @return {Object}
 */
function parseDigestChallenge(header) {
  const challenge = String(header || "").replace(/^Digest\s+/i, "");
  const params = {};
  const matcher = /(\w+)=("([^"]*)"|([^,]*))/g;
  let match;

  while ((match = matcher.exec(challenge)) !== null) {
    params[match[1]] = match[3] !== undefined ? match[3] : match[4];
  }

  return params;
}

/**
 * Computes an HTTP Digest Authorization header.
 * @param {Object} params
 * @param {Object} options
 * @return {string}
 */
function buildDigestAuth(params, options) {
  const cnonce = crypto.randomBytes(8).toString("hex");
  const nc = "00000001";
  const qop = String(params.qop || "auth").split(",")[0].trim() || "auth";
  const algorithm = params.algorithm || "MD5";
  const ha1 = crypto.createHash("md5")
      .update(`${options.username}:${params.realm}:${options.password}`)
      .digest("hex");
  const ha2 = crypto.createHash("md5")
      .update(`${options.method}:${options.uri}`)
      .digest("hex");
  const response = crypto.createHash("md5")
      .update(`${ha1}:${params.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
      .digest("hex");

  return [
    `Digest username="${options.username}"`,
    `realm="${params.realm}"`,
    `nonce="${params.nonce}"`,
    `uri="${options.uri}"`,
    `algorithm=${algorithm}`,
    `response="${response}"`,
    `qop=${qop}`,
    `nc=${nc}`,
    `cnonce="${cnonce}"`,
    params.opaque !== undefined ? `opaque="${params.opaque}"` : "",
  ].filter(Boolean).join(", ");
}

/**
 * Calls a Hikvision ISAPI endpoint using HTTP Digest auth.
 * @param {string} cameraBase
 * @param {string} path
 * @param {Object} options
 * @return {Promise<{status: number, text: string}>}
 */
async function hikvisionFetch(cameraBase, path, options = {}) {
  const url = `${cameraBase}${path}`;
  const method = options.method || "GET";
  const requestTimeoutMs = 5000;
  const first = await fetch(url, {
    method,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  if (first.status !== 401) {
    const text = await first.text();
    return {status: first.status, text};
  }

  const challenge = parseDigestChallenge(first.headers.get("www-authenticate"));
  const auth = buildDigestAuth(challenge, {
    username: LPR_USER,
    password: LPR_ADMIN_PASSWORD.value(),
    method,
    uri: path,
  });

  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: {
      "Authorization": auth,
      ...(options.headers || {}),
    },
    body: options.body,
  });
  const text = await response.text();
  return {status: response.status, text};
}

/**
 * Fetches a Hikvision ISAPI binary resource (e.g. a JPEG snapshot) using
 * HTTP Digest auth. Kept separate from hikvisionFetch because reading a
 * binary body as text (response.text()) corrupts it.
 * @param {string} cameraBase
 * @param {string} path
 * @param {number} [timeoutMs]
 * @return {Promise<{status: number, bytes: number}>}
 */
async function hikvisionFetchBinary(cameraBase, path, timeoutMs = 6000) {
  const url = `${cameraBase}${path}`;
  const first = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (first.status !== 401) {
    const buf = Buffer.from(await first.arrayBuffer());
    return {status: first.status, bytes: buf.length};
  }
  const challenge = parseDigestChallenge(first.headers.get("www-authenticate"));
  const auth = buildDigestAuth(challenge, {
    username: LPR_USER,
    password: LPR_ADMIN_PASSWORD.value(),
    method: "GET",
    uri: path,
  });
  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {"Authorization": auth},
  });
  const buf = Buffer.from(await response.arrayBuffer());
  return {status: response.status, bytes: buf.length};
}

/**
 * Verifies that the submitted GitHub token can read the resident data repo.
 * @param {string} token
 * @return {Promise<void>}
 */
async function validateGithubToken(token) {
  const cleanToken = String(token || "").trim();
  if (!cleanToken) {
    throw new Error("Missing GitHub token");
  }

  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;
  const response = await fetch(url, {
    headers: {
      "Authorization": `token ${cleanToken}`,
      "Accept": "application/vnd.github.v3+json",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub token rejected (${response.status})`);
  }
}

/**
 * Searches one camera for a plate.
 * @param {string} cameraBase
 * @param {string} plate
 * @return {Promise<boolean>}
 */
async function lprPlateExists(cameraBase, plate) {
  const body = "<LPListAuditSearchDescription>" +
    "<maxResults>20</maxResults>" +
    "<searchResultPosition>0</searchResultPosition>" +
    "<searchID>0</searchID>" +
    `<LicensePlate>${escapeXml(plate)}</LicensePlate>` +
    "</LPListAuditSearchDescription>";
  const result = await hikvisionFetch(
      cameraBase,
      "/ISAPI/Traffic/channels/1/searchLPListAudit",
      {
        method: "POST",
        headers: {"Content-Type": "application/xml; charset=UTF-8"},
        body,
      },
  );

  if (result.status !== 200) {
    throw new Error(`search failed (${result.status}): ${result.text}`);
  }

  const match = result.text.match(/<totalMatches>(\d+)<\/totalMatches>/);
  return Number(match && match[1] || 0) > 0;
}

/**
 * Decodes the small XML entity set used by Hikvision ISAPI responses.
 * @param {string} value
 * @return {string}
 */
function decodeXmlText(value) {
  return String(value || "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
}

/**
 * Reads the complete allowlist from one camera using paginated ISAPI search.
 * @param {string} cameraBase
 * @return {Promise<Object>}
 */
async function fetchLprAllowlist(cameraBase) {
  const pageSize = 100;
  const rawPlates = [];
  let totalMatches = null;

  for (let position = 0; position < 5000; position += pageSize) {
    const body = "<LPListAuditSearchDescription>" +
      `<maxResults>${pageSize}</maxResults>` +
      `<searchResultPosition>${position}</searchResultPosition>` +
      "<searchID>daily-reconciliation</searchID>" +
      "</LPListAuditSearchDescription>";
    const result = await hikvisionFetch(
        cameraBase,
        "/ISAPI/Traffic/channels/1/searchLPListAudit",
        {
          method: "POST",
          headers: {"Content-Type": "application/xml; charset=UTF-8"},
          body,
        },
    );
    if (result.status !== 200) {
      throw new Error(`allowlist fetch failed (${result.status})`);
    }

    const totalMatch = result.text.match(
        /<totalMatches>(\d+)<\/totalMatches>/,
    );
    if (totalMatches === null) {
      totalMatches = Number(totalMatch && totalMatch[1] || 0);
    }
    const plateMatches = result.text.matchAll(
        /<LicensePlate>([\s\S]*?)<\/LicensePlate>/g,
    );
    const pagePlates = [...plateMatches]
        .map((match) => decodeXmlText(match[1]).trim())
        .filter(Boolean);
    rawPlates.push(...pagePlates);

    if (!pagePlates.length || rawPlates.length >= totalMatches) break;
  }

  const normalizedPlates = rawPlates
      .map((plate) => normalizePlateArray([plate])[0] || "")
      .filter(Boolean);
  const counts = {};
  normalizedPlates.forEach((plate) => {
    counts[plate] = (counts[plate] || 0) + 1;
  });

  return {
    camera: cameraBase,
    totalRecords: rawPlates.length,
    totalMatches: totalMatches || 0,
    plates: [...new Set(normalizedPlates)].sort(),
    duplicates: Object.entries(counts)
        .filter(([, count]) => count > 1)
        .map(([plate, count]) => ({plate, count})),
    formatWarnings: rawPlates
        .filter((plate) => (normalizePlateArray([plate])[0] || "") !== plate)
        .map((plate) => ({
          raw: plate,
          normalized: normalizePlateArray([plate])[0],
        })),
  };
}

/**
 * Adds one allowlist plate to one camera.
 * @param {string} cameraBase
 * @param {string} plate
 * @return {Promise<Object>}
 */
async function lprAddPlate(cameraBase, plate) {
  if (await lprPlateExists(cameraBase, plate)) {
    return {plate, action: "skip", reason: "exists"};
  }

  const now = new Date().toISOString().slice(0, 19);
  const payload = {
    LicensePlateInfoList: [{
      listType: "allowList",
      LicensePlate: plate,
      cardNo: "",
      cardID: "",
      plateType: "92TypeCivil",
      plateColor: "blue",
      plateDescription: "",
      name: "",
      certificateType: "ID",
      certificateNumber: "",
      operationType: "add",
      virtualParkingNum: "",
      groupName: "weifenzu",
      createTime: now,
      effectiveStartDate: "1970-01-01T00:00:00",
      effectiveTime: "2099-12-30T00:00:00",
      operation: "new",
    }],
  };
  const result = await hikvisionFetch(
      cameraBase,
      "/ISAPI/Traffic/channels/1/licensePlateAuditData/record?format=json",
      {
        method: "PUT",
        headers: {"Content-Type": "application/json; charset=UTF-8"},
        body: JSON.stringify(payload),
      },
  );
  const data = JSON.parse(result.text || "{}");

  if (result.status !== 200 || data.statusCode !== 1) {
    throw new Error(`add ${plate} failed (${result.status}): ${result.text}`);
  }

  return {plate, action: "add"};
}

/**
 * Removes one plate from one camera if present.
 * @param {string} cameraBase
 * @param {string} plate
 * @return {Promise<Object>}
 */
async function lprRemovePlate(cameraBase, plate) {
  if (!(await lprPlateExists(cameraBase, plate))) {
    return {plate, action: "skip", reason: "missing"};
  }

  const payload = {
    deleteAllEnabled: false,
    licensePlate: [plate],
  };
  const result = await hikvisionFetch(
      cameraBase,
      "/ISAPI/Traffic/channels/1/DelLicensePlateAuditData?format=json",
      {
        method: "PUT",
        headers: {"Content-Type": "application/json; charset=UTF-8"},
        body: JSON.stringify(payload),
      },
  );
  const data = JSON.parse(result.text || "{}");

  if (result.status !== 200 || data.statusCode !== 1) {
    throw new Error(
        `remove ${plate} failed (${result.status}): ${result.text}`,
    );
  }

  return {plate, action: "remove"};
}

/**
 * Syncs car plate differences to all configured LPR cameras.
 * @param {Object} params
 * @return {Promise<Object>}
 */
async function syncLprCarDiff({houseNo, oldCars, newCars, allCars}) {
  const normalizedOldCars = normalizePlateArray(oldCars);
  const normalizedNewCars = normalizePlateArray(newCars);
  const allCarSet = new Set(normalizePlateArray(allCars));
  const oldSet = new Set(normalizedOldCars);
  const newSet = new Set(normalizedNewCars);
  const toAdd = normalizedNewCars.filter((plate) => !oldSet.has(plate));
  const toRemove = normalizedOldCars.filter((plate) =>
    !newSet.has(plate) && !allCarSet.has(plate),
  );
  const results = [];

  // Retry a camera op up to MAX_ATTEMPTS with exponential backoff.
  // Handles transient camera/network failures (most common failure mode).
  const MAX_ATTEMPTS = 3;
  const runWithRetry = async (fn, plate, action) => {
    const attempts = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return {ok: true, result: await fn()};
      } catch (error) {
        attempts.push(`attempt ${attempt}: ${error.message}`);
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
    }
    return {
      ok: false,
      error: {plate, action, error: attempts.join(" | ")},
    };
  };

  for (const camera of LPR_CAMERAS) {
    const cameraResult = {camera, added: [], removed: [], errors: []};

    // Always reconcile the resident's full current car list. This heals cases
    // where a plate already existed in Firestore but went missing from a
    // camera allowlist, which a pure diff-only sync would never re-add.
    for (const plate of normalizedNewCars) {
      const r = await runWithRetry(
          () => lprAddPlate(camera, plate), plate, "add",
      );
      if (r.ok) cameraResult.added.push(r.result);
      else cameraResult.errors.push(r.error);
    }

    for (const plate of toRemove) {
      const r = await runWithRetry(
          () => lprRemovePlate(camera, plate), plate, "remove",
      );
      if (r.ok) cameraResult.removed.push(r.result);
      else cameraResult.errors.push(r.error);
    }

    results.push(cameraResult);
  }

  const errorCount = results.reduce(
      (total, item) => total + item.errors.length,
      0,
  );

  return {
    ok: errorCount === 0,
    houseNo: String(houseNo || ""),
    toAdd,
    toRemove,
    results,
  };
}

/**
 * Builds the current project-wide car plate list, optionally overriding
 * one resident's car list with fresh values before syncing.
 * @param {string} houseNo
 * @param {string[]} overrideCars
 * @return {Promise<string[]>}
 */
async function buildAllCarsForSync(houseNo, overrideCars = []) {
  const targetHouseNo = normalizeHouseNo(houseNo);
  const allResidentsSnap = await db.collection(RESIDENTS_COLLECTION).get();
  const allCars = [];

  allResidentsSnap.docs.forEach((residentDoc) => {
    const item = residentDoc.data() || {};
    const itemHouseNo = normalizeHouseNo(item.house_no || item.houseNo);
    if (itemHouseNo === targetHouseNo) {
      normalizePlateArray(overrideCars).forEach((plate) => allCars.push(plate));
      return;
    }
    normalizePlateArray(item.cars || [])
        .forEach((plate) => allCars.push(plate));
  });

  return allCars;
}

/**
 * Syncs one resident's car list into both LPR cameras and stores the result
 * back on the resident document.
 * @param {FirebaseFirestore.DocumentReference} residentDocRef
 * @param {string} houseNo
 * @param {string[]} oldCars
 * @param {string[]} newCars
 * @return {Promise<Object>}
 */
async function syncResidentCarsToLpr(
    residentDocRef, houseNo, oldCars, newCars) {
  const normalizedHouseNo = normalizeHouseNo(houseNo);
  const normalizedOldCars = normalizePlateArray(oldCars);
  const normalizedNewCars = normalizePlateArray(newCars);
  const allCars = await buildAllCarsForSync(
      normalizedHouseNo, normalizedNewCars);
  const result = await syncLprCarDiff({
    houseNo: normalizedHouseNo,
    oldCars: normalizedOldCars,
    newCars: normalizedNewCars,
    allCars,
  });

  const patch = {
    lpr_sync_pending: !result.ok,
    lpr_last_sync: new Date().toISOString(),
  };
  if (result.ok) {
    patch.lpr_last_error = "";
  } else {
    const errorSummary = result.results
        .flatMap((cameraResult) => (cameraResult.errors || []).map((err) =>
          `${cameraResult.camera} ${err.action} ${err.plate}: ${err.error}`,
        ))
        .join(" | ");
    patch.lpr_last_error = errorSummary.slice(0, 4000);
  }
  await residentDocRef.set(patch, {merge: true});
  return result;
}

/**
 * Retries LPR sync for one resident doc already marked as pending.
 * @param {FirebaseFirestore.QueryDocumentSnapshot} residentDoc
 * @return {Promise<Object>}
 */
async function retryPendingLprSyncForResident(residentDoc) {
  const resident = residentDoc.data() || {};
  const houseNo = normalizeHouseNo(resident.house_no || resident.houseNo || "");
  if (!houseNo) {
    return {ok: false, houseNo: "", error: "Missing house number"};
  }

  const cars = normalizePlateArray(resident.cars || []);
  const result = await syncResidentCarsToLpr(
      residentDoc.ref, houseNo, cars, cars);

  const patch = {
    lpr_last_retry_at: new Date().toISOString(),
    lpr_sync_retry_count: admin.firestore.FieldValue.increment(1),
  };

  await residentDoc.ref.set(patch, {merge: true});

  // This function only runs for residents already flagged lpr_sync_pending,
  // so a successful result here is a recovery from an earlier failed sync.
  // Record it in the admin audit log so the prior "Failed" entry is followed
  // by a visible success, even though the retry is automatic.
  if (result.ok) {
    const prevRetries = Number(resident.lpr_sync_retry_count || 0);
    writeAuditLog("admin_resident_lpr_resync", houseNo, {
      source: "retryPendingLprSync",
      cars,
      added: result.toAdd,
      removed: result.toRemove,
      retryCount: prevRetries + 1,
      note: "Auto-retry succeeded: LPR camera sync recovered",
    }, true);
  }

  return result;
}

/**
 * Backstops resident car edits that bypass the normal resident/admin update
 * endpoints, so direct Firestore writes still reach both LPR cameras.
 */
exports.residentLprSyncBackfill = onDocumentUpdated(
    {
      document: `${RESIDENTS_COLLECTION}/{residentId}`,
      memory: "512MiB",
      timeoutSeconds: 120,
    },
    async (event) => {
      const before = event.data && event.data.before.data() || {};
      const after = event.data && event.data.after.data() || {};
      const beforeCars = normalizePlateArray(before.cars || []);
      const afterCars = normalizePlateArray(after.cars || []);
      if (beforeCars.length === afterCars.length &&
          beforeCars.every((plate, index) => plate === afterCars[index])) {
        return;
      }

      const writerRole = String(after.updatedBy || "").trim().toLowerCase();
      if ((writerRole === "resident" || writerRole === "admin") &&
          after.updatedByIp) {
        return;
      }

      const houseNo = normalizeHouseNo(after.house_no || after.houseNo || "");
      if (!houseNo) {
        return;
      }

      try {
        const result = await syncResidentCarsToLpr(
            event.data.after.ref, houseNo, beforeCars, afterCars);
        logger.info("residentLprSyncBackfill complete", {
          residentId: event.params.residentId,
          houseNo,
          added: result.toAdd,
          removed: result.toRemove,
        });
      } catch (error) {
        logger.warn("residentLprSyncBackfill failed", {
          residentId: event.params.residentId,
          houseNo,
          error: String(error.message || error),
        });
      }
    },
);

/**
 * Builds the canonical LPR plate set and house ownership map from Firestore.
 * @return {Promise<Object>}
 */
async function buildExpectedLprState() {
  const snap = await db.collection(RESIDENTS_COLLECTION).get();
  const plateHouses = {};

  snap.docs.forEach((docSnap) => {
    const resident = docSnap.data() || {};
    const houseNo = normalizeHouseNo(
        resident.house_no || resident.houseNo || "",
    );
    normalizePlateArray(resident.cars || []).forEach((plate) => {
      if (!plateHouses[plate]) plateHouses[plate] = [];
      if (houseNo && !plateHouses[plate].includes(houseNo)) {
        plateHouses[plate].push(houseNo);
      }
    });
  });

  const plates = Object.keys(plateHouses).sort();
  return {
    residentCount: snap.size,
    plates,
    plateHouses,
    duplicateAssignments: Object.entries(plateHouses)
        .filter(([, houses]) => houses.length > 1)
        .map(([plate, houses]) => ({plate, houses})),
  };
}

/**
 * Compares one camera's allowlist with Firestore master data.
 * @param {Object} cameraState
 * @param {Object} expectedState
 * @return {Object}
 */
function compareLprState(cameraState, expectedState) {
  const expectedSet = new Set(expectedState.plates);
  const cameraSet = new Set(cameraState.plates);
  return {
    ...cameraState,
    online: true,
    missing: expectedState.plates.filter((plate) => !cameraSet.has(plate)),
    extra: cameraState.plates.filter((plate) => !expectedSet.has(plate)),
  };
}

/**
 * Adds missing Firestore plates to one camera, without deleting camera-only
 * records. Each plate is idempotent because lprAddPlate checks first.
 * @param {string} camera
 * @param {string[]} missing
 * @return {Promise<Object>}
 */
async function repairMissingLprPlates(camera, missing) {
  const added = [];
  const errors = [];
  for (const plate of missing) {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await lprAddPlate(camera, plate);
        added.push(plate);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
        }
      }
    }
    if (lastError) {
      errors.push({
        plate,
        error: String(lastError.message || lastError).slice(0, 500),
      });
    }
  }
  return {added, errors};
}

/**
 * Builds a compact LINE Flex card for the daily LPR report.
 * @param {Object} report
 * @return {Object}
 */
function buildLprReconciliationFlexMessage(report) {
  const allOnline = report.cameras.every((camera) => camera.online);
  const remainingMissing = report.cameras.reduce(
      (sum, camera) => sum + camera.missing.length,
      0,
  );
  const autoHealed = [...new Set(report.cameras.flatMap(
      (camera) => camera.autoHealed || [],
  ))];
  const missing = [...new Set(report.cameras.flatMap(
      (camera) => camera.missing || [],
  ))];
  const lprOnlyCount = Math.max(
      ...report.cameras.map((camera) => camera.extra.length),
      0,
  );
  const ready = allOnline && remainingMissing === 0;
  const statusTitle = !allOnline ? "LPR บางตัว Offline" :
    ready ? "ระบบพร้อมใช้งาน" : "ยังมีทะเบียนขาด";
  const statusColor = !allOnline ? "#B42318" :
    ready ? "#2F6B3C" : "#9A6700";
  const headerColor = !allOnline ? "#FDECEC" :
    ready ? "#EDF5E8" : "#FFF4D6";
  const dateText = new Intl.DateTimeFormat("th-TH-u-ca-gregory", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  }).format(new Date(report.runAt));
  const bodyContents = [
    {
      type: "box",
      layout: "horizontal",
      contents: [
        {
          type: "text",
          text: "ข้อมูลในระบบ",
          size: "sm",
          color: "#6B7280",
          flex: 3,
        },
        {
          type: "text",
          text: `${report.expectedCount} ทะเบียน · ` +
            `${report.residentCount} บ้าน`,
          size: "sm",
          weight: "bold",
          color: "#25211D",
          align: "end",
          flex: 7,
        },
      ],
    },
    {type: "separator", margin: "lg", color: "#E8E1D7"},
  ];

  report.cameras.forEach((camera, index) => {
    const label = camera.camera.split(":").pop();
    const cameraMeta = label === "8241" ? {
      direction: "ขาเข้า",
      serialSuffix: "GF7297900",
    } : label === "8242" ? {
      direction: "ขาออก",
      serialSuffix: "GF7297916",
    } : {
      direction: "ไม่ทราบทิศ",
      serialSuffix: "",
    };
    bodyContents.push({
      type: "box",
      layout: "vertical",
      margin: index === 0 ? "lg" : "md",
      paddingAll: "12px",
      backgroundColor: camera.online ? "#F8F6F2" : "#FDECEC",
      cornerRadius: "8px",
      contents: [
        {
          type: "box",
          layout: "horizontal",
          contents: [
            {
              type: "text",
              text: `LPR ${label} · ${cameraMeta.direction}`,
              size: "md",
              weight: "bold",
              color: "#25211D",
            },
            {
              type: "text",
              text: camera.online ? "ONLINE" : "OFFLINE",
              size: "xs",
              weight: "bold",
              color: camera.online ? "#2F6B3C" : "#B42318",
              align: "end",
            },
          ],
        },
        {
          type: "text",
          text: cameraMeta.serialSuffix ?
            `Serial ...${cameraMeta.serialSuffix}` : "",
          size: "xxs",
          color: "#8A8178",
          margin: "xs",
        },
        {
          type: "text",
          text: camera.online ?
            `${camera.plates.length} รายการ  •  ` +
              `เติม ${camera.autoHealed.length}  •  ` +
              `ขาด ${camera.missing.length}  •  ` +
              `LPR-only ${camera.extra.length}` :
            String(camera.error || "เชื่อมต่อไม่ได้"),
          size: "sm",
          color: "#6B625A",
          margin: "sm",
          wrap: true,
        },
      ],
    });
  });

  if (autoHealed.length) {
    const values = autoHealed.map((plate) => {
      const houses = report.plateHouses[plate] || [];
      return houses.length ? `${plate} · บ้าน ${houses.join(", ")}` : plate;
    });
    bodyContents.push({
      type: "box",
      layout: "vertical",
      margin: "lg",
      paddingAll: "12px",
      backgroundColor: "#EDF5E8",
      cornerRadius: "8px",
      contents: [
        {
          type: "text",
          text: `เพิ่มอัตโนมัติแล้ว ${autoHealed.length} รายการ`,
          size: "sm",
          weight: "bold",
          color: "#2F6B3C",
        },
        {
          type: "text",
          text: values.join("\n"),
          size: "sm",
          color: "#43553F",
          margin: "sm",
          wrap: true,
        },
      ],
    });
  }

  if (missing.length) {
    const values = missing.map((plate) => {
      const houses = report.plateHouses[plate] || [];
      return houses.length ? `${plate} · บ้าน ${houses.join(", ")}` : plate;
    });
    bodyContents.push({
      type: "box",
      layout: "vertical",
      margin: "lg",
      paddingAll: "12px",
      backgroundColor: "#FDECEC",
      cornerRadius: "8px",
      contents: [
        {
          type: "text",
          text: `ยังขาด ${missing.length} รายการ`,
          size: "sm",
          weight: "bold",
          color: "#B42318",
        },
        {
          type: "text",
          text: values.join("\n"),
          size: "sm",
          color: "#7A271A",
          margin: "sm",
          wrap: true,
        },
      ],
    });
  }

  if (lprOnlyCount) {
    bodyContents.push({
      type: "text",
      text: `LPR-only ${lprOnlyCount} รายการ · เก็บไว้ ไม่ลบอัตโนมัติ`,
      size: "xs",
      color: "#7A6F64",
      margin: "lg",
      wrap: true,
    });
  }

  return {
    type: "flex",
    altText: `LPR Daily Check: ${statusTitle}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        paddingAll: "18px",
        backgroundColor: headerColor,
        contents: [
          {
            type: "text",
            text: "LPR DAILY CHECK",
            size: "xs",
            weight: "bold",
            color: "#8A6A3F",
          },
          {
            type: "text",
            text: statusTitle,
            size: "xl",
            weight: "bold",
            color: statusColor,
            margin: "sm",
          },
          {
            type: "text",
            text: dateText,
            size: "sm",
            color: "#6B625A",
            margin: "xs",
          },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "18px",
        contents: bodyContents,
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "14px",
        backgroundColor: "#F4EFE7",
        contents: [
          {
            type: "text",
            text: "เติมทะเบียนที่ขาดอัตโนมัติ · ไม่ลบ LPR-only",
            size: "xs",
            color: "#6B625A",
            align: "center",
            wrap: true,
          },
        ],
      },
    },
  };
}

/**
 * Runs and persists one full Firestore-to-camera reconciliation.
 * @param {Object} options
 * @param {boolean} options.sendLine
 * @param {boolean} options.autoHeal
 * @return {Promise<Object>}
 */
async function runLprReconciliation({sendLine = true, autoHeal = true} = {}) {
  const runAt = new Date().toISOString();
  const expected = await buildExpectedLprState();
  const cameras = [];

  for (const camera of LPR_CAMERAS) {
    try {
      const cameraState = await fetchLprAllowlist(camera);
      const initialState = compareLprState(cameraState, expected);
      const initialMissing = [...initialState.missing];
      let repair = {added: [], errors: []};
      let finalState = initialState;
      if (autoHeal && initialMissing.length) {
        repair = await repairMissingLprPlates(camera, initialMissing);
        finalState = compareLprState(
            await fetchLprAllowlist(camera),
            expected,
        );
      }
      cameras.push({
        ...finalState,
        initialMissing,
        autoHealed: repair.added.filter((plate) =>
          !finalState.missing.includes(plate),
        ),
        healErrors: repair.errors,
      });
    } catch (error) {
      cameras.push({
        camera,
        online: false,
        error: String(error.message || error).slice(0, 500),
        plates: [],
        totalRecords: 0,
        totalMatches: 0,
        missing: [],
        extra: [],
        duplicates: [],
        formatWarnings: [],
        initialMissing: [],
        autoHealed: [],
        healErrors: [],
      });
    }
  }

  const hasOffline = cameras.some((camera) => !camera.online);
  const hasWarning = cameras.some((camera) => camera.online && (
    camera.missing.length || camera.extra.length ||
    camera.duplicates.length || camera.formatWarnings.length
  )) || expected.duplicateAssignments.length > 0;
  const report = {
    runAt,
    status: hasOffline ? "offline" : hasWarning ? "warning" : "healthy",
    residentCount: expected.residentCount,
    expectedCount: expected.plates.length,
    expectedPlates: expected.plates,
    plateHouses: expected.plateHouses,
    duplicateAssignments: expected.duplicateAssignments,
    cameras,
  };

  const reportRef = db.collection(LPR_RECONCILIATION_COLLECTION).doc();
  await reportRef.set({
    ...report,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  let lineSent = false;
  let lineError = "";
  const targetId = await getLprMonitorTargetId();
  if (sendLine) {
    try {
      if (!targetId) throw new Error("LINE target is not configured");
      await sendLinePushMessages(targetId, [
        buildLprReconciliationFlexMessage(report),
      ]);
      lineSent = true;
    } catch (error) {
      lineError = String(error.message || error).slice(0, 500);
      logger.error("LPR reconciliation LINE report failed", error);
    }
  }

  await reportRef.set({lineSent, lineError}, {merge: true});
  return {id: reportRef.id, ...report, lineSent, lineError};
}

/**
 * Returns the first matching XML tag value from a Hikvision event payload.
 * @param {string} payload
 * @param {string[]} tagNames
 * @return {string}
 */
function extractLprEventTag(payload, tagNames) {
  for (const tagName of tagNames) {
    const pattern = new RegExp(
        `<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`,
        "i",
    );
    const match = String(payload || "").match(pattern);
    if (match) return decodeXmlText(match[1]).trim();
  }
  return "";
}

/**
 * Makes compact Hikvision timestamps parseable by JavaScript.
 * @param {string} value
 * @return {string}
 */
function normalizeLprEventTime(value) {
  const clean = String(value || "").trim();
  const compact = clean.match(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(.*)$/,
  );
  if (!compact) return clean;
  return `${compact[1]}-${compact[2]}-${compact[3]}T` +
    `${compact[4]}:${compact[5]}:${compact[6]}${compact[7]}`;
}

/**
 * Recognizes camera placeholders for a missing or unreadable plate.
 * @param {*} value
 * @return {boolean}
 */
function isUnreadableLprPlate(value) {
  // The exit camera emits 11111 for a vehicle without a plate; its capture
  // overlay says UnKnown-11111. Keep real plates such as กข11111 readable.
  const placeholder =
    /^(11111|unknown(?:[\s-]*11111)?|none|null|n\/a|no\s*plate|unlicensed)$/i;
  return placeholder
      .test(String(value || "").trim());
}

/**
 * @param {Object} event
 * @return {boolean}
 */
function isReadableLprEvent(event) {
  const plate = String(event && event.plate || "").trim();
  if (!plate || isUnreadableLprPlate(plate) ||
      isUnreadableLprPlate(event && event.rawPlate)) {
    return false;
  }
  const confidence = String(event && event.confidence || "").trim();
  if (confidence && Number.isFinite(Number(confidence)) &&
      Number(confidence) <= 0) {
    return false;
  }
  return true;
}

/**
 * Explains, in Thai, why one detection was counted as "สแกนไม่พบ"
 * (unreadable). Derived from the same fields isReadableLprEvent checks, so
 * the reason always matches the readable/unreadable split.
 * @param {Object} event stored LPR traffic event
 * @return {string}
 */
function describeUnreadableReason(event) {
  const rawPlate = String(event && event.rawPlate || "").trim();
  const confidenceText = String(event && event.confidence || "").trim();
  const confidence = Number(confidenceText);
  if (!rawPlate) {
    return "กล้องไม่พบข้อความป้ายทะเบียน";
  }
  if (isUnreadableLprPlate(rawPlate)) {
    return "ป้ายอ่านไม่ออก/ไม่มีป้าย";
  }
  if (confidenceText && Number.isFinite(confidence) && confidence <= 0) {
    return "กล้องมั่นใจ 0 (อ่านไม่ออก)";
  }
  // rawPlate existed but normalization produced no canonical Thai plate.
  return "รูปแบบป้ายไม่ตรงมาตรฐานไทย (ป้ายต่างชาติ/พิเศษ หรืออ่านเพี้ยน)";
}

/**
 * Builds a tokenized Firebase Storage download URL for one event's stored
 * capture, or "" if the image has not been synced yet. Display-only (the
 * token is unguessable and the /lprlog page is committee-gated).
 * @param {Object} event stored LPR traffic event
 * @return {string}
 */
function lprEventImageUrl(event) {
  if (!event || !event.imagePath || !event.imageToken) return "";
  const bucketName = admin.storage().bucket().name;
  return "https://firebasestorage.googleapis.com/v0/b/" + bucketName +
    "/o/" + encodeURIComponent(event.imagePath) +
    "?alt=media&token=" + event.imageToken;
}

/**
 * Returns a stable Firestore id for one canonical plate.
 * @param {string} plate
 * @return {string}
 */
function vehicleProfileDocId(plate) {
  return crypto.createHash("sha256")
      .update(String(plate || ""))
      .digest("hex")
      .slice(0, 40);
}

/**
 * Normalizes Gemini vehicle attributes before persistence and display.
 * @param {Object} value
 * @return {Object}
 */
function normalizeVehicleVision(value) {
  const clean = value || {};
  const confidence = Math.max(0, Math.min(1, Number(clean.confidence) || 0));
  return {
    make: String(clean.make || "").trim().slice(0, 60),
    model: String(clean.model || "").trim().slice(0, 80),
    color: String(clean.color || "").trim().toLowerCase().slice(0, 30),
    confidence,
  };
}

/**
 * Uses Gemini vision to identify the primary vehicle in one stored capture.
 * @param {string} imagePath Firebase Storage object path
 * @return {Promise<Object>}
 */
async function analyzeVehicleCapture(imagePath) {
  const authClient = await vertexAuth.getClient();
  const access = await authClient.getAccessToken();
  if (!access.token) throw new Error("Vertex access token unavailable");

  const projectId = process.env.GCLOUD_PROJECT || "pattra8-54c3f";
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/` +
    `${projectId}/locations/${VERTEX_VISION_LOCATION}/publishers/google/` +
    `models/${VERTEX_VISION_MODEL}:generateContent`;
  const fileUri = `gs://${admin.storage().bucket().name}/${imagePath}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${access.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          {text: "Analyze the primary vehicle in this Thai LPR capture. " +
            "Identify its manufacturer, model family, and body color from " +
            "visible evidence only. Do not infer identity from the license " +
            "plate. Use English manufacturer/model names and one of these " +
            "colors: black, white, silver, gray, deep gray, red, blue, " +
            "deep blue, green, yellow, brown, orange, pink, purple, cyan, " +
            "unknown. If uncertain, leave make/model empty and lower the " +
            "confidence."},
          {fileData: {mimeType: "image/jpeg", fileUri}},
        ],
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 800,
        thinkingConfig: {thinkingLevel: "MINIMAL"},
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            make: {type: "STRING"},
            model: {type: "STRING"},
            color: {type: "STRING"},
            confidence: {type: "NUMBER"},
          },
          required: ["make", "model", "color", "confidence"],
        },
      },
    }),
    signal: AbortSignal.timeout(45000),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(String(result.error && result.error.message ||
      `Vertex request failed (${response.status})`).slice(0, 500));
  }
  const parts = result.candidates && result.candidates[0] &&
    result.candidates[0].content && result.candidates[0].content.parts || [];
  const textPart = parts.find((part) => part.text);
  if (!textPart) throw new Error("Vertex returned no vehicle result");
  return normalizeVehicleVision(JSON.parse(textPart.text));
}

/**
 * Gets or creates a cached vehicle profile and links it to an event.
 * @param {Object} event
 * @param {FirebaseFirestore.DocumentReference|null} eventRef
 * @return {Promise<Object|null>}
 */
async function enrichVisitorVehicle(event, eventRef = null) {
  if (!isReadableLprEvent(event) || !event.imagePath) return null;
  const profileRef = db.collection(LPR_VEHICLE_PROFILES_COLLECTION)
      .doc(vehicleProfileDocId(event.plate));
  const profileSnap = await profileRef.get();
  let profile = profileSnap.exists ? profileSnap.data() || {} : null;

  if (!profile) {
    const vision = await analyzeVehicleCapture(event.imagePath);
    profile = {
      plate: event.plate,
      ...vision,
      source: "vertex-vision",
      modelId: VERTEX_VISION_MODEL,
      sourceImagePath: event.imagePath,
      analyzedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await profileRef.set(profile, {merge: true});
  }

  const normalized = normalizeVehicleVision(profile);
  if (eventRef) {
    await eventRef.set({
      vehicleVision: normalized,
      vehicleVisionSource: profile.source || "profile-cache",
      vehicleVisionUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
  }
  return normalized;
}

/**
 * Loads cached vision attributes for report rows.
 * @param {Object[]} rows
 * @return {Promise<Object[]>}
 */
async function attachVehicleProfiles(rows) {
  if (!rows.length) return rows;
  const refs = rows.map((row) =>
    db.collection(LPR_VEHICLE_PROFILES_COLLECTION)
        .doc(vehicleProfileDocId(row.plate)),
  );
  const snaps = await db.getAll(...refs);
  return rows.map((row, index) => {
    if (!snaps[index].exists) return row;
    return {
      ...row,
      vehicleVision: normalizeVehicleVision(snaps[index].data()),
    };
  });
}

/**
 * Agent C's independent Thai-plate canonicalizer.
 * @param {string} value
 * @return {string}
 */
function normalizeAgentCPlate(value) {
  const clean = String(value || "")
      .normalize("NFKC")
      .replace(/[\u200B-\u200D\uFEFF\s-]/g, "");
  const match = clean.match(/([0-9]?[ก-ฮ]{1,3}[0-9]{1,4})/u);
  return match ? match[1] : "";
}

/**
 * Thai consonants that ANPR/vision engines routinely confuse for one another
 * (near-identical glyphs). Used only to tell a benign overlay re-read glitch
 * apart from a genuinely different image — never to "correct" the camera.
 */
const THAI_CONFUSABLE_PAIRS = [
  ["ก", "ถ"], ["ก", "ภ"], ["ถ", "ภ"],
  ["ข", "ช"], ["ข", "ซ"], ["ช", "ซ"], ["ข", "ฃ"],
  ["ค", "ด"], ["ค", "ต"], ["ด", "ต"], ["ค", "ฅ"], ["ด", "ถ"],
  ["ณ", "ฌ"], ["ณ", "ญ"], ["ณ", "ฒ"], ["ฌ", "ญ"], ["ฌ", "ฒ"], ["ญ", "ฒ"],
  ["บ", "ป"], ["บ", "ษ"], ["ป", "ษ"],
  ["พ", "ผ"], ["พ", "ฟ"], ["พ", "ฬ"], ["ผ", "ฟ"],
  ["ว", "ร"],
];
const THAI_CONFUSABLE = new Set(
    THAI_CONFUSABLE_PAIRS.map((pair) => pair.slice().sort().join("|")),
);

/**
 * Whether two Thai characters are a known look-alike confusion pair.
 * @param {string} a
 * @param {string} b
 * @return {boolean}
 */
function isConfusablePair(a, b) {
  return THAI_CONFUSABLE.has([a, b].sort().join("|"));
}

/**
 * Classifies the difference between the camera's event plate and the plate
 * read back from the image overlay banner. "lookalike" means a single
 * confusable-glyph slip (treated as a match); "different" means a real
 * mismatch (wrong image attached to the event).
 * @param {string} eventPlate
 * @param {string} overlayPlate
 * @return {string} empty|identical|lookalike|different
 */
function classifyPlateDiff(eventPlate, overlayPlate) {
  const a = normalizeAgentCPlate(eventPlate);
  const b = normalizeAgentCPlate(overlayPlate);
  if (!a || !b) return "empty";
  if (a === b) return "identical";
  if (a.length !== b.length) return "different";
  const diffs = [];
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) diffs.push([a[i], b[i]]);
  }
  if (diffs.length === 1 && isConfusablePair(diffs[0][0], diffs[0][1])) {
    return "lookalike";
  }
  return "different";
}

/**
 * Selects every Visitor and a deterministic ten-percent resident sample.
 * @param {Object} event
 * @param {Set<string>} residentSet
 * @return {boolean}
 */
function shouldAgentCAudit(event, residentSet) {
  const plate = String(event.plate || "");
  if (!plate) return false;
  if (!residentSet.has(plate)) return true;
  const sample = parseInt(crypto.createHash("sha256")
      .update(`${event.cameraId || ""}|${event.capturedAtEpoch || 0}|${plate}`)
      .digest("hex").slice(0, 8), 16);
  return sample % 10 === 0;
}

/**
 * Reads two things from a stored capture: (1) the plate text printed by the
 * camera in the black overlay banner at the very top — used only to confirm
 * the image truly belongs to this event; (2) the vehicle make/model/color.
 * The camera's ANPR text stays the sole source of truth for the plate — this
 * never re-judges the physical plate.
 * @param {Buffer} source
 * @return {Promise<Object>}
 */
async function analyzeAgentCImage(source) {
  // Required lazily: sharp is a native module and this is its only caller, so
  // loading it at module scope would tax the cold start of every function.
  const sharp = require("sharp");
  const metadata = await sharp(source).metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (!width || !height) throw new Error("Invalid Agent C image");
  const prepared = await sharp(source)
      .resize({width: 1600, withoutEnlargement: true})
      .jpeg({quality: 85})
      .toBuffer();
  const authClient = await vertexAuth.getClient();
  const access = await authClient.getAccessToken();
  if (!access.token) throw new Error("Agent C Vertex token unavailable");
  const projectId = process.env.GCLOUD_PROJECT || "pattra8-54c3f";
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/` +
    `${projectId}/locations/${VERTEX_VISION_LOCATION}/publishers/google/` +
    `models/${VERTEX_VISION_MODEL}:generateContent`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${access.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{role: "user", parts: [
        {text: "You audit an LPR capture for image integrity. A black " +
          "overlay banner runs across the very top, printed by the camera. " +
          "1) Transcribe the plate text printed in that banner right after " +
          "'Plate No.:' EXACTLY as shown — Thai letters and digits only, " +
          "drop the province name. Return it as overlayPlate, with " +
          "overlayConfidence. If the banner is missing or unreadable, return " +
          "an empty overlayPlate and low overlayConfidence. " +
          "2) Separately describe the primary vehicle: make, model family, " +
          "broad body color, with vehicleConfidence. Do not transcribe the " +
          "physical plate on the car body."},
        {inlineData: {
          mimeType: "image/jpeg",
          data: prepared.toString("base64"),
        }},
      ]}],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 900,
        thinkingConfig: {thinkingLevel: "MINIMAL"},
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            overlayPlate: {type: "STRING"},
            make: {type: "STRING"},
            model: {type: "STRING"},
            color: {type: "STRING"},
            overlayConfidence: {type: "NUMBER"},
            vehicleConfidence: {type: "NUMBER"},
          },
          required: ["overlayPlate", "make", "model", "color",
            "overlayConfidence", "vehicleConfidence"],
        },
      },
    }),
    signal: AbortSignal.timeout(45000),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(String(result.error && result.error.message ||
      `Agent C Vertex failed (${response.status})`).slice(0, 500));
  }
  const parts = result.candidates && result.candidates[0] &&
    result.candidates[0].content && result.candidates[0].content.parts || [];
  const textPart = parts.find((part) => part.text);
  if (!textPart) throw new Error("Agent C Vertex returned no result");
  const parsed = JSON.parse(textPart.text);
  const rawOverlay = String(parsed.overlayPlate || "").split(/[([]/)[0];
  return {
    overlayPlate: normalizeAgentCPlate(rawOverlay),
    make: String(parsed.make || "").trim().slice(0, 60),
    model: String(parsed.model || "").trim().slice(0, 80),
    color: String(parsed.color || "").trim().toLowerCase().slice(0, 30),
    overlayConfidence: Math.max(0, Math.min(1,
        Number(parsed.overlayConfidence) || 0)),
    vehicleConfidence: Math.max(0, Math.min(1,
        Number(parsed.vehicleConfidence) || 0)),
    evidenceHash: crypto.createHash("sha256").update(prepared).digest("hex"),
  };
}

/**
 * Audits one stored event without mutating Agent A/B source data.
 * @param {FirebaseFirestore.QueryDocumentSnapshot} docSnap
 * @return {Promise<Object>}
 */
async function runAgentCEventAudit(docSnap) {
  const event = docSnap.data() || {};
  const auditRef = db.collection(LPR_AGENT_C_AUDITS_COLLECTION)
      .doc(docSnap.id);
  const existing = await auditRef.get();
  if (existing.exists && existing.data().status === "complete" &&
      Number(existing.data().auditVersion || 0) >= 2) {
    return existing.data();
  }
  if (!event.imagePath) throw new Error("Agent C event image is missing");
  const [source] = await admin.storage().bucket().file(event.imagePath)
      .download();
  const vision = await analyzeAgentCImage(source);
  const sourcePlate = String(event.plate || "");
  // Camera ANPR text is the sole source of truth for the plate. Vision is
  // used only to confirm the stored image belongs to this event (overlay
  // banner == event plate) and to record vehicle attributes.
  const overlayReadable = Boolean(vision.overlayPlate) &&
    vision.overlayConfidence >= 0.6;
  const diffKind = classifyPlateDiff(sourcePlate, vision.overlayPlate);
  const reasonCodes = [];
  let verdict = "pass";
  if (!sourcePlate || !overlayReadable) {
    verdict = "unverifiable";
    reasonCodes.push("OVERLAY_UNREADABLE");
  } else if (diffKind === "different") {
    verdict = "image_mismatch";
    reasonCodes.push("IMAGE_EVENT_MISMATCH");
  } else if (diffKind === "lookalike") {
    reasonCodes.push("OVERLAY_LOOKALIKE_OK");
  }
  if (event.imageMatchDeltaMs !== null &&
      Number(event.imageMatchDeltaMs) > 5000) {
    reasonCodes.push("IMAGE_TIME_DELTA_HIGH");
  }
  const audit = {
    eventId: docSnap.id,
    cameraId: event.cameraId || "",
    direction: event.direction || "",
    capturedAtEpoch: event.capturedAtEpoch || null,
    sourcePlate,
    sourceConfidence: event.confidence || "",
    cameraVehicleColor: event.vehicleColor || "",
    cameraVehicleLogoCode: event.vehicleLogoCode || "",
    imagePath: event.imagePath,
    imageMatchDeltaMs: event.imageMatchDeltaMs === undefined ? null :
      event.imageMatchDeltaMs,
    overlayPlate: vision.overlayPlate,
    plateDiff: diffKind,
    vision: {
      make: vision.make,
      model: vision.model,
      color: vision.color,
      overlayConfidence: vision.overlayConfidence,
      vehicleConfidence: vision.vehicleConfidence,
      evidenceHash: vision.evidenceHash,
    },
    verdict,
    reasonCodes,
    status: "complete",
    auditModel: VERTEX_VISION_MODEL,
    auditVersion: 2,
    auditedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await auditRef.set(audit, {merge: true});
  return audit;
}

/**
 * Parses one HTTP notification from an LPR camera.
 * @param {string} payload
 * @return {Object|null}
 */
function parseLprTrafficEvent(payload) {
  const eventType = extractLprEventTag(payload, [
    "eventType",
    "eventDescription",
  ]);
  const rawPlate = extractLprEventTag(payload, [
    "licensePlate",
    "plateNumber",
    "plateNo",
  ]);
  const isVehicleEvent = Boolean(rawPlate) ||
    /anpr|vehicle|traffic|tfs/i.test(eventType);
  if (!isVehicleEvent) return null;

  const rawTime = extractLprEventTag(payload, [
    "dateTime",
    "captureTime",
    "passTime",
  ]);
  const normalizedTime = normalizeLprEventTime(rawTime);
  const parsedEpoch = Date.parse(normalizedTime);
  const capturedAtEpoch = Number.isFinite(parsedEpoch) ?
    parsedEpoch : Date.now();
  const confidence = extractLprEventTag(payload, [
    "confidenceLevel",
    "confidence",
  ]);
  const normalizedPlate = normalizePlateArray([rawPlate])[0] || "";
  const vehicleColor = extractLprEventTag(payload, ["vehicleColor", "color"]);
  const vehicleLogoCode = extractLprEventTag(payload, ["vehicleLogoRecog"]);
  const vehicleType = extractLprEventTag(payload, ["vehicleType"]);
  const plate = isReadableLprEvent({
    plate: normalizedPlate,
    rawPlate,
    confidence,
  }) ? normalizedPlate : "";

  return {
    eventType: eventType || "vehicle",
    rawPlate,
    plate,
    capturedAt: new Date(capturedAtEpoch).toISOString(),
    capturedAtEpoch,
    eventDirection: extractLprEventTag(payload, [
      "direction",
      "vehicle_direction",
    ]),
    matchingResult: extractLprEventTag(payload, ["matchingResult"]),
    confidence,
    vehicleColor,
    vehicleLogoCode,
    vehicleType,
    laneNo: extractLprEventTag(payload, ["laneNo", "laneID"]),
    picName: extractLprEventTag(payload, ["picName", "imageName"]),
  };
}

/**
 * Returns Bangkok day boundaries for a YYYY-MM-DD date.
 * @param {string} reportDate
 * @param {number} startHour inclusive start hour (default 0)
 * @param {number} endHour exclusive end hour (default 24 = next midnight)
 * @return {Object}
 */
function getTrafficDayRange(reportDate, startHour = 0, endHour = 24) {
  const cleanDate = String(reportDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
    throw new Error("Invalid report date");
  }
  const sh = String(startHour).padStart(2, "0");
  const startEpoch = Date.parse(`${cleanDate}T${sh}:00:00+07:00`);
  const endEpoch = endHour >= 24 ?
    Date.parse(`${cleanDate}T23:59:59.999+07:00`) + 1 :
    Date.parse(`${cleanDate}T${String(endHour).padStart(2, "0")}:00:00+07:00`);
  return {reportDate: cleanDate, startEpoch, endEpoch};
}

/**
 * Formats a Bangkok time label as HH:MM.
 * @param {number} hour
 * @param {number} minute
 * @return {string}
 */
function formatBangkokClock(hour, minute = 0) {
  const h = Math.max(0, Math.min(23, Number(hour) || 0));
  const m = Math.max(0, Math.min(59, Number(minute) || 0));
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Formats a Bangkok date label from an epoch.
 * @param {number} epoch
 * @return {string}
 */
function formatBangkokDateLabel(epoch) {
  return new Intl.DateTimeFormat("th-TH-u-ca-gregory", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Bangkok",
  }).format(new Date(epoch));
}

/**
 * Formats a canonical plate for display.
 * @param {string} plate
 * @return {string}
 */
function displayPlate(plate) {
  return String(plate || "")
      .replace(/\s+/g, "")
      .replace(/^(.+?)(\d{1,4})$/, "$1 $2");
}

// Default start for full-day traffic views (lprlog, weekly summary).
const DAILY_REPORT_START_HOUR = 7;
// Guard shifts for the Pattra Watch LINE cards: day 07:00–19:00, night
// 19:00–07:00 the next morning. Each card is sent 15 minutes after its shift
// ends (19:15 / 07:15) so late camera events are included.
const DAY_SHIFT_START_HOUR = 7;
const DAY_SHIFT_END_HOUR = 19;
const NIGHT_SHIFT_START_HOUR = 19;
const NIGHT_SHIFT_END_HOUR = 7;

/**
 * Returns yesterday's calendar date in Bangkok.
 * @return {string}
 */
function getYesterdayBangkokDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
  );
  const todayEpoch = Date.parse(
      `${values.year}-${values.month}-${values.day}T00:00:00+07:00`,
  );
  // Read the Bangkok calendar date of "yesterday midnight Bangkok", not the
  // UTC date. toISOString() would report the UTC day of a 17:00Z instant,
  // which is one day earlier than intended.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(todayEpoch - 24 * 60 * 60 * 1000));
}

/**
 * Builds one daily traffic summary from stored LPR events.
 * @param {string} reportDate
 * @param {number} [startHour] Hour the report day starts (default 07:00).
 * @param {number} [endHour] Exclusive end hour (default 24 = midnight).
 * @return {Promise<Object>}
 */
async function buildDailyTrafficReport(
    reportDate, startHour = DAILY_REPORT_START_HOUR, endHour = 24) {
  const range = getTrafficDayRange(reportDate, startHour, endHour);
  const [eventSnap, expected] = await Promise.all([
    db.collection(LPR_TRAFFIC_EVENTS_COLLECTION)
        .where("capturedAtEpoch", ">=", range.startEpoch)
        .where("capturedAtEpoch", "<", range.endEpoch)
        .get(),
    buildExpectedLprState(),
  ]);
  const events = eventSnap.docs.map((docSnap) => resolveLprPlate({
    id: docSnap.id,
    ...docSnap.data(),
  }, expected));
  const residentSet = new Set(expected.plates);
  const readableEvents = events.filter(isReadableLprEvent);
  const residentEvents = readableEvents.filter((event) =>
    residentSet.has(event.plate),
  );
  const externalEvents = readableEvents.filter((event) =>
    !residentSet.has(event.plate),
  );
  const uniquePlates = new Set(readableEvents.map((event) => event.plate));
  const uniqueResident = new Set(residentEvents.map((event) => event.plate));
  const uniqueExternal = new Set(externalEvents.map((event) => event.plate));
  const hourlyCounts = Array.from({length: 24}, () => 0);
  events.forEach((event) => {
    const hour = Number(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Bangkok",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(event.capturedAtEpoch)));
    if (Number.isInteger(hour)) hourlyCounts[hour]++;
  });
  const busiestCount = Math.max(...hourlyCounts, 0);
  const busiestHour = busiestCount ? hourlyCounts.indexOf(busiestCount) : null;

  // Aggregate per unique plate so the overview card can list visitor plates
  // and the resident houses that came through during the day.
  const aggMap = new Map();
  readableEvents.forEach((event) => {
    const agg = aggMap.get(event.plate) || {
      plate: event.plate,
      firstEpoch: event.capturedAtEpoch,
      directions: new Set(),
      entryEpoch: null,
      exitEpoch: null,
      firstEvent: event,
      entryEvent: null,
      exitEvent: null,
    };
    if (event.capturedAtEpoch <= agg.firstEpoch) agg.firstEvent = event;
    agg.firstEpoch = Math.min(agg.firstEpoch, event.capturedAtEpoch);
    if (event.direction) agg.directions.add(event.direction);
    if (event.direction === "entry") {
      if (agg.entryEpoch === null || event.capturedAtEpoch < agg.entryEpoch) {
        agg.entryEvent = event;
      }
      agg.entryEpoch = agg.entryEpoch === null ? event.capturedAtEpoch :
        Math.min(agg.entryEpoch, event.capturedAtEpoch);
    }
    if (event.direction === "exit") {
      if (agg.exitEpoch === null || event.capturedAtEpoch < agg.exitEpoch) {
        agg.exitEvent = event;
      }
      agg.exitEpoch = agg.exitEpoch === null ? event.capturedAtEpoch :
        Math.min(agg.exitEpoch, event.capturedAtEpoch);
    }
    aggMap.set(event.plate, agg);
  });
  // Evidence captures per plate: the first entry shot and the first exit shot
  // (falling back to the first detection if neither direction is tagged).
  // imageUrl is "" while the NVR sync is still pending (~15 min lag).
  const buildCaptures = (agg) => {
    const caps = [];
    const add = (ev, label) => {
      if (!ev) return;
      caps.push({
        label,
        direction: ev.direction || "",
        time: ev.capturedAtEpoch ? formatBangkokHm(ev.capturedAtEpoch) : "",
        cameraId: ev.cameraId || "",
        imageUrl: lprEventImageUrl(ev),
      });
    };
    add(agg.entryEvent, "เข้า");
    add(agg.exitEvent, "ออก");
    if (!caps.length) add(agg.firstEvent, "ผ่าน");
    return caps;
  };
  const residentHouseSet = new Set();
  const residentPlateRows = [];
  const externalPlateRows = [];
  Array.from(aggMap.values())
      .sort((a, b) => a.firstEpoch - b.firstEpoch)
      .forEach((agg) => {
        const houses = expected.plateHouses[agg.plate] || [];
        const row = {
          plate: agg.plate,
          firstTime: formatBangkokHm(agg.firstEpoch),
          entryTime: agg.entryEpoch ? formatBangkokHm(agg.entryEpoch) : null,
          exitTime: agg.exitEpoch ? formatBangkokHm(agg.exitEpoch) : null,
          directions: Array.from(agg.directions),
          houses,
          captures: buildCaptures(agg),
        };
        if (residentSet.has(agg.plate)) {
          houses.forEach((house) => residentHouseSet.add(house));
          residentPlateRows.push(row);
        } else {
          externalPlateRows.push(row);
        }
      });
  const enrichedExternalPlates = await attachVehicleProfiles(
      externalPlateRows,
  );

  // Security signals for the "ต้องตรวจสอบ" summary line.
  const nightHours = new Set([22, 23, 0, 1, 2, 3, 4, 5]);
  const nightExternalSet = new Set();
  externalEvents.forEach((event) => {
    if (event.direction !== "entry" || !event.capturedAtEpoch) return;
    const hour = Number(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Bangkok", hour: "2-digit", hourCycle: "h23",
    }).format(new Date(event.capturedAtEpoch)));
    if (nightHours.has(hour)) nightExternalSet.add(event.plate);
  });
  const stillInsideExternal = enrichedExternalPlates
      .filter((r) => r.entryTime && !r.exitTime).length;

  const dayEpochs = events
      .map((event) => event.capturedAtEpoch)
      .filter(Boolean);
  const timeRange = dayEpochs.length ?
    `${formatBangkokHm(Math.min(...dayEpochs))}–` +
    `${formatBangkokHm(Math.max(...dayEpochs))}` : "";

  return {
    reportDate: range.reportDate,
    startHour,
    endHour,
    generatedAt: new Date().toISOString(),
    timeRange,
    totalDetections: events.length,
    entryDetections: events
        .filter((event) => event.direction === "entry").length,
    exitDetections: events
        .filter((event) => event.direction === "exit").length,
    uniqueCars: uniquePlates.size,
    residentCars: uniqueResident.size,
    residentEntryCars: residentPlateRows
        .filter((r) => r.directions.includes("entry")).length,
    residentExitCars: residentPlateRows
        .filter((r) => r.directions.includes("exit")).length,
    externalCars: uniqueExternal.size,
    externalEntryCars: enrichedExternalPlates
        .filter((r) => r.directions.includes("entry")).length,
    externalExitCars: enrichedExternalPlates
        .filter((r) => r.directions.includes("exit")).length,
    residentHouses: residentHouseSet.size,
    residentHouseList: Array.from(residentHouseSet),
    residentPlates: residentPlateRows,
    externalPlates: enrichedExternalPlates,
    residentDetections: residentEvents.length,
    externalDetections: externalEvents.length,
    unreadableDetections: events.length - readableEvents.length,
    unreadableEvents: events.filter((event) => !isReadableLprEvent(event))
        .sort((a, b) => (a.capturedAtEpoch || 0) - (b.capturedAtEpoch || 0))
        .slice(0, 300)
        .map((event) => ({
          eventId: event.id,
          cameraId: event.cameraId,
          direction: event.direction,
          capturedAt: event.capturedAt,
          time: event.capturedAtEpoch ?
            formatBangkokHm(event.capturedAtEpoch) : "",
          rawPlate: event.rawPlate || "",
          vehicleType: event.vehicleType || "",
          vehicleColor: event.vehicleColor || "",
          reason: describeUnreadableReason(event),
          imageUrl: lprEventImageUrl(event),
        })),
    busiestHour,
    busiestCount,
    hourlyCounts,
    stillInsideExternal,
    nightExternalCars: nightExternalSet.size,
    cameraCounts: {
      "8241": events.filter((event) => event.cameraId === "8241").length,
      "8242": events.filter((event) => event.cameraId === "8242").length,
    },
  };
}

/**
 * Strips a full daily traffic report down to what's safe to show any
 * logged-in resident: aggregate resident in/out counts (no houses or
 * plates) plus the full external/visitor plate list (make/model/color,
 * in/out times) since that isn't privacy-sensitive to residents.
 * @param {Object} report Output of buildDailyTrafficReport.
 * @return {Object}
 */
function toVisitorBoardReport(report) {
  return {
    reportDate: report.reportDate,
    generatedAt: report.generatedAt,
    timeRange: report.timeRange,
    totalDetections: report.totalDetections,
    uniqueCars: report.uniqueCars,
    residentCars: report.residentCars,
    residentEntryCars: report.residentEntryCars,
    residentExitCars: report.residentExitCars,
    externalCars: report.externalCars,
    externalEntryCars: report.externalEntryCars,
    externalExitCars: report.externalExitCars,
    unreadableDetections: report.unreadableDetections,
    externalPlates: (report.externalPlates || []).map((row) => ({
      plate: row.plate,
      firstTime: row.firstTime,
      entryTime: row.entryTime,
      exitTime: row.exitTime,
      // confidence travels with the attributes so /visitorboard/ can apply the
      // same LPR_VISION_MIN_CONFIDENCE cut the Flex cards do. Without it the
      // board had no way to tell a confident read from a guess and showed
      // both identically.
      vehicleVision: row.vehicleVision ? {
        make: row.vehicleVision.make,
        model: row.vehicleVision.model,
        color: row.vehicleVision.color,
        confidence: row.vehicleVision.confidence,
      } : null,
    })),
  };
}

/**
 * Searches traffic events for one plate across all stored dates.
 * @param {string} rawPlate
 * @return {Promise<Object>}
 */
async function buildPlateSearchReport(rawPlate) {
  const plate = normalizePlateArray([rawPlate])[0] || "";
  if (!plate) {
    throw new Error("Missing plate");
  }

  const expected = await buildExpectedLprState();
  const eventSnap = await db.collection(LPR_TRAFFIC_EVENTS_COLLECTION)
      .where("plate", "in", lprSearchPlates(plate, expected))
      .get();

  const events = eventSnap.docs.map((docSnap) => ({
    id: docSnap.id,
    ...docSnap.data(),
  })).map((event) => resolveLprPlate(event, expected))
      .filter((event) => event.plate === plate)
      .filter(isReadableLprEvent)
      .sort((a, b) => (a.capturedAtEpoch || 0) - (b.capturedAtEpoch || 0));

  const houses = expected.plateHouses[plate] || [];
  const resident = new Set(expected.plates).has(plate);
  const eventGroups = new Map();
  events.forEach((event) => {
    const epoch = Number(event.capturedAtEpoch || 0);
    if (!epoch) return;
    const reportDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Bangkok",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(epoch));
    const group = eventGroups.get(reportDate) || {
      reportDate,
      dateLabel: formatBangkokDateLabel(epoch),
      firstEpoch: epoch,
      lastEpoch: epoch,
      entryCount: 0,
      exitCount: 0,
      events: [],
    };
    group.firstEpoch = Math.min(group.firstEpoch, epoch);
    group.lastEpoch = Math.max(group.lastEpoch, epoch);
    if (event.direction === "entry") group.entryCount += 1;
    if (event.direction === "exit") group.exitCount += 1;
    group.events.push({
      eventId: event.id,
      reportDate,
      capturedAt: event.capturedAt || "",
      capturedAtEpoch: epoch,
      time: formatBangkokHm(epoch),
      direction: event.direction || "",
      directionLabel: event.direction === "entry" ? "เข้า" :
        event.direction === "exit" ? "ออก" : "ผ่าน",
      cameraId: event.cameraId || "",
      imageUrl: lprEventImageUrl(event),
      reportedPlate: event.reportedPlate || event.plate,
      plateCorrection: event.plateCorrection || "",
    });
    eventGroups.set(reportDate, group);
  });

  const dateGroups = Array.from(eventGroups.values())
      .sort((a, b) => a.firstEpoch - b.firstEpoch)
      .map((group) => ({
        ...group,
        eventCount: group.events.length,
        firstTime: formatBangkokHm(group.firstEpoch),
        lastTime: formatBangkokHm(group.lastEpoch),
        timeRange: `${formatBangkokHm(group.firstEpoch)}–${
          formatBangkokHm(group.lastEpoch)
        }`,
        events: group.events.sort((a, b) =>
          a.capturedAtEpoch - b.capturedAtEpoch),
      }));

  const epochs = dateGroups.flatMap((group) =>
    group.events.map((event) => event.capturedAtEpoch),
  ).filter(Boolean);
  const firstEpoch = epochs.length ? Math.min(...epochs) : null;
  const lastEpoch = epochs.length ? Math.max(...epochs) : null;
  const summaryRow = {
    plate,
    houses,
    resident,
  };
  const enrichedSummary = (await attachVehicleProfiles([summaryRow]))[0] ||
    summaryRow;
  const firstLabel = firstEpoch ?
    `${formatBangkokDateLabel(firstEpoch)} ${formatBangkokHm(firstEpoch)} น.` :
    "";
  const lastLabel = lastEpoch ?
    `${formatBangkokDateLabel(lastEpoch)} ${formatBangkokHm(lastEpoch)} น.` :
    "";

  return {
    queryPlate: plate,
    generatedAt: new Date().toISOString(),
    summary: {
      plate,
      displayPlate: displayPlate(plate),
      resident,
      houses,
      totalEvents: events.length,
      totalDays: dateGroups.length,
      entryEvents: events.filter((event) => event.direction === "entry").length,
      exitEvents: events.filter((event) => event.direction === "exit").length,
      firstEpoch,
      lastEpoch,
      firstDate: firstEpoch ? new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(firstEpoch)) : "",
      lastDate: lastEpoch ? new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(lastEpoch)) : "",
      firstTime: firstEpoch ? formatBangkokHm(firstEpoch) : "",
      lastTime: lastEpoch ? formatBangkokHm(lastEpoch) : "",
      firstLabel,
      lastLabel,
      vehicleVision: enrichedSummary.vehicleVision || null,
    },
    dateGroups,
  };
}

/**
 * Searches traffic events for every registered vehicle at one house.
 * @param {string} rawHouseNo
 * @return {Promise<Object>}
 */
async function buildHouseSearchReport(rawHouseNo) {
  const houseNo = normalizeHouseNo(rawHouseNo);
  if (!/^38\/\d{1,2}$/.test(houseNo)) {
    const error = new Error("Invalid house number");
    error.status = 400;
    throw error;
  }

  const expected = await buildExpectedLprState();
  const plates = expected.plates.filter((plate) =>
    (expected.plateHouses[plate] || []).includes(houseNo));
  const chunks = [];
  const searchPlates = [...new Set(plates.flatMap((plate) =>
    lprSearchPlates(plate, expected)))];
  for (let index = 0; index < searchPlates.length; index += 30) {
    chunks.push(searchPlates.slice(index, index + 30));
  }
  const eventSnaps = await Promise.all(chunks.map((chunk) =>
    db.collection(LPR_TRAFFIC_EVENTS_COLLECTION)
        .where("plate", "in", chunk)
        .get()));
  const events = eventSnaps.flatMap((snap) => snap.docs.map((docSnap) => ({
    id: docSnap.id,
    ...docSnap.data(),
  }))).map((event) => resolveLprPlate(event, expected))
      .filter((event) => plates.includes(event.plate))
      .filter(isReadableLprEvent)
      .sort((a, b) =>
        (a.capturedAtEpoch || 0) - (b.capturedAtEpoch || 0));

  const profileRows = await attachVehicleProfiles(plates.map((plate) => ({
    plate,
  })));
  const profilesByPlate = {};
  profileRows.forEach((row) => {
    profilesByPlate[row.plate] = row.vehicleVision || null;
  });

  const countsByPlate = {};
  const eventGroups = new Map();
  events.forEach((event) => {
    const epoch = Number(event.capturedAtEpoch || 0);
    if (!epoch) return;
    countsByPlate[event.plate] = (countsByPlate[event.plate] || 0) + 1;
    const reportDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Bangkok",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(epoch));
    const group = eventGroups.get(reportDate) || {
      reportDate,
      dateLabel: formatBangkokDateLabel(epoch),
      firstEpoch: epoch,
      lastEpoch: epoch,
      entryCount: 0,
      exitCount: 0,
      events: [],
    };
    group.firstEpoch = Math.min(group.firstEpoch, epoch);
    group.lastEpoch = Math.max(group.lastEpoch, epoch);
    if (event.direction === "entry") group.entryCount += 1;
    if (event.direction === "exit") group.exitCount += 1;
    group.events.push({
      eventId: event.id,
      reportDate,
      capturedAt: event.capturedAt || "",
      capturedAtEpoch: epoch,
      time: formatBangkokHm(epoch),
      direction: event.direction || "",
      directionLabel: event.direction === "entry" ? "เข้า" :
        event.direction === "exit" ? "ออก" : "ผ่าน",
      cameraId: event.cameraId || "",
      imageUrl: lprEventImageUrl(event),
      plate: event.plate,
      displayPlate: displayPlate(event.plate),
      reportedPlate: event.reportedPlate || event.plate,
      plateCorrection: event.plateCorrection || "",
      houses: expected.plateHouses[event.plate] || [houseNo],
      vehicleVision: profilesByPlate[event.plate] || null,
    });
    eventGroups.set(reportDate, group);
  });

  const dateGroups = Array.from(eventGroups.values())
      .sort((a, b) => b.firstEpoch - a.firstEpoch)
      .map((group) => ({
        ...group,
        eventCount: group.events.length,
        firstTime: formatBangkokHm(group.firstEpoch),
        lastTime: formatBangkokHm(group.lastEpoch),
        timeRange: `${formatBangkokHm(group.firstEpoch)}–${
          formatBangkokHm(group.lastEpoch)
        }`,
        events: group.events.sort((a, b) =>
          b.capturedAtEpoch - a.capturedAtEpoch),
      }));
  const epochs = events.map((event) =>
    Number(event.capturedAtEpoch || 0)).filter(Boolean);
  const firstEpoch = epochs.length ? Math.min(...epochs) : null;
  const lastEpoch = epochs.length ? Math.max(...epochs) : null;

  return {
    queryType: "house",
    queryHouseNo: houseNo,
    generatedAt: new Date().toISOString(),
    summary: {
      houseNo,
      registeredCars: plates.length,
      activeCars: Object.keys(countsByPlate).length,
      totalEvents: events.length,
      totalDays: dateGroups.length,
      entryEvents: events.filter((event) =>
        event.direction === "entry").length,
      exitEvents: events.filter((event) =>
        event.direction === "exit").length,
      firstLabel: firstEpoch ?
        `${formatBangkokDateLabel(firstEpoch)} ${
          formatBangkokHm(firstEpoch)} น.` : "",
      lastLabel: lastEpoch ?
        `${formatBangkokDateLabel(lastEpoch)} ${
          formatBangkokHm(lastEpoch)} น.` : "",
      vehicles: plates.map((plate) => ({
        plate,
        displayPlate: displayPlate(plate),
        eventCount: countsByPlate[plate] || 0,
        vehicleVision: profilesByPlate[plate] || null,
      })),
    },
    dateGroups,
  };
}

/**
 * Builds the shared "Pattra Watch" shift card used by both the day
 * (07:00–19:00) and night (19:00–07:00) report. One summary block (total,
 * resident/visitor split, unreadable, hourly strip) then the visitor list.
 * @param {Object} report normalized traffic report
 * @param {Object} [opts] {variant: "daily"|"night", title, windowText}
 * @return {Object}
 */
function buildPattraWatchFlex(report, opts) {
  const o = opts || {};
  const night = o.variant === "night";
  const logoBase = "https://firebasestorage.googleapis.com/v0/b/" +
    "pattra8-54c3f.firebasestorage.app/o/lpr_assets%2F";
  const logoLight = `${logoBase}pattra-villa-light.png?alt=media&token=` +
    "dc978f74-8e13-4fd9-8612-f7177550d0b1";
  const logoDark = `${logoBase}pattra-villa-dark.png?alt=media&token=` +
    "f9a2a5af-2566-4008-b085-870c13ea5934";
  const palettes = {
    classic: {
      night: {
        headBg: "#1E2A38", bodyBg: "#26323F", tag: "#7FA8C9",
        title: "#F2EDE4", sub: "#A9B6C4", heroBg: "#2E3D4D",
        label: "#B7AFA4", line: "#3A4855", green: "#7FB069",
        orange: "#E0A458", red: "#E07A5F", text: "#F2EDE4", muted: "#8C99A6",
      },
      day: {
        headBg: "#F0F5ED", bodyBg: "#FFFFFF", tag: "#527A45",
        title: "#25451F", sub: "#66705F", heroBg: "#EAF3EA",
        label: "#746A61", line: "#E6E0D6", green: "#2F6B3C",
        orange: "#A15C22", red: "#B42318", text: "#25211D", muted: "#746A61",
      },
    },
    slate: {
      night: {
        headBg: "#1B2733", bodyBg: "#222E3A", tag: "#7E9AB5",
        title: "#EAF0F6", sub: "#9DAAB8", heroBg: "#2A3744",
        label: "#9AA6B2", line: "#34404D", green: "#5FB8A3",
        orange: "#D9A066", red: "#E08163", text: "#EAF0F6", muted: "#8895A2",
      },
      day: {
        headBg: "#EEF2F6", bodyBg: "#FFFFFF", tag: "#5B7A99",
        title: "#1F2D3D", sub: "#647284", heroBg: "#F3F6F9",
        label: "#7C8794", line: "#E3E8EE", green: "#2E7D6B",
        orange: "#B9742F", red: "#BC4439", text: "#1F2D3D", muted: "#7C8794",
      },
    },
    cream: {
      night: {
        headBg: "#2A241C", bodyBg: "#322B22", tag: "#C2A878",
        title: "#F3ECDD", sub: "#C0B4A0", heroBg: "#3B3328",
        label: "#B7AC97", line: "#473E31", green: "#9CB36B",
        orange: "#D9A05B", red: "#E08A6B", text: "#F3ECDD", muted: "#A99E8A",
      },
      day: {
        headBg: "#F6F1E7", bodyBg: "#FFFCF7", tag: "#8A7A5C",
        title: "#3B3026", sub: "#7A6E5D", heroBg: "#F1EADC",
        label: "#8A7E6D", line: "#E8DFCF", green: "#5E7A3F",
        orange: "#B26A3A", red: "#A8432F", text: "#3B3026", muted: "#8A7E6D",
      },
    },
  };
  const themeName = o.themeName || report.themeName || "cream";
  const pal = palettes[themeName] || palettes.classic;
  const t = {...(night ? pal.night : pal.day),
    logo: night ? logoLight : logoDark};
  const shiftName = night ? "กะกลางคืน" : "กะกลางวัน";
  const title = o.title || `สรุปรถเข้า–ออก (${shiftName})`;
  const thaiDate = (ymd, options) => new Intl.DateTimeFormat(
      "th-TH-u-ca-gregory", {...options, timeZone: "Asia/Bangkok"},
  ).format(new Date(`${ymd}T12:00:00+07:00`));
  // A cross-midnight night shift is dated by the evening it starts; the end
  // date only appears next to the end time.
  const crossesMidnight = night && report.crossesMidnight;
  // Built from parts: dateStyle "long" adds the era ("ค.ศ.") on some ICU
  // builds.
  const dateYmd = crossesMidnight && report.shiftStartDate ?
    report.shiftStartDate : report.reportDate;
  const dateText = `${thaiDate(dateYmd, {day: "numeric", month: "long"})} ` +
    String(dateYmd).slice(0, 4);
  const windowText = (() => {
    if (o.windowText) return `${o.windowText} น.`;
    const [startLabel, endLabel] = String(report.windowLabel || "")
        .split("–");
    if (crossesMidnight && startLabel && endLabel) {
      const endShort = thaiDate(report.reportDate,
          {day: "numeric", month: "short"});
      return `${startLabel} – ${endLabel} (${endShort})`;
    }
    return `${report.windowLabel || "ทั้งวัน"} น.`;
  })();
  // Visitor-list times use a calmer green/red than the summary numbers.
  const listColors = themeName === "cream" ?
    (night ? {inTime: "#A3BE76", outTime: "#E39278"} :
      {inTime: "#557F3E", outTime: "#A9533F"}) :
    {inTime: t.green, outTime: t.red};
  const fill = (color, extra) => ({type: "box", layout: "vertical",
    backgroundColor: color, contents: [{type: "filler"}], ...(extra || {})});
  // One tile per group: color stripe matching the split bar, label first,
  // then the number. Unreadable is counted in ครั้ง, not cars.
  const tile = (color, label, value, unit) => ({
    type: "box", layout: "horizontal", flex: 1, spacing: "sm",
    backgroundColor: t.bodyBg, cornerRadius: "10px", paddingAll: "10px",
    contents: [
      fill(color, {width: "4px", cornerRadius: "2px"}),
      {type: "box", layout: "vertical", flex: 1, contents: [
        {type: "text", text: label, size: "xxs", color: t.label},
        {type: "text", size: "lg", weight: "bold", color, contents: [
          {type: "span", text: String(value || 0)},
          {type: "span", text: ` ${unit}`, size: "xxs", weight: "regular",
            color: t.label},
        ]},
      ]},
    ],
  });
  // Hourly traffic as one row of cells shaded by volume, scaled between the
  // shift's quietest and busiest hour so a flat day still shows its peaks.
  const buildHeatStrip = () => {
    const counts = report.hourlyCounts || [];
    const startHour = Number.isInteger(report.startHour) ?
      report.startHour : (night ? 19 : 7);
    const endHour = Number.isInteger(report.endHour) ?
      report.endHour % 24 : (night ? 7 : 19);
    const endsMidHour = /:(?!00)\d{2}$/.test(
        String(report.windowLabel || ""));
    const span = ((endHour - startHour + 24) % 24 || 24) +
      (endsMidHour ? 1 : 0);
    const hours = Array.from({length: Math.min(span, 24)}, (_, i) =>
      (startHour + i) % 24);
    const values = hours.map((h) => counts[h] || 0);
    const maxC = Math.max(...values);
    const minC = Math.min(...values);
    const busiest = hours[values.indexOf(maxC)];
    const ramp = night ?
      ["#544937", "#7A6340", "#B5844A", "#E0A85E"] :
      ["#E3D3B8", "#E0B57A", "#D08A42", "#A85E2E"];
    const shade = (c) => {
      const r = maxC === minC ? 0 : (c - minC) / (maxC - minC);
      return ramp[r >= 0.85 ? 3 : r >= 0.6 ? 2 : r >= 0.3 ? 1 : 0];
    };
    const hh = (h) => String(h).padStart(2, "0");
    // Hour ticks every ~quarter of the shift, with the end hour pinned right.
    const step = Math.max(1, Math.round(hours.length / 4));
    const tickIdx = [0, step, step * 2, step * 3]
        .filter((i) => i < hours.length);
    const tickText = (h, align) => ({type: "text", text: hh(h),
      size: "xxs", color: t.label, flex: align === "end" ? 0 : 1,
      align: align || "start"});
    const ticks = tickIdx.map((idx, i) => {
      const next = i + 1 < tickIdx.length ? tickIdx[i + 1] : hours.length;
      if (i + 1 < tickIdx.length) {
        return {...tickText(hours[idx]), flex: next - idx};
      }
      return {type: "box", layout: "horizontal", flex: next - idx, contents: [
        tickText(hours[idx]),
        tickText((hours[hours.length - 1] + 1) % 24, "end"),
      ]};
    });
    return {type: "box", layout: "vertical", margin: "lg", contents: [
      {type: "box", layout: "baseline", contents: [
        {type: "text", text: "ช่วงที่รถเข้าออกเยอะ", size: "xxs",
          color: t.label, flex: 1},
        {type: "text", size: "xxs", color: t.orange, weight: "bold", flex: 0,
          text: maxC ? `พีค ${hh(busiest)}:00–${hh((busiest + 1) % 24)}:00` :
            "ยังไม่มีข้อมูล"},
      ]},
      {type: "box", layout: "horizontal", height: "16px", spacing: "xs",
        margin: "md", contents: values.map((c) =>
          fill(maxC ? shade(c) : t.line, {flex: 1, cornerRadius: "3px"}))},
      {type: "box", layout: "horizontal", margin: "sm", contents: ticks},
    ]};
  };
  // Total, resident/visitor split bar, three tiles and the hourly strip in
  // one block.
  const buildSummary = () => {
    const resident = report.residentCars || 0;
    const external = report.externalCars || 0;
    const split = [
      ...(resident ? [fill(t.green, {flex: resident})] : []),
      ...(external ? [fill(t.orange, {flex: external})] : []),
    ];
    return {type: "box", layout: "vertical", backgroundColor: t.heroBg,
      cornerRadius: "lg", paddingAll: "16px", contents: [
        {type: "box", layout: "baseline", contents: [
          {type: "text", text: "รถผ่านประตูทั้งหมด", size: "sm",
            weight: "bold", color: t.title, flex: 1},
          {type: "text", text: String(report.uniqueCars || 0), size: "xxl",
            weight: "bold", color: t.title, flex: 0},
          {type: "text", text: "คัน", size: "sm", color: t.label, flex: 0,
            margin: "sm"},
        ]},
        {type: "box", layout: "horizontal", height: "10px", margin: "md",
          cornerRadius: "5px", spacing: "xs",
          contents: split.length ? split : [fill(t.line, {flex: 1})]},
        {type: "box", layout: "horizontal", margin: "lg", spacing: "sm",
          contents: [
            tile(t.green, "รถลูกบ้าน", resident, "คัน"),
            tile(t.orange, "รถภายนอก", external, "คัน"),
            tile(t.red, "สแกนไม่พบ", report.unreadableDetections, "ครั้ง"),
          ]},
        {type: "separator", margin: "lg", color: t.line},
        buildHeatStrip(),
      ]};
  };
  const dirText = (dirs) => {
    const out = [];
    if (dirs.includes("entry")) out.push("เข้า");
    if (dirs.includes("exit")) out.push("ออก");
    return out.join("/") || "—";
  };
  const displayPlate = (plate) => String(plate || "")
      .replace(/\s+/g, "")
      .replace(/^(.+?)(\d{1,4})$/, "$1 $2");
  const colorLabels = {
    "black": "ดำ", "white": "ขาว", "silver": "เงิน", "gray": "เทา",
    "deep gray": "เทาเข้ม", "red": "แดง", "blue": "น้ำเงิน",
    "deep blue": "น้ำเงินเข้ม", "green": "เขียว", "yellow": "เหลือง",
    "brown": "น้ำตาล", "orange": "ส้ม", "pink": "ชมพู",
    "purple": "ม่วง", "cyan": "ฟ้า",
  };
  const vehicleText = (row) => {
    const vision = normalizeVehicleVision(row.vehicleVision);
    if (vision.confidence < LPR_VISION_MIN_CONFIDENCE) return "";
    const name = [vision.make, vision.model].filter(Boolean).join(" ");
    return [name, colorLabels[vision.color] || ""]
        .filter(Boolean).join(" · ");
  };
  const MAX = 40;
  const externalPlates = report.externalPlates || [];
  // Entry and exit each get a fixed-width cell placed straight in the row so
  // every row's times line up in two columns, even when one side is "—".
  // Kept flat (no wrapper box) to stay well under LINE's 30 KB bubble limit.
  const shiftStartMinutes = (Number.isInteger(report.startHour) ?
    report.startHour : (night ? 19 : 7)) * 60;
  const minutesIntoShift = (hm) => {
    const [h, m] = String(hm).split(":").map(Number);
    return (h * 60 + m - shiftStartMinutes + 1440) % 1440;
  };
  const timeCell = (text, color, width, align) => ({
    type: "box", layout: "vertical", width, contents: [
      {type: "text", text, size: "xs", color, align},
    ],
  });
  const visitorTimes = (row) => {
    if (!row.entryTime && !row.exitTime) {
      return [{type: "text", size: "xs", color: t.label, flex: 0,
        align: "end", text: `${dirText(row.directions || [])} ${
          row.firstTime || "—"}`}];
    }
    // Exit before entry means a camera clock problem or a car that left and
    // came back — flag the pair for a human look. Times are compared from the
    // shift start so 23:40 → 00:35 on the night shift is not flagged.
    const odd = row.entryTime && row.exitTime &&
      minutesIntoShift(row.exitTime) < minutesIntoShift(row.entryTime);
    return [
      timeCell(row.entryTime || "—",
          row.entryTime ? listColors.inTime : t.muted, "40px", "end"),
      // Start-aligned so the arrow stays in one column when exit is "—".
      timeCell(`${odd ? "⚠" : "→"} ${row.exitTime || "—"}`,
          row.exitTime ? listColors.outTime : t.muted, "58px", "start"),
    ];
  };
  const makeRow = (row) => {
    const vehicle = vehicleText(row);
    return {
      type: "box", layout: "horizontal", margin: "md", spacing: "sm",
      alignItems: "center",
      contents: [
        {type: "box", layout: "vertical", width: "72px", height: "24px",
          borderWidth: "1.5px", borderColor: t.text, cornerRadius: "6px",
          justifyContent: "center", alignItems: "center", contents: [
            {type: "text", text: displayPlate(row.plate), size: "xxs",
              weight: "bold", color: t.text, adjustMode: "shrink-to-fit"},
          ]},
        // Long names are cut with "…" rather than shrunk.
        {type: "text", text: vehicle || "ไม่มีข้อมูลรถ", size: "xxs",
          color: vehicle ? t.label : t.muted, flex: 1, wrap: false},
        ...visitorTimes(row),
      ],
    };
  };
  const composeVisitorRows = (shown) => {
    if (report.externalCars === 0) {
      return [{type: "text", text: "ไม่มีรถภายนอกในช่วงนี้", size: "sm",
        color: t.green, align: "center", margin: "md"}];
    }
    const rows = externalPlates.slice(0, shown).map(makeRow);
    const hidden = report.externalCars - shown;
    return hidden > 0 ? [...rows, {type: "text",
      text: `… และอีก ${hidden} คัน`,
      size: "xs", color: t.label, align: "center", margin: "md"}] : rows;
  };
  let shown = report.externalCars === 0 ?
    0 : Math.min(report.externalCars, MAX);
  const visitorRows = composeVisitorRows(shown);
  // A camera with zero events across the whole window almost certainly
  // stopped notifying (e.g. both cameras went silent 2026-07-19 23:54) —
  // surface it on the card instead of silently reporting half the traffic.
  const silentCameras = Object.entries(report.cameraCounts || {})
      .filter(([, count]) => !count)
      .map(([camId]) => camId === "8241" ? "กล้องขาเข้า" :
        camId === "8242" ? "กล้องขาออก" : `กล้อง ${camId}`);
  const cameraWarning = silentCameras.length ? [{
    type: "box", layout: "vertical", margin: "lg", paddingAll: "10px",
    backgroundColor: night ? "#4A3428" : "#FDECEA", cornerRadius: "md",
    contents: [
      {type: "text", size: "xs", weight: "bold", color: t.red, wrap: true,
        text: `⚠️ ${silentCameras.join(" และ ")}ไม่ส่งข้อมูลเลยในช่วงนี้ ` +
          "ยอดรถอาจต่ำกว่าจริง — โปรดตรวจสอบกล้อง"},
    ],
  }] : [];
  const message = {
    type: "flex",
    altText: `${title}: รถผ่านประตู ${report.uniqueCars || 0} คัน`,
    contents: {
      type: "bubble", size: "giga",
      header: {type: "box", layout: "vertical", paddingAll: "18px",
        backgroundColor: t.headBg, contents: [
          {type: "box", layout: "horizontal", alignItems: "center",
            contents: [
              // One line on narrow phones: shrink slightly instead of
              // breaking "(กะกลางคืน)" in the middle.
              {type: "text", text: title, size: "lg", weight: "bold",
                color: t.title, flex: 7, wrap: false,
                adjustMode: "shrink-to-fit"},
              {type: "image", url: t.logo, size: "90px", flex: 3,
                aspectRatio: "928:118", aspectMode: "fit", align: "end"},
            ]},
          // Date and shift window on one line, in a full-width pill so the
          // longer night window still fits.
          {type: "box", layout: "vertical", margin: "md",
            backgroundColor: night ? t.heroBg : "#FFF2B8",
            cornerRadius: "md", paddingAll: "8px", paddingStart: "10px",
            contents: [
              {type: "text", wrap: false, adjustMode: "shrink-to-fit",
                contents: [
                  {type: "span", text: dateText, size: "sm",
                    weight: "bold", color: t.title},
                  {type: "span", text: "   ·   ", size: "sm",
                    color: t.label},
                  {type: "span", text: windowText, size: "sm",
                    color: t.label},
                ]},
            ]},
        ]},
      body: {type: "box", layout: "vertical", paddingAll: "20px",
        backgroundColor: t.bodyBg, contents: [
          buildSummary(),
          ...cameraWarning,
          {type: "separator", margin: "xl", color: t.line},
          {type: "box", layout: "horizontal", margin: "xl",
            alignItems: "center", contents: [
              {type: "text", text: "🚗 รถภายนอก (Visitor)", size: "md",
                weight: "bold", color: t.orange, flex: 4},
              {type: "text", text: `${report.externalCars} คัน`, size: "md",
                weight: "bold", color: t.orange, align: "end", flex: 2},
            ]},
          ...visitorRows,
        ]},
    },
  };
  // LINE rejects any bubble whose JSON exceeds 30 KB; visitor volume can push
  // the card over (145 external cars overflowed on 2026-07-02). Trim trailing
  // rows and recompute the "… และอีก N คัน" note until it is safely under.
  const body = message.contents.body.contents;
  const trimStart = body.length - visitorRows.length;
  while (shown > 0 &&
      Buffer.byteLength(JSON.stringify(message.contents), "utf8") > 29000) {
    shown -= 1;
    const rows = composeVisitorRows(shown);
    body.splice(trimStart, body.length - trimStart, ...rows);
  }
  return message;
}

/**
 * Builds the LINE Flex card for daily traffic (overview template).
 * @param {Object} report
 * @return {Object}
 */
function buildDailyTrafficFlexMessage(report) {
  const startLabel = formatBangkokClock(DAY_SHIFT_START_HOUR);
  const endLabel = formatBangkokClock(DAY_SHIFT_END_HOUR);
  const shiftEndEpoch = Date.parse(`${report.reportDate}T${endLabel}:00+07:00`);
  const completedShift = Date.now() >= shiftEndEpoch;
  return buildPattraWatchFlex(report, {
    variant: "daily",
    windowText: completedShift ? `${startLabel}–${endLabel}` :
      report.timeRange || `${startLabel}–ปัจจุบัน`,
  });
}

/**
 * Persists and optionally sends one daily traffic report.
 * @param {string} reportDate
 * @param {boolean} sendLine
 * @param {string} targetIdOverride registered LINE target for manual tests
 * @param {string} themeName card color theme (classic|slate|cream)
 * @return {Promise<Object>}
 */
async function runDailyTrafficReport(reportDate, sendLine = true,
    targetIdOverride = "", themeName = "") {
  const report = await buildDailyTrafficReport(
      reportDate, DAY_SHIFT_START_HOUR, DAY_SHIFT_END_HOUR);
  report.securityOfficerName = await getSecurityShiftOfficerName("day");
  if (themeName) report.themeName = themeName;
  const reportRef = db.collection(LPR_DAILY_TRAFFIC_COLLECTION)
      .doc(report.reportDate);
  let lineSent = false;
  let lineError = "";
  let lineTargetId = "";
  if (sendLine) {
    try {
      const targetId = targetIdOverride ||
        await resolveLineFlexTargetId("daily", getDailyTrafficTargetId);
      if (!targetId) throw new Error("Daily traffic LINE group is not set");
      lineTargetId = targetId;
      await sendLinePushMessages(targetId, [
        buildDailyTrafficFlexMessage(report),
      ]);
      lineSent = true;
    } catch (error) {
      lineError = String(error.message || error).slice(0, 500);
    }
  } else {
    await resolveLineFlexTargetId("daily", getDailyTrafficTargetId);
  }
  await reportRef.set({
    ...report,
    lineSent,
    lineError,
    lineTargetId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
  return {...report, lineSent, lineError, lineTargetId};
}

/**
 * Returns today's calendar date in Bangkok (YYYY-MM-DD).
 * @return {string}
 */
function getTodayBangkokDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Builds the epoch range for the overnight window that ends on one Bangkok
 * date (the morning the card is sent). A window whose start is later than its
 * end (e.g. 19:00–07:00) starts on the previous evening.
 * @param {string} reportDate YYYY-MM-DD, the morning the window ends
 * @param {number} startHour inclusive start hour (default 0)
 * @param {number} startMinute inclusive start minute (default 0)
 * @param {number} endHour exclusive end hour (default 7)
 * @param {number} endMinute exclusive end minute (default 0)
 * @return {{reportDate: string, startHour: number, endHour: number,
 *   startEpoch: number, endEpoch: number, crossesMidnight: boolean,
 *   shiftStartDate: string}}
 */
function getOvernightRange(reportDate, startHour = 0, startMinute = 0,
    endHour = 7, endMinute = 0) {
  const cleanDate = String(reportDate || "").slice(0, 10);
  const sh = String(startHour).padStart(2, "0");
  const sm = String(startMinute).padStart(2, "0");
  const eh = String(endHour).padStart(2, "0");
  const em = String(endMinute).padStart(2, "0");
  const crossesMidnight = startHour * 60 + startMinute >
    endHour * 60 + endMinute;
  const shiftStartDate = crossesMidnight ?
    shiftBangkokDate(cleanDate, -1) : cleanDate;
  const startEpoch = Date.parse(`${shiftStartDate}T${sh}:${sm}:00+07:00`);
  const endEpoch = Date.parse(`${cleanDate}T${eh}:${em}:00+07:00`);
  return {reportDate: cleanDate, startHour, endHour, startEpoch, endEpoch,
    crossesMidnight, shiftStartDate};
}

/**
 * Formats an epoch as HH:MM in Bangkok time.
 * @param {number} epoch
 * @return {string}
 */
function formatBangkokHm(epoch) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(epoch));
}

/**
 * Builds the overnight (default 19:00–07:00) security report from LPR events.
 * Splits readable detections into resident vs external cars and lists the
 * external plates so the night shift can review who came through.
 * @param {string} reportDate YYYY-MM-DD
 * @param {number} startHour
 * @param {number} startMinute
 * @param {number} endHour
 * @param {number} endMinute
 * @return {Promise<Object>}
 */
async function buildOvernightSecurityReport(reportDate,
    startHour = NIGHT_SHIFT_START_HOUR, startMinute = 0,
    endHour = NIGHT_SHIFT_END_HOUR, endMinute = 0) {
  const range = getOvernightRange(
      reportDate, startHour, startMinute, endHour, endMinute);
  const [eventSnap, expected] = await Promise.all([
    db.collection(LPR_TRAFFIC_EVENTS_COLLECTION)
        .where("capturedAtEpoch", ">=", range.startEpoch)
        .where("capturedAtEpoch", "<", range.endEpoch)
        .get(),
    buildExpectedLprState(),
  ]);
  const events = eventSnap.docs.map((docSnap) => resolveLprPlate({
    id: docSnap.id,
    ...docSnap.data(),
  }, expected));
  const residentSet = new Set(expected.plates);
  const readableEvents = events.filter(isReadableLprEvent);

  // Aggregate per unique plate so each car is counted once with its first
  // detection time and the directions it was seen passing.
  const plateAgg = new Map();
  readableEvents.forEach((event) => {
    const existing = plateAgg.get(event.plate) || {
      plate: event.plate,
      firstEpoch: event.capturedAtEpoch,
      lastEpoch: event.capturedAtEpoch,
      directions: new Set(),
      detections: 0,
      entryEpoch: null,
      exitEpoch: null,
    };
    existing.firstEpoch = Math.min(existing.firstEpoch, event.capturedAtEpoch);
    existing.lastEpoch = Math.max(existing.lastEpoch, event.capturedAtEpoch);
    if (event.direction) existing.directions.add(event.direction);
    if (event.direction === "entry") {
      existing.entryEpoch = existing.entryEpoch === null ?
        event.capturedAtEpoch :
        Math.min(existing.entryEpoch, event.capturedAtEpoch);
    }
    if (event.direction === "exit") {
      existing.exitEpoch = existing.exitEpoch === null ?
        event.capturedAtEpoch :
        Math.min(existing.exitEpoch, event.capturedAtEpoch);
    }
    existing.detections += 1;
    plateAgg.set(event.plate, existing);
  });

  const residentHouses = new Set();
  const residentPlates = [];
  const externalPlates = [];
  Array.from(plateAgg.values())
      .sort((a, b) => a.firstEpoch - b.firstEpoch)
      .forEach((agg) => {
        const houses = expected.plateHouses[agg.plate] || [];
        const row = {
          plate: agg.plate,
          firstTime: formatBangkokHm(agg.firstEpoch),
          lastTime: formatBangkokHm(agg.lastEpoch),
          entryTime: agg.entryEpoch ? formatBangkokHm(agg.entryEpoch) : null,
          exitTime: agg.exitEpoch ? formatBangkokHm(agg.exitEpoch) : null,
          directions: Array.from(agg.directions),
          detections: agg.detections,
          houses,
        };
        if (residentSet.has(agg.plate)) {
          houses.forEach((house) => residentHouses.add(house));
          residentPlates.push(row);
        } else {
          externalPlates.push(row);
        }
      });
  const enrichedExternalPlates = await attachVehicleProfiles(externalPlates);

  const hourlyCounts = Array.from({length: 24}, () => 0);
  events.forEach((event) => {
    const hour = Number(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Bangkok",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(event.capturedAtEpoch)));
    if (Number.isInteger(hour)) hourlyCounts[hour]++;
  });
  const busiestCount = Math.max(...hourlyCounts, 0);
  const busiestHour = busiestCount ? hourlyCounts.indexOf(busiestCount) : null;

  // Count unique cars per direction (a car seen both ways counts in each).
  let entryCars = 0;
  let exitCars = 0;
  plateAgg.forEach((agg) => {
    if (agg.directions.has("entry")) entryCars += 1;
    if (agg.directions.has("exit")) exitCars += 1;
  });

  return {
    reportDate: range.reportDate,
    windowLabel: `${formatBangkokClock(startHour, startMinute)}–` +
      `${formatBangkokClock(endHour, endMinute)}`,
    startHour: range.startHour,
    endHour: range.endHour,
    crossesMidnight: range.crossesMidnight,
    shiftStartDate: range.shiftStartDate,
    generatedAt: new Date().toISOString(),
    totalDetections: events.length,
    entryCars,
    exitCars,
    entryDetections: events
        .filter((event) => event.direction === "entry").length,
    exitDetections: events
        .filter((event) => event.direction === "exit").length,
    uniqueCars: plateAgg.size,
    residentCars: residentPlates.length,
    residentEntryCars: residentPlates
        .filter((r) => r.directions.includes("entry")).length,
    residentExitCars: residentPlates
        .filter((r) => r.directions.includes("exit")).length,
    residentHouses: residentHouses.size,
    residentHouseList: Array.from(residentHouses),
    externalCars: enrichedExternalPlates.length,
    externalEntryCars: enrichedExternalPlates
        .filter((r) => r.directions.includes("entry")).length,
    externalExitCars: enrichedExternalPlates
        .filter((r) => r.directions.includes("exit")).length,
    unreadableDetections: events.length - readableEvents.length,
    busiestHour,
    busiestCount,
    hourlyCounts,
    residentPlates,
    externalPlates: enrichedExternalPlates,
  };
}

/**
 * Builds the LINE Flex card for the overnight security report.
 * @param {Object} report
 * @return {Object}
 */
function buildOvernightSecurityFlexMessage(report) {
  return buildPattraWatchFlex(report, {variant: "night"});
}

/**
 * Splits an array into fixed-size chunks.
 * @param {Array} items
 * @param {number} size
 * @return {Array[]}
 */
function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Builds an arbitrary Bangkok time range, including cross-midnight windows.
 * @param {string} reportDate
 * @param {number} startHour
 * @param {number} startMinute
 * @param {number} endHour
 * @param {number} endMinute
 * @return {Object}
 */
function getSecurityAuditRange(reportDate, startHour, startMinute,
    endHour, endMinute) {
  const cleanDate = String(reportDate || getTodayBangkokDate()).slice(0, 10);
  const start = Number.isFinite(Number(startHour)) ? Number(startHour) : 7;
  const startMin = Number.isFinite(Number(startMinute)) ?
    Number(startMinute) : 30;
  const end = Number.isFinite(Number(endHour)) ? Number(endHour) : 19;
  const endMin = Number.isFinite(Number(endMinute)) ? Number(endMinute) : 30;
  const startEpoch = Date.parse(
      `${cleanDate}T${String(start).padStart(2, "0")}:` +
      `${String(startMin).padStart(2, "0")}:00+07:00`,
  );
  let endEpoch = Date.parse(
      `${cleanDate}T${String(end).padStart(2, "0")}:` +
      `${String(endMin).padStart(2, "0")}:00+07:00`,
  );
  const crossesMidnight = end < start || (end === start && endMin <= startMin);
  if (crossesMidnight) endEpoch += 24 * 60 * 60 * 1000;
  return {
    reportDate: cleanDate,
    startHour: start,
    startMinute: startMin,
    endHour: end,
    endMinute: endMin,
    startEpoch,
    endEpoch,
    crossesMidnight,
    windowLabel: `${formatBangkokClock(start, startMin)}–` +
      `${formatBangkokClock(end, endMin)}`,
    shift: crossesMidnight || start >= 19 ? "night" : "day",
  };
}

/**
 * Builds the LPR slice used by the guard-audit card for any time window.
 * @param {Object} range
 * @return {Promise<Object>}
 */
async function buildSecurityAuditTrafficSlice(range) {
  const [eventSnap, expected] = await Promise.all([
    db.collection(LPR_TRAFFIC_EVENTS_COLLECTION)
        .where("capturedAtEpoch", ">=", range.startEpoch)
        .where("capturedAtEpoch", "<", range.endEpoch)
        .get(),
    buildExpectedLprState(),
  ]);
  const events = eventSnap.docs.map((docSnap) => resolveLprPlate({
    id: docSnap.id,
    ...docSnap.data(),
  }, expected));
  const residentSet = new Set(expected.plates);
  const readableEvents = events.filter(isReadableLprEvent);
  const externalEvents = readableEvents.filter((event) =>
    !residentSet.has(event.plate),
  );
  const aggMap = new Map();
  externalEvents.forEach((event) => {
    const agg = aggMap.get(event.plate) || {
      plate: event.plate,
      firstEpoch: event.capturedAtEpoch,
      directions: new Set(),
      entryEpoch: null,
      exitEpoch: null,
      firstEvent: event,
      eventEpochs: [],
      entryEvent: null,
      exitEvent: null,
    };
    agg.eventEpochs.push(event.capturedAtEpoch);
    if (event.capturedAtEpoch <= agg.firstEpoch) agg.firstEvent = event;
    agg.firstEpoch = Math.min(agg.firstEpoch, event.capturedAtEpoch);
    if (event.direction) agg.directions.add(event.direction);
    if (event.direction === "entry") {
      if (agg.entryEpoch === null || event.capturedAtEpoch < agg.entryEpoch) {
        agg.entryEvent = event;
      }
      agg.entryEpoch = agg.entryEpoch === null ? event.capturedAtEpoch :
        Math.min(agg.entryEpoch, event.capturedAtEpoch);
    }
    if (event.direction === "exit") {
      if (agg.exitEpoch === null || event.capturedAtEpoch < agg.exitEpoch) {
        agg.exitEvent = event;
      }
      agg.exitEpoch = agg.exitEpoch === null ? event.capturedAtEpoch :
        Math.min(agg.exitEpoch, event.capturedAtEpoch);
    }
    aggMap.set(event.plate, agg);
  });
  const buildCaptures = (agg) => {
    const caps = [];
    const add = (ev, label) => {
      if (!ev) return;
      caps.push({
        label,
        direction: ev.direction || "",
        time: ev.capturedAtEpoch ? formatBangkokHm(ev.capturedAtEpoch) : "",
        cameraId: ev.cameraId || "",
        imageUrl: lprEventImageUrl(ev),
      });
    };
    add(agg.entryEvent, "เข้า");
    add(agg.exitEvent, "ออก");
    if (!caps.length) add(agg.firstEvent, "ผ่าน");
    return caps;
  };
  const externalPlateRows = Array.from(aggMap.values())
      .sort((a, b) => a.firstEpoch - b.firstEpoch)
      .map((agg) => ({
        plate: agg.plate,
        firstEpoch: agg.firstEpoch,
        eventEpochs: agg.eventEpochs,
        firstTime: formatBangkokHm(agg.firstEpoch),
        entryTime: agg.entryEpoch ? formatBangkokHm(agg.entryEpoch) : null,
        exitTime: agg.exitEpoch ? formatBangkokHm(agg.exitEpoch) : null,
        directions: Array.from(agg.directions),
        houses: [],
        captures: buildCaptures(agg),
      }));
  const enrichedExternalPlates = await attachVehicleProfiles(externalPlateRows);
  const epochs = events.map((event) => event.capturedAtEpoch).filter(Boolean);
  return {
    timeRange: epochs.length ?
      `${formatBangkokHm(Math.min(...epochs))}–` +
      `${formatBangkokHm(Math.max(...epochs))}` : "",
    eventCount: events.length,
    externalCars: enrichedExternalPlates.length,
    externalPlates: enrichedExternalPlates,
    unreadableDetections: events.length - readableEvents.length,
  };
}

/**
 * Pairs guard-logged plates with LPR plates that differ only by a misread
 * (OCR on either side swaps a letter or digit). A pair needs a small edit
 * distance AND close capture times: <=1 edit within 30 min, or <=3 edits
 * within 10 min (never more than half the shorter plate). Each plate pairs
 * at most once, closest match first.
 * @param {Array<{plate: string, epoch: number}>} logged Unmatched guard plates.
 * @param {Array<{plate: string, epoch: number}>} seen Unmatched LPR plates.
 * @return {Array<Object>} {logged, lpr, distance, minutes} pairs.
 */
function matchSecurityAuditPlates(logged, seen) {
  const rules = [
    {maxDistance: 1, maxMinutes: 30},
    {maxDistance: 3, maxMinutes: 10},
  ];
  const chars = (plate) => Array.from(String(plate || "").replace(/\s+/g, ""));
  const editDistance = (a, b) => {
    let prev = Array.from({length: b.length + 1}, (_, j) => j);
    for (let i = 1; i <= a.length; i += 1) {
      const row = [i];
      for (let j = 1; j <= b.length; j += 1) {
        row[j] = Math.min(prev[j] + 1, row[j - 1] + 1,
            prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = row;
    }
    return prev[b.length];
  };
  const candidates = [];
  logged.forEach((guard) => {
    seen.forEach((camera) => {
      if (!Number.isFinite(guard.epoch) || !Number.isFinite(camera.epoch)) {
        return;
      }
      const a = chars(guard.plate);
      const b = chars(camera.plate);
      const distance = editDistance(a, b);
      const minutes = Math.abs(guard.epoch - camera.epoch) / 60000;
      const cap = Math.floor(Math.min(a.length, b.length) / 2);
      const ok = distance > 0 && distance <= cap && rules.some((rule) =>
        distance <= rule.maxDistance && minutes <= rule.maxMinutes);
      if (ok) {
        candidates.push({logged: guard.plate, lpr: camera.plate, distance,
          minutes: Math.round(minutes)});
      }
    });
  });
  candidates.sort((x, y) => x.distance - y.distance || x.minutes - y.minutes);
  const usedLogged = new Set();
  const usedLpr = new Set();
  return candidates.filter((pair) => {
    if (usedLogged.has(pair.logged) || usedLpr.has(pair.lpr)) return false;
    usedLogged.add(pair.logged);
    usedLpr.add(pair.lpr);
    return true;
  });
}

/**
 * Builds the guard-audit report card using daily traffic + visitor log data.
 * @param {string} reportDate
 * @param {number} startHour
 * @param {number} startMinute
 * @param {number} endHour
 * @param {number} endMinute
 * @param {string} officerNameOverride
 * @return {Promise<Object>}
 */
async function buildSecurityAuditReport(reportDate, startHour = 7,
    startMinute = 30, endHour = 19, endMinute = 30,
    officerNameOverride = "") {
  const scheduleRange = getSecurityAuditRange(
      reportDate, startHour, startMinute, endHour, endMinute);
  const reportRange = scheduleRange.shift === "night" ?
    getSecurityAuditRange(reportDate, 19, 0, 7, 0) :
    getSecurityAuditRange(reportDate, 7, 0, 19, 0);
  const nextDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(reportRange.startEpoch + 24 * 60 * 60 * 1000));
  const visitDates = [reportRange.reportDate];
  if (reportRange.crossesMidnight) visitDates.push(nextDate);
  const [trafficReport, visitorSnaps, officerName, cameraStatuses] =
    await Promise.all([
      buildSecurityAuditTrafficSlice(reportRange),
      Promise.all(visitDates.map((visitDate) =>
        db.collection(VISITOR_INTAKE_COLLECTION)
            .where("visitDate", "==", visitDate)
            .limit(500)
            .get(),
      )),
      getSecurityShiftOfficerName(reportRange.shift),
      db.getAll(...["8241", "8242"].map((cameraId) =>
        db.collection(LPR_AGENT_C_STATUS_COLLECTION).doc(cameraId))),
    ]);
  const visitorRecords = visitorSnaps.flatMap((snap) => snap.docs)
      .map((docSnap) => ({id: docSnap.id, ...(docSnap.data() || {})}))
      .filter((record) => {
        const createdAtMs = record.createdAt && record.createdAt.toMillis ?
          record.createdAt.toMillis() : 0;
        return createdAtMs >= reportRange.startEpoch &&
          createdAtMs < reportRange.endEpoch;
      });

  // Visitor logs store "4ฒง 1808 กรุงเทพ" while LPR reads "4ฒง1808"; compare
  // on the plate without its province so the two sources can match.
  const plateKey = (raw) => normalizeVisitorPlate(
      stripThaiProvinceForLookup(normalizeVisitorPlate(raw)));
  const visitorCarMap = new Map();
  const visitorMotorcycles = [];
  const purposeCounts = new Map();
  visitorRecords.forEach((record) => {
    const plate = plateKey(
        record.vehicleCapture && record.vehicleCapture.plateText,
    );
    const vehicleType = normalizeVisitorVehicleType(
        record.vehicleCapture && record.vehicleCapture.vehicleType,
    );
    if (plate && vehicleType !== "รถมอเตอร์ไซค์") {
      visitorCarMap.set(plate, record);
    }
    if (vehicleType === "รถมอเตอร์ไซค์") {
      visitorMotorcycles.push(record);
    }
    const label = visitorReportPurposeLabel(
        record.purposeCategory || "unknown",
        record.purposeText || "",
    );
    purposeCounts.set(label, (purposeCounts.get(label) || 0) + 1);
  });

  const externalPlates = (trafficReport.externalPlates || []).map((row) => ({
    ...row,
    plate: plateKey(row.plate || ""),
  })).filter((row) => row.plate);
  const lprPlates = new Set(externalPlates.map((row) => row.plate));
  // A misread on either side (e.g. guard OCR "3ฒร 4468" vs camera
  // "3ฒร 4466") would otherwise make the whole shift unassessable.
  const lprEpochs = new Map(externalPlates.map((row) =>
    [row.plate, Number(row.firstEpoch)]));
  const recordEpoch = (record) => record.createdAt &&
    record.createdAt.toMillis ? record.createdAt.toMillis() : NaN;
  const fuzzyMatches = matchSecurityAuditPlates(
      Array.from(visitorCarMap.entries())
          .filter(([plate]) => !lprPlates.has(plate))
          .map(([plate, record]) => ({plate, epoch: recordEpoch(record)})),
      Array.from(lprPlates)
          .filter((plate) => !visitorCarMap.has(plate))
          .map((plate) => ({plate, epoch: lprEpochs.get(plate)})),
  );
  fuzzyMatches.forEach((pair) => {
    const record = visitorCarMap.get(pair.logged);
    visitorCarMap.delete(pair.logged);
    visitorCarMap.set(pair.lpr, record);
  });
  const visitorCarPlates = Array.from(visitorCarMap.keys());
  const outageWindows = auditOutageWindows(
      cameraStatuses.map((snap) => snap.exists ? snap.data() || {} : {}),
      reportRange);
  const unmatchedPlates = Array.from(lprPlates)
      .filter((plate) => !visitorCarMap.has(plate));
  const excusedPlates = unmatchedPlates.filter((plate) =>
    externalPlates.some((row) => row.plate === plate &&
      isOutageAffectedCar(row, outageWindows)));
  const excusedSet = new Set(excusedPlates);
  const missingPlates = unmatchedPlates.filter((plate) =>
    !excusedSet.has(plate));
  // Count the same set of known Visitor plates for every card metric.
  // During power interruptions, guard logs supply cars absent from LPR.
  // Score known cars; forgive unmatched captures during confirmed outages.
  const knownPlates = new Set([...lprPlates, ...visitorCarPlates]);
  const visitorOnlyCars = visitorCarPlates.filter((plate) =>
    !lprPlates.has(plate)).length;
  const uncheckedCars = missingPlates.length;
  const assessmentAvailable = knownPlates.size > 0;
  const missingPlatesDisplay = missingPlates.slice(0,
      Math.min(24, uncheckedCars));
  const missingPlatesLeft = Math.max(0, uncheckedCars -
    missingPlatesDisplay.length);

  return {
    reportDate: reportRange.reportDate,
    windowLabel: reportRange.windowLabel,
    shift: reportRange.shift,
    generatedAt: new Date().toISOString(),
    securityOfficerName: String(officerNameOverride || officerName || "")
        .trim(),
    carTotal: knownPlates.size,
    lprCarTotal: lprPlates.size,
    visitorOnlyCars,
    fuzzyMatches,
    excusedCars: excusedPlates.length,
    excusedPlates,
    assessmentAvailable,
    checkedCars: visitorCarPlates.length,
    uncheckedCars,
    percent: assessmentAvailable ?
      Math.round(((visitorCarPlates.length + excusedPlates.length) /
        knownPlates.size) * 100) : null,
    unreadable: trafficReport.unreadableDetections || 0,
    scanUnreadable: trafficReport.unreadableDetections || 0,
    motorcycleCount: visitorMotorcycles.length,
    purposes: Array.from(purposeCounts.entries())
        .map(([label, count]) => ({label, count}))
        .sort((a, b) =>
          b.count - a.count || a.label.localeCompare(b.label, "th"),
        )
        .slice(0, 4),
    missingPlates,
    missingPlatesDisplay,
    totalMissingLabel: missingPlatesLeft > 0 ?
      `… และอีก ${missingPlatesLeft} คัน` : "",
    trafficReport,
  };
}

/**
 * Rating tiers for the guard-audit card, keyed by getSecurityAuditTier().
 * `tone` colors text on the cream body, `soft` tints the stat strip, and
 * `from`/`to` paint the header gradient behind white text.
 */
const SECURITY_AUDIT_TIERS = {
  full: {
    tone: "#5F7F46", soft: "#EAF3DE", from: "#4C6B38", to: "#7C9C5E",
    emoji: "🏆", name: "ยอดเยี่ยม",
    message: "ตรวจบัตรครบทุกคัน ขอบคุณทีม รปภ. ครับ",
  },
  excellent: {
    tone: "#2F7F73", soft: "#DFF0EC", from: "#256A60", to: "#4C9E90",
    emoji: "🌟", name: "เยี่ยมมาก",
    message: "เกือบครบทุกคันแล้ว เยี่ยมมากครับ",
  },
  good: {
    tone: "#9A8420", soft: "#F6EFC9", from: "#7D6A12", to: "#B79E2E",
    emoji: "👏", name: "ดีมาก",
    message: "ทำได้ดีครับ ขอบคุณที่ช่วยกันตรวจ",
  },
  positive: {
    tone: "#39749A", soft: "#E5F1F8", from: "#326B90", to: "#659BB8",
    emoji: "👍", name: "ตรวจได้ดี",
    message: "ขอบคุณทีม รปภ. กะหน้าช่วยกันตรวจให้ครบทุกคันนะครับ",
  },
  fair: {
    tone: "#C47A2C", soft: "#FBEBD3", from: "#B26A1D", to: "#DB9A44",
    emoji: "💪", name: "เพิ่มการตรวจอีกนิด",
    message: "กะหน้าลองให้ครบ 100% นะครับ",
  },
  low: {
    tone: "#BF4B3A", soft: "#FBE4DF", from: "#A63B2D", to: "#D2604E",
    emoji: "💪", name: "ควรปรับปรุง",
    message: "กะหน้าช่วยกันตรวจบัตรเพิ่มอีกนิดนะครับ",
  },
  unavailable: {
    tone: "#8D7A66", soft: "#EFE7DA", from: "#7A6A58", to: "#A39380",
    emoji: "📋", name: "ประเมินไม่ได้",
    message: "ข้อมูล LPR ไม่เพียงพอสำหรับประเมิน",
  },
};

/**
 * Picks the guard-audit rating tier from the report's real counts.
 * "full" requires zero unchecked cars, never just a rounded 100%.
 * @param {Object} report
 * @return {string} Key of SECURITY_AUDIT_TIERS.
 */
function getSecurityAuditTier(report) {
  const available = report.percent !== null &&
    Number.isFinite(report.percent) &&
    report.assessmentAvailable !== false &&
    Number(report.carTotal) > 0;
  if (!available) return "unavailable";
  if (Number(report.uncheckedCars) === 0) return "full";
  if (report.percent >= 90) return "excellent";
  if (report.percent >= 80) return "good";
  if (report.percent >= 70) return "positive";
  if (report.percent >= 50) return "fair";
  return "low";
}

/**
 * Star rating (0-5) shown on the guard-audit card. Stars follow their own
 * cut-offs, independent of the color tier: full = 5, 80+ = 4.5,
 * 60+ = 3, 50+ = 2, below 50 = 1. Only a true 100% earns five.
 * @param {Object} report
 * @return {number}
 */
function getSecurityAuditStars(report) {
  const tierKey = getSecurityAuditTier(report);
  if (tierKey === "unavailable") return 0;
  if (tierKey === "full") return 5;
  if (report.percent >= 80) return 4.5;
  if (report.percent >= 60) return 3;
  if (report.percent >= 50) return 2;
  return 1;
}

/**
 * Builds the guard-audit LINE card: a tier-colored header with the score,
 * a 10-segment progress track, and up to six unchecked plates.
 * @param {Object} report
 * @return {Object}
 */
function buildSecurityAuditFlexMessage(report) {
  const t = {
    bodyBg: "#FFFCF6",
    title: "#34281F",
    text: "#47372B",
    label: "#8D7A66",
    labelStrong: "#6F5D4B",
    line: "#E7DCCB",
    track: "#EADDCB",
    green: "#5F7F46",
    white: "#FFFFFF",
    whiteSoft: "#FFFFFFD9",
    whiteDim: "#FFFFFF55",
    divider: "#00000014",
    pill: "#00000038",
    pillLight: "#FFFFFFEB",
  };
  const tierKey = getSecurityAuditTier(report);
  const tier = SECURITY_AUDIT_TIERS[tierKey];
  const available = tierKey !== "unavailable";
  const starCount = getSecurityAuditStars(report);
  const carTotal = Number(report.carTotal) || 0;
  const checkedCars = Number(report.checkedCars) || 0;
  const uncheckedCars = Number(report.uncheckedCars) || 0;
  const excusedCars = Number(report.excusedCars) || 0;
  // A rounded 100% must not show while any car is still unchecked.
  const percent = available ?
    Math.max(0, Math.min(uncheckedCars > 0 ? 99 : 100, report.percent)) :
    null;
  // Gregorian (ค.ศ.) year on purpose; do not use the default Buddhist era.
  const dateText = new Intl.DateTimeFormat("th-TH-u-ca-gregory", {
    dateStyle: "medium",
    timeZone: "Asia/Bangkok",
  }).format(new Date(`${report.reportDate}T12:00:00+07:00`));
  const timeText = `${report.displayWindowLabel || report.windowLabel} น.`;
  const isNight = report.shift === "night";
  const shiftName = isNight ? "กะกลางคืน" : "กะกลางวัน";
  const shiftLabel = `${isNight ? "🦉" : "🌤️"} ${shiftName}`;
  // Day = light pill / dark text, night = dark pill / white text, so the
  // shift reads at a glance even without the emoji.
  const shiftPill = isNight ?
    {bg: t.pill, color: t.white} : {bg: t.pillLight, color: t.title};

  const stat = (value, label, color) => ({
    type: "box",
    layout: "vertical",
    flex: 1,
    alignItems: "center",
    // Label first so it reads naturally in Thai: "ตรวจแล้ว" → "5 คัน".
    contents: [
      // sm label shrinks only if a narrow phone cannot fit it on one line.
      {type: "text", text: label, size: "sm", weight: "bold",
        color: t.labelStrong, align: "center", wrap: false,
        adjustMode: "shrink-to-fit"},
      {type: "text", text: value, size: "lg", weight: "bold", color,
        align: "center", margin: "xs", wrap: false,
        adjustMode: "shrink-to-fit"},
    ],
  });
  const statDivider = {type: "separator", color: t.divider};

  // Smooth track; the filled part uses the same gradient as the header.
  const fillFlex = available && percent > 0 ?
    Math.max(1, Math.min(100, percent)) : 0;
  const progressFill = fillFlex > 0 ? [{
    type: "box",
    layout: "vertical",
    flex: fillFlex,
    cornerRadius: "6px",
    backgroundColor: tier.tone,
    background: {
      type: "linearGradient",
      angle: "0deg",
      startColor: tier.from,
      endColor: tier.to,
    },
    contents: [{type: "filler"}],
  }] : [];
  if (fillFlex > 0 && fillFlex < 100) {
    progressFill.push({type: "box", layout: "vertical",
      flex: 100 - fillFlex, contents: [{type: "filler"}]});
  }
  const progress = {
    type: "box",
    layout: "horizontal",
    height: "12px",
    margin: "sm",
    backgroundColor: t.track,
    cornerRadius: "6px",
    contents: progressFill.length ? progressFill : [{type: "filler"}],
  };

  const plateBadge = (plate) => ({
    type: "box",
    layout: "vertical",
    flex: 1,
    height: "30px",
    borderColor: t.text,
    borderWidth: "1px",
    cornerRadius: "7px",
    justifyContent: "center",
    alignItems: "center",
    contents: [
      {type: "text", text: plate, size: "xxs", weight: "bold",
        color: t.text, align: "center", wrap: false,
        adjustMode: "shrink-to-fit"},
    ],
  });
  const shownPlates = available ?
    (report.missingPlates || []).slice(0, 6) : [];
  const platesLeft = available ?
    Math.max(0, uncheckedCars - shownPlates.length) : 0;
  const plateSlots = shownPlates.map(plateBadge);
  if (platesLeft > 0) {
    plateSlots.push({type: "text", text: `อีก ${platesLeft} คัน`,
      size: "xs", color: t.label, align: "center", gravity: "center",
      flex: 1});
  }
  const plateRows = chunkArray(plateSlots, 3).map((row) => ({
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    margin: "sm",
    contents: [...row, ...Array.from({length: 3 - row.length},
        () => ({type: "filler"}))],
  }));

  const starAssetBase = "https://firebasestorage.googleapis.com/v0/b/" +
    "pattra8-54c3f.firebasestorage.app/o/lpr_assets%2F" +
    "security-audit-star-v1-";
  const stars = available ? [{
    type: "box",
    layout: "baseline",
    spacing: "2px",
    margin: "xs",
    contents: Array.from({length: 5}, (_, index) => {
      const fill = starCount >= index + 1 ? "full" :
        starCount > index ? "half" : "empty";
      return {
        type: "icon",
        url: `${starAssetBase}${fill}.png?alt=media&token=` +
          "9f3d7d58-2db0-4ff5-8655-f2726243fb47",
        size: "20px",
        aspectRatio: "1:1",
      };
    }),
  }] : [{type: "text", text: "ตรวจบัตรรถยนต์", size: "xs",
    color: t.whiteSoft, margin: "xs"}];

  return {
    type: "flex",
    altText: `ตรวจงาน รปภ. ${shiftName} ${dateText}: ` + (available ?
      `${tier.name} คะแนน ${percent}% (ตรวจ ${checkedCars} คัน` +
      ` ยกเว้น ${excusedCars} คัน)` :
      "ประเมินไม่ได้"),
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        backgroundColor: tier.from,
        background: {
          type: "linearGradient",
          angle: "135deg",
          startColor: tier.from,
          endColor: tier.to,
        },
        contents: [
          {type: "box", layout: "horizontal", alignItems: "center",
            contents: [
              {type: "text", text: "ตรวจงาน รปภ.", size: "lg",
                weight: "bold", color: t.white, flex: 0},
              {type: "filler"},
              {type: "box", layout: "horizontal", flex: 0,
                backgroundColor: shiftPill.bg, cornerRadius: "14px",
                paddingTop: "4px", paddingBottom: "4px",
                paddingStart: "10px", paddingEnd: "12px",
                contents: [
                  {type: "text", text: shiftLabel, size: "sm",
                    weight: "bold", color: shiftPill.color, flex: 0,
                    wrap: false},
                ]},
            ]},
          {type: "text", text: `${dateText} · ${timeText}`, size: "xs",
            color: t.whiteSoft, margin: "xs", wrap: false,
            adjustMode: "shrink-to-fit"},
          {type: "box", layout: "horizontal", margin: "lg",
            alignItems: "center", contents: [
              {type: "text", text: tier.emoji, size: "4xl", flex: 0},
              {type: "box", layout: "vertical", flex: 1, margin: "md",
                contents: [
                  {type: "text", text: tier.name, size: "md",
                    weight: "bold", color: t.white, wrap: false,
                    adjustMode: "shrink-to-fit"},
                  ...stars,
                ]},
              ...(available ? [{type: "text", text: `${percent}%`,
                size: "4xl", weight: "bold", color: t.white, flex: 0,
                align: "end", wrap: false}] : []),
            ]},
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        backgroundColor: t.bodyBg,
        contents: [
          {type: "box", layout: "horizontal", contents: [
            {type: "text", text: "ตรวจบัตรรถยนต์", size: "xs",
              weight: "bold", color: t.label, flex: 1},
            ...(available ? [{type: "text",
              text: excusedCars > 0 ?
                `ตรวจ ${checkedCars} · ยกเว้น ${excusedCars} คัน` :
                `${checkedCars} / ${carTotal} คัน`, size: "xs",
              weight: "bold", color: tier.tone, align: "end",
              flex: 0}] : []),
          ]},
          progress,
          {type: "text", text: excusedCars > 0 ?
            `ยกเว้น ${excusedCars} คันช่วง ANPR ขัดข้อง ไม่หักคะแนน รปภ.` :
            tier.message, size: "sm", wrap: true,
          margin: "md", color: available ? t.text : t.label},
          {
            type: "box",
            layout: "horizontal",
            margin: "lg",
            paddingAll: "10px",
            cornerRadius: "12px",
            backgroundColor: tier.soft,
            contents: [
              stat(available ? `${carTotal} คัน` : "ไม่ทราบ", "รถ Visitor",
                  available ? t.title : t.label),
              statDivider,
              stat(`${checkedCars} คัน`, "ตรวจแล้ว", t.green),
              statDivider,
              stat(available ? `${uncheckedCars} คัน` : "ไม่ทราบ",
                  "ไม่ได้ตรวจบัตร",
                  available && uncheckedCars > 0 ? tier.tone : t.label),
            ],
          },
          ...(plateRows.length ? [
            {type: "text", text: "ทะเบียนที่ไม่ได้ตรวจบัตร", size: "sm",
              weight: "bold", color: t.title, margin: "lg"},
            ...plateRows,
          ] : []),
          {type: "separator", margin: "lg", color: t.line},
          {type: "box", layout: "horizontal", margin: "md",
            backgroundColor: "#EDF2EC", cornerRadius: "12px",
            paddingAll: "14px", spacing: "md", alignItems: "center",
            contents: [
              {type: "text", text: "🛵", size: "xxl", flex: 0},
              {type: "box", layout: "vertical", flex: 1, spacing: "xs",
                contents: [
                  {type: "text", text: "มอเตอร์ไซค์", size: "sm",
                    weight: "bold", color: t.text, wrap: true},
                  {type: "text", text: "เข้า–ออกโครงการวันนี้", size: "xxs",
                    color: t.label, wrap: true},
                ]},
              {type: "text", size: "xxl", flex: 0, contents: [
                {type: "span",
                  text: `${Number(report.motorcycleCount) || 0}`,
                  weight: "bold", color: t.text},
                {type: "span", text: " คัน", size: "sm", color: t.text},
              ]},
            ]},
          {type: "text",
            text: `อัปเดต ${formatBangkokHm(Date.now())} น.`,
            size: "xxs", color: t.label, align: "end", margin: "md"},
        ],
      },
    },
  };
}

/**
 * Runs the guard-audit report build and optionally sends it to LINE.
 * @param {string} reportDate
 * @param {boolean} sendLine
 * @param {number} startHour
 * @param {number} startMinute
 * @param {number} endHour
 * @param {number} endMinute
 * @param {string} [targetIdOverride]
 * @param {string} [officerNameOverride]
 * @return {Promise<Object>}
 */
async function runSecurityAuditReport(reportDate, sendLine = true,
    startHour = 7, startMinute = 30, endHour = 19, endMinute = 30,
    targetIdOverride = "",
    officerNameOverride = "") {
  const report = await buildSecurityAuditReport(
      reportDate,
      startHour,
      startMinute,
      endHour,
      endMinute,
      officerNameOverride,
  );
  let lineSent = false;
  let lineError = "";
  let lineTargetId = "";
  if (sendLine) {
    try {
      const routeKey = report.shift === "night" ? "guardNight" : "guardDay";
      const targetId = targetIdOverride ||
        await resolveLineFlexTargetId(routeKey, getGuardAuditTargetId);
      if (!targetId) throw new Error("Guard audit LINE group is not set");
      lineTargetId = targetId;
      await sendLinePushMessages(targetId, [
        buildSecurityAuditFlexMessage(report),
      ]);
      lineSent = true;
    } catch (error) {
      lineError = String(error.message || error);
      logger.error("runSecurityAuditReport send failed", error);
    }
  }
  return {...report, lineSent, lineError, lineTargetId};
}

/**
 * Moves a Bangkok calendar date by a whole number of days.
 * @param {string} reportDate YYYY-MM-DD
 * @param {number} dayOffset
 * @return {string}
 */
function shiftBangkokDate(reportDate, dayOffset) {
  const cleanDate = String(reportDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
    throw new Error("Invalid report date");
  }
  const epoch = Date.parse(`${cleanDate}T12:00:00+07:00`) +
    Number(dayOffset || 0) * 24 * 60 * 60 * 1000;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epoch));
}

/**
 * Formats a compact Thai date range for the weekly resident card.
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 * @return {string}
 */
function formatWeeklyThaiDateRange(startDate, endDate) {
  const format = (date, includeYear) => new Intl.DateTimeFormat(
      "th-TH-u-ca-gregory", {
        day: "numeric",
        month: "long",
        ...(includeYear ? {year: "numeric"} : {}),
        timeZone: "Asia/Bangkok",
      }).format(new Date(`${date}T12:00:00+07:00`));
  const sameYear = startDate.slice(0, 4) === endDate.slice(0, 4);
  const sameMonth = startDate.slice(0, 7) === endDate.slice(0, 7);
  if (sameMonth) {
    const startDay = Number(startDate.slice(8, 10));
    return `${startDay}–${format(endDate, true)}`;
  }
  return `${format(startDate, !sameYear)} – ${format(endDate, true)}`;
}

/**
 * Builds a seven-day resident-safe safety summary from Daily Watch and
 * guard-audit data. The window ends on a completed traffic day.
 * @param {string} endDate YYYY-MM-DD
 * @return {Promise<Object>}
 */
async function buildWeeklySafetyReport(endDate) {
  const cleanEndDate = String(endDate || getYesterdayBangkokDate()).trim();
  const startDate = shiftBangkokDate(cleanEndDate, -6);
  const reportDates = Array.from({length: 7}, (_, index) =>
    shiftBangkokDate(startDate, index));
  const dailyBundles = await Promise.all(reportDates.map(async (reportDate) => {
    const [traffic, guardDay, guardNight] = await Promise.all([
      buildDailyTrafficReport(reportDate),
      buildSecurityAuditReport(reportDate, 7, 30, 19, 30),
      buildSecurityAuditReport(reportDate, 19, 30, 7, 30),
    ]);
    return {traffic, guardDay, guardNight};
  }));
  const trafficReports = dailyBundles.map((bundle) => bundle.traffic);
  const guardReports = dailyBundles.flatMap((bundle) => [
    bundle.guardDay,
    bundle.guardNight,
  ]);
  const sum = (items, key) => items.reduce(
      (total, item) => total + Number(item && item[key] || 0), 0);
  const hourlyCounts = Array.from({length: 24}, (_, hour) =>
    trafficReports.reduce((total, report) =>
      total + Number(report.hourlyCounts && report.hourlyCounts[hour] || 0),
    0));
  const busiestCount = Math.max(...hourlyCounts, 0);
  const busiestHour = busiestCount ? hourlyCounts.indexOf(busiestCount) : null;
  const purposeCounts = new Map();
  guardReports.forEach((report) => {
    (report.purposes || []).forEach((item) => {
      const label = String(item.label || "อื่น ๆ");
      purposeCounts.set(
          label,
          (purposeCounts.get(label) || 0) + Number(item.count || 0),
      );
    });
  });
  const visitorCars = sum(guardReports, "carTotal");
  const checkedCars = guardReports.reduce((total, report) => {
    const carTotal = Number(report.carTotal || 0);
    return total + Math.min(carTotal, Number(report.checkedCars || 0));
  }, 0);
  const excusedCars = sum(guardReports, "excusedCars");
  const uncheckedCars = Math.max(0, visitorCars - checkedCars - excusedCars);
  const assessmentAvailable = visitorCars > 0 && guardReports.every(
      (report) => report.assessmentAvailable ||
        (report.carTotal === 0 && report.trafficReport.eventCount > 0));
  const cameraComplete = trafficReports.every((report) =>
    Number(report.cameraCounts && report.cameraCounts["8241"] || 0) > 0 &&
    Number(report.cameraCounts && report.cameraCounts["8242"] || 0) > 0);
  return {
    startDate,
    endDate: cleanEndDate,
    reportDates,
    dateLabel: formatWeeklyThaiDateRange(startDate, cleanEndDate),
    generatedAt: new Date().toISOString(),
    trafficCars: sum(trafficReports, "uniqueCars"),
    residentCars: sum(trafficReports, "residentCars"),
    externalCars: sum(trafficReports, "externalCars"),
    visitorCars,
    excusedCars,
    checkedCars,
    uncheckedCars,
    assessmentAvailable,
    checkPercent: assessmentAvailable ?
      Math.round(((checkedCars + excusedCars) / visitorCars) * 1000) / 10 :
      null,
    motorcycleCount: sum(guardReports, "motorcycleCount"),
    unreadableDetections: sum(trafficReports, "unreadableDetections"),
    busiestHour,
    busiestCount,
    hourlyCounts,
    cameraComplete,
    purposes: Array.from(purposeCounts.entries())
        .map(([label, count]) => ({label, count}))
        .sort((a, b) =>
          b.count - a.count || a.label.localeCompare(b.label, "th"))
        .slice(0, 4),
  };
}

/**
 * Builds the resident-facing weekly safety Flex in the selected
 * Design A / Content B direction.
 * @param {Object} report
 * @return {Object}
 */
function buildWeeklySafetyFlexMessage(report) {
  const t = {
    headBg: "#EFE5D4",
    bodyBg: "#FFFAF1",
    cardBg: "#F4ECDF",
    auditBg: "#F2E7D6",
    statusBg: "#EDF4E8",
    ink: "#362C24",
    muted: "#847568",
    green: "#547445",
    greenLight: "#DCE9D6",
    orange: "#C87338",
    line: "#E5D9C7",
    track: "#DED1BF",
  };
  const stat = (value, label, color) => ({
    type: "box",
    layout: "vertical",
    flex: 1,
    backgroundColor: t.cardBg,
    cornerRadius: "13px",
    paddingAll: "12px",
    contents: [
      {
        type: "box",
        layout: "horizontal",
        alignItems: "center",
        contents: [
          {
            type: "box",
            layout: "vertical",
            width: "7px",
            height: "7px",
            cornerRadius: "4px",
            backgroundColor: color,
            contents: [{type: "filler"}],
          },
          {
            type: "text",
            text: label,
            size: "xxs",
            color: t.muted,
            margin: "sm",
          },
        ],
      },
      {
        type: "text",
        text: String(value),
        size: "xl",
        weight: "bold",
        color: t.ink,
        margin: "sm",
      },
      {type: "text", text: "คัน · รวมรายวัน", size: "xxs", color: t.muted},
    ],
  });
  const purposeIcons = ["📦", "🛠️", "🏠", "•••"];
  const purposeRows = (report.purposes || []).map((item, index) => ({
    type: "box",
    layout: "horizontal",
    alignItems: "center",
    margin: index ? "md" : "sm",
    contents: [
      {
        type: "box",
        layout: "vertical",
        width: "26px",
        height: "26px",
        cornerRadius: "8px",
        backgroundColor: t.headBg,
        justifyContent: "center",
        alignItems: "center",
        contents: [{
          type: "text",
          text: purposeIcons[index] || "•",
          size: "xxs",
          align: "center",
          color: t.ink,
        }],
      },
      {
        type: "text",
        text: item.label,
        size: "xs",
        color: t.ink,
        flex: 4,
        margin: "sm",
        wrap: true,
      },
      {
        type: "text",
        text: `${item.count} รายการ`,
        size: "xs",
        weight: "bold",
        color: t.ink,
        align: "end",
        flex: 2,
        wrap: false,
        adjustMode: "shrink-to-fit",
      },
    ],
  }));
  const assessmentAvailable = report.checkPercent !== null &&
    report.assessmentAvailable !== false;
  const checkPercent = Math.max(0, Math.min(
      100, Number(report.checkPercent || 0)));
  const assessmentText = assessmentAvailable ?
    `${checkPercent}%` : "ประเมินไม่ได้";
  const progressFlex = Math.max(1, Math.round(checkPercent));
  const remainingFlex = Math.max(1, 100 - progressFlex);
  const peakText = report.busiestHour === null ? "ยังไม่มีข้อมูลช่วงพีค" :
    `ช่วงรถหนาแน่นที่สุด ${String(report.busiestHour)
        .padStart(2, "0")}:00–${String((report.busiestHour + 1) % 24)
        .padStart(2, "0")}:00 น.`;
  const cameraText = report.cameraComplete ?
    "✓ กล้องทางเข้าและทางออกส่งข้อมูลครบตลอดสัปดาห์" :
    "⚠️ พบช่วงที่กล้องทางเข้าหรือทางออกไม่มีข้อมูล";
  return {
    type: "flex",
    altText: `สรุปความปลอดภัย ${report.dateLabel}: ` +
      `ตรวจ Visitor ${assessmentText}`,
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box",
        layout: "vertical",
        paddingAll: "18px",
        backgroundColor: t.headBg,
        contents: [
          {
            type: "text",
            text: "PATTRA VILLA 8",
            size: "xs",
            weight: "bold",
            color: t.ink,
          },
          ...(report.preview ? [{
            type: "text",
            text: "ข้อมูลตัวอย่าง · Sandbox",
            size: "xxs",
            weight: "bold",
            color: t.orange,
            margin: "sm",
          }] : []),
          {
            type: "text",
            text: "สรุปความปลอดภัยประจำสัปดาห์",
            size: "lg",
            weight: "bold",
            color: t.ink,
            margin: "lg",
            wrap: true,
          },
          {
            type: "text",
            text: report.dateLabel,
            size: "sm",
            color: t.muted,
            margin: "sm",
          },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "18px",
        backgroundColor: t.bodyBg,
        contents: [
          {
            type: "text",
            text: "เรียนลูกบ้าน สัปดาห์นี้ระบบ Pattra Watch และทีม รปภ. " +
              "ได้ดูแลการเข้า–ออก พร้อมตรวจผู้มาติดต่ออย่างต่อเนื่อง " +
              "สรุปภาพรวมได้ดังนี้",
            size: "xs",
            color: t.muted,
            wrap: true,
            lineSpacing: "5px",
          },
          {
            type: "box",
            layout: "vertical",
            backgroundColor: t.green,
            cornerRadius: "18px",
            paddingAll: "16px",
            margin: "lg",
            contents: [
              {
                type: "text",
                text: "ภาพรวมการเข้า–ออก",
                size: "xxs",
                weight: "bold",
                color: t.greenLight,
              },
              {
                type: "box",
                layout: "horizontal",
                alignItems: "flex-end",
                margin: "sm",
                contents: [
                  {
                    type: "text",
                    text: String(report.trafficCars),
                    size: "3xl",
                    weight: "bold",
                    color: "#FFFFFF",
                    flex: 2,
                  },
                  {
                    type: "text",
                    text: "คัน · ยอดรวมรายวัน",
                    size: "xs",
                    weight: "bold",
                    color: "#FFFFFF",
                    align: "end",
                    flex: 3,
                    margin: "sm",
                  },
                ],
              },
              {
                type: "text",
                text: "สรุปจากรายงาน Daily Watch ตลอด 7 วัน",
                size: "xxs",
                color: t.greenLight,
                margin: "sm",
              },
            ],
          },
          {
            type: "box",
            layout: "horizontal",
            spacing: "sm",
            margin: "md",
            contents: [
              stat(report.residentCars, "รถลูกบ้าน", t.green),
              stat(report.externalCars, "รถภายนอก", t.orange),
            ],
          },
          {type: "separator", margin: "lg", color: t.line},
          {
            type: "text",
            text: "🛡️  การตรวจผู้มาติดต่อ",
            size: "sm",
            weight: "bold",
            color: t.ink,
            margin: "lg",
          },
          {
            type: "box",
            layout: "vertical",
            backgroundColor: t.auditBg,
            cornerRadius: "16px",
            paddingAll: "14px",
            margin: "md",
            contents: [
              {
                type: "box",
                layout: "horizontal",
                alignItems: "center",
                contents: [
                  {
                    type: "text",
                    text: report.excusedCars > 0 ?
                      `คะแนนตรวจ (ยกเว้น ANPR ${report.excusedCars} คัน)` :
                      "อัตราตรวจและบันทึกข้อมูล",
                    size: "xs",
                    weight: "bold",
                    color: t.ink,
                    flex: 4,
                  },
                  {
                    type: "text",
                    text: assessmentText,
                    wrap: true,
                    size: "xl",
                    weight: "bold",
                    color: t.green,
                    align: "end",
                    flex: 2,
                  },
                ],
              },
              {
                type: "box",
                layout: "horizontal",
                height: "8px",
                backgroundColor: t.track,
                cornerRadius: "4px",
                margin: "sm",
                contents: [
                  {
                    type: "box",
                    layout: "vertical",
                    flex: progressFlex,
                    backgroundColor: assessmentAvailable ? t.green : t.track,
                    cornerRadius: "4px",
                    contents: [{type: "filler"}],
                  },
                  {
                    type: "box",
                    layout: "vertical",
                    flex: remainingFlex,
                    contents: [{type: "filler"}],
                  },
                ],
              },
              {
                type: "box",
                layout: "horizontal",
                spacing: "md",
                margin: "md",
                contents: [
                  {
                    type: "box",
                    layout: "vertical",
                    flex: 1,
                    contents: [
                      {
                        type: "text",
                        text: `${report.checkedCars} คัน`,
                        size: "md",
                        weight: "bold",
                        color: t.ink,
                      },
                      {
                        type: "text",
                        text: "ตรวจและบันทึกแล้ว",
                        size: "xxs",
                        color: t.muted,
                        margin: "xs",
                      },
                    ],
                  },
                  {
                    type: "separator",
                    color: t.track,
                  },
                  {
                    type: "box",
                    layout: "vertical",
                    flex: 1,
                    contents: [
                      {
                        type: "text",
                        text: `${report.uncheckedCars} คัน`,
                        size: "md",
                        weight: "bold",
                        color: t.ink,
                      },
                      {
                        type: "text",
                        text: "อยู่ระหว่างตรวจสอบข้อมูล",
                        size: "xxs",
                        color: t.muted,
                        margin: "xs",
                        wrap: true,
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {type: "separator", margin: "lg", color: t.line},
          {
            type: "text",
            text: "ผู้มาติดต่อมาทำอะไรบ้าง",
            size: "sm",
            weight: "bold",
            color: t.ink,
            margin: "lg",
          },
          ...(purposeRows.length ? purposeRows : [{
            type: "text",
            text: "ยังไม่มีข้อมูลเหตุผลที่มาติดต่อ",
            size: "xs",
            color: t.muted,
            align: "center",
            margin: "md",
          }]),
          {type: "separator", margin: "lg", color: t.line},
          {
            type: "box",
            layout: "vertical",
            backgroundColor: t.statusBg,
            cornerRadius: "12px",
            paddingAll: "12px",
            margin: "lg",
            contents: [
              {
                type: "text",
                text: cameraText,
                size: "xxs",
                weight: "bold",
                color: report.cameraComplete ? t.green : t.orange,
                wrap: true,
              },
              {
                type: "text",
                text: `⏰ ${peakText}`,
                size: "xxs",
                color: t.green,
                margin: "sm",
                wrap: true,
              },
              {
                type: "text",
                text: `🏍️ มอเตอร์ไซค์ผู้มาติดต่อ ` +
                  `${report.motorcycleCount} คัน`,
                size: "xxs",
                color: t.green,
                margin: "sm",
              },
            ],
          },
          {
            type: "text",
            text: "ขอบคุณลูกบ้านที่ร่วมกันดูแลความปลอดภัย",
            size: "xxs",
            color: t.muted,
            align: "center",
            margin: "lg",
          },
          {
            type: "text",
            text: "Pattra Watch × บันทึกการปฏิบัติงาน รปภ.",
            size: "xxs",
            color: t.muted,
            align: "center",
            margin: "xs",
          },
        ],
      },
    },
  };
}

/**
 * Builds a compact LINE Flex heatmap for Pattra Pay payment status.
 * Intended for sandbox/manual preview only.
 * @param {Object} data
 * @return {Object}
 */
function buildPaymentHeatmapFlexMessage(data) {
  const paid = new Set([
    ...(data.paidHouses || []),
    ...(data.overageHouses || []),
  ]);
  const total = 68;
  const paidCount = paid.size;
  const unpaidCount = Math.max(0, total - paidCount);
  const t = {
    bg: "#FFFDF8",
    head: "#F7F0E4",
    paidBox: "#E8F7F1",
    dueBox: "#FFFAF2",
    text: "#251F18",
    label: "#7A6E5D",
    soft: "#A79A89",
    line: "#E5D9C8",
    paid: "#07986A",
    paidDark: "#05754F",
    unpaid: "#FFFFFF",
    unpaidText: "#71675A",
    unpaidBorder: "#DACDBA",
  };
  const title = data.feeType === "parking" ?
    "สถานะชำระค่าจอดรถ" : "สถานะชำระค่าส่วนกลาง";
  const periodLabel = data.period === "H1" ? "งวดต้นปี" : "งวดกลางปี";
  const displayYear = Number(data.year || 0);
  const legend = (color, text, borderColor = color) => ({
    type: "box", layout: "horizontal", spacing: "xs", alignItems: "center",
    flex: 0, contents: [
      {type: "box", layout: "vertical", width: "10px", height: "10px",
        cornerRadius: "5px", backgroundColor: color, borderColor,
        borderWidth: "1px", contents: [
          {type: "filler"},
        ]},
      {type: "text", text, size: "xxs", color: t.label, flex: 0,
        wrap: false},
    ],
  });
  const metric = (value, label, color, bg, unit = "") => ({
    type: "box", layout: "vertical", flex: 1, backgroundColor: bg,
    cornerRadius: "12px", paddingAll: "10px", borderColor: t.line,
    borderWidth: "1px", contents: [
      {type: "text", size: "xl", weight: "bold", color, align: "center",
        contents: unit ? [
          {type: "span", text: String(value)},
          {type: "span", text: ` ${unit}`, size: "sm"},
        ] : [{type: "span", text: String(value)}]},
      {type: "text", text: label, size: "xxs", weight: "bold",
        color: t.label, align: "center", margin: "xs"},
    ],
  });
  const percent = Math.round((paidCount / total) * 100);
  const tile = (house) => {
    const isPaid = paid.has(house);
    return {
      type: "box", layout: "vertical", flex: 1, height: "44px",
      cornerRadius: "12px", backgroundColor: isPaid ? t.paid : t.unpaid,
      borderColor: isPaid ? t.paidDark : t.unpaidBorder,
      borderWidth: "1px", justifyContent: "center", alignItems: "center",
      contents: [
        {type: "text", text: `38/${house}`, size: "xs", weight: "bold",
          color: isPaid ? "#FFFFFF" : t.unpaidText, align: "center",
          adjustMode: "shrink-to-fit"},
      ],
    };
  };
  const rows = [];
  for (let start = 1; start <= total; start += 6) {
    const contents = [];
    for (let house = start; house < start + 6 && house <= total; house++) {
      contents.push(tile(house));
    }
    const remaining = total - start + 1;
    const pad = remaining < 6 ? Math.floor((6 - remaining) / 2) : 0;
    for (let i = 0; i < pad; i++) {
      contents.unshift({type: "box", layout: "vertical", flex: 1,
        height: "44px", backgroundColor: "#FFFFFF00", borderWidth: "0px",
        contents: [{type: "filler"}]});
      contents.push({type: "box", layout: "vertical", flex: 1,
        height: "44px", backgroundColor: "#FFFFFF00", borderWidth: "0px",
        contents: [{type: "filler"}]});
    }
    rows.push({type: "box", layout: "horizontal", spacing: "xs",
      margin: rows.length ? "sm" : "md", justifyContent: "center",
      contents});
  }
  return {
    type: "flex",
    altText: `${title} ${periodLabel} จ่ายแล้ว ${paidCount}/${total}`,
    contents: {
      type: "bubble", size: "giga",
      header: {type: "box", layout: "vertical", paddingAll: "18px",
        backgroundColor: t.head, contents: [
          {type: "box", layout: "horizontal", spacing: "sm",
            alignItems: "flex-start", contents: [
              {type: "box", layout: "vertical", flex: 1, contents: [
                {type: "text", text: title, size: "lg", weight: "bold",
                  color: t.text, wrap: true},
                {type: "text",
                  text: `${periodLabel} ${displayYear}`,
                  size: "sm", color: t.label, margin: "xs", wrap: true},
              ]},
              {type: "image",
                url: "https://raw.githubusercontent.com/pattra8/" +
                  "pattra8.github.io/main/paystatus/" +
                  "pattra-villa-logo-flex-v3.png",
                size: "130px", aspectMode: "fit", aspectRatio: "1440:159",
                flex: 0, margin: "xs"},
            ]},
        ]},
      body: {type: "box", layout: "vertical", paddingAll: "16px",
        backgroundColor: t.bg, contents: [
          {type: "box", layout: "horizontal", spacing: "sm", contents: [
            metric(paidCount, "จ่ายแล้ว", t.paid, t.paidBox, "หลัง"),
            metric(unpaidCount, "รอชำระ", t.unpaidText, t.dueBox, "หลัง"),
            metric(`${percent}%`, "ชำระแล้ว", t.paid, t.paidBox),
          ]},
          {type: "separator", margin: "sm", color: t.line},
          ...rows,
          {type: "separator", margin: "md", color: t.line},
          {type: "box", layout: "horizontal", margin: "md", spacing: "md",
            justifyContent: "center", contents: [
              legend(t.paid, "จ่ายแล้ว"),
              legend(t.unpaid, "รอการชำระ", t.unpaidBorder),
            ]},
          {type: "text", text: `อัปเดตล่าสุด ${formatThaiUpdatedDate()}`,
            size: "xxs", color: t.soft, align: "center", margin: "md"},
        ]},
    },
  };
}

/**
 * Formats "now" in Bangkok as a Thai-language date + time,
 * e.g. "5 กรกฎาคม 2026 · 14:40 น.".
 * @return {string}
 */
function formatThaiUpdatedDate() {
  const now = new Date();
  const date = new Intl.DateTimeFormat("th-TH-u-ca-gregory", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);
  const time = new Intl.DateTimeFormat("th-TH-u-ca-gregory", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  return `${date} · ${time} น.`;
}

/**
 * Builds the source data for the payment heatmap.
 * @param {Object} opts
 * @return {Promise<Object>}
 */
async function buildPaymentHeatmapData(opts) {
  const feeType = String(opts.feeType || "common").trim() === "parking" ?
    "parking" : "common";
  const year = Number(opts.year || new Date().getFullYear());
  const period = String(opts.period || (feeType === "common" ? "H2" : ""))
      .trim();
  if (!period) throw new Error("Missing payment period");
  const snap = await db.collection("pattra_payments")
      .where("feeType", "==", feeType)
      .where("period", "==", period)
      .where("year", "==", year)
      .get();
  const paidHouses = [];
  const pendingHouses = [];
  const overageHouses = [];
  snap.docs.forEach((docSnap) => {
    const d = docSnap.data() || {};
    const houseNo = ppHouseNum(d.houseNo);
    if (!houseNo) return;
    if (d.status === "verified") paidHouses.push(houseNo);
    else if (d.status === "pending") pendingHouses.push(houseNo);
    if (Number(d.overage || 0) > 0) overageHouses.push(houseNo);
  });
  return {
    feeType,
    period,
    year,
    paidHouses: [...new Set(paidHouses)].sort((a, b) => a - b),
    pendingHouses: [...new Set(pendingHouses)].sort((a, b) => a - b),
    overageHouses: [...new Set(overageHouses)].sort((a, b) => a - b),
  };
}

/**
 * Persists and optionally sends one overnight security report.
 * @param {string} reportDate
 * @param {boolean} sendLine
 * @param {number} startHour
 * @param {number} startMinute
 * @param {number} endHour
 * @param {number} endMinute
 * @param {string} targetIdOverride registered LINE target for manual tests
 * @return {Promise<Object>}
 */
async function runOvernightSecurityReport(reportDate, sendLine = true,
    startHour = NIGHT_SHIFT_START_HOUR, startMinute = 0,
    endHour = NIGHT_SHIFT_END_HOUR, endMinute = 0,
    targetIdOverride = "") {
  const report = await buildOvernightSecurityReport(
      reportDate, startHour, startMinute, endHour, endMinute);
  report.securityOfficerName = await getSecurityShiftOfficerName("night");
  const reportRef = db.collection(LPR_OVERNIGHT_COLLECTION)
      .doc(report.reportDate);
  let lineSent = false;
  let lineError = "";
  let lineTargetId = "";
  if (sendLine) {
    try {
      const targetId = targetIdOverride ||
        await resolveLineFlexTargetId("night", getDailyTrafficTargetId);
      if (!targetId) throw new Error("Night watch LINE group is not set");
      lineTargetId = targetId;
      await sendLinePushMessages(targetId, [
        buildOvernightSecurityFlexMessage(report),
      ]);
      lineSent = true;
    } catch (error) {
      lineError = String(error.message || error).slice(0, 500);
    }
  }
  await reportRef.set({
    ...report,
    lineSent,
    lineError,
    lineTargetId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
  return {...report, lineSent, lineError, lineTargetId};
}

/**
 * Gets the configured LINE target id.
 * @return {Promise<string|null>}
 */
async function getLineTargetId() {
  const configSnap = await db.doc(LINE_CONFIG_PATH).get();
  if (!configSnap.exists) return null;

  const config = configSnap.data() || {};
  return config.groupId || config.roomId || config.userId || null;
}

/**
 * Normalizes a LINE flex routing choice.
 * @param {string} value
 * @return {string}
 */
function normalizeLineFlexRouteChoice(value) {
  return String(value || "").trim().toLowerCase() === "sandbox" ?
    "sandbox" : "prd";
}

/**
 * Returns the default flex routing map.
 * @return {Object<string, string>}
 */
function getDefaultLineFlexRoutes() {
  return {...LINE_FLEX_ROUTE_DEFAULTS};
}

/**
 * Returns a cleaned LINE target id.
 * @param {*} value
 * @return {string}
 */
function normalizeLineFlexTargetId(value) {
  return String(value || "").trim();
}

/**
 * Merges known route defaults with saved flow settings.
 * @param {Object} data
 * @return {Object<string, {
 *   sandboxTargetId: string,
 *   productionTargetId: string,
 *   activeMode: string,
 * }>}
 */
function normalizeLineFlexFlows(data) {
  const defaults = getDefaultLineFlexFlows();
  const rawFlows = data && data.flows && typeof data.flows === "object" ?
    data.flows : {};
  const rawRoutes = data && data.routes && typeof data.routes === "object" ?
    data.routes : {};

  Object.keys(defaults).forEach((routeKey) => {
    const saved = rawFlows[routeKey] && typeof rawFlows[routeKey] === "object" ?
      rawFlows[routeKey] : {};
    defaults[routeKey] = {
      sandboxTargetId: normalizeLineFlexTargetId(
          saved.sandboxTargetId || defaults[routeKey].sandboxTargetId,
      ),
      productionTargetId: normalizeLineFlexTargetId(
          saved.productionTargetId || defaults[routeKey].productionTargetId,
      ),
      activeMode: normalizeLineFlexRouteChoice(
          saved.activeMode ||
          rawRoutes[routeKey] ||
          defaults[routeKey].activeMode,
      ),
    };
  });

  return defaults;
}

/**
 * Reads the central LINE flex routing document.
 * @return {Promise<FirebaseFirestore.DocumentSnapshot>}
 */
async function getLineFlexRoutingDoc() {
  return db.doc(LINE_FLEX_ROUTING_CONFIG_PATH).get();
}

/**
 * Loads the central LINE flex routing config.
 * @return {Promise<Object>}
 */
async function getLineFlexRoutingConfig() {
  const snap = await getLineFlexRoutingDoc();
  const data = snap.exists ? snap.data() || {} : {};
  const flows = normalizeLineFlexFlows(data);
  const routes = {};
  const routeTargets = {};
  Object.keys(flows).forEach((routeKey) => {
    routes[routeKey] = flows[routeKey].activeMode;
    routeTargets[routeKey] = {
      sandbox: {
        key: "sandbox",
        label: buildTargetLabelFromId(flows[routeKey].sandboxTargetId),
        targetId: flows[routeKey].sandboxTargetId,
      },
      prd: {
        key: "prd",
        label: buildTargetLabelFromId(flows[routeKey].productionTargetId),
        targetId: flows[routeKey].productionTargetId,
      },
    };
  });
  return {
    flows,
    routes,
    routeTargets,
    updatedAt: data.updatedAt || null,
    updatedBy: data.updatedBy || "",
  };
}

/**
 * Resolves a LINE flex target id from the central routing config.
 * @param {string} routeKey
 * @param {Function} [fallbackGetter]
 * @return {Promise<string|null>}
 */
async function resolveLineFlexTargetId(routeKey, fallbackGetter) {
  const snap = await getLineFlexRoutingDoc();
  if (snap.exists) {
    const config = await getLineFlexRoutingConfig();
    const flow = config.flows && config.flows[routeKey] ?
      config.flows[routeKey] : null;
    const env = normalizeLineFlexRouteChoice(flow && flow.activeMode);
    const targetId = env === "sandbox" ?
      normalizeLineFlexTargetId(flow && flow.sandboxTargetId) :
      normalizeLineFlexTargetId(flow && flow.productionTargetId);
    if (targetId) return targetId;
  }
  if (typeof fallbackGetter === "function") {
    return fallbackGetter();
  }
  const defaults = getDefaultLineFlexFlows()[routeKey];
  if (defaults) {
    return defaults.activeMode === "sandbox" ?
      defaults.sandboxTargetId : defaults.productionTargetId;
  }
  return LINE_FLEX_SECURITY_PRODUCTION_TARGET_ID;
}

/**
 * Gets the sandbox LINE target for public report issues.
 * This intentionally avoids the live Security group.
 * @return {Promise<string|null>}
 */
async function getReportIssueTargetId() {
  return resolveLineFlexTargetId("pattraReport", async () =>
    REPORT_ISSUE_TEST_TARGET_ID);
}

/**
 * Gets the dedicated LPR monitor group without following later bot chats.
 * The first run migrates the current group target for backwards compatibility.
 * @return {Promise<string|null>}
 */
async function getLprMonitorTargetId() {
  const monitorRef = db.doc(LPR_MONITOR_CONFIG_PATH);
  const monitorSnap = await monitorRef.get();
  if (monitorSnap.exists) {
    const monitor = monitorSnap.data() || {};
    return monitor.groupId || monitor.targetId || null;
  }

  const configSnap = await db.doc(LINE_CONFIG_PATH).get();
  if (!configSnap.exists) return null;
  const config = configSnap.data() || {};
  if (!config.groupId) return null;

  await monitorRef.set({
    targetId: config.groupId,
    groupId: config.groupId,
    source: "migrated-current-group",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
  return config.groupId;
}

/**
 * Gets the dedicated daily traffic report group.
 * @return {Promise<string|null>}
 */
async function getDailyTrafficTargetId() {
  return resolveLineFlexTargetId("daily", async () => {
    const trafficRef = db.doc(DAILY_TRAFFIC_CONFIG_PATH);
    const trafficSnap = await trafficRef.get();
    if (trafficSnap.exists) {
      const traffic = trafficSnap.data() || {};
      return traffic.groupId || traffic.targetId || null;
    }

    const configSnap = await db.doc(LINE_CONFIG_PATH).get();
    if (!configSnap.exists) return null;
    const config = configSnap.data() || {};
    if (!config.groupId) return null;
    await trafficRef.set({
      targetId: config.groupId,
      groupId: config.groupId,
      source: "migrated-current-group",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
    return config.groupId;
  });
}

/**
 * Gets the dedicated visitor daily report target. No production fallback.
 * @return {Promise<string|null>}
 */
async function getVisitorDailyTargetId() {
  const snap = await db.doc(VISITOR_DAILY_CONFIG_PATH).get();
  if (!snap.exists) return null;
  const config = snap.data() || {};
  return config.groupId || config.targetId || null;
}

/**
 * Gets the guard-audit target group. Prefer explicit config, otherwise fall
 * back to the latest security shift source group.
 * @return {Promise<string|null>}
 */
async function getGuardAuditTargetId() {
  return resolveLineFlexTargetId("guardDay", async () => {
    const guardSnap = await db.doc(GUARD_AUDIT_CONFIG_PATH).get();
    if (guardSnap.exists) {
      const guard = guardSnap.data() || {};
      return guard.groupId || guard.targetId || null;
    }
    const shiftSnap = await db.doc(SECURITY_SHIFT_CONFIG_PATH).get();
    if (!shiftSnap.exists) return null;
    const shift = shiftSnap.data() || {};
    return shift.groupId || shift.targetId || null;
  });
}

/**
 * Extracts a LINE target id from a webhook source.
 * @param {Object} source
 * @return {string|null}
 */
function getTargetIdFromSource(source) {
  return source.groupId || source.roomId || source.userId || null;
}

/**
 * Masks a LINE target id for display in the PR admin page.
 * @param {string} targetId
 * @return {string}
 */
function maskTargetId(targetId) {
  if (!targetId || targetId.length <= 10) return targetId || "";
  return `${targetId.slice(0, 5)}...${targetId.slice(-6)}`;
}

/**
 * Builds a readable LINE target label from a target id.
 * @param {string} targetId
 * @return {string}
 */
function buildTargetLabelFromId(targetId) {
  const cleanTargetId = String(targetId || "").trim();
  const knownTargets = Object.values(LINE_FLEX_TARGETS);
  const known = knownTargets.find((item) => item.targetId === cleanTargetId);
  if (known) return known.label;
  return `LINE Target ${maskTargetId(cleanTargetId)}`;
}

/**
 * Builds a readable LINE target label.
 * @param {Object} source
 * @return {string}
 */
function buildTargetLabel(source) {
  const targetId = getTargetIdFromSource(source);
  const sourceType = source.type || source.sourceType || "unknown";

  if (sourceType === "group") return `LINE Group ${maskTargetId(targetId)}`;
  if (sourceType === "room") return `LINE Room ${maskTargetId(targetId)}`;
  if (sourceType === "user") return `LINE User ${maskTargetId(targetId)}`;
  return `LINE Target ${maskTargetId(targetId)}`;
}

/**
 * Checks whether a LINE label is still generic and should be enriched.
 * @param {string} label
 * @return {boolean}
 */
function isGenericLineTargetLabel(label) {
  return /^LINE (Group|Room|User|Target)\b/.test(String(label || "").trim());
}

/**
 * Fetches the current LINE group summary name.
 * @param {string} groupId
 * @return {Promise<string>}
 */
async function fetchLineGroupSummaryName(groupId) {
  const cleanGroupId = String(groupId || "").trim();
  if (!cleanGroupId) return "";
  const response = await fetch(
      `https://api.line.me/v2/bot/group/${cleanGroupId}/summary`,
      {
        headers: {
          "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN.value()}`,
        },
        signal: AbortSignal.timeout(10000),
      },
  );
  if (!response.ok) {
    throw new Error(`LINE group summary failed (${response.status})`);
  }
  const data = await response.json().catch(() => ({}));
  return String(data.groupName || "").trim();
}

/**
 * Resolves a friendly LINE target label, using LINE API when needed.
 * @param {Object} target
 * @return {Promise<string>}
 */
async function resolveFriendlyLineTargetLabel(target) {
  const baseLabel = String(target && target.label || "").trim();
  const sourceType = String(
      target && (target.sourceType || target.type) || "unknown",
  ).trim().toLowerCase();
  const targetId = String(
      target &&
      (target.targetId || target.groupId || target.roomId || target.userId) ||
      "",
  ).trim();

  if (!targetId) return baseLabel || "LINE target";
  if (baseLabel && !isGenericLineTargetLabel(baseLabel)) return baseLabel;

  if (sourceType === "group") {
    try {
      const groupName = await fetchLineGroupSummaryName(targetId);
      if (groupName) return groupName;
    } catch (err) {
      logger.warn("Failed to enrich LINE group label", {
        groupId: targetId,
        error: err.message,
      });
    }
  }

  return baseLabel || buildTargetLabelFromId(targetId);
}

/**
 * Tries to extract a duty officer name from the Security Pattra 8 report text.
 * Accepts common report formats such as:
 *   1.นายอินตา ทาสุก
 *   1. นาย อินตา ทาสุก
 * @param {string} text
 * @return {string}
 */
function parseSecurityShiftName(text) {
  const value = String(text || "").replace(/\r/g, "\n");
  const match = value.match(/^\s*\d+\.\s*(?:นาย|นาง|นางสาว)?\s*([^\n]+)/m);
  if (!match) return "";
  return match[1]
      .replace(/\s+(?:รายงาน.*|จึงเรียนมาเพื่อทราบ.*)$/u, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
}

/**
 * Checks whether a message time is inside the guard handoff window.
 * @param {number} timestampMs
 * @return {boolean}
 */
function isSecurityShiftReportWindow(timestampMs) {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(Number(timestampMs) || Date.now()))
      .reduce((acc, part) => {
        if (part.type === "hour") acc.hour = Number(part.value);
        if (part.type === "minute") acc.minute = Number(part.value);
        return acc;
      }, {hour: 0, minute: 0});
  const minutes = time.hour * 60 + time.minute;
  const morning = minutes >= (6 * 60 + 30) && minutes <= (7 * 60 + 30);
  const evening = minutes >= (18 * 60 + 30) && minutes <= (19 * 60 + 30);
  return morning || evening;
}

/**
 * Converts a timestamp to the most likely shift label.
 * @param {number} timestampMs
 * @return {string}
 */
function getSecurityShiftFromTimestamp(timestampMs) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(Number(timestampMs) || Date.now()))
      .reduce((acc, part) => {
        if (part.type === "hour") acc.hour = Number(part.value);
        return acc;
      }, {hour: 0});
  return parts.hour >= 19 ? "night" : "day";
}

/**
 * Detects the shift from a Security Pattra 8 handoff note.
 * @param {string} text
 * @return {string}
 */
function parseSecurityShiftKind(text) {
  const value = String(text || "");
  if (/19\.?00|ทุ่ม|กลางคืน/i.test(value)) return "night";
  if (/07\.?00|เช้า|กลางวัน/i.test(value)) return "day";
  return "";
}

/**
 * Stores the latest officer name reported by the security group for a shift.
 * @param {string} shift
 * @param {string} officerName
 * @param {Object} source
 * @return {Promise<void>}
 */
async function upsertSecurityShiftReport(shift, officerName, source) {
  const cleanShift = ["day", "night"].includes(shift) ? shift : "";
  const cleanName = String(officerName || "").trim().slice(0, 80);
  const targetId = getTargetIdFromSource(source);
  if (!cleanShift || !cleanName || !targetId) return;

  await db.doc(SECURITY_SHIFT_CONFIG_PATH).set({
    targetId,
    shift: cleanShift,
    officerName: cleanName,
    sourceType: source.type || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
}

/**
 * Reads the latest officer name for the requested shift.
 * @param {string} shift
 * @return {Promise<string>}
 */
async function getSecurityShiftOfficerName(shift) {
  const snap = await db.doc(SECURITY_SHIFT_CONFIG_PATH).get();
  if (!snap.exists) return "";
  const data = snap.data() || {};
  if (data.shift !== shift) return "";
  return String(data.officerName || "").trim();
}

/**
 * Stores each LINE target separately so PR sends can choose a group.
 * @param {Object} source
 * @param {string} eventType
 * @return {Promise<void>}
 */
async function upsertLineTarget(source, eventType) {
  const targetId = getTargetIdFromSource(source);
  if (!targetId) return;

  const sourceType = source.type || "unknown";
  await db.collection(LINE_TARGETS_COLLECTION).doc(targetId).set({
    targetId,
    sourceType,
    label: buildTargetLabel(source),
    groupId: source.groupId || null,
    roomId: source.roomId || null,
    userId: source.userId || null,
    lastEventType: eventType || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
}

/**
 * Lists known LINE targets. Falls back to the legacy latest target config.
 * @return {Promise<Object[]>}
 */
async function getLineTargets() {
  const snap = await db.collection(LINE_TARGETS_COLLECTION)
      .orderBy("updatedAt", "desc")
      .limit(50)
      .get();
  const targets = snap.docs.map((docSnap) => {
    const data = docSnap.data() || {};
    return {
      targetId: data.targetId || docSnap.id,
      sourceType: data.sourceType || "unknown",
      label: data.label || buildTargetLabel(data),
      updatedAt: data.updatedAt || null,
    };
  });

  if (targets.length) return targets;

  const configSnap = await db.doc(LINE_CONFIG_PATH).get();
  if (!configSnap.exists) return [];

  const config = configSnap.data() || {};
  const targetId = getTargetIdFromSource(config);
  if (!targetId) return [];

  return [{
    targetId,
    sourceType: config.sourceType || "unknown",
    label: buildTargetLabel(config),
    updatedAt: config.updatedAt || null,
  }];
}

/**
 * Returns known LINE targets for config dropdowns, including hard defaults.
 * @return {Promise<Array<Object>>}
 */
async function getLineFlexTargetOptions() {
  const optionMap = new Map();
  Object.values(LINE_FLEX_TARGETS).forEach((target) => {
    optionMap.set(target.targetId, {
      targetId: target.targetId,
      label: target.label,
      sourceType: target.key,
      updatedAt: null,
    });
  });

  const dynamicTargets = await getLineTargets();
  dynamicTargets.forEach((target) => {
    if (!target || !target.targetId) return;
    optionMap.set(target.targetId, {
      targetId: target.targetId,
      label: target.label || buildTargetLabelFromId(target.targetId),
      sourceType: target.sourceType || "unknown",
      updatedAt: target.updatedAt || null,
    });
  });

  const options = Array.from(optionMap.values());
  await Promise.all(options.map(async (target) => {
    const originalLabel = String(target.label || "").trim();
    const friendlyLabel = await resolveFriendlyLineTargetLabel(target);
    target.label = friendlyLabel;
    if (target.targetId && friendlyLabel && friendlyLabel !== originalLabel) {
      await db.collection(LINE_TARGETS_COLLECTION).doc(target.targetId).set({
        targetId: target.targetId,
        label: friendlyLabel,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
    }
  }));
  return options;
}

/**
 * Resolves and validates the selected LINE target.
 * @param {string} targetId
 * @return {Promise<Object>}
 */
async function resolveLineTarget(targetId) {
  const cleanTargetId = String(targetId || "").trim();
  if (!cleanTargetId) {
    throw new Error("Please select a LINE target group");
  }

  const targets = await getLineTargets();
  const target = targets.find((item) => item.targetId === cleanTargetId);
  if (!target) {
    throw new Error("Selected LINE target is not registered");
  }

  return target;
}

// ===========================================================================
// ===== VISITOR INTAKE =====================================================
// Guard LINE bot + committee admin viewer. Frontend (separate project):
//   ../../Pattra Visitors/index.html  ->  https://pattra8.com/visitors/
//
// NOTE: this folder ("Pattra Report") is the shared Firebase root for the
// ENTIRE pattra8 project, not the report-board app. Visitor backend lives
// here because Firebase requires all function sources under one project root
// (a sibling source dir is rejected: "outside of project directory").
//
// Visitor pieces below, in order:
//   - isVisitorIntakeTarget / handleVisitorIntakeEvent  (routed from the
//     shared exports.lineWebhook — LINE allows only one webhook URL)
//   - saveVisitorIntakeImage / analyzeVisitorIntakeImage / parse helpers
//   - visitorIntakeImageUrl / mapVisitorIntakeDoc
//   - exports.visitorIntakeAdmin   (committee auth via
//     verifyAdminResidentAccess)
//   - exports.visitorIntakeCleanup (retention purge cron)
// Config constants are near the top of the file (search VISITOR_INTAKE_).
// ===========================================================================

/**
 * Checks if the LINE source is the configured Visitor Intake target.
 * @param {Object} source
 * @return {Promise<boolean>}
 */
async function isVisitorIntakeTarget(source) {
  const targetId = getTargetIdFromSource(source);
  if (!targetId) return false;
  const configSnap = await db.doc(VISITOR_INTAKE_CONFIG_PATH).get();
  if (!configSnap.exists) return false;
  const config = configSnap.data() || {};
  return targetId === (config.targetId || config.groupId || config.roomId ||
    config.userId || "");
}

/**
 * Adds days to the current wall-clock time.
 * @param {number} days
 * @return {Date}
 */
function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

/**
 * Builds a short stable hash for sensitive ids.
 * @param {string} value
 * @return {string}
 */
function shortHash(value) {
  return crypto.createHash("sha256")
      .update(String(value || ""))
      .digest("hex")
      .slice(0, 24);
}

/**
 * Downloads a LINE message content payload.
 * @param {string} messageId
 * @return {Promise<{buffer: Buffer, contentType: string}>}
 */
async function downloadLineMessageContent(messageId) {
  const response = await fetch(
      `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      {
        headers: {
          "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN.value()}`,
        },
        signal: AbortSignal.timeout(30000),
      },
  );
  const contentType = response.headers.get("content-type") || "image/jpeg";
  const arrayBuffer = await response.arrayBuffer();
  if (!response.ok) {
    const error = new Error(`LINE content failed (${response.status})`);
    error.code = response.status === 410 ?
      "LINE_CONTENT_UNAVAILABLE" : "LINE_CONTENT_FAILED";
    error.status = response.status;
    throw error;
  }
  return {buffer: Buffer.from(arrayBuffer), contentType};
}

/**
 * Identifies media that LINE no longer allows the bot to download.
 * @param {*} error
 * @return {boolean}
 */
function isLineContentUnavailable(error) {
  return Boolean(error && error.code === "LINE_CONTENT_UNAVAILABLE");
}

/**
 * Saves a visitor intake LINE image in private Firebase Storage.
 * @param {Object} event
 * @param {string} logId
 * @return {Promise<Object>}
 */
async function saveVisitorIntakeImage(event, logId) {
  const messageId = event.message && event.message.id || "";
  const {buffer, contentType} = await downloadLineMessageContent(messageId);
  const dateKey = getTodayBangkokDate();
  const safeTarget = shortHash(getTargetIdFromSource(event.source || {}));
  const storagePath = `visitor-intake/${dateKey}/${safeTarget}/` +
    `${logId}/${messageId}.jpg`;
  const downloadToken = crypto.randomUUID();
  const file = admin.storage().bucket().file(storagePath);
  await file.save(buffer, {
    resumable: false,
    metadata: {
      contentType,
      metadata: {
        firebaseStorageDownloadTokens: downloadToken,
        retentionDays: String(VISITOR_INTAKE_IMAGE_RETENTION_DAYS),
        expiresAt: daysFromNow(VISITOR_INTAKE_IMAGE_RETENTION_DAYS)
            .toISOString(),
      },
    },
  });
  return {
    messageId,
    storagePath,
    downloadToken,
    contentType,
    sizeBytes: buffer.length,
    expiresAt: admin.firestore.Timestamp.fromDate(
        daysFromNow(VISITOR_INTAKE_IMAGE_RETENTION_DAYS),
    ),
    createdAt: admin.firestore.Timestamp.fromDate(new Date()),
  };
}

/**
 * Normalizes a Thai Pattra house number.
 * @param {string} raw
 * @return {string}
 */
function normalizePattraHouseNo(raw) {
  const clean = String(raw || "").trim();
  const prefixed = clean.match(/38\s*\/\s*(\d{1,2})/);
  const compact = clean.match(/^38([1-9]\d?)$/);
  const number = prefixed ? Number(prefixed[1]) :
    compact ? Number(compact[1]) : Number(clean);
  if (!Number.isInteger(number) || number < 1 || number > 69) return "";
  return `38/${number}`;
}

/**
 * Extracts every valid Pattra house number mentioned in free-form text.
 * Intended for guard messages such as "38/1 - 38/7" which means two houses,
 * not a numeric range.
 * @param {string} raw
 * @return {string[]}
 */
function extractPattraHouseNos(raw) {
  const value = String(raw || "").normalize("NFKC");
  const found = [];
  const seen = new Set();
  const addHouse = (rawHouse) => {
    const houseNo = normalizePattraHouseNo(rawHouse);
    if (houseNo && !seen.has(houseNo)) {
      seen.add(houseNo);
      found.push(houseNo);
    }
  };
  const patterns = [
    /38\s*\/\s*(\d{1,2})(?!\d)/g,
    /\b38([1-9]\d?)(?!\d)\b/g,
    /\b38\s+([1-9]\d?)(?!\d)\b/g,
    /(?:^|\s)(?:บ้าน|เลขที่|หลายบ้าน\s*บ้าน)\s*(\d{1,2})(?!\d)/gi,
  ];
  patterns.forEach((pattern) => {
    let match = null;
    while ((match = pattern.exec(value))) {
      addHouse(match[1] || match[0]);
    }
  });
  const slashList = value.match(
      /38\s*\/\s*\d{1,2}(?:\s*(?:,|และ|กับ)\s*\d{1,2})+/g,
  ) || [];
  slashList.forEach((list) => {
    const numbers = list.match(/\d{1,2}/g) || [];
    const suffixes = numbers[0] === "38" ? numbers.slice(1) : numbers;
    suffixes.slice(0, 8).forEach(addHouse);
  });
  const multiHouseIndex = value.search(/หลายบ้าน/i);
  if (multiHouseIndex >= 0) {
    const numbers = value.slice(multiHouseIndex).match(/\d{1,2}/g) || [];
    numbers.slice(0, 8).forEach(addHouse);
  }
  const labeledMany = value.match(new RegExp(
      "(?:หลายบ้าน\\s*บ้าน|บ้าน|เลขที่)\\s*" +
      "\\d{1,2}(?:\\s*(?:และ|กับ|,|-|–|—)\\s*\\d{1,2})+",
  ));
  if (labeledMany) {
    if (!labeledMany[0].includes("/")) {
      const numbers = labeledMany[0].match(/\d{1,2}/g) || [];
      numbers.slice(0, 8).forEach(addHouse);
    }
  }
  return found;
}

/**
 * Removes explicit house-number mentions from free-form text while keeping the
 * rest of the purpose readable.
 * @param {string} raw
 * @return {string}
 */
function stripPattraHouseNos(raw) {
  return String(raw || "")
      .replace(/38\s*\/\s*\d{1,2}(?!\d)/g, " ")
      .replace(/\b38[1-9]\d?(?!\d)\b/g, " ")
      .replace(/\b38\s+[1-9]\d?(?!\d)\b/g, " ")
      .replace(/(^|\s)(?:บ้าน|เลขที่|หลายบ้าน\s*บ้าน)\s*\d{1,2}(?!\d)/gi,
          "$1")
      .replace(/\s*(?:และ|กับ|,)\s*\d{1,2}(?!\d)/g, " ")
      .replace(/\s*[-–—,]\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
}

// Purpose keyword patterns. Order matters: "grab car / มารับ" (pickup) is
// checked before the generic "grab" (food) rule below.
// pickup = รับ-ส่งคน (Grab car / taxi). "มารับ" is treated as a person
// pickup EXCEPT when it is immediately picking up a parcel/goods
// ("มารับพัสดุ", "มารับของ") — those are delivery, handled by the
// negative lookahead + the extra parcel-pickup tokens in DELIVERY below.
const VISITOR_LAUNDRY_RE =
  /ซัก\s*รีด|ซัก\s*แห้ง|(?:รับ|ส่ง|เอา)\s*ผ้า|\blaundry\b/;
const VISITOR_PICKUP_RE = new RegExp([
  "grab\\s*car", "grabcar", "bolt", "แท็กซี่", "taxi", "รับ-?ส่ง", "รับคน",
  "รับลูกบ้าน", "ส่งลูกบ้าน", "ไปส่งลูกบ้าน", "มาส่งลูกบ้าน",
  "ส่งรับบ้าน", "รถลูกบ้าน", "รับรถลูกบ้าน",
  "มารับ(?!\\s*(?:พัสดุ|ของ|เอกสาร|สินค้า|กล่อง|parcel))",
].join("|"));
const VISITOR_FOOD_RE =
  new RegExp([
    "grab", "food", "panda", "lineman", "line\\s*man", "robinhood",
    "rider", "ไรเดอร์", "อาหาร", "ส่งอาหาร", "ส่งขน", "น้ำแข็ง",
    "น้ําแข็ง",
  ].join("|"));
const VISITOR_DELIVERY_RE = new RegExp([
  "shopee", "lazada", "ขนส่ง", "ส่งของ", "ส่งพัสดุ", "พัสดุ", "parcel",
  "รับพัสดุ", "รับของ", "รับเอกสาร", "รับสินค้า",
  "ส่งเอกสาร", "เอาเอกสาร", "มาเอาเอกสาร",
  "delivery", "flash", "kerry", "j&t", "ไปรษณีย์", "dhl", "ninja", "best",
].join("|"));
const VISITOR_UTILITY_RE = new RegExp([
  "การไฟฟ้า", "การประปา", "เจ้าหน้าที่ไฟฟ้า", "เจ้าหน้าที่ประปา",
  "3bb", "ทีโอที", "อินเตอร์เน็ต", "internet", "wifi", "ไวไฟ",
  "fiber", "ไฟเบอร์", "รถขยะ", "ขยะ",
].join("|"));
const VISITOR_CONTRACTOR_RE = new RegExp([
  "ช่าง", "ผู้รับเหมา", "รับเหมา", "ซ่อม", "ซ่อมไฟ", "ซ่อมน้ำ",
  "ไฟฟ้า", "ประปา", "ทาสี", "แอร์", "ติดตั้ง", "ก่อสร้าง",
  "ฉีดปลวก", "ปลวก", "ทำความสะอาด", "แม่บ้าน",
].join("|"));
const VISITOR_OFFICE_RE = /นิติ|นิติบุคคล|สำนักงานนิติ|ออฟฟิศ|office/;
const VISITOR_COMMON_AREA_RE = new RegExp([
  "ติดต่อนิติ", "นิติบุคคล", "สำนักงานนิติ", "หน้าโครงการ",
  "ติดต่อหน้าโครงการ", "สโมสร", "ติดต่อสโมสร",
].join("|"));
const VISITOR_COMMON_AREA_OPERATION_RE = new RegExp([
  "รถขยะ", "ขยะ", "ผู้รับเหมา", "รับเหมา", "ส่วนกลาง", "งานส่วนกลาง",
  "ซ่อมส่วนกลาง", "ช่าง.*ส่วนกลาง", "ล้างสระ", "ดูแลสวน", "ตัดหญ้า",
  "สโมสร", "หน้าโครงการ",
].join("|"));
const VISITOR_COMMON_AREA_WORK_RE = new RegExp([
  "รถขยะ", "ขยะ", "ปรับปรุง", "ก่อสร้าง", "ส่ง\\s*(?:ปูน|วัสดุ)",
  "ปูนซีเมนต์", "ซ่อม(?:ระบบ)?", "ตัดหญ้า", "ดูแลสวน", "ล้างสระ",
  "ไม้กั้น",
].join("|"));
const VISITOR_CONTACT_RE =
  /มาติดต่อ|ติดต่อบ้าน|ติดต่อ(?!.*นิติ)|พบลูกบ้าน|เข้าพบ|มาพบ/;
const VISITOR_GUEST_RE = /ญาติ|ญาต|เยี่ยม|แขก|เพื่อน|มาหา|guest/;
const VISITOR_CHAT_ACK_RE = new RegExp("^(" + [
  "รับทราบ", "รับทราบครับ", "รับทราบค่ะ", "ครับ", "ค่ะ", "โอเค",
  "ok", "okay", "ได้ครับ", "ได้ค่ะ", "ขอบคุณ", "ขอบคุณครับ",
  "ขอบคุณค่ะ",
].join("|") + ")[\\s.!ๆ]*$", "i");
const VISITOR_CHAT_HINT_RE = new RegExp([
  "ต่อไป", "visitor", "line\\s*กลุ่ม", "กลุ่มนี้", "ตัวอย่าง",
  "ผมทำระบบ", "ระบบอ่าน", "พิมพ์\\s*ๆ", "อ่านชื่อ", "อ่านทะเบียน",
  "บัตรประชาชน", "ใบขับขี่", "ขอภาพชัด", "อ่านไม่ออก", "ไม่มั่น",
  "มาหาใคร", "บ้านอะไร", "ติดต่อเรื่องอะไร",
].join("|"), "i");
const VISITOR_HOUSE_WITH_EXTRA_DIGITS_RE = /38\s*\/\s*\d{3,}/;

// Human-readable Thai label per category (shown in the LINE reply).
const VISITOR_CATEGORY_LABELS = {
  laundry: "ซักรีด/รับ–ส่งผ้า",
  food_delivery: "ส่งอาหาร (Food Delivery)",
  delivery: "ส่งพัสดุ/ขนส่ง (Delivery)",
  pickup: "รับ-ส่ง (Grab/แท็กซี่)",
  contractor: "ช่าง/ซ่อมบำรุง (Contractor)",
  utility: "หน่วยงานสาธารณูปโภค",
  office: "ติดต่อนิติ/ส่วนกลาง",
  contact: "มาติดต่อ",
  guest: "แขก/ผู้มาติดต่อ",
};

/**
 * Maps a free-form purpose into a compact category.
 * @param {string} text
 * @return {string}
 */
function mapVisitorPurposeCategory(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return "unknown";
  if (VISITOR_LAUNDRY_RE.test(value) &&
      !/ช่าง|ซ่อม|ติดตั้ง/.test(value)) return "laundry";
  if (VISITOR_PICKUP_RE.test(value)) return "pickup";
  if (VISITOR_FOOD_RE.test(value)) return "food_delivery";
  if (VISITOR_DELIVERY_RE.test(value)) return "delivery";
  if (VISITOR_UTILITY_RE.test(value)) return "utility";
  if (VISITOR_CONTRACTOR_RE.test(value)) return "contractor";
  if (VISITOR_OFFICE_RE.test(value)) return "office";
  if (VISITOR_CONTACT_RE.test(value)) return "contact";
  if (VISITOR_GUEST_RE.test(value)) return "guest";
  return "other";
}

/**
 * Returns a clean Thai purpose label for the reply, falling back to the
 * guard's raw text when the category is generic/unknown.
 * @param {string} category
 * @param {string} rawText
 * @return {string}
 */
function visitorPurposeLabel(category, rawText) {
  if (category === "contractor") {
    const detail = visitorContractorDetail(rawText);
    return detail ? `ช่าง/ซ่อมบำรุง (${detail})` : "ช่าง/ซ่อมบำรุง";
  }
  if (category === "office") {
    const value = String(rawText || "").trim();
    return /^(?:ติดต่อนิติ(?:\/ส่วนกลาง)?|งาน(?:ปรับปรุง)?ส่วนกลาง)/
        .test(value) ?
      value : "ติดต่อนิติ/ส่วนกลาง";
  }
  return VISITOR_CATEGORY_LABELS[category] || (rawText || "ไม่ระบุ");
}

/**
 * Returns the purpose label used in aggregate LINE reports. Office/common-area
 * details are intentionally hidden because they are operational notes rather
 * than useful report categories.
 * @param {string} category
 * @param {string} rawText
 * @return {string}
 */
function visitorReportPurposeLabel(category, rawText) {
  if (category === "office") return "ติดต่อนิติ/ส่วนกลาง";
  return visitorPurposeLabel(category, rawText);
}

/**
 * Returns a compact purpose label for narrow LINE chat bubbles.
 * @param {string} category
 * @param {string} rawText
 * @return {string}
 */
function visitorReplyPurposeLabel(category, rawText) {
  if (category === "food_delivery") return "ส่งอาหาร";
  if (category === "delivery") return "ส่งพัสดุ/ขนส่ง";
  if (category === "contractor") {
    const detail = visitorContractorDetail(rawText);
    return detail ? `ช่าง/ซ่อมบำรุง (${detail})` : "ช่าง/ซ่อมบำรุง";
  }
  return visitorPurposeLabel(category, rawText);
}

/**
 * Pulls the free-form detail from common-area / juristic office contacts.
 * @param {string} rawText
 * @return {string}
 */
function visitorCommonAreaDetail(rawText) {
  const value = cleanVisitorPurposeText(rawText)
      .replace(/38\s*\/\s*69/g, " ")
      .replace(VISITOR_COMMON_AREA_RE, " ")
      .replace(/ส่วน\s*กลาง/g, " ")
      .replace(/มาติดต่อ|ติดต่อ/g, " ")
      .replace(/[()（）]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
  if (/ปรับปรุง\s*สโมสร|สโมสร.*ปรับปรุง/.test(value)) {
    return "ปรับปรุงสโมสร";
  }
  if (/ส่ง\s*(?:ปูน\s*ซีเมนต์|ปูน)|ปูน\s*ซีเมนต์/.test(value)) {
    return "ส่งปูนซีเมนต์";
  }
  if (/ส่ง\s*วัสดุ|วัสดุ/.test(value)) {
    return "ส่งวัสดุ";
  }
  if (/ไม้\s*กั้น|ระบบ\s*ไม้\s*กั้น/.test(value)) {
    return "ซ่อมระบบไม้กั้น";
  }
  return value;
}

/**
 * Chooses whether a 38/69 entry is a meeting with juristic office or work
 * being performed in the common area.
 * @param {string} rawText
 * @param {string} detail
 * @return {string}
 */
function visitorCommonAreaPurposeLabel(rawText, detail) {
  const source = `${rawText || ""} ${detail || ""}`;
  if (!VISITOR_COMMON_AREA_WORK_RE.test(source)) {
    return detail ? `ติดต่อนิติ (${detail})` : "ติดต่อนิติ";
  }
  if (/ปรับปรุง|ก่อสร้าง/.test(source)) {
    return detail ? `งานปรับปรุงส่วนกลาง (${detail})` : "งานปรับปรุงส่วนกลาง";
  }
  return detail ? `งานส่วนกลาง (${detail})` : "งานส่วนกลาง";
}

/**
 * Pulls a concise contractor subtype from the guard's message.
 * @param {string} rawText
 * @return {string}
 */
function visitorContractorDetail(rawText) {
  const value = cleanVisitorPurposeText(rawText)
      .replace(/38\s*\/\s*\d{1,2}/g, "")
      .replace(/\s+/g, " ")
      .trim();
  if (!value) return "";
  if (/ติดตั้ง\s*แอร์|ลง\s*แอร์/.test(value)) return "ติดตั้งแอร์";
  if (/ย้าย\s*แอร์|รื้อ\s*แอร์/.test(value)) return "ย้ายแอร์";
  if (/ซ่อม\s*แอร์|เช็ค\s*แอร์|ตรวจ\s*แอร์/.test(value)) return "ซ่อมแอร์";
  if (/ล้าง\s*แอร์/.test(value)) return "ล้างแอร์";
  if (/แอร์/.test(value)) return "ช่างแอร์";
  if (/ช่าง\s*ไฟ|ไฟฟ้า|ซ่อมไฟ/.test(value)) return "ช่างไฟ";
  if (/ช่าง\s*ประปา|ประปา|ซ่อมน้ำ/.test(value)) return "ช่างประปา";
  if (/สวน|ตัดหญ้า|ต้นไม้/.test(value)) return "ช่างสวน";
  if (/fiber|ไฟเบอร์|กล้อง|cctv/i.test(value)) {
    return "fiber/กล้องวงจรปิด";
  }
  if (/ผู้รับเหมา|รับเหมา|ก่อสร้าง/.test(value)) return "ผู้รับเหมา/ก่อสร้าง";
  if (/ทุบ|รื้อ/.test(value)) return "ช่างทุบ";
  return value.replace(/^ช่าง\s*มา/g, "").replace(/^มา/g, "").trim()
      .slice(0, 40);
}

/**
 * Formats the house line for LINE replies.
 * @param {string} houseNo
 * @return {string}
 */
function visitorReplyHouseNo(houseNo) {
  const value = String(houseNo || "").trim();
  return value === "38/69" ? "38/69 (ส่วนกลาง)" : value;
}

/**
 * Formats one or more houses for LINE replies.
 * @param {string} houseNo
 * @param {string[]} houseNos
 * @return {string}
 */
function visitorReplyHouseList(houseNo, houseNos = []) {
  const values = Array.isArray(houseNos) ? houseNos.filter(Boolean) : [];
  const ordered = values.length ? values : [houseNo].filter(Boolean);
  return ordered.map(visitorReplyHouseNo).join(", ");
}

/**
 * Applies a village-office worldview for messages that clearly refer to
 * common-area operations even when the guard did not type a house number.
 * @param {string} houseNo
 * @param {string} purposeText
 * @param {string} rawText
 * @return {boolean}
 */
function shouldInferCommonArea(houseNo, purposeText, rawText) {
  if (houseNo) return false;
  const value = `${purposeText || ""} ${rawText || ""}`.trim();
  if (!value) return false;
  if (VISITOR_COMMON_AREA_RE.test(value)) return true;
  return VISITOR_COMMON_AREA_OPERATION_RE.test(value);
}

/**
 * Extracts a short house suffix from guard speech when the house appears as a
 * loose trailing number, e.g. "มีรถมาส่งอาหารครับ 15 ครับ".
 * @param {string} raw
 * @return {string}
 */
function extractVisitorTrailingHouseNo(raw) {
  const value = String(raw || "").normalize("NFKC");
  if (![
    VISITOR_FOOD_RE,
    VISITOR_DELIVERY_RE,
    VISITOR_PICKUP_RE,
    VISITOR_CONTRACTOR_RE,
    VISITOR_GUEST_RE,
  ].some((re) => re.test(value))) {
    return "";
  }
  const match = value.match(
      /(?:^|\s)([1-9]\d?)(?=\s*(?:ครับ|ค่ะ|คะ|ผม)?\s*$)/,
  );
  return match ? normalizePattraHouseNo(match[1]) : "";
}

/**
 * Detects guard-entered operational exceptions that should be saved without
 * repeatedly asking for the missing image.
 * @param {string} raw
 * @return {string}
 */
function extractVisitorIntakeException(raw) {
  const value = String(raw || "").normalize("NFKC").toLowerCase();
  const noDocumentRe = new RegExp([
    "ไม่มี\\s*(?:บัตร|ใบขับขี่)",
    "ไม่(?:ได้)?\\s*(?:ถ่าย|ส่ง)\\s*(?:บัตร|ใบขับขี่)",
  ].join("|"));
  const noVehicleRe = new RegExp([
    "ไม่มี\\s*(?:ทะเบียน|รูปรถ|ป้ายทะเบียน)",
    "ไม่(?:ได้)?\\s*(?:ถ่าย|ส่ง)\\s*(?:ทะเบียน|รูปรถ|ป้ายทะเบียน)",
  ].join("|"));
  if (/ไม่มี\s*สแกน\s*เข้า|ไม่\s*สแกน\s*เข้า|เป็น\s*ลูกบ้าน/.test(
      value,
  )) {
    return "resident_no_scan";
  }
  const noDoc = noDocumentRe.test(value);
  const noVehicle = noVehicleRe.test(value);
  if (noDoc && noVehicle) return "missing_document_and_vehicle";
  if (noDoc) return "missing_document";
  if (noVehicle) return "missing_vehicle";
  return "";
}

/**
 * Normalizes guard text before parsing without losing the original raw text.
 * @param {string} raw
 * @return {string}
 */
function normalizeVisitorInputText(raw) {
  return String(raw || "")
      .normalize("NFKC")
      .replace(/บ้าน\s+เลข\s+ที่/gi, "บ้านเลขที่")
      .replace(/เลข\s+ที่/gi, "เลขที่")
      .replace(/((?:บ้าน|เลขที่)\s*)(\d)\s+(\d)(?!\d)/gi, "$1$2$3")
      .replace(/\b38\s+([1-9]\d?)(?!\d)/g, "38/$1")
      .replace(/\b38([1-9]\d?)(?!\d)\b/g, "38/$1")
      .replace(/([^\s])(?=38\s*\/\s*\d{1,2})/g, "$1 ")
      .replace(/([A-Za-z0-9])(?=(?:บ้าน|เลขที่)\s*\d{1,2})/gi, "$1 ")
      .replace(/(38\s*\/\s*\d{1,2})(?=[^\s\d])/g, "$1 ")
      .replace(/((?:บ้าน|เลขที่)\s*\d{1,2})(?=[^\s\d])/gi, "$1 ")
      .replace(/\s+/g, " ")
      .trim();
}

/**
 * Parses flexible guard-entered visitor text.
 * @param {string} text
 * @return {Object}
 */
function parseVisitorIntakeText(text) {
  const rawText = String(text || "").trim();
  const normalizedText = normalizeVisitorInputText(rawText);
  const explicitHouseNos = extractPattraHouseNos(normalizedText);
  const warnings = [];
  if (VISITOR_HOUSE_WITH_EXTRA_DIGITS_RE.test(rawText)) {
    warnings.push("house_format_ambiguous");
  }
  if (normalizedText !== rawText) warnings.push("text_spacing_normalized");
  const vehiclePlate = extractVisitorPlateFromText(normalizedText);
  const intakeException = extractVisitorIntakeException(normalizedText);
  const isCommonAreaContact = VISITOR_COMMON_AREA_RE.test(normalizedText);
  const tokens = normalizedText
      .split(/[\n,，]+/)
      .map((line) => line.trim())
      .filter(Boolean);
  let houseNo = isCommonAreaContact ? "38/69" : "";
  let houseNos = isCommonAreaContact ? ["38/69"] : [];
  const purposeParts = [];

  for (const token of tokens) {
    const tokenHouseNos = extractPattraHouseNos(token);
    const labeledShort = token.match(/(?:บ้าน|เลขที่)\s*(\d{1,2})(?!\d)/i);
    const standalone = token.match(/^\d{1,2}$/);
    const suffixWithPurpose = token.match(/^(\d{1,2})\s*(.+)$/);
    if (houseNos.length > 1 && suffixWithPurpose &&
        houseNos.includes(normalizePattraHouseNo(suffixWithPurpose[1]))) {
      const leftover = stripPattraHouseNos(suffixWithPurpose[2]).trim();
      if (leftover) purposeParts.push(leftover);
      continue;
    }
    if (!houseNo && (tokenHouseNos.length || labeledShort || standalone)) {
      houseNo = tokenHouseNos[0] || normalizePattraHouseNo(
          labeledShort ? labeledShort[1] : token,
      );
      houseNos = tokenHouseNos.length ?
        tokenHouseNos : [houseNo].filter(Boolean);
      const leftover = stripPattraHouseNos(token)
          .replace(/^\d{1,2}$/, "")
          .trim();
      if (leftover) purposeParts.push(leftover);
      continue;
    }
    purposeParts.push(token);
  }

  if (!houseNo && explicitHouseNos.length) {
    houseNo = explicitHouseNos[0];
    houseNos = explicitHouseNos;
  } else if (explicitHouseNos.length > houseNos.length) {
    houseNo = explicitHouseNos[0];
    houseNos = explicitHouseNos;
  }
  if (!houseNo) {
    const trailingHouseNo = extractVisitorTrailingHouseNo(normalizedText);
    if (trailingHouseNo) {
      houseNo = trailingHouseNo;
      houseNos = [trailingHouseNo];
    }
  }

  let purposeText = cleanVisitorPurposeText(
      removeVisitorPlateText(purposeParts.join(" "), vehiclePlate),
  );
  const parsedHouseNos = houseNos.length ? houseNos : explicitHouseNos;
  parsedHouseNos.forEach((parsedHouseNo) => {
    const suffix = String(parsedHouseNo || "").replace(/^38\//, "");
    if (suffix) {
      purposeText = purposeText.replace(
          new RegExp(`^${suffix}\\s*(?=\\D|$)`),
          "",
      ).trim();
    }
  });
  if (!purposeText && intakeException === "resident_no_scan") {
    purposeText = "ลูกบ้าน/ไม่มีสแกนเข้า";
  }
  const inferCommonArea = shouldInferCommonArea(
      houseNo,
      purposeText,
      normalizedText,
  );
  if (!houseNo && inferCommonArea) {
    houseNo = "38/69";
    houseNos = ["38/69"];
    warnings.push("common_area_inferred");
  }
  if (isCommonAreaContact) {
    const commonAreaDetail = visitorCommonAreaDetail(purposeText || rawText);
    purposeText = visitorCommonAreaPurposeLabel(
        purposeText || rawText,
        commonAreaDetail,
    );
  }
  if (/ส่งรับบ้าน|รับรถลูกบ้าน|รถลูกบ้าน/.test(purposeText)) {
    warnings.push("pickup_text_interpreted");
  }
  const purposeCategory = isCommonAreaContact ?
    "office" : mapVisitorPurposeCategory(purposeText);
  const ignoredReason = getVisitorChatTextReason({
    rawText,
    houseNo,
    houseNos: houseNos.length ? houseNos : [houseNo].filter(Boolean),
    purposeText,
    purposeCategory,
    vehiclePlate,
    intakeException,
  });
  return {
    rawText,
    houseNo,
    houseNos: houseNos.length ? houseNos : [houseNo].filter(Boolean),
    purposeText,
    purposeCategory,
    vehiclePlate,
    intakeException,
    ignored: Boolean(ignoredReason),
    ignoredReason,
    warnings: Array.from(new Set(warnings)),
    textConfidence: houseNo && purposeText ? 0.92 : 0.45,
  };
}

/**
 * Extracts a manually typed Thai vehicle plate from a guard message.
 * @param {string} raw
 * @return {string}
 */
function extractVisitorPlateFromText(raw) {
  const value = String(raw || "").normalize("NFKC")
      .replace(/38\s*\/\s*\d{1,2}/g, " ")
      .replace(/\b38[1-9]\d?(?!\d)\b/g, " ")
      .replace(/\b38\b/g, " ")
      .replace(/(?:บ้าน|เลขที่)\s*\d{1,2}(?!\d)/gi, " ")
      .replace(/(?:เลข)?ทะเบียน|ป้ายทะเบียน|ทะเบียนรถ/gi, " ")
      .replace(/\s*(ครับ|ค่ะ|คะ|นะครับ|นะค่ะ|นะคะ)\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const match = value.match(/([0-9]?\s*[ก-ฮ]{1,3}\s*[0-9]{1,4})/);
  if (!match) return "";
  const base = match[1].replace(/\s+/g, "");
  const tail = value.slice(match.index + match[0].length);
  const province = THAI_PROVINCES.find((candidate) =>
    tail.includes(candidate));
  return normalizeVisitorPlate([base, province].filter(Boolean).join(" "));
}

/**
 * Removes a known plate from free-form purpose text.
 * @param {string} raw
 * @param {string} plate
 * @return {string}
 */
function removeVisitorPlateText(raw, plate) {
  let value = String(raw || "");
  if (!plate) return value;
  plate.split(/\s+/).filter(Boolean).forEach((part) => {
    value = value.replace(new RegExp(part, "g"), " ");
  });
  return value
      .replace(/(?:เลข)?ทะเบียน|ป้ายทะเบียน|ทะเบียนรถ/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
}

/**
 * Removes house labels and polite particles from parsed purpose text.
 * @param {string} raw
 * @return {string}
 */
function cleanVisitorPurposeText(raw) {
  return String(raw || "")
      .replace(/ลูก\s+บ้าน/gi, "ลูกบ้าน")
      .replace(/มาติดต่อ\s*ลูกบ้าน/gi, "มาติดต่อ")
      .replace(/ส่ง\s*ลูกบ้านเลขที่/gi, "ส่งลูกบ้าน")
      .replace(/มาส่ง\s*ลูกบ้านเลขที่/gi, "มาส่งลูกบ้าน")
      .replace(/ไปส่ง\s*ลูกบ้านเลขที่/gi, "ไปส่งลูกบ้าน")
      .replace(/รับ\s*ลูกบ้านเลขที่/gi, "รับลูกบ้าน")
      .replace(/มารับ\s*ลูกบ้านเลขที่/gi, "มารับลูกบ้าน")
      .replace(/ส่งรับบ้าน/gi, "ส่งรับบ้าน")
      .replace(/(?:ลูก)?บ้านเลขที่/gi, "")
      .replace(/^ลูกบ้าน\s*$/u, "")
      .replace(/^บ้าน\s*$/u, "")
      .replace(/เลขที่/gi, "")
      .replace(/\b(house|home)\s*(no\.?|number)?\b/gi, "")
      .replace(/\s*(ครับ|ค่ะ|คะ|นะครับ|นะค่ะ|นะคะ)\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
}

/**
 * Detects non-intake chat in the guard group before it pollutes logs.
 * @param {Object} parsed
 * @return {string}
 */
function getVisitorChatTextReason(parsed) {
  const rawText = String(parsed.rawText || "").trim();
  if (!rawText) return "empty";
  if (VISITOR_CHAT_ACK_RE.test(rawText)) return "acknowledgement";
  if (VISITOR_CHAT_HINT_RE.test(rawText)) return "instruction_chat";
  if (parsed.vehiclePlate) return "";
  if (parsed.houseNo && parsed.intakeException) return "";
  if (!parsed.houseNo && (!parsed.purposeText ||
      ["unknown", "other"].includes(parsed.purposeCategory))) {
    return "no_house_or_visitor_purpose";
  }
  return "";
}

/**
 * Calls Gemini to classify and OCR one visitor intake image.
 * @param {string} imagePath Firebase Storage object path
 * @return {Promise<Object>}
 */
async function analyzeVisitorIntakeImage(imagePath) {
  const authClient = await vertexAuth.getClient();
  const access = await authClient.getAccessToken();
  if (!access.token) throw new Error("Vertex access token unavailable");

  const projectId = process.env.GCLOUD_PROJECT || "pattra8-54c3f";
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/` +
    `${projectId}/locations/${VERTEX_VISION_LOCATION}/publishers/google/` +
    `models/${VERTEX_VISION_MODEL}:generateContent`;
  const fileUri = `gs://${admin.storage().bucket().name}/${imagePath}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${access.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          {text: "Analyze this visitor registration image from a Thai " +
            "security gate. Classify it as document, vehicle, " +
            "document_vehicle, or other. Use document_vehicle when one " +
            "image visibly contains both an identity document and a vehicle " +
            "license plate. " +
            "For Thai ID card or driver license, extract the person's Thai " +
            "name if visible, the English/Latin name if visible, document " +
            "type, and the person's number as digits only in " +
            "documentNumber. A Thai driver license prints BOTH a 13-digit " +
            "national ID (เลขประจำตัวประชาชน) and a shorter license number " +
            "(เลขที่ใบอนุญาต) — always put the 13-digit national ID in " +
            "documentNumber, and only fall back to the license number when " +
            "no 13-digit national ID is visible. Prefer Thai names over " +
            "English names for the " +
            "main personName field. For vehicle images, extract the " +
            "visible Thai license plate with province if visible. Read the " +
            "plate character by character directly from the image, then " +
            "verify every Thai letter a second time before returning it. " +
            "Pay special attention to similar-looking Thai letters such as " +
            "ร/ธ, ก/ภ, ข/ช, and พ/ฟ. Do not infer a letter from a common " +
            "plate pattern; leave vehiclePlate empty when any plate letter " +
            "cannot be read confidently. Classify " +
            "vehicle type as car, motorcycle, truck, or garbage_truck. Use " +
            "visible " +
            "evidence only. If uncertain, lower confidence and leave fields " +
            "empty."},
          {fileData: {mimeType: "image/jpeg", fileUri}},
        ],
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 900,
        thinkingConfig: {thinkingLevel: "MINIMAL"},
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            imageKind: {type: "STRING"},
            documentType: {type: "STRING"},
            personName: {type: "STRING"},
            thaiPersonName: {type: "STRING"},
            englishPersonName: {type: "STRING"},
            documentNumber: {type: "STRING"},
            maskedDocumentNo: {type: "STRING"},
            vehiclePlate: {type: "STRING"},
            vehicleType: {type: "STRING"},
            confidence: {type: "NUMBER"},
          },
          required: [
            "imageKind",
            "documentType",
            "personName",
            "thaiPersonName",
            "englishPersonName",
            "documentNumber",
            "maskedDocumentNo",
            "vehiclePlate",
            "vehicleType",
            "confidence",
          ],
        },
      },
    }),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(String(result.error && result.error.message ||
      `Vertex request failed (${response.status})`).slice(0, 500));
    error.status = response.status;
    throw error;
  }
  const parts = result.candidates && result.candidates[0] &&
    result.candidates[0].content && result.candidates[0].content.parts || [];
  const textPart = parts.find((part) => part.text);
  if (!textPart) throw new Error("Vertex returned no visitor result");
  const parsed = JSON.parse(textPart.text);
  const thaiPersonName = String(parsed.thaiPersonName || "")
      .trim().slice(0, 120);
  const englishPersonName = String(parsed.englishPersonName || "")
      .trim().slice(0, 120);
  const personName = String(
      thaiPersonName || parsed.personName || englishPersonName || "",
  ).trim().slice(0, 120);
  const documentNumber = normalizeDocumentNumber(parsed.documentNumber);
  return {
    imageKind: ["document", "vehicle", "document_vehicle", "other"]
        .includes(parsed.imageKind) ?
      parsed.imageKind : "other",
    documentType: String(parsed.documentType || "unknown").trim()
        .slice(0, 40),
    personName,
    thaiPersonName,
    englishPersonName,
    documentNumber,
    maskedDocumentNo: maskDocumentNumber(
        parsed.maskedDocumentNo || documentNumber,
    ),
    vehiclePlate: normalizeVisitorPlate(parsed.vehiclePlate),
    vehicleType: normalizeVisitorVehicleType(parsed.vehicleType),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    modelId: VERTEX_VISION_MODEL,
  };
}

/**
 * Replies to one LINE event.
 * @param {string} replyToken
 * @param {string} text
 * @return {Promise<void>}
 */
async function replyLineText(replyToken, text) {
  if (!replyToken || !text) return;
  try {
    const response = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN.value()}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: [{type: "text", text: String(text).slice(0, 2000)}],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const body = await response.text();
      const error = new Error(
          `LINE reply failed (${response.status}): ${body}`,
      );
      error.code = "LINE_REPLY_FAILED";
      error.status = response.status;
      throw error;
    }
  } catch (error) {
    if (isLineReplyFailure(error)) throw error;
    const wrapped = new Error(
        `LINE reply unavailable: ${String(error.message || error)}`,
    );
    wrapped.code = "LINE_REPLY_FAILED";
    throw wrapped;
  }
}

/**
 * Identifies delivery failures that happen after Visitor data was saved.
 * @param {*} error
 * @return {boolean}
 */
function isLineReplyFailure(error) {
  return Boolean(error && error.code === "LINE_REPLY_FAILED");
}

/**
 * Builds a stable active visitor session key for one LINE sender/target.
 * @param {Object} source
 * @return {string}
 */
function visitorSessionKey(source) {
  const targetId = getTargetIdFromSource(source) || "unknown-target";
  const senderId = source.userId || "unknown-sender";
  return shortHash(`${targetId}:${senderId}`);
}

/**
 * Atomically finds or creates the active visitor intake log id for this
 * LINE source. Runs in a transaction so that concurrent webhook deliveries
 * (e.g. an image and a text message arriving as separate POSTs) converge on
 * ONE log id instead of each minting a duplicate log.
 * @param {Object} source LINE event source
 * @param {number} now Epoch milliseconds for this event
 * @param {Object|null} parsed Parsed text payload, if this is a text event.
 * @param {Object} options Event options.
 * @return {Promise<string>} The active log id
 */
function resolveVisitorIntakeLogId(source, now, parsed = null, options = {}) {
  const store = options.store || db;
  const sessionRef = store.collection(VISITOR_INTAKE_SESSIONS_COLLECTION)
      .doc(visitorSessionKey(source));
  const eventRef = options.eventId ?
    store.collection(LINE_WEBHOOK_EVENTS_COLLECTION)
        .doc(options.eventId) : null;
  return store.runTransaction(async (tx) => {
    const eventSnap = eventRef ? await tx.get(eventRef) : null;
    const boundLogId = eventSnap && eventSnap.exists &&
      (eventSnap.data() || {}).visitorLogId;
    if (boundLogId) return boundLogId;
    const sessionSnap = await tx.get(sessionRef);
    const old = sessionSnap.exists ? sessionSnap.data() || {} : {};
    const active = old.logId && old.lastEventAtMs &&
      now - Number(old.lastEventAtMs) <= VISITOR_INTAKE_SESSION_WINDOW_MS;
    let shouldStartNew = !active;
    if (active && ((parsed && parsed.houseNo) || options.isImage)) {
      const oldLogRef = store.collection(VISITOR_INTAKE_COLLECTION)
          .doc(old.logId);
      const oldLogSnap = await tx.get(oldLogRef);
      const oldLog = oldLogSnap.exists ? oldLogSnap.data() || {} : {};
      shouldStartNew = options.isImage ?
        shouldStartNewVisitorImageLog(oldLog) :
        shouldStartNewVisitorLog(oldLog, parsed);
    }
    const logId = shouldStartNew ?
      store.collection(VISITOR_INTAKE_COLLECTION).doc().id : old.logId;
    if (eventSnap && eventSnap.exists) {
      tx.set(eventRef, {visitorLogId: logId}, {merge: true});
    }
    tx.set(sessionRef, {
      logId,
      targetId: getTargetIdFromSource(source) || null,
      senderId: source.userId || null,
      lastEventAtMs: now,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
    return logId;
  });
}

/**
 * Builds the current visitor intake reply text.
 * @param {Object} data
 * @return {string}
 */
function buildVisitorIntakeReply(data) {
  const images = Array.isArray(data.images) ? data.images : [];
  if (data.status !== "complete" && images.some((image) => !image.analysis &&
      (image.analysisPending || image.analysisFailed))) {
    return data.ocrRetryAt || images.some((image) => image.analysisPending) ?
      "✅ บันทึกรูปผู้มาติดต่อแล้ว ระบบกำลังอ่านข้อมูลจากรูป" :
      "⚠️ บันทึกรูปผู้มาติดต่อแล้ว แต่ระบบอ่านข้อมูลไม่สำเร็จ " +
        "กรุณาตรวจสอบรายการ";
  }
  const docCount = images.filter((img) =>
    ["document", "document_vehicle"].includes(img.kind)).length;
  const vehicleCount = images.filter((img) =>
    ["vehicle", "document_vehicle"].includes(img.kind)).length;
  const unknownImageCount = images.filter((img) => img.kind === "other").length;
  const houseNo = data.houseNo || "";
  const houseNos = Array.isArray(data.houseNos) ? data.houseNos : [];
  const purposeText = data.purposeText || "";
  const plate = formatVisitorReplyPlate(
      data.vehicleCapture && data.vehicleCapture.plateText,
  );
  const personName = visitorReplyPersonName(data.ocr || {});
  const exceptionLabel = visitorIntakeExceptionLabel(data.intakeException);
  const skipDocument = ["missing_document", "missing_document_and_vehicle",
    "resident_no_scan"].includes(String(data.intakeException || ""));
  const skipVehicle = ["missing_vehicle", "missing_document_and_vehicle",
    "resident_no_scan"].includes(String(data.intakeException || ""));
  const blockingMissing = [];
  const optionalMissing = [];
  if (!houseNo) blockingMissing.push("บ้านเลขที่");
  if (!purposeText) blockingMissing.push("เหตุผลที่มา");
  if (!docCount && !skipDocument) {
    const item = images.length ?
      "รูปบัตร/ใบขับขี่อ่านไม่ชัด กรุณาส่งใหม่" :
      "รูปบัตร/ใบขับขี่";
    if (plate) optionalMissing.push(item);
    else blockingMissing.push(item);
  }
  if (!vehicleCount && !plate && !skipVehicle) {
    const item = unknownImageCount ?
      "อ่านทะเบียนได้ไม่ชัดครับ รบกวน รปภ ส่งรูปป้ายทะเบียนใหม่ " +
        "หรือพิมพ์ทะเบียนให้หน่อยครับ" :
      "รูปรถ/ทะเบียน";
    if (docCount || personName) optionalMissing.push(item);
    else blockingMissing.push(item);
  } else if (!plate && !skipVehicle) {
    const item = "อ่านทะเบียนได้ไม่ชัดครับ รบกวน รปภ พิมพ์ทะเบียนให้หน่อยครับ";
    if (docCount || personName) optionalMissing.push(item);
    else blockingMissing.push(item);
  }

  const divider = "━━━━━━━━━━━━━";

  if (blockingMissing.length) {
    const missingLines = blockingMissing.map((item) => `- ${item}`)
        .join("\n");
    return [
      "ยังบันทึก Visitor ไม่ครบครับ",
      divider,
      "รบกวนส่งข้อมูลที่ขาดเพิ่ม:",
      missingLines,
      divider,
      "ถ้าส่งรูปไม่ได้ ให้พิมพ์บอกได้เลย",
      "ตัวอย่าง: ไม่มีบัตร มีแต่ทะเบียน",
      "ตัวอย่าง: ไม่มีทะเบียน มีแต่บัตร",
    ].join("\n");
  }

  const purposeLabel = visitorReplyPurposeLabel(
      data.purposeCategory,
      purposeText,
  );
  const lines = [
    "✅ บันทึกเรียบร้อย",
    divider,
    `🏠 ติดต่อบ้าน : ${visitorReplyHouseList(houseNo, houseNos)}`,
  ];
  if (personName) lines.push(`👤 ชื่อ: ${personName}`);
  lines.push(`📝 เหตุผล : ${purposeLabel}`);
  if (plate) lines.push(`🚗 ทะเบียน : ${plate}`);
  if (exceptionLabel) lines.push(`ℹ️ หมายเหตุ : ${exceptionLabel}`);
  if (optionalMissing.length) {
    lines.push(`ℹ️ ข้อมูลขาดบางส่วน : ${optionalMissing.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Formats a guard-entered exception code for LINE replies.
 * @param {string} code
 * @return {string}
 */
function visitorIntakeExceptionLabel(code) {
  switch (String(code || "")) {
    case "resident_no_scan":
      return "ลูกบ้าน/ไม่มีสแกนเข้า";
    case "missing_document":
      return "ไม่มีบัตร/ใบขับขี่";
    case "missing_vehicle":
      return "ไม่มีรูปรถ/ทะเบียน";
    case "missing_document_and_vehicle":
      return "ไม่มีบัตรและไม่มีรูปรถ/ทะเบียน";
    default:
      return "";
  }
}

/**
 * Determines whether the webhook should reply immediately on this event.
 * Complete records always reply at once. Incomplete records can reply after
 * the guard follows images with text, but only after every image has finished
 * analysis so no in-progress notice interrupts the chat.
 * @param {Object} current
 * @param {Object} merged
 * @param {Object|null} parsed
 * @param {string} reply
 * @return {boolean}
 */
function shouldReplyVisitorIntakeNow(current, merged, parsed, reply) {
  if (merged.status === "complete" && current.status !== "complete") {
    return true;
  }
  const hasPendingImage = Array.isArray(merged.images) &&
    merged.images.some((image) => image.kind === "pending" ||
      image.analysisPending === true);
  if (hasPendingImage) return false;
  if (parsed && merged.status === "partial" &&
      !["complete", "partial"].includes(String(current.status || ""))) {
    return true;
  }
  if (!parsed) return false;
  const imageCount = Array.isArray(merged.images) ? merged.images.length : 0;
  if (!imageCount || merged.status === "complete") return false;
  const nextReply = String(reply || "").trim();
  const prevReply = String(current.lastReplyText || "").trim();
  if (nextReply !== prevReply) return true;
  const lastReplyAtMs = current.lastReplyAt && current.lastReplyAt.toMillis ?
    current.lastReplyAt.toMillis() : 0;
  return !lastReplyAtMs ||
    (Date.now() - lastReplyAtMs) >= 30 * 1000;
}

/**
 * Picks the best name for the LINE reply, preferring Thai when available.
 * @param {Object} ocr
 * @return {string}
 */
function visitorReplyPersonName(ocr) {
  const candidates = [
    ocr.thaiPersonName,
    hasThaiText(ocr.personName) ? ocr.personName : "",
    ocr.englishPersonName,
    ocr.personName,
  ];
  return String(candidates.find((name) => String(name || "").trim()) || "")
      .trim();
}

/**
 * Checks if a string contains Thai text.
 * @param {string} value
 * @return {boolean}
 */
function hasThaiText(value) {
  return /[ก-๙]/u.test(String(value || ""));
}

/**
 * Formats vehicle plate text for the guard-facing LINE reply.
 * @param {string} raw
 * @return {string}
 */
function formatVisitorReplyPlate(raw) {
  return normalizeVisitorPlate(raw);
}

/**
 * Checks whether a visitor plate looks like a normal Thai plate string.
 * @param {string} raw
 * @return {boolean}
 */
function isLikelyThaiVisitorPlate(raw) {
  const value = stripThaiProvinceForLookup(normalizeVisitorPlate(raw));
  if (!value) return false;
  return /^[0-9]?[ก-ฮ]{1,3}[0-9]{1,4}$/u.test(value);
}

/**
 * Builds warning codes for records that look incomplete or low-confidence.
 * @param {Object} data
 * @return {string[]}
 */
function getVisitorWarningCodes(data) {
  const warnings = new Set();
  if ((data.images || []).some((image) => image.analysisFailed)) {
    warnings.add(data.ocrRetryAt ? "ocr_retry_pending" : "ocr_failed");
  }
  const parsedWarnings = data && data.textParse &&
    Array.isArray(data.textParse.warnings) ? data.textParse.warnings : [];
  parsedWarnings.forEach((item) => warnings.add(item));
  if (!["complete", "partial"].includes(String(data.status || ""))) {
    warnings.add("incomplete");
  }
  if (["other", "unknown"].includes(String(data.purposeCategory || "")) &&
      String(data.purposeText || "").trim()) {
    warnings.add("category_fallback");
  }
  const ocr = data.ocr || {};
  const hasName = [
    ocr.personName,
    ocr.thaiPersonName,
    ocr.englishPersonName,
  ].some((value) => String(value || "").trim());
  if (hasName && !String(ocr.documentNumber || "").trim()) {
    warnings.add("missing_document_number");
  }
  if (Number(ocr.confidence) > 0 && Number(ocr.confidence) < 0.9) {
    warnings.add("low_document_confidence");
  }
  const plateText = data.vehicleCapture && data.vehicleCapture.plateText || "";
  if (plateText && !isLikelyThaiVisitorPlate(plateText)) {
    warnings.add("suspicious_plate_text");
  }
  return Array.from(warnings);
}

/**
 * Converts one warning code into a short Thai operator label.
 * @param {string} code
 * @return {string}
 */
function visitorWarningLabel(code) {
  return {
    incomplete: "ข้อมูลยังไม่ครบ",
    ocr_retry_pending: "ระบบจะลองอ่านรูปใหม่อัตโนมัติ",
    ocr_failed: "ระบบอ่านรูปไม่สำเร็จ กรุณาตรวจสอบ",
    category_fallback: "หมวดอัตโนมัติยังไม่ชัด",
    missing_document_number: "อ่านเลขบัตร/ใบขับขี่ไม่ครบ",
    low_document_confidence: "OCR บัตร/ใบขับขี่มั่นใจไม่สูง",
    suspicious_plate_text: "ทะเบียนที่อ่านได้ดูผิดปกติ",
    house_format_ambiguous: "เลขบ้านในข้อความกำกวม",
    text_spacing_normalized: "ข้อความพิมพ์ติดกัน ระบบช่วยแยกคำให้",
    pickup_text_interpreted: "ความหมายรับ-ส่งตีความจากข้อความ",
    common_area_inferred: "ระบบตีความว่าเป็นงานส่วนกลาง",
  }[code] || "ต้องตรวจสอบข้อมูล";
}

/**
 * Returns user-facing warning labels for a visitor record.
 * @param {Object} data
 * @return {string[]}
 */
function buildVisitorWarnings(data) {
  return getVisitorWarningCodes(data).map(visitorWarningLabel);
}

/**
 * Counts visitor logs and prepares concise rows for the daily LINE report.
 * @param {string} reportDate
 * @return {Promise<Object>}
 */
async function buildVisitorDailyReport(reportDate) {
  const date = String(reportDate || getYesterdayBangkokDate()).slice(0, 10);
  const snap = await db.collection(VISITOR_INTAKE_COLLECTION)
      .where("visitDate", "==", date)
      .limit(500)
      .get();
  const records = snap.docs
      .map((docSnap) => ({id: docSnap.id, ...(docSnap.data() || {})}))
      .sort((a, b) => {
        const av = a.createdAt && a.createdAt.toMillis ?
          a.createdAt.toMillis() : 0;
        const bv = b.createdAt && b.createdAt.toMillis ?
          b.createdAt.toMillis() : 0;
        return av - bv;
      });
  const categories = {};
  const houses = new Set();
  let complete = 0;
  let withPlate = 0;
  let withDocumentNo = 0;
  let missingImage = 0;
  const rows = [];

  records.forEach((record) => {
    const category = record.purposeCategory || "unknown";
    categories[category] = (categories[category] || 0) + 1;
    if (record.houseNo) houses.add(record.houseNo);
    if (["complete", "partial"].includes(record.status)) complete += 1;
    else if (record.status === "pending_image") missingImage += 1;
    const plate = record.vehicleCapture ?
      normalizeVisitorPlate(record.vehicleCapture.plateText) : "";
    if (plate) withPlate += 1;
    const documentNumber = record.ocr ?
      normalizeDocumentNumber(record.ocr.documentNumber) : "";
    if (documentNumber) withDocumentNo += 1;
    rows.push({
      id: record.id,
      time: record.createdAt && record.createdAt.toMillis ?
        formatBangkokHm(record.createdAt.toMillis()) : "",
      houseNo: record.houseNo || "ไม่พบบ้าน",
      category,
      purposeLabel: visitorPurposeLabel(category, record.purposeText),
      plate,
      status: record.status || "unknown",
    });
  });

  return {
    reportDate: date,
    generatedAt: new Date().toISOString(),
    total: records.length,
    complete,
    pending: records.length - complete,
    missingImage,
    withPlate,
    withDocumentNo,
    houses: houses.size,
    categories,
    topCategories: Object.entries(categories)
        .sort((a, b) => b[1] - a[1])
        .map(([category, count]) => ({
          category,
          label: visitorPurposeLabel(category, ""),
          count,
        })),
    rows,
  };
}

/**
 * Builds one LINE Flex message for the Visitor Intake daily summary.
 * @param {Object} report
 * @return {Object}
 */
function buildVisitorDailyFlexMessage(report) {
  const t = {
    headBg: "#F6F1E7",
    bodyBg: "#FFFCF7",
    cardBg: "#F1EADC",
    title: "#3B3026",
    text: "#2A2218",
    label: "#8A7E6D",
    line: "#E8DFCF",
    green: "#5E7A3F",
    orange: "#B26A3A",
    red: "#A8432F",
    muted: "#8A7E6D",
  };
  const dateText = new Intl.DateTimeFormat("th-TH-u-ca-gregory", {
    dateStyle: "long",
    timeZone: "Asia/Bangkok",
  }).format(new Date(`${report.reportDate}T12:00:00+07:00`));
  const stat = (value, label, color) => ({
    type: "box", layout: "vertical", flex: 1, contents: [
      {type: "text", text: String(value), size: "xxl", weight: "bold",
        color, align: "center"},
      {type: "text", text: label, size: "xs", color: t.label,
        align: "center", margin: "xs", wrap: true},
    ],
  });
  const categoryRows = (report.topCategories || []).slice(0, 5)
      .map((item) => ({
        type: "box", layout: "horizontal", margin: "sm", contents: [
          {type: "text", text: item.label, size: "sm", color: t.text,
            flex: 4, wrap: false, adjustMode: "shrink-to-fit"},
          {type: "text", text: `${item.count} รายการ`, size: "sm",
            color: t.orange, weight: "bold", align: "end", flex: 2},
        ],
      }));
  const recordRows = (report.rows || []).slice(0, 8).map((row) => ({
    type: "box", layout: "horizontal", margin: "md", spacing: "sm",
    alignItems: "center", contents: [
      {type: "text", text: row.time || "—", size: "xs", color: t.label,
        flex: 2, wrap: false},
      {type: "text", text: row.houseNo || "—", size: "sm",
        weight: "bold", color: t.text, flex: 2, wrap: false,
        adjustMode: "shrink-to-fit"},
      {type: "text", text: row.purposeLabel || "ไม่ระบุ", size: "xs",
        color: t.label, flex: 4, wrap: false, adjustMode: "shrink-to-fit"},
      {type: "text", text: row.plate || "", size: "xxs",
        color: row.plate ? t.orange : t.muted, flex: 3, align: "end",
        wrap: false, adjustMode: "shrink-to-fit"},
    ],
  }));
  if ((report.rows || []).length > 8) {
    recordRows.push({type: "text",
      text: `… และอีก ${(report.rows || []).length - 8} รายการ`,
      size: "xs", color: t.label, align: "center", margin: "md"});
  }
  if (!recordRows.length) {
    recordRows.push({type: "text", text: "ไม่มีรายการผู้มาติดต่อ",
      size: "sm", color: t.green, align: "center", margin: "md"});
  }
  if (!categoryRows.length) {
    categoryRows.push({type: "text", text: "ยังไม่มีข้อมูลหมวดหมู่",
      size: "sm", color: t.label, align: "center", margin: "sm"});
  }

  return {
    type: "flex",
    altText: `Visitor summary ${dateText}: ${report.total} รายการ`,
    contents: {
      type: "bubble", size: "giga",
      header: {type: "box", layout: "vertical", paddingAll: "18px",
        backgroundColor: t.headBg, contents: [
          {type: "text", text: "สรุปผู้มาติดต่อประจำวัน", size: "lg",
            weight: "bold", color: t.title, wrap: true},
          {type: "text", text: dateText, size: "sm", color: t.label,
            margin: "xs", wrap: false, adjustMode: "shrink-to-fit"},
          {type: "text", text: "Visitor Intake · Pattra Watch", size: "xs",
            color: t.orange, margin: "sm"},
        ]},
      body: {type: "box", layout: "vertical", paddingAll: "18px",
        backgroundColor: t.bodyBg, contents: [
          {type: "box", layout: "vertical", backgroundColor: t.cardBg,
            cornerRadius: "md", paddingAll: "12px", contents: [
              {type: "text", text: "ผู้มาติดต่อทั้งหมด", size: "sm",
                weight: "bold", color: t.title, align: "center"},
              {type: "text", text: `${report.total} รายการ`, size: "xxl",
                weight: "bold", color: t.orange, align: "center"},
              {type: "text", text: `บ้านที่ติดต่อ ${report.houses} หลัง`,
                size: "xs", color: t.label, align: "center", margin: "xs"},
            ]},
          {type: "box", layout: "horizontal", spacing: "sm", margin: "lg",
            contents: [
              stat(report.complete, "ครบแล้ว", t.green),
              stat(report.pending, "รอข้อมูล", t.red),
              stat(report.withPlate, "มีทะเบียน", t.orange),
            ]},
          {type: "separator", margin: "lg", color: t.line},
          {type: "text", text: "มาทำอะไร", size: "md", weight: "bold",
            color: t.title, margin: "lg"},
          ...categoryRows,
          {type: "separator", margin: "lg", color: t.line},
          {type: "text", text: "รายการล่าสุด", size: "md", weight: "bold",
            color: t.title, margin: "lg"},
          ...recordRows,
        ]},
    },
  };
}

/**
 * Persists and optionally sends one visitor daily summary.
 * @param {string} reportDate
 * @param {boolean} sendLine
 * @param {string} targetIdOverride
 * @return {Promise<Object>}
 */
async function runVisitorDailyReport(reportDate, sendLine = true,
    targetIdOverride = "") {
  const report = await buildVisitorDailyReport(reportDate);
  const reportRef = db.collection(VISITOR_DAILY_REPORTS_COLLECTION)
      .doc(report.reportDate);
  let lineSent = false;
  let lineError = "";
  let lineTargetId = "";
  if (sendLine) {
    try {
      const targetId = targetIdOverride || await getVisitorDailyTargetId();
      if (!targetId) {
        throw new Error("Visitor daily LINE sandbox target is not set");
      }
      await sendLinePushMessages(targetId, [
        buildVisitorDailyFlexMessage(report),
      ]);
      lineSent = true;
      lineTargetId = targetId;
    } catch (error) {
      lineError = error.message;
      logger.error("Visitor daily LINE report failed", error);
    }
  }
  await reportRef.set({
    ...report,
    lineSent,
    lineError,
    lineTargetId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
  return {...report, lineSent, lineError, lineTargetId};
}

/**
 * Handles one visitor intake LINE message.
 * @param {Object} event
 * @return {Promise<boolean>} true if this event was handled as intake
 */
async function handleVisitorIntakeEvent(event) {
  if (event.type !== "message" || !event.message) return false;
  const message = event.message || {};
  if (!["text", "image"].includes(message.type)) return false;

  const messageText = message.type === "text" ?
    String(message.text || "").trim() : "";
  if (message.type === "text" && !messageText) return false;

  const source = event.source || {};
  const now = Date.now();

  let parsed = null;
  if (message.type === "text") {
    parsed = parseVisitorIntakeText(messageText);
    if (parsed.ignored) {
      logger.info("Visitor intake ignored chat text", {
        reason: parsed.ignoredReason,
      });
      return false;
    }
  }

  const logId = await resolveVisitorIntakeLogId(
      source,
      now,
      parsed,
      {isImage: message.type === "image",
        eventId: getLineWebhookEventId(event)},
  );
  const logRef = db.collection(VISITOR_INTAKE_COLLECTION).doc(logId);

  // Slow work (download + save + Gemini analyze) runs OUTSIDE the
  // transaction so the transaction below stays fast and retry-safe.
  let storedImage = null;
  let imageOcr = null;
  let imageVehicle = null;
  if (message.type === "image") {
    const existingSnap = await logRef.get();
    const existing = existingSnap.exists ? existingSnap.data() || {} : {};
    const saved = (existing.images || []).find((i) =>
      i.messageId === message.id && i.storagePath && !i.purgedAt);
    if (saved && (saved.analysis || saved.analysisAttempts >= 9 ||
        saved.analysisRetryable === false)) return true;
    const image = saved || await saveVisitorIntakeImage(event, logId);
    const priorAttempts = Number(image.analysisAttempts || 0);
    storedImage = {
      ...image,
      kind: "pending",
      analysisPending: true,
      analysisAttempts: Math.min(9, priorAttempts + 3),
      analysis: null,
    };
    const reserved = await db.runTransaction(async (tx) => {
      const snap = await tx.get(logRef);
      const cur = snap.exists ? snap.data() || {} : {};
      if (cur.ocrRecoveryLease &&
          visitorTimestampMs(cur.ocrRetryAt) > Date.now()) {
        throw new Error("Visitor OCR recovery in progress; retry later");
      }
      const images = Array.isArray(cur.images) ? [...cur.images] : [];
      const index = storedImage.messageId ? images.findIndex(
          (im) => im.messageId === storedImage.messageId) : -1;
      if (index >= 0 && images[index].analysis) return false;
      if (index >= 0 &&
          Number(images[index].analysisAttempts || 0) !== priorAttempts) {
        throw new Error("Visitor image changed; retry with current state");
      }
      if (index >= 0) images[index] = {...images[index], ...storedImage};
      else images.push(storedImage);
      const update = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastLineMessageId: message.id || null,
        images,
        ocrRetryAt: admin.firestore.Timestamp.fromMillis(Date.now() +
          5 * 60 * 1000),
      };
      if (!snap.exists) {
        update.createdAt = admin.firestore.FieldValue.serverTimestamp();
        update.visitDate = getTodayBangkokDate();
        update.lineGroupId = source.groupId || null;
        update.lineRoomId = source.roomId || null;
        update.lineUserId = source.userId || null;
        update.sourceType = source.type || null;
        update.lprLinked = false;
        update.imagesPurged = false;
        update.imageRetentionDays = VISITOR_INTAKE_IMAGE_RETENTION_DAYS;
        update.metadataRetentionDays = VISITOR_INTAKE_METADATA_RETENTION_DAYS;
        update.metadataExpiresAt = admin.firestore.Timestamp.fromDate(
            daysFromNow(VISITOR_INTAKE_METADATA_RETENTION_DAYS),
        );
      }
      tx.set(logRef, update, {merge: true});
      return true;
    });
    if (!reserved) return true;
    const outcome = await analyzeVisitorImageWithRetry(
        () => analyzeVisitorIntakeImage(image.storagePath),
        (error, attempt) => logger.warn(
            "Visitor intake image analysis failed",
            {logId, attempt, error: error.message},
        ),
        Math.min(3, 9 - priorAttempts),
    );
    const analysis = outcome.analysis;
    storedImage = {
      ...image,
      ...visitorImageAnalysisPatch(outcome),
      analysisAttempts: priorAttempts + outcome.attempts,
    };
    const kind = storedImage.kind;
    if (analysis && ["document", "document_vehicle"].includes(kind)) {
      imageOcr = {
        personName: analysis.personName || "",
        thaiPersonName: analysis.thaiPersonName || "",
        englishPersonName: analysis.englishPersonName || "",
        documentType: analysis.documentType || "unknown",
        documentNumber: analysis.documentNumber || "",
        maskedDocumentNo: analysis.maskedDocumentNo || "",
        confidence: analysis.confidence,
      };
    }
    if (analysis && ["vehicle", "document_vehicle"].includes(kind)) {
      imageVehicle = {
        plateText: analysis.vehiclePlate || "",
        vehicleType: analysis.vehicleType || "unknown",
        confidence: analysis.confidence,
      };
    }
  }

  // Merge this message into the log atomically. Concurrent messages each
  // read the latest state inside the transaction (retrying on conflict), so
  // no image is lost and the status is always computed from complete data.
  // Reply only when the reply text actually changes, to avoid duplicate
  // messages when several events land in the same burst.
  const replyText = await db.runTransaction(async (tx) => {
    const snap = await tx.get(logRef);
    const cur = snap.exists ? snap.data() || {} : {};
    if (parsed && (cur.rawTexts || []).some((text) =>
      text.messageId === message.id)) return null;
    if (storedImage && (!snap.exists || cur.imagesPurged)) return null;
    const update = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastLineMessageId: message.id || null,
    };
    if (!snap.exists) {
      update.createdAt = admin.firestore.FieldValue.serverTimestamp();
      update.visitDate = getTodayBangkokDate();
      update.lineGroupId = source.groupId || null;
      update.lineRoomId = source.roomId || null;
      update.lineUserId = source.userId || null;
      update.sourceType = source.type || null;
      update.lprLinked = false;
      update.imagesPurged = false;
      update.imageRetentionDays = VISITOR_INTAKE_IMAGE_RETENTION_DAYS;
      update.metadataRetentionDays = VISITOR_INTAKE_METADATA_RETENTION_DAYS;
      update.metadataExpiresAt = admin.firestore.Timestamp.fromDate(
          daysFromNow(VISITOR_INTAKE_METADATA_RETENTION_DAYS),
      );
    }

    if (parsed) {
      const texts = Array.isArray(cur.rawTexts) ? [...cur.rawTexts] : [];
      if (!texts.some((text) => text.messageId === message.id)) {
        texts.push({
          messageId: message.id || null,
          text: parsed.rawText,
          createdAt: admin.firestore.Timestamp.fromDate(new Date()),
        });
      }
      update.rawTexts = texts;
      if (parsed.houseNo) update.houseNo = parsed.houseNo;
      if (parsed.houseNos && parsed.houseNos.length) {
        update.houseNos = parsed.houseNos;
      }
      if (parsed.purposeText) update.purposeText = parsed.purposeText;
      if (parsed.purposeText) update.purposeCategory = parsed.purposeCategory;
      if (parsed.vehiclePlate) {
        const currentVehicle = cur.vehicleCapture || {};
        update.vehicleCapture = {
          ...currentVehicle,
          plateText: parsed.vehiclePlate,
          vehicleType: currentVehicle.vehicleType || "unknown",
          confidence: Math.max(Number(currentVehicle.confidence) || 0, 0.75),
          source: "typed_text",
        };
      }
      if (parsed.intakeException) {
        update.intakeException = parsed.intakeException;
      }
      update.textParse = parsed;
    }

    if (storedImage) {
      const images = Array.isArray(cur.images) ? [...cur.images] : [];
      const index = storedImage.messageId ? images.findIndex(
          (im) => im.messageId === storedImage.messageId) : -1;
      if (index < 0 || images[index].purgedAt || images[index].analysis ||
          images[index].storagePath !== storedImage.storagePath) return null;
      images[index] = {...images[index], ...storedImage};
      update.images = images;
      if (imageOcr) update.ocr = mergeVisitorEvidence(cur.ocr, imageOcr);
      if (imageVehicle) {
        update.vehicleCapture = mergeVisitorEvidence(
            cur.vehicleCapture, imageVehicle);
      }
      const retryAt = nextVisitorOcrRetryAt(images, Date.now());
      update.ocrRetryAt = retryAt ?
        admin.firestore.Timestamp.fromMillis(retryAt) :
        admin.firestore.FieldValue.delete();
    }

    const merged = {...cur, ...update};
    if (storedImage && !nextVisitorOcrRetryAt(merged.images, Date.now())) {
      delete merged.ocrRetryAt;
    }
    merged.status = getVisitorIntakeStatus(merged);
    update.status = merged.status;
    const reply = buildVisitorIntakeReply(merged);
    // Reply right away when the visit becomes complete. For incomplete
    // records, wait until all images finish analysis before asking for any
    // missing information so an in-progress notice does not interrupt chat.
    const replyNow = shouldReplyVisitorIntakeNow(cur, merged, parsed, reply);
    if (replyNow) {
      update.lastReplyText = reply;
      update.lastReplyAt = admin.firestore.FieldValue.serverTimestamp();
    }
    tx.set(logRef, update, {merge: true});
    return replyNow ? reply : null;
  });

  if (replyText) {
    await replyLineText(event.replyToken, replyText);
  }
  logger.info("Visitor intake event handled", {logId});
  return true;
}

/**
 * Processes one verified LINE event after the webhook has acknowledged it.
 * @param {Object} event
 * @return {Promise<void>}
 */
async function processLineWebhookEvent(event) {
  const source = event.source || {};
  await upsertLineTarget(source, event.type);

  const data = {
    sourceType: source.type || null,
    groupId: source.groupId || null,
    roomId: source.roomId || null,
    userId: source.userId || null,
    lastEventType: event.type || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const messageText = event.type === "message" &&
    event.message && event.message.type === "text" ?
    String(event.message.text || "").trim() : "";
  if (source.type === "group" && source.groupId &&
      isSecurityShiftReportWindow(event.timestamp)) {
    const shift = parseSecurityShiftKind(messageText) ||
      getSecurityShiftFromTimestamp(event.timestamp);
    const officerName = parseSecurityShiftName(messageText);
    if (shift && officerName &&
        /รายงานตัว|ปฏิบัติหน้าที่|เรียนมาเพื่อทราบ|รับทราบ|รปภ/i
            .test(messageText)) {
      await upsertSecurityShiftReport(shift, officerName, source);
      logger.info("Stored security shift officer", {
        groupId: source.groupId,
        shift,
        officerName,
      });
    }
  }
  if (source.type === "group" && source.groupId &&
      messageText === "เปิดรับรายงาน LPR") {
    await db.doc(LPR_MONITOR_CONFIG_PATH).set({
      targetId: source.groupId,
      groupId: source.groupId,
      registeredBy: source.userId || null,
      command: messageText,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
    logger.info("Registered dedicated LPR monitor group", {
      groupId: source.groupId,
    });
  }
  if (source.type === "group" && source.groupId &&
      messageText === "รับข้อมูล Pattra Daily Traffic") {
    await db.doc(DAILY_TRAFFIC_CONFIG_PATH).set({
      targetId: source.groupId,
      groupId: source.groupId,
      registeredBy: source.userId || null,
      command: messageText,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
    logger.info("Registered daily traffic report group", {
      groupId: source.groupId,
    });
  }
  if (source.type === "group" && source.groupId &&
      messageText === "รับรายงาน ตรวจงาน รปภ") {
    await db.doc(GUARD_AUDIT_CONFIG_PATH).set({
      targetId: source.groupId,
      groupId: source.groupId,
      registeredBy: source.userId || null,
      command: messageText,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
    logger.info("Registered guard audit report group", {
      groupId: source.groupId,
    });
  }
  if (source.type === "group" && source.groupId &&
      messageText === "เปิดรับ Visitor Intake") {
    await db.doc(VISITOR_INTAKE_CONFIG_PATH).set({
      targetId: source.groupId,
      groupId: source.groupId,
      registeredBy: source.userId || null,
      command: messageText,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
    await replyLineText(
        event.replyToken,
        "✅ เปิดรับ Visitor Intake แล้วครับ\n\n" +
        "ส่งข้อมูล Visitor ได้เลย:\n" +
        "1) รูปบัตร/ใบขับขี่\n" +
        "2) รูปรถที่เห็นทะเบียน\n" +
        "3) บ้านเลขที่ + เหตุผล\n\n" +
        "ตัวอย่าง:\n" +
        "38/13\n" +
        "ช่างมาทาสี",
    );
    logger.info("Registered visitor intake group", {
      groupId: source.groupId,
    });
    return;
  }

  if (await isVisitorIntakeTarget(source)) {
    try {
      const handled = await handleVisitorIntakeEvent(event);
      if (handled) return;
    } catch (error) {
      if (isLineReplyFailure(error)) {
        logger.warn("Visitor intake saved; LINE reply suppressed", {
          status: Number(error.status || 0) || null,
        });
        return;
      }
      logger.error("Visitor intake handling failed; retrying silently", {
        error: error.message,
      });
      throw error;
    }
  }

  if (data.groupId || data.roomId || data.userId) {
    await db.doc(LINE_CONFIG_PATH).set(data, {merge: true});
    logger.info("Stored LINE target", data);
  }
}

/**
 * Returns a Firestore-safe, stable id for LINE webhook redelivery dedupe.
 * @param {Object} event
 * @return {string}
 */
function getLineWebhookEventId(event) {
  const webhookEventId = String(event.webhookEventId || "").trim();
  if (/^[A-Za-z0-9_-]{1,200}$/.test(webhookEventId)) {
    return webhookEventId;
  }
  return shortHash(JSON.stringify(event || {}));
}

/**
 * Persists verified LINE events before acknowledging the webhook request.
 * Existing ids are intentional redeliveries and must not trigger twice.
 * @param {Object[]} events
 * @return {Promise<number>}
 */
async function enqueueLineWebhookEvents(events) {
  let queued = 0;
  await Promise.all(events.map(async (event) => {
    const eventId = getLineWebhookEventId(event);
    const ref = db.collection(LINE_WEBHOOK_EVENTS_COLLECTION).doc(eventId);
    try {
      await ref.create({
        event,
        status: "queued",
        attempts: 0,
        eventTimestamp: Number(event.timestamp) || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      queued += 1;
    } catch (error) {
      if (Number(error.code) === 6 || error.code === "already-exists") {
        logger.info("Ignored duplicate LINE webhook event", {eventId});
        return;
      }
      throw error;
    }
  }));
  return queued;
}

exports.lineWebhook = onRequest(
    {
      secrets: [LINE_CHANNEL_SECRET],
      minInstances: 0,
      timeoutSeconds: 10,
    },
    async (req, res) => {
      if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return;
      }

      const signature = req.get("x-line-signature");
      const rawBody = req.rawBody ||
        Buffer.from(JSON.stringify(req.body || {}));
      const expectedSignature = crypto
          .createHmac("SHA256", LINE_CHANNEL_SECRET.value())
          .update(rawBody)
          .digest("base64");

      if (!signature || signature !== expectedSignature) {
        logger.error("Invalid LINE signature");
        res.status(401).send("Invalid signature");
        return;
      }

      const body = req.body || {};
      const events = Array.isArray(body.events) ? body.events : [];
      try {
        const queued = await enqueueLineWebhookEvents(events);
        res.status(200).json({ok: true});
        logger.info("LINE webhook acknowledged", {
          received: events.length,
          queued,
        });
      } catch (error) {
        logger.error("Unable to enqueue LINE webhook", {
          error: error.message,
        });
        res.status(500).json({ok: false});
      }
    },
);

exports.lineWebhookWorker = onDocumentCreated(
    {
      document: `${LINE_WEBHOOK_EVENTS_COLLECTION}/{eventId}`,
      secrets: [LINE_CHANNEL_ACCESS_TOKEN],
      memory: "512MiB",
      timeoutSeconds: 240,
      retry: true,
    },
    async (triggerEvent) => {
      const snap = triggerEvent.data;
      if (!snap) return;
      const eventId = triggerEvent.params.eventId;
      const queueRef = snap.ref;
      const queued = await db.runTransaction(async (tx) => {
        const currentSnap = await tx.get(queueRef);
        if (!currentSnap.exists) return null;
        const current = currentSnap.data() || {};
        if (current.status === "completed") return null;
        if (current.status === "processing" && Date.now() -
            visitorTimestampMs(current.processingAt) < 270 * 1000) {
          throw new Error("LINE event already processing; retry after lease");
        }
        tx.set(queueRef, {
          status: "processing",
          attempts: admin.firestore.FieldValue.increment(1),
          processingAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
        return current.event || null;
      });
      if (!queued) return;

      try {
        await processLineWebhookEvent(queued);
        await queueRef.set({
          event: admin.firestore.FieldValue.delete(),
          status: "completed",
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
        logger.info("LINE webhook event completed", {eventId});
      } catch (error) {
        if (isLineContentUnavailable(error)) {
          const source = queued.source || {};
          const message = queued.message || {};
          await queueRef.set({
            status: "needs_resend",
            recovery: {
              reason: "line_content_unavailable",
              messageId: String(message.id || ""),
              messageType: String(message.type || ""),
              targetId: getTargetIdFromSource(source),
              eventTimestamp: Number(queued.timestamp || 0),
              isRedelivery: queued.deliveryContext &&
                queued.deliveryContext.isRedelivery === true,
            },
            lastError: String(error.message || error).slice(0, 500),
            failedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, {merge: true});
          logger.warn("LINE media expired; resend required", {
            eventId,
            messageId: String(message.id || ""),
          });
          return;
        }
        await queueRef.set({
          status: "failed",
          lastError: String(error.message || error).slice(0, 500),
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
        logger.error("LINE webhook worker failed", {
          eventId,
          error: error.message,
        });
        throw error;
      }
    },
);

exports.visitorIntakeCleanup = onSchedule(
    {
      schedule: "every day 03:20",
      timeZone: "Asia/Bangkok",
    },
    async () => {
      const now = new Date();
      const imageCutoff = admin.firestore.Timestamp.fromDate(
          new Date(Date.now() -
            VISITOR_INTAKE_IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000),
      );
      const staleImagesSnap = await db.collection(VISITOR_INTAKE_COLLECTION)
          .where("imagesPurged", "==", false)
          .where("createdAt", "<=", imageCutoff)
          .limit(100)
          .get();
      const bucket = admin.storage().bucket();

      for (const docSnap of staleImagesSnap.docs) {
        const data = docSnap.data() || {};
        const images = Array.isArray(data.images) ? data.images : [];
        const storagePaths = images
            .map((image) => image.storagePath)
            .filter(Boolean);
        await Promise.all(storagePaths.map((path) =>
          bucket.file(path).delete({ignoreNotFound: true}),
        ));
        const purgedImages = images.map((image) => ({
          ...image,
          storagePath: "",
          purgedAt: admin.firestore.Timestamp.fromDate(now),
        }));
        await docSnap.ref.set({
          images: purgedImages,
          imagesPurged: true,
          imagesPurgedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
      }

      const metadataSnap = await db.collection(VISITOR_INTAKE_COLLECTION)
          .where("metadataExpiresAt", "<=", admin.firestore.Timestamp
              .fromDate(now))
          .limit(100)
          .get();
      await Promise.all(metadataSnap.docs.map(async (docSnap) => {
        const data = docSnap.data() || {};
        const images = Array.isArray(data.images) ? data.images : [];
        const storagePaths = images
            .map((image) => image.storagePath)
            .filter(Boolean);
        await Promise.all(storagePaths.map((path) =>
          bucket.file(path).delete({ignoreNotFound: true}),
        ));
        await docSnap.ref.delete();
      }));

      const sessionCutoffMs = Date.now() -
        VISITOR_INTAKE_METADATA_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const sessionsSnap = await db
          .collection(VISITOR_INTAKE_SESSIONS_COLLECTION)
          .where("lastEventAtMs", "<=", sessionCutoffMs)
          .limit(100)
          .get();
      await Promise.all(sessionsSnap.docs.map((docSnap) => docSnap.ref
          .delete()));

      const webhookCutoff = admin.firestore.Timestamp.fromDate(new Date(
          Date.now() - LINE_WEBHOOK_EVENT_RETENTION_DAYS *
          24 * 60 * 60 * 1000,
      ));
      const webhookEventsSnap = await db
          .collection(LINE_WEBHOOK_EVENTS_COLLECTION)
          .where("updatedAt", "<=", webhookCutoff)
          .limit(100)
          .get();
      await Promise.all(webhookEventsSnap.docs.map((docSnap) => docSnap.ref
          .delete()));

      logger.info("Visitor intake cleanup complete", {
        imageDocs: staleImagesSnap.size,
        metadataDocs: metadataSnap.size,
        sessions: sessionsSnap.size,
        webhookEvents: webhookEventsSnap.size,
      });
    },
);

// How long an incomplete session must sit quiet before we nudge the guard,
// and how old before we treat it as abandoned and stop nudging.
const VISITOR_INTAKE_REMINDER_QUIET_MS = 3 * 60 * 1000;
const VISITOR_INTAKE_REMINDER_FLOOR_MS = 10 * 60 * 1000;
const VISITOR_OUTAGE_HEALTH_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Builds the hourly guard notice used only during a confirmed LINE outage.
 * @return {string}
 */
function buildVisitorLineOutageNotice() {
  return [
    "⚠️ แจ้งสถานะระบบ Visitor",
    "",
    "ขณะนี้ LINE Messaging API ขัดข้องชั่วคราว",
    "รปภ. สามารถส่งข้อมูลได้ตามปกติครับ",
    "ระบบจะเก็บข้อมูลไว้ และประมวลผลย้อนหลังให้อัตโนมัติ",
    "เมื่อ LINE กลับมาให้บริการตามปกติ",
  ].join("\n");
}

/**
 * Sends at most one Visitor outage notice per hour to its explicit target.
 * @param {number} nowMs
 * @return {Promise<boolean>}
 */
async function maybeSendVisitorLineOutageNotice(nowMs) {
  const configRef = db.doc(VISITOR_INTAKE_CONFIG_PATH);
  const lease = await db.runTransaction(async (tx) => {
    const snap = await tx.get(configRef);
    const config = snap.exists ? snap.data() || {} : {};
    const targetId = String(config.targetId || "").trim();
    if (!targetId || !shouldAttemptVisitorOutageNotice(
        config.lineOutageNoticeAttemptEpoch,
        nowMs,
    )) {
      return null;
    }
    tx.set(configRef, {
      lineOutageNoticeAttemptEpoch: nowMs,
      lineOutageNoticeAttemptAt:
        admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
    return {targetId};
  });
  if (!lease) return false;

  try {
    await sendLinePush(lease.targetId, buildVisitorLineOutageNotice());
    await configRef.set({
      lineOutageNoticeSentEpoch: nowMs,
      lineOutageNoticeSentAt:
        admin.firestore.FieldValue.serverTimestamp(),
      lineOutageNoticeLastError: "",
    }, {merge: true});
    logger.warn("Visitor LINE outage notice sent", {
      targetId: maskTargetId(lease.targetId),
    });
    return true;
  } catch (error) {
    await configRef.set({
      lineOutageNoticeLastError:
        String(error.message || error).slice(0, 300),
    }, {merge: true});
    logger.warn("Visitor LINE outage notice failed", {
      targetId: maskTargetId(lease.targetId),
      error: error.message,
    });
    return false;
  }
}

/**
 * Recovers one persisted OCR job with a lease and per-image attempt budget.
 * Never changes visit timestamps, house assignments, images, or LINE replies.
 * @param {FirebaseFirestore.DocumentReference} ref Intake record.
 * @param {number} now Current time.
 * @param {Object} options Optional dependencies for deterministic tests.
 * @return {Promise<boolean>}
 */
async function recoverVisitorIntakeOcr(ref, now, options = {}) {
  const store = options.store || db;
  const analyze = options.analyze || analyzeVisitorIntakeImage;
  const lease = crypto.randomUUID();
  const claimed = await store.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data() || {};
    const due = visitorTimestampMs(data.ocrRetryAt);
    if (!due || due > now) return null;
    const images = Array.isArray(data.images) ? [...data.images] : [];
    const index = data.imagesPurged ? -1 : images.findIndex((image) =>
      canRetryVisitorImage(image, now));
    if (index < 0) {
      tx.update(ref, {
        images: images.map((image) => image.analysisPending && !image.analysis ?
          {...image, analysisPending: false, analysisFailed: true} : image),
        ocrRetryAt: admin.firestore.FieldValue.delete(),
        ocrRecoveryLease: admin.firestore.FieldValue.delete(),
      });
      return null;
    }
    const image = images[index];
    images[index] = {...image, analysisPending: true,
      analysisAttempts: Number(image.analysisAttempts || 0) + 1};
    tx.update(ref, {
      images,
      ocrRecoveryLease: lease,
      ocrRetryAt: admin.firestore.Timestamp.fromMillis(now + 5 * 60 * 1000),
    });
    return image;
  });
  if (!claimed) return false;

  const outcome = await analyzeVisitorImageWithRetry(
      () => analyze(claimed.storagePath),
      (error) => logger.warn("Visitor OCR recovery request failed", {
        logId: ref.id, error: error.message,
      }),
      1,
  );
  return store.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const data = snap.data() || {};
    if (data.ocrRecoveryLease !== lease) return false;
    const images = Array.isArray(data.images) ? [...data.images] : [];
    const index = images.findIndex((image) =>
      image.messageId === claimed.messageId &&
      image.storagePath === claimed.storagePath);
    const active = !data.imagesPurged && index >= 0 &&
      !images[index].purgedAt && !images[index].analysis &&
      (!images[index].expiresAt ||
        visitorTimestampMs(images[index].expiresAt) > Date.now());
    const update = {ocrRecoveryLease: admin.firestore.FieldValue.delete()};
    if (active) {
      images[index] = {...images[index], ...visitorImageAnalysisPatch(outcome)};
      const aggregates = deriveVisitorAggregatesFromImages(images);
      update.images = images;
      if (aggregates.ocr) {
        update.ocr = mergeVisitorEvidence(data.ocr, aggregates.ocr);
      }
      if (aggregates.vehicleCapture) {
        update.vehicleCapture = mergeVisitorEvidence(
            data.vehicleCapture, aggregates.vehicleCapture);
      }
      update.status = getVisitorIntakeStatus({...data, ...update});
      if (!outcome.failed) {
        update.ocrRecoveredAt = admin.firestore.FieldValue.serverTimestamp();
      }
    }
    const retryAt = data.imagesPurged ? null :
      nextVisitorOcrRetryAt(images, Date.now());
    update.ocrRetryAt = retryAt ?
      admin.firestore.Timestamp.fromMillis(retryAt) :
      admin.firestore.FieldValue.delete();
    tx.update(ref, update);
    return active && !outcome.failed;
  });
}

exports.visitorIntakeOcrRecovery = onSchedule(
    {
      schedule: "every 1 minutes",
      timeZone: "Asia/Bangkok",
      timeoutSeconds: 180,
      memory: "512MiB",
      maxInstances: 1,
    },
    async () => {
      const now = Date.now();
      const due = await db.collection(VISITOR_INTAKE_COLLECTION)
          .where("ocrRetryAt", "<=", admin.firestore.Timestamp.fromMillis(now))
          .orderBy("ocrRetryAt", "asc")
          .limit(2)
          .get();
      let recovered = 0;
      for (const doc of due.docs) {
        if (await recoverVisitorIntakeOcr(doc.ref, now)) {
          recovered += 1;
        }
      }
      if (due.size) {
        logger.info("Visitor OCR recovery finished", {
          checked: due.size, recovered,
        });
      }
    },
);

exports.visitorIntakeReminder = onSchedule(
    {
      schedule: "every 1 minutes",
      timeZone: "Asia/Bangkok",
      secrets: [LINE_CHANNEL_ACCESS_TOKEN],
    },
    async () => {
      const nowMs = Date.now();
      const healthSnap = await db.doc(SYSTEM_HEALTH_CONFIG_PATH).get();
      const health = healthSnap.exists ? healthSnap.data() || {} : {};
      const lineMessaging = health.lineMessaging || {};
      const healthAgeMs = nowMs -
        Number(lineMessaging.checkedEpoch || 0);
      const lineConfirmedOffline = lineMessaging.status === "offline" &&
        healthAgeMs >= 0 &&
        healthAgeMs <= VISITOR_OUTAGE_HEALTH_MAX_AGE_MS;
      if (lineConfirmedOffline) {
        await maybeSendVisitorLineOutageNotice(nowMs);
        return;
      }

      const quietBefore = admin.firestore.Timestamp.fromMillis(
          nowMs - VISITOR_INTAKE_REMINDER_QUIET_MS);
      const floor = nowMs - VISITOR_INTAKE_REMINDER_FLOOR_MS;
      // Both bounds are range filters on the same field, so this still needs
      // no composite index — but the lower bound matters: without it every
      // run read the 50 most recent quiet records, virtually all of them long
      // -completed visits that the in-code checks below then discarded. Once
      // an intake is older than the floor it can never be reminded, so
      // bounding the query costs nothing and turns ~50 reads per minute into
      // roughly the number of intakes actually in flight. Status and the
      // reminder checks stay in code.
      const snap = await db.collection(VISITOR_INTAKE_COLLECTION)
          .where("updatedAt", "<=", quietBefore)
          .where("updatedAt", ">=", admin.firestore.Timestamp.fromMillis(floor))
          .orderBy("updatedAt", "desc")
          .limit(50)
          .get();

      let sent = 0;
      for (const doc of snap.docs) {
        const data = doc.data() || {};
        if (["complete", "partial"].includes(data.status)) continue;
        const updatedMs = data.updatedAt && data.updatedAt.toMillis ?
          data.updatedAt.toMillis() : 0;
        if (updatedMs < floor) continue;
        const remindedMs = data.reminderSentAt && data.reminderSentAt.toMillis ?
          data.reminderSentAt.toMillis() : 0;
        if (remindedMs >= updatedMs) continue; // already nudged since activity
        const to = data.lineGroupId || data.lineRoomId || data.lineUserId;
        if (!to) continue;
        try {
          await sendLinePush(to, buildVisitorIntakeReply(data));
          await doc.ref.set({
            lastReplyAt: admin.firestore.FieldValue.serverTimestamp(),
            lastReplyText: buildVisitorIntakeReply(data),
            reminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
          }, {merge: true});
          sent += 1;
        } catch (error) {
          logger.warn("Visitor intake reminder failed", {
            logId: doc.id,
            error: error.message,
          });
        }
      }
      if (sent) logger.info("Visitor intake reminders sent", {sent});
    },
);

exports.visitorDailySummary = onSchedule(
    {
      schedule: "5 0 * * *",
      timeZone: "Asia/Bangkok",
      secrets: [LINE_CHANNEL_ACCESS_TOKEN],
      memory: "512MiB",
      timeoutSeconds: 90,
    },
    async () => {
      const report = await runVisitorDailyReport(
          getYesterdayBangkokDate(),
          false,
      );
      logger.info("visitorDailySummary complete", {
        reportDate: report.reportDate,
        total: report.total,
        lineSent: report.lineSent,
      });
    },
);

/**
 * Builds a Firebase Storage download URL from a stored download token.
 * Matches the token pattern used everywhere else in this codebase, which
 * needs no IAM signBlob permission (unlike getSignedUrl in gen2 runtimes).
 * @param {string} storagePath
 * @param {string} downloadToken
 * @param {string} bucketName
 * @return {string}
 */
function visitorIntakeImageUrl(storagePath, downloadToken, bucketName) {
  if (!storagePath || !downloadToken || !bucketName) return "";
  return "https://firebasestorage.googleapis.com/v0/b/" +
    `${bucketName}/o/${encodeURIComponent(storagePath)}` +
    `?alt=media&token=${downloadToken}`;
}

/**
 * Rebuilds aggregate OCR/vehicle fields from the selected image list.
 * @param {Object[]} images
 * @return {Object}
 */
function deriveVisitorAggregatesFromImages(images) {
  let ocr = null;
  let vehicleCapture = null;
  (Array.isArray(images) ? images : []).forEach((image) => {
    const analysis = image.analysis || {};
    if (["document", "document_vehicle"].includes(image.kind) &&
        (analysis.personName || analysis.thaiPersonName ||
          analysis.englishPersonName || analysis.documentNumber)) {
      ocr = {
        personName: analysis.personName || "",
        thaiPersonName: analysis.thaiPersonName || "",
        englishPersonName: analysis.englishPersonName || "",
        documentType: analysis.documentType || "unknown",
        documentNumber: analysis.documentNumber || "",
        maskedDocumentNo: analysis.maskedDocumentNo || "",
        confidence: analysis.confidence || 0,
      };
    }
    if (["vehicle", "document_vehicle"].includes(image.kind) &&
        analysis.vehiclePlate) {
      vehicleCapture = {
        plateText: normalizeVisitorPlate(analysis.vehiclePlate),
        vehicleType: normalizeVisitorVehicleType(analysis.vehicleType),
        confidence: analysis.confidence || 0,
      };
    }
  });
  return {ocr, vehicleCapture};
}

/**
 * Converts one Visitor Intake Firestore document into a safe admin payload.
 * @param {FirebaseFirestore.QueryDocumentSnapshot} docSnap
 * @return {Promise<Object>}
 */
async function mapVisitorIntakeDoc(docSnap) {
  const data = docSnap.data() || {};
  const images = Array.isArray(data.images) ? data.images : [];
  const bucketName = admin.storage().bucket().name;
  const safeImages = await Promise.all(images.map(async (image) => ({
    kind: image.kind || "other",
    analysisPending: image.analysisPending === true,
    analysisFailed: image.analysisFailed === true,
    analysisRetryable: image.analysisRetryable !== false,
    messageId: image.messageId || "",
    contentType: image.contentType || "",
    sizeBytes: image.sizeBytes || 0,
    imageUrl: image.storagePath && !data.imagesPurged ?
      visitorIntakeImageUrl(image.storagePath, image.downloadToken,
          bucketName) : "",
    expiresAt: image.expiresAt || null,
    purgedAt: image.purgedAt || null,
    analysis: image.analysis ? {
      imageKind: image.analysis.imageKind || "",
      documentType: image.analysis.documentType || "",
      personName: image.analysis.personName || "",
      thaiPersonName: image.analysis.thaiPersonName || "",
      englishPersonName: image.analysis.englishPersonName || "",
      maskedDocumentNo: image.analysis.maskedDocumentNo || "",
      documentNumber: image.analysis.documentNumber || "",
      vehiclePlate: image.analysis.vehiclePlate || "",
      vehicleType: image.analysis.vehicleType || "",
      confidence: image.analysis.confidence || 0,
    } : null,
  })));

  return {
    id: docSnap.id,
    visitDate: data.visitDate || "",
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
    houseNo: data.houseNo || "",
    houseNos: Array.isArray(data.houseNos) ? data.houseNos : [],
    purposeText: data.purposeText || "",
    purposeCategory: data.purposeCategory || "unknown",
    status: data.status || "unknown",
    lprLinked: Boolean(data.lprLinked),
    imagesPurged: Boolean(data.imagesPurged),
    ocrRetryAt: data.ocrRetryAt || null,
    ocrRecoveredAt: data.ocrRecoveredAt || null,
    ocr: data.ocr || null,
    vehicleCapture: data.vehicleCapture || null,
    rawTexts: Array.isArray(data.rawTexts) ? data.rawTexts : [],
    warnings: buildVisitorWarnings(data),
    warningCodes: getVisitorWarningCodes(data),
    images: safeImages,
  };
}

/**
 * Converts Firestore-ish values into an ISO string when possible.
 * @param {*} value
 * @return {string}
 */
function toIsoString(value) {
  if (!value) return "";
  if (typeof value.toDate === "function") {
    try {
      return value.toDate().toISOString();
    } catch (_) {
      return "";
    }
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value).toISOString() : "";
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
  }
  return "";
}

/**
 * Reads a collection's count and date range with minimal document reads.
 * @param {FirebaseFirestore.CollectionReference} collectionRef
 * @param {string} dateField
 * @return {Promise<{count: number, oldestAt: string, newestAt: string}>}
 */
async function summarizeCollectionDates(collectionRef, dateField) {
  const [countSnap, oldestSnap, newestSnap] = await Promise.all([
    collectionRef.count().get(),
    collectionRef.orderBy(dateField, "asc").limit(1).get(),
    collectionRef.orderBy(dateField, "desc").limit(1).get(),
  ]);
  const count = Number(countSnap.data().count || 0);
  const oldestAt = oldestSnap.empty ? "" :
    toIsoString(oldestSnap.docs[0].data()[dateField]);
  const newestAt = newestSnap.empty ? "" :
    toIsoString(newestSnap.docs[0].data()[dateField]);
  return {count, oldestAt, newestAt};
}

/**
 * Summarizes the files stored under one Storage prefix.
 * @param {string} prefix
 * @return {Promise<{fileCount: number, totalBytes: number}>}
 */
async function summarizeStoragePrefix(prefix) {
  const bucket = admin.storage().bucket();
  const [files] = await bucket.getFiles({prefix});
  let fileCount = 0;
  let totalBytes = 0;
  for (const file of files) {
    fileCount += 1;
    const size = Number(file.metadata && file.metadata.size) || 0;
    totalBytes += size;
  }
  return {fileCount, totalBytes};
}

/**
 * Builds one storage summary row for a Firestore collection and file prefix.
 * @param {Object} config
 * @param {string} config.label
 * @param {string} config.collectionName
 * @param {string} config.dateField
 * @param {string} config.storagePrefix
 * @return {Promise<Object>}
 */
async function buildStorageStatsRow(config) {
  const collectionRef = db.collection(config.collectionName);
  const [collectionStats, storageStats] = await Promise.all([
    summarizeCollectionDates(collectionRef, config.dateField),
    summarizeStoragePrefix(config.storagePrefix),
  ]);
  return {
    label: config.label,
    collectionName: config.collectionName,
    dateField: config.dateField,
    storagePrefix: config.storagePrefix,
    docCount: collectionStats.count,
    fileCount: storageStats.fileCount,
    totalBytes: storageStats.totalBytes,
    oldestAt: collectionStats.oldestAt,
    newestAt: collectionStats.newestAt,
  };
}

exports.visitorIntakeAdmin = onRequest(
    {
      memory: "512MiB",
      timeoutSeconds: 60,
      secrets: [LINE_CHANNEL_ACCESS_TOKEN],
    },
    async (req, res) => {
      setCorsHeaders(req, res);
      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }
      if (req.method !== "POST") {
        res.status(405).json({ok: false, error: "Method Not Allowed"});
        return;
      }

      try {
        const body = req.body || {};
        const action = String(body.action || "list");

        if (action === "myVisitors") {
          // Resident-facing "My Visitor" digital footprint for
          // /myvisitor/ — any resident with a valid PIN sees only THEIR
          // OWN house's visitor-intake history (delivery/technician/guest
          // entries with ID + vehicle photos). Always scopes to the house
          // that just passed PIN verification; never trusts any other
          // house field from the client. Strips the raw OCR document
          // number (keeps only the pre-masked version) even though the
          // committee view below returns it — a resident viewing their
          // own log has no audit justification for the unmasked ID
          // number. Uses .orderBy() (unlike the committee "list" action's
          // client-side sort) because this query has no date bound over
          // the 365-day retention window, so an unordered .limit() could
          // silently return an arbitrary, not-necessarily-recent subset.
          const houseNo = normalizeHouseNo(body.houseNo);
          const pin = String(body.pin || "");
          await verifyResidentPinInternal(houseNo, pin);
          logFeatureUsage("myvisitor", houseNo);
          const limit = Math.min(Math.max(Number(body.limit || 150), 1),
              300);
          const snap = await db.collection(VISITOR_INTAKE_COLLECTION)
              .where("houseNo", "==", houseNo)
              .orderBy("createdAt", "desc")
              .limit(limit)
              .get();
          const records = await Promise.all(snap.docs.map(mapVisitorIntakeDoc));
          records.forEach((r) => {
            if (r.ocr) delete r.ocr.documentNumber;
            (r.images || []).forEach((img) => {
              if (img.analysis) delete img.analysis.documentNumber;
            });
          });
          // Cross-reference the visitor's photographed plate against the
          // brand/color profile already built from gate-camera captures of
          // that same plate (the same lookup buildDailyTrafficReport uses
          // for the LINE daily/night traffic cards), so a car's make/model/
          // color can show up here even though visitor-intake's own photo
          // analysis only extracts plate + vehicleType, not brand/color.
          const lookupRows = records.map((r) => ({
            plate: (r.vehicleCapture && r.vehicleCapture.plateText) ?
              stripThaiProvinceForLookup(r.vehicleCapture.plateText) : "",
          }));
          const enrichedRows = await attachVehicleProfiles(lookupRows);
          records.forEach((r, i) => {
            if (enrichedRows[i] && enrichedRows[i].vehicleVision) {
              r.vehicleVision = enrichedRows[i].vehicleVision;
            }
          });
          res.status(200).json({
            ok: true,
            houseNo,
            records,
            hasMore: snap.docs.length === limit,
          });
          return;
        }

        await verifyAdminResidentAccess(body, "admin.audit");

        if (action === "delete") {
          const rawIds = Array.isArray(body.recordIds) ? body.recordIds :
            (body.recordId ? [body.recordId] : []);
          const recordIds = rawIds
              .map((x) => String(x || "").trim())
              .filter(Boolean)
              .slice(0, 100);
          if (!recordIds.length) {
            res.status(400).json({ok: false, error: "recordId required"});
            return;
          }
          const bucket = admin.storage().bucket();
          const deleted = [];
          for (const recordId of recordIds) {
            const docRef = db.collection(VISITOR_INTAKE_COLLECTION)
                .doc(recordId);
            const docSnap = await docRef.get();
            if (docSnap.exists) {
              const paths = (Array.isArray(docSnap.data().images) ?
                docSnap.data().images : [])
                  .map((im) => im.storagePath)
                  .filter(Boolean);
              await Promise.all(paths.map((p) =>
                bucket.file(p).delete({ignoreNotFound: true}),
              ));
              await docRef.delete();
            }
            deleted.push(recordId);
          }
          logger.info("Visitor intake records deleted",
              {count: deleted.length});
          res.status(200).json({ok: true, deleted});
          return;
        }

        if (action === "update") {
          const recordId = String(body.recordId || "").trim();
          if (!recordId) {
            res.status(400).json({ok: false, error: "recordId required"});
            return;
          }
          const patch = body.record || {};
          const docRef = db.collection(VISITOR_INTAKE_COLLECTION)
              .doc(recordId);
          const docSnap = await docRef.get();
          if (!docSnap.exists) {
            res.status(404).json({ok: false, error: "Record not found"});
            return;
          }
          const cur = docSnap.data() || {};
          const ocr = {...(cur.ocr || {})};
          const vehicleCapture = {...(cur.vehicleCapture || {})};
          const update = {
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            manualEditedAt: admin.firestore.FieldValue.serverTimestamp(),
            manualEditedBy: normalizeHouseNo(body.houseNo || ""),
          };

          if (Object.prototype.hasOwnProperty.call(patch, "houseNo")) {
            update.houseNo = normalizePattraHouseNo(patch.houseNo);
          }
          if (Object.prototype.hasOwnProperty.call(patch, "purposeText") ||
              Object.prototype.hasOwnProperty.call(patch, "purposeCategory")) {
            const purposeText = cleanVisitorPurposeText(patch.purposeText);
            update.purposeText = purposeText;
            const category = String(patch.purposeCategory || "").trim();
            update.purposeCategory = VISITOR_CATEGORY_LABELS[category] ?
              category : mapVisitorPurposeCategory(purposeText);
          }
          if (Object.prototype.hasOwnProperty.call(patch, "personName")) {
            const personName = normalizeVisitorName(patch.personName);
            ocr.personName = personName;
            if (hasThaiText(personName)) ocr.thaiPersonName = personName;
            else ocr.englishPersonName = personName;
            update.ocr = ocr;
          }
          if (Object.prototype.hasOwnProperty.call(patch, "documentNumber")) {
            const documentNumber = normalizeDocumentNumber(
                patch.documentNumber,
            );
            ocr.documentNumber = documentNumber;
            ocr.maskedDocumentNo = maskDocumentNumber(documentNumber);
            update.ocr = ocr;
          }
          if (Object.prototype.hasOwnProperty.call(patch, "plateText")) {
            vehicleCapture.plateText = normalizeVisitorPlate(patch.plateText);
            update.vehicleCapture = vehicleCapture;
          }
          if (Object.prototype.hasOwnProperty.call(patch, "vehicleType")) {
            vehicleCapture.vehicleType = normalizeVisitorVehicleType(
                patch.vehicleType,
            );
            update.vehicleCapture = vehicleCapture;
          }

          const nextData = {...cur, ...update};
          delete nextData.updatedAt;
          delete nextData.manualEditedAt;
          update.status = getVisitorIntakeStatus(nextData);
          await docRef.update(update);
          const fresh = await docRef.get();
          res.status(200).json({
            ok: true,
            record: await mapVisitorIntakeDoc(fresh),
          });
          return;
        }

        if (action === "pushRecordNote") {
          const recordId = String(body.recordId || "").trim();
          if (!recordId) {
            res.status(400).json({ok: false, error: "recordId required"});
            return;
          }
          const docRef = db.collection(VISITOR_INTAKE_COLLECTION)
              .doc(recordId);
          const docSnap = await docRef.get();
          if (!docSnap.exists) {
            res.status(404).json({ok: false, error: "Record not found"});
            return;
          }
          const data = docSnap.data() || {};
          const targetId = data.lineGroupId || data.lineRoomId ||
            data.lineUserId || "";
          if (!targetId) {
            res.status(400).json({ok: false, error: "LINE target missing"});
            return;
          }
          const plate = normalizeVisitorPlate(
              data.vehicleCapture && data.vehicleCapture.plateText,
          );
          const defaultText = [
            "✅ เคสนี้บันทึกครบถ้วนแล้วครับ",
            "",
            `🏠 บ้าน : ${data.houseNo || "-"}`,
            `✏️ เหตุผล : ${visitorReplyPurposeLabel(
                data.purposeCategory,
                data.purposeText,
            )}`,
            plate ? `🚗 ทะเบียน : ${plate}` : "",
          ].filter(Boolean).join("\n");
          const text = String(body.messageText || defaultText).trim();
          if (!text) {
            res.status(400).json({ok: false, error: "messageText required"});
            return;
          }
          await sendLinePush(targetId, text);
          await docRef.update({
            lastManualLineNote: text.slice(0, 2000),
            lastManualLineNoteAt: admin.firestore.FieldValue.serverTimestamp(),
            lastManualLineNoteBy: normalizeHouseNo(body.houseNo || ""),
          });
          res.status(200).json({ok: true, targetId, text});
          return;
        }

        if (action === "keepImageMessageIds") {
          const recordId = String(body.recordId || "").trim();
          const keepIds = new Set((Array.isArray(body.messageIds) ?
            body.messageIds : [])
              .map((id) => String(id || "").trim())
              .filter(Boolean));
          if (!recordId || !keepIds.size) {
            res.status(400).json({
              ok: false,
              error: "recordId and messageIds required",
            });
            return;
          }
          const docRef = db.collection(VISITOR_INTAKE_COLLECTION)
              .doc(recordId);
          const docSnap = await docRef.get();
          if (!docSnap.exists) {
            res.status(404).json({ok: false, error: "Record not found"});
            return;
          }
          const cur = docSnap.data() || {};
          const oldImages = Array.isArray(cur.images) ? cur.images : [];
          const images = oldImages.filter((image) =>
            keepIds.has(String(image.messageId || "")));
          const aggregates = deriveVisitorAggregatesFromImages(images);
          const nextData = {...cur, images, ...aggregates};
          const update = {
            images,
            ocr: aggregates.ocr,
            vehicleCapture: aggregates.vehicleCapture,
            status: getVisitorIntakeStatus(nextData),
            imageCleanedAt: admin.firestore.FieldValue.serverTimestamp(),
            imageCleanedBy: normalizeHouseNo(body.houseNo || ""),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          await docRef.update(update);
          const fresh = await docRef.get();
          res.status(200).json({
            ok: true,
            removed: oldImages.length - images.length,
            record: await mapVisitorIntakeDoc(fresh),
          });
          return;
        }

        if (action === "splitRecord") {
          const recordId = String(body.recordId || "").trim();
          const moveImageIds = new Set((Array.isArray(body.moveImageIds) ?
            body.moveImageIds : [])
              .map((id) => String(id || "").trim())
              .filter(Boolean));
          const moveRawTextIds = new Set((Array.isArray(body.moveRawTextIds) ?
            body.moveRawTextIds : [])
              .map((id) => String(id || "").trim())
              .filter(Boolean));
          const newRecordPatch = body.newRecord || {};
          const sourcePatch = body.sourceRecord || {};
          if (!recordId || !moveImageIds.size) {
            res.status(400).json({
              ok: false,
              error: "recordId and moveImageIds required",
            });
            return;
          }

          const sourceRef = db.collection(VISITOR_INTAKE_COLLECTION)
              .doc(recordId);
          const newRef = db.collection(VISITOR_INTAKE_COLLECTION).doc();
          await db.runTransaction(async (tx) => {
            const sourceSnap = await tx.get(sourceRef);
            if (!sourceSnap.exists) {
              throw Object.assign(new Error("Record not found"), {status: 404});
            }
            const cur = sourceSnap.data() || {};
            const oldImages = Array.isArray(cur.images) ? cur.images : [];
            const oldRawTexts = Array.isArray(cur.rawTexts) ?
              cur.rawTexts : [];
            const movedImages = oldImages.filter((image) =>
              moveImageIds.has(String(image.messageId || "")));
            if (!movedImages.length) {
              throw Object.assign(new Error("No matching images to split"), {
                status: 400,
              });
            }
            const keptImages = oldImages.filter((image) =>
              !moveImageIds.has(String(image.messageId || "")));
            const movedRawTexts = moveRawTextIds.size ?
              oldRawTexts.filter((item) =>
                moveRawTextIds.has(String(item.messageId || ""))) : [];
            const keptRawTexts = moveRawTextIds.size ?
              oldRawTexts.filter((item) =>
                !moveRawTextIds.has(String(item.messageId || ""))) :
              oldRawTexts;

            const sourceAggregates = deriveVisitorAggregatesFromImages(
                keptImages,
            );
            const movedAggregates = deriveVisitorAggregatesFromImages(
                movedImages,
            );
            const nowTs = admin.firestore.FieldValue.serverTimestamp();

            const sourceUpdate = {
              images: keptImages,
              rawTexts: keptRawTexts,
              ocr: sourceAggregates.ocr,
              vehicleCapture: sourceAggregates.vehicleCapture,
              updatedAt: nowTs,
              imageCleanedAt: nowTs,
              imageCleanedBy: normalizeHouseNo(body.houseNo || ""),
            };
            if (Object.prototype.hasOwnProperty.call(sourcePatch, "houseNo")) {
              sourceUpdate.houseNo = normalizePattraHouseNo(
                  sourcePatch.houseNo,
              );
            }
            if (Object.prototype.hasOwnProperty.call(
                sourcePatch, "purposeText")) {
              sourceUpdate.purposeText = cleanVisitorPurposeText(
                  sourcePatch.purposeText,
              );
            }
            if (Object.prototype.hasOwnProperty.call(
                sourcePatch, "purposeCategory")) {
              const category = String(sourcePatch.purposeCategory || "").trim();
              sourceUpdate.purposeCategory = VISITOR_CATEGORY_LABELS[category] ?
                category : mapVisitorPurposeCategory(sourceUpdate.purposeText);
            }
            const nextSource = {...cur, ...sourceUpdate};
            sourceUpdate.status = getVisitorIntakeStatus(nextSource);

            const newData = {
              visitDate: cur.visitDate || getTodayBangkokDate(),
              createdAt: movedRawTexts[0] && movedRawTexts[0].createdAt ?
                movedRawTexts[0].createdAt : cur.createdAt || nowTs,
              updatedAt: nowTs,
              lineGroupId: cur.lineGroupId || null,
              lineRoomId: cur.lineRoomId || null,
              lineUserId: cur.lineUserId || null,
              sourceType: cur.sourceType || null,
              lprLinked: false,
              imagesPurged: Boolean(cur.imagesPurged),
              imageRetentionDays: cur.imageRetentionDays ||
                VISITOR_INTAKE_IMAGE_RETENTION_DAYS,
              metadataRetentionDays: cur.metadataRetentionDays ||
                VISITOR_INTAKE_METADATA_RETENTION_DAYS,
              metadataExpiresAt: cur.metadataExpiresAt || null,
              rawTexts: movedRawTexts,
              images: movedImages,
              houseNo: normalizePattraHouseNo(newRecordPatch.houseNo),
              purposeText: cleanVisitorPurposeText(
                  newRecordPatch.purposeText,
              ),
              purposeCategory: "",
              ocr: movedAggregates.ocr,
              vehicleCapture: movedAggregates.vehicleCapture,
              splitFromRecordId: recordId,
              splitBy: normalizeHouseNo(body.houseNo || ""),
              splitAt: nowTs,
            };
            const newCategory = String(
                newRecordPatch.purposeCategory || "",
            ).trim();
            newData.purposeCategory = VISITOR_CATEGORY_LABELS[newCategory] ?
              newCategory : mapVisitorPurposeCategory(newData.purposeText);
            newData.status = getVisitorIntakeStatus(newData);

            tx.update(sourceRef, sourceUpdate);
            tx.set(newRef, newData);
          });

          const [sourceFresh, newFresh] = await Promise.all([
            sourceRef.get(),
            newRef.get(),
          ]);
          res.status(200).json({
            ok: true,
            sourceRecord: await mapVisitorIntakeDoc(sourceFresh),
            newRecord: await mapVisitorIntakeDoc(newFresh),
          });
          return;
        }

        if (action === "dailyReport") {
          const report = await runVisitorDailyReport(
              body.reportDate || getYesterdayBangkokDate(),
              body.sendLine === true,
              String(body.targetId || "").trim(),
          );
          res.status(200).json({ok: true, report});
          return;
        }

        if (action !== "list") {
          res.status(400).json({ok: false, error: "Invalid action"});
          return;
        }
        const visitDate = String(body.visitDate || getTodayBangkokDate())
            .slice(0, 10);
        const snap = await db.collection(VISITOR_INTAKE_COLLECTION)
            .where("visitDate", "==", visitDate)
            .limit(Math.min(Math.max(Number(body.limit || 200), 1), 500))
            .get();
        const docs = snap.docs.sort((a, b) => {
          const av = a.data().createdAt && a.data().createdAt.toMillis ?
            a.data().createdAt.toMillis() : 0;
          const bv = b.data().createdAt && b.data().createdAt.toMillis ?
            b.data().createdAt.toMillis() : 0;
          return bv - av;
        });
        const records = await Promise.all(docs.map(mapVisitorIntakeDoc));
        const stats = {
          total: records.length,
          complete: records.filter((r) =>
            ["complete", "partial"].includes(r.status)).length,
          partial: records.filter((r) => r.status === "partial").length,
          pending: records.filter((r) =>
            !["complete", "partial"].includes(r.status)).length,
          withVehiclePlate: records.filter((r) =>
            r.vehicleCapture && r.vehicleCapture.plateText,
          ).length,
        };
        res.status(200).json({ok: true, visitDate, stats, records});
      } catch (error) {
        logger.error("visitorIntakeAdmin failed", error);
        res.status(error.status || 500).json({
          ok: false,
          error: error.message,
        });
      }
    },
);
// ===== END VISITOR INTAKE ==================================================
// (exports.lineWebhook above is shared infrastructure, not visitor-only.)

exports.residentSheetSync = onRequest(async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  if (req.method === "GET") {
    try {
      const encodedRange = encodeURIComponent(RESIDENT_SHEET_RANGE);
      const valuesUrl = "https://sheets.googleapis.com/v4/spreadsheets/" +
        `${RESIDENT_SHEET_ID}/values/${encodedRange}`;
      const sheetData = await callSheetsApi(valuesUrl);
      const rows = sheetData.values || [];
      const data = rows
          .slice(1)
          .filter((row) => row.some(Boolean))
          .map((row) => Object.fromEntries(
              RESIDENT_HEADERS.map((header, index) => [
                header,
                row[index] || "",
              ]),
          ));

      res.status(200).json({ok: true, data});
    } catch (error) {
      logger.error("residentSheetSync GET failed", error);
      res.status(500).json({ok: false, error: error.message});
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ok: false, error: "Method Not Allowed"});
    return;
  }

  try {
    const body = req.body || {};
    await verifyAdminResidentAccess(body, "admin.residents");

    const record = body.record || {};
    if (!record.house_no) {
      res.status(400).json({ok: false, error: "Missing house_no"});
      return;
    }

    const encodedRange = encodeURIComponent(RESIDENT_SHEET_RANGE);
    const baseUrl = "https://sheets.googleapis.com/v4/spreadsheets";
    const valuesUrl = `${baseUrl}/${RESIDENT_SHEET_ID}/values/${encodedRange}`;
    const sheetData = await callSheetsApi(valuesUrl);
    const rows = sheetData.values || [];
    const rowValues = buildResidentRow(record);
    const houseNo = rowValues[0];
    let targetRow = -1;

    for (let index = 1; index < rows.length; index++) {
      if ((rows[index][0] || "") === houseNo) {
        targetRow = index + 1;
        break;
      }
    }

    if (targetRow === -1) {
      const appendUrl = `${valuesUrl}:append?` +
        "valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS";
      const result = await callSheetsApi(appendUrl, {
        method: "POST",
        body: JSON.stringify({values: [rowValues]}),
      });
      res.status(200).json({ok: true, mode: "append", result});
      return;
    }

    const updateRange = encodeURIComponent(
        `Residents!A${targetRow}:G${targetRow}`,
    );
    const updateUrl = `${baseUrl}/${RESIDENT_SHEET_ID}/values/` +
      `${updateRange}?valueInputOption=USER_ENTERED`;
    const result = await callSheetsApi(updateUrl, {
      method: "PUT",
      body: JSON.stringify({values: [rowValues]}),
    });

    res.status(200).json({ok: true, mode: "update", row: targetRow, result});
  } catch (error) {
    logger.error("residentSheetSync failed", error);
    res.status(500).json({ok: false, error: error.message});
  }
});

/**
 * Verifies a resident PIN and returns the PIN doc data.
 * Throws with a .status property on failure.
 * @param {string} houseNo
 * @param {string} pin
 * @return {Promise<Object>}
 */
async function verifyResidentPinInternal(houseNo, pin) {
  // Reject missing credentials up front with a clean 401 — otherwise an
  // empty houseNo reaches Firestore doc("") and surfaces as a 500.
  if (!houseNo || !pin) {
    const err = new Error("Missing credentials");
    err.status = 401;
    throw err;
  }
  const docRef = db
      .collection(RESIDENT_PIN_COLLECTION)
      .doc(residentPinDocId(houseNo));
  const doc = await docRef.get();
  if (!doc.exists) {
    const err = new Error("PIN not configured");
    err.status = 404;
    throw err;
  }
  const data = doc.data() || {};
  const cleanPin = normalizeResidentPin(pin);
  const pinHash = hashResidentPin(cleanPin, data.salt || "");
  if (pinHash !== data.pinHash) {
    await docRef.set(
        {lastFailedAt: admin.firestore.FieldValue.serverTimestamp()},
        {merge: true},
    );
    const err = new Error("Invalid PIN");
    err.status = 401;
    throw err;
  }
  return data;
}

/**
 * Writes a single audit log entry (fire-and-forget, never blocks the caller).
 * @param {string} action
 * @param {string} houseNo
 * @param {Object} extra
 * @param {boolean} success
 */
function writeAuditLog(action, houseNo, extra = {}, success = true) {
  db.collection(AUDIT_LOG_COLLECTION).add({
    action,
    houseNo,
    success,
    ts: admin.firestore.FieldValue.serverTimestamp(),
    ...extra,
  }).catch((err) => logger.warn("audit_log write failed", err));
}

// Every feature slug logFeatureUsage() will accept from client-supplied
// input (getResidentData's optional `feature`, residentPinAuth's
// "pingFeatureView"). Calls that pass a hardcoded literal (myVisitors,
// visitorBoard, myReceipts, myIssues) don't need to go through this list.
const FEATURE_USAGE_FEATURES = new Set([
  "data", "vehicle", "myvisitor", "visitorboard", "myreceipt", "myparking",
  "parking", "report",
]);

/**
 * Records that a house viewed a resident-facing feature (fire-and-forget).
 * One doc per house/feature/Bangkok-day, merged in place — unlike
 * writeAuditLog this never grows past one row per house per feature per
 * day, so a resident refreshing a page 50 times doesn't flood the log.
 * Powers the admin "การใช้งานบ้าน" (House Usage) breakdown, kept separate
 * from the Activity Log tab (writeAuditLog), which stays reserved for
 * actual writes/edits (resident_update, pin_change, submit_request, ...).
 * @param {string} feature short slug, e.g. "myvisitor", "myparking"
 * @param {string} houseNo
 */
function logFeatureUsage(feature, houseNo) {
  const date = getTodayBangkokDate();
  const docId = `${residentPinDocId(houseNo)}__${feature}__${date}`;
  db.collection(FEATURE_USAGE_COLLECTION).doc(docId).set({
    houseNo,
    feature,
    date,
    count: admin.firestore.FieldValue.increment(1),
    lastSeen: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true}).catch((err) =>
    logger.warn("feature_usage write failed", err));
}

exports.residentPinAuth = onRequest(
    {secrets: [LPR_ADMIN_PASSWORD]},
    async (req, res) => {
      setCorsHeaders(req, res);

      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }

      if (req.method !== "POST") {
        res.status(405).json({ok: false, error: "Method Not Allowed"});
        return;
      }

      try {
        const body = req.body || {};
        const action = String(body.action || "verify").trim();
        const houseNo = normalizeHouseNo(body.houseNo);

        if (action === "adminAuditLogs") {
          await verifyAdminResidentAccess(body, "admin.audit");
          const limit = Math.min(Math.max(Number(body.limit || 80), 1), 200);
          const snap = await db.collection(AUDIT_LOG_COLLECTION)
              .orderBy("ts", "desc")
              .limit(limit)
              .get();
          res.status(200).json({
            ok: true,
            logs: snap.docs.map((doc) => {
              const log = doc.data() || {};
              return {
                id: doc.id,
                ...log,
                timestamp: log.ts && log.ts.toDate ?
              log.ts.toDate().toISOString() : log.ts || null,
              };
            }),
          });
          return;
        }

        if (action === "adminFeatureUsage") {
          // Coarse "which house used what" — backs the House Usage tab's
          // per-feature breakdown. Separate from adminAuditLogs: this reads
          // logFeatureUsage's one-row-per-house-per-feature-per-day docs,
          // so it stays small even when residents refresh a page constantly.
          await verifyAdminResidentAccess(body, "admin.audit");
          const limit = Math.min(Math.max(Number(body.limit || 3000), 1),
              5000);
          const snap = await db.collection(FEATURE_USAGE_COLLECTION)
              .orderBy("date", "desc")
              .limit(limit)
              .get();
          res.status(200).json({
            ok: true,
            usage: snap.docs.map((doc) => {
              const u = doc.data() || {};
              return {
                houseNo: u.houseNo || "",
                feature: u.feature || "",
                date: u.date || "",
                count: u.count || 0,
                lastSeen: u.lastSeen && u.lastSeen.toDate ?
                  u.lastSeen.toDate().toISOString() : u.lastSeen || null,
              };
            }),
          });
          return;
        }

        if (action === "adminStorageStats") {
          await verifyAdminResidentAccess(body, "admin.audit");
          const [lprLog, visitorIntake] = await Promise.all([
            buildStorageStatsRow({
              label: "LPR log",
              collectionName: LPR_TRAFFIC_EVENTS_COLLECTION,
              dateField: "capturedAtEpoch",
              storagePrefix: `${LPR_CAPTURES_PREFIX}/`,
            }),
            buildStorageStatsRow({
              label: "Visitor intake",
              collectionName: VISITOR_INTAKE_COLLECTION,
              dateField: "createdAt",
              storagePrefix: "visitor-intake/",
            }),
          ]);

          const totals = {
            docCount: lprLog.docCount + visitorIntake.docCount,
            fileCount: lprLog.fileCount + visitorIntake.fileCount,
            totalBytes: lprLog.totalBytes + visitorIntake.totalBytes,
          };

          res.status(200).json({
            ok: true,
            generatedAt: new Date().toISOString(),
            totals,
            features: {
              lprLog,
              visitorIntake,
            },
          });
          return;
        }

        if (action === "adminResidents") {
          await verifyAdminResidentAccess(body, "admin.residents");
          const [snap, pinSnap] = await Promise.all([
            db.collection(RESIDENTS_COLLECTION).get(),
            db.collection(RESIDENT_PIN_COLLECTION).get(),
          ]);
          const pinByHouse = new Map();
          pinSnap.docs.forEach((pinDoc) => {
            const pinData = pinDoc.data() || {};
            const pinHouseNo = normalizeHouseNo(
                pinData.houseNo || pinData.house_no,
            );
            if (pinHouseNo) pinByHouse.set(pinHouseNo, pinData);
          });
          const residents = snap.docs.map((residentDoc) => {
            const r = residentDoc.data() || {};
            const house = normalizeHouseNo(r.house_no || r.houseNo || "");
            const cars = normalizePlateArray(r.cars || []);
            const motorcycles = normalizePlateArray(r.motorcycles || []);
            const carQuota = getCarQuota(house, r);
            const pin = pinByHouse.get(house) || {};
            const lastLoginAt = pin.lastLoginAt && pin.lastLoginAt.toDate ?
          pin.lastLoginAt.toDate().toISOString() : "";
            const lastActivityAt =
              pin.lastActivityAt && pin.lastActivityAt.toDate ?
                pin.lastActivityAt.toDate().toISOString() : "";
            const firstActivityAt =
              pin.firstActivityAt && pin.firstActivityAt.toDate ?
                pin.firstActivityAt.toDate().toISOString() : "";
            return {
              house_no: house,
              houseNo: house,
              name: r.name || "",
              email: r.email || "",
              phone: r.phone || "",
              deed_no: r.deed_no || "",
              deedNo: r.deed_no || "",
              zone: r.zone || "",
              plot: r.plot || "",
              carPlates: cars,
              motorcyclePlates: motorcycles,
              cars,
              motorcycles,
              carCount: cars.length,
              motorcycleCount: motorcycles.length,
              car_quota: parseCarQuota(r.car_quota),
              carQuota,
              residents: Number(r.residents || r.occupants || 0),
              pets: Array.isArray(r.pets) ? r.pets.join(", ") : r.pets || "",
              lineId: r.lineId || r.line_id || "",
              note: r.note || "",
              pinSet: Boolean(pin.pinHash),
              lastLogin: lastLoginAt,
              lastActivity: lastActivityAt,
              firstActivity: firstActivityAt,
              activityCount: Number(pin.activityCount || 0),
              last_updated: r.last_updated || "",
              lastUpdated: r.last_updated || "",
              lpr_sync_pending: !!r.lpr_sync_pending,
              lprSyncPending: !!r.lpr_sync_pending,
              lpr_last_sync: r.lpr_last_sync || "",
              lprLastSync: r.lpr_last_sync || "",
            };
          }).filter((r) => r.house_no);
          residents.sort((a, b) => {
            const an = Number(a.house_no.split("/")[1] || "0");
            const bn = Number(b.house_no.split("/")[1] || "0");
            return an - bn;
          });
          res.status(200).json({ok: true, residents});
          return;
        }

        if (action === "pingFeatureView") {
          // Generic, low-stakes "this house opened <feature>" ping for pages
          // with no dedicated resident-facing read action of their own (the
          // /parking/ slot map is public Firestore, no Cloud Function call
          // to piggyback on) or that share getResidentData across several
          // different pages and need to say which one. Feature is
          // allowlisted so a bad client can't write junk into the usage log.
          const feature = String(body.feature || "");
          if (!FEATURE_USAGE_FEATURES.has(feature)) {
            res.status(400).json({ok: false, error: "Unknown feature"});
            return;
          }
          await verifyResidentPinInternal(houseNo, String(body.pin || ""));
          logFeatureUsage(feature, houseNo);
          res.status(200).json({ok: true});
          return;
        }

        if (!houseNo) {
          res.status(400).json({ok: false, error: "Missing houseNo"});
          return;
        }

        const docRef = db
            .collection(RESIDENT_PIN_COLLECTION)
            .doc(residentPinDocId(houseNo));
        const doc = await docRef.get();
        if (!doc.exists) {
          res.status(404).json({ok: false, error: "PIN not configured"});
          return;
        }

        const data = doc.data() || {};

        if (action === "adminUpdateResidentData") {
          await verifyAdminResidentAccess(body, "admin.residents");

          const record = body.record || body;
          const targetHouseNo = normalizeHouseNo(
              record.house_no || record.houseNo ||
          body.targetHouseNo || body.houseNo,
          );
          const residentDocRef = db
              .collection(RESIDENTS_COLLECTION)
              .doc(residentPinDocId(targetHouseNo || houseNo));
          const residentSnap = await residentDocRef.get();
          const oldData = residentSnap.exists ? residentSnap.data() || {} : {};
          const patch = {};

          [
            "name", "email", "phone", "deed_no", "zone", "plot",
            "lineId", "line_id", "residents", "occupants", "pets", "note",
          ].forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(record, key)) {
              patch[key] = Array.isArray(record[key]) ?
            record[key] : String(record[key] || "").trim();
            }
          });
          if (Object.prototype.hasOwnProperty.call(record, "car_quota")) {
            const quota = parseCarQuota(record.car_quota);
            if (quota) {
              patch.car_quota = quota;
            } else {
              patch.car_quota = admin.firestore.FieldValue.delete();
            }
          }
          if (Object.prototype.hasOwnProperty.call(patch, "line_id") &&
        !Object.prototype.hasOwnProperty.call(patch, "lineId")) {
            patch.lineId = patch.line_id;
            delete patch.line_id;
          }
          patch.house_no =
            normalizeHouseNo(record.house_no || record.houseNo) ||
            oldData.house_no ||
            targetHouseNo ||
            houseNo;

          const touchesCars =
        Object.prototype.hasOwnProperty.call(body, "record") &&
        Object.prototype.hasOwnProperty.call(record, "cars") &&
        Array.isArray(record.cars);
          const touchesMotorcycles =
        Object.prototype.hasOwnProperty.call(body, "record") &&
        Object.prototype.hasOwnProperty.call(record, "motorcycles") &&
        Array.isArray(record.motorcycles);
          if (touchesCars) {
            patch.cars = normalizePlateArray(record.cars || []);
          }
          if (touchesMotorcycles) {
            patch.motorcycles = normalizePlateArray(record.motorcycles || []);
          }

          patch.last_updated = new Date().toISOString();
          patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
          patch.updatedBy = "admin";
          patch.updatedByIp = req.ip || "";

          await residentDocRef.set(patch, {merge: true});

          let lprSync = null;
          if (touchesCars) {
            const allResidentsSnap = await db
                .collection(RESIDENTS_COLLECTION)
                .get();
            const allCars = [];
            allResidentsSnap.docs.forEach((residentDoc) => {
              const item = residentDoc.data() || {};
              const itemHouseNo = normalizeHouseNo(
                  item.house_no || item.houseNo,
              );
              if (itemHouseNo === patch.house_no) {
                normalizePlateArray(patch.cars || []).forEach((plate) =>
                  allCars.push(plate),
                );
                return;
              }
              normalizePlateArray(item.cars || []).forEach((plate) =>
                allCars.push(plate),
              );
            });
            lprSync = await syncLprCarDiff({
              houseNo: patch.house_no,
              oldCars: oldData.cars || [],
              newCars: patch.cars || [],
              allCars,
            });
            await residentDocRef.set({
              lpr_sync_pending: !lprSync.ok,
              lpr_last_sync: new Date().toISOString(),
            }, {merge: true});
          }

          const changedFields = Object.keys(patch)
              .filter((key) => ![
                "house_no",
                "last_updated",
                "updatedAt",
                "updatedBy",
                "updatedByIp",
              ].includes(key))
              .filter((key) => !residentAuditValuesEqual(
                  key, oldData[key], patch[key],
              ));
          writeAuditLog("admin_resident_update", patch.house_no, {
            ip: req.ip,
            changedFields,
            old: {
              name: oldData.name || "",
              email: oldData.email || "",
              phone: oldData.phone || "",
              cars: oldData.cars || [],
              motorcycles: oldData.motorcycles || [],
            },
            new: {
              name: Object.prototype.hasOwnProperty.call(patch, "name") ?
            patch.name : oldData.name || "",
              email: Object.prototype.hasOwnProperty.call(patch, "email") ?
            patch.email : oldData.email || "",
              phone: Object.prototype.hasOwnProperty.call(patch, "phone") ?
            patch.phone : oldData.phone || "",
              cars: Object.prototype.hasOwnProperty.call(patch, "cars") ?
            patch.cars : oldData.cars || [],
              motorcycles:
            Object.prototype.hasOwnProperty.call(patch, "motorcycles") ?
              patch.motorcycles : oldData.motorcycles || [],
            },
            lprSync,
          }, lprSync ? lprSync.ok : true);

          res.status(200).json({
            ok: true,
            houseNo: patch.house_no,
            updated: changedFields,
            lprPending: lprSync ? !lprSync.ok : false,
            lprSync,
          });
          return;
        }

        if (action === "adminReset") {
          await verifyAdminResidentAccess(body, "admin.pins");
          const pin = generateResidentPin();
          const salt = crypto.randomBytes(16).toString("hex");
          await docRef.set({
            houseNo: data.houseNo || houseNo,
            pinHash: hashResidentPin(pin, salt),
            salt,
            changedByResident: false,
            resetByAdmin: true,
            adminResetAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, {merge: true});
          writeAuditLog("admin_pin_reset", houseNo, {ip: req.ip});
          res.status(200).json({
            ok: true,
            houseNo: data.houseNo || houseNo,
            pin,
          });
          return;
        }

        if (action === "verify") {
          const pin = normalizeResidentPin(body.pin);
          const pinHash = hashResidentPin(pin, data.salt || "");
          if (pinHash !== data.pinHash) {
            await docRef.set({
              lastFailedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, {merge: true});
            writeAuditLog("pin_verify", houseNo, {ip: req.ip}, false);
            res.status(401).json({ok: false, error: "Invalid PIN"});
            return;
          }

          await docRef.set({
            lastLoginAt: admin.firestore.FieldValue.serverTimestamp(),
          }, {merge: true});
          writeAuditLog("pin_verify", houseNo, {ip: req.ip}, true);
          res.status(200).json({ok: true, houseNo: data.houseNo || houseNo});
          return;
        }

        if (action === "change") {
          const oldPin = normalizeResidentPin(body.oldPin);
          const newPin = normalizeResidentPin(body.newPin);
          const oldHash = hashResidentPin(oldPin, data.salt || "");
          if (oldHash !== data.pinHash) {
            writeAuditLog("pin_change", houseNo, {ip: req.ip}, false);
            res.status(401).json({ok: false, error: "Invalid PIN"});
            return;
          }

          const salt = crypto.randomBytes(16).toString("hex");
          await docRef.set({
            pinHash: hashResidentPin(newPin, salt),
            salt,
            changedByResident: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, {merge: true});
          writeAuditLog("pin_change", houseNo, {ip: req.ip}, true);
          res.status(200).json({ok: true, houseNo: data.houseNo || houseNo});
          return;
        }

        if (action === "reset") {
          const newPin = normalizeResidentPin(body.newPin);

          // Rate limit: max 20 attempts per hour
          const nowMs = Date.now();
          const recentAttempts = (data.resetAttempts || [])
              .filter((t) => nowMs - t < FORGOT_PIN_WINDOW_MS);
          if (recentAttempts.length >= FORGOT_PIN_RATE_LIMIT) {
            writeAuditLog("pin_reset", houseNo,
                {ip: req.ip, reason: "rate_limited"}, false);
            res.status(429).json({ok: false, error: "rate_limited",
              message: "ลองใหม่ในอีก 1 ชั่วโมง"});
            return;
          }

          // Read resident identity data from Firestore residents collection
          const residentDocSnap = await db
              .collection(RESIDENTS_COLLECTION)
              .doc(residentPinDocId(houseNo))
              .get();

          const resident = residentDocSnap.exists ?
            residentDocSnap.data() : null;

          if (!resident) {
            res.status(404).json({ok: false, error: "Resident not found"});
            return;
          }

          const checks = [
            residentIdentityMatches(resident.name, body.name, "text"),
            residentIdentityMatches(resident.email, body.email, "email"),
            residentIdentityMatches(resident.phone, body.phone, "phone"),
          ];
          const matched = checks.filter(Boolean).length;
          if (matched < 2) {
            await docRef.set({
              lastResetFailedAt: admin.firestore.FieldValue.serverTimestamp(),
              resetAttempts: [...recentAttempts, nowMs],
            }, {merge: true});
            writeAuditLog("pin_reset", houseNo, {ip: req.ip}, false);
            res.status(403).json({ok: false, error: "Identity check failed"});
            return;
          }

          const salt = crypto.randomBytes(16).toString("hex");
          await docRef.set({
            pinHash: hashResidentPin(newPin, salt),
            salt,
            changedByResident: true,
            resetByResident: true,
            resetAttempts: [],
            resetAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, {merge: true});
          writeAuditLog("pin_reset", houseNo, {ip: req.ip}, true);
          res.status(200).json({ok: true, houseNo: data.houseNo || houseNo});
          return;
        }

        res.status(400).json({ok: false, error: "Unknown action"});
      } catch (error) {
        logger.error("residentPinAuth failed", error);
        const status = error.status ||
          (/PIN must|Missing|Unknown/i.test(error.message) ? 400 : 500);
        res.status(status).json({ok: false, error: error.message});
      }
    },
);

exports.adminAccessMatrix = onRequest(async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ok: false, error: "Method Not Allowed"});
    return;
  }

  try {
    const body = req.body || {};
    const action = String(body.action || "resolve").trim();

    if (action === "resolve") {
      const houseNo = normalizeHouseNo(body.houseNo);
      const pin = String(body.pin || "");
      if (!houseNo || !pin) {
        res.status(401).json({ok: false, error: "Missing credentials"});
        return;
      }
      // This runs on every landing-page load, so trim the Firestore round
      // trips: the PIN read and the access read are independent, and the
      // activity counter can ride along with whichever finishes last.
      const accessPromise = getAdminAccess(houseNo);
      accessPromise.catch(() => {});
      const pinData = await verifyResidentPinInternal(houseNo, pin);

      const activityPatch = {
        lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
        activityCount: admin.firestore.FieldValue.increment(1),
      };
      if (!pinData.firstActivityAt) {
        activityPatch.firstActivityAt =
          admin.firestore.FieldValue.serverTimestamp();
      }
      const [access] = await Promise.all([
        accessPromise,
        db.collection(RESIDENT_PIN_COLLECTION)
            .doc(residentPinDocId(houseNo))
            .set(activityPatch, {merge: true}),
      ]);
      res.status(200).json({ok: true, access});
      return;
    }

    await verifyAccessMatrixManager(body);

    if (action === "list") {
      const [accessSnap, residentsSnap] = await Promise.all([
        db.collection(ADMIN_ACCESS_COLLECTION).get(),
        db.collection(RESIDENTS_COLLECTION).get(),
      ]);
      const houses = new Set(Object.keys(ADMIN_ACCESS_DEFAULTS));
      accessSnap.docs.forEach((doc) => {
        const data = doc.data() || {};
        const houseNo = normalizeHouseNo(data.houseNo);
        if (houseNo) houses.add(houseNo);
      });
      const residentNames = new Map();
      const residents = [];
      residentsSnap.docs.forEach((doc) => {
        const data = doc.data() || {};
        const houseNo = normalizeHouseNo(data.house_no || data.houseNo);
        if (houseNo) {
          const residentName = String(data.name || "");
          residentNames.set(houseNo, residentName);
          residents.push({houseNo, residentName});
        }
      });
      const access = await Promise.all(
          [...houses].map(async (houseNo) => ({
            ...await getAdminAccess(houseNo),
            residentName: residentNames.get(houseNo) || "",
          })),
      );
      access.sort((a, b) => {
        const aNo = Number(a.houseNo.split("/")[1] || 0);
        const bNo = Number(b.houseNo.split("/")[1] || 0);
        return aNo - bNo;
      });
      residents.sort((a, b) => {
        const aNo = Number(a.houseNo.split("/")[1] || 0);
        const bNo = Number(b.houseNo.split("/")[1] || 0);
        return aNo - bNo;
      });
      res.status(200).json({
        ok: true,
        permissionKeys: ADMIN_PERMISSION_KEYS,
        access,
        residents,
      });
      return;
    }

    if (action === "save") {
      const targetHouseNo = normalizeHouseNo(body.targetHouseNo);
      if (!targetHouseNo) {
        res.status(400).json({ok: false, error: "Missing house number"});
        return;
      }
      const pinSnap = await db.collection(RESIDENT_PIN_COLLECTION)
          .doc(residentPinDocId(targetHouseNo))
          .get();
      if (!pinSnap.exists) {
        res.status(404).json({ok: false, error: "Resident PIN not configured"});
        return;
      }
      const permissions = normalizeAdminPermissions(body.permissions);
      [
        ["expense.manage", "expense.view"],
        ["insurance.manage", "insurance.view"],
        ["blueprints.manage", "blueprints.view"],
      ].forEach(([manageKey, viewKey]) => {
        if (permissions[manageKey]) permissions[viewKey] = true;
      });
      if (targetHouseNo === "38/8") {
        permissions["admin.portal"] = true;
      }
      const payload = {
        houseNo: targetHouseNo,
        roleLabel: String(body.roleLabel || "ผู้ดูแล")
            .trim().slice(0, 80) || "ผู้ดูแล",
        active: targetHouseNo === "38/8" ? true : body.active !== false,
        permissions,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: "38/8",
      };
      await db.collection(ADMIN_ACCESS_COLLECTION)
          .doc(residentPinDocId(targetHouseNo))
          .set(payload, {merge: true});
      writeAuditLog("admin_access_update", targetHouseNo, {
        permissions,
        active: payload.active,
      });
      res.status(200).json({
        ok: true,
        access: await getAdminAccess(targetHouseNo),
      });
      return;
    }

    if (action === "remove") {
      const targetHouseNo = normalizeHouseNo(body.targetHouseNo);
      if (!targetHouseNo || targetHouseNo === "38/8") {
        res.status(400).json({
          ok: false,
          error: "The primary superadmin cannot be removed",
        });
        return;
      }
      await db.collection(ADMIN_ACCESS_COLLECTION)
          .doc(residentPinDocId(targetHouseNo))
          .set({
            houseNo: targetHouseNo,
            active: false,
            permissions: normalizeAdminPermissions({}),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedBy: "38/8",
          }, {merge: true});
      writeAuditLog("admin_access_remove", targetHouseNo);
      res.status(200).json({ok: true});
      return;
    }

    res.status(400).json({ok: false, error: "Invalid action"});
  } catch (err) {
    logger.error("adminAccessMatrix failed", err);
    const status = err.status ||
      (/PIN must|Missing|Invalid action/i.test(err.message) ? 400 : 500);
    res.status(status).json({ok: false, error: err.message});
  }
});

// Functions the pattra8.com landing page blocks on. A cold start costs ~2s
// there, which is what made the admin cards pop in late — so keep one
// instance of each alive during the hours residents actually browse.
const WARM_TARGET_FUNCTIONS = ["adminAccessMatrix", "getResidentData"];

/**
 * Sends a preflight-shaped OPTIONS request, which every handler answers with
 * 204 before touching Firestore — enough to keep the instance resident.
 * @param {string} fnName
 * @return {Promise<void>}
 */
async function warmFunction(fnName) {
  const projectId = process.env.GCLOUD_PROJECT || "pattra8-54c3f";
  const url =
    `https://asia-southeast1-${projectId}.cloudfunctions.net/${fnName}`;
  try {
    await fetch(url, {
      method: "OPTIONS",
      headers: {
        "Origin": "https://pattra8.com",
        "Access-Control-Request-Method": "POST",
      },
    });
  } catch (err) {
    logger.warn(`warmFunction ${fnName} failed`, err);
  }
}

exports.authWarmPing = onSchedule(
    {
      schedule: "*/5 6-22 * * *",
      timeZone: "Asia/Bangkok",
      memory: "256MiB",
      timeoutSeconds: 60,
    },
    async () => {
      await Promise.all(WARM_TARGET_FUNCTIONS.map(warmFunction));
    },
);

exports.lineFlexRoutingAdmin = onRequest({
  secrets: [LINE_CHANNEL_ACCESS_TOKEN],
}, async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ok: false, error: "Method Not Allowed"});
    return;
  }

  try {
    const body = req.body || {};
    const action = String(body.action || "get").trim();

    await verifyAdminResidentAccess(body, "admin.portal");

    if (action === "get") {
      const targets = await getLineFlexTargetOptions();
      res.status(200).json({
        ok: true,
        config: await getLineFlexRoutingConfig(),
        targets,
        routes: getDefaultLineFlexRoutes(),
      });
      return;
    }

    if (action === "save") {
      const targetOptions = await getLineFlexTargetOptions();
      const allowedTargetIds = new Set(
          targetOptions.map((item) => item.targetId).filter(Boolean),
      );
      const incomingFlows = body.flows && typeof body.flows === "object" ?
        body.flows : {};
      const flows = getDefaultLineFlexFlows();
      Object.keys(flows).forEach((routeKey) => {
        const saved = incomingFlows[routeKey] &&
          typeof incomingFlows[routeKey] === "object" ?
          incomingFlows[routeKey] : {};
        const sandboxTargetId = normalizeLineFlexTargetId(
            saved.sandboxTargetId || flows[routeKey].sandboxTargetId,
        );
        const productionTargetId = normalizeLineFlexTargetId(
            saved.productionTargetId || flows[routeKey].productionTargetId,
        );

        if (!allowedTargetIds.has(sandboxTargetId)) {
          throw new Error(`Sandbox target for ${routeKey} is not registered`);
        }
        if (!allowedTargetIds.has(productionTargetId)) {
          throw new Error(
              `Production target for ${routeKey} is not registered`,
          );
        }

        flows[routeKey] = {
          sandboxTargetId,
          productionTargetId,
          activeMode: normalizeLineFlexRouteChoice(saved.activeMode),
        };
      });

      await db.doc(LINE_FLEX_ROUTING_CONFIG_PATH).set({
        flows,
        routes: Object.fromEntries(Object.keys(flows).map((routeKey) => [
          routeKey,
          flows[routeKey].activeMode,
        ])),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: normalizeHouseNo(body.houseNo || "") || "38/8",
      }, {merge: true});

      res.status(200).json({
        ok: true,
        config: await getLineFlexRoutingConfig(),
        targets: targetOptions,
        routes: getDefaultLineFlexRoutes(),
      });
      return;
    }

    if (action === "reset") {
      const flows = getDefaultLineFlexFlows();
      const targets = await getLineFlexTargetOptions();
      await db.doc(LINE_FLEX_ROUTING_CONFIG_PATH).set({
        flows,
        routes: Object.fromEntries(Object.keys(flows).map((routeKey) => [
          routeKey,
          flows[routeKey].activeMode,
        ])),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: normalizeHouseNo(body.houseNo || "") || "38/8",
      }, {merge: true});

      res.status(200).json({
        ok: true,
        config: await getLineFlexRoutingConfig(),
        targets,
        routes: getDefaultLineFlexRoutes(),
      });
      return;
    }

    if (action === "sendPattraPaySandbox") {
      const config = await getLineFlexRoutingConfig();
      const flow = config.flows && config.flows.pattraPay ?
        config.flows.pattraPay : getDefaultLineFlexFlows().pattraPay;
      const targetId = normalizeLineFlexTargetId(
          flow && flow.sandboxTargetId,
      );
      if (!targetId) {
        throw new Error("Pattra Pay sandbox target is not configured");
      }
      const data = await buildPaymentHeatmapData({
        feeType: body.feeType,
        period: body.period,
        year: body.year,
      });
      const message = buildPaymentHeatmapFlexMessage(data);
      await sendLinePushMessages(targetId, [message]);
      res.status(200).json({
        ok: true,
        targetId,
        targetLabel: buildTargetLabelFromId(targetId),
        data,
      });
      return;
    }

    if (action === "sendVisitorOutageNoticeSandbox") {
      const targetId = LINE_FLEX_SANDBOX_TARGET_ID;
      const text = buildVisitorLineOutageNotice();
      await sendLinePush(targetId, `[ทดสอบ Sandbox]\n${text}`);
      logger.info("Visitor outage notice sandbox sent", {
        targetId: maskTargetId(targetId),
      });
      res.status(200).json({
        ok: true,
        action,
        targetId: maskTargetId(targetId),
        targetLabel: buildTargetLabelFromId(targetId),
      });
      return;
    }

    if (action === "sendWeeklySafetySandboxPreview") {
      const report = {
        preview: true,
        startDate: "2026-07-19",
        endDate: "2026-07-25",
        dateLabel: "19–25 กรกฎาคม 2569",
        generatedAt: new Date().toISOString(),
        trafficCars: 486,
        residentCars: 312,
        externalCars: 174,
        visitorCars: 174,
        checkedCars: 165,
        uncheckedCars: 9,
        checkPercent: 94.8,
        motorcycleCount: 31,
        unreadableDetections: 8,
        busiestHour: 17,
        busiestCount: 42,
        cameraComplete: true,
        purposes: [
          {label: "ส่งอาหารและพัสดุ", count: 82},
          {label: "ช่างและผู้รับเหมา", count: 46},
          {label: "ติดต่อบ้านลูกบ้าน", count: 38},
          {label: "อื่น ๆ", count: 8},
        ],
      };
      const message = buildWeeklySafetyFlexMessage(report);
      const messageBytes = Buffer.byteLength(
          JSON.stringify(message.contents), "utf8");
      if (messageBytes > 29000) {
        throw new Error(
            `Weekly safety preview Flex is too large (${messageBytes})`,
        );
      }
      const targetId = LINE_FLEX_SANDBOX_TARGET_ID;
      await sendLinePushMessages(targetId, [message]);
      logger.info("Weekly safety sandbox preview sent", {
        targetId: maskTargetId(targetId),
        messageBytes,
      });
      res.status(200).json({
        ok: true,
        action,
        targetId: maskTargetId(targetId),
        targetLabel: buildTargetLabelFromId(targetId),
        messageBytes,
        report,
      });
      return;
    }

    if (action === "sendWeeklySafetySandbox") {
      const endDate = String(
          body.endDate || getYesterdayBangkokDate(),
      ).trim();
      const report = await buildWeeklySafetyReport(endDate);
      const message = buildWeeklySafetyFlexMessage(report);
      const messageBytes = Buffer.byteLength(
          JSON.stringify(message.contents), "utf8");
      if (messageBytes > 29000) {
        throw new Error(`Weekly safety Flex is too large (${messageBytes})`);
      }
      const targetId = LINE_FLEX_SANDBOX_TARGET_ID;
      await sendLinePushMessages(targetId, [message]);
      logger.info("Weekly safety sandbox sent", {
        startDate: report.startDate,
        endDate: report.endDate,
        targetId: maskTargetId(targetId),
        messageBytes,
      });
      res.status(200).json({
        ok: true,
        action,
        targetId: maskTargetId(targetId),
        targetLabel: buildTargetLabelFromId(targetId),
        messageBytes,
        report,
      });
      return;
    }

    if (action === "sendNativeImageFlexSandbox") {
      const media = Array.isArray(body.media) ? body.media : [];
      if (media.length !== 1) {
        throw new Error("Exactly one image is required");
      }
      const parsed = parseAnnouncementImage(media[0]);
      const sharp = require("sharp");
      const metadata = await sharp(parsed.buffer).metadata();
      const width = Number(metadata.width || 0);
      const height = Number(metadata.height || 0);
      if (!width || !height || height > width * 3) {
        throw new Error("Image aspect ratio is not supported by LINE Flex");
      }

      const title = String(
          body.title || "แยกขยะวันนี้ เพื่อชุมชนของเรา",
      ).trim().slice(0, 120);
      const imageHash = crypto.createHash("sha256")
          .update(parsed.buffer)
          .digest("hex");
      const broadcastRef = db.collection(LINE_BROADCASTS_COLLECTION).doc();
      const uploaded = await uploadAnnouncementImages(
          broadcastRef.id,
          media,
          "line-flex-sandbox",
      );
      const image = uploaded[0];
      const message = {
        type: "flex",
        altText: title,
        contents: {
          type: "bubble",
          size: "giga",
          hero: {
            type: "image",
            url: image.url,
            size: "full",
            aspectRatio: `${width}:${height}`,
            aspectMode: "fit",
            backgroundColor: "#FFFFFF",
            action: {
              type: "uri",
              label: "ดูภาพขนาดเต็ม",
              uri: image.url,
            },
          },
        },
      };
      const messageBytes = Buffer.byteLength(
          JSON.stringify(message.contents), "utf8");
      const targetId = LINE_FLEX_SANDBOX_TARGET_ID;
      await sendLinePushMessages(targetId, [message]);
      await broadcastRef.set({
        channel: ANNOUNCEMENT_CHANNEL,
        category: "native_flex_image",
        type: "native_flex_image",
        source: "line_flex_sandbox",
        sendMode: "sandbox",
        title,
        body: "",
        message: "",
        lineTargetId: targetId,
        lineTargetLabel: buildTargetLabelFromId(targetId),
        imageHash,
        imageWidth: width,
        imageHeight: height,
        messageBytes,
        media: uploaded,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      logger.info("Native image Flex sandbox sent", {
        targetId: maskTargetId(targetId),
        imageHash: imageHash.slice(0, 12),
        width,
        height,
        messageBytes,
      });
      res.status(200).json({
        ok: true,
        action,
        targetId: maskTargetId(targetId),
        targetLabel: buildTargetLabelFromId(targetId),
        title,
        imageHash,
        width,
        height,
        contentType: image.contentType,
        storagePath: image.storagePath,
        messageBytes,
      });
      return;
    }

    if (action === "sendFlowTest") {
      const flowKey = String(body.flowKey || "").trim();
      const mode = normalizeLineFlexRouteChoice(body.mode);
      const config = await getLineFlexRoutingConfig();
      const flows = config.flows || getDefaultLineFlexFlows();
      const flow = flows[flowKey];
      const targetId = mode === "sandbox" ?
        normalizeLineFlexTargetId(flow && flow.sandboxTargetId) :
        normalizeLineFlexTargetId(flow && flow.productionTargetId);
      if (!targetId) {
        const targetLabel = mode === "sandbox" ? "Sandbox" : "Production";
        throw new Error(
            `${targetLabel} target for ${flowKey} is not configured`,
        );
      }

      if (flowKey === "daily") {
        const report = await runDailyTrafficReport(
            getTodayBangkokDate(),
            true,
            targetId,
        );
        res.status(200).json({
          ok: true,
          flowKey,
          mode,
          targetId,
          targetLabel: buildTargetLabelFromId(targetId),
          report,
        });
        return;
      }

      if (flowKey === "night") {
        const report = await runOvernightSecurityReport(
            getTodayBangkokDate(),
            true,
            NIGHT_SHIFT_START_HOUR,
            0,
            NIGHT_SHIFT_END_HOUR,
            0,
            targetId,
        );
        res.status(200).json({
          ok: true,
          flowKey,
          mode,
          targetId,
          targetLabel: buildTargetLabelFromId(targetId),
          report,
        });
        return;
      }

      if (flowKey === "guardDay" || flowKey === "guardNight") {
        const nightShift = flowKey === "guardNight";
        const report = await runSecurityAuditReport(
            nightShift ? getYesterdayBangkokDate() : getTodayBangkokDate(),
            true,
            nightShift ? 19 : 7,
            30,
            nightShift ? 7 : 19,
            30,
            targetId,
        );
        res.status(200).json({
          ok: true,
          flowKey,
          mode,
          targetId,
          targetLabel: buildTargetLabelFromId(targetId),
          report,
        });
        return;
      }

      if (flowKey === "pattraPay") {
        const data = await buildPaymentHeatmapData({
          feeType: body.feeType,
          period: body.period,
          year: body.year,
        });
        const message = buildPaymentHeatmapFlexMessage(data);
        await sendLinePushMessages(targetId, [message]);
        res.status(200).json({
          ok: true,
          flowKey,
          mode,
          targetId,
          targetLabel: buildTargetLabelFromId(targetId),
          data,
        });
        return;
      }

      if (flowKey === "pattraReport") {
        const text = buildLineMessage(mode === "sandbox" ?
          "ตัวอย่างแจ้งปัญหาใหม่ (ทดสอบ sandbox)" :
          "ตัวอย่างแจ้งปัญหาใหม่ (ทดสอบ production)", {
          house: "38/8",
          category: "ทดสอบระบบ",
          title: mode === "sandbox" ?
            "ทดสอบส่งเข้า sandbox" :
            "ทดสอบส่งเข้า production",
          description: "ข้อความตัวอย่างจากหน้า LINE Flex Routing",
          priority: "normal",
          date: new Date().toLocaleDateString("th-TH-u-ca-gregory"),
        });
        await sendLinePush(targetId, text);
        res.status(200).json({
          ok: true,
          flowKey,
          mode,
          targetId,
          targetLabel: buildTargetLabelFromId(targetId),
          preview: true,
        });
        return;
      }

      throw new Error(`Unsupported test flow: ${flowKey}`);
    }

    res.status(400).json({ok: false, error: "Invalid action"});
  } catch (err) {
    logger.error("lineFlexRoutingAdmin failed", err);
    const status = err.status ||
      (/PIN must|Missing|Invalid action/i.test(err.message) ? 400 : 500);
    res.status(status).json({ok: false, error: err.message});
  }
});

exports.broadcastLineAnnouncement = onRequest(
    {
      secrets: [LINE_CHANNEL_ACCESS_TOKEN],
      memory: "512MiB",
      timeoutSeconds: 60,
    },
    async (req, res) => {
      setCorsHeaders(req, res);

      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }

      if (req.method !== "POST") {
        res.status(405).json({ok: false, error: "Method Not Allowed"});
        return;
      }

      try {
        const body = req.body || {};
        const action = String(body.action || "send");

        if (action === "listBroadcastTargets") {
          await verifyAccessMatrixManager(body);
          const targets = (await getLineFlexTargetOptions())
              .filter((target) =>
                target.targetId !== LINE_FLEX_SANDBOX_TARGET_ID,
              );
          res.status(200).json({
            ok: true,
            sandboxTarget: LINE_FLEX_TARGETS.sandbox,
            productionTargets: targets,
          });
          return;
        }

        if (action === "listTargets") {
          await verifyAdminResidentAccess(body, "admin.announcements");
          const targets = await getLineTargets();
          res.status(200).json({ok: true, targets});
          return;
        }

        let broadcastMode = null;
        let broadcastTarget = null;
        if (action === "sendBroadcast") {
          await verifyAccessMatrixManager(body);
          broadcastMode = String(body.mode || "").trim();
          const targets = await getLineFlexTargetOptions();

          if (broadcastMode === "sandbox") {
            broadcastTarget = LINE_FLEX_TARGETS.sandbox;
          } else if (broadcastMode === "prd") {
            const requestedTargetId = String(body.targetId || "").trim();
            broadcastTarget = targets.find((target) =>
              target.targetId === requestedTargetId &&
              target.targetId !== LINE_FLEX_SANDBOX_TARGET_ID,
            );
            if (!broadcastTarget) {
              throw new Error("Please select a production LINE group");
            }
          } else {
            throw new Error("Invalid broadcast mode");
          }
        }

        if (broadcastMode) {
          const message = String(body.message || "");
          const media = Array.isArray(body.media) ? body.media : [];
          if (!message.trim() && !media.length) {
            throw new Error("Missing message or media");
          }
          if (media.length > MAX_ANNOUNCEMENT_IMAGES) {
            throw new Error(`Maximum ${MAX_ANNOUNCEMENT_IMAGES} images`);
          }
        } else {
          await validateAnnouncementRequest(body);
        }

        const target = broadcastTarget ||
          await resolveLineTarget(body.targetId);
        const targetId = target.targetId;

        const announcementRef = db.collection(
            broadcastMode ? LINE_BROADCASTS_COLLECTION : "announcements",
        ).doc();
        const media = await uploadAnnouncementImages(
            announcementRef.id,
            body.media || [],
            broadcastMode ? "line-broadcasts" : "announcements",
        );
        const text = broadcastMode ?
          String(body.message || "").slice(0, 4900) :
          buildAnnouncementText(body);
        const messages = [
          ...media.map((item) => ({
            type: "image",
            originalContentUrl: item.url,
            previewImageUrl: item.url,
          })),
          ...(text.trim() ? [{type: "text", text}] : []),
        ];

        await sendLinePushMessages(targetId, messages);

        const record = {
          channel: ANNOUNCEMENT_CHANNEL,
          lineTargetId: targetId,
          lineTargetLabel: target.label || buildTargetLabel(target),
          lineTargetType: target.sourceType || null,
          title: String(body.title || "").trim(),
          body: String(body.message || "").trim(),
          message: String(body.message || "").trim(),
          category: broadcastMode ?
            "ข้อความโดยตรง" : String(body.category || "ทั่วไป").trim(),
          type: broadcastMode ?
            "direct_message" : String(body.category || "normal").trim(),
          source: broadcastMode ? "line_broadcast" : "admin_announcement",
          sendMode: broadcastMode,
          media,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        await announcementRef.set(record);

        res.status(200).json({
          ok: true,
          id: announcementRef.id,
          targetId,
          targetLabel: target.label || buildTargetLabel(target),
          mode: broadcastMode,
          media,
        });
      } catch (error) {
        const status = error.status ||
          (error.message === "Unauthorized" ? 401 : 400);
        logger.error("broadcastLineAnnouncement failed", error);
        res.status(status).json({ok: false, error: error.message});
      }
    },
);

exports.lprPlateSync = onRequest(
    {
      secrets: [LPR_ADMIN_PASSWORD],
      memory: "512MiB",
      timeoutSeconds: 60,
    },
    async (req, res) => {
      setCorsHeaders(req, res);

      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }

      if (req.method !== "POST") {
        res.status(405).json({ok: false, error: "Method Not Allowed"});
        return;
      }

      try {
        const body = req.body || {};
        await validateGithubToken(body.githubToken);

        const result = await syncLprCarDiff({
          houseNo: body.houseNo,
          oldCars: body.oldCars,
          newCars: body.newCars,
          allCars: body.allCars,
        });
        const houseNo = normalizeHouseNo(body.houseNo);
        if (houseNo && result.ok) {
          await db
              .collection(RESIDENTS_COLLECTION)
              .doc(residentPinDocId(houseNo))
              .set({
                lpr_sync_pending: false,
                lpr_last_sync: new Date().toISOString(),
              }, {merge: true});
        }

        res.status(result.ok ? 200 : 207).json(result);
      } catch (error) {
        const status = /token|Unauthorized/i.test(error.message) ? 401 : 500;
        logger.error("lprPlateSync failed", error);
        res.status(status).json({ok: false, error: error.message});
      }
    },
);

exports.retryPendingLprSync = onSchedule(
    {
      schedule: "every 15 minutes",
      timeZone: "Asia/Bangkok",
      secrets: [LPR_ADMIN_PASSWORD],
      memory: "512MiB",
      timeoutSeconds: 540,
    },
    async () => {
      const pendingSnap = await db
          .collection(RESIDENTS_COLLECTION)
          .where("lpr_sync_pending", "==", true)
          .limit(LPR_RETRY_BATCH_LIMIT)
          .get();

      if (pendingSnap.empty) {
        logger.info("retryPendingLprSync: no pending residents");
        return;
      }

      const results = [];
      for (const residentDoc of pendingSnap.docs) {
        try {
          const result = await retryPendingLprSyncForResident(residentDoc);
          results.push({
            houseNo: result.houseNo,
            ok: result.ok,
          });
        } catch (error) {
          const resident = residentDoc.data() || {};
          const houseNo = normalizeHouseNo(
              resident.house_no || resident.houseNo || "",
          );
          await residentDoc.ref.set({
            lpr_last_sync: new Date().toISOString(),
            lpr_last_retry_at: new Date().toISOString(),
            lpr_sync_pending: true,
            lpr_sync_retry_count: admin.firestore.FieldValue.increment(1),
            lpr_last_error: String(error.message || error).slice(0, 4000),
          }, {merge: true});
          results.push({
            houseNo,
            ok: false,
            error: error.message,
          });
        }
      }

      logger.info("retryPendingLprSync complete", {
        total: results.length,
        failed: results.filter((item) => !item.ok).length,
        houses: results,
      });
    },
);

exports.dailyLprReconciliation = onSchedule(
    {
      schedule: "0 6 * * *",
      timeZone: "Asia/Bangkok",
      secrets: [LPR_ADMIN_PASSWORD, LINE_CHANNEL_ACCESS_TOKEN],
      memory: "512MiB",
      timeoutSeconds: 540,
    },
    async () => {
      const report = await runLprReconciliation({
        sendLine: true,
        autoHeal: true,
      });
      logger.info("dailyLprReconciliation complete", {
        reportId: report.id,
        status: report.status,
        expectedCount: report.expectedCount,
        lineSent: report.lineSent,
      });
    },
);

exports.lprReconciliation = onRequest(
    {
      secrets: [LPR_ADMIN_PASSWORD, LINE_CHANNEL_ACCESS_TOKEN],
      memory: "512MiB",
      timeoutSeconds: 540,
    },
    async (req, res) => {
      setCorsHeaders(req, res);
      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }
      if (req.method !== "POST") {
        res.status(405).json({ok: false, error: "Method Not Allowed"});
        return;
      }

      try {
        const body = req.body || {};
        await verifyAdminResidentAccess(body, "admin.audit");
        const action = String(body.action || "latest").trim();

        if (action === "run") {
          const report = await runLprReconciliation({
            sendLine: body.sendLine !== false,
            autoHeal: body.autoHeal !== false,
          });
          res.status(200).json({ok: true, report});
          return;
        }

        if (action === "latest") {
          const snap = await db.collection(LPR_RECONCILIATION_COLLECTION)
              .orderBy("createdAt", "desc")
              .limit(Math.min(Math.max(Number(body.limit || 7), 1), 30))
              .get();
          const reports = snap.docs.map((docSnap) => {
            const data = docSnap.data() || {};
            return {
              id: docSnap.id,
              ...data,
              createdAt: data.createdAt && data.createdAt.toDate ?
                data.createdAt.toDate().toISOString() : "",
            };
          });
          res.status(200).json({ok: true, reports});
          return;
        }

        res.status(400).json({ok: false, error: "Invalid action"});
      } catch (error) {
        logger.error("lprReconciliation failed", error);
        res.status(error.status || 500).json({
          ok: false,
          error: error.message,
        });
      }
    },
);

// Maps each LPR camera port to the lane it guards (8241=entry, 8242=exit).
const LPR_CAMERA_DIRECTIONS = {
  "8241": "กล้องขาเข้า",
  "8242": "กล้องขาออก",
};

/**
 * Human-friendly labels for each configured LPR camera, keyed by base URL.
 * @param {string} cameraBase
 * @param {number} index
 * @return {string}
 */
function lprCameraLabel(cameraBase, index) {
  const port = (String(cameraBase).match(/:(\d+)/) || [])[1] || "";
  const direction = LPR_CAMERA_DIRECTIONS[port] || `กล้อง ${index + 1}`;
  return `${direction}${port ? ` (${port})` : ""}`;
}

/**
 * Open, login-free lookup for the guard station LPR check page.
 *
 * Given a plate, reports whether it is registered in the resident master
 * data (and to which house) and whether it currently exists in each LPR
 * camera's allowlist. Intentionally returns no personal data beyond the
 * house number, and uses permissive CORS so it can be opened from any
 * device at the guard post without login.
 */
exports.lprGuardLookup = onRequest(
    {
      secrets: [LPR_ADMIN_PASSWORD],
      memory: "256MiB",
      timeoutSeconds: 30,
    },
    async (req, res) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      res.set("Cache-Control", "no-store");
      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }

      try {
        const rawPlate = req.method === "POST" ?
          (req.body || {}).plate :
          req.query.plate;
        const plate = normalizePlateArray(rawPlate)[0] || "";
        if (!plate) {
          res.status(400).json({ok: false, error: "Missing plate"});
          return;
        }

        const expected = await buildExpectedLprState();
        const houses = expected.plateHouses[plate] || [];

        const cameras = await Promise.all(
            LPR_CAMERAS.map(async (cameraBase, index) => {
              const label = lprCameraLabel(cameraBase, index);
              try {
                const inCamera = await lprPlateExists(cameraBase, plate);
                return {label, inCamera};
              } catch (error) {
                logger.warn("lprGuardLookup camera check failed", {
                  cameraBase,
                  error: error.message,
                });
                return {label, inCamera: null};
              }
            }),
        );

        res.status(200).json({
          ok: true,
          plate,
          registered: houses.length > 0,
          houses,
          cameras,
        });
      } catch (error) {
        logger.error("lprGuardLookup failed", error);
        res.status(500).json({ok: false, error: error.message});
      }
    },
);

exports.lprEventWebhook = onRequest(
    {
      secrets: [LPR_EVENT_TOKEN],
      memory: "256MiB",
      timeoutSeconds: 30,
    },
    async (req, res) => {
      if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return;
      }
      const suppliedToken = String(req.query.token || "");
      const expectedToken = String(LPR_EVENT_TOKEN.value() || "");
      if (!suppliedToken || suppliedToken !== expectedToken) {
        res.status(403).send("Forbidden");
        return;
      }

      // Hikvision ISAPI Listening with "Platform Response Verification" on
      // requires a valid ResponseStatus ACK; a plain "OK" makes the camera
      // treat the host as failed and stop streaming. Reply with statusCode 1.
      const sendAck = () => res
          .set("Content-Type", "application/xml")
          .status(200)
          .send(
              "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
            "<ResponseStatus version=\"2.0\" " +
            "xmlns=\"http://www.isapi.org/ver20/XMLSchema\">\n" +
            "<requestURL>/lprEventWebhook</requestURL>\n" +
            "<statusCode>1</statusCode>\n" +
            "<statusString>OK</statusString>\n" +
            "<subStatusCode>ok</subStatusCode>\n" +
            "</ResponseStatus>",
          );

      try {
        const cameraId = String(req.query.camera || "unknown").slice(0, 20);
        const configuredDirection = String(
            req.query.direction || "unknown",
        );
        const direction = ["entry", "exit"].includes(configuredDirection) ?
          configuredDirection : "unknown";
        const payload = req.rawBody ? req.rawBody.toString("utf8") :
          JSON.stringify(req.body || {});
        // TEMP-DEBUG (remove after parser is verified): capture the raw
        // camera payload so we can match parseLprTrafficEvent to the real
        // Hikvision ANPR format. Cloud-side only; no gate impact.
        logger.info("lprEventWebhook raw payload", {
          cameraId,
          direction,
          contentType: String(req.headers["content-type"] || ""),
          length: payload.length,
          bodyHead: payload.slice(0, 3000),
        });
        const parsed = parseLprTrafficEvent(payload);
        if (!parsed) {
          // TEMP-DEBUG: persist unparseable payloads for inspection.
          try {
            const dbgId = crypto.createHash("sha256")
                .update(`${Date.now()}|${cameraId}|${payload.slice(0, 200)}`)
                .digest("hex").slice(0, 40);
            await db.collection("lpr_debug_events").doc(dbgId).set({
              cameraId,
              direction,
              contentType: String(req.headers["content-type"] || ""),
              length: payload.length,
              rawBody: payload.slice(0, 8000),
              sourceIp: req.ip || "",
              receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          } catch (dbgErr) {
            logger.warn("lpr_debug_events write failed", String(dbgErr));
          }
          sendAck();
          return;
        }

        // Camera clocks are not trustworthy: on 2026-07-19 the entry camera
        // ran exactly +60 min ahead (DST/manual-time flip) and every daily
        // report row showed exit-before-entry. When the camera timestamp is
        // more than 10 minutes off the server clock, keep the raw value for
        // audit but record the event at server time.
        const nowEpoch = Date.now();
        const clockSkewMs = nowEpoch - parsed.capturedAtEpoch;
        if (Math.abs(clockSkewMs) > 10 * 60 * 1000) {
          logger.warn("LPR camera clock skew — using server time", {
            cameraId,
            direction,
            cameraCapturedAt: parsed.capturedAt,
            clockSkewMinutes: Math.round(clockSkewMs / 60000),
          });
          parsed.cameraCapturedAt = parsed.capturedAt;
          parsed.cameraCapturedAtEpoch = parsed.capturedAtEpoch;
          parsed.clockSkewMs = clockSkewMs;
          parsed.capturedAtEpoch = nowEpoch;
          parsed.capturedAt = new Date(nowEpoch).toISOString();
        }

        const eventKey = [
          cameraId,
          parsed.cameraCapturedAt || parsed.capturedAt,
          parsed.plate,
          parsed.picName,
        ].join("|");
        const eventId = crypto.createHash("sha256")
            .update(eventKey)
            .digest("hex")
            .slice(0, 40);
        const eventRef = db.collection(LPR_TRAFFIC_EVENTS_COLLECTION)
            .doc(eventId);
        const cameraStatusRef = db.collection(LPR_AGENT_C_STATUS_COLLECTION)
            .doc(cameraId);
        await db.runTransaction(async (transaction) => {
          const existingEvent = await transaction.get(eventRef);
          transaction.set(eventRef, {
            ...parsed,
            cameraId,
            direction,
            sourceIp: req.ip || "",
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, {merge: true});
          // Hikvision may retry the same deterministic event. Only advance the
          // sequence once so retries cannot manufacture peer activity.
          if (!existingEvent.exists) {
            transaction.set(cameraStatusRef, {
              cameraId,
              lastCaptureAtEpoch: parsed.capturedAtEpoch,
              lastEventReceivedAtEpoch: nowEpoch,
              eventSequence: admin.firestore.FieldValue.increment(1),
              eventHeartbeatAt: admin.firestore.FieldValue.serverTimestamp(),
            }, {merge: true});
          }
        });
        logger.info("Stored LPR traffic event", {
          eventId,
          cameraId,
          direction,
          plate: parsed.plate || "unreadable",
        });
        sendAck();
      } catch (error) {
        logger.error("lprEventWebhook failed", error);
        res.status(500).send("Error");
      }
    },
);

// Day shift card (07:00–19:00), sent 15 minutes after the shift ends.
exports.dailyTrafficSummary = onSchedule(
    {
      schedule: "15 19 * * *",
      timeZone: "Asia/Bangkok",
      secrets: [LINE_CHANNEL_ACCESS_TOKEN],
      memory: "512MiB",
      timeoutSeconds: 120,
    },
    async () => {
      const report = await runDailyTrafficReport(
          getTodayBangkokDate(),
          !REPORT_PUSH_PAUSED,
      );
      logger.info("dailyTrafficSummary complete", {
        reportDate: report.reportDate,
        totalDetections: report.totalDetections,
        lineSent: report.lineSent,
        pushPaused: REPORT_PUSH_PAUSED,
      });
    },
);

exports.dailyTrafficReport = onRequest(
    {
      secrets: [LINE_CHANNEL_ACCESS_TOKEN],
      memory: "512MiB",
      timeoutSeconds: 120,
    },
    async (req, res) => {
      setCorsHeaders(req, res);
      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }
      if (req.method !== "POST") {
        res.status(405).json({ok: false, error: "Method Not Allowed"});
        return;
      }
      try {
        const body = req.body || {};
        const action = String(body.action || "run");
        if (action === "visitorBoard") {
          // Resident-facing board for /visitorboard/ — any resident with a
          // valid PIN (not just committee) can call this. Unlike "dailyLog"
          // it never returns which house a resident car belongs to; it only
          // exposes aggregate resident in/out counts plus the full external
          // (visitor) plate list, which isn't privacy-sensitive to residents.
          const houseNo = normalizeHouseNo(body.houseNo);
          const pin = String(body.pin || "");
          await verifyResidentPinInternal(houseNo, pin);
          logFeatureUsage("visitorboard", houseNo);
          const reportDate = String(body.reportDate || "").slice(0, 10) ||
            getTodayBangkokDate();
          const report = await buildDailyTrafficReport(reportDate, 0);
          res.status(200).json({
            ok: true,
            report: toVisitorBoardReport(report),
          });
          return;
        }
        await verifyAdminResidentAccess(body, "admin.audit");
        if (action === "run") {
          // Optional targetId override lets admins push a test card to the
          // sandbox group (e.g. Pattra Watch) instead of the live residents
          // group. Falls back to the configured daily_traffic target.
          const report = await runDailyTrafficReport(
              body.reportDate || getTodayBangkokDate(),
              body.sendLine !== false,
              String(body.targetId || "").trim(),
              String(body.themeName || "").trim(),
          );
          res.status(200).json({ok: true, report});
          return;
        }
        if (action === "latest") {
          const snap = await db.collection(LPR_DAILY_TRAFFIC_COLLECTION)
              .orderBy("reportDate", "desc")
              .limit(Math.min(Math.max(Number(body.limit || 7), 1), 31))
              .get();
          res.status(200).json({
            ok: true,
            reports: snap.docs.map((docSnap) => ({
              id: docSnap.id,
              ...docSnap.data(),
            })),
          });
          return;
        }
        if (action === "dailyLog") {
          // Read-only daily log for the committee /lprlog page. Builds the
          // report fresh for any date (incl. today) without sending LINE or
          // overwriting the stored report doc. Gated to admin.audit because
          // it exposes resident in/out movements. Uses startHour 0 so the
          // page shows the full calendar day 00:00–23:59 (incl. the
          // 00:00–07:00 night window that the LINE daily card excludes).
          await verifyAdminResidentAccess(body, "admin.audit");
          const reportDate = String(body.reportDate || "").slice(0, 10) ||
            getTodayBangkokDate();
          const report = await buildDailyTrafficReport(reportDate, 0);
          // Attach any human-entered review comment to each unreadable event.
          const ids = (report.unreadableEvents || [])
              .map((e) => e.eventId).filter(Boolean);
          if (ids.length) {
            const refs = ids.map((id) =>
              db.collection(LPR_UNREADABLE_LABELS_COLLECTION).doc(id));
            const snaps = await db.getAll(...refs);
            const byId = {};
            snaps.forEach((s) => {
              if (s.exists) byId[s.id] = s.data() || {};
            });
            report.unreadableEvents.forEach((e) => {
              const l = byId[e.eventId];
              e.comment = l ? (l.comment || "") : "";
            });
          }
          res.status(200).json({ok: true, report});
          return;
        }
        if (action === "searchPlate") {
          await verifyAdminResidentAccess(body, "admin.audit");
          const report = await buildPlateSearchReport(
              body.plate || body.q || "",
          );
          res.status(200).json({ok: true, report});
          return;
        }
        if (action === "searchHouse") {
          await verifyAdminResidentAccess(body, "admin.audit");
          const report = await buildHouseSearchReport(
              body.queryHouseNo || body.q || "",
          );
          res.status(200).json({ok: true, report});
          return;
        }
        if (action === "lprLabel") {
          // Save a committee reviewer's comment on one สแกนไม่พบ capture
          // (OCR training feedback). Keyed by eventId.
          await verifyAdminResidentAccess(body, "admin.audit");
          const eventId = String(body.eventId || "").trim();
          if (!eventId) {
            res.status(400).json({ok: false, error: "eventId required"});
            return;
          }
          await db.collection(LPR_UNREADABLE_LABELS_COLLECTION)
              .doc(eventId).set({
                eventId,
                comment: String(body.comment || "").slice(0, 1000),
                reportDate: String(body.reportDate || "").slice(0, 10),
                by: normalizeHouseNo(body.houseNo || body.adminHouseNo || ""),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              }, {merge: true});
          res.status(200).json({ok: true});
          return;
        }
        res.status(400).json({ok: false, error: "Invalid action"});
      } catch (error) {
        logger.error("dailyTrafficReport failed", error);
        res.status(error.status || 500).json({
          ok: false,
          error: error.message,
        });
      }
    },
);

// Night shift card (19:00 yesterday – 07:00 today), sent 15 minutes after
// the shift ends. reportDate is the morning the shift ends.
exports.overnightSecuritySummary = onSchedule(
    {
      schedule: "15 7 * * *",
      timeZone: "Asia/Bangkok",
      secrets: [LINE_CHANNEL_ACCESS_TOKEN],
      memory: "512MiB",
      timeoutSeconds: 120,
    },
    async () => {
      const report = await runOvernightSecurityReport(
          getTodayBangkokDate(),
          !REPORT_PUSH_PAUSED,
          NIGHT_SHIFT_START_HOUR,
          0,
          NIGHT_SHIFT_END_HOUR,
          0,
      );
      logger.info("overnightSecuritySummary complete", {
        reportDate: report.reportDate,
        window: report.windowLabel,
        externalCars: report.externalCars,
        lineSent: report.lineSent,
        pushPaused: REPORT_PUSH_PAUSED,
      });
    },
);

exports.guardAuditDaySummary = onSchedule(
    {
      schedule: "30 19 * * *",
      timeZone: "Asia/Bangkok",
      secrets: [LINE_CHANNEL_ACCESS_TOKEN],
      memory: "512MiB",
      timeoutSeconds: 120,
    },
    async () => {
      const report = await runSecurityAuditReport(
          getTodayBangkokDate(),
          !REPORT_PUSH_PAUSED,
          7,
          30,
          19,
          30,
      );
      logger.info("guardAuditDaySummary complete", {
        reportDate: report.reportDate,
        window: report.windowLabel,
        carTotal: report.carTotal,
        lprCarTotal: report.lprCarTotal,
        lprEventCount: report.trafficReport.eventCount,
        visitorOnlyCars: report.visitorOnlyCars,
        assessmentAvailable: report.assessmentAvailable,
        percent: report.percent,
        checkedCars: report.checkedCars,
        uncheckedCars: report.uncheckedCars,
        lineSent: report.lineSent,
        pushPaused: REPORT_PUSH_PAUSED,
      });
    },
);

exports.guardAuditNightSummary = onSchedule(
    {
      schedule: "30 7 * * *",
      timeZone: "Asia/Bangkok",
      secrets: [LINE_CHANNEL_ACCESS_TOKEN],
      memory: "512MiB",
      timeoutSeconds: 120,
    },
    async () => {
      const report = await runSecurityAuditReport(
          getYesterdayBangkokDate(),
          !REPORT_PUSH_PAUSED,
          19,
          30,
          7,
          30,
      );
      logger.info("guardAuditNightSummary complete", {
        reportDate: report.reportDate,
        window: report.windowLabel,
        carTotal: report.carTotal,
        lprCarTotal: report.lprCarTotal,
        lprEventCount: report.trafficReport.eventCount,
        visitorOnlyCars: report.visitorOnlyCars,
        assessmentAvailable: report.assessmentAvailable,
        percent: report.percent,
        checkedCars: report.checkedCars,
        uncheckedCars: report.uncheckedCars,
        lineSent: report.lineSent,
        pushPaused: REPORT_PUSH_PAUSED,
      });
    },
);

exports.overnightSecurityReport = onRequest(
    {
      secrets: [LINE_CHANNEL_ACCESS_TOKEN],
      memory: "512MiB",
      timeoutSeconds: 120,
    },
    async (req, res) => {
      setCorsHeaders(req, res);
      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }
      if (req.method !== "POST") {
        res.status(405).json({ok: false, error: "Method Not Allowed"});
        return;
      }
      try {
        const body = req.body || {};
        await verifyAdminResidentAccess(body, "admin.audit");
        const action = String(body.action || "run");
        if (action === "run") {
          const report = await runOvernightSecurityReport(
              body.reportDate || getTodayBangkokDate(),
              body.sendLine !== false,
              Number.isFinite(Number(body.startHour)) ?
                Number(body.startHour) : NIGHT_SHIFT_START_HOUR,
              Number.isFinite(Number(body.startMinute)) ?
                Number(body.startMinute) : 0,
              Number.isFinite(Number(body.endHour)) ?
                Number(body.endHour) : NIGHT_SHIFT_END_HOUR,
              Number.isFinite(Number(body.endMinute)) ?
                Number(body.endMinute) : 0,
          );
          res.status(200).json({ok: true, report});
          return;
        }
        if (action === "latest") {
          const snap = await db.collection(LPR_OVERNIGHT_COLLECTION)
              .orderBy("reportDate", "desc")
              .limit(Math.min(Math.max(Number(body.limit || 7), 1), 31))
              .get();
          res.status(200).json({
            ok: true,
            reports: snap.docs.map((docSnap) => ({
              id: docSnap.id,
              ...docSnap.data(),
            })),
          });
          return;
        }
        res.status(400).json({ok: false, error: "Invalid action"});
      } catch (error) {
        logger.error("overnightSecurityReport failed", error);
        res.status(error.status || 500).json({
          ok: false,
          error: error.message,
        });
      }
    },
);

/**
 * Manual trigger for the Pattra Watch reports (daily or night), guarded by
 * the LPR event token. Lets us regenerate / re-push a report on demand.
 * GET/POST ?token=...&type=daily|night|guardAudit&date=YYYY-MM-DD&
 *   sendLine=true&startHour=0&startMinute=0&endHour=7&endMinute=30&
 *   targetId=<registered LINE target>
 */
exports.lprWatchRun = onRequest(
    {
      secrets: [LINE_CHANNEL_ACCESS_TOKEN, LPR_EVENT_TOKEN, LPR_NVR_PASSWORD],
      memory: "512MiB",
      timeoutSeconds: 300,
    },
    async (req, res) => {
      const params = {...(req.query || {}), ...(req.body || {})};
      if (String(params.token || "") !== LPR_EVENT_TOKEN.value()) {
        res.status(403).json({ok: false, error: "Forbidden"});
        return;
      }
      try {
        const type = String(params.type || "daily");
        const date = String(params.date || getTodayBangkokDate());
        // `||` would turn a JSON boolean false into "true" and send anyway.
        const sendLine = String(
          params.sendLine === undefined ? "true" : params.sendLine,
        ) !== "false";
        let targetIdOverride = "";
        if (params.targetId) {
          const target = await resolveLineTarget(params.targetId);
          targetIdOverride = target.targetId;
        }
        if (type === "imagesync") {
          const result = await runLprImageSync();
          res.status(200).json({ok: true, type, result});
          return;
        }
        if (type === "guardAudit") {
          const report = await runSecurityAuditReport(
              date,
              sendLine,
              Number(params.startHour || 7),
              Number(params.startMinute || 30),
              Number(params.endHour || 19),
              Number(params.endMinute || 30),
              targetIdOverride,
              String(params.officerName || "").trim(),
          );
          res.status(200).json({ok: true, type, date, sendLine, report});
          return;
        }
        if (type === "vision") {
          const result = await runVisitorVisionBackfill(
              date, Number(params.limit || 10),
          );
          res.status(200).json({ok: true, type, date, result});
          return;
        }
        if (type === "paymentHeatmap") {
          const data = await buildPaymentHeatmapData({
            feeType: params.feeType,
            period: params.period,
            year: params.year,
          });
          const message = buildPaymentHeatmapFlexMessage(data);
          const targetId = targetIdOverride ||
            await resolveLineFlexTargetId("pattraPay");
          if (!targetId) {
            res.status(400).json({
              ok: false,
              error: "Pattra Pay LINE group is not set",
            });
            return;
          }
          if (sendLine) {
            await sendLinePushMessages(targetId, [message]);
          }
          res.status(200).json({
            ok: true,
            type,
            sendLine,
            targetId: maskTargetId(targetId),
            data,
            message: sendLine ? undefined : message,
          });
          return;
        }
        let report;
        if (type === "night") {
          const hourParam = (value, fallback) =>
            Number.isFinite(Number(value)) && value !== "" ?
              Number(value) : fallback;
          report = await runOvernightSecurityReport(
              date, sendLine,
              hourParam(params.startHour, NIGHT_SHIFT_START_HOUR),
              hourParam(params.startMinute, 0),
              hourParam(params.endHour, NIGHT_SHIFT_END_HOUR),
              hourParam(params.endMinute, 0),
              targetIdOverride,
          );
        } else {
          report = await runDailyTrafficReport(
              date, sendLine, targetIdOverride,
              String(params.theme || ""),
          );
        }
        res.status(200).json({ok: true, type, date, sendLine, report});
      } catch (error) {
        logger.error("lprWatchRun failed", error);
        res.status(500).json({
          ok: false,
          error: String(error.message || error),
        });
      }
    },
);

const LPR_NVR_BASE = "http://lpr.pattra8.com:8243";
const LPR_CAPTURES_PREFIX = "lpr_captures";

/**
 * Fetches an NVR ISAPI path using HTTP Digest auth (supports binary).
 * @param {string} path path with optional query string
 * @param {Object} [options] {method, headers, body, timeoutMs}
 * @return {Promise<Response>}
 */
async function nvrFetch(path, options = {}) {
  const url = `${LPR_NVR_BASE}${path}`;
  const method = options.method || "GET";
  const timeoutMs = options.timeoutMs || 20000;
  const first = await fetch(url, {
    method,
    headers: options.headers,
    body: options.body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (first.status !== 401) return first;
  // The NVR offers two challenges (MD5 and SHA-256) in one header; pick MD5
  // since buildDigestAuth computes an MD5 response.
  const rawAuth = first.headers.get("www-authenticate") || "";
  const blocks = [...rawAuth.matchAll(/Digest\s+(.*?)(?=,\s*Digest\s|$)/gis)]
      .map((m) => m[1]);
  const challenges = (blocks.length ? blocks : [rawAuth])
      .map((b) => parseDigestChallenge(b));
  const challenge = challenges.find((c) =>
    String(c.algorithm || "MD5").toUpperCase() === "MD5") || challenges[0];
  const auth = buildDigestAuth(challenge, {
    username: LPR_USER,
    password: LPR_NVR_PASSWORD.value(),
    method,
    uri: path,
  });
  return fetch(url, {
    method,
    headers: {"Authorization": auth, ...(options.headers || {})},
    body: options.body,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Returns Bangkok date/time parts for one epoch.
 * @param {number} epoch ms
 * @return {{date: string, hms: string, localZ: string}}
 */
function bangkokStamp(epoch) {
  const d = new Date(epoch);
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit",
    day: "2-digit",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit",
    second: "2-digit", hourCycle: "h23",
  }).format(d);
  return {date, hms: time.replace(/:/g, ""), localZ: `${date}T${time}Z`};
}

/**
 * Finds the NVR capture picture URL nearest to one event's time.
 * @param {Object} event lpr_traffic_events doc data
 * @return {Promise<Object|null>}
 */
async function findNvrPicture(event) {
  const track = event.direction === "exit" ? "2303" : "2203";
  const center = Number(event.capturedAtEpoch);
  const startZ = bangkokStamp(center - 10000).localZ;
  const endZ = bangkokStamp(center + 10000).localZ;
  const body = "<CMSearchDescription><searchID>" +
    "e1f2a3b4-0000-0000-0000-000000000001</searchID><trackIDList><trackID>" +
    `${track}</trackID></trackIDList><timeSpanList><timeSpan><startTime>` +
    `${startZ}</startTime><endTime>${endZ}</endTime></timeSpan>` +
    "</timeSpanList><maxResults>20</maxResults><searchResultPostion>0" +
    "</searchResultPostion></CMSearchDescription>";
  const resp = await nvrFetch("/ISAPI/ContentMgmt/search", {
    method: "POST",
    headers: {"Content-Type": "application/xml"},
    body,
  });
  const xml = await resp.text();
  const uris = [...xml.matchAll(/<playbackURI>([^<]+)<\/playbackURI>/g)]
      .map((m) => m[1].replace(/&amp;/g, "&"));
  if (!resp.ok || !uris.length) {
    logger.warn("findNvrPicture miss", {
      status: resp.status, plate: event.plate,
      xmlHead: xml.slice(0, 200),
    });
    return null;
  }
  const candidates = uris.map((uri) => {
    const match = decodeURIComponent(uri).match(
        /starttime=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/i,
    );
    if (!match) return {uri, deltaMs: null};
    const captureEpoch = Date.parse(
        `${match[1]}-${match[2]}-${match[3]}T` +
        `${match[4]}:${match[5]}:${match[6]}+07:00`,
    );
    return {
      uri,
      deltaMs: Number.isFinite(captureEpoch) ?
        Math.abs(captureEpoch - center) : null,
    };
  });
  candidates.sort((a, b) => {
    if (a.deltaMs === null) return 1;
    if (b.deltaMs === null) return -1;
    return a.deltaMs - b.deltaMs;
  });
  return candidates[0];
}

/**
 * Agent A image sync: for recent readable events without a stored image,
 * pulls the matching NVR capture and saves it to Firebase Storage, then
 * links it on the event document.
 * @return {Promise<{scanned: number, saved: number, missed: number}>}
 */
async function runLprImageSync() {
  const sinceEpoch = Date.now() - 24 * 60 * 60 * 1000;
  const snap = await db.collection(LPR_TRAFFIC_EVENTS_COLLECTION)
      .where("capturedAtEpoch", ">=", sinceEpoch)
      .get();
  const bucket = admin.storage().bucket();
  let saved = 0;
  let missed = 0;
  for (const docSnap of snap.docs) {
    const event = docSnap.data();
    // Sync images for readable AND unreadable (สแกนไม่พบ) events — the
    // unreadable captures are exactly what we want for OCR training review.
    if (event.imageStored ||
        Number(event.imageSyncAttempts || 0) >= 32) continue;
    try {
      const picture = await findNvrPicture(event);
      if (!picture) {
        await docSnap.ref.set({
          imageSyncAttempts: admin.firestore.FieldValue.increment(1),
          imageSyncLastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
          imageSyncLastError: "NVR picture not found",
        }, {merge: true});
        missed += 1;
        continue;
      }
      const path = picture.uri.replace(/^https?:\/\/[^/]+/, "");
      const imgResp = await nvrFetch(path, {timeoutMs: 60000});
      if (!imgResp.ok) {
        await docSnap.ref.set({
          imageSyncAttempts: admin.firestore.FieldValue.increment(1),
          imageSyncLastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
          imageSyncLastError: `NVR image HTTP ${imgResp.status}`,
        }, {merge: true});
        missed += 1;
        continue;
      }
      const buffer = Buffer.from(await imgResp.arrayBuffer());
      const stamp = bangkokStamp(Number(event.capturedAtEpoch));
      const dir = event.direction === "exit" ? "exit" : "entry";
      const plateLabel = event.plate || ("noplate-" + docSnap.id.slice(0, 8));
      const objectName = `${LPR_CAPTURES_PREFIX}/${stamp.date}/${dir}/` +
        `${stamp.hms}_${plateLabel}.jpg`;
      const imageToken = crypto.randomUUID();
      await bucket.file(objectName).save(buffer, {
        resumable: false,
        metadata: {
          contentType: "image/jpeg",
          metadata: {firebaseStorageDownloadTokens: imageToken},
        },
      });
      await docSnap.ref.set({
        imagePath: objectName,
        imageToken,
        imageStored: true,
        imageMatchDeltaMs: picture.deltaMs,
        imageSyncLastError: admin.firestore.FieldValue.delete(),
        imageSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
      saved += 1;
    } catch (error) {
      await docSnap.ref.set({
        imageSyncAttempts: admin.firestore.FieldValue.increment(1),
        imageSyncLastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
        imageSyncLastError: String(error.message || error).slice(0, 300),
      }, {merge: true});
      logger.warn("lprImageSync item failed", {
        id: docSnap.id, error: String(error.message || error),
      });
      missed += 1;
    }
  }
  logger.info("lprImageSync done", {scanned: snap.size, saved, missed});
  await db.doc(SYSTEM_HEALTH_CONFIG_PATH).set({
    imageSync: {
      lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
      lastRunEpoch: Date.now(),
      scanned: snap.size,
      saved,
      missed,
    },
  }, {merge: true});
  return {scanned: snap.size, saved, missed};
}

/**
 * Enriches unique Visitor plates from one Bangkok calendar day.
 * @param {string} reportDate
 * @param {number} limit
 * @return {Promise<Object>}
 */
async function runVisitorVisionBackfill(reportDate, limit = 10) {
  const range = getTrafficDayRange(reportDate);
  const [snap, expected] = await Promise.all([
    db.collection(LPR_TRAFFIC_EVENTS_COLLECTION)
        .where("capturedAtEpoch", ">=", range.startEpoch)
        .where("capturedAtEpoch", "<", range.endEpoch)
        .get(),
    buildExpectedLprState(),
  ]);
  const residentSet = new Set(expected.plates);
  const candidates = new Map();
  snap.docs.forEach((docSnap) => {
    const event = docSnap.data() || {};
    if (!isReadableLprEvent(event) || !event.imagePath ||
        residentSet.has(event.plate) || candidates.has(event.plate)) {
      return;
    }
    candidates.set(event.plate, {event, ref: docSnap.ref});
  });

  const selected = Array.from(candidates.values())
      .slice(0, Math.min(Math.max(limit, 1), 25));
  const results = [];
  for (const item of selected) {
    try {
      const vision = await enrichVisitorVehicle(item.event, item.ref);
      results.push({plate: item.event.plate, ok: true, vision});
    } catch (error) {
      logger.warn("Visitor vision backfill failed", {
        plate: item.event.plate,
        error: String(error.message || error),
      });
      results.push({
        plate: item.event.plate,
        ok: false,
        error: String(error.message || error).slice(0, 300),
      });
    }
  }
  return {
    candidates: candidates.size,
    processed: results.length,
    succeeded: results.filter((item) => item.ok).length,
    results,
  };
}

/**
 * Agent A scheduled image sync — runs every 15 minutes.
 */
exports.lprImageSync = onSchedule(
    {
      schedule: "*/15 * * * *",
      timeZone: "Asia/Bangkok",
      secrets: [LPR_NVR_PASSWORD],
      memory: "512MiB",
      timeoutSeconds: 300,
    },
    async () => {
      await runLprImageSync();
    },
);

/**
 * Retention purge for LPR capture images. Deletes Storage objects older than
 * LPR_IMAGE_RETENTION_DAYS and clears the image fields on the event document,
 * keeping the lightweight metadata that reports still read. Setting
 * imageStored:false drops each purged event out of the query on the next run,
 * and purged events sit far outside the 24h window lprImageSync scans, so they
 * are never re-fetched.
 * @return {Promise<{scanned: number, purged: number}>}
 */
async function runLprImagePurge() {
  const cutoffEpoch = Date.now() -
    LPR_IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const bucket = admin.storage().bucket();
  let scanned = 0;
  let purged = 0;
  // Normally trickles ~one day of captures per run; the batch loop only ever
  // matters if a backlog builds up (e.g. the cron was paused).
  for (let batch = 0; batch < 30; batch += 1) {
    const snap = await db.collection(LPR_TRAFFIC_EVENTS_COLLECTION)
        .where("imageStored", "==", true)
        .where("capturedAtEpoch", "<=", cutoffEpoch)
        .orderBy("capturedAtEpoch", "asc")
        .limit(200)
        .get();
    if (snap.empty) break;
    scanned += snap.size;
    for (const docSnap of snap.docs) {
      const event = docSnap.data() || {};
      if (event.imagePath) {
        await bucket.file(event.imagePath).delete({ignoreNotFound: true});
      }
      await docSnap.ref.set({
        imagePath: admin.firestore.FieldValue.delete(),
        imageToken: admin.firestore.FieldValue.delete(),
        imageStored: false,
        imagePurged: true,
        imagePurgedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
      purged += 1;
    }
    if (snap.size < 200) break;
  }
  logger.info("lprImagePurge done", {scanned, purged});
  return {scanned, purged};
}

/**
 * Retention cron — deletes LPR capture images older than 90 days.
 */
exports.lprImageCleanup = onSchedule(
    {
      schedule: "every day 03:40",
      timeZone: "Asia/Bangkok",
      memory: "512MiB",
      timeoutSeconds: 300,
    },
    async () => {
      await runLprImagePurge();
    },
);

/**
 * Agent A vision enrichment. Runs only when image sync first links a capture,
 * skips resident vehicles, and reuses the cached profile for repeat plates.
 */
exports.lprVehicleVision = onDocumentUpdated(
    {
      document: `${LPR_TRAFFIC_EVENTS_COLLECTION}/{eventId}`,
      memory: "512MiB",
      timeoutSeconds: 120,
    },
    async (event) => {
      const before = event.data && event.data.before.data() || {};
      const after = event.data && event.data.after.data() || {};
      const imageJustLinked = Boolean(after.imagePath) &&
        (!before.imagePath || before.imagePath !== after.imagePath);
      if (!imageJustLinked || !isReadableLprEvent(after)) return;

      const expected = await buildExpectedLprState();
      if (new Set(expected.plates).has(after.plate)) return;
      try {
        const vision = await enrichVisitorVehicle(
            after, event.data.after.ref,
        );
        logger.info("Visitor vehicle vision complete", {
          eventId: event.params.eventId,
          plate: after.plate,
          confidence: vision && vision.confidence,
        });
      } catch (error) {
        logger.warn("Visitor vehicle vision failed", {
          eventId: event.params.eventId,
          plate: after.plate,
          error: String(error.message || error),
        });
      }
    },
);

/**
 * Sends a deduplicated Agent C shadow alert to Pattra Watch only.
 * @param {string} fingerprint
 * @param {string} severity
 * @param {string} message
 * @param {boolean} healthAlert Independent operational alert to Pattra Watch.
 * @return {Promise<boolean>}
 */
async function sendAgentCShadowAlert(fingerprint, severity, message,
    healthAlert = false) {
  const configSnap = healthAlert ? null :
    await db.doc(LPR_AGENT_C_CONFIG_PATH).get();
  const config = configSnap && configSnap.exists ?
    configSnap.data() || {} : {};
  // Either switch opens the alert channel: the backlog monitor has to be able
  // to speak up while the Gemini audit half is off.
  const gateOpen = config.enabled === true ||
    config.backlogMonitorEnabled === true;
  if (!healthAlert && (!gateOpen || config.shadowMode !== true ||
      config.testTargetId !== LPR_AGENT_C_TEST_TARGET_ID)) {
    return false;
  }
  await resolveLineTarget(LPR_AGENT_C_TEST_TARGET_ID);
  const alertRef = db.collection(LPR_AGENT_C_ALERTS_COLLECTION)
      .doc(vehicleProfileDocId(fingerprint));
  const acquired = await db.runTransaction(async (transaction) => {
    const alertSnap = await transaction.get(alertRef);
    const previous = alertSnap.exists ? alertSnap.data() || {} : {};
    const cooldown = previous.cooldownUntil &&
      previous.cooldownUntil.toMillis ? previous.cooldownUntil.toMillis() : 0;
    if (healthAlert && previous.status === "open") return false;
    if (cooldown > Date.now()) return false;
    transaction.set(alertRef, {
      fingerprint,
      severity,
      message,
      status: "sending",
      count: admin.firestore.FieldValue.increment(1),
      lastSeen: admin.firestore.FieldValue.serverTimestamp(),
      cooldownUntil: admin.firestore.Timestamp.fromMillis(
          Date.now() + 30 * 60 * 1000,
      ),
    }, {merge: true});
    return true;
  });
  if (!acquired) return false;
  try {
    await sendLinePushMessages(LPR_AGENT_C_TEST_TARGET_ID, [{
      type: "text",
      text: `Agent C [${severity}]\n${message}`,
    }]);
  } catch (error) {
    await alertRef.set({
      status: "failed",
      cooldownUntil: admin.firestore.Timestamp.fromMillis(0),
    }, {merge: true});
    throw error;
  }
  await alertRef.set({
    status: "open",
    lineSentAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
  return true;
}

/**
 * Read-only camera/NVR health probe. It contains no configuration mutation.
 * @return {Promise<Object>}
 */
async function runAgentCHealthProbe() {
  const nowEpoch = Date.now();
  const cameraStatusRefs = ["8241", "8242", "nvr"].map((cameraId) =>
    db.collection(LPR_AGENT_C_STATUS_COLLECTION).doc(cameraId));
  const cameraStatusSnaps = await db.getAll(...cameraStatusRefs);
  const previousByCamera = Object.fromEntries(cameraStatusSnaps.map((snap) => [
    snap.id,
    snap.exists ? snap.data() || {} : {},
  ]));
  const latestByCamera = Object.fromEntries(["8241", "8242"].map(
      (cameraId) => [cameraId,
        Number(previousByCamera[cameraId].lastCaptureAtEpoch || 0)],
  ));
  const latestReceivedByCamera = Object.fromEntries(["8241", "8242"].map(
      (cameraId) => [cameraId,
        Number(previousByCamera[cameraId].lastEventReceivedAtEpoch || 0)],
  ));
  const probes = [];
  for (const cameraBase of LPR_CAMERAS) {
    const cameraId = (cameraBase.match(/:(\d+)$/) || [])[1] || cameraBase;
    const started = Date.now();
    let ok = false;
    let statusCode = 0;
    let error = "";
    let captureOk = false;
    let captureBytes = 0;
    let captureError = "";
    try {
      // Hard safety boundary: Agent C camera probes are GET-only.
      const result = await hikvisionFetch(
          cameraBase, "/ISAPI/System/deviceInfo", {method: "GET"},
      );
      statusCode = result.status;
      ok = result.status === 200;
    } catch (probeError) {
      error = String(probeError.message || probeError).slice(0, 300);
    }
    try {
      // deviceInfo can return 200 while the video/ANPR pipeline is hung
      // (seen 2026-07-04: exit camera served config fine but reset the
      // socket on every snapshot request for days). Fetch a real snapshot
      // so a hung pipeline fails the probe instead of looking healthy.
      const snap = await hikvisionFetchBinary(
          cameraBase, "/ISAPI/Streaming/channels/1/picture",
      );
      captureOk = snap.status === 200 && snap.bytes > 1000;
      captureBytes = snap.bytes;
      if (!captureOk) captureError = `capture status ${snap.status}`;
    } catch (captureProbeError) {
      captureError = String(captureProbeError.message || captureProbeError)
          .slice(0, 300);
    }
    ok = ok && captureOk;
    probes.push({cameraId, ok, statusCode, error,
      captureOk, captureBytes, captureError,
      latencyMs: Date.now() - started,
      lastCaptureAtEpoch: latestByCamera[cameraId] || null,
      lastEventReceivedAtEpoch: latestReceivedByCamera[cameraId] || null});
  }
  const nvrStarted = Date.now();
  let nvrOk = false;
  let nvrStatus = 0;
  let nvrError = "";
  try {
    // Hard safety boundary: Agent C NVR probe is GET-only.
    const response = await nvrFetch("/ISAPI/System/deviceInfo", {
      method: "GET", timeoutMs: 10000,
    });
    nvrStatus = response.status;
    nvrOk = response.ok;
  } catch (probeError) {
    nvrError = String(probeError.message || probeError).slice(0, 300);
  }
  probes.push({cameraId: "nvr", ok: nvrOk, statusCode: nvrStatus,
    error: nvrError, latencyMs: Date.now() - nvrStarted,
    lastEventReceivedAtEpoch: null});

  for (const probe of probes) {
    const ref = db.collection(LPR_AGENT_C_STATUS_COLLECTION)
        .doc(probe.cameraId);
    const previous = previousByCamera[probe.cameraId] || {};
    const failures = probe.ok ? 0 :
      Number(previous.consecutiveFailures || 0) + 1;
    const peerCameraId = probe.cameraId === "8241" ? "8242" :
      probe.cameraId === "8242" ? "8241" : "";
    const lastEventEpoch = Number(probe.lastCaptureAtEpoch || 0);
    const peerEventSequence = peerCameraId ?
      Number(previousByCamera[peerCameraId].eventSequence || 0) : 0;
    const peerEventsSince = peerCameraId ? accumulatePeerEvents({
      lastEventEpoch,
      observedLastEventEpoch: previous.observedLastEventEpoch,
      peerEventSequence,
      observedPeerEventSequence: previous.observedPeerEventSequence,
      previousPeerEvents: previous.peerEventsWhileStale,
    }) : 0;
    const eventStatus = peerCameraId && probe.ok ? anprEventStatus({
      nowEpoch,
      lastEventEpoch,
      peerLastEventEpoch: latestByCamera[peerCameraId],
      peerEventsSince,
    }) : "unknown";
    const eventStale = eventStatus === "warning" || eventStatus === "offline";
    const consecutiveEventStale = eventStale ?
      Number(previous.consecutiveEventStale || 0) + 1 : 0;
    const physicalFailureSinceEpoch = probe.ok ? 0 :
      Number(previous.physicalFailureSinceEpoch || nowEpoch);
    const outageState = peerCameraId ? nextAnprOutageState(previous, {
      nowEpoch, lastEventEpoch, eventStale: consecutiveEventStale >= 3,
      physicalFailure: failures >= 3, probeOk: probe.ok,
    }) : {};
    const severity = failures >= 3 ? "critical" :
      failures >= 2 ? "warning" : "healthy";
    await ref.set({
      cameraId: probe.cameraId,
      ok: probe.ok,
      statusCode: probe.statusCode,
      error: probe.error || "",
      captureOk: probe.cameraId === "nvr" ? null : probe.captureOk === true,
      captureBytes: Number(probe.captureBytes || 0),
      captureError: probe.captureError || "",
      latencyMs: probe.latencyMs,
      consecutiveFailures: failures,
      physicalFailureSinceEpoch,
      ...outageState,
      eventStatus,
      peerCameraId: peerCameraId || null,
      peerEventsSince,
      peerEventsWhileStale: peerEventsSince,
      observedLastEventEpoch: lastEventEpoch,
      observedPeerEventSequence: peerEventSequence,
      consecutiveEventStale,
      severity,
      lastProbeAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(probe.ok ? {
        lastSuccessAt: admin.firestore.FieldValue.serverTimestamp(),
      } : {}),
    }, {merge: true});
    if (!probe.ok && failures >= 2) {
      await sendAgentCShadowAlert(
          `probe-${probe.cameraId}-${physicalFailureSinceEpoch}-${severity}`,
          severity.toUpperCase(),
          `${probe.cameraId} probe ไม่ผ่าน ${failures} ครั้งติดต่อกัน\n` +
          "กรุณาตรวจสอบระบบ https://pattra8.com/system-health/",
          true,
      );
    }
    if (probe.ok && Number(previous.consecutiveFailures || 0) >= 2) {
      await sendAgentCShadowAlert(
          `recovered-${probe.cameraId}-` +
          `${previous.physicalFailureSinceEpoch || 0}`,
          "RECOVERED",
          `${probe.cameraId} API/ภาพกลับมาแล้ว ยังต้องตรวจ ANPR event`,
          true,
      );
    }
    if (eventStale && consecutiveEventStale >= 3) {
      const staleMinutes = Math.floor((nowEpoch - lastEventEpoch) / 60000);
      await sendAgentCShadowAlert(
          `anpr-stale-${probe.cameraId}-${lastEventEpoch}-${eventStatus}`,
          eventStatus === "offline" ? "CRITICAL" : "WARNING",
          `${probe.cameraId} ANPR event เงียบ ${staleMinutes} นาที ` +
          `แต่ ${peerCameraId} มี ${peerEventsSince} events ระหว่างนั้น\n` +
          `กรุณาตรวจสอบ/รีบูตกล้อง${probe.cameraId === "8242" ? "ขาออก" :
            "ขาเข้า"}\nhttps://pattra8.com/system-health/`,
          true,
      );
    }
    if (eventStatus === "online" &&
        lastEventEpoch > Number(previous.observedLastEventEpoch || 0) &&
        previous.activeAnprOutage && !outageState.activeAnprOutage) {
      await sendAgentCShadowAlert(
          `anpr-recovered-${probe.cameraId}-` +
          `${previous.activeAnprOutage.startEpoch}`,
          "RECOVERED",
          `${probe.cameraId} กลับมาส่ง ANPR event แล้ว`,
          true,
      );
    }
  }
  return {probes};
}

/**
 * Converts Firestore timestamps and epoch-like values to milliseconds.
 * @param {*} value
 * @return {number}
 */
function systemHealthEpoch(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  const numberValue = Number(value || 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

/**
 * Checks LINE's public incident feed and this OA's read-only API health.
 * @return {Promise<Object>}
 */
async function probeLineMessagingHealth() {
  const checkedEpoch = Date.now();
  const headers = {
    "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN.value()}`,
  };
  const requestOptions = {headers, signal: AbortSignal.timeout(6000)};
  const [statusResult, botResult, webhookResult] = await Promise.allSettled([
    fetch(
        "https://jncpmz37bpzt.statuspage.io/api/v2/incidents/unresolved.json",
        {signal: AbortSignal.timeout(6000)},
    ),
    fetch("https://api.line.me/v2/bot/info", requestOptions),
    fetch(
        "https://api.line.me/v2/bot/channel/webhook/endpoint",
        requestOptions,
    ),
  ]);

  let statusPageOk = false;
  let incident = null;
  if (statusResult.status === "fulfilled" && statusResult.value.ok) {
    statusPageOk = true;
    const payload = await statusResult.value.json().catch(() => ({}));
    const incidents = Array.isArray(payload.incidents) ?
      payload.incidents : [];
    const current = incidents.find((item) =>
      /messaging\s*api/i.test(String(item && item.name || "")),
    );
    if (current) {
      incident = {
        name: String(current.name || "LINE Messaging API incident"),
        status: String(current.status || "investigating"),
        impact: String(current.impact || ""),
        updatedAt: String(current.updated_at || ""),
        url: String(current.shortlink || current.url ||
          "https://api.line-status.info/"),
      };
    }
  }

  const botApiOk = botResult.status === "fulfilled" && botResult.value.ok;
  const webhookApiOk = webhookResult.status === "fulfilled" &&
    webhookResult.value.ok;
  let webhookActive = false;
  if (webhookApiOk) {
    const webhook = await webhookResult.value.json().catch(() => ({}));
    webhookActive = webhook.active === true;
  }
  const status = lineMessagingStatus({
    hasIncident: Boolean(incident && incident.status !== "monitoring"),
    isMonitoring: Boolean(incident && incident.status === "monitoring"),
    statusPageOk,
    botApiOk,
    webhookApiOk,
    webhookActive,
  });

  return {
    status,
    ok: status === "online",
    checkedEpoch,
    latencyMs: Date.now() - checkedEpoch,
    statusPageOk,
    botApiOk,
    webhookApiOk,
    webhookActive,
    incident,
  };
}

/**
 * Runs the read-only infrastructure probes and persists a safe status snapshot.
 * @return {Promise<Object>}
 */
async function runSystemHealthProbe() {
  const startedEpoch = Date.now();
  const [health, lineMessaging] = await Promise.all([
    runAgentCHealthProbe(),
    probeLineMessagingHealth(),
  ]);
  const statusRefs = health.probes.map((probe) =>
    db.collection(LPR_AGENT_C_STATUS_COLLECTION).doc(probe.cameraId),
  );
  const statusSnaps = statusRefs.length ? await db.getAll(...statusRefs) : [];
  const statusById = Object.fromEntries(statusSnaps.map((snap) => [
    snap.id,
    snap.exists ? snap.data() || {} : {},
  ]));
  const cameras = {};
  health.probes.forEach((probe) => {
    const saved = statusById[probe.cameraId] || {};
    const physicalStatus = probeStatus(
        probe.ok === true, saved.consecutiveFailures,
    );
    const eventStatus = saved.eventStatus || "unknown";
    // Traffic in the other lane cannot prove that this lane missed a car.
    // Keep device availability separate from uncertain ANPR freshness.
    const status = physicalStatus;
    cameras[probe.cameraId] = {
      cameraId: probe.cameraId,
      ok: probe.ok === true,
      status,
      apiOk: probe.statusCode === 200,
      snapshotOk: probe.cameraId === "nvr" ? null :
        probe.captureOk === true,
      snapshotBytes: Number(probe.captureBytes || 0),
      latencyMs: Number(probe.latencyMs || 0),
      consecutiveFailures: Number(saved.consecutiveFailures || 0),
      eventStatus,
      consecutiveEventStale: Number(saved.consecutiveEventStale || 0),
      peerEventsSince: Number(saved.peerEventsSince || 0),
      lastAnprEventEpoch: Number(probe.lastCaptureAtEpoch || 0),
      lastEventReceivedEpoch: Number(probe.lastEventReceivedAtEpoch || 0),
      checkedEpoch: startedEpoch,
    };
  });

  let storage = {status: "online", ok: true, checkedEpoch: startedEpoch};
  try {
    await admin.storage().bucket().getMetadata();
  } catch (error) {
    storage = {
      status: "offline",
      ok: false,
      checkedEpoch: startedEpoch,
      message: "Storage probe failed",
    };
  }

  await db.doc(SYSTEM_HEALTH_CONFIG_PATH).set({
    cameras,
    lineMessaging,
    storage,
    firestore: {
      status: "online",
      ok: true,
      checkedEpoch: startedEpoch,
    },
    lastProbeAt: admin.firestore.FieldValue.serverTimestamp(),
    lastProbeEpoch: startedEpoch,
  }, {merge: true});

  for (const cameraId of ["8241", "8242"]) {
    const rebootRef = db.collection(SYSTEM_HEALTH_REBOOTS_COLLECTION)
        .doc(cameraId);
    const rebootSnap = await rebootRef.get();
    const reboot = rebootSnap.exists ? rebootSnap.data() || {} : {};
    const requestedEpoch = systemHealthEpoch(reboot.requestedEpoch);
    const camera = cameras[cameraId];
    if (reboot.status === "rebooting" && camera && camera.ok &&
        startedEpoch > requestedEpoch + 15000) {
      await rebootRef.set({
        status: "completed",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        completedEpoch: startedEpoch,
      }, {merge: true});
    }
  }

  return {cameras, lineMessaging, storage, checkedEpoch: startedEpoch};
}

/**
 * Produces the president-facing status payload without secrets or raw errors.
 * @return {Promise<Object>}
 */
async function buildSystemHealthSummary() {
  const [stateSnap, rebootSnaps, dailySnap, nightSnap] = await Promise.all([
    db.doc(SYSTEM_HEALTH_CONFIG_PATH).get(),
    db.getAll(
        db.collection(SYSTEM_HEALTH_REBOOTS_COLLECTION).doc("8241"),
        db.collection(SYSTEM_HEALTH_REBOOTS_COLLECTION).doc("8242"),
    ),
    db.collection(LPR_DAILY_TRAFFIC_COLLECTION)
        .orderBy("reportDate", "desc").limit(1).get(),
    db.collection(LPR_OVERNIGHT_COLLECTION)
        .orderBy("reportDate", "desc").limit(1).get(),
  ]);
  const now = Date.now();
  const state = stateSnap.exists ? stateSnap.data() || {} : {};
  const rebootById = Object.fromEntries(rebootSnaps.map((snap) => [
    snap.id,
    snap.exists ? snap.data() || {} : {},
  ]));
  const cameraLabels = {
    "8241": "กล้องขาเข้า",
    "8242": "กล้องขาออก",
  };
  const cameras = ["8241", "8242"].map((cameraId) => {
    const camera = state.cameras && state.cameras[cameraId] || {};
    const reboot = rebootById[cameraId] || {};
    const requestedEpoch = systemHealthEpoch(reboot.requestedEpoch);
    const rebootRecent = reboot.status === "rebooting" &&
      requestedEpoch > now - 5 * 60 * 1000;
    // Normalize cached probes too: old freshness warnings are not evidence
    // that the device API or live image has failed.
    const deviceStatus = typeof camera.ok === "boolean" ?
      probeStatus(camera.ok, camera.consecutiveFailures) : "unknown";
    return {
      cameraId,
      label: cameraLabels[cameraId],
      status: rebootRecent ? "rebooting" : deviceStatus,
      apiOk: camera.apiOk === true,
      snapshotOk: camera.snapshotOk === true,
      snapshotBytes: Number(camera.snapshotBytes || 0),
      latencyMs: Number(camera.latencyMs || 0),
      eventStatus: camera.eventStatus || "unknown",
      consecutiveEventStale: Number(camera.consecutiveEventStale || 0),
      peerEventsSince: Number(camera.peerEventsSince || 0),
      lastAnprEventEpoch: Number(camera.lastAnprEventEpoch || 0),
      lastEventReceivedEpoch: Number(camera.lastEventReceivedEpoch || 0),
      checkedEpoch: Number(camera.checkedEpoch || 0),
      reboot: {
        status: reboot.status || "idle",
        requestedEpoch,
        completedEpoch: systemHealthEpoch(reboot.completedEpoch),
      },
    };
  });
  const imageSync = state.imageSync || {};
  const imageSyncStatus = heartbeatStatus(
      imageSync.lastRunEpoch,
      now,
      22 * 60 * 1000,
      40 * 60 * 1000,
  );
  const daily = dailySnap.empty ? {} : dailySnap.docs[0].data() || {};
  const night = nightSnap.empty ? {} : nightSnap.docs[0].data() || {};
  const nvr = state.cameras && state.cameras.nvr || {};
  const lineMessaging = state.lineMessaging || {};
  const lineIncident = lineMessaging.incident || null;
  const components = [
    {
      id: "lineMessaging",
      label: "LINE Messaging API",
      status: lineMessaging.status || "unknown",
      detail: lineIncident && lineIncident.name ?
        `LINE incident: ${lineIncident.name}` :
        lineMessaging.status === "online" ?
          "OA API และ Webhook พร้อมใช้งาน" :
          "LINE API, Webhook หรือหน้า Status ตอบผิดปกติ",
      checkedEpoch: Number(lineMessaging.checkedEpoch || 0),
      statusUrl: lineIncident && lineIncident.url ||
        "https://api.line-status.info/",
      external: true,
    },
    {
      id: "nvr",
      label: "NVR Recording",
      status: nvr.status || "unknown",
      detail: nvr.ok ? "เชื่อมต่อเครื่องบันทึกได้" : "รอตรวจสอบเครื่องบันทึก",
      checkedEpoch: Number(nvr.checkedEpoch || 0),
    },
    {
      id: "imageSync",
      label: "LPR Image Sync",
      status: Number(imageSync.missed || 0) > 0 ? "warning" :
        imageSyncStatus,
      detail: `รอบล่าสุด บันทึก ${Number(imageSync.saved || 0)} · ` +
        `พลาด ${Number(imageSync.missed || 0)}`,
      checkedEpoch: Number(imageSync.lastRunEpoch || 0),
    },
    {
      id: "firestore",
      label: "Firestore",
      status: state.firestore && state.firestore.status || "unknown",
      detail: "ฐานข้อมูลสถานะและ LPR events",
      checkedEpoch: Number(state.firestore &&
        state.firestore.checkedEpoch || 0),
    },
    {
      id: "storage",
      label: "Firebase Storage",
      status: state.storage && state.storage.status || "unknown",
      detail: "พื้นที่จัดเก็บภาพรถและเอกสาร",
      checkedEpoch: Number(state.storage && state.storage.checkedEpoch || 0),
    },
    {
      id: "dailyReport",
      label: "Daily Watch Report",
      status: daily.lineSent === true ? "online" :
        daily.lineError ? "warning" : "unknown",
      detail: daily.reportDate ? `รายงานล่าสุด ${daily.reportDate}` :
        "ยังไม่มีข้อมูลรายงาน",
      checkedEpoch: systemHealthEpoch(daily.updatedAt),
    },
    {
      id: "nightReport",
      label: "Night Watch Report",
      status: night.lineSent === true ? "online" :
        night.lineError ? "warning" : "unknown",
      detail: night.reportDate ? `รายงานล่าสุด ${night.reportDate}` :
        "ยังไม่มีข้อมูลรายงาน",
      checkedEpoch: systemHealthEpoch(night.updatedAt),
    },
  ];
  const healthStatuses = [
    ...cameras.map((camera) => camera.status === "rebooting" ?
      "warning" : camera.status),
    ...components.filter((component) => [
      "lineMessaging",
      "nvr",
      "imageSync",
      "firestore",
      "storage",
    ].includes(component.id)).map((component) => component.status),
  ];
  return {
    generatedEpoch: now,
    lastProbeEpoch: Number(state.lastProbeEpoch || 0),
    overallStatus: overallStatus(healthStatuses),
    cameras,
    components,
  };
}

/**
 * Verifies the authenticated account is the primary president account.
 * @param {Object} body
 * @return {Promise<Object>}
 */
async function verifySystemHealthPresident(body) {
  const access = await verifyAdminResidentAccess(body, "admin.portal");
  if (access.houseNo !== "38/8") {
    const error = new Error("Unauthorized");
    error.status = 403;
    throw error;
  }
  return access;
}

/**
 * Reboots one allowlisted ANPR camera with a five-minute cooldown.
 * @param {string} cameraId
 * @param {string} houseNo
 * @return {Promise<Object>}
 */
async function rebootSystemHealthCamera(cameraId, houseNo) {
  const cameraBases = {"8241": LPR_CAMERAS[0], "8242": LPR_CAMERAS[1]};
  const cameraBase = cameraBases[cameraId];
  if (!cameraBase) {
    const error = new Error("Camera is not allowlisted");
    error.status = 400;
    throw error;
  }
  const now = Date.now();
  const rebootRef = db.collection(SYSTEM_HEALTH_REBOOTS_COLLECTION)
      .doc(cameraId);
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(rebootRef);
    const previous = snap.exists ? snap.data() || {} : {};
    const previousEpoch = systemHealthEpoch(previous.requestedEpoch);
    if (previousEpoch > now - 5 * 60 * 1000) {
      const error = new Error("Camera reboot cooldown is active");
      error.status = 429;
      throw error;
    }
    transaction.set(rebootRef, {
      cameraId,
      status: "rebooting",
      requestedBy: houseNo,
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
      requestedEpoch: now,
    }, {merge: true});
  });

  try {
    const result = await hikvisionFetch(
        cameraBase,
        "/ISAPI/System/reboot",
        {method: "PUT"},
    );
    if (result.status !== 200 || !/<statusCode>1<\/statusCode>/.test(
        result.text || "")) {
      throw new Error(`Camera rejected reboot (${result.status})`);
    }
    writeAuditLog("system_health_camera_reboot", houseNo, {cameraId});
    return {cameraId, status: "rebooting", requestedEpoch: now};
  } catch (error) {
    await rebootRef.set({
      status: "failed",
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
      failedEpoch: Date.now(),
    }, {merge: true});
    writeAuditLog("system_health_camera_reboot", houseNo, {
      cameraId,
      reason: String(error.message || error).slice(0, 160),
    }, false);
    throw error;
  }
}

exports.systemHealthProbe = onSchedule(
    {
      schedule: "every 2 minutes",
      timeZone: "Asia/Bangkok",
      secrets: [LPR_ADMIN_PASSWORD, LPR_NVR_PASSWORD,
        LINE_CHANNEL_ACCESS_TOKEN],
      memory: "512MiB",
      timeoutSeconds: 90,
    },
    async () => {
      const result = await runSystemHealthProbe();
      logger.info("systemHealthProbe complete", {
        checkedEpoch: result.checkedEpoch,
        camera8241: result.cameras["8241"] &&
          result.cameras["8241"].status,
        camera8242: result.cameras["8242"] &&
          result.cameras["8242"].status,
      });
    },
);

exports.systemHealthAdmin = onRequest(
    {
      secrets: [LPR_ADMIN_PASSWORD, LPR_NVR_PASSWORD,
        LINE_CHANNEL_ACCESS_TOKEN],
      memory: "512MiB",
      timeoutSeconds: 120,
    },
    async (req, res) => {
      setCorsHeaders(req, res);
      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }
      if (req.method !== "POST") {
        res.status(405).json({ok: false, error: "Method Not Allowed"});
        return;
      }
      try {
        const body = req.body || {};
        const access = await verifySystemHealthPresident(body);
        const action = String(body.action || "summary").trim();
        if (action === "probe") {
          await runSystemHealthProbe();
        } else if (action === "reboot") {
          if (String(body.confirm || "") !== "REBOOT") {
            res.status(400).json({ok: false, error: "Confirmation required"});
            return;
          }
          const reboot = await rebootSystemHealthCamera(
              String(body.cameraId || ""), access.houseNo,
          );
          res.status(202).json({ok: true, reboot});
          return;
        } else if (action !== "summary") {
          res.status(400).json({ok: false, error: "Invalid action"});
          return;
        }
        res.status(200).json({
          ok: true,
          summary: await buildSystemHealthSummary(),
        });
      } catch (error) {
        logger.error("systemHealthAdmin failed", error);
        res.status(error.status || 500).json({
          ok: false,
          error: String(error.message || error),
        });
      }
    },
);

/**
 * Agent C ad-hoc runner. No timer — Agent C only runs when this endpoint is
 * called (token-guarded). type=health|freshness|daily|night|all.
 * e.g. /lprAgentCRun?token=...&type=freshness
 */
exports.lprAgentCRun = onRequest(
    {
      secrets: [LPR_ADMIN_PASSWORD, LPR_NVR_PASSWORD,
        LINE_CHANNEL_ACCESS_TOKEN, LPR_EVENT_TOKEN],
      memory: "1GiB",
      timeoutSeconds: 540,
    },
    async (req, res) => {
      const params = {...(req.query || {}), ...(req.body || {})};
      if (String(params.token || "") !== LPR_EVENT_TOKEN.value()) {
        res.status(403).json({ok: false, error: "Forbidden"});
        return;
      }
      try {
        const type = String(params.type || "freshness");
        const out = {};
        if (type === "health" || type === "all") {
          out.health = await runAgentCHealthProbe();
        }
        if (type === "freshness" || type === "all") {
          out.freshness = await runAgentCFreshnessAudit();
        }
        if (type === "daily" || type === "all") {
          out.daily = await runAgentCReportAudit(
              "daily", String(params.date || getYesterdayBangkokDate()));
        }
        if (type === "night" || type === "all") {
          out.night = await runAgentCReportAudit(
              "night", String(params.date || getTodayBangkokDate()));
        }
        res.status(200).json({ok: true, type, result: out});
      } catch (error) {
        logger.error("lprAgentCRun failed", error);
        res.status(500).json({
          ok: false,
          error: String(error.message || error),
        });
      }
    },
);

/**
 * Agent C blind audit trigger. It reads Storage and writes only Agent C data.
 */
exports.lprAgentCEventAudit = onDocumentUpdated(
    {
      document: `${LPR_TRAFFIC_EVENTS_COLLECTION}/{eventId}`,
      secrets: [LINE_CHANNEL_ACCESS_TOKEN],
      memory: "1GiB",
      timeoutSeconds: 120,
    },
    async (event) => {
      const before = event.data && event.data.before.data() || {};
      const after = event.data && event.data.after.data() || {};
      const imageJustLinked = Boolean(after.imagePath) &&
        (!before.imagePath || before.imagePath !== after.imagePath);
      if (!imageJustLinked) return;
      try {
        // The flag is checked before the resident scan, not alongside it:
        // buildExpectedLprState() reads the whole residents collection, and
        // running it in parallel meant every traffic event paid for that scan
        // even while Agent C was switched off.
        const configSnap = await db.doc(LPR_AGENT_C_CONFIG_PATH).get();
        const config = configSnap.exists ? configSnap.data() || {} : {};
        if (config.enabled !== true) return;
        const expected = await buildExpectedLprState();
        if (!shouldAgentCAudit(after, new Set(expected.plates))) {
          return;
        }
        const audit = await runAgentCEventAudit(event.data.after);
        if (audit.verdict === "image_mismatch") {
          await sendAgentCShadowAlert(
              `image-mismatch-${event.params.eventId}`,
              "REVIEW",
              `⚠️ ภาพไม่ตรง event\n` +
              `event ทะเบียน: ${audit.sourcePlate || "ไม่พบ"}\n` +
              `ภาพที่เก็บเป็น: ${audit.overlayPlate || "อ่านไม่ได้"}\n` +
              `(ระบบจับคู่ภาพคลาดเฟรม · audit ` +
              `${event.params.eventId.slice(0, 8)})`,
          );
        }
      } catch (error) {
        logger.warn("lprAgentCEventAudit failed", {
          eventId: event.params.eventId,
          error: String(error.message || error),
        });
      }
    },
);

/**
 * Agent C freshness/backlog scan plus bounded audit backfill.
 * @return {Promise<Object>}
 */
async function runAgentCFreshnessAudit() {
  const now = Date.now();
  const since = now - 24 * 60 * 60 * 1000;
  // Two independent switches. `backlogMonitorEnabled` covers the image-backlog
  // scan, which is plain Firestore work and safe to leave on; `enabled` gates
  // only the Gemini audit backfill below. They used to share one flag, so
  // switching off the vision spend also switched off backlog alerting.
  const configSnap = await db.doc(LPR_AGENT_C_CONFIG_PATH).get();
  const config = configSnap.exists ? configSnap.data() || {} : {};
  const visionEnabled = config.enabled === true;
  const backlogEnabled = config.backlogMonitorEnabled === true || visionEnabled;
  if (!backlogEnabled) {
    return {enabled: false, backlogMonitorEnabled: false};
  }
  const [snap, expected] = await Promise.all([
    db.collection(LPR_TRAFFIC_EVENTS_COLLECTION)
        .where("capturedAtEpoch", ">=", since)
        .get(),
    buildExpectedLprState(),
  ]);
  const residentSet = new Set(expected.plates);
  const readable = snap.docs.filter((docSnap) =>
    isReadableLprEvent(docSnap.data() || {}),
  );
  const missing30m = readable.filter((docSnap) => {
    const item = docSnap.data() || {};
    return !item.imagePath && Number(item.capturedAtEpoch || now) <
      now - 30 * 60 * 1000;
  });
  const withImages = !visionEnabled ? [] : readable.filter((docSnap) => {
    const item = docSnap.data() || {};
    return Boolean(item.imagePath) && shouldAgentCAudit(item, residentSet);
  });
  const auditRefs = withImages.map((docSnap) =>
    db.collection(LPR_AGENT_C_AUDITS_COLLECTION).doc(docSnap.id),
  );
  const auditSnaps = auditRefs.length ? await db.getAll(...auditRefs) : [];
  const unaudited = withImages.filter((docSnap, index) =>
    !auditSnaps[index].exists,
  ).slice(0, 3);
  const auditResults = [];
  for (const docSnap of unaudited) {
    try {
      const audit = await runAgentCEventAudit(docSnap);
      auditResults.push({eventId: docSnap.id, verdict: audit.verdict});
    } catch (error) {
      auditResults.push({eventId: docSnap.id, verdict: "error"});
    }
  }
  const date = getTodayBangkokDate();
  const dayRange = getTrafficDayRange(date);
  const dayAuditSnap = !visionEnabled ? {docs: [], size: 0} :
    await db.collection(LPR_AGENT_C_AUDITS_COLLECTION)
        .where("capturedAtEpoch", ">=", dayRange.startEpoch)
        .get();
  const verdicts = {pass: 0, image_mismatch: 0, unverifiable: 0};
  dayAuditSnap.docs.forEach((docSnap) => {
    const verdict = String((docSnap.data() || {}).verdict || "");
    if (Object.prototype.hasOwnProperty.call(verdicts, verdict)) {
      verdicts[verdict] += 1;
    }
  });
  const checked = verdicts.pass + verdicts.image_mismatch;
  const metrics = {
    date,
    recentEvents: snap.size,
    recentReadable: readable.length,
    recentImages: withImages.length,
    missingImageOver30m: missing30m.length,
    auditBackfillProcessed: auditResults.length,
    auditedToday: dayAuditSnap.size,
    verdicts,
    imageMismatches: verdicts.image_mismatch,
    imageIntegrityRate: checked ? verdicts.pass / checked : null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await db.collection(LPR_AGENT_C_METRICS_COLLECTION).doc(date)
      .set(metrics, {merge: true});
  if (missing30m.length >= 3) {
    await sendAgentCShadowAlert(
        "image-backlog-30m",
        "WARNING",
        `มี event อ่านได้แต่ภาพยังไม่มาเกิน 30 นาที ` +
          `${missing30m.length} รายการ`,
    );
  }
  if (verdicts.image_mismatch >= 3) {
    await sendAgentCShadowAlert(
        `image-mismatch-day-${date}`,
        "WARNING",
        `พบภาพไม่ตรง event ${verdicts.image_mismatch} รายการวันนี้ ` +
          `(ระบบจับคู่ภาพ/เวลาอาจคลาดเฟรม)`,
    );
  }
  return {...metrics, auditResults};
}

/**
 * Rebuilds one report window independently from Agent B's report builders.
 * @param {string} reportDate
 * @param {number} startHour
 * @param {number} endHour
 * @return {Promise<Object>}
 */
async function buildAgentCWindow(reportDate, startHour, endHour) {
  const startEpoch = Date.parse(
      `${reportDate}T${String(startHour).padStart(2, "0")}:00:00+07:00`,
  );
  const endEpoch = endHour === 24 ?
    startEpoch + 24 * 60 * 60 * 1000 :
    Date.parse(
        `${reportDate}T${String(endHour).padStart(2, "0")}:00:00+07:00`,
    );
  const [eventSnap, expected] = await Promise.all([
    db.collection(LPR_TRAFFIC_EVENTS_COLLECTION)
        .where("capturedAtEpoch", ">=", startEpoch)
        .where("capturedAtEpoch", "<", endEpoch)
        .get(),
    buildExpectedLprState(),
  ]);
  const residentSet = new Set(expected.plates);
  const events = eventSnap.docs.map((docSnap) => resolveLprPlate({
    id: docSnap.id,
    ...docSnap.data(),
  }, expected));
  const readable = events.filter(isReadableLprEvent);
  const unique = new Set(readable.map((item) => item.plate));
  const resident = new Set(readable
      .filter((item) => residentSet.has(item.plate))
      .map((item) => item.plate));
  const external = new Set(readable
      .filter((item) => !residentSet.has(item.plate))
      .map((item) => item.plate));
  const eventIdsHash = crypto.createHash("sha256")
      .update(events.map((item) => item.id).sort().join("|"))
      .digest("hex");
  return {
    reportDate,
    startHour,
    endHour,
    totalDetections: events.length,
    uniqueCars: unique.size,
    residentCars: resident.size,
    externalCars: external.size,
    unreadableDetections: events.length - readable.length,
    eventIdsHash,
  };
}

/**
 * Compares one independent Agent C window with Agent B's stored report.
 * @param {string} type daily|night
 * @param {string} reportDate
 * @return {Promise<Object>}
 */
async function runAgentCReportAudit(type, reportDate) {
  const night = type === "night";
  const rebuilt = await buildAgentCWindow(
      reportDate, 0, night ? 7 : 24,
  );
  const collection = night ? LPR_OVERNIGHT_COLLECTION :
    LPR_DAILY_TRAFFIC_COLLECTION;
  const [reportSnap, targetSnap] = await Promise.all([
    db.collection(collection).doc(reportDate).get(),
    db.doc(DAILY_TRAFFIC_CONFIG_PATH).get(),
  ]);
  const report = reportSnap.exists ? reportSnap.data() || {} : {};
  const target = targetSnap.exists ? targetSnap.data() || {} : {};
  const expectedTargetId = target.groupId || target.targetId || "";
  const fields = ["totalDetections", "uniqueCars", "residentCars",
    "externalCars", "unreadableDetections"];
  const deltas = Object.fromEntries(fields.map((field) => [
    field,
    Number(rebuilt[field] || 0) - Number(report[field] || 0),
  ]));
  const deliveryMismatch = report.lineSent !== true ||
    !expectedTargetId || report.lineTargetId !== expectedTargetId;
  const windowMismatch = night &&
    (Number(report.startHour) !== 0 || Number(report.endHour) !== 7);
  const mismatch = !reportSnap.exists || deliveryMismatch || windowMismatch ||
    Object.values(deltas).some((value) => value !== 0);
  const audit = {
    type,
    reportDate,
    rebuilt,
    agentBReportExists: reportSnap.exists,
    agentBLineSent: report.lineSent === true,
    agentBLineTargetId: report.lineTargetId || "",
    expectedTargetId,
    deliveryMismatch,
    windowMismatch,
    deltas,
    verdict: mismatch ? "review" : "pass",
    auditedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await db.collection(LPR_AGENT_C_REPORTS_COLLECTION)
      .doc(`${type}_${reportDate}`)
      .set(audit, {merge: true});
  if (mismatch) {
    await sendAgentCShadowAlert(
        `report-${type}-${reportDate}`,
        "REVIEW",
        `${type} ${reportDate} ยอด Agent B ไม่ตรง Agent C`,
    );
  }
  return audit;
}

// Kill switch for the retired public/private issue boards. Never turn this on
// again without re-reading the anonymity note in domains/issues/README.md.
const LEGACY_ISSUE_LINE_NOTIFY_ENABLED = false;

/**
 * Creates a Firestore trigger that sends LINE alerts.
 * @param {string} collectionPath
 * @param {string} issueType
 * @param {Function} [resolveTargetId]
 * @return {*}
 */
function createIssueNotifier(collectionPath, issueType, resolveTargetId) {
  return onDocumentCreated(
      {
        document: `${collectionPath}/{issueId}`,
        secrets: [LINE_CHANNEL_ACCESS_TOKEN],
      },
      async (event) => {
        // The old open issue board was retired in favour of `estate_issues`
        // (see domains/issues/README.md). These two exports stay declared so
        // the deployed export surface does not change, but they must never
        // push again: the committee asked for reports to be readable only in
        // the backend, and the legacy documents carried house numbers that
        // would now leak an anonymous report into a chat room. The source
        // collections are emptied by the archive migration, so this guard is
        // the second lock, not the only one.
        if (!LEGACY_ISSUE_LINE_NOTIFY_ENABLED) {
          logger.info("Legacy issue LINE notification disabled", {
            collectionPath,
          });
          return;
        }

        const snap = event.data;
        if (!snap) {
          logger.warn("No snapshot data for LINE notification");
          return;
        }

        const targetId = await (resolveTargetId || getLineTargetId)();
        if (!targetId) {
          logger.warn("LINE target not configured yet");
          return;
        }

        const payload = snap.data() || {};
        const text = buildLineMessage(issueType, payload);

        await sendLinePush(targetId, text);
        logger.info("LINE notification sent", {
          collectionPath,
          targetId,
          issueId: event.params.issueId,
        });
      },
  );
}

exports.notifyLinePublicIssue = createIssueNotifier(
    "issues",
    "มีรายการแจ้งปัญหาใหม่",
    getReportIssueTargetId,
);
exports.notifyLinePrivateIssue = createIssueNotifier(
    "private_issues",
    "มีรายการแจ้งปัญหาส่วนตัวใหม่",
);

// ── Resident-facing API (Phase 2) ──────────────────────────────────────────

exports.getResidentData = onRequest(
    {secrets: [GH_TOKEN_SECRET]},
    async (req, res) => {
      setCorsHeaders(req, res);
      if (req.method === "OPTIONS") {
        res.status(204).send(""); return;
      }
      if (req.method !== "POST") {
        res.status(405).json({ok: false, error: "Method Not Allowed"});
        return;
      }
      try {
        const body = req.body || {};
        const houseNo = normalizeHouseNo(body.houseNo);
        if (!houseNo) {
          res.status(400).json({ok: false, error: "Missing houseNo"});
          return;
        }
        await verifyResidentPinInternal(houseNo, String(body.pin || ""));
        const snap = await db
            .collection(RESIDENTS_COLLECTION)
            .doc(residentPinDocId(houseNo))
            .get();
        if (!snap.exists) {
          res.status(404).json({ok: false, error: "Resident not found"});
          return;
        }
        const r = snap.data() || {};
        // Shared by several pages (/data/, /vehicle/, a fresh login on
        // /myvisitor/, /myreceipt/, /visitorboard/, /parking/, ...) — an
        // explicit `feature` lets the page that actually shows this data as
        // its main content (not just a one-time login step) get its own
        // usage badge instead of everything collapsing into "data".
        const rawFeature = String(body.feature || "");
        const dataFeature = FEATURE_USAGE_FEATURES.has(rawFeature) ?
          rawFeature : "data";
        logFeatureUsage(dataFeature, houseNo);
        res.status(200).json({ok: true, resident: {
          house_no: r.house_no || houseNo,
          name: r.name || "",
          email: r.email || "",
          phone: r.phone || "",
          deed_no: r.deed_no || "",
          zone: r.zone || "",
          plot: r.plot || "",
          cars: r.cars || [],
          motorcycles: r.motorcycles || [],
          car_quota: parseCarQuota(r.car_quota),
          carQuota: getCarQuota(houseNo, r),
          last_updated: r.last_updated || "",
          vehicle_updated_at: r.vehicle_updated_at || {},
        }});
      } catch (err) {
        logger.error("getResidentData failed", err);
        res.status(err.status || 500).json({ok: false, error: err.message});
      }
    },
);

exports.updateResidentData = onRequest(
    {
      secrets: [LPR_ADMIN_PASSWORD],
      memory: "512MiB",
      timeoutSeconds: 60,
    },
    async (req, res) => {
      setCorsHeaders(req, res);
      if (req.method === "OPTIONS") {
        res.status(204).send(""); return;
      }
      if (req.method !== "POST") {
        res.status(405).json({ok: false, error: "Method Not Allowed"});
        return;
      }

      try {
        const body = req.body || {};
        const houseNo = normalizeHouseNo(body.houseNo);
        if (!houseNo) {
          res.status(400).json({ok: false, error: "Missing houseNo"});
          return;
        }
        await verifyResidentPinInternal(houseNo, String(body.pin || ""));

        const docRef = db
            .collection(RESIDENTS_COLLECTION)
            .doc(residentPinDocId(houseNo));
        const snap = await docRef.get();
        if (!snap.exists) {
          res.status(404).json({ok: false, error: "Resident not found"});
          return;
        }

        const oldData = snap.data() || {};
        const patch = {};
        const profile = body.profile || {};
        if (Object.prototype.hasOwnProperty.call(profile, "name")) {
          patch.name = String(profile.name || "").trim();
        }
        if (Object.prototype.hasOwnProperty.call(profile, "email")) {
          patch.email = String(profile.email || "").trim();
        }
        if (Object.prototype.hasOwnProperty.call(profile, "phone")) {
          patch.phone = String(profile.phone || "").trim();
        }

        const vehicles = body.vehicles || {};
        const touchesCars =
          Object.prototype.hasOwnProperty.call(vehicles, "cars");
        const touchesMotorcycles =
          Object.prototype.hasOwnProperty.call(vehicles, "motorcycles");
        if (touchesCars) {
          patch.cars = normalizePlateArray(vehicles.cars);
          // Quota check: allow edits/deletes on grandfathered data,
          // but block any increase beyond quota
          const quota = getCarQuota(houseNo, oldData);
          const oldCount = (oldData.cars || []).length;
          if (patch.cars.length > quota && patch.cars.length > oldCount) {
            res.status(400).json({
              ok: false,
              error: "car_quota_exceeded",
              quota,
              current: oldCount,
            });
            return;
          }
        }
        if (touchesMotorcycles) {
          patch.motorcycles = normalizePlateArray(vehicles.motorcycles);
        }

        if (!Object.keys(patch).length) {
          res.status(400).json({ok: false, error: "No changes submitted"});
          return;
        }

        const requestUpdatedAt = new Date().toISOString();
        const vehicleChange = body.vehicleChange || {};
        const vehicleType = vehicleChange.type === "car" ? "car" :
          vehicleChange.type === "moto" ? "moto" : "";
        const vehicleAction = ["add", "edit", "delete"].includes(
            vehicleChange.action,
        ) ? vehicleChange.action : "";
        const vehicleOriginal = normalizePlateArray([
          vehicleChange.originalPlate,
        ])[0] || "";
        const vehiclePlate = normalizePlateArray([
          vehicleChange.plate,
        ])[0] || "";
        const vehicleListTouched = vehicleType === "car" ? touchesCars :
          vehicleType === "moto" ? touchesMotorcycles : false;
        const oldVehicleList = vehicleType === "car" ?
          normalizePlateArray(oldData.cars) :
          normalizePlateArray(oldData.motorcycles);
        const nextVehicleList = vehicleType === "car" ?
          normalizePlateArray(patch.cars) :
          normalizePlateArray(patch.motorcycles);
        const timestamps = residentVehicleUpdatedAt(oldData);
        let vehicleTimestampChanged = false;
        if (vehicleListTouched && vehicleAction === "add" && vehiclePlate &&
            nextVehicleList.includes(vehiclePlate) &&
            !oldVehicleList.includes(vehiclePlate)) {
          timestamps[vehicleUpdatedAtKey(vehicleType, vehiclePlate)] =
            requestUpdatedAt;
          vehicleTimestampChanged = true;
        } else if (vehicleListTouched && vehicleAction === "edit" &&
            vehicleOriginal && vehiclePlate &&
            oldVehicleList.includes(vehicleOriginal) &&
            nextVehicleList.includes(vehiclePlate) &&
            (vehicleOriginal === vehiclePlate ||
              !nextVehicleList.includes(vehicleOriginal))) {
          delete timestamps[vehicleUpdatedAtKey(vehicleType, vehicleOriginal)];
          timestamps[vehicleUpdatedAtKey(vehicleType, vehiclePlate)] =
            requestUpdatedAt;
          vehicleTimestampChanged = true;
        } else if (vehicleListTouched && vehicleAction === "delete" &&
            vehicleOriginal && oldVehicleList.includes(vehicleOriginal) &&
            !nextVehicleList.includes(vehicleOriginal)) {
          delete timestamps[vehicleUpdatedAtKey(vehicleType, vehicleOriginal)];
          vehicleTimestampChanged = true;
        }
        if (vehicleTimestampChanged) {
          patch.vehicle_updated_at = timestamps;
        }

        patch.last_updated = requestUpdatedAt;
        patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        patch.updatedBy = "resident";
        patch.updatedByIp = req.ip || "";

        const changedFields = Object.keys(patch)
            .filter((key) => ![
              "last_updated",
              "vehicle_updated_at",
              "updatedAt",
              "updatedBy",
              "updatedByIp",
            ].includes(key))
            .filter((key) => !residentAuditValuesEqual(
                key, oldData[key], patch[key],
            ));
        let lprSync = null;
        if (touchesCars) {
          await docRef.set(patch, {merge: true});

          const allResidentsSnap = await db
              .collection(RESIDENTS_COLLECTION)
              .get();
          const allCars = [];
          allResidentsSnap.docs.forEach((residentDoc) => {
            if (residentDoc.id === residentPinDocId(houseNo)) return;
            const item = residentDoc.data() || {};
            normalizePlateArray(item.cars).forEach((plate) =>
              allCars.push(plate),
            );
          });
          normalizePlateArray(patch.cars || []).forEach((plate) =>
            allCars.push(plate),
          );
          lprSync = await syncLprCarDiff({
            houseNo,
            oldCars: oldData.cars || [],
            newCars: patch.cars || [],
            allCars,
          });
          await docRef.set({
            lpr_sync_pending: !lprSync.ok,
            lpr_last_sync: new Date().toISOString(),
          }, {merge: true});
        } else {
          await docRef.set(patch, {merge: true});
        }

        writeAuditLog("resident_update", houseNo, {
          ip: req.ip,
          changedFields,
          old: {
            name: oldData.name || "",
            email: oldData.email || "",
            phone: oldData.phone || "",
            cars: oldData.cars || [],
            motorcycles: oldData.motorcycles || [],
          },
          new: {
            name: Object.prototype.hasOwnProperty.call(patch, "name") ?
              patch.name : oldData.name || "",
            email: Object.prototype.hasOwnProperty.call(patch, "email") ?
              patch.email : oldData.email || "",
            phone: Object.prototype.hasOwnProperty.call(patch, "phone") ?
              patch.phone : oldData.phone || "",
            cars: Object.prototype.hasOwnProperty.call(patch, "cars") ?
              patch.cars : oldData.cars || [],
            motorcycles:
              Object.prototype.hasOwnProperty.call(patch, "motorcycles") ?
                patch.motorcycles : oldData.motorcycles || [],
          },
          lprSync,
        }, lprSync ? lprSync.ok : true);

        res.status(200).json({
          ok: true,
          houseNo,
          updated: changedFields,
          lprPending: lprSync ? !lprSync.ok : false,
          lprSync,
          vehicleUpdatedAt: patch.vehicle_updated_at ||
            oldData.vehicle_updated_at || {},
        });
      } catch (err) {
        logger.error("updateResidentData failed", err);
        res.status(err.status || 500).json({ok: false, error: err.message});
      }
    },
);

exports.submitRequest = onRequest(
    {secrets: [GH_TOKEN_SECRET]},
    async (req, res) => {
      setCorsHeaders(req, res);
      if (req.method === "OPTIONS") {
        res.status(204).send(""); return;
      }
      if (req.method !== "POST") {
        res.status(405).json({ok: false, error: "Method Not Allowed"});
        return;
      }
      try {
        const body = req.body || {};
        const houseNo = normalizeHouseNo(body.houseNo);
        if (!houseNo) {
          res.status(400).json({ok: false, error: "Missing houseNo"});
          return;
        }
        await verifyResidentPinInternal(houseNo, String(body.pin || ""));
        const title = String(body.title || "").trim();
        const issueBody = String(body.body || "").trim();
        const labels = Array.isArray(body.labels) ?
          body.labels.map(String) : ["vehicle"];
        if (!title) {
          res.status(400).json({ok: false, error: "Missing title"});
          return;
        }
        const ghRes = await fetch(
            `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues`,
            {
              method: "POST",
              headers: {
                "Authorization": `token ${GH_TOKEN_SECRET.value()}`,
                "Accept": "application/vnd.github.v3+json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({title, body: issueBody, labels}),
            },
        );
        if (!ghRes.ok) {
          const errText = await ghRes.text();
          throw new Error(
              `GitHub issue creation failed (${ghRes.status}): ${errText}`,
          );
        }
        const issue = await ghRes.json();
        writeAuditLog("submit_request", houseNo,
            {ip: req.ip, issue_number: issue.number});
        res.status(200).json({
          ok: true,
          issue_number: issue.number,
          issue_url: issue.html_url,
        });
      } catch (err) {
        logger.error("submitRequest failed", err);
        res.status(err.status || 500).json({ok: false, error: err.message});
      }
    },
);

exports.cancelRequest = onRequest(
    {secrets: [GH_TOKEN_SECRET]},
    async (req, res) => {
      setCorsHeaders(req, res);
      if (req.method === "OPTIONS") {
        res.status(204).send(""); return;
      }
      if (req.method !== "POST") {
        res.status(405).json({ok: false, error: "Method Not Allowed"});
        return;
      }
      try {
        const body = req.body || {};
        const houseNo = normalizeHouseNo(body.houseNo);
        const issueNumber = Number(body.issue_number);
        if (!houseNo || !issueNumber) {
          res.status(400).json({
            ok: false, error: "Missing houseNo or issue_number",
          });
          return;
        }
        await verifyResidentPinInternal(houseNo, String(body.pin || ""));
        const base = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}` +
          `/issues/${issueNumber}`;
        const headers = {
          "Authorization": `token ${GH_TOKEN_SECRET.value()}`,
          "Accept": "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        };
        await fetch(`${base}/comments`, {
          method: "POST", headers,
          body: JSON.stringify({body: "🚫 ยกเลิกคำร้องโดยเจ้าของบ้าน"}),
        });
        const closeRes = await fetch(base, {
          method: "PATCH", headers,
          body: JSON.stringify({state: "closed"}),
        });
        if (!closeRes.ok) {
          const errText = await closeRes.text();
          throw new Error(
              `GitHub close failed (${closeRes.status}): ${errText}`,
          );
        }
        writeAuditLog("cancel_request", houseNo,
            {ip: req.ip, issue_number: issueNumber});
        res.status(200).json({ok: true, issue_number: issueNumber});
      } catch (err) {
        logger.error("cancelRequest failed", err);
        res.status(err.status || 500).json({ok: false, error: err.message});
      }
    },
);

exports.getPendingRequests = onRequest(
    {secrets: [GH_TOKEN_SECRET]},
    async (req, res) => {
      setCorsHeaders(req, res);
      if (req.method === "OPTIONS") {
        res.status(204).send(""); return;
      }
      if (req.method !== "POST") {
        res.status(405).json({ok: false, error: "Method Not Allowed"});
        return;
      }
      try {
        const body = req.body || {};
        const houseNo = normalizeHouseNo(body.houseNo);
        if (!houseNo) {
          res.status(400).json({ok: false, error: "Missing houseNo"});
          return;
        }
        await verifyResidentPinInternal(houseNo, String(body.pin || ""));
        const ghRes = await fetch(
            `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}` +
            `/issues?labels=vehicle&state=open&per_page=30`,
            {
              headers: {
                "Authorization": `token ${GH_TOKEN_SECRET.value()}`,
                "Accept": "application/vnd.github.v3+json",
              },
            },
        );
        if (!ghRes.ok) {
          res.status(200).json({ok: true, issues: []});
          return;
        }
        const issues = await ghRes.json();
        const filtered = issues.filter((issue) => {
          if ((issue.title || "").includes(`บ้าน ${houseNo}`)) return true;
          try {
            const bm = (issue.body || "").match(/```json\s*([\s\S]*?)```/);
            if (bm) {
              const d = JSON.parse(bm[1]);
              if (normalizeHouseNo(d.house_no) === houseNo) return true;
            }
          } catch (_) {/* ignore parse errors */}
          return false;
        });
        res.status(200).json({ok: true, issues: filtered});
      } catch (err) {
        logger.error("getPendingRequests failed", err);
        res.status(err.status || 500).json({ok: false, error: err.message});
      }
    },
);

// ── Poll / Voting System ─────────────────────────────────────────────────────

exports.pollAction = onRequest(
    {secrets: [GH_TOKEN_SECRET]},
    async (req, res) => {
      setCorsHeaders(req, res);
      if (req.method === "OPTIONS") return res.status(204).send("");
      if (req.method !== "POST") {
        return res.status(405).json({ok: false, error: "POST only"});
      }
      const body = req.body || {};
      const {action} = body;

      // ── helpers ──────────────────────────────────────────────────────────
      const getPollRef = (pollId) =>
        db.collection(POLLS_COLLECTION).doc(pollId);

      try {
        // ── list (public) ───────────────────────────────────────────────
        if (action === "list") {
          const snap = await db.collection(POLLS_COLLECTION)
              .orderBy("createdAt", "desc")
              .limit(20)
              .get();
          const polls = snap.docs.map((d) => ({id: d.id, ...d.data()}));
          return res.status(200).json({ok: true, polls});
        }

        // ── create (admin) ──────────────────────────────────────────────
        if (action === "create") {
          await verifyAdminResidentAccess(body, "admin.vote");
          const poll = body.poll || {
            mode: "single",
            title: body.question,
            description: body.description || "",
            type: "single",
            options: Array.isArray(body.options) ? body.options : [],
            deadline: body.expiresAt || body.deadline || null,
          };
          if (!poll || !poll.title) {
            return res.status(400).json(
                {ok: false, error: "Missing poll title"});
          }

          const deadline = poll.deadline ?
            admin.firestore.Timestamp.fromDate(new Date(poll.deadline)) : null;

          // ── Phase 2: multi-question survey ──────────────────────────────
          if (poll.mode === "survey" &&
            (!Array.isArray(poll.questions) || poll.questions.length === 0)) {
            return res.status(400).json(
                {ok: false, error: "Survey must have at least 1 question"});
          }
          if (Array.isArray(poll.questions) && poll.questions.length > 0) {
            const VALID_Q_TYPES = [
              "single", "multi", "rating", "acknowledge",
              "text", "textarea", "dropdown",
            ];
            const questions = poll.questions.map((q, i) => {
              if (!q.type || !VALID_Q_TYPES.includes(q.type)) {
                throw Object.assign(
                    new Error(`Question ${i + 1}: invalid type "${q.type}"`),
                    {status: 400},
                );
              }
              const needsOptions =
                ["single", "multi", "dropdown"].includes(q.type);
              if (needsOptions &&
                (!Array.isArray(q.options) || q.options.length < 2)) {
                throw Object.assign(
                    new Error(
                        `Question ${i + 1}: options required for ${q.type}`),
                    {status: 400},
                );
              }
              return {
                id: String(q.id || `q${i + 1}`),
                label: String(q.label || "").slice(0, 300),
                type: q.type,
                required: Boolean(q.required !== false),
                options: needsOptions ?
                  q.options.map((o) => ({
                    label: String(o.label || o).slice(0, 100),
                    imageUrl: String(o.imageUrl || "").slice(0, 500),
                  })) : null,
                maxChoices: q.type === "multi" ?
                  (Number(q.maxChoices) || 2) : null,
                imageUrl: String(q.imageUrl || "").slice(0, 500),
              };
            });
            const docRef = await db.collection(POLLS_COLLECTION).add({
              title: String(poll.title).slice(0, 200),
              description: String(poll.description || "").slice(0, 1000),
              imageUrl: String(poll.imageUrl || "").slice(0, 500),
              mode: "survey",
              questions,
              deadline,
              totalHouses: Number(poll.totalHouses) || 68,
              status: "active",
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            return res.status(200).json({ok: true, pollId: docRef.id});
          }

          // ── Phase 1: single-question poll (backward compat) ─────────────
          if (!poll.type) {
            return res.status(400).json(
                {ok: false, error: "Missing poll type"});
          }
          const validTypes = ["single", "multi", "rating", "acknowledge"];
          if (!validTypes.includes(poll.type)) {
            return res.status(400).json(
                {ok: false, error: "Invalid poll type"});
          }
          const needsOptions = ["single", "multi"].includes(poll.type);
          if (needsOptions &&
            (!Array.isArray(poll.options) || poll.options.length < 2)) {
            return res.status(400).json({ok: false, error: "options required"});
          }
          const docRef = await db.collection(POLLS_COLLECTION).add({
            title: String(poll.title).slice(0, 200),
            description: String(poll.description || "").slice(0, 1000),
            imageUrl: String(poll.imageUrl || "").slice(0, 500),
            mode: "single",
            type: poll.type,
            options: needsOptions ?
              poll.options.map((o) => ({
                label: String(o.label || o).slice(0, 100),
                imageUrl: String(o.imageUrl || "").slice(0, 500),
              })) : null,
            maxChoices: poll.type === "multi" ?
              (Number(poll.maxChoices) || 2) : null,
            deadline,
            totalHouses: Number(poll.totalHouses) || 68,
            status: "active",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          return res.status(200).json({ok: true, pollId: docRef.id});
        }

        // ── close (admin) ───────────────────────────────────────────────
        if (action === "close") {
          await verifyAdminResidentAccess(body, "admin.vote");
          const {pollId} = body;
          if (!pollId) {
            return res.status(400).json(
                {ok: false, error: "Missing pollId"},
            );
          }
          await getPollRef(pollId).update({status: "closed"});
          return res.status(200).json({ok: true});
        }

        // ── delete (admin) ──────────────────────────────────────────────
        if (action === "delete") {
          await verifyAdminResidentAccess(body, "admin.vote");
          const {pollId} = body;
          if (!pollId) {
            return res.status(400).json(
                {ok: false, error: "Missing pollId"},
            );
          }
          const pollRef = getPollRef(pollId);
          const pollSnap = await pollRef.get();
          if (!pollSnap.exists) {
            return res.status(404).json({ok: false, error: "Poll not found"});
          }
          // Delete all votes subcollection first
          const votesSnap = await pollRef.collection("votes").get();
          const batch = db.batch();
          votesSnap.docs.forEach((d) => batch.delete(d.ref));
          batch.delete(pollRef);
          await batch.commit();
          writeAuditLog("poll_delete", "admin", {pollId, ip: req.ip});
          return res.status(200).json({ok: true});
        }

        // ── vote (PIN required) ─────────────────────────────────────────
        if (action === "vote") {
          const {houseNo, pin, pollId} = body;
          // answers = survey mode  |  choice = single-question mode
          const answers = body.answers;
          const choice = body.choice;
          if (!houseNo || !pin || !pollId) {
            return res.status(400).json(
                {ok: false, error: "Missing houseNo, pin, or pollId"},
            );
          }
          const normalizedHouseNo = normalizeHouseNo(houseNo);
          await verifyResidentPinInternal(houseNo, pin);
          const pollSnap = await getPollRef(pollId).get();
          if (!pollSnap.exists) {
            return res.status(404).json({ok: false, error: "Poll not found"});
          }
          const poll = pollSnap.data();
          if (poll.status !== "active") {
            return res.status(400).json({ok: false, error: "Poll is closed"});
          }
          const deadlineMs = poll.deadline ? poll.deadline.toMillis() : null;
          if (deadlineMs && Date.now() > deadlineMs) {
            await getPollRef(pollId).update({status: "closed"});
            return res.status(400).json(
                {ok: false, error: "Poll deadline has passed"});
          }
          const voteDocId = residentPinDocId(houseNo);
          const voteRef = getPollRef(pollId).collection("votes").doc(voteDocId);
          const existing = await voteRef.get();
          if (existing.exists) {
            return res.status(409).json({ok: false, error: "already_voted"});
          }

          // ── helper: validate one question answer ───────────────────────
          const validateAnswer = (q, ans) => {
            const optionLabels = (q.options || []).map((o) =>
              typeof o === "object" ? o.label : String(o));
            if (q.type === "acknowledge") return true;
            if (q.type === "single") {
              return optionLabels.includes(String(ans));
            }
            if (q.type === "multi") {
              return Array.isArray(ans) && ans.length > 0 &&
                ans.length <= (q.maxChoices || 99) &&
                ans.every((a) => optionLabels.includes(String(a)));
            }
            if (q.type === "rating") {
              const r = Number(ans);
              return Number.isInteger(r) && r >= 1 && r <= 5;
            }
            if (q.type === "dropdown") {
              return optionLabels.includes(String(ans));
            }
            if (q.type === "text" || q.type === "textarea") {
              return typeof ans === "string" && ans.trim().length <= 1000;
            }
            return false;
          };

          // ── survey mode (multi-question) ───────────────────────────────
          if (poll.mode === "survey") {
            if (!answers || typeof answers !== "object") {
              return res.status(400).json(
                  {ok: false, error: "Missing answers"});
            }
            for (const q of poll.questions || []) {
              const ans = answers[q.id];
              const empty = ans === undefined || ans === null || ans === "";
              if (q.required !== false && empty) {
                return res.status(400).json(
                    {ok: false, error: `Question "${q.label}" is required`});
              }
              if (ans !== undefined && ans !== null && ans !== "") {
                if (!validateAnswer(q, ans)) {
                  return res.status(400).json(
                      {ok: false, error: `Invalid answer for "${q.label}"`});
                }
              }
            }
          } else {
            // ── single-question mode ─────────────────────────────────────
            if (poll.type === "acknowledge") {
              // Force canonical value — reject any other string
              if (choice !== undefined && choice !== null &&
                  choice !== "acknowledged") {
                return res.status(400).json(
                    {ok: false, error: "Invalid choice for acknowledge poll"});
              }
            } else {
              if (choice === undefined) {
                return res.status(400).json(
                    {ok: false, error: "Missing choice"});
              }
              const optionLabels = (poll.options || []).map((o) =>
                typeof o === "object" ? o.label : String(o));
              if (poll.type === "single" || poll.type === "dropdown") {
                if (!optionLabels.includes(String(choice))) {
                  return res.status(400).json(
                      {ok: false, error: "Invalid choice"});
                }
              } else if (poll.type === "multi") {
                if (
                  !Array.isArray(choice) || choice.length === 0 ||
                  choice.length > (poll.maxChoices || 2) ||
                  !choice.every((c) => optionLabels.includes(String(c)))
                ) {
                  return res.status(400).json(
                      {ok: false, error: "Invalid choice"});
                }
              } else if (poll.type === "rating") {
                const r = Number(choice);
                if (!Number.isInteger(r) || r < 1 || r > 5) {
                  return res.status(400).json(
                      {ok: false, error: "Rating must be 1-5"});
                }
              }
            }
          }

          // ── save signature ─────────────────────────────────────────────
          const signatureRef = getResidentSignatureRef(normalizedHouseNo);
          const signatureSnap = await signatureRef.get();
          let signatureReused = signatureSnap.exists;
          if (!signatureSnap.exists) {
            const signatureDataUrl =
              normalizeSignatureDataUrl(body.signatureDataUrl);
            await signatureRef.set({
              houseNo: normalizedHouseNo,
              signatureDataUrl,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              source: "vote",
            });
            signatureReused = false;
          }

          // Normalise choice for acknowledge type
          const finalChoice = poll.type === "acknowledge" ?
            "acknowledged" : choice;
          await voteRef.set({
            houseNo: normalizedHouseNo,
            ...(poll.mode === "survey" ? {answers} : {choice: finalChoice}),
            votedAt: admin.firestore.FieldValue.serverTimestamp(),
            signedAt: admin.firestore.FieldValue.serverTimestamp(),
            signatureRef: `${RESIDENT_SIGNATURE_COLLECTION}/${voteDocId}`,
            signatureReused,
            ip: req.ip || "",
          });
          await writeAuditLog("poll_vote", houseNo, {pollId, ip: req.ip}, true);
          return res.status(200).json({ok: true});
        }

        // ── signatureStatus (PIN required) ──────────────────────────────
        if (action === "signatureStatus") {
          const {houseNo, pin, pollId} = body;
          if (!houseNo || !pin || !pollId) {
            return res.status(400).json(
                {ok: false, error: "Missing fields"},
            );
          }
          const normalizedHouseNo = normalizeHouseNo(houseNo);
          await verifyResidentPinInternal(normalizedHouseNo, pin);
          const voteDocId = residentPinDocId(normalizedHouseNo);
          const voteSnap = await getPollRef(pollId)
              .collection("votes")
              .doc(voteDocId)
              .get();
          if (voteSnap.exists) {
            const vd = voteSnap.data() || {};
            return res.status(200).json({
              ok: true, alreadyVoted: true,
              choice: vd.choice, answers: vd.answers,
            });
          }
          const signatureSnap =
            await getResidentSignatureRef(normalizedHouseNo).get();
          const signature = signatureSnap.exists ?
            signatureSnap.data() || {} :
            null;
          return res.status(200).json({
            ok: true,
            alreadyVoted: false,
            hasSignature: Boolean(signature),
            signatureDataUrl: signature ? signature.signatureDataUrl || "" : "",
          });
        }

        // ── hasVoted (PIN required) ─────────────────────────────────────
        if (action === "hasVoted") {
          const {houseNo, pin, pollId} = body;
          if (!houseNo || !pin || !pollId) {
            return res.status(400).json(
                {ok: false, error: "Missing fields"},
            );
          }
          await verifyResidentPinInternal(houseNo, pin);
          const voteDocId = residentPinDocId(houseNo);
          const voteSnap = await getPollRef(pollId)
              .collection("votes")
              .doc(voteDocId)
              .get();
          if (voteSnap.exists) {
            const vd = voteSnap.data() || {};
            return res.status(200).json({
              ok: true, voted: true,
              choice: vd.choice, answers: vd.answers,
            });
          }
          return res.status(200).json({ok: true, voted: false});
        }

        // ── myVotes (PIN required): one request for all poll-card statuses ──
        if (action === "myVotes") {
          const {houseNo, pin} = body;
          if (!houseNo || !pin) {
            return res.status(400).json(
                {ok: false, error: "Missing houseNo or pin"},
            );
          }
          const normalizedHouseNo = normalizeHouseNo(houseNo);
          await verifyResidentPinInternal(normalizedHouseNo, pin);
          const voteDocId = residentPinDocId(normalizedHouseNo);
          const [snap, residentSnap] = await Promise.all([
            db.collection(POLLS_COLLECTION)
                .orderBy("createdAt", "desc")
                .limit(50)
                .get(),
            db.collection(RESIDENTS_COLLECTION).doc(voteDocId).get(),
          ]);
          const residentData = residentSnap.exists ?
            residentSnap.data() : {};
          const votes = {};
          await Promise.all(snap.docs.map(async (pollDoc) => {
            const voteSnap = await pollDoc.ref
                .collection("votes")
                .doc(voteDocId)
                .get();
            if (voteSnap.exists) {
              const vote = voteSnap.data() || {};
              votes[pollDoc.id] = {
                voted: true,
                choice: vote.choice,
                answers: vote.answers,
                votedAt: vote.votedAt || null,
              };
            }
          }));
          return res.status(200).json({
            ok: true,
            houseNo: normalizedHouseNo,
            residentName: residentData.name || "",
            votes,
          });
        }

        // ── results (closed OR admin) ───────────────────────────────────
        if (action === "results") {
          const {pollId} = body;
          if (!pollId) {
            await verifyAdminResidentAccess(body, "admin.vote");
            const snap = await db.collection(POLLS_COLLECTION)
                .orderBy("createdAt", "desc")
                .limit(50)
                .get();
            const polls = await Promise.all(snap.docs.map(async (pollDoc) => {
              const poll = {
                id: pollDoc.id,
                pollId: pollDoc.id,
                ...pollDoc.data(),
              };
              const votesSnap = await pollDoc.ref.collection("votes").get();
              const counts = {};
              votesSnap.docs.forEach((voteDoc) => {
                const vote = voteDoc.data() || {};
                const choice = vote.choice;
                if (Array.isArray(choice)) {
                  choice.forEach((c) => {
                    counts[String(c)] = (counts[String(c)] || 0) + 1;
                  });
                } else if (choice !== undefined && choice !== null) {
                  counts[String(choice)] = (counts[String(choice)] || 0) + 1;
                }
              });
              const optionList = (poll.options || []).map((option) => {
                const label = typeof option === "object" ?
                  String(option.label || option.text || "") : String(option);
                return {label, text: label, votes: counts[label] || 0};
              });
              return {
                ...poll,
                question: poll.title || poll.question || "",
                options: optionList,
                createdAt: poll.createdAt && poll.createdAt.toDate ?
                  poll.createdAt.toDate().toISOString() : poll.createdAt || "",
                expiresAt: poll.deadline && poll.deadline.toDate ?
                  poll.deadline.toDate().toISOString() : poll.expiresAt || "",
              };
            }));
            return res.status(200).json({ok: true, polls});
          }
          if (!pollId) {
            return res.status(400).json(
                {ok: false, error: "Missing pollId"},
            );
          }
          const pollSnap = await getPollRef(pollId).get();
          if (!pollSnap.exists) {
            return res.status(404).json(
                {ok: false, error: "Poll not found"},
            );
          }
          const poll = {id: pollSnap.id, ...pollSnap.data()};
          const now = Date.now();
          const deadlinePassed =
            poll.deadline && poll.deadline.toMillis() < now;
          const closed =
            poll.status === "closed" || deadlinePassed;
          let adminViewer = false;
          try {
            await verifyAdminResidentAccess(body, "admin.vote");
            adminViewer = true;
          } catch (err) {
            adminViewer = false;
          }
          if (!closed && !adminViewer) {
            return res.status(403).json(
                {ok: false, error: "poll_not_closed"},
            );
          }
          const votesSnap = await getPollRef(pollId)
              .collection("votes")
              .get();
          const total = votesSnap.size;
          // counts: single-question → {option:n}
          // survey → {qId: {option:n}}
          const counts = {};
          const voteRows = [];
          await Promise.all(votesSnap.docs.map(async (d) => {
            const vote = d.data() || {};
            const rowHouseNo = normalizeHouseNo(vote.houseNo || "");
            const voteDocId = residentPinDocId(rowHouseNo);
            const [residentSnap, signatureSnap] = await Promise.all([
              rowHouseNo ?
                db.collection(RESIDENTS_COLLECTION).doc(voteDocId).get() :
                Promise.resolve(null),
              vote.signatureRef ?
                db.doc(vote.signatureRef).get() :
                getResidentSignatureRef(rowHouseNo).get(),
            ]);
            const resident = residentSnap && residentSnap.exists ?
              residentSnap.data() || {} : {};
            const signature = signatureSnap && signatureSnap.exists ?
              signatureSnap.data() || {} : {};

            if (poll.mode === "survey") {
              // Aggregate per-question counts
              const ans = vote.answers || {};
              for (const q of poll.questions || []) {
                if (!counts[q.id]) counts[q.id] = {};
                const a = ans[q.id];
                if (a === undefined || a === null) continue;
                if (q.type === "acknowledge") {
                  counts[q.id]["ทราบแล้ว"] =
                    (counts[q.id]["ทราบแล้ว"] || 0) + 1;
                } else if (q.type === "multi" && Array.isArray(a)) {
                  a.forEach((c) => {
                    counts[q.id][c] = (counts[q.id][c] || 0) + 1;
                  });
                } else if (q.type === "rating") {
                  const k = String(a);
                  counts[q.id][k] = (counts[q.id][k] || 0) + 1;
                } else if (q.type === "text" || q.type === "textarea") {
                  // store raw texts array for admin
                  if (!counts[q.id].__texts) counts[q.id].__texts = [];
                  counts[q.id].__texts.push({houseNo: rowHouseNo, text: a});
                } else {
                  counts[q.id][String(a)] = (counts[q.id][String(a)] || 0) + 1;
                }
              }
              voteRows.push({
                houseNo: rowHouseNo,
                residentName: resident.name || "",
                answers: vote.answers,
                votedAt: vote.votedAt || null,
                signatureDataUrl: signature.signatureDataUrl || "",
                signatureReused: Boolean(vote.signatureReused),
              });
            } else {
              const {choice} = vote;
              voteRows.push({
                houseNo: rowHouseNo,
                residentName: resident.name || "",
                choice,
                votedAt: vote.votedAt || null,
                signedAt: vote.signedAt || null,
                signatureRef: vote.signatureRef || "",
                signatureDataUrl: signature.signatureDataUrl || "",
                signatureReused: Boolean(vote.signatureReused),
              });
              if (poll.type === "acknowledge") {
                counts["ทราบแล้ว"] = (counts["ทราบแล้ว"] || 0) + 1;
              } else if (poll.type === "multi" && Array.isArray(choice)) {
                choice.forEach((c) => {
                  counts[c] = (counts[c] || 0) + 1;
                });
              } else if (poll.type === "rating") {
                counts[String(choice)] = (counts[String(choice)] || 0) + 1;
              } else {
                counts[String(choice)] = (counts[String(choice)] || 0) + 1;
              }
            }
          }));
          const totalHouses = poll.totalHouses || 68;
          const participationPct = totalHouses > 0 ?
            Math.round((total / totalHouses) * 100) : 0;
          return res.status(200).json({
            ok: true,
            poll,
            results: {counts, total, totalHouses, participationPct},
            votes: adminViewer ? voteRows : undefined,
          });
        }

        return res.status(400).json({ok: false, error: "Unknown action"});
      } catch (err) {
        logger.error("pollAction failed", err);
        res.status(err.status || 500).json({ok: false, error: err.message});
      }
    },
);

// ── Lifestyle Survey ─────────────────────────────────────────────────────────

const VALID_AGE_GROUPS = new Set(["child", "teen", "adult", "elderly"]);
const VALID_PETS = new Set(["dog", "cat", "other", "none"]);
const VALID_ACTIVITIES = new Set([
  "garden", "fitness", "pool", "running", "other",
]);
const VALID_WORKSHOPS = new Set([
  "massage", "yoga", "stretching", "weight", "soundbath",
  "painting", "pottery", "candle", "soap", "perfume", "macrame",
  "flower", "gardening", "photo", "gift", "boardgame", "wine",
]);

exports.getLifestyleSurvey = onRequest(async (req, res) => {
  if (!prepareJsonRequest(req, res)) return;
  try {
    const body = req.body || {};
    const houseNo = normalizeHouseNo(body.houseNo);
    if (!houseNo) {
      res.status(400).json({ok: false, error: "Missing houseNo"});
      return;
    }
    await verifyResidentPinInternal(houseNo, String(body.pin || ""));
    const snap = await db
        .collection(LIFESTYLE_SURVEY_COLLECTION)
        .doc(residentPinDocId(houseNo))
        .get();
    res.status(200).json({
      ok: true,
      survey: snap.exists ? snap.data() : null,
    });
  } catch (err) {
    logger.error("getLifestyleSurvey failed", err);
    sendLegacyError(res, err);
  }
});

exports.updateLifestyleSurvey = onRequest(async (req, res) => {
  if (!prepareJsonRequest(req, res)) return;
  try {
    const body = req.body || {};
    const houseNo = normalizeHouseNo(body.houseNo);
    if (!houseNo) {
      res.status(400).json({ok: false, error: "Missing houseNo"});
      return;
    }
    await verifyResidentPinInternal(houseNo, String(body.pin || ""));

    const ts = admin.firestore.FieldValue.serverTimestamp();
    const payload = {houseNo, updatedAt: ts};

    if (body.occupants !== undefined) {
      const occ = Number(body.occupants);
      if (!Number.isInteger(occ) || occ < 1 || occ > 8) {
        res.status(400).json({ok: false, error: "Invalid occupants"});
        return;
      }
      payload.occupants = occ;
    }
    if (body.ageGroups !== undefined) {
      const ag = body.ageGroups;
      if (!Array.isArray(ag) || ag.some((v) => !VALID_AGE_GROUPS.has(v))) {
        res.status(400).json({ok: false, error: "Invalid ageGroups"});
        return;
      }
      payload.ageGroups = ag;
    }
    if (body.pets !== undefined) {
      const p = body.pets;
      if (!Array.isArray(p) || p.some((v) => !VALID_PETS.has(v))) {
        res.status(400).json({ok: false, error: "Invalid pets"});
        return;
      }
      payload.pets = p;
    }
    if (body.activities !== undefined) {
      const ac = body.activities;
      if (!Array.isArray(ac) || ac.some((v) => !VALID_ACTIVITIES.has(v))) {
        res.status(400).json({ok: false, error: "Invalid activities"});
        return;
      }
      payload.activities = ac;
    }
    if (body.workshops !== undefined) {
      const ws = body.workshops;
      if (!Array.isArray(ws) || ws.some((v) => !VALID_WORKSHOPS.has(v))) {
        res.status(400).json({ok: false, error: "Invalid workshops"});
        return;
      }
      payload.workshops = ws;
    }
    if (body.workshopSuggestion !== undefined) {
      payload.workshopSuggestion =
        String(body.workshopSuggestion).slice(0, 300);
    }

    const docRef = db
        .collection(LIFESTYLE_SURVEY_COLLECTION)
        .doc(residentPinDocId(houseNo));
    const snap = await docRef.get();
    if (!snap.exists) {
      payload.submittedAt = ts;
    }
    await docRef.set(payload, {merge: true});
    res.status(200).json({ok: true});
  } catch (err) {
    logger.error("updateLifestyleSurvey failed", err);
    sendLegacyError(res, err);
  }
});

exports.getLifestyleSurveyStats = onRequest(async (req, res) => {
  if (!prepareJsonRequest(req, res)) return;
  try {
    const body = req.body || {};
    await verifyAdminResidentAccess(body, "admin.survey");
    const snap = await db.collection(LIFESTYLE_SURVEY_COLLECTION).get();
    const stats = {
      total: 0,
      occupants: {},
      ageGroups: {},
      pets: {},
      activities: {},
      workshops: {},
    };
    snap.forEach((doc) => {
      const d = doc.data();
      stats.total++;
      if (d.occupants) {
        const k = String(d.occupants);
        stats.occupants[k] = (stats.occupants[k] || 0) + 1;
      }
      (d.ageGroups || []).forEach((v) => {
        stats.ageGroups[v] = (stats.ageGroups[v] || 0) + 1;
      });
      (d.pets || []).forEach((v) => {
        stats.pets[v] = (stats.pets[v] || 0) + 1;
      });
      (d.activities || []).forEach((v) => {
        stats.activities[v] = (stats.activities[v] || 0) + 1;
      });
      (d.workshops || []).forEach((v) => {
        stats.workshops[v] = (stats.workshops[v] || 0) + 1;
      });
    });
    res.status(200).json({ok: true, stats});
  } catch (err) {
    logger.error("getLifestyleSurveyStats failed", err);
    sendLegacyError(res, err);
  }
});

exports.adminDocumentVault = onRequest({
  memory: "512MiB",
  timeoutSeconds: 60,
}, async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ok: false, error: "Method Not Allowed"});
    return;
  }

  try {
    const body = req.body || {};
    const access = await verifyCommitteeResidentAccess(body);

    const action = String(body.action || "list");
    const vaultType = String(body.vaultType || "").trim();
    if (!ADMIN_DOCUMENT_TYPES.has(vaultType)) {
      res.status(400).json({ok: false, error: "Invalid vault type"});
      return;
    }

    const collection = db.collection(ADMIN_DOCUMENTS_COLLECTION);

    if (action === "list") {
      const snap = await collection
          .where("vaultType", "==", vaultType)
          .limit(200)
          .get();
      const documents = [];
      for (const doc of snap.docs) {
        const data = doc.data();
        documents.push({
          id: doc.id,
          vaultType: data.vaultType,
          category: data.category || "",
          title: data.title || "",
          notes: data.notes || "",
          fileName: data.fileName || "",
          mimeType: data.mimeType || "",
          size: data.size || 0,
          storagePath: data.storagePath || "",
          sortOrder: typeof data.sortOrder === "number" ?
            data.sortOrder : null,
          createdAt: data.createdAt ?
            data.createdAt.toDate().toISOString() : "",
          updatedAt: data.updatedAt ?
            data.updatedAt.toDate().toISOString() : "",
          downloadUrl: data.downloadUrl || "",
        });
      }
      documents.sort((a, b) =>
        String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      res.status(200).json({
        ok: true,
        documents,
        role: access.role,
        canWrite: access.canWrite,
      });
      return;
    }

    if (!access.canWrite) {
      res.status(403).json({ok: false, error: "Read-only access"});
      return;
    }

    if (action === "upload") {
      const title = String(body.title || "").trim().slice(0, 160);
      if (!title) {
        res.status(400).json({ok: false, error: "Missing title"});
        return;
      }

      const parsed = parseAdminDocumentDataUrl(body.dataUrl);
      const docRef = collection.doc();
      const fileName = sanitizeFileName(body.fileName || title);
      const storagePath =
        `admin-documents/${vaultType}/${docRef.id}/${fileName}`;
      const downloadToken = crypto.randomUUID();
      const bucket = admin.storage().bucket();
      await bucket.file(storagePath).save(parsed.buffer, {
        resumable: false,
        metadata: {
          contentType: parsed.contentType,
          metadata: {firebaseStorageDownloadTokens: downloadToken},
        },
      });
      const downloadUrl = "https://firebasestorage.googleapis.com/v0/b/" +
        `${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&` +
        `token=${downloadToken}`;

      const payload = {
        vaultType,
        category: String(body.category || "General").trim().slice(0, 80),
        title,
        notes: String(body.notes || "").trim().slice(0, 800),
        fileName,
        mimeType: parsed.contentType,
        size: parsed.buffer.length,
        storagePath,
        downloadUrl,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: "admin",
      };
      await docRef.set(payload);
      res.status(200).json({
        ok: true,
        document: {
          id: docRef.id,
          ...payload,
          createdAt: new Date().toISOString(),
          downloadUrl,
        },
      });
      return;
    }

    if (action === "update") {
      const docId = String(body.documentId || "").trim();
      const title = String(body.title || "").trim().slice(0, 160);
      if (!docId) {
        res.status(400).json({ok: false, error: "Missing document id"});
        return;
      }
      if (!title) {
        res.status(400).json({ok: false, error: "Missing title"});
        return;
      }

      const docRef = collection.doc(docId);
      const snap = await docRef.get();
      if (!snap.exists || snap.data().vaultType !== vaultType) {
        res.status(404).json({ok: false, error: "Document not found"});
        return;
      }
      await docRef.update({
        category: String(body.category || "General").trim().slice(0, 80),
        title,
        notes: String(body.notes || "").trim().slice(0, 800),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.status(200).json({ok: true});
      return;
    }

    if (action === "reorder") {
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) {
        res.status(400).json({ok: false, error: "Missing items"});
        return;
      }
      const batch = db.batch();
      let count = 0;
      for (const item of items) {
        const id = String((item && item.documentId) || "").trim();
        const order = Number(item && item.sortOrder);
        if (!id || !Number.isFinite(order)) {
          continue;
        }
        batch.set(collection.doc(id), {
          sortOrder: order,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
        count += 1;
      }
      if (count > 0) {
        await batch.commit();
      }
      res.status(200).json({ok: true, updated: count});
      return;
    }

    if (action === "delete") {
      const docId = String(body.documentId || "").trim();
      if (!docId) {
        res.status(400).json({ok: false, error: "Missing document id"});
        return;
      }
      const docRef = collection.doc(docId);
      const snap = await docRef.get();
      if (!snap.exists || snap.data().vaultType !== vaultType) {
        res.status(404).json({ok: false, error: "Document not found"});
        return;
      }
      const storagePath = snap.data().storagePath;
      if (storagePath) {
        await admin.storage().bucket().file(storagePath)
            .delete({ignoreNotFound: true});
      }
      await docRef.delete();
      res.status(200).json({ok: true});
      return;
    }

    res.status(400).json({ok: false, error: "Invalid action"});
  } catch (err) {
    logger.error("adminDocumentVault failed", err);
    res.status(err.status || 500).json({ok: false, error: err.message});
  }
});

// ── Bulky Waste helpers ──────────────────────────────────────────────────────

/**
 * Parses a single bulky-waste photo data URL and returns upload-ready payload.
 * Accepts JPEG, PNG, and HEIC.
 * @param {string} dataUrl
 * @param {string} originalFileName
 * @return {{buffer: Buffer, contentType: string,
 *   extension: string, size: number}}
 */
function parseBulkyWastePhoto(dataUrl, originalFileName) {
  const match = String(dataUrl || "")
      .match(/^data:(image\/(?:jpeg|jpg|png|heic));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new Error(
        `Unsupported image format for "${originalFileName || "photo"}". ` +
        "Please use JPG, PNG, or HEIC.",
    );
  }
  const rawType = match[1];
  const contentType = rawType === "image/jpg" ? "image/jpeg" : rawType;
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > MAX_BULKY_WASTE_PHOTO_BYTES) {
    const name = originalFileName || "photo";
    throw new Error(`Photo "${name}" exceeds 8 MB limit`);
  }
  const extMap = {
    "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic",
  };
  return {
    buffer,
    contentType,
    extension: extMap[contentType] || "jpg",
    size: buffer.length,
  };
}

/**
 * Uploads bulky-waste photos to Firebase Storage and returns metadata array.
 * @param {string} pathPrefix — storage folder prefix for these photos
 * @param {Object[]} photos — [{dataUrl, fileName}]
 * @param {number} maxCount — max photos to keep
 * @return {Promise<Object[]>}
 */
async function uploadBulkyWastePhotos(pathPrefix, photos, maxCount) {
  const bucket = admin.storage().bucket();
  const uploaded = [];
  const cap = maxCount || MAX_BULKY_WASTE_PHOTOS;
  const list = Array.isArray(photos) ? photos.slice(0, cap) : [];

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const parsed = parseBulkyWastePhoto(item.dataUrl, item.fileName);
    const safeName = sanitizeFileName(item.fileName || `photo-${i + 1}`);
    const token = crypto.randomUUID();
    const storagePath =
      `${pathPrefix}/${Date.now()}-${i}-${safeName}` +
      `.${parsed.extension}`;
    const file = bucket.file(storagePath);

    await file.save(parsed.buffer, {
      resumable: false,
      metadata: {
        contentType: parsed.contentType,
        metadata: {firebaseStorageDownloadTokens: token},
      },
    });

    const downloadUrl = "https://firebasestorage.googleapis.com/v0/b/" +
      `${bucket.name}/o/${encodeURIComponent(storagePath)}` +
      `?alt=media&token=${token}`;

    uploaded.push({
      storagePath,
      downloadUrl,
      fileName: safeName,
      mimeType: parsed.contentType,
      size: parsed.size,
    });
  }
  return uploaded;
}

/**
 * Validates and normalises the items array from a bulky-waste request.
 * @param {*} raw
 * @return {{name: string, qty: number, note: string}[]}
 */
function normalizeBulkyWasteItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    const err = new Error("กรุณาระบุรายการสิ่งของอย่างน้อย 1 รายการ");
    err.status = 400;
    throw err;
  }
  return raw.slice(0, MAX_BULKY_WASTE_ITEMS).map((item, i) => {
    const name = String(item.name || "").trim().slice(0, 200);
    if (!name) {
      const err = new Error(`รายการที่ ${i + 1}: กรุณาระบุชื่อสิ่งของ`);
      err.status = 400;
      throw err;
    }
    return {
      name,
      qty: Math.max(1, Math.min(999, Number(item.qty) || 1)),
      note: String(item.note || "").trim().slice(0, 400),
    };
  });
}

/**
 * Derives request-level status from item states (single source of truth).
 * "completed" once every item is resolved (collected OR rejected);
 * otherwise "submitted" (still has pending items).
 * @param {Object[]} items
 * @return {string}
 */
function deriveBulkyStatus(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return "submitted";
  const allResolved = list.every((it) => it.collected || it.rejected);
  return allResolved ? "completed" : "submitted";
}

// ── submitBulkyWasteRequest ──────────────────────────────────────────────────

exports.submitBulkyWasteRequest = onRequest({
  memory: "512MiB",
  timeoutSeconds: 120,
}, async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).send(""); return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ok: false, error: "Method Not Allowed"}); return;
  }

  try {
    const body = req.body || {};
    const houseNo = normalizeHouseNo(body.houseNo);
    const pin = String(body.pin || "");

    await verifyResidentPinInternal(houseNo, pin);

    // Check if the pickup round is currently open.
    const roundSnap = await db.doc("system_config/bulky_waste_round").get();
    const roundData = roundSnap.data();
    if (roundData && !roundData.isOpen) {
      res.status(403).json({
        ok: false,
        error: "ปิดรับคำขอชั่วคราว",
        roundLabel: roundData.roundLabel || "",
        nextPickupDate: roundData.nextPickupDate || "",
      });
      return;
    }
    const currentRoundId = roundData ? (roundData.currentRoundId || 1) : 1;

    const baseItems = normalizeBulkyWasteItems(body.items);
    const notes = String(body.notes || "").trim().slice(0, 1000);
    const rawItems = Array.isArray(body.items) ? body.items : [];

    // Count total photos across all items before uploading anything.
    let totalPhotos = 0;
    for (let i = 0; i < baseItems.length; i++) {
      const p = rawItems[i] && Array.isArray(rawItems[i].photos) ?
        rawItems[i].photos : [];
      totalPhotos += p.length;
    }
    if (totalPhotos > MAX_BULKY_WASTE_PHOTOS) {
      res.status(400).json({
        ok: false,
        error: `แนบรูปได้รวมสูงสุด ${MAX_BULKY_WASTE_PHOTOS} รูป`,
      });
      return;
    }

    const collection = db.collection(BULKY_WASTE_COLLECTION);
    const docRef = collection.doc();

    // Upload each item's photos under its own folder, attach metadata.
    const items = [];
    for (let i = 0; i < baseItems.length; i++) {
      const srcPhotos = rawItems[i] && Array.isArray(rawItems[i].photos) ?
        rawItems[i].photos : [];
      const photos = await uploadBulkyWastePhotos(
          `bulky-waste/${docRef.id}/item-${i}`,
          srcPhotos,
          MAX_BULKY_WASTE_PHOTOS_PER_ITEM,
      );
      items.push({...baseItems[i], photos});
    }

    const residentName = String(body.residentName || "").trim().slice(0, 200);
    const phone = String(body.phone || "").trim().slice(0, 30);
    const lineId = String(body.lineId || "").trim().slice(0, 100);
    const payload = {
      houseNo,
      residentName,
      phone,
      lineId,
      items,
      notes,
      status: "submitted",
      roundId: currentRoundId,
      adminNote: "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdByIp: req.headers["x-forwarded-for"] || req.ip || "",
      updatedBy: "",
    };

    await docRef.set(payload);

    writeAuditLog("bulky_waste_submit", houseNo, {
      requestId: docRef.id,
      itemCount: items.length,
      photoCount: totalPhotos,
    });

    res.status(200).json({ok: true, requestId: docRef.id});
  } catch (err) {
    logger.error("submitBulkyWasteRequest failed", err);
    res.status(err.status || 500).json({ok: false, error: err.message});
  }
});

// ── getMyBulkyWasteRequests ──────────────────────────────────────────────────

exports.getMyBulkyWasteRequests = onRequest(async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).send(""); return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ok: false, error: "Method Not Allowed"}); return;
  }

  try {
    const body = req.body || {};
    const houseNo = normalizeHouseNo(body.houseNo);
    const pin = String(body.pin || "");

    await verifyResidentPinInternal(houseNo, pin);

    // Fetch round config and resident requests in parallel.
    const [snap, roundSnap] = await Promise.all([
      db.collection(BULKY_WASTE_COLLECTION)
          .where("houseNo", "==", houseNo)
          .limit(50)
          .get(),
      db.doc("system_config/bulky_waste_round").get(),
    ]);

    const rd = roundSnap.data();
    const round = rd ? {
      isOpen: !!rd.isOpen,
      roundLabel: rd.roundLabel || "",
      nextPickupDate: rd.nextPickupDate || "",
      currentRoundId: rd.currentRoundId || 1,
    } : {isOpen: true, roundLabel: "", nextPickupDate: "", currentRoundId: 1};

    const requests = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        houseNo: d.houseNo,
        residentName: d.residentName || "",
        phone: d.phone || "",
        lineId: d.lineId || "",
        items: d.items || [],
        notes: d.notes || "",
        status: d.status,
        roundId: d.roundId || 0,
        adminNote: d.adminNote || "",
        createdAt: d.createdAt ? d.createdAt.toDate().toISOString() : "",
      };
    });

    requests.sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

    res.status(200).json({ok: true, requests, round});
  } catch (err) {
    logger.error("getMyBulkyWasteRequests failed", err);
    res.status(err.status || 500).json({ok: false, error: err.message});
  }
});

// ── deleteBulkyWasteRequest (resident, only while pending) ───────────────────

exports.deleteBulkyWasteRequest = onRequest(async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).send(""); return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ok: false, error: "Method Not Allowed"}); return;
  }

  try {
    const body = req.body || {};
    const houseNo = normalizeHouseNo(body.houseNo);
    const pin = String(body.pin || "");
    const requestId = String(body.requestId || "").trim();

    await verifyResidentPinInternal(houseNo, pin);

    if (!requestId) {
      res.status(400).json({ok: false, error: "Missing requestId"}); return;
    }

    const docRef = db.collection(BULKY_WASTE_COLLECTION).doc(requestId);
    const snap = await docRef.get();
    if (!snap.exists) {
      res.status(404).json({ok: false, error: "ไม่พบคำขอนี้"}); return;
    }

    const d = snap.data();
    if (normalizeHouseNo(d.houseNo) !== houseNo) {
      res.status(403).json({ok: false, error: "ไม่สามารถลบคำขอของบ้านอื่นได้"});
      return;
    }
    if (d.status !== "submitted") {
      res.status(400).json({
        ok: false,
        error: "ลบไม่ได้ เนื่องจากนิติบุคคลกำลังดำเนินการกับคำขอนี้แล้ว",
      });
      return;
    }

    // remove uploaded photos from Storage
    const bucket = admin.storage().bucket();
    const paths = (d.items || [])
        .flatMap((it) => (it.photos || []).map((p) => p.storagePath))
        .filter(Boolean);
    await Promise.all(paths.map((p) =>
      bucket.file(p).delete({ignoreNotFound: true}).catch(() => {}),
    ));

    await docRef.delete();

    writeAuditLog("bulky_waste_cancel", houseNo, {requestId});

    res.status(200).json({ok: true});
  } catch (err) {
    logger.error("deleteBulkyWasteRequest failed", err);
    res.status(err.status || 500).json({ok: false, error: err.message});
  }
});

// ── editBulkyWasteRequest (resident, only while pending) ─────────────────────

exports.editBulkyWasteRequest = onRequest({
  memory: "512MiB",
  timeoutSeconds: 120,
}, async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).send(""); return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ok: false, error: "Method Not Allowed"}); return;
  }

  try {
    const body = req.body || {};
    const houseNo = normalizeHouseNo(body.houseNo);
    const pin = String(body.pin || "");
    const requestId = String(body.requestId || "").trim();

    await verifyResidentPinInternal(houseNo, pin);

    if (!requestId) {
      res.status(400).json({ok: false, error: "Missing requestId"}); return;
    }

    const docRef = db.collection(BULKY_WASTE_COLLECTION).doc(requestId);
    const snap = await docRef.get();
    if (!snap.exists) {
      res.status(404).json({ok: false, error: "ไม่พบคำขอนี้"}); return;
    }

    const d = snap.data();
    if (normalizeHouseNo(d.houseNo) !== houseNo) {
      res.status(403).json({
        ok: false, error: "ไม่สามารถแก้ไขคำขอของบ้านอื่นได้",
      });
      return;
    }
    if (d.status !== "submitted") {
      res.status(400).json({
        ok: false,
        error: "แก้ไขไม่ได้ เนื่องจากนิติบุคคลกำลังดำเนินการกับคำขอนี้แล้ว",
      });
      return;
    }

    const baseItems = normalizeBulkyWasteItems(body.items);
    const notes = String(body.notes || "").trim().slice(0, 1000);
    const phone = String(body.phone || "").trim().slice(0, 30);
    const lineId = String(body.lineId || "").trim().slice(0, 100);
    const residentName = String(body.residentName || "").trim().slice(0, 200);
    const rawItems = Array.isArray(body.items) ? body.items : [];

    // Validate per-item + total photo caps before any upload.
    let totalPhotos = 0;
    for (let i = 0; i < baseItems.length; i++) {
      const ph = rawItems[i] && Array.isArray(rawItems[i].photos) ?
        rawItems[i].photos : [];
      if (ph.length > MAX_BULKY_WASTE_PHOTOS_PER_ITEM) {
        res.status(400).json({
          ok: false,
          error: `รายการที่ ${i + 1}: แนบรูปได้สูงสุด ` +
            `${MAX_BULKY_WASTE_PHOTOS_PER_ITEM} รูป`,
        });
        return;
      }
      totalPhotos += ph.length;
    }
    if (totalPhotos > MAX_BULKY_WASTE_PHOTOS) {
      res.status(400).json({
        ok: false,
        error: `แนบรูปได้รวมสูงสุด ${MAX_BULKY_WASTE_PHOTOS} รูป`,
      });
      return;
    }

    // Rebuild items: keep existing photos (have storagePath),
    // upload new ones (have dataUrl).
    const items = [];
    const keptPaths = new Set();
    for (let i = 0; i < baseItems.length; i++) {
      const ph = rawItems[i] && Array.isArray(rawItems[i].photos) ?
        rawItems[i].photos : [];
      const kept = [];
      const toUpload = [];
      for (const p of ph) {
        if (p && p.storagePath && p.downloadUrl) {
          kept.push({
            storagePath: p.storagePath,
            downloadUrl: p.downloadUrl,
            fileName: p.fileName || "",
            mimeType: p.mimeType || "",
            size: p.size || 0,
          });
          keptPaths.add(p.storagePath);
        } else if (p && p.dataUrl) {
          toUpload.push({dataUrl: p.dataUrl, fileName: p.fileName});
        }
      }
      const uploaded = await uploadBulkyWastePhotos(
          `bulky-waste/${requestId}/item-${i}`,
          toUpload,
          MAX_BULKY_WASTE_PHOTOS_PER_ITEM - kept.length,
      );
      items.push({...baseItems[i], photos: [...kept, ...uploaded]});
    }

    // Delete orphaned Storage files (photos removed during edit).
    const bucket = admin.storage().bucket();
    const oldPaths = (d.items || [])
        .flatMap((it) => (it.photos || []).map((p) => p.storagePath))
        .filter(Boolean);
    const orphans = oldPaths.filter((p) => !keptPaths.has(p));
    await Promise.all(orphans.map((p) =>
      bucket.file(p).delete({ignoreNotFound: true}).catch(() => {}),
    ));

    await docRef.update({
      items,
      notes,
      phone,
      lineId,
      residentName,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: "resident",
    });

    writeAuditLog("bulky_waste_edit", houseNo, {
      requestId,
      itemCount: items.length,
    });

    res.status(200).json({ok: true});
  } catch (err) {
    logger.error("editBulkyWasteRequest failed", err);
    res.status(err.status || 500).json({ok: false, error: err.message});
  }
});

// ── manageBulkyWasteRequests (admin) ─────────────────────────────────────────

exports.manageBulkyWasteRequests = onRequest(async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).send(""); return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ok: false, error: "Method Not Allowed"}); return;
  }

  try {
    const body = req.body || {};
    await verifyAdminResidentAccess(body, "admin.pickup");

    const action = String(body.action || "list");
    const collection = db.collection(BULKY_WASTE_COLLECTION);

    if (action === "list") {
      // Avoid composite index: filter by status with where-only (no orderBy),
      // otherwise order by createdAt; sort in memory either way.
      const statusFilter = String(body.status || "").trim();
      let query;
      if (statusFilter && BULKY_WASTE_STATUSES.has(statusFilter)) {
        query = collection.where("status", "==", statusFilter).limit(200);
      } else {
        query = collection.orderBy("createdAt", "desc").limit(200);
      }

      // Fetch round config in parallel with the requests query.
      const [snap, roundSnap] = await Promise.all([
        query.get(),
        db.doc("system_config/bulky_waste_round").get(),
      ]);

      const rd = roundSnap.data();
      const round = rd ? {
        isOpen: !!rd.isOpen,
        roundLabel: rd.roundLabel || "",
        nextPickupDate: rd.nextPickupDate || "",
        currentRoundId: rd.currentRoundId || 1,
      } : {
        isOpen: true, roundLabel: "", nextPickupDate: "", currentRoundId: 1,
      };

      const requests = snap.docs.map((doc) => {
        const d = doc.data();
        return {
          id: doc.id,
          houseNo: d.houseNo,
          residentName: d.residentName || "",
          phone: d.phone || "",
          lineId: d.lineId || "",
          items: d.items || [],
          notes: d.notes || "",
          status: d.status,
          roundId: d.roundId || 0,
          adminNote: d.adminNote || "",
          createdAt: d.createdAt ? d.createdAt.toDate().toISOString() : "",
          updatedAt: d.updatedAt ? d.updatedAt.toDate().toISOString() : "",
        };
      });

      requests.sort((a, b) =>
        String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

      res.status(200).json({ok: true, requests, round});
      return;
    }

    if (action === "update") {
      const requestId = String(body.requestId || "").trim();
      if (!requestId) {
        res.status(400).json({ok: false, error: "Missing requestId"}); return;
      }

      const docRef = collection.doc(requestId);
      const snap = await docRef.get();
      if (!snap.exists) {
        res.status(404).json({ok: false, error: "Request not found"}); return;
      }

      const updates = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: "admin",
      };

      if (body.adminNote !== undefined) {
        updates.adminNote = String(body.adminNote || "").trim().slice(0, 1000);
      }

      // Per-item flags: "collected" (partial pickups) and "rejected"
      // (admin declines an item, with a reason). Arrays align by index.
      // The request-level status is then DERIVED from item states.
      const hasCollected = Array.isArray(body.collected);
      const hasRejected = Array.isArray(body.rejected);
      if (hasCollected || hasRejected) {
        const existing = snap.data().items || [];
        const reasons = Array.isArray(body.rejectReasons) ?
          body.rejectReasons : [];
        updates.items = existing.map((it, i) => {
          const next = {...it};
          if (hasCollected) next.collected = Boolean(body.collected[i]);
          if (hasRejected) {
            next.rejected = Boolean(body.rejected[i]);
            next.rejectReason = next.rejected ?
              String(reasons[i] || "").trim().slice(0, 300) : "";
          }
          // collected and rejected are mutually exclusive
          if (next.rejected) next.collected = false;
          return next;
        });
      }

      // Derive status from the resulting items (single source of truth).
      const finalItems = updates.items || snap.data().items || [];
      updates.status = deriveBulkyStatus(finalItems);

      await docRef.update(updates);

      writeAuditLog("bulky_waste_update", snap.data().houseNo, {
        requestId,
        updates: Object.keys(updates).filter(
            (k) => k !== "updatedAt" && k !== "updatedBy",
        ),
      });

      res.status(200).json({ok: true});
      return;
    }

    if (action === "delete") {
      const requestId = String(body.requestId || "").trim();
      if (!requestId) {
        res.status(400).json({ok: false, error: "Missing requestId"}); return;
      }
      const docRef = collection.doc(requestId);
      const snap = await docRef.get();
      if (!snap.exists) {
        res.status(404).json({ok: false, error: "ไม่พบคำขอนี้"}); return;
      }
      const d = snap.data();

      // Remove all photos from Storage, then delete the doc.
      const bucket = admin.storage().bucket();
      const paths = (d.items || [])
          .flatMap((it) => (it.photos || []).map((p) => p.storagePath))
          .filter(Boolean);
      await Promise.all(paths.map((p) =>
        bucket.file(p).delete({ignoreNotFound: true}).catch(() => {}),
      ));
      await docRef.delete();

      writeAuditLog("bulky_waste_admin_delete", d.houseNo, {requestId});
      res.status(200).json({ok: true});
      return;
    }

    if (action === "bulkUpdate") {
      const ids = Array.isArray(body.ids) ?
        body.ids.map((x) => String(x).trim()).filter(Boolean) : [];
      // target: "completed" = mark all non-rejected items collected;
      //         "submitted" = clear collected on all items (reset to pending).
      const target = String(body.status || "").trim();
      if (!ids.length) {
        res.status(400).json({ok: false, error: "ไม่ได้เลือกรายการ"}); return;
      }
      if (!BULKY_WASTE_STATUSES.has(target)) {
        res.status(400).json({ok: false, error: "Invalid status"}); return;
      }

      const refs = ids.slice(0, 200).map((id) => collection.doc(id));
      const snaps = await db.getAll(...refs);
      const batch = db.batch();
      snaps.forEach((snap, i) => {
        if (!snap.exists) return;
        const items = (snap.data().items || []).map((it) => {
          if (target === "completed") {
            // keep rejected items as-is; collect the rest
            return it.rejected ? it : {...it, collected: true};
          }
          return {...it, collected: false};
        });
        batch.update(refs[i], {
          items,
          status: deriveBulkyStatus(items),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedBy: "admin",
        });
      });
      await batch.commit();

      writeAuditLog("bulky_waste_bulk_update", "admin", {
        count: ids.length,
        target,
      });

      res.status(200).json({ok: true, count: ids.length});
      return;
    }

    res.status(400).json({ok: false, error: "Invalid action"});
  } catch (err) {
    logger.error("manageBulkyWasteRequests failed", err);
    res.status(err.status || 500).json({ok: false, error: err.message});
  }
});

// ── managePickupRound (admin) ───────────────────────────────────────────────

exports.managePickupRound = onRequest(async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).send(""); return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ok: false, error: "Method Not Allowed"}); return;
  }

  try {
    const body = req.body || {};
    await verifyAdminResidentAccess(body, "admin.pickup");

    const action = String(body.action || "get");
    const docRef = db.doc("system_config/bulky_waste_round");

    if (action === "get") {
      const snap = await docRef.get();
      const d = snap.data() || {};
      res.status(200).json({
        ok: true,
        round: {
          isOpen: !!d.isOpen,
          roundLabel: d.roundLabel || "",
          nextPickupDate: d.nextPickupDate || "",
          currentRoundId: d.currentRoundId || 1,
          openedAt: d.openedAt ? d.openedAt.toDate().toISOString() : null,
          closedAt: d.closedAt ? d.closedAt.toDate().toISOString() : null,
        },
      });
      return;
    }

    if (action === "open") {
      const roundLabel = String(body.roundLabel || "").trim().slice(0, 100);
      const nextPickupDate =
        String(body.nextPickupDate || "").trim().slice(0, 50);
      // Increment roundId whenever a new round is opened (to flag old reqs).
      const snap = await docRef.get();
      const prev = snap.data() || {};
      const wasOpen = !!prev.isOpen;
      const newRoundId = wasOpen ?
        (prev.currentRoundId || 1) :
        ((prev.currentRoundId || 1) + 1);

      await docRef.set({
        isOpen: true,
        roundLabel: roundLabel || prev.roundLabel || "",
        nextPickupDate: nextPickupDate || prev.nextPickupDate || "",
        currentRoundId: newRoundId,
        openedAt: admin.firestore.FieldValue.serverTimestamp(),
        closedAt: prev.closedAt || null,
      }, {merge: true});

      writeAuditLog("pickup_round_open", "admin", {
        roundLabel, newRoundId,
      });
      res.status(200).json({ok: true, currentRoundId: newRoundId});
      return;
    }

    if (action === "close") {
      await docRef.set({
        isOpen: false,
        closedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});

      writeAuditLog("pickup_round_close", "admin", {});
      res.status(200).json({ok: true});
      return;
    }

    res.status(400).json({ok: false, error: "Invalid action"});
  } catch (err) {
    logger.error("managePickupRound failed", err);
    res.status(err.status || 500).json({ok: false, error: err.message});
  }
});

/* eslint-disable */
// ===========================================================================
// Pattra8 Pay — self-service ค่าส่วนกลาง / ค่าจอดรถ
// Added by Pattra8 Pay. Reuses verifyAdminResidentAccess (admin = บ้าน 38/8),
// setCorsHeaders, normalizeHouseNo, db, admin. Stores payments in
// `pattra_payments`; receipts numbered via `pattra_counters/receipts`.
// Email delivery uses Resend (process.env.RESEND_API_KEY) — optional until set.
// ===========================================================================
const PP_COLLECTION = PATTRA_PAYMENTS_COLLECTION;
// Notes a resident sends without a slip — "จ่ายไปแล้วทาง LINE ตั้งแต่ มี.ค."
// Kept out of pattra_payments: a message is not a payment.
const PP_MESSAGES_COLLECTION = "pattra_parking_messages";
// Append-only trail of changes made to an issued receipt. A receipt is a
// document people file for expenses, so every edit has to be traceable.
const PP_RECEIPT_LOG_COLLECTION = "pattra_receipt_log";
const PP_PLANS_COLLECTION = PATTRA_INSTALLMENT_PLANS_COLLECTION;
const PP_SLIP_INBOX_COLLECTION = "pattra_slip_uploads";
const PP_BLOCK = "38";
const PP_COMMON_BASE = 9600;
const PP_PARKING_RATE = 600; // monthly parking slot rent, baht
const PP_PUBLIC_COMMON_PERIOD = "H2";
const PP_PUBLIC_COMMON_YEAR = 2026;
// The estate is who sends the receipt — "Pattra8 Pay" is an internal tool
// name and means nothing to a resident scanning their inbox.
const PP_FROM = "Pattra Villa 8 <receipt@pattra8.com>"; // verified domain in Resend
const PP_ADMIN_NOTIFICATION_EMAIL = "mrteam388@gmail.com";
// The receipt document itself lives in its own module so maintenance
// scripts can render byte-identical output — see domains/payments/.
const {
  periodLabel: ppPeriodLabel,
  renderReceiptHtml: ppReceiptHtml,
} = require("./domains/payments/receipt-template");

async function ppSendEmail(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return {sent: false, reason: key ? "no-recipient" : "no-key"};
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {Authorization: `Bearer ${key}`, "Content-Type": "application/json"},
      body: JSON.stringify({from: PP_FROM, to: [to], subject, html}),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      logger.warn("pattraPay email failed", r.status, t);
      return {sent: false, reason: `http-${r.status}`};
    }
    return {sent: true};
  } catch (e) {
    logger.warn("pattraPay email error", e);
    return {sent: false, reason: "exception"};
  }
}

function ppNewSlipNotificationHtml(houseNo, amount, uploadedAt) {
  const uploadedAtText = new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  }).format(uploadedAt);
  const amountText = Number(amount).toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"></head>
<body style="margin:0;background:#f7f1e7;font-family:Arial,sans-serif;color:#2a2218">
<div style="max-width:560px;margin:0 auto;padding:28px 16px">
<div style="overflow:hidden;border:1px solid #e6dcc7;border-radius:18px;background:#fff">
<div style="height:6px;background:#c47a2c"></div>
<div style="padding:28px">
<div style="font-size:12px;font-weight:700;letter-spacing:.16em;color:#c47a2c">
PATTRA8 PAY · NEW SLIP
</div>
<h1 style="margin:10px 0 6px;font-size:26px">มีสลิปใหม่เข้าตรวจรายการ</h1>
<p style="margin:0 0 22px;color:#6b5d4a">ลูกบ้านส่งหลักฐานการชำระเงินเข้าระบบแล้ว</p>
<div style="padding:18px;border-radius:14px;background:#faf6ee">
<p style="margin:0 0 8px"><strong>บ้านเลขที่:</strong> 38/${houseNo}</p>
<p style="margin:0 0 8px"><strong>ยอด:</strong> ${amountText} บาท</p>
<p style="margin:0"><strong>อัปโหลดเมื่อ:</strong> ${uploadedAtText}</p>
</div>
<a href="https://pattra8.com/commonfee/"
style="display:block;margin-top:22px;padding:13px 18px;border-radius:10px;
background:#5f7c4e;color:#fff;text-align:center;text-decoration:none;font-weight:700">
เปิดหน้าค่าส่วนกลางเพื่อตรวจรายการ
</a>
</div></div></div></body></html>`;
}

function ppParseSlip(dataUrl) {
  const m = String(dataUrl || "").match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!m) return null;
  return {contentType: m[1], buffer: Buffer.from(m[2], "base64")};
}

async function ppUploadSlipDataUrl(docId, dataUrl) {
  const slip = ppParseSlip(dataUrl);
  if (!slip) return "";
  if (slip.buffer.length > 10 * 1024 * 1024) {
    throw Object.assign(new Error("ไฟล์สลิปใหญ่เกิน 10MB"), {status: 400});
  }
  const ext = slip.contentType.split("/")[1] || "jpg";
  const path = `pattra-slips/${docId}.${ext}`;
  const token = crypto.randomUUID();
  const bucket = admin.storage().bucket();
  await bucket.file(path).save(slip.buffer, {
    resumable: false,
    metadata: {contentType: slip.contentType, metadata: {firebaseStorageDownloadTokens: token}},
  });
  return "https://firebasestorage.googleapis.com/v0/b/" +
    `${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

/**
 * Read a parking slip and turn it into the months it pays for.
 *
 * Slip-first flow: the resident picks their house and attaches the transfer,
 * and the amount on the slip decides how many months it covers. Nothing here
 * settles anything — every month it returns is written as pending for the
 * committee to check.
 *
 * @param {string} slipDataUrl data-url of the uploaded slip
 * @param {number} houseNo paying house, already verified as a renter
 * @param {number} fallbackAmount amount to fall back on when OCR fails
 * @param {string} wantedStart month the resident chose to start from, for
 *   settling a month in the past; empty to start from the next open month
 * @return {Promise<Object>} periods, the amount used, and what OCR saw
 */
async function ppReadParkingSlip(
    slipDataUrl, houseNo, fallbackAmount, wantedStart,
) {
  const empty = {
    periods: [], arrears: [], amount: 0, bank: "", payerName: "",
    memo: "", memoPeriod: "", startedFrom: "", confidence: 0, exact: false,
    error: "",
  };
  const slip = ppParseSlip(slipDataUrl);
  if (!slip) return {...empty, error: "กรุณาแนบรูปสลิป"};
  if (slip.buffer.length > 10 * 1024 * 1024) {
    return {...empty, error: "ไฟล์สลิปใหญ่เกิน 10MB"};
  }

  let ocr = null;
  try {
    ocr = await ppAnalyzeSlipImage(slip.buffer, slip.contentType);
  } catch (error) {
    logger.warn("parking slip OCR failed", error);
  }

  const readAmount = ocr && Number(ocr.amount) > 0 ? Number(ocr.amount) : 0;
  const amount = readAmount || Number(fallbackAmount) || 0;
  if (!(amount > 0)) {
    return {...empty, error: "อ่านยอดจากสลิปไม่ได้ กรุณาลองใหม่"};
  }

  const guess = inferParkingMonths(amount, PP_PARKING_RATE, houseNo);
  // An amount that is not a clean run of months still gets recorded — as a
  // single month the committee reviews — rather than being turned away.
  const months = guess.auto ? guess.months : 1;

  // Start after every month this house already holds, so prepaying twice does
  // not buy the same month again.
  const houseSnap = await db.collection(PP_COLLECTION)
      .where("houseNo", "==", houseNo).get();
  const taken = houseSnap.docs
      .map((doc) => doc.data() || {})
      .filter((data) => data.feeType === "parking" &&
        (data.status === "pending" || data.status === "verified"))
      .map((data) => String(data.period || ""));
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000); // Bangkok
  const currentPeriod = `${now.getUTCFullYear()}-` +
    `${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  // Which months this slip settles, in order of how well we know the payer's
  // intent:
  //   1. the month the resident picked on the page — they were asked outright;
  //   2. the month written in the transfer memo ("ค่าจอดรถ feb 2026"), which
  //      is the payer saying it in their own words on the slip itself;
  //   3. otherwise the months they have skipped, oldest first.
  // A memo month the house already holds is ignored rather than refused — the
  // memo may just be describing an earlier payment.
  const chosen = String(wantedStart || "").trim();
  const memoPeriod = parseMemoPeriod(ocr && ocr.memo, currentPeriod);
  const memoUsable = memoPeriod && !taken.includes(memoPeriod);
  let startedFrom = "arrears";
  let periods;
  if (parseParkingPeriod(chosen)) {
    startedFrom = "resident";
    periods = parkingPeriodsFrom(chosen, months);
  } else if (memoUsable) {
    startedFrom = "memo";
    periods = parkingPeriodsFrom(memoPeriod, months);
  } else {
    periods = allocateParkingMonths(taken, currentPeriod, months);
  }

  // Never sell a month the house already holds, whichever direction we came
  // from — the committee would otherwise see two rows for one month.
  const clash = periods.filter((period) => taken.includes(period));
  if (clash.length) {
    return {
      ...empty,
      error: `มีรายการของ ${clash.join(", ")} อยู่แล้ว กรุณาเลือกเดือนอื่น`,
    };
  }

  return {
    periods,
    // What the house still owes, so the page can say so before asking for a
    // slip rather than after the fact.
    arrears: parkingArrears(taken, currentPeriod),
    // Kept for the committee's review card: the memo as written, the month it
    // was read as, and which rule actually chose the months above.
    memo: ocr && ocr.memo || "",
    memoPeriod,
    startedFrom,
    amount,
    bank: ocr && ocr.bank || "",
    // The name as it appears on the slip. Evidence, not the receipt name —
    // the committee compares it with the house register at review time.
    payerName: ocr && ocr.payerName || "",
    confidence: ocr ? Number(ocr.confidence) || 0 : 0,
    exact: guess.auto,
    error: periods.length ? "" : "คำนวณเดือนจากยอดไม่ได้",
  };
}

/**
 * OCR one payment slip with Vertex vision to pre-fill the paystatus upload
 * form. Residents write/stamp their house number (usually "38/xx" or a bare
 * number) on the slip, so that is the key field; also read the transferred
 * amount and the payer's bank. Image is passed inline (base64) — the slip is
 * not uploaded to Storage yet at pre-fill time.
 * @param {Buffer} buffer decoded slip image bytes
 * @param {string} contentType e.g. "image/jpeg"
 * @return {Promise<{houseNo: (number|null), amount: (number|null),
 *   bank: string, confidence: number}>}
 */
async function ppAnalyzeSlipImage(buffer, contentType) {
  const authClient = await vertexAuth.getClient();
  const access = await authClient.getAccessToken();
  if (!access.token) throw new Error("Vertex access token unavailable");

  const projectId = process.env.GCLOUD_PROJECT || "pattra8-54c3f";
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/` +
    `${projectId}/locations/${VERTEX_VISION_LOCATION}/publishers/google/` +
    `models/${VERTEX_VISION_MODEL}:generateContent`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${access.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          {text: "This is a Thai bank transfer slip for a housing estate " +
            "(หมู่บ้านภัทราวิลล่า 8, block 38). A resident usually writes or " +
            "stamps their house number on the slip to identify who paid — it " +
            "looks like \"38/27\" or sometimes just a bare number. Extract: " +
            "(1) houseNo — that house number as digits only, dropping the " +
            "\"38/\" block prefix (so \"38/27\" -> \"27\"), value 1-68; " +
            "(2) amount — the transferred amount in Thai baht as a number; " +
            "(3) bank — the payer's / sending bank as a short name or code " +
            "(e.g. SCB, KBANK, BBL, KTB, ธ.ไทยพาณิชย์); " +
            "(4) payerName — the sender / payer name shown on the slip, " +
            "not the recipient name. For Thai slips this is often next to " +
            "\"จาก\" or above the sending account. Use the visible shortened " +
            "name exactly as shown if the full name is masked, for example " +
            "\"นางสาว ญาดา ท.\" or \"นายพสิษฐ์ ศ.\". Do not use PATTRA VILLA8, " +
            "นิติบุคคลหมู่บ้านจัดสรร ภัทราวิลล่า 8, or the recipient account " +
            "as payerName; " +
            "(5) memo — the memo / note / บันทึกช่วยจำ line the sender typed " +
            "with the transfer, copied VERBATIM and left empty when there is " +
            "none. Do not translate it, tidy it, or invent one; it often " +
            "names the month being paid for, e.g. \"ค่าจอดรถ feb 2026\". " +
            "Use visible evidence " +
            "only. If a field is not clearly visible, leave it empty and " +
            "lower confidence."},
          {inlineData: {mimeType: contentType || "image/jpeg",
            data: buffer.toString("base64")}},
        ],
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 400,
        thinkingConfig: {thinkingLevel: "MINIMAL"},
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            houseNo: {type: "STRING"},
            amount: {type: "NUMBER"},
            bank: {type: "STRING"},
            payerName: {type: "STRING"},
            memo: {type: "STRING"},
            confidence: {type: "NUMBER"},
          },
          required: [
            "houseNo", "amount", "bank", "payerName", "memo", "confidence",
          ],
        },
      },
    }),
    signal: AbortSignal.timeout(45000),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(String(result.error && result.error.message ||
      `Vertex request failed (${response.status})`).slice(0, 500));
  }
  const parts = result.candidates && result.candidates[0] &&
    result.candidates[0].content && result.candidates[0].content.parts || [];
  const textPart = parts.find((part) => part.text);
  if (!textPart) throw new Error("Vertex returned no slip result");
  const parsed = JSON.parse(textPart.text);
  const amount = Number(parsed.amount);
  return {
    houseNo: ppHouseNum(parsed.houseNo),
    amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    bank: ppCleanImportText(parsed.bank, 40),
    payerName: ppCleanImportText(parsed.payerName, 160),
    memo: ppCleanImportText(parsed.memo, 200),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
  };
}

function ppMapDoc(doc) {
  const d = doc.data() || {};
  return {
    id: doc.id,
    houseNo: d.houseNo,
    feeType: d.feeType,
    period: d.period,
    year: d.year,
    amount: d.amount,
    payerName: d.payerName || "",
    // What OCR read off the slip image, kept apart from payerName (which the
    // receipt is issued in). Never back-filled from the house register, so an
    // empty value honestly means "could not read it".
    slipPayerName: d.slipPayerName || "",
    slipMemo: d.slipMemo || "",
    periodSource: d.periodSource || "",
    email: d.email || "",
    slipUrl: d.slipUrl || "",
    status: d.status,
    note: d.note || "",
    receiptNo: d.receiptNo || "",
    createdAt: d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : Date.now(),
    verifiedAt: d.verifiedAt && d.verifiedAt.toMillis ? d.verifiedAt.toMillis() : null,
    source: d.source || "",
    paidAt: d.paidAt && d.paidAt.toMillis ? d.paidAt.toMillis() : null,
    bank: d.bank || "",
    transactionRef: d.transactionRef || "",
    importFile: d.importFile || "",
    confidence: d.confidence || "",
    overage: Number(d.overage || 0),
    rawNote: d.rawNote || "",
    reviewNote: d.reviewNote || "",
    residentNote: d.residentNote || "",
    groupId: d.groupId || "",
    groupIndex: Number.isFinite(d.groupIndex) ? d.groupIndex : null,
    groupSize: Number.isFinite(d.groupSize) ? d.groupSize : null,
    groupAmount: Number.isFinite(d.groupAmount) ? d.groupAmount : null,
    receiptRef: d.receiptRef || "",
    planId: d.planId || "",
    ocrAmount: d.ocrAmount == null ? null : Number(d.ocrAmount),
  };
}

function ppCleanImportText(value, max = 300) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function ppTimestampFromMillis(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return admin.firestore.Timestamp.fromMillis(ms);
}

function ppPlanId(houseNo, feeType, period, year) {
  return `${year}_${feeType}_${period}_${houseNo}`;
}

function ppMapPlan(doc) {
  const d = doc.data() || {};
  return {
    id: doc.id,
    houseNo: d.houseNo,
    feeType: d.feeType || "common",
    period: d.period || "",
    year: Number(d.year) || null,
    totalAmount: Number(d.totalAmount || 0),
    paidAmount: Number(d.paidAmount || 0),
    appliedPaymentIds: Array.isArray(d.appliedPaymentIds) ?
      d.appliedPaymentIds : [],
    status: d.status || "active",
    note: d.note || "",
    createdBy: d.createdBy || "",
    createdAt: d.createdAt && d.createdAt.toMillis ?
      d.createdAt.toMillis() : null,
    closedAt: d.closedAt && d.closedAt.toMillis ?
      d.closedAt.toMillis() : null,
    closeReason: d.closeReason || "",
  };
}

async function ppLoadHousePlans(houseNo, year) {
  const snap = await db.collection(PP_PLANS_COLLECTION)
      .where("houseNo", "==", houseNo).get();
  return snap.docs.map(ppMapPlan)
      .filter((plan) => year == null || Number(plan.year) === Number(year));
}

async function ppActivePlan(houseNo, period, year) {
  const doc = await db.collection(PP_PLANS_COLLECTION)
      .doc(ppPlanId(houseNo, "common", period, year)).get();
  if (!doc.exists) return null;
  const plan = ppMapPlan(doc);
  return isPlanActive(plan) ? plan : null;
}

async function ppHouseBilling(houseNo, year) {
  const [paymentSnap, plans] = await Promise.all([
    db.collection(PP_COLLECTION).where("houseNo", "==", houseNo).get(),
    ppLoadHousePlans(houseNo, year),
  ]);
  return buildHouseBilling({
    houseNo,
    year,
    baseAmount: PP_COMMON_BASE,
    payments: paymentSnap.docs.map(ppMapDoc),
    plans,
  });
}

// Move records created by the retired public slip inbox into the normal
// payment verification queue. Deterministic payment IDs make this idempotent:
// retrying an interrupted adminList request cannot create a second payment.
async function ppMigrateLegacySlipInbox() {
  const snap = await db.collection(PP_SLIP_INBOX_COLLECTION).limit(200).get();
  const pending = snap.docs.filter((doc) => {
    const data = doc.data() || {};
    return data.status !== "processed" && data.slipUrl && ppHouseNum(data.houseNo);
  });
  if (!pending.length) return 0;

  const batch = db.batch();
  const migrations = await Promise.all(pending.map(async (doc) => {
    const data = doc.data() || {};
    const houseNo = ppHouseNum(data.houseNo);
    const houseSnap = await db.collection(PP_COLLECTION)
        .where("houseNo", "==", houseNo).get();
    const existing = houseSnap.docs.find((paymentDoc) => {
      const payment = paymentDoc.data() || {};
      return payment.feeType === "common" &&
        payment.period === (data.period || PP_PUBLIC_COMMON_PERIOD) &&
        payment.year === Number(data.year || PP_PUBLIC_COMMON_YEAR) &&
        (payment.status === "pending" || payment.status === "verified");
    });
    if (existing) {
      return {inboxRef: doc.ref, paymentRef: existing.ref, payload: null};
    }
    const paymentRef = db.collection(PP_COLLECTION).doc(`inbox_${doc.id}`);
    return {
      inboxRef: doc.ref,
      paymentRef,
      payload: {
        houseNo,
        feeType: "common",
        period: data.period || PP_PUBLIC_COMMON_PERIOD,
        year: Number(data.year || PP_PUBLIC_COMMON_YEAR),
        amount: Number(data.amount || commonSlipAmount(PP_COMMON_BASE, houseNo)),
        payerName: "",
        email: data.email || "",
        slipUrl: data.slipUrl || "",
        status: "pending",
        source: "resident_upload",
        legacyInboxId: doc.id,
        createdAt: data.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      },
    };
  }));
  migrations.forEach(({inboxRef, paymentRef, payload}) => {
    if (payload) batch.set(paymentRef, payload, {merge: true});
    batch.update(inboxRef, {
      status: "processed",
      paymentId: paymentRef.id,
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
  return pending.length;
}

exports.pattraPay = onRequest(
    {secrets: [LPR_ADMIN_PASSWORD, RESEND_API_KEY]},
    async (req, res) => {
      setCorsHeaders(req, res);
      if (req.method === "OPTIONS") { res.status(204).send(""); return; }
      if (req.method !== "POST") { res.status(405).json({ok: false, error: "Method Not Allowed"}); return; }

      try {
        const body = req.body || {};
        const action = String(body.action || "").trim();

        // -------- public: current common-fee position by house ------------
        if (action === "houseBilling") {
          const houseNo = ppHouseNum(body.houseNo);
          if (!houseNo) {
            throw Object.assign(new Error("บ้านเลขที่ไม่ถูกต้อง"), {status: 400});
          }
          const year = Number.isFinite(parseInt(body.year, 10)) ?
            parseInt(body.year, 10) : PP_PUBLIC_COMMON_YEAR;
          const billing = await ppHouseBilling(houseNo, year);
          const hasInstallment = billing.periods.some((card) =>
            Boolean(card.installment));
          let balanceAuthorized = !hasInstallment;
          if (hasInstallment && String(body.pin || "").trim()) {
            await verifyResidentPinInternal(
                `${PP_BLOCK}/${houseNo}`,
                String(body.pin || ""),
            );
            balanceAuthorized = true;
          }
          const protectedBilling = balanceAuthorized ?
            {...billing, requiresPin: false} :
            redactInstallmentBalances(billing);
          res.status(200).json({
            ok: true,
            ...protectedBilling,
            houseBlock: PP_BLOCK,
          });
          return;
        }

        // -------- public: simple common-fee slip upload --------------------
        if (action === "submitCommonSlip") {
          const houseNo = ppHouseNum(body.houseNo);
          if (!houseNo) {
            throw Object.assign(new Error("บ้านเลขที่ไม่ถูกต้อง"), {status: 400});
          }
          const period = normalizeCommonPeriod(
              body.period, PP_PUBLIC_COMMON_PERIOD);
          const year = Number.isFinite(parseInt(body.year, 10)) ?
            parseInt(body.year, 10) : PP_PUBLIC_COMMON_YEAR;
          const email = normalizeOptionalReceiptEmail(body.email);
          const slip = ppParseSlip(body.slipDataUrl);
          if (!slip) {
            throw Object.assign(new Error("กรุณาแนบรูปสลิป"), {status: 400});
          }
          const allowedTypes = new Set([
            "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
          ]);
          if (!allowedTypes.has(slip.contentType)) {
            throw Object.assign(new Error("รองรับเฉพาะไฟล์รูปภาพ JPG, PNG, WEBP หรือ HEIC"),
                {status: 400});
          }
          if (slip.buffer.length > 10 * 1024 * 1024) {
            throw Object.assign(new Error("ไฟล์สลิปใหญ่เกิน 10MB"), {status: 400});
          }

          const plan = await ppActivePlan(houseNo, period, year);
          let balanceAuthorized = false;
          if (plan && String(body.pin || "").trim()) {
            await verifyResidentPinInternal(
                `${PP_BLOCK}/${houseNo}`,
                String(body.pin || ""),
            );
            balanceAuthorized = true;
          }
          const [paymentSnap, legacyInboxSnap] = await Promise.all([
            db.collection(PP_COLLECTION).where("houseNo", "==", houseNo).get(),
            db.collection(PP_SLIP_INBOX_COLLECTION).where("houseNo", "==", houseNo).get(),
          ]);
          const hasPayment = paymentSnap.docs.some((doc) => {
            const data = doc.data() || {};
            if (data.feeType !== "common" || data.period !== period ||
                Number(data.year) !== Number(year)) {
              return false;
            }
            return plan ? data.status === "pending" :
              data.status === "pending" || data.status === "verified";
          });
          const hasLegacyUpload = !plan && legacyInboxSnap.docs.some((doc) => {
            const data = doc.data() || {};
            return data.period === period &&
              Number(data.year) === Number(year) &&
              data.status !== "processed" &&
              data.slipUrl;
          });
          if (hasPayment || hasLegacyUpload) {
            res.status(200).json({
              ok: true,
              duplicate: true,
              status: "received",
            });
            return;
          }

          const ref = db.collection(PP_COLLECTION).doc();
          const ext = slip.contentType.split("/")[1] || "jpg";
          const storagePath = `pattra-slips/${ref.id}.${ext}`;
          const token = crypto.randomUUID();
          const bucket = admin.storage().bucket();
          await bucket.file(storagePath).save(slip.buffer, {
            resumable: false,
            metadata: {
              contentType: slip.contentType,
              contentDisposition: `attachment; filename="slip-38-${houseNo}.${ext}"`,
              metadata: {firebaseStorageDownloadTokens: token},
            },
          });
          const slipUrl = "https://firebasestorage.googleapis.com/v0/b/" +
            `${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&` +
            `token=${token}`;
          const uploadedAt = new Date();
          let amount = commonSlipAmount(PP_COMMON_BASE, houseNo);
          let ocr = null;
          if (plan) {
            amount = 0;
            try {
              ocr = await ppAnalyzeSlipImage(slip.buffer, slip.contentType);
              if (ocr && Number(ocr.amount) > 0) amount = Number(ocr.amount);
            } catch (error) {
              logger.warn("pattraPay plan slip OCR failed", error);
            }
          }
          const payload = {
            houseNo,
            feeType: "common",
            period,
            year,
            amount,
            payerName: "",
            email,
            slipUrl,
            storagePath,
            status: "pending",
            source: "resident_upload",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          if (plan) {
            payload.planId = plan.id;
            payload.ocrAmount = amount > 0 ? amount : null;
            payload.bank = ocr && ocr.bank || "";
            payload.slipPayerName = ocr && ocr.payerName || "";
            payload.confidence = ocr ? String(ocr.confidence) : "";
            payload.reviewNote = amount > 0 ?
              "ผ่อนชำระ — ยอดอ่านจากสลิปอัตโนมัติ กรุณาตรวจก่อนยืนยัน" :
              "ผ่อนชำระ — อ่านยอดจากสลิปไม่ได้ กรุณากรอกยอดก่อนยืนยัน";
          }
          await ref.set(payload);
          const notification = await ppSendEmail(
              PP_ADMIN_NOTIFICATION_EMAIL,
              `มีสลิปใหม่ บ้าน 38/${houseNo} · ${amount.toFixed(2)} บาท`,
              ppNewSlipNotificationHtml(houseNo, amount, uploadedAt),
          );
          const notificationPatch = {
            adminNotificationStatus: notification.sent ?
              "sent" : `failed:${notification.reason || "unknown"}`,
          };
          if (notification.sent) {
            notificationPatch.adminNotificationSentAt =
              admin.firestore.FieldValue.serverTimestamp();
          }
          await ref.update(notificationPatch).catch((error) => {
            logger.warn("pattraPay notification status update failed", error);
          });
          const response = {ok: true, duplicate: false, status: "received"};
          if (plan && balanceAuthorized) {
            const progress = planProgress(plan);
            response.installment = {
              amount,
              totalAmount: progress.totalAmount,
              paidAmount: progress.paidAmount,
              projectedPaidAmount:
                Math.round((progress.paidAmount + amount) * 100) / 100,
              projectedRemaining: Math.max(0, Math.round(
                  (progress.totalAmount - progress.paidAmount - amount) * 100,
              ) / 100),
              percent: progress.percent,
            };
          }
          res.status(200).json(response);
          return;
        }

        // -------- admin: list the separate public slip inbox --------------
        if (action === "adminListCommonSlips") {
          await verifyAdminResidentAccess(body);
          const snap = await db.collection(PP_SLIP_INBOX_COLLECTION)
              .orderBy("createdAt", "desc").limit(200).get();
          const uploads = snap.docs.map((doc) => {
            const data = doc.data() || {};
            return {
              id: doc.id,
              houseNo: data.houseNo,
              email: data.email || "",
              amount: Number(data.amount || 0),
              slipUrl: data.slipUrl || "",
              status: data.status || "new",
              createdAt: data.createdAt && data.createdAt.toMillis ?
                data.createdAt.toMillis() : null,
            };
          });
          res.status(200).json({ok: true, uploads});
          return;
        }

        // -------- admin: remove a migrated record from the retired inbox ---
        if (action === "adminDeleteLegacyCommonSlip") {
          await verifyAdminResidentAccess(body);
          const uploadId = String(body.id || "").trim();
          if (!/^[A-Za-z0-9_-]{1,200}$/.test(uploadId)) {
            throw Object.assign(new Error("รหัสรายการไม่ถูกต้อง"), {status: 400});
          }
          const inboxRef = db.collection(PP_SLIP_INBOX_COLLECTION).doc(uploadId);
          const inboxDoc = await inboxRef.get();
          if (!inboxDoc.exists) {
            throw Object.assign(new Error("ไม่พบรายการในกล่องรับสลิปเดิม"), {status: 404});
          }
          const inbox = inboxDoc.data() || {};
          const houseNo = ppHouseNum(inbox.houseNo);
          const paymentSnap = houseNo ?
            await db.collection(PP_COLLECTION).where("houseNo", "==", houseNo).get() :
            null;
          const payment = paymentSnap && paymentSnap.docs.find((doc) => {
            const data = doc.data() || {};
            return data.feeType === "common" &&
              data.period === (inbox.period || PP_PUBLIC_COMMON_PERIOD) &&
              data.year === Number(inbox.year || PP_PUBLIC_COMMON_YEAR) &&
              (data.status === "pending" || data.status === "verified");
          });
          if (!payment) {
            throw Object.assign(
                new Error("ยังไม่พบรายการนี้ใน Pay Status จึงยังลบจากกล่องเดิมไม่ได้"),
                {status: 409},
            );
          }
          // Keep the payment record and its Storage object. Only the obsolete
          // inbox pointer is removed, so review history and slip access remain.
          await inboxRef.delete();
          res.status(200).json({
            ok: true,
            deleted: true,
            houseNo,
            paymentId: payment.id,
          });
          return;
        }

        // -------- public: submit a payment ---------------------------------
        // One parking transfer may cover several consecutive months (600 = 1,
        // 1,200 = 2, 3,600.xx = 6). Each month becomes its own pending row so
        // the existing verify/receipt flow is unchanged, and the rows share a
        // groupId plus one uploaded slip.
        if (action === "submitPayment") {
          const houseNo = ppHouseNum(body.houseNo);
          const feeType = String(body.feeType || "");
          const year = parseInt(body.year, 10);
          const amount = Number(body.amount);
          if (!houseNo) throw Object.assign(new Error("บ้านเลขที่ไม่ถูกต้อง"), {status: 400});
          if (feeType !== "common" && feeType !== "parking") throw Object.assign(new Error("ประเภทไม่ถูกต้อง"), {status: 400});
          if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error("ยอดเงินไม่ถูกต้อง"), {status: 400});

          // Either an explicit list of months, or a start month + a count.
          const startPeriod = String(body.startPeriod || "").trim();
          const monthCount = parseInt(body.months, 10);
          const requested = Array.isArray(body.periods) ?
            body.periods :
            (startPeriod && Number.isFinite(monthCount) ?
              parkingPeriodsFrom(startPeriod, monthCount) :
              (body.period ? [body.period] : []));
          let periods = requested
              .map((value) => String(value || "").trim())
              .filter(Boolean);

          // Slip-first parking: the resident only attaches the slip. Read the
          // transferred amount off it, turn that into a run of months, and
          // start from the first month the house does not already hold.
          let read = null;
          if (feeType === "parking" && !periods.length) {
            read = await ppReadParkingSlip(
                body.slipDataUrl, houseNo, amount, startPeriod,
            );
            periods = read.periods;
            if (!periods.length) {
              throw Object.assign(
                  new Error(read.error ||
                    "อ่านยอดจากสลิปไม่ได้ กรุณาเลือกเดือนเอง"),
                  {status: 400},
              );
            }
          }
          if (!periods.length) throw Object.assign(new Error("ไม่ระบุงวด"), {status: 400});
          if (new Set(periods).size !== periods.length) {
            throw Object.assign(new Error("งวดซ้ำกัน"), {status: 400});
          }
          if (periods.length > 1) {
            if (feeType !== "parking") {
              throw Object.assign(new Error("ชำระหลายงวดพร้อมกันได้เฉพาะค่าจอดรถ"), {status: 400});
            }
            if (periods.length > MAX_PARKING_PERIODS) {
              throw Object.assign(
                  new Error(`ชำระล่วงหน้าได้ไม่เกิน ${MAX_PARKING_PERIODS} เดือนต่อหนึ่งสลิป`),
                  {status: 400},
              );
            }
          }

          const total = read ? read.amount : amount;
          const rows = splitSlipAmount(total, houseNo, periods.length);
          if (rows.length !== periods.length) {
            throw Object.assign(new Error("แบ่งยอดตามงวดไม่ได้"), {status: 400});
          }

          const refs = periods.map(() => db.collection(PP_COLLECTION).doc());
          // Upload once and point every month at the same slip image.
          const slipUrl = await ppUploadSlipDataUrl(refs[0].id, body.slipDataUrl);
          const groupId = periods.length > 1 ? refs[0].id : "";
          const email = String(body.email || "").trim();
          // Free text from the resident ("โอนรวม 3 เดือน", "โอนจากบัญชีแม่").
          // Kept apart from reviewNote, which the system writes.
          const residentNote = ppCleanImportText(body.residentNote, 500);

          // Advisory only: say so when the transferred amount is not a clean
          // multiple of the monthly rate, so the committee looks closer.
          const suggestion = inferParkingMonths(
              total, PP_PARKING_RATE, houseNo,
          );
          const mismatch = !suggestion.auto ||
            suggestion.months !== periods.length;
          const groupNote =
            `ชำระล่วงหน้า ${periods.length} เดือนในสลิปเดียว ` +
            `(${periods[0]} ถึง ${periods[periods.length - 1]}) ` +
            `ยอดโอนรวม ${total.toFixed(2)} บาท` +
            (mismatch ? " — ยอดไม่ตรงจำนวนเดือน กรุณาตรวจก่อนยืนยัน" : "");

          const batch = db.batch();
          refs.forEach((ref, index) => {
            // A parking run can cross into the next year, so each row keeps
            // the year of its own month rather than the year of the transfer.
            const rowYear = feeType === "parking" ?
              Number(periods[index].slice(0, 4)) || year : year;
            const payload = {
              houseNo,
              feeType,
              period: periods[index],
              year: rowYear,
              amount: rows[index] / 100,
              payerName: "",
              email,
              slipUrl,
              status: "pending",
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            };
            if (residentNote) payload.residentNote = residentNote;
            if (read) {
              payload.source = "resident_upload";
              payload.ocrAmount = read.amount;
              payload.bank = read.bank;
              payload.slipPayerName = read.payerName;
              payload.slipMemo = read.memo;
              payload.periodSource = read.startedFrom;
              payload.confidence = String(read.confidence);
              // Say where the month came from as well as the amount: a month
              // taken from the memo is a reading of the slip, and the
              // committee should be able to check it against the image.
              const whichMonth = read.startedFrom === "memo" ?
                ` · งวดตาม memo บนสลิป ("${read.memo}")` :
                read.startedFrom === "resident" ?
                  " · งวดที่ลูกบ้านเลือกเอง" :
                  " · งวดตามเดือนที่ค้างเก่าสุด";
              payload.reviewNote =
                `อ่านยอดจากสลิปอัตโนมัติ ${read.amount.toFixed(2)} บาท` +
                whichMonth + " — กรุณาตรวจก่อนยืนยัน";
            }
            if (groupId) {
              payload.groupId = groupId;
              payload.groupIndex = index;
              payload.groupSize = periods.length;
              payload.groupAmount = total;
              payload.reviewNote = groupNote;
            }
            batch.set(ref, payload);
          });
          await batch.commit();

          res.status(200).json({
            ok: true,
            id: refs[0].id,
            ids: refs.map((ref) => ref.id),
            periods,
            groupId,
            amount: total,
            months: periods.length,
            read: read ? {
              amount: read.amount,
              bank: read.bank,
              confidence: read.confidence,
              exact: read.exact,
              memo: read.memo,
              memoPeriod: read.memoPeriod,
              startedFrom: read.startedFrom,
            } : null,
          });
          return;
        }

        // -------- public: status board (house numbers only, no PII) --------
        if (action === "publicStatus") {
          const [snap, planSnap] = await Promise.all([
            db.collection(PP_COLLECTION)
                .where("status", "in", ["verified", "pending"]).get(),
            db.collection(PP_PLANS_COLLECTION)
                .where("status", "==", "active").get(),
          ]);
          const status = {common: {}, parking: {}};
          const pending = {common: {}, parking: {}};
          const installment = {common: {}, parking: {}};
          const onPlan = new Set();
          planSnap.docs.forEach((doc) => {
            const plan = ppMapPlan(doc);
            const key = `${plan.year}:${plan.period}`;
            onPlan.add(`${plan.houseNo}|${plan.feeType}|${key}`);
            if (!installment.common[key]) installment.common[key] = [];
            installment.common[key].push({
              houseNo: plan.houseNo,
              percent: planProgress(plan).percent,
            });
          });
          snap.docs.forEach((doc) => {
            const d = doc.data() || {};
            const key = d.feeType === "common" ?
              `${d.year}:${d.period}` : d.period;
            if (onPlan.has(`${d.houseNo}|${d.feeType}|${key}`)) return;
            const target = d.status === "verified" ? status : pending;
            const bucket = d.feeType === "common" ? target.common : target.parking;
            if (!bucket[key]) bucket[key] = [];
            if (!bucket[key].includes(d.houseNo)) bucket[key].push(d.houseNo);
          });
          res.status(200).json({ok: true, status, pending, installment});
          return;
        }

        // -------- admin: list all payments (PII) ---------------------------
        if (action === "adminList") {
          await verifyAdminResidentAccess(body);
          await ppMigrateLegacySlipInbox();
          const snap = await db.collection(PP_COLLECTION).orderBy("createdAt", "desc").limit(1000).get();
          res.status(200).json({ok: true, payments: snap.docs.map(ppMapDoc)});
          return;
        }

        // -------- admin: import LINE album CSV rows as pending -------------
        if (action === "adminImportPayments") {
          await verifyAdminResidentAccess(body);
          const rows = Array.isArray(body.payments) ? body.payments : [];
          if (!rows.length) throw Object.assign(new Error("ไม่มีรายการนำเข้า"), {status: 400});
          if (rows.length > 100) throw Object.assign(new Error("นำเข้าได้ไม่เกิน 100 รายการต่อครั้ง"), {status: 400});

          const imported = [];
          const skipped = [];
          const batch = db.batch();

          for (const row of rows) {
            const houseNo = ppHouseNum(row.houseNo);
            const feeType = String(row.feeType || "common");
            const period = ppCleanImportText(row.period, 20);
            const year = parseInt(row.year, 10);
            const amount = Number(row.amount);
            if (!houseNo || (feeType !== "common" && feeType !== "parking") ||
                !period || !Number.isFinite(year) ||
                !Number.isFinite(amount) || amount <= 0) {
              skipped.push({houseNo: row.houseNo || "", reason: "invalid"});
              continue;
            }

            const transactionRef = ppCleanImportText(row.transactionRef, 120);
            if (transactionRef) {
              const existing = await db.collection(PP_COLLECTION)
                  .where("transactionRef", "==", transactionRef)
                  .limit(1).get();
              if (!existing.empty) {
                skipped.push({houseNo, transactionRef, reason: "duplicate"});
                continue;
              }
            }

            const ref = db.collection(PP_COLLECTION).doc();
            const paidAt = ppTimestampFromMillis(row.paidAt);
            const payload = {
              houseNo,
              feeType,
              period,
              year,
              amount,
              payerName: ppCleanImportText(row.payerName, 160),
              email: "",
              slipUrl: "",
              status: "pending",
              source: "line_album",
              paidAt,
              bank: ppCleanImportText(row.bank, 80),
              transactionRef,
              importFile: ppCleanImportText(row.importFile, 240),
              confidence: ppCleanImportText(row.confidence, 20),
              overage: Math.max(0, Number(row.overage || 0)),
              rawNote: ppCleanImportText(row.rawNote, 500),
              reviewNote: ppCleanImportText(row.reviewNote, 500),
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            };
            batch.set(ref, payload);
            imported.push({id: ref.id, houseNo, transactionRef});
          }

          if (imported.length) await batch.commit();
          res.status(200).json({ok: true, imported, skipped});
          return;
        }

        // -------- admin: attach slip images to imported pending records ----
        if (action === "adminAttachSlips") {
          await verifyAdminResidentAccess(body);
          const rows = Array.isArray(body.slips) ? body.slips : [];
          if (!rows.length) throw Object.assign(new Error("ไม่มีรูปสลิป"), {status: 400});
          if (rows.length > 100) throw Object.assign(new Error("แนบรูปได้ไม่เกิน 100 รายการต่อครั้ง"), {status: 400});

          const attached = [];
          const skipped = [];

          for (const row of rows) {
            const transactionRef = ppCleanImportText(row.transactionRef, 120);
            const id = ppCleanImportText(row.id, 120);
            let snap = null;
            if (id) {
              const byId = await db.collection(PP_COLLECTION).doc(id).get();
              if (byId.exists) snap = byId;
            }
            if (!snap && transactionRef) {
              const byRef = await db.collection(PP_COLLECTION)
                  .where("transactionRef", "==", transactionRef)
                  .limit(1).get();
              if (!byRef.empty) snap = byRef.docs[0];
            }
            if (!snap) {
              skipped.push({transactionRef, reason: "not-found"});
              continue;
            }
            const slipUrl = await ppUploadSlipDataUrl(snap.id, row.slipDataUrl);
            if (!slipUrl) {
              skipped.push({transactionRef, id: snap.id, reason: "bad-slip"});
              continue;
            }
            await snap.ref.update({
              slipUrl,
              importFile: ppCleanImportText(row.importFile, 240) || snap.data().importFile || "",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            attached.push({id: snap.id, houseNo: snap.data().houseNo, transactionRef, slipUrl});
          }

          res.status(200).json({ok: true, attached, skipped});
          return;
        }

        // -------- admin: OCR a slip to pre-fill the upload form ------------
        // Reads house number / amount / bank off the slip image so the
        // paystatus drag-drop panel can auto-fill. Read-only: nothing is
        // written to Firestore or Storage here.
        if (action === "ocrSlip") {
          await verifyAdminResidentAccess(body);
          const slip = ppParseSlip(body.slipDataUrl);
          if (!slip) throw Object.assign(new Error("ไม่มีรูปสลิป"), {status: 400});
          if (slip.buffer.length > 10 * 1024 * 1024) {
            throw Object.assign(new Error("ไฟล์สลิปใหญ่เกิน 10MB"), {status: 400});
          }
          const ocr = await ppAnalyzeSlipImage(slip.buffer, slip.contentType);
          res.status(200).json({ok: true, ...ocr});
          return;
        }

        // -------- admin: add a new payment from an uploaded slip -----------
        // Drag-and-drop upload in the paystatus admin UI. Creates a normal
        // pending record (with slip already attached) that flows straight
        // into the ตรวจรายการ queue. Soft duplicate check: warns unless the
        // admin explicitly confirms (confirmDuplicate:true).
        if (action === "adminAddPayment") {
          await verifyAdminResidentAccess(body);
          const houseNo = ppHouseNum(body.houseNo);
          const feeType = String(body.feeType || "common");
          const year = parseInt(body.year, 10);
          const amount = Number(body.amount);
          if (!houseNo) throw Object.assign(new Error("บ้านเลขที่ไม่ถูกต้อง"), {status: 400});
          if (feeType !== "common" && feeType !== "parking") throw Object.assign(new Error("ประเภทไม่ถูกต้อง"), {status: 400});
          if (!Number.isFinite(year)) throw Object.assign(new Error("ปีไม่ถูกต้อง"), {status: 400});
          if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error("ยอดเงินไม่ถูกต้อง"), {status: 400});
          if (!ppParseSlip(body.slipDataUrl)) throw Object.assign(new Error("ไม่มีรูปสลิป"), {status: 400});

          // Parking may be prepaid several months on one slip, so the period
          // is a list here. Common fee stays exactly one period.
          const askedPeriods = Array.isArray(body.periods) ?
            body.periods : [body.period];
          const periods = askedPeriods
              .map((value) => ppCleanImportText(value, 20))
              .filter(Boolean);
          if (!periods.length) throw Object.assign(new Error("ไม่ระบุงวด"), {status: 400});
          if (new Set(periods).size !== periods.length) {
            throw Object.assign(new Error("งวดซ้ำกัน"), {status: 400});
          }
          if (periods.length > 1) {
            if (feeType !== "parking") {
              throw Object.assign(new Error("ชำระหลายงวดพร้อมกันได้เฉพาะค่าจอดรถ"), {status: 400});
            }
            if (periods.length > MAX_PARKING_PERIODS) {
              throw Object.assign(
                  new Error(`ชำระล่วงหน้าได้ไม่เกิน ${MAX_PARKING_PERIODS} เดือนต่อหนึ่งสลิป`),
                  {status: 400},
              );
            }
          }

          // Single-field query (no composite index needed) + in-memory filter —
          // a house has at most a handful of payment rows, so this is cheap.
          const houseSnap = await db.collection(PP_COLLECTION).where("houseNo", "==", houseNo).get();
          const dupDocs = houseSnap.docs.filter((d) => {
            const dd = d.data();
            return dd.feeType === feeType && periods.includes(dd.period) &&
              dd.year === year &&
              (dd.status === "pending" || dd.status === "verified");
          });
          if (dupDocs.length && body.confirmDuplicate !== true) {
            const existing = dupDocs.map((d) => ({
              id: d.id,
              period: d.data().period,
              amount: d.data().amount,
              status: d.data().status,
            }));
            res.status(200).json({ok: true, duplicate: true, existing});
            return;
          }

          const rows = splitSlipAmount(amount, houseNo, periods.length);
          if (rows.length !== periods.length) {
            throw Object.assign(new Error("แบ่งยอดตามงวดไม่ได้"), {status: 400});
          }
          const refs = periods.map(() => db.collection(PP_COLLECTION).doc());
          const slipUrl = await ppUploadSlipDataUrl(refs[0].id, body.slipDataUrl);
          const groupId = periods.length > 1 ? refs[0].id : "";
          const payerName = ppCleanImportText(body.payerName, 160);
          const bank = ppCleanImportText(body.bank, 80);
          const transactionRef = ppCleanImportText(body.transactionRef, 120);
          const reviewNote = ppCleanImportText(body.reviewNote, 500);

          const batch = db.batch();
          refs.forEach((ref, index) => {
            const payload = {
              houseNo, feeType, year,
              period: periods[index],
              amount: rows[index] / 100,
              payerName,
              // Admin-entered rows are typed straight off the slip image, so
              // the same value is the slip evidence. Verify may later replace
              // payerName with the register name; this copy stays put.
              slipPayerName: payerName,
              email: "", slipUrl, status: "pending", source: "admin_upload",
              bank, transactionRef,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            };
            if (reviewNote) payload.reviewNote = reviewNote;
            if (groupId) {
              payload.groupId = groupId;
              payload.groupIndex = index;
              payload.groupSize = periods.length;
              payload.groupAmount = amount;
              payload.reviewNote = (reviewNote ? `${reviewNote} · ` : "") +
                `ชำระล่วงหน้า ${periods.length} เดือนในสลิปเดียว ` +
                `(${periods[0]} ถึง ${periods[periods.length - 1]}) ` +
                `ยอดโอนรวม ${amount.toFixed(2)} บาท`;
            }
            batch.set(ref, payload);
          });
          await batch.commit();

          res.status(200).json({
            ok: true,
            duplicate: false,
            id: refs[0].id,
            ids: refs.map((ref) => ref.id),
            periods,
            groupId,
          });
          return;
        }

        // -------- admin: patch pending payment metadata -------------------
        // Pending installment rows may also correct the advisory OCR amount.
        if (action === "adminPatchPayment") {
          await verifyAdminResidentAccess(body);
          const id = String(body.id || "");
          if (!id) throw Object.assign(new Error("ไม่ระบุรายการ"), {status: 400});
          const ref = db.collection(PP_COLLECTION).doc(id);
          const snap = await ref.get();
          if (!snap.exists) throw Object.assign(new Error("ไม่พบรายการ"), {status: 404});
          const d = snap.data() || {};
          if (d.status !== "pending") {
            throw Object.assign(new Error("แก้ได้เฉพาะรายการรอตรวจ"), {status: 400});
          }
          const patch = {updatedAt: admin.firestore.FieldValue.serverTimestamp()};
          if (Object.prototype.hasOwnProperty.call(body, "payerName")) {
            patch.payerName = ppCleanImportText(body.payerName, 160);
          }
          if (Object.prototype.hasOwnProperty.call(body, "email")) {
            patch.email = ppCleanImportText(body.email, 160);
          }
          if (Object.prototype.hasOwnProperty.call(body, "bank")) {
            patch.bank = ppCleanImportText(body.bank, 80);
          }
          if (Object.prototype.hasOwnProperty.call(body, "reviewNote")) {
            patch.reviewNote = ppCleanImportText(body.reviewNote, 500);
          }
          if (Object.prototype.hasOwnProperty.call(body, "amount")) {
            if (!d.planId) {
              throw Object.assign(
                  new Error("แก้ยอดได้เฉพาะรายการผ่อนชำระ"), {status: 400});
            }
            const amount = Number(body.amount);
            if (!Number.isFinite(amount) || amount <= 0) {
              throw Object.assign(new Error("ยอดเงินไม่ถูกต้อง"), {status: 400});
            }
            patch.amount = Math.round(amount * 100) / 100;
            patch.amountReviewedAt = admin.firestore.FieldValue.serverTimestamp();
            patch.amountReviewedBy = normalizeHouseNo(body.adminHouseNo || "");
          }
          await ref.update(patch);
          res.status(200).json({ok: true, id});
          return;
        }

        // -------- admin: send a SAMPLE receipt email (UAT/test only) -------
        // Renders ppReceiptHtml with fake data and emails it to `to`. Does NOT
        // touch any payment record or the receipt counter — safe to run anytime.
        if (action === "testReceiptEmail") {
          await verifyAdminResidentAccess(body);
          const to = String(body.to || "").trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
            throw Object.assign(new Error("อีเมลปลายทางไม่ถูกต้อง"), {status: 400});
          }
          const sample = {
            houseNo: 16, feeType: "common", period: "H2",
            year: new Date().getFullYear(), amount: 9600.16,
            payerName: "ตัวอย่าง ผู้ชำระ", email: to,
            receiptNo: "RC-TEST-0000", verifiedAt: Date.now(),
          };
          const html = ppReceiptHtml(sample);
          const mail = await ppSendEmail(
              to, "ตัวอย่างใบเสร็จรับเงิน (ทดสอบระบบ) · Pattra Villa 8", html);
          res.status(200).json({ok: true, test: true, sent: mail.sent, reason: mail.reason || null, to});
          return;
        }

        // -------- admin: verify + issue + email receipt --------------------
        if (action === "adminVerify") {
          await verifyAdminResidentAccess(body);
          const id = String(body.id || "");
          if (!id) throw Object.assign(new Error("ไม่ระบุรายการ"), {status: 400});
          const ref = db.collection(PP_COLLECTION).doc(id);
          const before = await ref.get();
          if (!before.exists) {
            throw Object.assign(new Error("ไม่พบรายการ"), {status: 404});
          }
          const d = before.data() || {};

          // resolve resident name + email from residents collection.
          // Admin-picked name/email override the slip/resident defaults.
          const overrideName = typeof body.payerName === "string" ? body.payerName.trim() : "";
          const overrideEmail = typeof body.receiptEmail === "string" ? body.receiptEmail.trim() : "";
          let name = overrideName || d.payerName || "";
          let email = overrideEmail || d.email || "";
          try {
            const resident = await findPaymentResident(
                db.collection(RESIDENTS_COLLECTION),
                d.houseNo,
            );
            if (resident) {
              if (!name) name = resident.name || "";
              if (!email) email = resident.email || "";
            }
          } catch (e) { logger.warn("resident resolve failed", e); }

          const issued = await commitPaymentVerification(db, ref, {
            planCollection: PP_PLANS_COLLECTION,
            applyPaymentToPlan,
            payerName: name,
            email,
            verifiedAtMs: Date.now(),
            serverTimestamp: () =>
              admin.firestore.FieldValue.serverTimestamp(),
            renderReceipt: ppReceiptHtml,
          });
          if (issued.alreadyIssued) {
            res.status(200).json({
              ok: true,
              receiptNo: issued.receiptNo,
              emailSent: false,
              emailReason: "already-issued",
              alreadyIssued: true,
              receiptHtml: issued.receiptHtml,
              installment: issued.installment,
            });
            return;
          }

          const receiptNo = issued.receiptNo;
          const html = issued.receiptHtml;
          const mail = await ppSendEmail(
              email,
              "Pattra Villa 8: ใบเสร็จรับเงิน " +
                `${d.feeType === "common" ? "ค่าส่วนกลาง" : "ค่าจอดรถ"} ` +
                `บ้านเลขที่ ${PP_BLOCK}/${d.houseNo} ${ppPeriodLabel(d)}`,
              html,
          );

          await ref.update({
            receiptSentAt: mail.sent ? admin.firestore.FieldValue.serverTimestamp() : null,
            emailStatus: mail.sent ? "sent" : `not-sent:${mail.reason}`,
          });

          res.status(200).json({
            ok: true,
            receiptNo,
            emailSent: mail.sent,
            emailReason: mail.reason || null,
            receiptHtml: html,
            installment: issued.installment,
          });
          return;
        }

        // -------- admin: verify a whole multi-month transfer at once -------
        // A parking slip that paid several months is stored as one row per
        // month. The resident made ONE payment, so this approves every month
        // together and issues a single receipt for the full amount.
        if (action === "adminVerifyGroup") {
          await verifyAdminResidentAccess(body);
          const groupId = String(body.groupId || "").trim();
          if (!groupId) throw Object.assign(new Error("ไม่ระบุกลุ่มรายการ"), {status: 400});

          const snap = await db.collection(PP_COLLECTION)
              .where("groupId", "==", groupId).get();
          if (snap.empty) {
            throw Object.assign(new Error("ไม่พบรายการของสลิปใบนี้"), {status: 404});
          }
          const docs = snap.docs.slice().sort((a, b) => {
            const ai = Number((a.data() || {}).groupIndex || 0);
            const bi = Number((b.data() || {}).groupIndex || 0);
            return ai - bi;
          });
          const first = docs[0].data() || {};
          const last = docs[docs.length - 1].data() || {};

          const overrideName = typeof body.payerName === "string" ? body.payerName.trim() : "";
          const overrideEmail = typeof body.receiptEmail === "string" ? body.receiptEmail.trim() : "";
          let name = overrideName || first.payerName || "";
          let email = overrideEmail || first.email || "";
          try {
            const resident = await findPaymentResident(
                db.collection(RESIDENTS_COLLECTION),
                first.houseNo,
            );
            if (resident) {
              if (!name) name = resident.name || "";
              if (!email) email = resident.email || "";
            }
          } catch (e) { logger.warn("resident resolve failed", e); }

          const spanLabel = docs.length > 1 ?
            `${ppPeriodLabel(first)} – ${ppPeriodLabel(last)}` :
            ppPeriodLabel(first);

          const issued = await commitGroupVerification(
              db, docs.map((doc) => doc.ref), {
                payerName: name,
                email,
                periodLabel: spanLabel,
                verifiedAtMs: Date.now(),
                serverTimestamp: () =>
                  admin.firestore.FieldValue.serverTimestamp(),
                renderReceipt: ppReceiptHtml,
              });
          if (issued.alreadyIssued) {
            res.status(200).json({
              ok: true,
              receiptNo: issued.receiptNo,
              emailSent: false,
              emailReason: "already-issued",
              alreadyIssued: true,
              receiptHtml: issued.receiptHtml,
              months: docs.length,
            });
            return;
          }

          const mail = await ppSendEmail(
              email,
              "Pattra Villa 8: ใบเสร็จรับเงิน ค่าจอดรถ " +
                `บ้านเลขที่ ${PP_BLOCK}/${first.houseNo} ` +
                `${spanLabel} (${docs.length} เดือน)`,
              issued.receiptHtml,
          );
          await docs[0].ref.update({
            receiptSentAt: mail.sent ?
              admin.firestore.FieldValue.serverTimestamp() : null,
            emailStatus: mail.sent ? "sent" : `not-sent:${mail.reason}`,
          });

          res.status(200).json({
            ok: true,
            receiptNo: issued.receiptNo,
            emailSent: mail.sent,
            emailReason: mail.reason || null,
            receiptHtml: issued.receiptHtml,
            amount: issued.amount,
            months: docs.length,
            periodLabel: spanLabel,
          });
          return;
        }

        // -------- resident: my own verified receipts -----------------------
        // Resident-level auth (own house + own PIN, no committee requirement).
        // Lets a logged-in resident pull their house's receipts even if they
        // never received / can't find the emailed copy.
        if (action === "myReceipts") {
          const houseKey = normalizeHouseNo(body.houseNo);
          const pin = String(body.pin || "");
          await verifyResidentPinInternal(houseKey, pin);
          logFeatureUsage("myreceipt", houseKey);
          const houseNo = ppHouseNum(houseKey);
          if (!houseNo) {
            throw Object.assign(new Error("บ้านเลขที่ไม่ถูกต้อง"), {status: 400});
          }
          // Single-field query (auto-indexed); status filtered in memory so no
          // composite index is needed. A house has only a handful of records.
          const snap = await db.collection(PP_COLLECTION)
              .where("houseNo", "==", houseNo).get();
          const receipts = snap.docs
              .map((doc) => ({doc, d: doc.data() || {}}))
              // A multi-month transfer has one receipt held by its first
              // row; the other months point at it and must not list again.
              .filter(({d}) => d.status === "verified" && d.receiptNo &&
                !d.receiptRef)
              .map(({doc, d}) => ({
                id: doc.id,
                receiptNo: d.receiptNo || "",
                feeType: d.feeType || "common",
                period: d.period || "",
                // A grouped receipt covers several months and its own total,
                // not just the month the owning row happens to sit on.
                periods: Array.isArray(d.receiptPeriods) ? d.receiptPeriods : null,
                year: d.year || null,
                amount: Number(
                    Number.isFinite(d.receiptAmount) ? d.receiptAmount : d.amount || 0,
                ),
                payerName: d.payerName || "",
                bank: d.bank || "",
                verifiedAt: d.verifiedAt && d.verifiedAt.toMillis ?
                  d.verifiedAt.toMillis() : null,
                emailed: !!d.receiptSentAt,
                nameEditedAt: d.nameEditedAt && d.nameEditedAt.toMillis ?
                  d.nameEditedAt.toMillis() : null,
              }))
              .sort((a, b) => (b.verifiedAt || 0) - (a.verifiedAt || 0));
          // The address a receipt goes to by default, so the page can show it
          // instead of asking the resident to type what we already know.
          let defaultEmail = "";
          try {
            const resident = await findPaymentResident(
                db.collection(RESIDENTS_COLLECTION), houseNo,
            );
            defaultEmail = (resident && resident.email) || "";
          } catch (e) {
            logger.warn("resident email resolve failed", e);
          }
          if (!defaultEmail) {
            const withEmail = snap.docs
                .map((doc) => doc.data() || {})
                .find((d) => d.houseNo === houseNo && d.email);
            defaultEmail = (withEmail && withEmail.email) || "";
          }
          res.status(200).json({ok: true, houseNo, receipts, defaultEmail});
          return;
        }

        // -------- resident: send a note with no slip attached --------------
        // The status page can be wrong (a back-log slip not imported yet, a
        // transfer sent over LINE). This lets the resident say so.
        if (action === "submitParkingMessage") {
          const houseKey = normalizeHouseNo(body.houseNo);
          const pin = String(body.pin || "");
          await verifyResidentPinInternal(houseKey, pin);
          const houseNo = ppHouseNum(houseKey);
          if (!houseNo) {
            throw Object.assign(new Error("บ้านเลขที่ไม่ถูกต้อง"), {status: 400});
          }
          const message = ppCleanImportText(body.message, 1000);
          if (!message) {
            throw Object.assign(new Error("กรุณาพิมพ์ข้อความ"), {status: 400});
          }
          const ref = await db.collection(PP_MESSAGES_COLLECTION).add({
            houseNo,
            message,
            feeType: "parking",
            status: "open",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          res.status(200).json({ok: true, id: ref.id});
          return;
        }

        // -------- admin: counts for the homepage badges --------------------
        // Counts only — no slip, name or amount leaves this action, so the
        // landing page never holds payment data it does not need.
        if (action === "adminPayCounts" || action === "adminParkingCounts") {
          await verifyAdminResidentAccess(body);
          const [pendingSnap, msgSnap] = await Promise.all([
            db.collection(PP_COLLECTION).where("status", "==", "pending").get(),
            db.collection(PP_MESSAGES_COLLECTION)
                .where("status", "==", "open").get(),
          ]);
          // One transfer covering several months is several rows but one
          // slip to review, so the badge counts slips.
          const parkingSlips = new Set();
          const commonSlips = new Set();
          pendingSnap.docs.forEach((doc) => {
            const d = doc.data() || {};
            const key = d.groupId || doc.id;
            if (d.feeType === "parking") parkingSlips.add(key);
            else if (d.feeType === "common") commonSlips.add(key);
          });
          const messages = msgSnap.size;
          res.status(200).json({
            ok: true,
            parking: {
              slips: parkingSlips.size,
              messages,
              total: parkingSlips.size + messages,
            },
            common: {slips: commonSlips.size, total: commonSlips.size},
            // Kept for the first version of the parking badge.
            slips: parkingSlips.size,
            messages,
            total: parkingSlips.size + messages,
          });
          return;
        }

        // -------- admin: the resident message inbox ------------------------
        if (action === "adminListParkingMessages") {
          await verifyAdminResidentAccess(body);
          const snap = await db.collection(PP_MESSAGES_COLLECTION)
              .orderBy("createdAt", "desc").limit(200).get();
          res.status(200).json({
            ok: true,
            messages: snap.docs.map((doc) => {
              const d = doc.data() || {};
              return {
                id: doc.id,
                houseNo: ppHouseNum(d.houseNo) || 0,
                message: d.message || "",
                status: d.status === "done" ? "done" : "open",
                createdAt: d.createdAt && d.createdAt.toMillis ?
                  d.createdAt.toMillis() : null,
                resolvedAt: d.resolvedAt && d.resolvedAt.toMillis ?
                  d.resolvedAt.toMillis() : null,
              };
            }),
          });
          return;
        }

        // -------- admin: mark one message handled (or reopen it) -----------
        if (action === "adminResolveParkingMessage") {
          await verifyAdminResidentAccess(body);
          const id = String(body.id || "");
          if (!id) {
            throw Object.assign(new Error("ไม่ระบุข้อความ"), {status: 400});
          }
          const done = body.done !== false;
          await db.collection(PP_MESSAGES_COLLECTION).doc(id).update({
            status: done ? "done" : "open",
            resolvedAt: done ?
              admin.firestore.FieldValue.serverTimestamp() : null,
          });
          res.status(200).json({ok: true});
          return;
        }

        // -------- resident: one receipt's printable HTML -------------------
        if (action === "myReceiptDoc") {
          const houseKey = normalizeHouseNo(body.houseNo);
          const pin = String(body.pin || "");
          await verifyResidentPinInternal(houseKey, pin);
          const houseNo = ppHouseNum(houseKey);
          const id = String(body.id || "");
          if (!id) {
            throw Object.assign(new Error("ไม่ระบุใบเสร็จ"), {status: 400});
          }
          const doc = await db.collection(PP_COLLECTION).doc(id).get();
          if (!doc.exists) {
            throw Object.assign(new Error("ไม่พบใบเสร็จ"), {status: 404});
          }
          const d = doc.data() || {};
          // Guard against pulling another house's receipt by id.
          if (ppHouseNum(d.houseNo) !== houseNo || d.status !== "verified") {
            throw Object.assign(new Error("Unauthorized"), {status: 403});
          }
          let html = d.receiptHtml;
          if (!html) {
            // Older records issued before receiptHtml was stored — regenerate
            // from the same template used for the emailed copy.
            html = ppReceiptHtml({
              houseNo: d.houseNo,
              feeType: d.feeType,
              period: d.period,
              year: d.year,
              amount: d.amount,
              payerName: d.payerName || "",
              email: d.email || "",
              receiptNo: d.receiptNo || "",
              verifiedAt: d.verifiedAt && d.verifiedAt.toMillis ?
                d.verifiedAt.toMillis() : Date.now(),
            });
          }
          res.status(200).json({
            ok: true,
            receiptNo: d.receiptNo || "",
            receiptHtml: html,
          });
          return;
        }

        // -------- resident: correct the name a receipt is issued in --------
        // Residents file these for expense claims, so the name has to be
        // fixable without a committee round-trip. The receipt NUMBER, amount,
        // period and date never change, and every edit is logged.
        if (action === "myReceiptRename") {
          const houseKey = normalizeHouseNo(body.houseNo);
          const pin = String(body.pin || "");
          await verifyResidentPinInternal(houseKey, pin);
          const houseNo = ppHouseNum(houseKey);
          const id = String(body.id || "");
          if (!id) {
            throw Object.assign(new Error("ไม่ระบุใบเสร็จ"), {status: 400});
          }
          const name = ppCleanImportText(body.name, 120).replace(/[<>]/g, "");
          if (!name) {
            throw Object.assign(new Error("กรุณากรอกชื่อ"), {status: 400});
          }
          const ref = db.collection(PP_COLLECTION).doc(id);
          const doc = await ref.get();
          if (!doc.exists) {
            throw Object.assign(new Error("ไม่พบใบเสร็จ"), {status: 404});
          }
          const d = doc.data() || {};
          if (ppHouseNum(d.houseNo) !== houseNo || d.status !== "verified") {
            throw Object.assign(new Error("Unauthorized"), {status: 403});
          }
          const before = d.payerName || "";
          if (before === name) {
            res.status(200).json({ok: true, payerName: name, unchanged: true});
            return;
          }

          // Re-render the stored document with the new name, keeping every
          // other field exactly as it was issued.
          const html = ppReceiptHtml({
            houseNo: d.houseNo,
            feeType: d.feeType,
            period: d.period,
            periods: Array.isArray(d.receiptPeriods) ? d.receiptPeriods : null,
            year: d.year,
            amount: Number.isFinite(d.receiptAmount) ?
              d.receiptAmount : d.amount,
            payerName: name,
            email: d.email || "",
            receiptNo: d.receiptNo || "",
            verifiedAt: d.verifiedAt && d.verifiedAt.toMillis ?
              d.verifiedAt.toMillis() : Date.now(),
          });
          await db.collection(PP_RECEIPT_LOG_COLLECTION).add({
            paymentId: id,
            receiptNo: d.receiptNo || "",
            houseNo,
            // So each committee page can show only its own fee type.
            feeType: d.feeType || "",
            field: "payerName",
            from: before,
            to: name,
            by: "resident",
            byHouseNo: houseNo,
            at: admin.firestore.FieldValue.serverTimestamp(),
          });
          await ref.update({
            payerName: name,
            receiptHtml: html,
            nameEditedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          res.status(200).json({ok: true, payerName: name});
          return;
        }

        // -------- admin: the receipt edit trail ----------------------------
        if (action === "adminListReceiptLog") {
          await verifyAdminResidentAccess(body);
          const snap = await db.collection(PP_RECEIPT_LOG_COLLECTION)
              .orderBy("at", "desc").limit(300).get();
          res.status(200).json({
            ok: true,
            entries: snap.docs.map((doc) => {
              const d = doc.data() || {};
              return {
                id: doc.id,
                paymentId: d.paymentId || "",
                receiptNo: d.receiptNo || "",
                houseNo: ppHouseNum(d.houseNo) || 0,
                feeType: d.feeType || "",
                field: d.field || "",
                from: d.from || "",
                to: d.to || "",
                by: d.by || "",
                at: d.at && d.at.toMillis ? d.at.toMillis() : null,
              };
            }),
          });
          return;
        }

        // -------- resident: email one receipt to themselves ----------------
        // Defaults to the address on file for the house; an override is
        // accepted for the case where the receipt has to go somewhere else
        // (an accountant, a landlord, a second address).
        if (action === "myReceiptEmail") {
          const houseKey = normalizeHouseNo(body.houseNo);
          const pin = String(body.pin || "");
          await verifyResidentPinInternal(houseKey, pin);
          const houseNo = ppHouseNum(houseKey);
          const id = String(body.id || "");
          if (!id) {
            throw Object.assign(new Error("ไม่ระบุใบเสร็จ"), {status: 400});
          }
          const ref = db.collection(PP_COLLECTION).doc(id);
          const doc = await ref.get();
          if (!doc.exists) {
            throw Object.assign(new Error("ไม่พบใบเสร็จ"), {status: 404});
          }
          const d = doc.data() || {};
          if (ppHouseNum(d.houseNo) !== houseNo || d.status !== "verified") {
            throw Object.assign(new Error("Unauthorized"), {status: 403});
          }

          const override = String(body.email || "").trim();
          let to = override || d.email || "";
          if (!override && !to) {
            try {
              const resident = await findPaymentResident(
                  db.collection(RESIDENTS_COLLECTION), d.houseNo,
              );
              to = (resident && resident.email) || "";
            } catch (e) {
              logger.warn("resident email resolve failed", e);
            }
          }
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
            throw Object.assign(
                new Error(override ?
                  "อีเมลไม่ถูกต้อง" :
                  "บ้านนี้ยังไม่มีอีเมลในระบบ กรุณาระบุอีเมลปลายทาง"),
                {status: 400},
            );
          }

          const html = d.receiptHtml || ppReceiptHtml({
            houseNo: d.houseNo,
            feeType: d.feeType,
            period: d.period,
            year: d.year,
            amount: d.amount,
            payerName: d.payerName || "",
            email: d.email || "",
            receiptNo: d.receiptNo || "",
            verifiedAt: d.verifiedAt && d.verifiedAt.toMillis ?
              d.verifiedAt.toMillis() : Date.now(),
          });
          const mail = await ppSendEmail(
              to,
              "Pattra Villa 8: ใบเสร็จรับเงิน " +
                `${d.feeType === "common" ? "ค่าส่วนกลาง" : "ค่าจอดรถ"} ` +
                `บ้านเลขที่ ${PP_BLOCK}/${d.houseNo} ${ppPeriodLabel(d)}`,
              html,
          );
          if (!mail.sent) {
            throw Object.assign(
                new Error("ส่งอีเมลไม่สำเร็จ กรุณาลองใหม่"), {status: 502});
          }
          const patch = {
            lastEmailedAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          // The list shows "ส่งอีเมลแล้ว" off receiptSentAt; a receipt issued
          // before the house had an address should start showing it now.
          if (!d.receiptSentAt) {
            patch.receiptSentAt = admin.firestore.FieldValue.serverTimestamp();
          }
          await ref.update(patch);
          res.status(200).json({ok: true, to});
          return;
        }

        // -------- admin: installment plans ---------------------------------
        if (action === "adminListPlans") {
          await verifyAdminResidentAccess(body);
          const snap = await db.collection(PP_PLANS_COLLECTION).get();
          const plans = snap.docs.map(ppMapPlan)
              .map((plan) => Object.assign({}, plan, planProgress(plan)))
              .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          res.status(200).json({ok: true, plans});
          return;
        }

        if (action === "adminCreatePlan") {
          const access = await verifyAdminResidentAccess(body);
          const houseNo = ppHouseNum(body.houseNo);
          if (!houseNo) {
            throw Object.assign(new Error("บ้านเลขที่ไม่ถูกต้อง"), {status: 400});
          }
          const period = normalizeCommonPeriod(
              body.period, PP_PUBLIC_COMMON_PERIOD);
          const year = Number.isFinite(parseInt(body.year, 10)) ?
            parseInt(body.year, 10) : PP_PUBLIC_COMMON_YEAR;
          const input = validatePlanInput({
            totalAmount: body.totalAmount == null ?
              PP_COMMON_BASE : body.totalAmount,
          });
          const planRef = db.collection(PP_PLANS_COLLECTION)
              .doc(ppPlanId(houseNo, "common", period, year));
          const existing = await planRef.get();
          if (existing.exists) {
            throw Object.assign(
                new Error(`บ้าน ${PP_BLOCK}/${houseNo} เคยมีแผนผ่อนงวดนี้แล้ว`),
                {status: 409});
          }
          const paidSnap = await db.collection(PP_COLLECTION)
              .where("houseNo", "==", houseNo).get();
          const settled = paidSnap.docs.some((doc) => {
            const data = doc.data() || {};
            return data.feeType === "common" && data.period === period &&
              Number(data.year) === Number(year) &&
              data.status === "verified" && !data.planId;
          });
          if (settled) {
            throw Object.assign(
                new Error(`บ้าน ${PP_BLOCK}/${houseNo} ชำระงวดนี้ครบแล้ว`),
                {status: 409});
          }
          const plan = {
            houseNo,
            feeType: "common",
            period,
            year,
            totalAmount: input.totalAmount,
            paidAmount: 0,
            appliedPaymentIds: [],
            status: "active",
            note: ppCleanImportText(body.note, 500),
            createdBy: normalizeHouseNo(body.adminHouseNo || ""),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          await planRef.set(plan);
          logger.info("pattraPay installment plan created", {
            planId: planRef.id,
            houseNo,
            period,
            year,
            totalAmount: input.totalAmount,
            by: access && access.houseNo || "",
          });
          res.status(200).json({
            ok: true,
            plan: Object.assign({id: planRef.id}, plan, {createdAt: Date.now()}),
          });
          return;
        }

        if (action === "adminRecordPlanPayment") {
          await verifyAdminResidentAccess(body);
          const planId = String(body.planId || "");
          if (!planId) {
            throw Object.assign(new Error("ไม่ระบุแผน"), {status: 400});
          }
          const amount = Math.round(Number(body.amount) * 100) / 100;
          if (!Number.isFinite(amount) || amount <= 0) {
            throw Object.assign(new Error("ยอดเงินไม่ถูกต้อง"), {status: 400});
          }
          const planSnap = await db.collection(PP_PLANS_COLLECTION)
              .doc(planId).get();
          if (!planSnap.exists) {
            throw Object.assign(new Error("ไม่พบแผนผ่อน"), {status: 404});
          }
          const plan = ppMapPlan(planSnap);
          if (!isPlanActive(plan)) {
            throw Object.assign(new Error("แผนนี้ไม่ได้ใช้งานอยู่"), {status: 400});
          }
          const pendingSnap = await db.collection(PP_COLLECTION)
              .where("houseNo", "==", plan.houseNo).get();
          const hasPending = pendingSnap.docs.some((doc) => {
            const payment = doc.data() || {};
            return payment.planId === planId && payment.status === "pending";
          });
          if (hasPending) {
            throw Object.assign(
                new Error("แผนนี้มีรายการรอตรวจอยู่แล้ว"), {status: 409});
          }
          const ref = db.collection(PP_COLLECTION).doc();
          await ref.set({
            houseNo: plan.houseNo,
            feeType: "common",
            period: plan.period,
            year: plan.year,
            amount,
            payerName: ppCleanImportText(body.payerName, 160),
            email: "",
            slipUrl: "",
            status: "pending",
            source: "bank_statement",
            bank: ppCleanImportText(body.bank, 80),
            transactionRef: ppCleanImportText(body.transactionRef, 120),
            paidAt: ppTimestampFromMillis(body.paidAt),
            reviewNote: ppCleanImportText(body.note, 500) ||
              "บันทึกจาก statement — ลูกบ้านไม่ได้ส่งสลิป",
            planId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          res.status(200).json({ok: true, id: ref.id, amount});
          return;
        }

        if (action === "adminClosePlan") {
          await verifyAdminResidentAccess(body);
          const planId = String(body.planId || "");
          if (!planId) {
            throw Object.assign(new Error("ไม่ระบุแผน"), {status: 400});
          }
          const planRef = db.collection(PP_PLANS_COLLECTION).doc(planId);
          const snap = await planRef.get();
          if (!snap.exists) {
            throw Object.assign(new Error("ไม่พบแผนผ่อน"), {status: 404});
          }
          await planRef.update({
            status: "closed",
            closeReason: ppCleanImportText(body.reason, 500),
            closedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          res.status(200).json({ok: true, planId});
          return;
        }

        // -------- admin: reject --------------------------------------------
        if (action === "adminReject") {
          await verifyAdminResidentAccess(body);
          const id = String(body.id || "");
          if (!id) throw Object.assign(new Error("ไม่ระบุรายการ"), {status: 400});
          await db.collection(PP_COLLECTION).doc(id).update({
            status: "rejected",
            note: String(body.note || "ยอด/สลิปไม่ถูกต้อง"),
            verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          res.status(200).json({ok: true});
          return;
        }

        res.status(400).json({ok: false, error: "Invalid action"});
      } catch (err) {
        logger.error("pattraPay failed", err);
        res.status(err.status || 500).json({ok: false, error: err.message});
      }
    });


// ===========================================================================
// ESTATE ISSUES — pattra8.com/report/
// Login-gated issue / suggestion / feedback channel. See
// functions/domains/issues/README.md for the data model and the two
// invariants (anonymity, LINE containment) this code has to protect.
// ===========================================================================

const ESTATE_ISSUE_STORAGE_PREFIX = "estate-issues";
const ESTATE_ISSUE_ADMIN_PERMISSION = "admin.issues";
const ESTATE_ISSUE_LIST_LIMIT = 300;
const ESTATE_ISSUE_MEDIA_RETENTION_DAYS = 365;

/**
 * Allocates the next per-year ticket number.
 * @param {number} buddhistYear Buddhist-era year.
 * @return {Promise<string>} Ticket code such as "PT-2569-0007".
 */
async function allocateIssueCode(buddhistYear) {
  const ref = db
      .collection(ESTATE_ISSUE_COUNTERS_COLLECTION)
      .doc(String(buddhistYear));
  const sequence = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const next = Number((snap.exists ? snap.data().seq : 0) || 0) + 1;
    tx.set(ref, {seq: next, year: buddhistYear}, {merge: true});
    return next;
  });
  return formatIssueCode(buddhistYear, sequence);
}

/**
 * Loads every issue filed by one house, newest first.
 *
 * Sorting happens in memory on purpose: an equality filter plus an ordered
 * range would need a composite index, and one house never has more than a
 * handful of reports.
 *
 * @param {string} houseNo Normalized house number.
 * @return {Promise<Array<{id: string, data: Object}>>}
 */
async function loadIssuesForHouse(houseNo) {
  const snap = await db
      .collection(ESTATE_ISSUES_COLLECTION)
      .where("houseNo", "==", houseNo)
      .limit(ESTATE_ISSUE_LIST_LIMIT)
      .get();
  return snap.docs
      .map((doc) => ({id: doc.id, data: doc.data() || {}}))
      .sort((a, b) =>
        Number(b.data.createdAtEpoch || 0) - Number(a.data.createdAtEpoch || 0),
      );
}

/**
 * Loads an issue and confirms the caller filed it.
 * @param {string} issueId Firestore document id.
 * @param {string} houseNo Normalized house number of the caller.
 * @return {Promise<{ref: *, data: Object}>}
 */
async function loadOwnedIssue(issueId, houseNo) {
  const id = String(issueId || "").trim();
  if (!id) throw issueError("ไม่พบเรื่องที่ระบุ", 400);
  const ref = db.collection(ESTATE_ISSUES_COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw issueError("ไม่พบเรื่องที่ระบุ", 404);
  const data = snap.data() || {};
  if (String(data.houseNo || "") !== houseNo) {
    throw issueError("ไม่มีสิทธิ์เข้าถึงเรื่องนี้", 403);
  }
  return {ref, data};
}

/**
 * Loads an issue for committee handling.
 * @param {string} issueId Firestore document id.
 * @return {Promise<{ref: *, data: Object}>}
 */
async function loadIssueForAdmin(issueId) {
  const id = String(issueId || "").trim();
  if (!id) throw issueError("ไม่พบเรื่องที่ระบุ", 400);
  const ref = db.collection(ESTATE_ISSUES_COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw issueError("ไม่พบเรื่องที่ระบุ", 404);
  return {ref, data: snap.data() || {}};
}

/**
 * Stores one attachment in Storage and returns its stored descriptor.
 *
 * Objects stay private and are read through a download token, because the
 * gen2 runtime service account cannot sign URLs.
 *
 * @param {string} issueId Firestore document id.
 * @param {Object} upload Parsed upload from parseIssueUpload().
 * @return {Promise<Object>}
 */
async function storeIssueAttachment(issueId, upload) {
  const bucket = admin.storage().bucket();
  const token = crypto.randomUUID();
  const objectPath = `${ESTATE_ISSUE_STORAGE_PREFIX}/${issueId}/` +
    `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${upload.extension}`;

  await bucket.file(objectPath).save(upload.buffer, {
    resumable: false,
    contentType: upload.contentType,
    metadata: {
      contentType: upload.contentType,
      metadata: {firebaseStorageDownloadTokens: token},
    },
  });

  return {
    kind: upload.kind,
    contentType: upload.contentType,
    bytes: upload.bytes,
    storagePath: objectPath,
    url: "https://firebasestorage.googleapis.com/v0/b/" +
      `${bucket.name}/o/${encodeURIComponent(objectPath)}?alt=media&` +
      `token=${token}`,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Announces a new report in the Pattra Watch sandbox group.
 *
 * The target is hardcoded on purpose. Routing it through
 * resolveLineFlexTargetId() would let the stored `pattraReport` route send an
 * estate complaint into a residents or security group, which would defeat the
 * anonymity promise made on the form. Failures are swallowed: a chat notice is
 * never worth failing a resident's submission.
 *
 * @param {Object} issue Stored issue document.
 * @return {Promise<void>}
 */
async function announceIssueToWatchGroup(issue) {
  try {
    const bangkokTime = new Date().toLocaleString("th-TH-u-ca-gregory", {
      timeZone: "Asia/Bangkok",
      dateStyle: "medium",
      timeStyle: "short",
    });
    const message = buildIssueWatchNotice(issue, bangkokTime);
    await sendLinePushMessages(LINE_FLEX_SANDBOX_TARGET_ID, [message]);
  } catch (err) {
    logger.warn("estateIssues watch notice failed", err);
  }
}

/**
 * Moves one legacy issue's inline base64 media into Storage.
 *
 * The retired board stored whole photos as data URLs inside the Firestore
 * document, which is why a handful of tickets accounted for most of the
 * database. The archive keeps the picture but not the encoding mistake.
 *
 * @param {string} archiveId Archive document id.
 * @param {Array<Object>} media Legacy media entries.
 * @return {Promise<Array<Object>>} Stored attachment descriptors.
 */
async function migrateLegacyIssueMedia(archiveId, media) {
  const list = Array.isArray(media) ? media : [];
  const stored = [];
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index] || {};
    try {
      const upload = parseIssueUpload(entry.dataUrl);
      stored.push(await storeIssueAttachment(`archive/${archiveId}`, upload));
    } catch (err) {
      logger.warn("archiveLegacy media skipped", {
        archiveId,
        index,
        error: err.message,
      });
    }
  }
  return stored;
}

exports.estateIssues = onRequest(
    {secrets: [LINE_CHANNEL_ACCESS_TOKEN]},
    async (req, res) => {
      if (!prepareJsonRequest(req, res)) return;

      const body = req.body || {};
      const action = String(body.action || "").trim();

      try {
        // ── Resident actions ────────────────────────────────────────────
        if (action === "submit") {
          const houseNo = normalizeHouseNo(body.houseNo);
          await verifyResidentPinInternal(houseNo, body.pin);
          const submission = buildIssueSubmission(body);
          const existing = await loadIssuesForHouse(houseNo);
          const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
          const recent = existing.filter((item) =>
            Number(item.data.createdAtEpoch || 0) >= dayAgo,
          ).length;
          if (isIssueRateLimited(recent)) {
            throw issueError(
                "วันนี้แจ้งครบจำนวนสูงสุดแล้ว กรุณาลองใหม่พรุ่งนี้",
                429,
            );
          }

          const now = new Date();
          const code = await allocateIssueCode(issueBuddhistYear(now));
          const doc = {
            code,
            houseNo,
            anonymous: submission.anonymous,
            title: submission.title,
            detail: submission.detail,
            category: submission.category,
            priority: submission.priority,
            contact: normalizeIssueText(body.contact, 120),
            status: "new",
            attachments: [],
            replies: [],
            internalNotes: [],
            residentSeenAtEpoch: now.getTime(),
            createdAtEpoch: now.getTime(),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          const ref = await db
              .collection(ESTATE_ISSUES_COLLECTION)
              .add(doc);

          writeAuditLog("estate_issue_submit", houseNo, {
            code,
            anonymous: submission.anonymous,
            category: submission.category,
          });
          await announceIssueToWatchGroup(doc);

          res.status(200).json({ok: true, id: ref.id, code});
          return;
        }

        if (action === "attach") {
          const houseNo = normalizeHouseNo(body.houseNo);
          await verifyResidentPinInternal(houseNo, body.pin);
          const {ref, data} = await loadOwnedIssue(body.issueId, houseNo);
          if (!isResidentIssueEditable(data.status)) {
            throw issueError("เรื่องนี้สิ้นสุดแล้ว ไม่สามารถแก้ไขได้", 409);
          }
          const upload = parseIssueUpload(body.dataUrl);
          assertAttachmentSlotAvailable(data.attachments, upload.kind);
          const attachment = await storeIssueAttachment(ref.id, upload);
          await ref.update({
            attachments: admin.firestore.FieldValue.arrayUnion(attachment),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          res.status(200).json({ok: true, attachment});
          return;
        }

        if (action === "updateIssue") {
          const houseNo = normalizeHouseNo(body.houseNo);
          await verifyResidentPinInternal(houseNo, body.pin);
          const {ref, data} = await loadOwnedIssue(body.issueId, houseNo);
          if (!isResidentIssueEditable(data.status)) {
            throw issueError("เรื่องนี้สิ้นสุดแล้ว ไม่สามารถแก้ไขได้", 409);
          }
          const submission = buildIssueSubmission({
            title: body.title,
            detail: body.detail,
            category: body.category,
          });
          await ref.update({
            title: submission.title,
            detail: submission.detail,
            category: submission.category,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          writeAuditLog("estate_issue_resident_update", houseNo, {
            issueId: ref.id,
            category: submission.category,
          });
          res.status(200).json({ok: true});
          return;
        }

        if (action === "removeAttachment") {
          const houseNo = normalizeHouseNo(body.houseNo);
          await verifyResidentPinInternal(houseNo, body.pin);
          const {ref, data} = await loadOwnedIssue(body.issueId, houseNo);
          if (!isResidentIssueEditable(data.status)) {
            throw issueError("เรื่องนี้สิ้นสุดแล้ว ไม่สามารถแก้ไขได้", 409);
          }
          const storagePath = String(body.storagePath || "").trim();
          const attachments = Array.isArray(data.attachments) ?
            data.attachments : [];
          const attachment = attachments.find((item) =>
            item && String(item.storagePath || "") === storagePath,
          );
          if (!attachment) throw issueError("ไม่พบไฟล์แนบที่ระบุ", 404);
          const expectedPrefix = `${ESTATE_ISSUE_STORAGE_PREFIX}/${ref.id}/`;
          if (!storagePath.startsWith(expectedPrefix)) {
            throw issueError("ไม่สามารถลบไฟล์นี้ได้", 403);
          }
          await admin.storage().bucket().file(storagePath).delete()
              .catch((err) => {
                if (Number(err.code) !== 404) throw err;
              });
          await ref.update({
            attachments: attachments.filter((item) =>
              String((item && item.storagePath) || "") !== storagePath,
            ),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          writeAuditLog("estate_issue_attachment_remove", houseNo, {
            issueId: ref.id,
            storagePath,
          });
          res.status(200).json({ok: true});
          return;
        }

        if (action === "myIssues") {
          const houseNo = normalizeHouseNo(body.houseNo);
          await verifyResidentPinInternal(houseNo, body.pin);
          logFeatureUsage("report", houseNo);
          const issues = await loadIssuesForHouse(houseNo);
          res.status(200).json({
            ok: true,
            issues: issues.map((item) =>
              toResidentIssueView(item.id, item.data),
            ),
          });
          return;
        }

        if (action === "addComment") {
          const houseNo = normalizeHouseNo(body.houseNo);
          await verifyResidentPinInternal(houseNo, body.pin);
          const {ref, data} = await loadOwnedIssue(body.issueId, houseNo);
          const message = normalizeIssueText(body.message, ISSUE_COMMENT_MAX);
          if (!message) throw issueError("กรุณาพิมพ์ข้อความ", 400);
          const now = Date.now();
          const commentUpdate = {
            replies: admin.firestore.FieldValue.arrayUnion({
              id: crypto.randomUUID(),
              author: "resident",
              message,
              createdAt: new Date(now).toISOString(),
              createdAtEpoch: now,
            }),
            residentSeenAtEpoch: now,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          if (data.status === "resolved" || data.status === "closed") {
            commentUpdate.status = "in_progress";
            commentUpdate.resolvedAt = null;
          }
          await ref.update(commentUpdate);
          res.status(200).json({ok: true});
          return;
        }

        if (action === "markSeen") {
          const houseNo = normalizeHouseNo(body.houseNo);
          await verifyResidentPinInternal(houseNo, body.pin);
          const {ref} = await loadOwnedIssue(body.issueId, houseNo);
          await ref.update({residentSeenAtEpoch: Date.now()});
          res.status(200).json({ok: true});
          return;
        }

        // ── Committee actions ───────────────────────────────────────────
        if (action === "adminList") {
          await verifyAdminResidentAccess(body, ESTATE_ISSUE_ADMIN_PERMISSION);
          const snap = await db
              .collection(ESTATE_ISSUES_COLLECTION)
              .orderBy("createdAtEpoch", "desc")
              .limit(ESTATE_ISSUE_LIST_LIMIT)
              .get();
          const all = snap.docs.map((doc) =>
            redactIssueForAdmin(doc.id, doc.data() || {}),
          );
          const status = String(body.status || "").trim();
          const category = String(body.category || "").trim();
          const search = String(body.search || "").trim().toLowerCase();
          const issues = all.filter((issue) => {
            if (status && issue.status !== status) return false;
            if (category && issue.category !== category) return false;
            if (search) {
              const haystack = `${issue.code} ${issue.title} ${issue.detail}`
                  .toLowerCase();
              if (!haystack.includes(search)) return false;
            }
            return true;
          });
          res.status(200).json({
            ok: true,
            issues,
            stats: summarizeIssueStatuses(all),
          });
          return;
        }

        // Counts only — the landing page shows an open-ticket badge and has
        // no business pulling resident free text across the wire for it.
        if (action === "adminStats") {
          await verifyAdminResidentAccess(body, ESTATE_ISSUE_ADMIN_PERMISSION);
          const collection = db.collection(ESTATE_ISSUES_COLLECTION);
          const [fresh, working] = await Promise.all([
            collection.where("status", "==", "new").count().get(),
            collection.where("status", "==", "in_progress").count().get(),
          ]);
          const newCount = fresh.data().count || 0;
          const inProgress = working.data().count || 0;
          res.status(200).json({
            ok: true,
            stats: {
              "new": newCount,
              "in_progress": inProgress,
              "open": newCount + inProgress,
            },
          });
          return;
        }

        if (action === "adminDetail") {
          await verifyAdminResidentAccess(body, ESTATE_ISSUE_ADMIN_PERMISSION);
          const {ref, data} = await loadIssueForAdmin(body.issueId);
          res.status(200).json({
            ok: true,
            issue: redactIssueForAdmin(ref.id, data),
          });
          return;
        }

        if (action === "adminReply") {
          const access = await verifyAdminResidentAccess(
              body,
              ESTATE_ISSUE_ADMIN_PERMISSION,
          );
          const {ref, data} = await loadIssueForAdmin(body.issueId);
          const message = normalizeIssueText(body.message, ISSUE_COMMENT_MAX);
          if (!message) throw issueError("กรุณาพิมพ์ข้อความตอบกลับ", 400);
          const now = Date.now();
          const replyUpdate = {
            replies: admin.firestore.FieldValue.arrayUnion({
              id: crypto.randomUUID(),
              author: "admin",
              message,
              createdAt: new Date(now).toISOString(),
              createdAtEpoch: now,
            }),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          if (issueQueueState(data) === "needs_action") {
            replyUpdate.status = "in_progress";
          }
          await ref.update(replyUpdate);
          writeAuditLog("estate_issue_reply", access.houseNo || "", {
            issueId: ref.id,
          });
          res.status(200).json({ok: true});
          return;
        }

        if (action === "adminUpdate") {
          const access = await verifyAdminResidentAccess(
              body,
              ESTATE_ISSUE_ADMIN_PERMISSION,
          );
          const {ref, data} = await loadIssueForAdmin(body.issueId);
          const update = {
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          if (body.status !== undefined) {
            const status = normalizeIssueStatus(body.status);
            update.status = status;
            const closing = status === "resolved" || status === "closed";
            if (closing && !data.resolvedAt) {
              update.resolvedAt = new Date().toISOString();
            }
            if (!closing) update.resolvedAt = null;
          }
          if (body.priority !== undefined) {
            update.priority = normalizeIssuePriority(body.priority);
          }
          await ref.update(update);
          writeAuditLog("estate_issue_update", access.houseNo || "", {
            issueId: ref.id,
            status: update.status || "",
            priority: update.priority || "",
          });
          res.status(200).json({ok: true});
          return;
        }

        // Removing a report is the one committee action that cannot be
        // undone, so it takes the whole record with it: the document and every
        // stored attachment. The audit log keeps ticket code and title as the
        // trail; the reporter's house number is deliberately not written there,
        // because an anonymous report stays anonymous even in the log.
        if (action === "adminDelete") {
          const access = await verifyAdminResidentAccess(
              body,
              ESTATE_ISSUE_ADMIN_PERMISSION,
          );
          const {ref, data} = await loadIssueForAdmin(body.issueId);
          const attachments = Array.isArray(data.attachments) ?
            data.attachments :
            [];
          const bucket = admin.storage().bucket();
          let removed = 0;
          for (const attachment of attachments) {
            if (!attachment || !attachment.storagePath) continue;
            try {
              await bucket.file(attachment.storagePath).delete();
              removed += 1;
            } catch (err) {
              logger.warn("estateIssues attachment delete failed", {
                storagePath: attachment.storagePath,
                error: err.message,
              });
            }
          }
          await ref.delete();
          writeAuditLog("estate_issue_delete", access.houseNo || "", {
            issueId: ref.id,
            code: String(data.code || ""),
            title: String(data.title || ""),
            media: removed,
          });
          res.status(200).json({ok: true});
          return;
        }

        if (action === "adminNote") {
          const access = await verifyAdminResidentAccess(
              body,
              ESTATE_ISSUE_ADMIN_PERMISSION,
          );
          const {ref} = await loadIssueForAdmin(body.issueId);
          const message = normalizeIssueText(
              body.message,
              ISSUE_INTERNAL_NOTE_MAX,
          );
          if (!message) throw issueError("กรุณาพิมพ์บันทึกภายใน", 400);
          const now = Date.now();
          await ref.update({
            internalNotes: admin.firestore.FieldValue.arrayUnion({
              id: crypto.randomUUID(),
              message,
              authorHouseNo: access.houseNo || "",
              createdAt: new Date(now).toISOString(),
              createdAtEpoch: now,
            }),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          res.status(200).json({ok: true});
          return;
        }

        if (action === "adminArchiveList") {
          await verifyAdminResidentAccess(body, ESTATE_ISSUE_ADMIN_PERMISSION);
          const snap = await db
              .collection(ISSUES_ARCHIVE_COLLECTION)
              .limit(ESTATE_ISSUE_LIST_LIMIT)
              .get();
          const issues = snap.docs
              .map((doc) => {
                const data = doc.data() || {};
                return {
                  id: doc.id,
                  source: String(data.source || ""),
                  date: String(data.date || ""),
                  house: String(data.house || ""),
                  title: String(data.title || ""),
                  detail: String(data.desc || data.detail || ""),
                  category: String(data.cat || ""),
                  status: String(data.status || ""),
                  attachments: Array.isArray(data.attachments) ?
                    data.attachments :
                    [],
                  archivedAt: String(data.archivedAt || ""),
                };
              })
              .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
          res.status(200).json({ok: true, issues});
          return;
        }

        if (action === "archiveLegacy") {
          const access = await verifyAdminResidentAccess(body, "admin.audit");
          const deleteOriginals = body.deleteOriginals === true;
          const sources = ["issues", "private_issues"];
          const result = {archived: 0, media: 0, deleted: 0, sources: {}};

          for (const source of sources) {
            const snap = await db.collection(source).get();
            let archived = 0;
            let deleted = 0;
            for (const doc of snap.docs) {
              const data = doc.data() || {};
              const archiveId = `${source}_${doc.id}`;
              const attachments =
                await migrateLegacyIssueMedia(archiveId, data.media);
              const {media, ...rest} = data;
              await db.collection(ISSUES_ARCHIVE_COLLECTION)
                  .doc(archiveId)
                  .set({
                    ...rest,
                    source,
                    originalId: doc.id,
                    attachments,
                    archivedAt: new Date().toISOString(),
                  }, {merge: true});
              archived += 1;
              result.media += attachments.length;
              if (deleteOriginals) {
                await doc.ref.delete();
                deleted += 1;
              }
            }
            result.archived += archived;
            result.deleted += deleted;
            result.sources[source] = {archived, deleted};
          }

          writeAuditLog("estate_issue_archive_legacy", access.houseNo || "", {
            archived: result.archived,
            deleted: result.deleted,
            media: result.media,
          });
          res.status(200).json({ok: true, ...result});
          return;
        }

        res.status(400).json({ok: false, error: "Invalid action"});
      } catch (err) {
        if (!err.status || err.status >= 500) {
          logger.error("estateIssues failed", {action, error: err.message});
        }
        sendLegacyError(res, err);
      }
    },
);

exports.estateIssueCleanup = onSchedule(
    {
      schedule: "30 3 * * *",
      timeZone: "Asia/Bangkok",
      memory: "512MiB",
    },
    async () => {
      const cutoff = Date.now() -
        ESTATE_ISSUE_MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const snap = await db
          .collection(ESTATE_ISSUES_COLLECTION)
          .where("createdAtEpoch", "<", cutoff)
          .limit(200)
          .get();

      const bucket = admin.storage().bucket();
      let purged = 0;
      for (const doc of snap.docs) {
        const data = doc.data() || {};
        const attachments = Array.isArray(data.attachments) ?
          data.attachments :
          [];
        if (!attachments.length) continue;
        for (const attachment of attachments) {
          if (!attachment || !attachment.storagePath) continue;
          try {
            await bucket.file(attachment.storagePath).delete();
            purged += 1;
          } catch (err) {
            logger.warn("estateIssueCleanup delete failed", {
              storagePath: attachment.storagePath,
              error: err.message,
            });
          }
        }
        // The ticket text stays; only the media ages out.
        await doc.ref.update({
          attachments: [],
          attachmentsPurgedAt: new Date().toISOString(),
        });
      }

      logger.info("estateIssueCleanup finished", {
        scanned: snap.size,
        purged,
      });
    },
);

// ===========================================================================
// Visitor Intake helpers exported for unit tests (functions/test/).
// Recovery/session tests inject an in-memory store; no production I/O.
// ===========================================================================
module.exports.__visitorTest = {
  resolveLprPlate,
  lprSearchPlates,
  isReadableLprEvent,
  parseLprTrafficEvent,
  describeUnreadableReason,
  buildSecurityAuditFlexMessage,
  matchSecurityAuditPlates,
  formatBangkokDateLabel,
  formatWeeklyThaiDateRange,
  buildWeeklySafetyFlexMessage,
  getSecurityAuditRange,
  getTrafficDayRange,
  getOvernightRange,
  buildPattraWatchFlex,
  buildDailyTrafficReport,
  buildOvernightSecurityReport,
  buildDailyTrafficFlexMessage,
  buildOvernightSecurityFlexMessage,
  recoverVisitorIntakeOcr,
  resolveVisitorIntakeLogId,
  getCarQuota,
  mapVisitorPurposeCategory,
  visitorPurposeLabel,
  visitorReportPurposeLabel,
  parseVisitorIntakeText,
  buildVisitorWarnings,
  cleanVisitorPurposeText,
  normalizeVisitorPlate,
  normalizeVisitorVehicleType,
  normalizeDocumentNumber,
  getVisitorIntakeStatus,
  shouldAttemptVisitorOutageNotice,
  shouldStartNewVisitorLog,
  shouldStartNewVisitorImageLog,
  shouldReplyVisitorIntakeNow,
  buildVisitorIntakeReply,
  visitorIntakeImageUrl,
  getTargetIdFromSource,
  getLineWebhookEventId,
  isLineContentUnavailable,
  isLineReplyFailure,
  buildVisitorLineOutageNotice,
};
