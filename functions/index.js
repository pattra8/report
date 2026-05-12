const crypto = require("crypto");

const admin = require("firebase-admin");
const {setGlobalOptions} = require("firebase-functions/v2");
const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {onRequest} = require("firebase-functions/v2/https");
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
const GH_TOKEN_SECRET = defineSecret("GH_TOKEN");

const LINE_CONFIG_PATH = "system_config/line";
const RESIDENT_SHEET_ID = "1NU6B7Yf225JGOpgqmQVLrHJl2tvxPtRR1gbtmBjYZyo";
const RESIDENT_SHEET_RANGE = "Residents!A:G";
const RESIDENT_ADMIN_PASSWORD = "PATTRADATA";
const ADMIN_PASSWORDS = new Set(["nitipattra8", "team388"]);
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
const GITHUB_RESIDENT_PATH = "data/residents.json";
const RESIDENT_PIN_COLLECTION = "resident_pins";
const RESIDENTS_COLLECTION = "residents";
const AUDIT_LOG_COLLECTION = "audit_log";
const POLLS_COLLECTION = "polls";
const RESIDENT_SIGNATURE_COLLECTION = "resident_signatures";
const FORGOT_PIN_RATE_LIMIT = 20;
const FORGOT_PIN_WINDOW_MS = 60 * 60 * 1000;
const MAX_SIGNATURE_DATA_URL_BYTES = 350 * 1024;
const LPR_CAMERAS = [
  "http://lpr.pattra8.com:8241",
  "http://lpr.pattra8.com:8242",
];
const LPR_USER = "admin";

// ── Car quota ────────────────────────────────────────────────────────────────
const CAR_QUOTA_DEFAULT = 2;
const CAR_QUOTA_EXTRA = 3;
// บ้านที่เช่าที่จอดรถโครงการคันที่ 3 → quota 3
const CAR_QUOTA_3_HOUSES = new Set([
  "38/3", "38/8", "38/15", "38/20", "38/21",
  "38/35", "38/43", "38/45", "38/67",
]);

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
 * Validates the admin password supplied by the PR page.
 * @param {Object} body
 * @return {void}
 */
function validateAdminPassword(body) {
  if (!ADMIN_PASSWORDS.has(String(body.adminPassword || ""))) {
    throw new Error("Unauthorized");
  }
}

/**
 * Validates the PR announcement send request.
 * @param {Object} body
 * @return {void}
 */
