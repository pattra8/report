const crypto = require("crypto");

const admin = require("firebase-admin");
const {GoogleAuth} = require("google-auth-library");
const sharp = require("sharp");
const {setGlobalOptions} = require("firebase-functions/v2");
const {
  onDocumentCreated,
  onDocumentUpdated,
} = require("firebase-functions/v2/firestore");
const {onRequest} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const {defineSecret} = require("firebase-functions/params");

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

const LINE_CONFIG_PATH = "system_config/line";
const LPR_MONITOR_CONFIG_PATH = "system_config/lpr_monitor";
const DAILY_TRAFFIC_CONFIG_PATH = "system_config/daily_traffic";
const SECURITY_SHIFT_CONFIG_PATH = "system_config/security_shift";
const GUARD_AUDIT_CONFIG_PATH = "system_config/guard_audit";
const LPR_AGENT_C_CONFIG_PATH = "system_config/lpr_agent_c";
const VISITOR_INTAKE_CONFIG_PATH = "system_config/visitor_intake";
const VISITOR_DAILY_CONFIG_PATH = "system_config/visitor_daily";
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
const LINE_TARGETS_COLLECTION = "line_targets";
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
const RESIDENT_PIN_COLLECTION = "resident_pins";
const RESIDENTS_COLLECTION = "residents";
const AUDIT_LOG_COLLECTION = "audit_log";
const POLLS_COLLECTION = "polls";
const LIFESTYLE_SURVEY_COLLECTION = "lifestyle_surveys";
const RESIDENT_SIGNATURE_COLLECTION = "resident_signatures";
const ADMIN_DOCUMENTS_COLLECTION = "admin_documents";
const ADMIN_ACCESS_COLLECTION = "admin_access";
const LPR_RECONCILIATION_COLLECTION = "lpr_reconciliation_runs";
const LPR_TRAFFIC_EVENTS_COLLECTION = "lpr_traffic_events";
const LPR_DAILY_TRAFFIC_COLLECTION = "lpr_daily_traffic_reports";
// Human review/labels for "สแกนไม่พบ" captures, used as OCR training feedback.
const LPR_UNREADABLE_LABELS_COLLECTION = "lpr_unreadable_labels";
const LPR_OVERNIGHT_COLLECTION = "lpr_overnight_reports";
const LPR_VEHICLE_PROFILES_COLLECTION = "lpr_vehicle_profiles";
const LPR_AGENT_C_STATUS_COLLECTION = "lpr_agent_c_camera_status";
const LPR_AGENT_C_AUDITS_COLLECTION = "lpr_agent_c_event_audits";
const LPR_AGENT_C_METRICS_COLLECTION = "lpr_agent_c_daily_metrics";
const LPR_AGENT_C_REPORTS_COLLECTION = "lpr_agent_c_report_audits";
const LPR_AGENT_C_ALERTS_COLLECTION = "lpr_agent_c_alerts";
const LPR_AGENT_C_TEST_TARGET_ID = "Cc8b4fea6ca64611a006388a9c46d8bbe";
const VISITOR_INTAKE_COLLECTION = "visitor_intake_logs";
const VISITOR_INTAKE_SESSIONS_COLLECTION = "visitor_intake_sessions";
const VISITOR_DAILY_REPORTS_COLLECTION = "visitor_daily_reports";
const VISITOR_INTAKE_SESSION_WINDOW_MS = 3 * 60 * 1000;
const VISITOR_INTAKE_IMAGE_RETENTION_DAYS = 90;
const VISITOR_INTAKE_METADATA_RETENTION_DAYS = 365;
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
const ADMIN_PERMISSION_KEYS = [
  "admin.portal",
  "admin.residents",
  "admin.pins",
  "admin.vote",
  "admin.survey",
  "admin.announcements",
  "admin.pickup",
  "admin.audit",
  "expense.view",
  "expense.manage",
  "insurance.view",
  "insurance.manage",
  "blueprints.view",
  "blueprints.manage",
];
const ADMIN_ACCESS_DEFAULTS = {
  "38/8": {
    roleLabel: "ประธานกรรมการ",
    permissions: Object.fromEntries(
        ADMIN_PERMISSION_KEYS.map((key) => [key, true]),
    ),
  },
  "38/38": {
    roleLabel: "กรรมการ",
    permissions: {
      "expense.view": true,
      "insurance.view": true,
      "blueprints.view": true,
    },
  },
};

// ── Bulky Waste ──────────────────────────────────────────────────────────────
const BULKY_WASTE_COLLECTION = "bulky_waste_requests";
const MAX_BULKY_WASTE_PHOTOS = 40; // total cap across all items
const MAX_BULKY_WASTE_PHOTOS_PER_ITEM = 8;
const MAX_BULKY_WASTE_PHOTO_BYTES = 8 * 1024 * 1024;
// Simplified to two states: submitted (ส่งคำขอมา) / completed (รับของไปแล้ว).
// Legacy values still accepted for display of older docs.
const BULKY_WASTE_STATUSES = new Set(["submitted", "completed"]);
const MAX_BULKY_WASTE_ITEMS = 30;

// ── Car quota ────────────────────────────────────────────────────────────────
const CAR_QUOTA_DEFAULT = 3;
const CAR_QUOTA_BY_HOUSE = new Map([
  ["38/19", 4],
  ["38/41", 5],
]);

/**
 * Parses a resident quota value into a positive integer.
 * @param {*} value
 * @return {number|null}
 */
function parseCarQuota(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const quota = Number(value);
  if (!Number.isInteger(quota) || quota <= 0) {
    return null;
  }
  return quota;
}

/**
 * Applies permissive CORS headers for static GitHub Pages admin requests.
 * @param {*} req
 * @param {*} res
 * @return {void}
 */
function setCorsHeaders(req, res) {
  const allowedOrigins = new Set([
    "https://pattra8.com",
    "https://www.pattra8.com",
    "https://pattra8.github.io",
  ]);
  const origin = req.get("Origin");
  res.set(
      "Access-Control-Allow-Origin",
      allowedOrigins.has(origin) ? origin : "https://pattra8.com",
  );
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Cache-Control", "no-store");
}

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
  const date = data.date || new Date().toLocaleDateString("th-TH");

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
 * @return {Promise<Object[]>}
 */
