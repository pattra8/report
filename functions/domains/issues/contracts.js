"use strict";

// Estate Issues (pattra8.com/report) domain contracts.
//
// Everything here is pure: no Firestore, no Storage, no network. The
// composition root in functions/index.js wires these helpers to the
// `estateIssues` export.
//
// Two invariants this module protects, both requested explicitly by the estate
// committee and easy to break by accident later:
//
// 1. Anonymity. A resident must log in before reporting, so the system always
//    knows the house. When the report is filed anonymously the house number
//    must never reach a committee member — not even the chair — so every
//    admin-facing projection goes through redactIssueForAdmin().
// 2. LINE containment. New reports may only ever be announced in the
//    "Pattra Watch" sandbox group, and the notice must not carry the reporter's
//    identity or their free text, because that would leak an anonymous report
//    into a chat room.

const ISSUE_CATEGORIES = Object.freeze([
  Object.freeze({key: "common_area", label: "🏡 พื้นที่ส่วนกลาง"}),
  Object.freeze({key: "pool", label: "🏊 สระว่ายน้ำ"}),
  Object.freeze({key: "fitness", label: "🏋️ ฟิตเนส"}),
  Object.freeze({key: "garden", label: "🌳 สวน"}),
  Object.freeze({key: "security", label: "🛡️ ความปลอดภัย"}),
  Object.freeze({key: "cleanliness", label: "🧹 ความสะอาด"}),
  Object.freeze({key: "traffic", label: "🚗 จราจร / ที่จอดรถ"}),
  Object.freeze({key: "utility", label: "💡 ไฟฟ้า / ประปา"}),
  Object.freeze({key: "noise", label: "🔊 เสียง / ความเป็นส่วนตัว"}),
  Object.freeze({key: "suggestion", label: "📝 ข้อเสนอแนะ"}),
  // Renamed from the original "ติชม" (feedback); the committee asked for
  // wording softer than "ร้องเรียน" (formal complaint) while the key stays
  // `feedback` so archived tickets keep matching.
  Object.freeze({key: "feedback", label: "💬 ข้อกังวล"}),
  Object.freeze({key: "other", label: "💭 อื่น ๆ"}),
]);

const ISSUE_STATUSES = Object.freeze([
  Object.freeze({key: "new", label: "เรื่องใหม่"}),
  Object.freeze({key: "in_progress", label: "กำลังดำเนินการ"}),
  Object.freeze({key: "resolved", label: "ดำเนินการแล้ว"}),
  Object.freeze({key: "closed", label: "ปิดเรื่อง"}),
]);

const ISSUE_PRIORITIES = Object.freeze([
  Object.freeze({key: "normal", label: "ปกติ"}),
  Object.freeze({key: "high", label: "เร่งด่วน"}),
  Object.freeze({key: "urgent", label: "ด่วนมาก"}),
]);

const ISSUE_TITLE_MAX = 120;
const ISSUE_DETAIL_MAX = 4000;
const ISSUE_COMMENT_MAX = 2000;
const ISSUE_INTERNAL_NOTE_MAX = 2000;

const ANONYMOUS_LABEL = "ไม่ประสงค์ออกนาม";
const ADMIN_AUTHOR_LABEL = "กรรมการ";

// Cloud Run caps a request at 32MB, so uploads are posted one file per request
// and stay well under that ceiling even after base64 inflates them by ~33%.
const ISSUE_ATTACHMENT_LIMITS = Object.freeze({
  maxImages: 5,
  maxVideos: 1,
  maxImageBytes: 6 * 1024 * 1024,
  maxVideoBytes: 20 * 1024 * 1024,
});

const ISSUE_IMAGE_TYPES = Object.freeze({
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
});

const ISSUE_VIDEO_TYPES = Object.freeze({
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
});

// A house may file this many reports per rolling 24h window. Generous for a
// real complaint, tight enough that a stuck client cannot flood the board.
const ISSUE_DAILY_SUBMIT_LIMIT = 10;