function validateAnnouncementRequest(body) {
  validateAdminPassword(body);

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
      .map((item) => item.replace(/[\s-]/g, "").trim())
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
 * Houses renting a 3rd project parking spot get quota=3; all others get 2.
 * @param {string} houseNo
 * @return {number}
 */
function getCarQuota(houseNo) {
  return CAR_QUOTA_3_HOUSES.has(normalizeHouseNo(houseNo)) ?
    CAR_QUOTA_EXTRA :
    CAR_QUOTA_DEFAULT;
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
  const first = await fetch(url, {method});

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
 * Verifies that the submitted GitHub token can read the resident data repo.
 * @param {string} token
 * @return {Promise<void>}
 */
async function validateGithubToken(token) {
  const cleanToken = String(token || "").trim();
  if (!cleanToken) {
    throw new Error("Missing GitHub token");
  }

  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}` +
    `/contents/${GITHUB_RESIDENT_PATH}`;
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

  for (const camera of LPR_CAMERAS) {
    const cameraResult = {camera, added: [], removed: [], errors: []};

    for (const plate of toAdd) {
      try {
        cameraResult.added.push(await lprAddPlate(camera, plate));
      } catch (error) {
        cameraResult.errors.push({
          plate,
          action: "add",
          error: error.message,
        });
      }
    }

    for (const plate of toRemove) {
      try {
        cameraResult.removed.push(await lprRemovePlate(camera, plate));
      } catch (error) {
        cameraResult.errors.push({
          plate,
          action: "remove",
          error: error.message,
        });
      }
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

exports.lineWebhook = onRequest(
    {
      secrets: [LINE_CHANNEL_SECRET],
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

        if (data.groupId || data.roomId || data.userId) {
          await db.doc(LINE_CONFIG_PATH).set(data, {merge: true});
          logger.info("Stored LINE target", data);
        }
      }

      res.status(200).json({ok: true});
    },
);

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
    if (body.password !== RESIDENT_ADMIN_PASSWORD) {
      res.status(401).json({ok: false, error: "Unauthorized"});
      return;
    }

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

exports.residentPinAuth = onRequest(async (req, res) => {
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

    if (action === "bootstrapResidentData") {
      if (body.adminPassword !== RESIDENT_ADMIN_PASSWORD) {
        res.status(401).json({ok: false, error: "Unauthorized"});
        return;
      }
      const residents = Array.isArray(body.residents) ? body.residents : [];
      if (!residents.length) {
        res.status(400).json({ok: false, error: "Missing residents array"});
        return;
      }
      const batch = db.batch();
      for (const r of residents) {
        const rHouseNo = normalizeHouseNo(r.house_no);
        if (!rHouseNo) continue;
        const docRef = db
            .collection(RESIDENTS_COLLECTION)
            .doc(residentPinDocId(rHouseNo));
        batch.set(docRef, {
          house_no: rHouseNo,
          name: r.name || "",
          email: r.email || "",
          phone: r.phone || "",
          deed_no: r.deed_no || "",
          zone: r.zone || "",
          plot: r.plot || "",
          cars: Array.isArray(r.cars) ? r.cars : [],
          motorcycles: Array.isArray(r.motorcycles) ? r.motorcycles : [],
          last_updated: r.last_updated || "",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
      }
      await batch.commit();
      res.status(200).json({ok: true, count: residents.length});
      return;
    }

    if (action === "bootstrap") {
      if (body.adminPassword !== RESIDENT_ADMIN_PASSWORD) {
        res.status(401).json({ok: false, error: "Unauthorized"});
        return;
      }

      const rawUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/` +
        `${GITHUB_REPO}/main/${GITHUB_RESIDENT_PATH}`;
      const response = await fetch(`${rawUrl}?t=${Date.now()}`);
      if (!response.ok) {
        throw new Error(`Resident data fetch failed (${response.status})`);
      }

      const residents = await response.json();
      const batch = db.batch();
      const created = [];
      const skipped = [];

      for (const resident of residents) {
        const residentHouseNo = normalizeHouseNo(resident.house_no);
        if (!residentHouseNo) continue;

        const docRef = db
            .collection(RESIDENT_PIN_COLLECTION)
            .doc(residentPinDocId(residentHouseNo));
        const doc = await docRef.get();
        if (doc.exists && !body.force) {
          skipped.push(residentHouseNo);
          continue;
        }

        const pin = generateResidentPin();
        const salt = crypto.randomBytes(16).toString("hex");
        batch.set(docRef, {
          houseNo: residentHouseNo,
          pinHash: hashResidentPin(pin, salt),
          salt,
          changedByResident: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
        created.push({houseNo: residentHouseNo, pin});
      }

      await batch.commit();
      res.status(200).json({ok: true, created, skipped});
      return;
    }

    if (action === "adminAuditLogs") {
      if (body.adminPassword !== RESIDENT_ADMIN_PASSWORD) {
        res.status(401).json({ok: false, error: "Unauthorized"});
        return;
      }
      const limit = Math.min(Math.max(Number(body.limit || 80), 1), 200);
      const snap = await db.collection(AUDIT_LOG_COLLECTION)
          .orderBy("ts", "desc")
          .limit(limit)
          .get();
      res.status(200).json({
        ok: true,
        logs: snap.docs.map((doc) => ({id: doc.id, ...doc.data()})),
      });
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

    if (action === "adminReset") {
      await validateGithubToken(body.githubToken);
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
      res.status(200).json({ok: true, houseNo: data.houseNo || houseNo, pin});
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

      let resident = null;
      if (residentDocSnap.exists) {
        resident = residentDocSnap.data();
      } else {
        // Fallback to GitHub raw URL during migration window
        const rawUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/` +
          `${GITHUB_REPO}/main/${GITHUB_RESIDENT_PATH}`;
        const response = await fetch(`${rawUrl}?t=${Date.now()}`);
        if (response.ok) {
          const residents = await response.json();
          resident = residents.find((item) =>
            normalizeHouseNo(item.house_no) === houseNo) || null;
        }
      }

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
    const status = /PIN must|Missing|Unknown/i.test(error.message) ? 400 : 500;
    res.status(status).json({ok: false, error: error.message});
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
          validateAdminPassword(body);
          const targets = await getLineTargets();
          res.status(200).json({ok: true, targets});
          return;
        }

        validateAnnouncementRequest(body);

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

        res.status(result.ok ? 200 : 207).json(result);
      } catch (error) {
        const status = /token|Unauthorized/i.test(error.message) ? 401 : 500;
        logger.error("lprPlateSync failed", error);
        res.status(status).json({ok: false, error: error.message});
      }
    },
);

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
          const quota = getCarQuota(houseNo);
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

        await docRef.set(patch, {merge: true});

        let lprSync = null;
        if (touchesCars) {
          const allResidentsSnap = await db
              .collection(RESIDENTS_COLLECTION)
              .get();
          const allCars = [];
          allResidentsSnap.docs.forEach((residentDoc) => {
            const item = residentDoc.data() || {};
            normalizePlateArray(item.cars).forEach((plate) =>
              allCars.push(plate),
            );
          });
          lprSync = await syncLprCarDiff({
            houseNo,
            oldCars: oldData.cars || [],
            newCars: patch.cars || [],
            allCars,
          });
        }

        const changedFields = Object.keys(patch)
            .filter((key) => ![
              "last_updated",
              "updatedAt",
              "updatedBy",
              "updatedByIp",
            ].includes(key));
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

        res.status(lprSync && !lprSync.ok ? 207 : 200).json({
          ok: !(lprSync && !lprSync.ok),
          houseNo,
          updated: changedFields,
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
      const isAdmin = () =>
        body.adminPassword === RESIDENT_ADMIN_PASSWORD;

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
          if (!isAdmin()) {
            return res.status(403).json({ok: false, error: "Forbidden"});
          }
          const {poll} = body;
          if (!poll || !poll.title) {
            return res.status(400).json(
                {ok: false, error: "Missing poll title"});
          }

          const deadline = poll.deadline ?
            admin.firestore.Timestamp.fromDate(new Date(poll.deadline)) : null;

          // ── Phase 2: multi-question survey ──────────────────────────────
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
          if (!isAdmin()) {
            return res.status(403).json({ok: false, error: "Forbidden"});
          }
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
          if (!isAdmin()) {
            return res.status(403).json({ok: false, error: "Forbidden"});
          }
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
              // no choice needed — just record the acknowledgment
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

          await voteRef.set({
            houseNo: normalizedHouseNo,
            ...(poll.mode === "survey" ? {answers} : {choice}),
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
          const snap = await db.collection(POLLS_COLLECTION)
              .orderBy("createdAt", "desc")
              .limit(50)
              .get();
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
            votes,
          });
        }

        // ── results (closed OR admin) ───────────────────────────────────
        if (action === "results") {
          const {pollId} = body;
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
          if (!closed && !isAdmin()) {
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
            votes: isAdmin() ? voteRows : undefined,
          });
        }

        return res.status(400).json({ok: false, error: "Unknown action"});
      } catch (err) {
        logger.error("pollAction failed", err);
        res.status(err.status || 500).json({ok: false, error: err.message});
      }
    },
);
