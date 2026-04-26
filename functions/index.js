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

/**
 * Applies permissive CORS headers for static GitHub Pages admin requests.
 * @param {*} res
 * @return {void}
 */
function setCorsHeaders(res) {
  res.set("Access-Control-Allow-Origin", "https://pattra8.github.io");
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
  setCorsHeaders(res);

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

exports.broadcastLineAnnouncement = onRequest(
    {
      secrets: [LINE_CHANNEL_ACCESS_TOKEN],
      memory: "512MiB",
      timeoutSeconds: 60,
    },
    async (req, res) => {
      setCorsHeaders(res);

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