/**
 * Builds a client error carrying the legacy HTTP status.
 * @param {string} message Thai message shown to the caller.
 * @param {number} status HTTP status code.
 * @return {Error}
 */
function issueError(message, status) {
  const err = new Error(message);
  err.status = status || 400;
  return err;
}

/**
 * Collapses whitespace and trims a free-text field to its maximum length.
 * @param {*} value Raw value from the request body.
 * @param {number} max Maximum retained characters.
 * @return {string}
 */
function normalizeIssueText(value, max) {
  const text = String(value === undefined || value === null ? "" : value)
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  return max > 0 ? text.slice(0, max) : text;
}

/**
 * Resolves a category key, defaulting to "other" for anything unknown.
 * @param {*} value Raw category.
 * @return {string}
 */
function normalizeIssueCategory(value) {
  const key = String(value || "").trim();
  const found = ISSUE_CATEGORIES.find((item) => item.key === key);
  return found ? found.key : "other";
}

/**
 * Resolves a status key, defaulting to "new".
 * @param {*} value Raw status.
 * @return {string}
 */
function normalizeIssueStatus(value) {
  const key = String(value || "").trim();
  const found = ISSUE_STATUSES.find((item) => item.key === key);
  return found ? found.key : "new";
}

/**
 * Resolves a priority key, defaulting to "normal".
 * @param {*} value Raw priority.
 * @return {string}
 */
function normalizeIssuePriority(value) {
  const key = String(value || "").trim();
  const found = ISSUE_PRIORITIES.find((item) => item.key === key);
  return found ? found.key : "normal";
}

/**
 * Looks up a Thai label from one of the frozen option lists.
 * @param {ReadonlyArray<{key: string, label: string}>} options Option list.
 * @param {string} key Option key.
 * @return {string}
 */
function optionLabel(options, key) {
  const found = options.find((item) => item.key === key);
  return found ? found.label : key;
}

/**
 * @param {string} key Category key.
 * @return {string} Thai category label.
 */
function issueCategoryLabel(key) {
  return optionLabel(ISSUE_CATEGORIES, normalizeIssueCategory(key));
}

/**
 * @param {string} key Status key.
 * @return {string} Thai status label.
 */
function issueStatusLabel(key) {
  return optionLabel(ISSUE_STATUSES, normalizeIssueStatus(key));
}

/**
 * Resident-facing status language describes what they can trust happened,
 * without exposing the committee's internal queue terminology. Feedback and
 * suggestions end as acknowledged; operational reports end as completed.
 *
 * @param {string} status Status key.
 * @param {string} category Category key.
 * @return {string} Thai resident-facing status label.
 */
function residentIssueStatusLabel(status, category) {
  const normalized = normalizeIssueStatus(status);
  if (normalized === "new") return "ส่งถึงกรรมการแล้ว";
  if (normalized === "in_progress") return "กำลังดูแล";
  const acknowledgement = category === "suggestion" || category === "feedback";
  return acknowledgement ? "รับทราบแล้ว" : "ดำเนินการแล้ว";
}

/**
 * Residents may correct report content only while the case is still live.
 * Conversation replies remain a separate channel and may reopen a closed case.
 *
 * @param {string} status Status key.
 * @return {boolean} Whether resident-owned content is editable.
 */
function isResidentIssueEditable(status) {
  const normalized = normalizeIssueStatus(status);
  return normalized !== "resolved" && normalized !== "closed";
}

/**
 * @param {string} key Priority key.
 * @return {string} Thai priority label.
 */
function issuePriorityLabel(key) {
  return optionLabel(ISSUE_PRIORITIES, normalizeIssuePriority(key));
}

/**
 * Returns the Buddhist-era year used in the ticket code.
 * @param {Date} date Reference date.
 * @return {number}
 */
function issueBuddhistYear(date) {
  const bangkok = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return bangkok.getUTCFullYear() + 543;
}

