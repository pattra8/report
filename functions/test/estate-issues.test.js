"use strict";

// Unit tests for the pure Estate Issues helpers (pattra8.com/report).
// Run: npm --prefix functions test

const {test, describe} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  ANONYMOUS_LABEL,
  ISSUE_ATTACHMENT_LIMITS,
  ISSUE_DAILY_SUBMIT_LIMIT,
  assertAttachmentSlotAvailable,
  buildIssueSubmission,
  buildIssueWatchNotice,
  formatIssueCode,
  hasUnreadAdminReply,
  issueQueueState,
  isResidentIssueEditable,
  issueBuddhistYear,
  isIssueRateLimited,
  normalizeIssueCategory,
  normalizeIssuePriority,
  normalizeIssueStatus,
  normalizeIssueText,
  parseIssueUpload,
  redactIssueForAdmin,
  residentIssueStatusLabel,
  summarizeIssueStatuses,
  toResidentIssueView,
} = require("../domains/issues/contracts");

const dataUrl = (contentType, bytes) =>
  `data:${contentType};base64,${Buffer.alloc(bytes, 1).toString("base64")}`;

describe("I-NORM normalization", () => {
  test("collapses whitespace and clips to the maximum length", () => {
    assert.equal(normalizeIssueText("  ไฟ   ดับ \n\n\n ครับ  ", 100),
        "ไฟ ดับ\n\nครับ");
    assert.equal(normalizeIssueText("abcdef", 3), "abc");
    assert.equal(normalizeIssueText(null, 10), "");
  });

  test("unknown option keys fall back to safe defaults", () => {
    assert.equal(normalizeIssueCategory("security"), "security");
    assert.equal(normalizeIssueCategory("pool"), "pool");
    assert.equal(normalizeIssueCategory("fitness"), "fitness");
    assert.equal(normalizeIssueCategory("garden"), "garden");
    assert.equal(normalizeIssueCategory("nope"), "other");
    assert.equal(normalizeIssueStatus(""), "new");
    assert.equal(normalizeIssueStatus("closed"), "closed");
    assert.equal(normalizeIssuePriority("urgent"), "urgent");
    assert.equal(normalizeIssuePriority({}), "normal");
  });
});

describe("I-CODE ticket codes", () => {
  test("uses the Buddhist year in the Bangkok day", () => {
    // 2025-12-31T18:00Z is already 2026-01-01 in Bangkok -> BE 2569.
    assert.equal(issueBuddhistYear(new Date("2025-12-31T18:00:00Z")), 2569);
    assert.equal(issueBuddhistYear(new Date("2025-12-31T10:00:00Z")), 2568);
  });

  test("pads the sequence and keeps growing past four digits", () => {
    assert.equal(formatIssueCode(2569, 7), "PT-2569-0007");
    assert.equal(formatIssueCode(2569, 1234), "PT-2569-1234");
    assert.equal(formatIssueCode(2569, 12345), "PT-2569-12345");
  });
});

describe("I-SUBMIT submission validation", () => {
  test("accepts a complete report and normalizes its options", () => {
    const submission = buildIssueSubmission({
      title: "  ไฟทางเสีย  ",
      detail: "หน้าบ้าน 38/12 ดับมาสามวัน",
      category: "utility",
      priority: "high",
      anonymous: "true",
    });
    assert.deepEqual(submission, {
      title: "ไฟทางเสีย",
      detail: "หน้าบ้าน 38/12 ดับมาสามวัน",
      category: "utility",
      priority: "high",
      anonymous: true,
    });
  });

  test("rejects a missing title or detail with a 400", () => {
    assert.throws(() => buildIssueSubmission({detail: "x"}), {status: 400});
    assert.throws(() => buildIssueSubmission({title: "ab"}), {status: 400});
    assert.throws(
        () => buildIssueSubmission({title: "หัวข้อยาวพอ", detail: "   "}),
        {status: 400},
    );
  });

  test("anonymity is opt-in, never inferred", () => {
    assert.equal(buildIssueSubmission({
      title: "หัวข้อ",
      detail: "รายละเอียด",
    }).anonymous, false);
    assert.equal(buildIssueSubmission({
      title: "หัวข้อ",
      detail: "รายละเอียด",
      anonymous: "yes",
    }).anonymous, false);
  });
});