async function uploadAnnouncementImages(announcementId, media) {
  const bucket = admin.storage().bucket();
  const images = Array.isArray(media) ?
    media.slice(0, MAX_ANNOUNCEMENT_IMAGES) :
    [];
  const uploaded = [];

  for (let index = 0; index < images.length; index++) {
    const parsed = parseAnnouncementImage(images[index]);
    const token = crypto.randomUUID();
    const objectPath = `announcements/${announcementId}/` +
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
  const date = new Date().toLocaleString("th-TH", {
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
 * Returns a complete, normalized permission map.
 * @param {Object} permissions
 * @return {Object}
 */
function normalizeAdminPermissions(permissions = {}) {
  return Object.fromEntries(
      ADMIN_PERMISSION_KEYS.map((key) => [key, permissions[key] === true]),
  );
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
 * Normalizes a house number for resident auth lookup.
 * @param {string} houseNo
 * @return {string}
 */
function normalizeHouseNo(houseNo) {
  return String(houseNo || "").trim().replace(/\s+/g, "");
}

/**
 * Returns the maximum number of cars allowed for a house.
 * @param {string} houseNo
 * @param {Object=} residentData
 * @return {number}
 */
function getCarQuota(houseNo, residentData = {}) {
  const residentQuota = parseCarQuota(
      residentData.car_quota || residentData.carQuota,
  );
  if (residentQuota) {
    return residentQuota;
  }
  const quota = CAR_QUOTA_BY_HOUSE.get(normalizeHouseNo(houseNo));
  if (quota) {
    return quota;
  }
  return CAR_QUOTA_DEFAULT;
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

    for (const plate of toAdd) {
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
  const allCars = await buildAllCarsForSync(houseNo, cars);
  const result = await syncLprCarDiff({
    houseNo,
    oldCars: cars,
    newCars: cars,
    allCars,
  });

  const patch = {
    lpr_last_sync: new Date().toISOString(),
    lpr_last_retry_at: new Date().toISOString(),
    lpr_sync_pending: !result.ok,
    lpr_sync_retry_count: admin.firestore.FieldValue.increment(1),
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
  const dateText = new Intl.DateTimeFormat("th-TH", {
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
 * Treats camera sentinel values and explicit zero-confidence results as an
 * unreadable detection instead of a real license plate.
 * @param {Object} event
 * @return {boolean}
 */
function isReadableLprEvent(event) {
  const plate = String(event && event.plate || "").trim();
  if (!plate || /^(unknown|none|null|n\/a|no\s*plate|unlicensed)$/i
      .test(plate)) {
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
  if (/^(unknown|none|null|n\/a|no\s*plate|unlicensed)$/i.test(rawPlate)) {
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
 * @return {Object}
 */
function getTrafficDayRange(reportDate, startHour = 0) {
  const cleanDate = String(reportDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
    throw new Error("Invalid report date");
  }
  const sh = String(startHour).padStart(2, "0");
  const startEpoch = Date.parse(`${cleanDate}T${sh}:00:00+07:00`);
  const endEpoch = Date.parse(`${cleanDate}T23:59:59.999+07:00`) + 1;
  return {reportDate: cleanDate, startEpoch, endEpoch};
}

/**
 * Formats a Bangkok date label from an epoch.
 * @param {number} epoch
 * @return {string}
 */
function formatBangkokDateLabel(epoch) {
  return new Intl.DateTimeFormat("th-TH", {
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

// Day card covers 07:00–23:59 so it complements the night card (00:00–07:00).
const DAILY_REPORT_START_HOUR = 7;

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
 * @return {Promise<Object>}
 */
async function buildDailyTrafficReport(
    reportDate, startHour = DAILY_REPORT_START_HOUR) {
  const range = getTrafficDayRange(reportDate, startHour);
  const [eventSnap, expected] = await Promise.all([
    db.collection(LPR_TRAFFIC_EVENTS_COLLECTION)
        .where("capturedAtEpoch", ">=", range.startEpoch)
        .where("capturedAtEpoch", "<", range.endEpoch)
        .get(),
    buildExpectedLprState(),
  ]);
  const events = eventSnap.docs.map((docSnap) => ({
    id: docSnap.id,
    ...docSnap.data(),
  }));
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
 * Searches traffic events for one plate across all stored dates.
 * @param {string} rawPlate
 * @return {Promise<Object>}
 */
async function buildPlateSearchReport(rawPlate) {
  const plate = normalizePlateArray([rawPlate])[0] || "";
  if (!plate) {
    throw new Error("Missing plate");
  }

  const [eventSnap, expected] = await Promise.all([
    db.collection(LPR_TRAFFIC_EVENTS_COLLECTION)
        .where("plate", "==", plate)
        .get(),
    buildExpectedLprState(),
  ]);

  const events = eventSnap.docs.map((docSnap) => ({
    id: docSnap.id,
    ...docSnap.data(),
  }))
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
 * Builds the shared "Pattra Watch" overview Flex card used by both the daily
 * and the night report. Leads with the total cars through the system, then
 * splits into resident (by house) and visitor (listed) plus unreadable.
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
  const title = o.title ||
    (night ? "สรุปรถเข้า–ออก ช่วงกลางคืน" : "สรุปรถเข้า–ออก ประจำวัน");
  const windowText = o.windowText || (night ? report.windowLabel : "ทั้งวัน");
  const dateText = new Intl.DateTimeFormat("th-TH", {
    dateStyle: "long", timeZone: "Asia/Bangkok",
  }).format(new Date(`${report.reportDate}T12:00:00+07:00`));
  const officerName = String(report.securityOfficerName || "").trim();
  const officerLine = officerName ? `รปภ. ${officerName}` : "";
  const stat = (value, label, color, sub) => ({
    type: "box", layout: "vertical", flex: 1, contents: [
      {type: "text", text: String(value), size: "xxl", weight: "bold",
        color, align: "center"},
      {type: "text", text: label, size: "xs", color: t.label,
        align: "center", margin: "xs", wrap: true},
      ...(sub ? [sub] : []),
    ],
  });
  // เข้า/ออก sub-line: green = เข้า, red = ออก, spaced away from the label.
  const io = (inN, outN) => ({
    type: "text", size: "xxs", align: "center", margin: "md", wrap: false,
    adjustMode: "shrink-to-fit", contents: [
      {type: "span", text: `เข้า ${inN || 0}`, color: t.green,
        weight: "bold"},
      {type: "span", text: "   ·   ", color: t.label},
      {type: "span", text: `ออก ${outN || 0}`, color: t.red,
        weight: "bold"},
    ],
  });
  // Hourly density heatmap (daily card only). Each bar is a vertical column:
  // an empty spacer (flex) on top + a colored bar (flex) at the bottom, inside
  // a fixed-height row so the flex ratios become bar heights.
  const buildHeatmap = () => {
    const counts = report.hourlyCounts || [];
    const hours = [];
    for (let h = 7; h <= 23; h++) hours.push(h);
    const maxC = Math.max(1, ...hours.map((h) => counts[h] || 0));
    const barColor = (c) => {
      if (!c) return t.line;
      const r = c / maxC;
      if (r >= 0.85) return t.orange;
      if (r >= 0.55) return "#C98A3C";
      if (r >= 0.30) return t.green;
      return "#CBDDB4";
    };
    const bars = hours.map((h) => {
      const c = counts[h] || 0;
      const val = Math.max(2, Math.round((c / maxC) * 100));
      const empty = Math.max(0, 100 - val);
      const col = [];
      if (empty > 0) {
        col.push({type: "box", layout: "vertical", flex: empty,
          contents: [{type: "filler"}]});
      }
      col.push({type: "box", layout: "vertical", flex: val,
        backgroundColor: barColor(c), cornerRadius: "2px",
        contents: [{type: "filler"}]});
      return {type: "box", layout: "vertical", flex: 1, contents: col};
    });
    const periodLabel = (txt, flex) => ({
      type: "box", layout: "vertical", flex, contents: [
        {type: "text", text: txt, size: "xs", color: t.label, align: "center"},
      ],
    });
    return {type: "box", layout: "vertical", margin: "lg", contents: [
      {type: "box", layout: "horizontal", contents: [
        {type: "text", text: "ช่วงที่รถเข้าออกเยอะ", size: "xs",
          color: t.label, flex: 3},
        {type: "text",
          text: report.busiestHour === null ? "" :
            `พีค ${String(report.busiestHour).padStart(2, "0")}:00 น.`,
          size: "xs", color: t.orange, weight: "bold", align: "end", flex: 2},
      ]},
      {type: "box", layout: "horizontal", height: "54px", spacing: "xs",
        margin: "sm", contents: bars},
      {type: "box", layout: "horizontal", margin: "sm", contents: [
        periodLabel("เช้า", 5),
        periodLabel("กลางวัน", 5),
        periodLabel("เย็น", 4),
        periodLabel("ค่ำ", 3),
      ]},
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
    const color = colorLabels[vision.color] || "";
    return [name, color ? `สี${color}` : ""].filter(Boolean).join(" · ");
  };
  const MAX = 40;
  const externalPlates = report.externalPlates || [];
  const timeSpan = (text, color, weight = "regular") => ({
    type: "span", text, color, weight,
  });
  const visitorTimeContents = (row) => {
    const contents = [];
    if (row.entryTime) {
      contents.push(timeSpan(row.entryTime, t.green, "bold"));
    } else if (!row.exitTime) {
      contents.push(timeSpan(`${dirText(row.directions)} `, t.label));
      contents.push(timeSpan(row.firstTime || "—", t.label, "bold"));
      return contents;
    } else {
      contents.push(timeSpan("—", t.label));
    }
    contents.push(timeSpan(" → ", t.label));
    contents.push(row.exitTime ?
      timeSpan(row.exitTime, t.red, "bold") :
      timeSpan("—", t.label));
    return contents;
  };
  const makeRow = (row) => {
    const vehicle = vehicleText(row);
    return {
      type: "box", layout: "horizontal", margin: "md", spacing: "sm",
      alignItems: "center",
      contents: [
        {type: "box", layout: "vertical", width: "76px", height: "24px",
          borderWidth: "1.5px", borderColor: t.text, cornerRadius: "6px",
          justifyContent: "center", alignItems: "center", contents: [
            {type: "text", text: displayPlate(row.plate), size: "xxs",
              weight: "bold", color: t.text, align: "center",
              adjustMode: "shrink-to-fit"},
          ]},
        {type: "text", text: vehicle || "ไม่มีข้อมูลรถ", size: "xs",
          color: vehicle ? t.label : t.muted, flex: 5, wrap: false,
          adjustMode: "shrink-to-fit"},
        {type: "text", contents: visitorTimeContents(row), size: "xs",
          flex: 4, align: "end", gravity: "center", wrap: false,
          adjustMode: "shrink-to-fit"},
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
  const message = {
    type: "flex",
    altText: night ? `เช้านี้: รถเข้า-ออก ${report.uniqueCars} คัน` :
      `วันนี้: รถเข้าออก ${report.uniqueCars} คัน`,
    contents: {
      type: "bubble", size: "giga",
      header: {type: "box", layout: "vertical", paddingAll: "18px",
        backgroundColor: t.headBg, contents: [
          {type: "box", layout: "horizontal", alignItems: "flex-start",
            contents: [
              {type: "box", layout: "vertical", flex: 7, contents: [
                {type: "text", text: title, size: "lg", weight: "bold",
                  color: t.title, wrap: true},
                {type: "box", layout: "vertical", margin: "sm",
                  backgroundColor: night ? t.heroBg : "#FFF2B8",
                  cornerRadius: "md", paddingAll: "7px", contents: [
                    {type: "text", text: dateText, size: "sm",
                      weight: "bold", color: t.title, wrap: false,
                      adjustMode: "shrink-to-fit"},
                    {type: "text", text: `ช่วงเวลา ${windowText} น.`,
                      size: "xxs", color: t.label, wrap: false,
                      adjustMode: "shrink-to-fit"},
                    ...(officerLine ? [{
                      type: "text",
                      text: officerLine,
                      size: "xxs",
                      color: t.orange,
                      wrap: false,
                      adjustMode: "shrink-to-fit",
                      margin: "xs",
                    }] : []),
                  ]},
              ]},
              {type: "image", url: t.logo, size: "90px", flex: 3,
                aspectRatio: "928:118", aspectMode: "fit", align: "end"},
            ]},
        ]},
      body: {type: "box", layout: "vertical", paddingAll: "18px",
        backgroundColor: t.bodyBg, contents: [
          {type: "box", layout: "vertical", backgroundColor: t.heroBg,
            cornerRadius: "md", paddingAll: "12px", contents: [
              {type: "text",
                text: "รถยนต์ผ่านประตูทั้งหมด",
                size: "sm", weight: "bold", color: t.title, align: "center"},
              {type: "text", text: `${report.uniqueCars} คัน`, size: "xxl",
                weight: "bold", color: t.green, align: "center"},
            ]},
          {type: "box", layout: "horizontal", spacing: "sm", margin: "lg",
            contents: [
              stat(report.residentCars, "รถลูกบ้าน", t.green,
                  io(report.residentEntryCars, report.residentExitCars)),
              stat(report.externalCars, "รถภายนอก", t.orange,
                  io(report.externalEntryCars, report.externalExitCars)),
              stat(report.unreadableDetections, "สแกนไม่พบ", t.red),
            ]},
          ...(night ? [] : [buildHeatmap()]),
          {type: "separator", margin: "lg", color: t.line},
          {type: "box", layout: "horizontal", margin: "lg",
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
  const completedDay = report.reportDate < getTodayBangkokDate();
  return buildPattraWatchFlex(report, {
    variant: "daily",
    windowText: completedDay ? "07:00–23:59" :
      report.timeRange || "07:00–ปัจจุบัน",
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
  const report = await buildDailyTrafficReport(reportDate);
  report.securityOfficerName = await getSecurityShiftOfficerName("day");
  if (themeName) report.themeName = themeName;
  const reportRef = db.collection(LPR_DAILY_TRAFFIC_COLLECTION)
      .doc(report.reportDate);
  let lineSent = false;
  let lineError = "";
  let lineTargetId = "";
  if (sendLine) {
    try {
      const targetId = targetIdOverride || await getDailyTrafficTargetId();
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
    await getDailyTrafficTargetId();
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
 * Builds the epoch range for the overnight window of one Bangkok date.
 * @param {string} reportDate YYYY-MM-DD
 * @param {number} startHour inclusive start hour (default 0)
 * @param {number} endHour exclusive end hour (default 7)
 * @return {{reportDate: string, startHour: number, endHour: number,
 *   startEpoch: number, endEpoch: number}}
 */
function getOvernightRange(reportDate, startHour = 0, endHour = 7) {
  const cleanDate = String(reportDate || "").slice(0, 10);
  const sh = String(startHour).padStart(2, "0");
  const eh = String(endHour).padStart(2, "0");
  const startEpoch = Date.parse(`${cleanDate}T${sh}:00:00+07:00`);
  const endEpoch = Date.parse(`${cleanDate}T${eh}:00:00+07:00`);
  return {reportDate: cleanDate, startHour, endHour, startEpoch, endEpoch};
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
 * Builds the overnight (default 00:00–07:00) security report from LPR events.
 * Splits readable detections into resident vs external cars and lists the
 * external plates so the night shift can review who came through.
 * @param {string} reportDate YYYY-MM-DD
 * @param {number} startHour
 * @param {number} endHour
 * @return {Promise<Object>}
 */
async function buildOvernightSecurityReport(reportDate, startHour = 0,
    endHour = 7) {
  const range = getOvernightRange(reportDate, startHour, endHour);
  const [eventSnap, expected] = await Promise.all([
    db.collection(LPR_TRAFFIC_EVENTS_COLLECTION)
        .where("capturedAtEpoch", ">=", range.startEpoch)
        .where("capturedAtEpoch", "<", range.endEpoch)
        .get(),
    buildExpectedLprState(),
  ]);
  const events = eventSnap.docs.map((docSnap) => ({
    id: docSnap.id,
    ...docSnap.data(),
  }));
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

  // Count unique cars per direction (a car seen both ways counts in each).
  let entryCars = 0;
  let exitCars = 0;
  plateAgg.forEach((agg) => {
    if (agg.directions.has("entry")) entryCars += 1;
    if (agg.directions.has("exit")) exitCars += 1;
  });

  return {
    reportDate: range.reportDate,
    windowLabel: `${String(range.startHour).padStart(2, "0")}:00–` +
      `${String(range.endHour).padStart(2, "0")}:00`,
    startHour: range.startHour,
    endHour: range.endHour,
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
 * @param {number} endHour
 * @return {Object}
 */
function getSecurityAuditRange(reportDate, startHour, endHour) {
  const cleanDate = String(reportDate || getTodayBangkokDate()).slice(0, 10);
  const start = Number.isFinite(Number(startHour)) ? Number(startHour) : 7;
  const end = Number.isFinite(Number(endHour)) ? Number(endHour) : 19;
  const startEpoch = Date.parse(
      `${cleanDate}T${String(start).padStart(2, "0")}:00:00+07:00`,
  );
  let endEpoch = Date.parse(
      `${cleanDate}T${String(end).padStart(2, "0")}:00:00+07:00`,
  );
  const crossesMidnight = end <= start;
  if (crossesMidnight) endEpoch += 24 * 60 * 60 * 1000;
  return {
    reportDate: cleanDate,
    startHour: start,
    endHour: end,
    startEpoch,
    endEpoch,
    crossesMidnight,
    windowLabel: `${String(start).padStart(2, "0")}:00–` +
      `${String(end).padStart(2, "0")}:00`,
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
  const events = eventSnap.docs.map((docSnap) => ({
    id: docSnap.id,
    ...docSnap.data(),
  }));
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
    externalCars: enrichedExternalPlates.length,
    externalPlates: enrichedExternalPlates,
    unreadableDetections: events.length - readableEvents.length,
  };
}

/**
 * Builds the guard-audit report card using daily traffic + visitor log data.
 * @param {string} reportDate
 * @param {number} startHour
 * @param {number} endHour
 * @param {string} officerNameOverride
 * @return {Promise<Object>}
 */
async function buildSecurityAuditReport(reportDate, startHour = 7,
    endHour = 19, officerNameOverride = "") {
  const range = getSecurityAuditRange(reportDate, startHour, endHour);
  const nextDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(range.startEpoch + 24 * 60 * 60 * 1000));
  const visitDates = [range.reportDate];
  if (range.crossesMidnight) visitDates.push(nextDate);
  const [trafficReport, visitorSnaps, officerName] = await Promise.all([
    buildSecurityAuditTrafficSlice(range),
    Promise.all(visitDates.map((visitDate) =>
      db.collection(VISITOR_INTAKE_COLLECTION)
          .where("visitDate", "==", visitDate)
          .limit(500)
          .get(),
    )),
    getSecurityShiftOfficerName(range.shift),
  ]);
  const visitorRecords = visitorSnaps.flatMap((snap) => snap.docs)
      .map((docSnap) => ({id: docSnap.id, ...(docSnap.data() || {})}))
      .filter((record) => {
        const createdAtMs = record.createdAt && record.createdAt.toMillis ?
          record.createdAt.toMillis() : 0;
        return createdAtMs >= range.startEpoch && createdAtMs < range.endEpoch;
      });

  const visitorCarMap = new Map();
  const visitorMotorcycles = [];
  const purposeCounts = new Map();
  visitorRecords.forEach((record) => {
    const plate = normalizeVisitorPlate(
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
    const label = visitorPurposeLabel(
        record.purposeCategory || "unknown",
        record.purposeText || "",
    );
    purposeCounts.set(label, (purposeCounts.get(label) || 0) + 1);
  });

  const visitorCarPlates = Array.from(visitorCarMap.keys());
  const externalPlates = (trafficReport.externalPlates || []).map((row) => ({
    ...row,
    plate: normalizeVisitorPlate(row.plate || ""),
  })).filter((row) => row.plate);
  const missingPlates = externalPlates
      .filter((row) => !visitorCarMap.has(row.plate))
      .map((row) => row.plate);
  const uncheckedCars = Math.max(0, externalPlates.length -
    visitorCarPlates.length);
  const missingPlatesDisplay = missingPlates.slice(0,
      Math.min(24, uncheckedCars));
  const missingPlatesLeft = Math.max(0, uncheckedCars -
    missingPlatesDisplay.length);

  return {
    reportDate: range.reportDate,
    windowLabel: range.windowLabel,
    shift: range.shift,
    generatedAt: new Date().toISOString(),
    securityOfficerName: String(officerNameOverride || officerName || "")
        .trim(),
    carTotal: externalPlates.length || trafficReport.externalCars || 0,
    checkedCars: visitorCarPlates.length,
    uncheckedCars,
    percent: externalPlates.length ?
      Math.round((visitorCarPlates.length / externalPlates.length) * 100) : 0,
    unreadable: trafficReport.unreadableDetections || 0,
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
 * Builds the guard-audit LINE card with badge-style unchecked plates.
 * @param {Object} report
 * @return {Object}
 */
function buildSecurityAuditFlexMessage(report) {
  const t = {
    headBg: "#F8F3EA",
    bodyBg: "#FFFCF6",
    cardBg: "#F2E7D3",
    softCard: "#FBF7EF",
    title: "#34281F",
    text: "#47372B",
    label: "#8D7A66",
    line: "#E7DCCB",
    green: "#5F7F46",
    orange: "#C56E33",
    red: "#BF4B3A",
    track: "#EADDCB",
    greenBg: "#EAF3DE",
    orangeBg: "#FFF6EA",
    redBg: "#FCEBEB",
  };
  const dateText = new Intl.DateTimeFormat("th-TH", {
    dateStyle: "long",
    timeZone: "Asia/Bangkok",
  }).format(new Date(`${report.reportDate}T12:00:00+07:00`));
  const timeText = `ช่วงเวลา ${report.windowLabel} น.`;
  const shiftTitle = report.shift === "night" ?
    "ตรวจงาน รปภ. กะกลางคืน" : "ตรวจงาน รปภ. กะกลางวัน";
  const officerLine = report.securityOfficerName ?
    `รปภ. ${report.securityOfficerName}` : "";
  const stat = (value, label, color) => ({
    type: "box",
    layout: "vertical",
    flex: 1,
    backgroundColor: t.softCard,
    cornerRadius: "10px",
    paddingAll: "10px",
    contents: [
      {type: "text", text: String(value), size: "xl", weight: "bold",
        color, align: "center"},
      {type: "text", text: label, size: "xs", color: t.label,
        align: "center", margin: "xs", wrap: true},
    ],
  });
  const plateBadge = (plate) => ({
    type: "box",
    layout: "vertical",
    width: "72px",
    height: "34px",
    borderColor: t.text,
    borderWidth: "1.5px",
    cornerRadius: "8px",
    paddingAll: "5px",
    justifyContent: "center",
    alignItems: "center",
    contents: [
      {type: "text", text: plate, size: "xxs", weight: "bold",
        color: t.text, align: "center", wrap: false,
        adjustMode: "shrink-to-fit"},
    ],
  });
  const badgeRows = chunkArray(report.missingPlatesDisplay || [], 4)
      .map((row) => ({
        type: "box",
        layout: "horizontal",
        spacing: "xs",
        margin: "sm",
        contents: row.map((plate) => plateBadge(plate)),
      }));
  if (!badgeRows.length) {
    badgeRows.push({
      type: "text",
      text: "ไม่มีทะเบียนที่ค้างตรวจ",
      size: "sm",
      color: t.label,
      align: "center",
      margin: "sm",
    });
  }
  if (report.totalMissingLabel) {
    badgeRows.push({
      type: "text",
      text: report.totalMissingLabel,
      size: "xs",
      color: t.label,
      align: "center",
      margin: "sm",
    });
  }
  const purposeRows = (report.purposes || []).map((item) => ({
    type: "box",
    layout: "horizontal",
    margin: "sm",
    contents: [
      {type: "text", text: item.label, size: "sm", color: t.text,
        flex: 4, wrap: false, adjustMode: "shrink-to-fit"},
      {type: "text", text: `${item.count} รายการ`, size: "sm",
        color: t.orange, weight: "bold", align: "end", flex: 2},
    ],
  }));
  const progressFlex = Math.max(1, Math.min(100, report.percent || 0));
  const progressBgFlex = Math.max(1, 100 - progressFlex);
  const percentColor = (report.percent || 0) >= 80 ? t.green :
    (report.percent || 0) >= 50 ? t.orange : t.red;
  const percentBg = (report.percent || 0) >= 80 ? t.greenBg :
    (report.percent || 0) >= 50 ? t.orangeBg : t.redBg;
  return {
    type: "flex",
    altText: `ตรวจงาน รปภ. ${dateText}: ตรวจได้ ${report.percent}%`,
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box",
        layout: "vertical",
        paddingAll: "18px",
        backgroundColor: t.headBg,
        contents: [
          {type: "text", text: shiftTitle, size: "lg",
            weight: "bold", color: t.title, wrap: true},
          {type: "text", text: dateText, size: "sm", color: t.label,
            margin: "xs", wrap: false, adjustMode: "shrink-to-fit"},
          {type: "text", text: timeText, size: "sm", color: t.label,
            margin: "xs", wrap: false, adjustMode: "shrink-to-fit"},
          ...(officerLine ? [{
            type: "text",
            text: officerLine,
            size: "xs",
            color: t.orange,
            margin: "xs",
            wrap: false,
            adjustMode: "shrink-to-fit",
          }] : []),
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "18px",
        backgroundColor: t.bodyBg,
        contents: [
          {
            type: "box",
            layout: "vertical",
            backgroundColor: t.cardBg,
            cornerRadius: "12px",
            paddingAll: "16px",
            contents: [
              {type: "text",
                text: "รถยนต์ Visitor เข้า-ออกโครงการทั้งหมด",
                size: "sm",
                weight: "bold", color: t.label, align: "center"},
              {type: "text", text: `${report.carTotal} คัน`, size: "4xl",
                weight: "bold", color: t.green, align: "center", margin: "xs"},
              {
                type: "box",
                layout: "horizontal",
                spacing: "sm",
                margin: "md",
                contents: [
                  stat(`${report.checkedCars} คัน`, "ตรวจแล้ว", t.green),
                  stat(`${report.uncheckedCars} คัน`, "ไม่ได้ตรวจบัตร", t.red),
                ],
              },
              {
                type: "box",
                layout: "horizontal",
                margin: "md",
                spacing: "md",
                alignItems: "center",
                contents: [
                  {
                    type: "box",
                    layout: "vertical",
                    flex: 1,
                    contents: [
                      {type: "text", text: "ตรวจบัตรแล้ว", size: "xs",
                        color: t.label, margin: "none"},
                      {
                        type: "box",
                        layout: "horizontal",
                        height: "8px",
                        margin: "sm",
                        backgroundColor: t.track,
                        cornerRadius: "4px",
                        contents: [
                          {type: "box", layout: "vertical",
                            flex: progressFlex,
                            backgroundColor: percentColor,
                            cornerRadius: "4px",
                            contents: [{type: "filler"}]},
                          {type: "box", layout: "vertical",
                            flex: progressBgFlex,
                            contents: [{type: "filler"}]},
                        ],
                      },
                    ],
                  },
                  {
                    type: "box",
                    layout: "vertical",
                    width: "48px",
                    height: "48px",
                    cornerRadius: "24px",
                    backgroundColor: percentBg,
                    borderColor: percentColor,
                    borderWidth: "2px",
                    justifyContent: "center",
                    alignItems: "center",
                    contents: [
                      {type: "text", text: `${report.percent}%`, size: "xs",
                        weight: "bold", color: percentColor, align: "center",
                        wrap: false, adjustMode: "shrink-to-fit"},
                    ],
                  },
                ],
              },
            ],
          },
          {type: "separator", margin: "lg", color: t.line},
          {type: "text", text: "ทะเบียนค้างตรวจบัตร", size: "md",
            weight: "bold", color: t.title, margin: "lg"},
          ...badgeRows,
          {type: "separator", margin: "lg", color: t.line},
          {
            type: "box",
            layout: "horizontal",
            margin: "lg",
            contents: [
              {type: "text",
                text: "รถมอเตอร์ไซต์เข้า-ออกหมู่บ้านทั้งหมด",
                size: "sm", weight: "bold", color: t.title, flex: 4,
                wrap: true},
              {type: "text", text: `${report.motorcycleCount} คัน`,
                size: "md", weight: "bold", color: t.green, align: "end",
                flex: 2},
            ],
          },
          {type: "separator", margin: "lg", color: t.line},
          {type: "text", text: "เหตุผลที่มาติดต่อ", size: "md",
            weight: "bold", color: t.title, margin: "lg"},
          ...(purposeRows.length ? purposeRows : [{
            type: "text",
            text: "ยังไม่มีรายการผู้มาติดต่อในกะนี้",
            size: "sm",
            color: t.label,
            align: "center",
            margin: "sm",
          }]),
          {
            type: "text",
            text: `ข้อมูลจริง · Pattra Watch · ${
              formatBangkokHm(Date.now())
            } น.`,
            size: "xxs", color: t.label, align: "center", margin: "lg",
          },
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
 * @param {number} endHour
 * @param {string} [targetIdOverride]
 * @param {string} [officerNameOverride]
 * @return {Promise<Object>}
 */
async function runSecurityAuditReport(reportDate, sendLine = true,
    startHour = 7, endHour = 19, targetIdOverride = "",
    officerNameOverride = "") {
  const report = await buildSecurityAuditReport(
      reportDate,
      startHour,
      endHour,
      officerNameOverride,
  );
  let lineSent = false;
  let lineError = "";
  let lineTargetId = "";
  if (sendLine) {
    try {
      const targetId = targetIdOverride || await getGuardAuditTargetId();
      if (!targetId) {
        throw new Error("Guard audit LINE group is not set");
      }
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
 * @param {number} endHour
 * @param {string} targetIdOverride registered LINE target for manual tests
 * @return {Promise<Object>}
 */
async function runOvernightSecurityReport(reportDate, sendLine = true,
    startHour = 0, endHour = 7, targetIdOverride = "") {
  const report = await buildOvernightSecurityReport(
      reportDate, startHour, endHour);
  report.securityOfficerName = await getSecurityShiftOfficerName("night");
  const reportRef = db.collection(LPR_OVERNIGHT_COLLECTION)
      .doc(report.reportDate);
  let lineSent = false;
  let lineError = "";
  let lineTargetId = "";
  if (sendLine) {
    try {
      const targetId = targetIdOverride || await getDailyTrafficTargetId();
      if (!targetId) throw new Error("Daily traffic LINE group is not set");
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
  const guardSnap = await db.doc(GUARD_AUDIT_CONFIG_PATH).get();
  if (guardSnap.exists) {
    const guard = guardSnap.data() || {};
    return guard.groupId || guard.targetId || null;
  }
  const shiftSnap = await db.doc(SECURITY_SHIFT_CONFIG_PATH).get();
  if (!shiftSnap.exists) return null;
  const shift = shiftSnap.data() || {};
  return shift.groupId || shift.targetId || null;
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
    throw new Error(`LINE content failed (${response.status})`);
  }
  return {buffer: Buffer.from(arrayBuffer), contentType};
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
  const number = prefixed ? Number(prefixed[1]) : Number(clean);
  if (!Number.isInteger(number) || number < 1 || number > 69) return "";
  return `38/${number}`;
}

// Purpose keyword patterns. Order matters: "grab car / มารับ" (pickup) is
// checked before the generic "grab" (food) rule below.
// pickup = รับ-ส่งคน (Grab car / taxi). "มารับ" is treated as a person
// pickup EXCEPT when it is immediately picking up a parcel/goods
// ("มารับพัสดุ", "มารับของ") — those are delivery, handled by the
// negative lookahead + the extra parcel-pickup tokens in DELIVERY below.
const VISITOR_PICKUP_RE = new RegExp([
  "grab\\s*car", "grabcar", "bolt", "แท็กซี่", "taxi", "รับ-?ส่ง", "รับคน",
  "รับลูกบ้าน", "ส่งลูกบ้าน", "ไปส่งลูกบ้าน",
  "มารับ(?!\\s*(?:พัสดุ|ของ|เอกสาร|สินค้า|กล่อง|parcel))",
].join("|"));
const VISITOR_FOOD_RE =
  /grab|food|panda|lineman|line\s*man|robinhood|อาหาร|ส่งอาหาร|ส่งขน/;
const VISITOR_DELIVERY_RE = new RegExp([
  "shopee", "lazada", "ขนส่ง", "ส่งของ", "ส่งพัสดุ", "พัสดุ", "parcel",
  "รับพัสดุ", "รับของ", "รับเอกสาร", "รับสินค้า",
  "delivery", "flash", "kerry", "j&t", "ไปรษณีย์", "dhl", "ninja", "best",
].join("|"));
const VISITOR_UTILITY_RE =
  /การไฟฟ้า|การประปา|เจ้าหน้าที่ไฟฟ้า|เจ้าหน้าที่ประปา|3bb|ทีโอที/;
const VISITOR_CONTRACTOR_RE = new RegExp([
  "ช่าง", "ผู้รับเหมา", "รับเหมา", "ซ่อม", "ซ่อมไฟ", "ซ่อมน้ำ",
  "ไฟฟ้า", "ประปา", "ทาสี", "แอร์", "ติดตั้ง", "ก่อสร้าง",
].join("|"));
const VISITOR_OFFICE_RE = /นิติ|นิติบุคคล|สำนักงานนิติ|ออฟฟิศ|office/;
const VISITOR_COMMON_AREA_RE = new RegExp([
  "ติดต่อนิติ", "นิติบุคคล", "สำนักงานนิติ", "หน้าโครงการ",
  "ติดต่อหน้าโครงการ", "สโมสร", "ติดต่อสโมสร",
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
const THAI_PROVINCES = [
  "กรุงเทพมหานคร", "กรุงเทพ", "กระบี่", "กาญจนบุรี", "กาฬสินธุ์",
  "กำแพงเพชร", "ขอนแก่น", "จันทบุรี", "ฉะเชิงเทรา", "ชลบุรี",
  "ชัยนาท", "ชัยภูมิ", "ชุมพร", "เชียงราย", "เชียงใหม่", "ตรัง",
  "ตราด", "ตาก", "นครนายก", "นครปฐม", "นครพนม", "นครราชสีมา",
  "นครศรีธรรมราช", "นครสวรรค์", "นนทบุรี", "นราธิวาส", "น่าน",
  "บึงกาฬ", "บุรีรัมย์", "ปทุมธานี", "ประจวบคีรีขันธ์", "ปราจีนบุรี",
  "ปัตตานี", "พระนครศรีอยุธยา", "พะเยา", "พังงา", "พัทลุง", "พิจิตร",
  "พิษณุโลก", "เพชรบุรี", "เพชรบูรณ์", "แพร่", "ภูเก็ต", "มหาสารคาม",
  "มุกดาหาร", "แม่ฮ่องสอน", "ยโสธร", "ยะลา", "ร้อยเอ็ด", "ระนอง",
  "ระยอง", "ราชบุรี", "ลพบุรี", "ลำปาง", "ลำพูน", "เลย", "ศรีสะเกษ",
  "สกลนคร", "สงขลา", "สตูล", "สมุทรปราการ", "สมุทรสงคราม",
  "สมุทรสาคร", "สระแก้ว", "สระบุรี", "สิงห์บุรี", "สุโขทัย",
  "สุพรรณบุรี", "สุราษฎร์ธานี", "สุรินทร์", "หนองคาย", "หนองบัวลำภู",
  "อ่างทอง", "อำนาจเจริญ", "อุดรธานี", "อุตรดิตถ์", "อุทัยธานี",
  "อุบลราชธานี",
].sort((a, b) => b.length - a.length);

// Human-readable Thai label per category (shown in the LINE reply).
const VISITOR_CATEGORY_LABELS = {
  food_delivery: "ส่งอาหาร",
  delivery: "ส่งพัสดุ/ขนส่ง",
  pickup: "รับ-ส่ง (Grab/แท็กซี่)",
  contractor: "ช่าง/ซ่อมบำรุง",
  utility: "หน่วยงานสาธารณูปโภค",
  office: "ติดต่อนิติ/ส่วนกลาง",
  contact: "มาติดต่อ",
  guest: "มาหาลูกบ้าน",
};

/**
 * Maps a free-form purpose into a compact category.
 * @param {string} text
 * @return {string}
 */
function mapVisitorPurposeCategory(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return "unknown";
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
  return VISITOR_CATEGORY_LABELS[category] || (rawText || "ไม่ระบุ");
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
  if (/ล้าง\s*แอร์|แอร์/.test(value)) return "ล้างแอร์";
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
 * Parses flexible guard-entered visitor text.
 * @param {string} text
 * @return {Object}
 */
function parseVisitorIntakeText(text) {
  const rawText = String(text || "").trim();
  const vehiclePlate = extractVisitorPlateFromText(rawText);
  const isCommonAreaContact = VISITOR_COMMON_AREA_RE.test(rawText);
  const tokens = rawText
      .split(/[\n,，]+/)
      .map((line) => line.trim())
      .filter(Boolean);
  let houseNo = isCommonAreaContact ? "38/69" : "";
  const purposeParts = [];

  for (const token of tokens) {
    const embedded = token.match(/38\s*\/\s*(\d{1,2})/);
    const labeledShort = token.match(/(?:บ้าน|เลขที่)\s*(\d{1,2})/i);
    const standalone = token.match(/^\d{1,2}$/);
    if (!houseNo && (embedded || labeledShort || standalone)) {
      houseNo = normalizePattraHouseNo(
          embedded ? embedded[0] : labeledShort ? labeledShort[1] : token,
      );
      const leftover = token.replace(/38\s*\/\s*\d{1,2}/, "")
          .replace(/(?:บ้าน|เลขที่)\s*\d{1,2}/i, "")
          .replace(/^\d{1,2}$/, "")
          .trim();
      if (leftover) purposeParts.push(leftover);
      continue;
    }
    purposeParts.push(token);
  }

  let purposeText = cleanVisitorPurposeText(
      removeVisitorPlateText(purposeParts.join(" "), vehiclePlate),
  );
  if (isCommonAreaContact) {
    purposeText = "ติดต่อนิติ/ส่วนกลาง";
  }
  const purposeCategory = mapVisitorPurposeCategory(purposeText);
  const ignoredReason = getVisitorChatTextReason({
    rawText,
    houseNo,
    purposeText,
    purposeCategory,
    vehiclePlate,
  });
  return {
    rawText,
    houseNo,
    purposeText,
    purposeCategory,
    vehiclePlate,
    ignored: Boolean(ignoredReason),
    ignoredReason,
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
      .replace(/ส่ง\s*ลูกบ้านเลขที่/gi, "ส่งลูกบ้าน")
      .replace(/ไปส่ง\s*ลูกบ้านเลขที่/gi, "ไปส่งลูกบ้าน")
      .replace(/รับ\s*ลูกบ้านเลขที่/gi, "รับลูกบ้าน")
      .replace(/มารับ\s*ลูกบ้านเลขที่/gi, "มารับลูกบ้าน")
      .replace(/(?:ลูก)?บ้านเลขที่/gi, "")
      .replace(/(^|.)ลูกบ้าน\s*$/giu, (match, prefix, _offset, text) =>
        /(รับ|ส่ง|ไปส่ง)ลูกบ้าน\s*$/u.test(text) ? match : prefix)
      .replace(/(^|.)บ้าน\s*$/giu, (match, prefix) =>
        prefix === "ก" ? match : prefix)
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
  if (!parsed.houseNo && (!parsed.purposeText ||
      ["unknown", "other"].includes(parsed.purposeCategory))) {
    return "no_house_or_visitor_purpose";
  }
  return "";
}

/**
 * Normalizes one manually editable visitor name.
 * @param {string} raw
 * @return {string}
 */
function normalizeVisitorName(raw) {
  return String(raw || "").normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
}

/**
 * Normalizes a Thai plate candidate for display/storage.
 * @param {string} raw
 * @return {string}
 */
function normalizeVisitorPlate(raw) {
  let clean = String(raw || "")
      .replace(/\s+/g, "")
      .replace(/จังหวัด/g, "")
      .replace(/กรุงเทพมหานคร/g, "กรุงเทพ")
      .trim();
  let province = "";
  for (const candidate of THAI_PROVINCES) {
    const normalized = normalizeThaiProvince(candidate);
    if (clean.includes(candidate)) {
      province = normalized;
      clean = clean.replace(candidate, "");
      break;
    }
    if (clean.includes(normalized)) {
      province = normalized;
      clean = clean.replace(normalized, "");
      break;
    }
  }
  const match = clean.match(/^([0-9]?[ก-ฮ]{1,3})([0-9]{1,4})$/);
  if (!match) return [clean, province].filter(Boolean).join(" ").slice(0, 40);
  return [match[1], match[2], province].filter(Boolean).join(" ");
}

/**
 * Normalizes Thai province names for visitor plate storage/display.
 * @param {string} raw
 * @return {string}
 */
function normalizeThaiProvince(raw) {
  const value = String(raw || "").trim();
  return value === "กรุงเทพมหานคร" ? "กรุงเทพ" : value;
}

/**
 * Normalizes vehicle type into committee-facing Thai buckets.
 * @param {string} raw
 * @return {string}
 */
function normalizeVisitorVehicleType(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value || value === "unknown") return "";
  if (/ขยะ|garbage|trash|waste|refuse/.test(value)) return "รถขยะ";
  if (/motor|มอเตอร์|มอเตอ|จักรยานยนต์|scooter|bike/.test(value)) {
    return "รถมอเตอร์ไซค์";
  }
  if (/truck|บรรทุก|lorry|สิบล้อ|หกล้อ/.test(value)) return "รถบรรทุก";
  if (/car|sedan|suv|van|pickup|รถยนต์|รถเก๋ง|รถตู้|กระบะ/.test(value)) {
    return "รถยนต์";
  }
  return value.slice(0, 30);
}

/**
 * Masks a sensitive document number.
 * @param {string} raw
 * @return {string}
 */
function maskDocumentNumber(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 4) return "";
  return `${"*".repeat(Math.max(4, digits.length - 4))}${digits.slice(-4)}`;
}

/**
 * Normalizes Thai ID / driver license OCR into digits-only storage.
 * @param {string} raw
 * @return {string}
 */
function normalizeDocumentNumber(raw) {
  return String(raw || "").replace(/\D/g, "").slice(0, 20);
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
            "security gate. Classify it as document, vehicle, or other. " +
            "For Thai ID card or driver license, extract the person's Thai " +
            "name if visible, the English/Latin name if visible, document " +
            "type, and the visible ID/license number as digits only in " +
            "documentNumber. Prefer Thai names over English names for the " +
            "main personName field. For vehicle images, extract the " +
            "visible Thai license plate with province if visible. Classify " +
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
    imageKind: ["document", "vehicle", "other"].includes(parsed.imageKind) ?
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
    throw new Error(`LINE reply failed (${response.status}): ${body}`);
  }
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
  const sessionRef = db.collection(VISITOR_INTAKE_SESSIONS_COLLECTION)
      .doc(visitorSessionKey(source));
  return db.runTransaction(async (tx) => {
    const sessionSnap = await tx.get(sessionRef);
    const old = sessionSnap.exists ? sessionSnap.data() || {} : {};
    const active = old.logId && old.lastEventAtMs &&
      now - Number(old.lastEventAtMs) <= VISITOR_INTAKE_SESSION_WINDOW_MS;
    let shouldStartNew = !active;
    if (active && ((parsed && parsed.houseNo) || options.isImage)) {
      const oldLogRef = db.collection(VISITOR_INTAKE_COLLECTION).doc(old.logId);
      const oldLogSnap = await tx.get(oldLogRef);
      const oldLog = oldLogSnap.exists ? oldLogSnap.data() || {} : {};
      shouldStartNew = options.isImage ?
        shouldStartNewVisitorImageLog(oldLog) :
        shouldStartNewVisitorLog(oldLog, parsed);
    }
    const logId = shouldStartNew ?
      db.collection(VISITOR_INTAKE_COLLECTION).doc().id : old.logId;
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
 * Decides if a new image should start a fresh visitor log. This prevents the
 * next visitor's image batch from being appended to an already-complete log
 * when guards send photos before the next text line.
 * @param {Object} currentLog
 * @return {boolean}
 */
function shouldStartNewVisitorImageLog(currentLog) {
  if (!currentLog) return false;
  if (currentLog.status === "complete") return true;
  const images = Array.isArray(currentLog.images) ? currentLog.images : [];
  return Boolean(
      currentLog.houseNo &&
      currentLog.purposeText &&
      images.length >= 2,
  );
}

/**
 * Decides if a text message should start a fresh visitor log.
 * @param {Object} currentLog
 * @param {Object} parsed
 * @return {boolean}
 */
function shouldStartNewVisitorLog(currentLog, parsed) {
  if (!currentLog || !parsed || !parsed.houseNo) return false;
  if (currentLog.houseNo && parsed.houseNo !== currentLog.houseNo) return true;
  if (currentLog.status !== "complete") return false;
  if (!parsed || !parsed.houseNo) return false;
  return parsed.houseNo !== currentLog.houseNo ||
    Boolean(parsed.purposeText && currentLog.purposeText);
}

/**
 * Builds the current visitor intake reply text.
 * @param {Object} data
 * @return {string}
 */
function buildVisitorIntakeReply(data) {
  const images = Array.isArray(data.images) ? data.images : [];
  const docCount = images.filter((img) => img.kind === "document").length;
  const vehicleCount = images.filter((img) => img.kind === "vehicle").length;
  const unknownImageCount = images.filter((img) => img.kind === "other").length;
  const houseNo = data.houseNo || "";
  const purposeText = data.purposeText || "";
  const plate = formatVisitorReplyPlate(
      data.vehicleCapture && data.vehicleCapture.plateText,
  );
  const personName = visitorReplyPersonName(data.ocr || {});
  const missing = [];
  if (!houseNo) missing.push("บ้านเลขที่");
  if (!purposeText) missing.push("เหตุผลที่มา");
  if (!docCount) {
    missing.push(images.length ?
      "รูปบัตร/ใบขับขี่อ่านไม่ชัด กรุณาส่งใหม่" :
      "รูปบัตร/ใบขับขี่");
  }
  if (!vehicleCount && !plate) {
    missing.push(unknownImageCount ?
      "อ่านทะเบียนได้ไม่ชัดครับ รบกวน รปภ ส่งรูปป้ายทะเบียนใหม่ " +
        "หรือพิมพ์ทะเบียนให้หน่อยครับ" :
      "รูปรถ/ทะเบียน");
  } else if (!plate) {
    missing.push("อ่านทะเบียนได้ไม่ชัดครับ รบกวน รปภ พิมพ์ทะเบียนให้หน่อยครับ");
  }

  const divider = "━━━━━━━━━━━━━";

  if (missing.length) {
    const missingLines = missing.map((item) => `   ◻️ ${item}`).join("\n");
    return [
      "🙏 รับข้อมูลแล้วครับ",
      "",
      "📋 ขอเพิ่มอีกนิดนะครับ",
      divider,
      missingLines,
      divider,
      "✍️ ตัวอย่างการพิมพ์",
      "      38/13",
      "      ช่างมาทาสี",
    ].join("\n");
  }

  const purposeLabel = visitorPurposeLabel(data.purposeCategory, purposeText);
  const lines = [
    "✅ บันทึกเรียบร้อย",
    divider,
    `🏠 ติดต่อบ้าน : ${visitorReplyHouseNo(houseNo)}`,
  ];
  if (personName) lines.push(`👤 ชื่อ: ${personName}`);
  lines.push(`📝 เหตุผล : ${purposeLabel}`);
  if (plate) lines.push(`🚗 ทะเบียน : ${plate}`);
  return lines.join("\n");
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
 * Recomputes visitor intake status from aggregate data.
 * @param {Object} data
 * @return {string}
 */
function getVisitorIntakeStatus(data) {
  const images = Array.isArray(data.images) ? data.images : [];
  const hasDocument = images.some((img) => img.kind === "document");
  const hasPlate = Boolean(
      data.vehicleCapture && data.vehicleCapture.plateText,
  );
  if (!data.houseNo || !data.purposeText) return "pending_text";
  if (!hasDocument || !hasPlate) return "pending_image";
  return "complete";
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
    if (record.status === "complete") complete += 1;
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
  const dateText = new Intl.DateTimeFormat("th-TH", {
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
      {isImage: message.type === "image"},
  );
  const logRef = db.collection(VISITOR_INTAKE_COLLECTION).doc(logId);

  // Slow work (download + save + Gemini analyze) runs OUTSIDE the
  // transaction so the transaction below stays fast and retry-safe.
  let storedImage = null;
  let imageOcr = null;
  let imageVehicle = null;
  if (message.type === "image") {
    const image = await saveVisitorIntakeImage(event, logId);
    let analysis = null;
    try {
      analysis = await analyzeVisitorIntakeImage(image.storagePath);
    } catch (error) {
      logger.warn("Visitor intake image analysis failed", {
        logId,
        error: error.message,
      });
    }
    const kind = analysis && analysis.confidence >= 0.55 ?
      analysis.imageKind : "other";
    storedImage = {...image, kind, analysis: analysis || null};
    if (analysis && kind === "document") {
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
    if (analysis && kind === "vehicle") {
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
      texts.push({
        messageId: message.id || null,
        text: parsed.rawText,
        createdAt: admin.firestore.Timestamp.fromDate(new Date()),
      });
      update.rawTexts = texts;
      if (parsed.houseNo) update.houseNo = parsed.houseNo;
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
      update.textParse = parsed;
    }

    if (storedImage) {
      const images = Array.isArray(cur.images) ? [...cur.images] : [];
      const dup = storedImage.messageId && images.some(
          (im) => im.messageId === storedImage.messageId);
      if (!dup) images.push(storedImage);
      update.images = images;
      if (imageOcr) update.ocr = imageOcr;
      if (imageVehicle) update.vehicleCapture = imageVehicle;
    }

    const merged = {...cur, ...update};
    merged.status = getVisitorIntakeStatus(merged);
    update.status = merged.status;
    const reply = buildVisitorIntakeReply(merged);
    // Reply right away ONLY when the visit is complete. While still
    // collecting, stay quiet so we don't nag the guard mid-upload (they are
    // usually about to type the house/reason). If the guard then pauses with
    // data still missing, visitorIntakeReminder pushes one reminder.
    const replyNow = merged.status === "complete" &&
      cur.status !== "complete";
    if (replyNow) update.lastReplyText = reply;
    tx.set(logRef, update, {merge: true});
    return replyNow ? reply : null;
  });

  if (replyText) {
    await replyLineText(event.replyToken, replyText);
  }
  logger.info("Visitor intake event handled", {logId});
  return true;
}

exports.lineWebhook = onRequest(
    {
      secrets: [LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN],
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

      for (const event of events) {
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
          continue;
        }

        if (await isVisitorIntakeTarget(source)) {
          try {
            const handled = await handleVisitorIntakeEvent(event);
            if (handled) continue;
          } catch (error) {
            logger.error("Visitor intake handling failed", {
              error: error.message,
            });
            await replyLineText(
                event.replyToken,
                "ระบบบันทึก Visitor มีปัญหาชั่วคราวครับ 🙏 " +
                "รบกวนส่งใหม่อีกครั้ง",
            );
            continue;
          }
        }

        if (data.groupId || data.roomId || data.userId) {
          await db.doc(LINE_CONFIG_PATH).set(data, {merge: true});
          logger.info("Stored LINE target", data);
        }
      }

      res.status(200).json({ok: true});
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

      logger.info("Visitor intake cleanup complete", {
        imageDocs: staleImagesSnap.size,
        metadataDocs: metadataSnap.size,
        sessions: sessionsSnap.size,
      });
    },
);

// How long an incomplete session must sit quiet before we nudge the guard,
// and how old before we treat it as abandoned and stop nudging.
const VISITOR_INTAKE_REMINDER_QUIET_MS = 45 * 1000;
const VISITOR_INTAKE_REMINDER_FLOOR_MS = 10 * 60 * 1000;

exports.visitorIntakeReminder = onSchedule(
    {
      schedule: "every 1 minutes",
      timeZone: "Asia/Bangkok",
      secrets: [LINE_CHANNEL_ACCESS_TOKEN],
    },
    async () => {
      const nowMs = Date.now();
      const quietBefore = admin.firestore.Timestamp.fromMillis(
          nowMs - VISITOR_INTAKE_REMINDER_QUIET_MS);
      const floor = nowMs - VISITOR_INTAKE_REMINDER_FLOOR_MS;
      // Single inequality on updatedAt keeps this index-free; status and the
      // floor/reminder checks are applied in code.
      const snap = await db.collection(VISITOR_INTAKE_COLLECTION)
          .where("updatedAt", "<=", quietBefore)
          .orderBy("updatedAt", "desc")
          .limit(50)
          .get();

      let sent = 0;
      for (const doc of snap.docs) {
        const data = doc.data() || {};
        if (data.status === "complete") continue;
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
    if (image.kind === "document" && analysis.personName) {
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
    if (image.kind === "vehicle" && analysis.vehiclePlate) {
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
    purposeText: data.purposeText || "",
    purposeCategory: data.purposeCategory || "unknown",
    status: data.status || "unknown",
    lprLinked: Boolean(data.lprLinked),
    imagesPurged: Boolean(data.imagesPurged),
    ocr: data.ocr || null,
    vehicleCapture: data.vehicleCapture || null,
    rawTexts: Array.isArray(data.rawTexts) ? data.rawTexts : [],
    images: safeImages,
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
        await verifyAdminResidentAccess(body, "admin.audit");
        const action = String(body.action || "list");

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
            `✏️ เหตุผล : ${visitorPurposeLabel(
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
          complete: records.filter((r) => r.status === "complete").length,
          pending: records.filter((r) => r.status !== "complete").length,
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

          const changedFields = Object.keys(patch).filter((key) => ![
            "house_no",
            "last_updated",
            "updatedAt",
            "updatedBy",
            "updatedByIp",
          ].includes(key));
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
      await verifyResidentPinInternal(houseNo, pin);
      const access = await getAdminAccess(houseNo);
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

        if (action === "listTargets") {
          await verifyAdminResidentAccess(body, "admin.announcements");
          const targets = await getLineTargets();
          res.status(200).json({ok: true, targets});
          return;
        }

        await validateAnnouncementRequest(body);

        const target = await resolveLineTarget(body.targetId);
        const targetId = target.targetId;

        const announcementRef = db.collection("announcements").doc();
        const media = await uploadAnnouncementImages(
            announcementRef.id,
            body.media || [],
        );
        const text = buildAnnouncementText(body);
        const messages = [
          {type: "text", text},
          ...media.map((item) => ({
            type: "image",
            originalContentUrl: item.url,
            previewImageUrl: item.url,
          })),
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
          category: String(body.category || "ทั่วไป").trim(),
          type: String(body.category || "normal").trim(),
          media,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        await announcementRef.set(record);

        res.status(200).json({
          ok: true,
          id: announcementRef.id,
          media,
        });
      } catch (error) {
        const status = error.message === "Unauthorized" ? 401 : 400;
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

        const eventKey = [
          cameraId,
          parsed.capturedAt,
          parsed.plate,
          parsed.picName,
        ].join("|");
        const eventId = crypto.createHash("sha256")
            .update(eventKey)
            .digest("hex")
            .slice(0, 40);
        await db.collection(LPR_TRAFFIC_EVENTS_COLLECTION).doc(eventId).set({
          ...parsed,
          cameraId,
          direction,
          sourceIp: req.ip || "",
          receivedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
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

exports.dailyTrafficSummary = onSchedule(
    {
      schedule: "5 0 * * *",
      timeZone: "Asia/Bangkok",
      secrets: [LINE_CHANNEL_ACCESS_TOKEN],
      memory: "512MiB",
      timeoutSeconds: 120,
    },
    async () => {
      const report = await runDailyTrafficReport(
          getYesterdayBangkokDate(),
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
        await verifyAdminResidentAccess(body, "admin.audit");
        const action = String(body.action || "run");
        if (action === "run") {
          // Optional targetId override lets admins push a test card to the
          // sandbox group (e.g. Pattra Watch) instead of the live residents
          // group. Falls back to the configured daily_traffic target.
          const report = await runDailyTrafficReport(
              body.reportDate || getYesterdayBangkokDate(),
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

exports.overnightSecuritySummary = onSchedule(
    {
      schedule: "0 7 * * *",
      timeZone: "Asia/Bangkok",
      secrets: [LINE_CHANNEL_ACCESS_TOKEN],
      memory: "512MiB",
      timeoutSeconds: 120,
    },
    async () => {
      const report = await runOvernightSecurityReport(
          getTodayBangkokDate(),
          !REPORT_PUSH_PAUSED,
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
      schedule: "0 19 * * *",
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
          19,
      );
      logger.info("guardAuditDaySummary complete", {
        reportDate: report.reportDate,
        window: report.windowLabel,
        checkedCars: report.checkedCars,
        uncheckedCars: report.uncheckedCars,
        lineSent: report.lineSent,
        pushPaused: REPORT_PUSH_PAUSED,
      });
    },
);

exports.guardAuditNightSummary = onSchedule(
    {
      schedule: "0 7 * * *",
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
          7,
      );
      logger.info("guardAuditNightSummary complete", {
        reportDate: report.reportDate,
        window: report.windowLabel,
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
                Number(body.startHour) : 0,
              Number.isFinite(Number(body.endHour)) ?
                Number(body.endHour) : 7,
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
 * GET/POST ?token=...&type=daily|night&date=YYYY-MM-DD&sendLine=true
 *   &startHour=0&endHour=7&targetId=<registered LINE target>
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
        const sendLine = String(params.sendLine || "true") !== "false";
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
              Number(params.endHour || 19),
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
          if (String(params.sandbox || "") !== "true" || !params.targetId) {
            res.status(400).json({
              ok: false,
              error: "paymentHeatmap requires sandbox=true and targetId",
            });
            return;
          }
          const data = await buildPaymentHeatmapData({
            feeType: params.feeType,
            period: params.period,
            year: params.year,
          });
          const message = buildPaymentHeatmapFlexMessage(data);
          if (sendLine) {
            await sendLinePushMessages(targetIdOverride, [message]);
          }
          res.status(200).json({
            ok: true,
            type,
            sandbox: true,
            sendLine,
            targetId: maskTargetId(targetIdOverride),
            data,
            message: sendLine ? undefined : message,
          });
          return;
        }
        let report;
        if (type === "night") {
          report = await runOvernightSecurityReport(
              date, sendLine,
              Number(params.startHour || 0),
              Number(params.endHour || 7),
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
 * @return {Promise<boolean>}
 */
async function sendAgentCShadowAlert(fingerprint, severity, message) {
  const configSnap = await db.doc(LPR_AGENT_C_CONFIG_PATH).get();
  const config = configSnap.exists ? configSnap.data() || {} : {};
  if (config.enabled !== true || config.shadowMode !== true ||
      config.testTargetId !== LPR_AGENT_C_TEST_TARGET_ID) {
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
  await sendLinePushMessages(LPR_AGENT_C_TEST_TARGET_ID, [{
    type: "text",
    text: `Agent C [${severity}]\n${message}`,
  }]);
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
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const eventSnap = await db.collection(LPR_TRAFFIC_EVENTS_COLLECTION)
      .where("capturedAtEpoch", ">=", since)
      .get();
  const latestByCamera = {};
  const latestReceivedByCamera = {};
  eventSnap.docs.forEach((docSnap) => {
    const item = docSnap.data() || {};
    const cameraId = String(item.cameraId || "");
    const receivedEpoch = item.receivedAt && item.receivedAt.toMillis ?
      item.receivedAt.toMillis() : 0;
    latestByCamera[cameraId] = Math.max(
        latestByCamera[cameraId] || 0,
        Number(item.capturedAtEpoch || 0),
    );
    latestReceivedByCamera[cameraId] = Math.max(
        latestReceivedByCamera[cameraId] || 0,
        receivedEpoch,
    );
  });
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
    const previousSnap = await ref.get();
    const previous = previousSnap.exists ? previousSnap.data() || {} : {};
    const failures = probe.ok ? 0 :
      Number(previous.consecutiveFailures || 0) + 1;
    const severity = failures >= 3 ? "critical" :
      failures >= 2 ? "warning" : "healthy";
    await ref.set({
      ...probe,
      consecutiveFailures: failures,
      severity,
      lastProbeAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(probe.ok ? {
        lastSuccessAt: admin.firestore.FieldValue.serverTimestamp(),
      } : {}),
    }, {merge: true});
    if (!probe.ok && failures >= 2) {
      await sendAgentCShadowAlert(
          `probe-${probe.cameraId}`,
          severity.toUpperCase(),
          `${probe.cameraId} probe ไม่ผ่าน ${failures} ครั้งติดต่อกัน`,
      );
    }
    if (probe.ok && Number(previous.consecutiveFailures || 0) >= 2) {
      await sendAgentCShadowAlert(
          `recovered-${probe.cameraId}`,
          "RECOVERED",
          `${probe.cameraId} กลับมาออนไลน์แล้ว`,
      );
    }
  }
  return {probes};
}

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
        const [configSnap, expected] = await Promise.all([
          db.doc(LPR_AGENT_C_CONFIG_PATH).get(),
          buildExpectedLprState(),
        ]);
        const config = configSnap.exists ? configSnap.data() || {} : {};
        if (config.enabled !== true || !shouldAgentCAudit(
            after, new Set(expected.plates))) {
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
  const [snap, configSnap, expected] = await Promise.all([
    db.collection(LPR_TRAFFIC_EVENTS_COLLECTION)
        .where("capturedAtEpoch", ">=", since)
        .get(),
    db.doc(LPR_AGENT_C_CONFIG_PATH).get(),
    buildExpectedLprState(),
  ]);
  const config = configSnap.exists ? configSnap.data() || {} : {};
  if (config.enabled !== true) return {enabled: false};
  const residentSet = new Set(expected.plates);
  const readable = snap.docs.filter((docSnap) =>
    isReadableLprEvent(docSnap.data() || {}),
  );
  const missing30m = readable.filter((docSnap) => {
    const item = docSnap.data() || {};
    return !item.imagePath && Number(item.capturedAtEpoch || now) <
      now - 30 * 60 * 1000;
  });
  const withImages = readable.filter((docSnap) => {
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
  const dayAuditSnap = await db.collection(LPR_AGENT_C_AUDITS_COLLECTION)
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
  const [eventSnap, residentSnap] = await Promise.all([
    db.collection(LPR_TRAFFIC_EVENTS_COLLECTION)
        .where("capturedAtEpoch", ">=", startEpoch)
        .where("capturedAtEpoch", "<", endEpoch)
        .get(),
    db.collection(RESIDENTS_COLLECTION).get(),
  ]);
  const residentSet = new Set();
  residentSnap.docs.forEach((docSnap) => {
    const item = docSnap.data() || {};
    normalizePlateArray(item.cars || []).forEach((plate) =>
      residentSet.add(plate),
    );
  });
  const events = eventSnap.docs.map((docSnap) => ({
    id: docSnap.id,
    ...docSnap.data(),
  }));
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

/**
 * Creates a Firestore trigger that sends LINE alerts.
 * @param {string} collectionPath
 * @param {string} issueType
 * @return {*}
 */
function createIssueNotifier(collectionPath, issueType) {
  return onDocumentCreated(
      {
        document: `${collectionPath}/{issueId}`,
        secrets: [LINE_CHANNEL_ACCESS_TOKEN],
      },
      async (event) => {
        const snap = event.data;
        if (!snap) {
          logger.warn("No snapshot data for LINE notification");
          return;
        }

        const targetId = await getLineTargetId();
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
        writeAuditLog("view", houseNo, {ip: req.ip});
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

        patch.last_updated = new Date().toISOString();
        patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        patch.updatedBy = "resident";
        patch.updatedByIp = req.ip || "";

        const changedFields = Object.keys(patch)
            .filter((key) => ![
              "last_updated",
              "updatedAt",
              "updatedBy",
              "updatedByIp",
            ].includes(key));
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
    res.status(err.status || 500).json({ok: false, error: err.message});
  }
});

exports.updateLifestyleSurvey = onRequest(async (req, res) => {
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
    res.status(err.status || 500).json({ok: false, error: err.message});
  }
});

exports.getLifestyleSurveyStats = onRequest(async (req, res) => {
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
    res.status(err.status || 500).json({ok: false, error: err.message});
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
const PP_COLLECTION = "pattra_payments";
const PP_BLOCK = "38";
const PP_FROM = "Pattra8 Pay <receipt@pattra8.com>"; // requires verified domain in Resend
const PP_MONTHS = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];

function ppHouseNum(v) {
  const m = String(v == null ? "" : v).match(/(\d+)\s*$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 68 ? n : null;
}

// --- Thai baht text -------------------------------------------------------
function ppBahtText(amount) {
  const TH = ["ศูนย์","หนึ่ง","สอง","สาม","สี่","ห้า","หก","เจ็ด","แปด","เก้า"];
  const POS = ["","สิบ","ร้อย","พัน","หมื่น","แสน","ล้าน"];
  function readInt(numStr) {
    let r = "";
    const len = numStr.length;
    for (let i = 0; i < len; i++) {
      const d = parseInt(numStr[i], 10);
      const pos = (len - i - 1) % 6;
      if (d !== 0) {
        if (pos === 1 && d === 1) r += "สิบ";
        else if (pos === 1 && d === 2) r += "ยี่สิบ";
        else if (pos === 0 && d === 1 && len > 1 && (len - i) % 6 !== 1) r += "เอ็ด";
        else r += TH[d] + POS[pos];
      }
      if (pos === 0 && i !== len - 1) r += "ล้าน";
    }
    return r;
  }
  const fixed = Math.abs(amount).toFixed(2);
  const [b, s] = fixed.split(".");
  let t = parseInt(b, 10) === 0 ? "ศูนย์บาท" : readInt(b) + "บาท";
  if (parseInt(s, 10) === 0) t += "ถ้วน";
  else t += readInt(s) + "สตางค์";
  return t;
}

function ppPeriodLabel(p) {
  if (p.feeType === "common") {
    return p.period === "H1" ? "ครึ่งปีแรก (ม.ค.–มิ.ย.)" : "ครึ่งปีหลัง (ก.ค.–ธ.ค.)";
  }
  const [y, m] = String(p.period).split("-");
  return `${PP_MONTHS[parseInt(m, 10) - 1]} ${y}`;
}

function ppMoney(n) {
  return Number(n).toLocaleString("th-TH", {minimumFractionDigits: 2});
}

function ppReceiptHtml(p) {
  const house = `${PP_BLOCK}/${p.houseNo}`;
  const dateStr = new Date(p.verifiedAt || Date.now())
      .toLocaleDateString("th-TH", {day: "numeric", month: "long", year: "numeric"});
  const fee = p.feeType === "common" ? "ค่าส่วนกลาง" : "ค่าจอดรถ";
  const amt = ppMoney(p.amount);
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ใบเสร็จรับเงิน ${p.receiptNo || ""}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sriracha&family=Cormorant+Garamond:wght@500;600;700&family=IBM+Plex+Sans+Thai:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"IBM Plex Sans Thai",system-ui,sans-serif;color:#2a2218;background:#efe7d8;padding:28px 16px;-webkit-font-smoothing:antialiased}
.num{font-family:"IBM Plex Sans Thai",system-ui,sans-serif;font-feature-settings:"lnum" 1,"tnum" 1}
.doc{max-width:560px;margin:0 auto;background:#fff;border-radius:22px;overflow:hidden;box-shadow:0 20px 50px rgba(80,60,30,.14)}
.bar{height:6px;background:linear-gradient(90deg,#d4913f,#c47a2c)}
.brand{padding:28px 30px 0;text-align:center}
.wm{font-family:"Cormorant Garamond",serif;font-size:40px;font-weight:600;letter-spacing:.05em;color:#2a2218;line-height:1}
.wmsub{font-size:14.5px;color:#6b5d4a;margin-top:7px}
.doctitle{width:100%;border-collapse:collapse}
.doctitle .rule{border-bottom:1px solid #e6dcc7;width:50%;font-size:0;line-height:0}
.doctitle .ttl{white-space:nowrap;padding:0 14px;text-align:center;font-size:18px;font-weight:600;letter-spacing:.3em;color:#c47a2c}
.docmeta{margin:13px 30px 0;text-align:center;font-size:13.5px;color:#6b5d4a}
.paid{display:inline-block;background:#e2ecd6;color:#4a6238;font-size:12.5px;font-weight:600;padding:5px 13px;border-radius:999px;white-space:nowrap;margin-right:8px}
.rno2 b{color:#2a2218;font-weight:600}
.hero{padding:20px 30px 16px;text-align:center}
.hero .l{font-size:14.5px;color:#6b5d4a;letter-spacing:.01em}
.hero .h{font-size:46px;font-weight:700;color:#2a2218;line-height:1.05;margin:6px 0 4px;letter-spacing:.01em}
.hero .p{font-size:14px;color:#6b5d4a}
.amtline{margin:0 30px;background:#faf6ee;border:1px solid #efe6d4;border-radius:14px;padding:16px 22px}
.amtline table{width:100%;border-collapse:collapse}
.amtline .k{font-size:14px;color:#6b5d4a;text-align:left;vertical-align:middle}
.amtline .v{font-size:28px;font-weight:700;color:#c47a2c;line-height:1;white-space:nowrap;text-align:right;vertical-align:middle}
.words{margin:10px 30px 0;font-size:13.5px;color:#6b5d4a;font-style:italic;text-align:center}
.klist{margin:16px 30px 0}
.krow{width:100%;border-collapse:collapse}
.krow td{padding:10px 0;border-bottom:1px solid #efe6d4;font-size:14px;vertical-align:top}
.krow td.k{color:#6b5d4a;white-space:nowrap}
.krow td.v{color:#2a2218;font-weight:500;text-align:right;padding-left:24px}
.foot{margin:14px 30px 26px;padding-top:14px;border-top:1px solid #efe6d4}
.foot table{width:100%;border-collapse:collapse}
.foot .note{font-size:11.5px;color:#6b5d4a;line-height:1.6;text-align:left;vertical-align:bottom}
.foot .signcell{text-align:right;vertical-align:bottom;white-space:nowrap}
.sign{display:inline-block;text-align:center}
.sign .sig{font-family:"Sriracha",cursive;font-size:19px;color:#2a2218;line-height:1.2;white-space:nowrap}
.sign .line{border-top:1px solid #c9b89c;margin:3px 0 4px}
.sign .cap{font-size:10.5px;color:#9a8b75}
.fine{padding:16px 30px 24px;font-size:10px;color:#b9a98f;text-align:center}
@media print{body{background:#fff;padding:0}.doc{box-shadow:none;border-radius:0}}</style></head>
<body><div class="doc">
<div class="bar"></div>
<div class="brand"><div class="wm">Pattra Villa 8</div><div class="wmsub">นิติบุคคล ภัทราวิลล่า 8</div></div>
<div style="padding:20px 30px 0"><table class="doctitle" role="presentation" cellpadding="0" cellspacing="0"><tr><td class="rule"></td><td class="ttl">ใบเสร็จรับเงิน</td><td class="rule"></td></tr></table></div>
<div class="docmeta"><span class="paid">✓ ชำระแล้ว</span>${p.receiptNo ? `<span class="rno2"><b class="num">${p.receiptNo}</b></span>` : ""}</div>
<div class="hero"><div class="l">${fee} · บ้านเลขที่</div><div class="h num">${PP_BLOCK} / ${p.houseNo}</div><div class="p">${ppPeriodLabel(p)} · ปี ${p.year}</div></div>
<div class="amtline"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td class="k">จำนวนเงินที่ได้รับ</td><td class="v num">฿${amt}</td></tr></table></div>
<div class="words">(${ppBahtText(p.amount)})</div>
<div class="klist">
<table class="krow" role="presentation" cellpadding="0" cellspacing="0"><tr><td class="k">ผู้ชำระ</td><td class="v">${p.payerName || "บ้าน " + house}</td></tr></table>
<table class="krow" role="presentation" cellpadding="0" cellspacing="0"><tr><td class="k">วันที่</td><td class="v">${dateStr}</td></tr></table>
<table class="krow" role="presentation" cellpadding="0" cellspacing="0"><tr><td class="k">โอนผ่าน</td><td class="v">ธนาคารไทยพาณิชย์ (SCB)</td></tr></table>
</div>
<div class="foot"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td class="note">ได้รับเงินไว้เป็นการถูกต้องแล้ว</td>
<td class="signcell"><div class="sign"><div class="sig">กรรมการนิติบุคคล ชุด 5</div><div class="line"></div><div class="cap">ผู้รับเงิน</div></div></td></tr></table></div>
</div></body></html>`;
}

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
            "as payerName. Use visible evidence " +
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
            confidence: {type: "NUMBER"},
          },
          required: ["houseNo", "amount", "bank", "payerName", "confidence"],
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

exports.pattraPay = onRequest(
    {secrets: [LPR_ADMIN_PASSWORD, RESEND_API_KEY]},
    async (req, res) => {
      setCorsHeaders(req, res);
      if (req.method === "OPTIONS") { res.status(204).send(""); return; }
      if (req.method !== "POST") { res.status(405).json({ok: false, error: "Method Not Allowed"}); return; }

      try {
        const body = req.body || {};
        const action = String(body.action || "").trim();

        // -------- public: submit a payment ---------------------------------
        if (action === "submitPayment") {
          const houseNo = ppHouseNum(body.houseNo);
          const feeType = String(body.feeType || "");
          const period = String(body.period || "");
          const year = parseInt(body.year, 10);
          const amount = Number(body.amount);
          if (!houseNo) throw Object.assign(new Error("บ้านเลขที่ไม่ถูกต้อง"), {status: 400});
          if (feeType !== "common" && feeType !== "parking") throw Object.assign(new Error("ประเภทไม่ถูกต้อง"), {status: 400});
          if (!period) throw Object.assign(new Error("ไม่ระบุงวด"), {status: 400});
          if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error("ยอดเงินไม่ถูกต้อง"), {status: 400});

          let slipUrl = "";
          const slip = ppParseSlip(body.slipDataUrl);
          if (slip) {
            if (slip.buffer.length > 10 * 1024 * 1024) throw Object.assign(new Error("ไฟล์สลิปใหญ่เกิน 10MB"), {status: 400});
            const ref = db.collection(PP_COLLECTION).doc();
            const ext = slip.contentType.split("/")[1] || "jpg";
            const path = `pattra-slips/${ref.id}.${ext}`;
            const token = crypto.randomUUID();
            const bucket = admin.storage().bucket();
            await bucket.file(path).save(slip.buffer, {
              resumable: false,
              metadata: {contentType: slip.contentType, metadata: {firebaseStorageDownloadTokens: token}},
            });
            slipUrl = "https://firebasestorage.googleapis.com/v0/b/" +
              `${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
            const payload = {
              houseNo, feeType, period, year, amount,
              payerName: "", email: String(body.email || "").trim(),
              slipUrl, status: "pending",
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            };
            await ref.set(payload);
            res.status(200).json({ok: true, id: ref.id});
            return;
          }
          // no slip
          const payload = {
            houseNo, feeType, period, year, amount,
            payerName: "", email: String(body.email || "").trim(),
            slipUrl: "", status: "pending",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          const ref = await db.collection(PP_COLLECTION).add(payload);
          res.status(200).json({ok: true, id: ref.id});
          return;
        }

        // -------- public: status board (house numbers only, no PII) --------
        if (action === "publicStatus") {
          const snap = await db.collection(PP_COLLECTION)
              .where("status", "in", ["verified", "pending"]).get();
          const status = {common: {}, parking: {}};
          const pending = {common: {}, parking: {}};
          snap.docs.forEach((doc) => {
            const d = doc.data() || {};
            const target = d.status === "verified" ? status : pending;
            const bucket = d.feeType === "common" ? target.common : target.parking;
            const key = d.feeType === "common" ? `${d.year}:${d.period}` : d.period;
            if (!bucket[key]) bucket[key] = [];
            if (!bucket[key].includes(d.houseNo)) bucket[key].push(d.houseNo);
          });
          res.status(200).json({ok: true, status, pending});
          return;
        }

        // -------- admin: list all payments (PII) ---------------------------
        if (action === "adminList") {
          await verifyAdminResidentAccess(body);
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
          const period = ppCleanImportText(body.period, 20);
          const year = parseInt(body.year, 10);
          const amount = Number(body.amount);
          if (!houseNo) throw Object.assign(new Error("บ้านเลขที่ไม่ถูกต้อง"), {status: 400});
          if (feeType !== "common" && feeType !== "parking") throw Object.assign(new Error("ประเภทไม่ถูกต้อง"), {status: 400});
          if (!period) throw Object.assign(new Error("ไม่ระบุงวด"), {status: 400});
          if (!Number.isFinite(year)) throw Object.assign(new Error("ปีไม่ถูกต้อง"), {status: 400});
          if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error("ยอดเงินไม่ถูกต้อง"), {status: 400});
          if (!ppParseSlip(body.slipDataUrl)) throw Object.assign(new Error("ไม่มีรูปสลิป"), {status: 400});

          // Single-field query (no composite index needed) + in-memory filter —
          // a house has at most a handful of payment rows, so this is cheap.
          const houseSnap = await db.collection(PP_COLLECTION).where("houseNo", "==", houseNo).get();
          const dupDocs = houseSnap.docs.filter((d) => {
            const dd = d.data();
            return dd.feeType === feeType && dd.period === period && dd.year === year &&
              (dd.status === "pending" || dd.status === "verified");
          });
          if (dupDocs.length && body.confirmDuplicate !== true) {
            const existing = dupDocs.map((d) => ({id: d.id, amount: d.data().amount, status: d.data().status}));
            res.status(200).json({ok: true, duplicate: true, existing});
            return;
          }

          const ref = db.collection(PP_COLLECTION).doc();
          const slipUrl = await ppUploadSlipDataUrl(ref.id, body.slipDataUrl);
          await ref.set({
            houseNo, feeType, period, year, amount,
            payerName: ppCleanImportText(body.payerName, 160),
            email: "", slipUrl, status: "pending", source: "admin_upload",
            bank: ppCleanImportText(body.bank, 80),
            transactionRef: ppCleanImportText(body.transactionRef, 120),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          res.status(200).json({ok: true, duplicate: false, id: ref.id});
          return;
        }

        // -------- admin: patch pending payment metadata -------------------
        // Used when OCR improves after upload. Only safe metadata fields are
        // patchable; this never verifies, deletes, or changes money fields.
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

          const seq = await db.runTransaction(async (tx) => {
            const cRef = db.doc("pattra_counters/receipts");
            const cSnap = await tx.get(cRef);
            const next = ((cSnap.exists ? cSnap.data().value : 0) || 0) + 1;
            tx.set(cRef, {value: next}, {merge: true});
            return next;
          });

          const snap = await ref.get();
          if (!snap.exists) throw Object.assign(new Error("ไม่พบรายการ"), {status: 404});
          const d = snap.data();

          // resolve resident name + email from residents collection.
          // Admin-picked name/email override the slip/resident defaults.
          const overrideName = typeof body.payerName === "string" ? body.payerName.trim() : "";
          const overrideEmail = typeof body.receiptEmail === "string" ? body.receiptEmail.trim() : "";
          let name = overrideName || d.payerName || "";
          let email = overrideEmail || d.email || "";
          try {
            const rSnap = await db.collection(RESIDENTS_COLLECTION).get();
            rSnap.docs.forEach((rd) => {
              const r = rd.data() || {};
              if (ppHouseNum(r.house_no || r.houseNo) === d.houseNo) {
                if (!name) name = r.name || "";
                if (!email) email = r.email || "";
              }
            });
          } catch (e) { logger.warn("resident resolve failed", e); }

          const receiptNo = `RC-${d.year}-${String(seq).padStart(4, "0")}`;
          const now = Date.now();
          const rec = {
            houseNo: d.houseNo, feeType: d.feeType, period: d.period, year: d.year,
            amount: d.amount, payerName: name, email, receiptNo, verifiedAt: now,
          };
          const html = ppReceiptHtml(rec);
          const mail = await ppSendEmail(
              email,
              `ใบเสร็จรับเงิน ${receiptNo} · ${d.feeType === "common" ? "ค่าส่วนกลาง" : "ค่าจอดรถ"} (${PP_BLOCK}/${d.houseNo})`,
              html,
          );

          await ref.update({
            status: "verified",
            payerName: name,
            email,
            receiptNo,
            receiptHtml: html,
            verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
            receiptSentAt: mail.sent ? admin.firestore.FieldValue.serverTimestamp() : null,
            emailStatus: mail.sent ? "sent" : `not-sent:${mail.reason}`,
          });

          res.status(200).json({ok: true, receiptNo, emailSent: mail.sent, emailReason: mail.reason || null, receiptHtml: html});
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
// Pure Visitor Intake helpers exported for unit tests (functions/test/).
// These are side-effect-free; the export adds no runtime behaviour.
// ===========================================================================
module.exports.__visitorTest = {
  getCarQuota,
  mapVisitorPurposeCategory,
  visitorPurposeLabel,
  parseVisitorIntakeText,
  cleanVisitorPurposeText,
  normalizeVisitorPlate,
  normalizeVisitorVehicleType,
  normalizeDocumentNumber,
  getVisitorIntakeStatus,
  shouldStartNewVisitorLog,
  shouldStartNewVisitorImageLog,
  buildVisitorIntakeReply,
  visitorIntakeImageUrl,
  getTargetIdFromSource,
};