/**
 * Formats a ticket code such as "PT-2569-0007".
 * @param {number} buddhistYear Buddhist-era year.
 * @param {number} sequence Per-year sequence number.
 * @return {string}
 */
function formatIssueCode(buddhistYear, sequence) {
  const seq = Math.max(1, Math.floor(Number(sequence) || 1));
  const padded = seq < 10000 ? String(seq).padStart(4, "0") : String(seq);
  return `PT-${buddhistYear}-${padded}`;
}

/**
 * Validates a resident submission and returns the stored command shape.
 * @param {Object} body Raw request body.
 * @return {{
 *   title: string,
 *   detail: string,
 *   category: string,
 *   priority: string,
 *   anonymous: boolean,
 * }}
 */
function buildIssueSubmission(body) {
  const source = body || {};
  const title = normalizeIssueText(source.title, ISSUE_TITLE_MAX);
  const detail = normalizeIssueText(source.detail, ISSUE_DETAIL_MAX);

  if (!title) throw issueError("กรุณาระบุหัวข้อเรื่อง", 400);
  if (title.length < 3) throw issueError("หัวข้อเรื่องสั้นเกินไป", 400);
  if (!detail) throw issueError("กรุณาระบุรายละเอียด", 400);

  return {
    title,
    detail,
    category: normalizeIssueCategory(source.category),
    priority: normalizeIssuePriority(source.priority),
    anonymous: source.anonymous === true || source.anonymous === "true",
  };
}

/**
 * Decodes a base64 data URL upload and enforces the per-kind size limits.
 * @param {*} dataUrl Data URL posted by the report page.
 * @return {{
 *   buffer: Buffer,
 *   contentType: string,
 *   extension: string,
 *   kind: string,
 *   bytes: number,
 * }}
 */
function parseIssueUpload(dataUrl) {
  const raw = String(dataUrl || "");
  const match = raw.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
  if (!match) throw issueError("ไฟล์แนบไม่ถูกต้อง", 400);

  const contentType = match[1].toLowerCase();
  const imageExtension = ISSUE_IMAGE_TYPES[contentType];
  const videoExtension = ISSUE_VIDEO_TYPES[contentType];
  if (!imageExtension && !videoExtension) {
    throw issueError("รองรับเฉพาะรูป JPG/PNG/WebP และวิดีโอ MP4/MOV/WebM", 400);
  }

  const buffer = Buffer.from(match[2], "base64");
  const bytes = buffer.length;
  if (!bytes) throw issueError("ไฟล์แนบเสียหาย", 400);

  const kind = imageExtension ? "image" : "video";
  const maxBytes = kind === "image" ?
    ISSUE_ATTACHMENT_LIMITS.maxImageBytes :
    ISSUE_ATTACHMENT_LIMITS.maxVideoBytes;
  if (bytes > maxBytes) {
    throw issueError(
        kind === "image" ? "รูปมีขนาดใหญ่เกินไป" : "วิดีโอยาวหรือใหญ่เกินไป",
        400,
    );
  }

  return {
    buffer,
    contentType: contentType === "image/jpg" ? "image/jpeg" : contentType,
    extension: imageExtension || videoExtension,
    kind,
    bytes,
  };
}

/**
 * Enforces the per-issue attachment counts.
 * @param {Array<Object>} attachments Attachments already stored on the issue.
 * @param {string} kind "image" or "video".
 * @return {void}
 */
function assertAttachmentSlotAvailable(attachments, kind) {
  const list = Array.isArray(attachments) ? attachments : [];
  const used = list.filter((item) => item && item.kind === kind).length;
  const max = kind === "image" ?
    ISSUE_ATTACHMENT_LIMITS.maxImages :
    ISSUE_ATTACHMENT_LIMITS.maxVideos;
  if (used >= max) {
    throw issueError(
        kind === "image" ?
          `แนบรูปได้สูงสุด ${max} รูป` :
          `แนบวิดีโอได้สูงสุด ${max} คลิป`,
        400,
    );
  }
}