describe("I-FILE attachments", () => {
  test("accepts supported images and videos", () => {
    const image = parseIssueUpload(dataUrl("image/jpeg", 1024));
    assert.equal(image.kind, "image");
    assert.equal(image.extension, "jpg");
    assert.equal(image.bytes, 1024);

    const video = parseIssueUpload(dataUrl("video/mp4", 2048));
    assert.equal(video.kind, "video");
    assert.equal(video.extension, "mp4");
  });

  test("normalizes image/jpg to the real content type", () => {
    assert.equal(parseIssueUpload(dataUrl("image/jpg", 16)).contentType,
        "image/jpeg");
  });

  test("rejects unsupported types, junk and oversized files", () => {
    assert.throws(() => parseIssueUpload("not-a-data-url"), {status: 400});
    assert.throws(() => parseIssueUpload(dataUrl("application/pdf", 16)),
        {status: 400});
    assert.throws(
        () => parseIssueUpload(
            dataUrl("image/png", ISSUE_ATTACHMENT_LIMITS.maxImageBytes + 1),
        ),
        {status: 400},
    );
    assert.throws(
        () => parseIssueUpload(
            dataUrl("video/mp4", ISSUE_ATTACHMENT_LIMITS.maxVideoBytes + 1),
        ),
        {status: 400},
    );
  });

  test("counts image and video slots separately", () => {
    const full = Array.from(
        {length: ISSUE_ATTACHMENT_LIMITS.maxImages},
        () => ({kind: "image"}),
    );
    assert.throws(() => assertAttachmentSlotAvailable(full, "image"),
        {status: 400});
    assertAttachmentSlotAvailable(full, "video");
    assert.throws(
        () => assertAttachmentSlotAvailable([{kind: "video"}], "video"),
        {status: 400},
    );
  });
});

describe("I-RATE submission rate limit", () => {
  test("blocks only once the daily allowance is used up", () => {
    assert.equal(isIssueRateLimited(ISSUE_DAILY_SUBMIT_LIMIT - 1), false);
    assert.equal(isIssueRateLimited(ISSUE_DAILY_SUBMIT_LIMIT), true);
  });
});

describe("I-ANON anonymity boundary", () => {
  const anonymousIssue = {
    code: "PT-2569-0001",
    houseNo: "38/12",
    contact: "081-000-0000",
    anonymous: true,
    title: "เสียงดังตอนกลางคืน",
    detail: "ทุกคืนวันศุกร์",
    category: "noise",
    status: "new",
  };

  test("a committee projection never carries the reporter's identity", () => {
    const view = redactIssueForAdmin("abc", anonymousIssue);
    assert.equal(view.houseNo, "");
    assert.equal(view.contact, "");
    assert.equal(view.reporterLabel, ANONYMOUS_LABEL);
    // Belt and braces: no field anywhere in the payload may echo the house.
    assert.equal(JSON.stringify(view).includes("38/12"), false);
  });

  test("a named report still shows its house to the committee", () => {
    const view = redactIssueForAdmin("abc", {
      ...anonymousIssue,
      anonymous: false,
    });
    assert.equal(view.houseNo, "38/12");
    assert.equal(view.reporterLabel, "38/12");
    assert.equal(view.contact, "081-000-0000");
  });

  test("residents never see internal notes or who replied", () => {
    const view = toResidentIssueView("abc", {
      ...anonymousIssue,
      internalNotes: [{message: "โทรหาช่างแล้ว", authorHouseNo: "38/8"}],
      replies: [{
        id: "r1",
        author: "admin",
        message: "รับเรื่องแล้วค่ะ",
        authorHouseNo: "38/8",
        createdAtEpoch: 200,
      }],
    });
    assert.equal("internalNotes" in view, false);
    assert.equal(view.replies[0].authorLabel, "กรรมการ");
    assert.equal(JSON.stringify(view).includes("38/8"), false);
  });
});

describe("I-READ unread state", () => {
  const withReplies = (replies, seen) => ({
    replies,
    residentSeenAtEpoch: seen,
  });

  test("flags an admin reply the resident has not opened yet", () => {
    assert.equal(hasUnreadAdminReply(withReplies(
        [{author: "admin", createdAtEpoch: 500}], 100,
    )), true);
  });

  test("clears once the resident has opened the thread", () => {
    assert.equal(hasUnreadAdminReply(withReplies(
        [{author: "admin", createdAtEpoch: 500}], 900,
    )), false);
  });

  test("the resident's own message never counts as unread", () => {
    assert.equal(hasUnreadAdminReply(withReplies(
        [{author: "resident", createdAtEpoch: 900}], 100,
    )), false);
    assert.equal(hasUnreadAdminReply({replies: []}), false);
  });
});

describe("I-RESIDENT status language", () => {
  test("new and active reports use clear progress language", () => {
    assert.equal(
        residentIssueStatusLabel("new", "utility"), "ส่งถึงกรรมการแล้ว",
    );
    assert.equal(
        residentIssueStatusLabel("in_progress", "utility"), "กำลังดูแล",
    );
  });

  test("closed feedback is acknowledged, not falsely completed", () => {
    assert.equal(
        residentIssueStatusLabel("resolved", "suggestion"), "รับทราบแล้ว",
    );
    assert.equal(residentIssueStatusLabel("closed", "feedback"), "รับทราบแล้ว");
    assert.equal(
        residentIssueStatusLabel("resolved", "utility"), "ดำเนินการแล้ว",
    );
  });
});