/**
 * @param {number} submittedToday Reports already filed in the rolling window.
 * @return {boolean} True when the house must wait before filing again.
 */
function isIssueRateLimited(submittedToday) {
  return Number(submittedToday || 0) >= ISSUE_DAILY_SUBMIT_LIMIT;
}

/**
 * Normalizes one stored reply into the shape both audiences share.
 * @param {Object} reply Stored reply.
 * @return {Object}
 */
function normalizeIssueReply(reply) {
  const source = reply || {};
  return {
    id: String(source.id || ""),
    author: source.author === "resident" ? "resident" : "admin",
    authorLabel: source.author === "resident" ?
      "ผู้แจ้ง" :
      ADMIN_AUTHOR_LABEL,
    message: String(source.message || ""),
    createdAt: source.createdAt || null,
  };
}

/**
 * Projects an issue for the resident who filed it.
 *
 * Internal notes stay hidden, and replies never carry the committee member's
 * own house number — residents see one voice, "นิติบุคคล / กรรมการ".
 *
 * @param {string} id Firestore document id.
 * @param {Object} issue Stored issue document.
 * @return {Object}
 */
function toResidentIssueView(id, issue) {
  const source = issue || {};
  const replies = Array.isArray(source.replies) ? source.replies : [];
  return {
    id,
    code: String(source.code || ""),
    title: String(source.title || ""),
    detail: String(source.detail || ""),
    category: normalizeIssueCategory(source.category),
    categoryLabel: issueCategoryLabel(source.category),
    priority: normalizeIssuePriority(source.priority),
    priorityLabel: issuePriorityLabel(source.priority),
    status: normalizeIssueStatus(source.status),
    statusLabel: residentIssueStatusLabel(source.status, source.category),
    anonymous: source.anonymous === true,
    attachments: Array.isArray(source.attachments) ? source.attachments : [],
    replies: replies.map(normalizeIssueReply),
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null,
    resolvedAt: source.resolvedAt || null,
    hasUnreadReply: hasUnreadAdminReply(source),
  };
}

/**
 * Projects an issue for a committee member.
 *
 * This is the anonymity boundary: when the reporter chose to stay anonymous,
 * no caller of this function can learn who they were. Keep `ownerHouseNo` and
 * `contact` out of the returned object — the stored document keeps them only so
 * the reporter can find their own thread and so rate limiting works.
 *
 * @param {string} id Firestore document id.
 * @param {Object} issue Stored issue document.
 * @return {Object}
 */
function redactIssueForAdmin(id, issue) {
  const source = issue || {};
  const anonymous = source.anonymous === true;
  const replies = Array.isArray(source.replies) ? source.replies : [];
  return {
    id,
    code: String(source.code || ""),
    title: String(source.title || ""),
    detail: String(source.detail || ""),
    category: normalizeIssueCategory(source.category),
    categoryLabel: issueCategoryLabel(source.category),
    priority: normalizeIssuePriority(source.priority),
    priorityLabel: issuePriorityLabel(source.priority),
    status: normalizeIssueStatus(source.status),
    statusLabel: issueStatusLabel(source.status),
    anonymous,
    reporterLabel: anonymous ? ANONYMOUS_LABEL : String(source.houseNo || ""),
    houseNo: anonymous ? "" : String(source.houseNo || ""),
    contact: anonymous ? "" : String(source.contact || ""),
    attachments: Array.isArray(source.attachments) ? source.attachments : [],
    replies: replies.map(normalizeIssueReply),
    internalNotes: Array.isArray(source.internalNotes) ?
      source.internalNotes :
      [],
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null,
    resolvedAt: source.resolvedAt || null,
    lastReplyBy: replies.length ?
      normalizeIssueReply(replies[replies.length - 1]).author :
      "",
    queueState: issueQueueState(source),
  };
}