describe("I-EDIT resident case lock", () => {
  test("only live cases allow resident content edits", () => {
    assert.equal(isResidentIssueEditable("new"), true);
    assert.equal(isResidentIssueEditable("in_progress"), true);
    assert.equal(isResidentIssueEditable("resolved"), false);
    assert.equal(isResidentIssueEditable("closed"), false);
  });
});

describe("I-STATS status summary", () => {
  test("counts every status and the total", () => {
    const stats = summarizeIssueStatuses([
      {status: "new"}, {status: "new"}, {status: "closed"}, {status: "junk"},
    ]);
    assert.equal(stats.new, 3);
    assert.equal(stats.closed, 1);
    assert.equal(stats.in_progress, 0);
    assert.equal(stats.total, 4);
  });
});

describe("I-QUEUE committee action state", () => {
  test("new reports stay actionable even after being opened", () => {
    assert.equal(issueQueueState({status: "new", replies: []}), "needs_action");
    assert.equal(issueQueueState({
      status: "new",
      replies: [{author: "admin", createdAtEpoch: 100}],
    }), "needs_action");
  });

  test("in-progress placement ignores the latest author", () => {
    assert.equal(issueQueueState({
      status: "in_progress",
      replies: [{author: "admin", createdAtEpoch: 100}],
    }), "waiting");
    assert.equal(issueQueueState({
      status: "in_progress",
      replies: [
        {author: "admin", createdAtEpoch: 100},
        {author: "resident", createdAtEpoch: 200},
      ],
    }), "waiting");
  });

  test("explicit completion always leaves the live queues", () => {
    assert.equal(issueQueueState({status: "resolved", replies: []}), "done");
    assert.equal(issueQueueState({
      status: "closed",
      replies: [{author: "resident", createdAtEpoch: 200}],
    }), "done");
  });
});

describe("I-LINE containment", () => {
  const issue = {
    code: "PT-2569-0009",
    houseNo: "38/12",
    anonymous: true,
    title: "เพื่อนบ้านจอดขวางหน้าบ้าน",
    detail: "ทะเบียน กข 1234 จอดขวางทุกเย็น",
    category: "traffic",
    priority: "urgent",
  };

  test("the notice is a doorbell: no identity, no free text", () => {
    const {text} = buildIssueWatchNotice(issue, "25 ส.ค. 2569 21:30");
    assert.equal(text.includes("PT-2569-0009"), true);
    assert.equal(text.includes("จราจร / ที่จอดรถ"), true);
    // Urgency was dropped from the resident form; the notice never carried
    // more than a doorbell's worth of detail anyway.
    assert.equal(text.includes("38/12"), false);
    assert.equal(text.includes(issue.title), false);
    assert.equal(text.includes(issue.detail), false);
  });

  test("a named report leaks nothing extra either", () => {
    const {text} = buildIssueWatchNotice({...issue, anonymous: false}, "x");
    assert.equal(text.includes("38/12"), false);
  });
});

describe("I-SRC source guards", () => {
  const source = fs.readFileSync(
      path.join(__dirname, "..", "index.js"),
      "utf8",
  );
  // Comment lines are dropped so prose explaining what NOT to call cannot
  // satisfy — or trip — these guards.
  const block = source
      .slice(source.indexOf("// ESTATE ISSUES"))
      .split("\n")
      .filter((line) => !/^(\/\/|\/\*|\*)/.test(line.trim()))
      .join("\n");

  test("issue notices go to the Pattra Watch sandbox target only", () => {
    assert.match(block, /sendLinePushMessages\(\s*LINE_FLEX_SANDBOX_TARGET_ID/);
    // resolveLineFlexTargetId reads a Firestore route that an operator can
    // flip to a production group; that must never gate an estate complaint.
    assert.equal(block.includes("resolveLineFlexTargetId"), false);
    assert.equal(block.includes("getReportIssueTargetId"), false);
    assert.equal(block.includes("LINE_FLEX_SECURITY_PRODUCTION_TARGET_ID"),
        false);
    assert.equal(block.includes("LINE_FLEX_PATTRA_PAY_PRODUCTION_TARGET_ID"),
        false);
  });

  test("the retired issue boards can no longer push to LINE", () => {
    assert.match(source, /const LEGACY_ISSUE_LINE_NOTIFY_ENABLED = false;/);
    assert.match(source, /if \(!LEGACY_ISSUE_LINE_NOTIFY_ENABLED\) \{/);
  });
});