/**
 * Derives the committee queue from durable conversation and workflow data.
 * Queue placement follows the explicit workflow status so committee actions
 * move a report predictably: new -> needs_action, in_progress -> waiting, and
 * resolved/closed -> done. Conversation authorship may decorate a card but
 * must never override the status selected by the committee.
 *
 * @param {Object} issue Stored issue document.
 * @return {"needs_action"|"waiting"|"done"}
 */
function issueQueueState(issue) {
  const source = issue || {};
  const status = normalizeIssueStatus(source.status);
  if (status === "resolved" || status === "closed") return "done";
  return status === "in_progress" ? "waiting" : "needs_action";
}

/**
 * True when the newest reply came from the committee and the resident has not
 * opened the thread since.
 * @param {Object} issue Stored issue document.
 * @return {boolean}
 */
function hasUnreadAdminReply(issue) {
  const source = issue || {};
  const replies = Array.isArray(source.replies) ? source.replies : [];
  const lastAdmin = replies
      .filter((reply) => reply && reply.author !== "resident")
      .pop();
  if (!lastAdmin) return false;
  const repliedAt = Number(lastAdmin.createdAtEpoch || 0);
  const seenAt = Number(source.residentSeenAtEpoch || 0);
  return repliedAt > seenAt;
}

/**
 * Counts issues per status for the admin dashboard chips.
 * @param {Array<Object>} issues Redacted or stored issues.
 * @return {Object<string, number>}
 */
function summarizeIssueStatuses(issues) {
  const counts = {total: 0};
  ISSUE_STATUSES.forEach((status) => {
    counts[status.key] = 0;
  });
  (Array.isArray(issues) ? issues : []).forEach((issue) => {
    const status = normalizeIssueStatus(issue && issue.status);
    counts[status] += 1;
    counts.total += 1;
  });
  return counts;
}

/**
 * Builds the only LINE message this feature is allowed to send.
 *
 * Deliberately carries no house number, no title and no detail: the sandbox
 * group is a shared room, and an anonymous report must stay anonymous there.
 * It is a doorbell, not a copy of the ticket — the committee opens the backend
 * to read anything real.
 *
 * @param {Object} issue Stored issue document.
 * @param {string} bangkokTime Preformatted Bangkok timestamp.
 * @return {{type: string, text: string}}
 */
function buildIssueWatchNotice(issue, bangkokTime) {
  const source = issue || {};
  const lines = [
    "มีเรื่องใหม่จากลูกบ้าน",
    `เลขที่: ${String(source.code || "-")}`,
    `หมวด: ${issueCategoryLabel(source.category)}`,
    `เวลา: ${String(bangkokTime || "")}`,
    "อ่านรายละเอียดที่ pattra8.com/report/ (เฉพาะกรรมการ)",
  ];
  return {type: "text", text: lines.join("\n")};
}

module.exports = {
  ADMIN_AUTHOR_LABEL,
  ANONYMOUS_LABEL,
  ISSUE_ATTACHMENT_LIMITS,
  ISSUE_CATEGORIES,
  ISSUE_COMMENT_MAX,
  ISSUE_DAILY_SUBMIT_LIMIT,
  ISSUE_DETAIL_MAX,
  ISSUE_INTERNAL_NOTE_MAX,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  ISSUE_TITLE_MAX,
  assertAttachmentSlotAvailable,
  buildIssueSubmission,
  buildIssueWatchNotice,
  formatIssueCode,
  hasUnreadAdminReply,
  issueQueueState,
  issueBuddhistYear,
  issueCategoryLabel,
  issueError,
  issuePriorityLabel,
  issueStatusLabel,
  isResidentIssueEditable,
  isIssueRateLimited,
  normalizeIssueCategory,
  normalizeIssuePriority,
  normalizeIssueReply,
  normalizeIssueStatus,
  normalizeIssueText,
  parseIssueUpload,
  redactIssueForAdmin,
  residentIssueStatusLabel,
  summarizeIssueStatuses,
  toResidentIssueView,
};
