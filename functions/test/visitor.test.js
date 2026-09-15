"use strict";

// Unit tests for the pure Visitor Intake helpers.
// Run: npm test   (uses the Node built-in test runner, no extra deps)
// Scenario IDs map to the pre-go-live test catalogue (U-CAT, U-PARSE, ...).

const {test, describe} = require("node:test");
const assert = require("node:assert");

const {
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
} = require("../index.js").__visitorTest;

const img = (kind) => ({kind});

describe("U-WEBHOOK getLineWebhookEventId", () => {
  test("uses the LINE webhook event id when it is Firestore-safe", () => {
    assert.strictEqual(
        getLineWebhookEventId({webhookEventId: "01K2ABC_xyz-123"}),
        "01K2ABC_xyz-123",
    );
  });

  test("falls back to a stable hash for missing or unsafe ids", () => {
    const event = {
      webhookEventId: "unsafe/id",
      type: "message",
      message: {id: "123", type: "text", text: "38/3 ส่งพัสดุ"},
    };
    const first = getLineWebhookEventId(event);
    const second = getLineWebhookEventId({...event});
    assert.match(first, /^[a-f0-9]{24}$/);
    assert.strictEqual(first, second);
  });
});

describe("U-LINE-REPLY isLineReplyFailure", () => {
  test("recognizes LINE delivery failure after data was saved", () => {
    assert.strictEqual(isLineReplyFailure({
      code: "LINE_REPLY_FAILED",
      status: 500,
    }), true);
  });

  test("keeps processing errors eligible for silent retry", () => {
    assert.strictEqual(
        isLineReplyFailure(new Error("Firestore failed")),
        false,
    );
    assert.strictEqual(isLineReplyFailure(null), false);
  });
});

describe("U-LINE-CONTENT isLineContentUnavailable", () => {
  test("recognizes expired LINE media", () => {
    assert.strictEqual(isLineContentUnavailable({
      code: "LINE_CONTENT_UNAVAILABLE",
      status: 410,
    }), true);
  });

  test("does not swallow retryable content failures", () => {
    assert.strictEqual(isLineContentUnavailable({
      code: "LINE_CONTENT_FAILED",
      status: 500,
    }), false);
    assert.strictEqual(isLineContentUnavailable(new Error("timeout")), false);
  });
});

describe("U-LINE-OUTAGE Visitor outage notice", () => {
  test("allows only one attempt per hour", () => {
    const now = 20000000;
    assert.strictEqual(shouldAttemptVisitorOutageNotice(0, now), true);
    assert.strictEqual(
        shouldAttemptVisitorOutageNotice(now - 59 * 60 * 1000, now),
        false,
    );
    assert.strictEqual(
        shouldAttemptVisitorOutageNotice(now - 60 * 60 * 1000, now),
        true,
    );
  });

  test("explains that guards can keep sending Visitor data", () => {
    const text = buildVisitorLineOutageNotice();
    assert.match(text, /LINE Messaging API ขัดข้องชั่วคราว/);
    assert.match(text, /ส่งข้อมูลได้ตามปกติ/);
    assert.match(text, /ประมวลผลย้อนหลัง/);
  });
});

describe("Laundry purposes", () => {
  for (const text of [
    "มาส่งผ้าซักรีดบ้าน", "มารับผ้า", "รับ-ส่งผ้า",
    "ร้านซัก รีด", "ส่งผ้าซักแห้ง", "Grab รับผ้า", "Laundry pickup",
  ]) {
    test(text, () => {
      assert.strictEqual(mapVisitorPurposeCategory(text), "laundry");
      const parsed = parseVisitorIntakeText(`${text} 38/12`);
      assert.strictEqual(parsed.purposeCategory, "laundry");
    });
  }
  test("consistent display and report label", () => {
    assert.strictEqual(visitorPurposeLabel("laundry", "มารับผ้า"),
        "ซักรีด/รับ–ส่งผ้า");
    assert.strictEqual(visitorReportPurposeLabel("laundry", "มาส่งผ้า"),
        "ซักรีด/รับ–ส่งผ้า");
  });
  test("washing machine repair remains contractor", () => {
    assert.strictEqual(mapVisitorPurposeCategory("ช่างซ่อมเครื่องซักผ้า"),
        "contractor");
  });
});

describe("U-CAT mapVisitorPurposeCategory", () => {
  const cases = [
    ["grab food", "food_delivery"],
    ["grabfood", "food_delivery"],
    ["มาส่งอาหาร", "food_delivery"],
    ["มาส่งขนม", "food_delivery"],
    ["lineman", "food_delivery"],
    ["robinhood", "food_delivery"],
    ["grab", "food_delivery"],
    ["grab car มารับ", "pickup"],
    ["grabcar", "pickup"],
    ["bolt", "pickup"],
    ["มารับ", "pickup"],
    ["รับลูกบ้าน", "pickup"],
    ["ส่งลูกบ้าน", "pickup"],
    ["เรียก taxi", "pickup"],
    ["แท็กซี่มารับ", "pickup"],
    ["มารับพัสดุ", "delivery"],
    ["มารับพัสดุบ้าน 38/43", "delivery"],
    ["มารับของ", "delivery"],
    ["มารับเอกสาร", "delivery"],
    ["shopee", "delivery"],
    ["lazada", "delivery"],
    ["ส่งพัสดุ", "delivery"],
    ["kerry", "delivery"],
    ["flash", "delivery"],
    ["j&t", "delivery"],
    ["ไปรษณีย์", "delivery"],
    ["การไฟฟ้า", "utility"],
    ["การประปา", "utility"],
    ["เน็ต 3bb", "utility"],
    ["มาใส่อินเตอร์เน็ต", "utility"],
    ["ช่างมาซ่อมบ้าน", "contractor"],
    ["ผู้รับเหมา เข้ามา", "contractor"],
    ["ช่างติดต่อลูกบ้าน 38/12", "contractor"],
    ["ช่างไฟ มาหา 38/13", "contractor"],
    ["ช่างประปา ติดต่อ 38/14", "contractor"],
    ["มาซ่อมไฟฟ้า", "contractor"],
    ["มาซ่อมประปา", "contractor"],
    ["มาทาสี", "contractor"],
    ["ติดตั้งแอร์", "contractor"],
    ["มาฉีดปลวกบ้าน", "contractor"],
    ["มาทำความสะอาดบ้าน", "contractor"],
    ["มาติดต่อ นิติ", "office"],
    ["นิติบุคคล", "office"],
    ["มาที่ออฟฟิศ", "office"],
    ["office", "office"],
    ["มาหานิติ", "office"],
    ["มาติดต่อลูกบ้าน", "contact"],
    ["เข้าพบลูกบ้าน", "contact"],
    ["มาเอาเอกสารบ้าน", "delivery"],
    ["ญาติมาเยี่ยม", "guest"],
    ["ญาตมาหา", "guest"],
    ["เพื่อนมาหา", "guest"],
    ["แขก", "guest"],
    ["asdfqwer", "other"],
    ["", "unknown"],
    ["   ", "unknown"],
  ];
  for (const [input, expected] of cases) {
    test(`"${input}" => ${expected}`, () => {
      assert.strictEqual(mapVisitorPurposeCategory(input), expected);
    });
  }

  test("U-CAT-09 null/undefined => unknown", () => {
    assert.strictEqual(mapVisitorPurposeCategory(null), "unknown");
    assert.strictEqual(mapVisitorPurposeCategory(undefined), "unknown");
  });

  test("U-CAT-10 pickup wins over food for 'grab car'", () => {
    assert.strictEqual(mapVisitorPurposeCategory("grab car"), "pickup");
  });

  test("U-CAT-10 office wins over guest for 'มาหานิติ'", () => {
    assert.strictEqual(mapVisitorPurposeCategory("มาหานิติ"), "office");
  });

  test("U-CAT-11 case-insensitive latin", () => {
    assert.strictEqual(mapVisitorPurposeCategory("GRAB FOOD"), "food_delivery");
    assert.strictEqual(mapVisitorPurposeCategory("  SHOPEE  "), "delivery");
  });
});

describe("U-LBL visitorPurposeLabel", () => {
  test("known category => Thai label", () => {
    assert.strictEqual(
        visitorPurposeLabel("food_delivery", "x"),
        "ส่งอาหาร (Food Delivery)",
    );
    assert.strictEqual(
        visitorPurposeLabel("office", "x"),
        "ติดต่อนิติ/ส่วนกลาง",
    );
    assert.strictEqual(
        visitorPurposeLabel("guest", "x"), "แขก/ผู้มาติดต่อ");
  });
  test("contractor category keeps subtype in parentheses", () => {
    assert.strictEqual(
        visitorPurposeLabel("contractor", "ช่างมาล้างแอร์"),
        "ช่าง/ซ่อมบำรุง (ล้างแอร์)",
    );
    assert.strictEqual(
        visitorPurposeLabel("contractor", "ช่างมาติดตั้งแอร์"),
        "ช่าง/ซ่อมบำรุง (ติดตั้งแอร์)",
    );
    assert.strictEqual(
        visitorPurposeLabel("contractor", "ช่างมาซ่อมแอร์"),
        "ช่าง/ซ่อมบำรุง (ซ่อมแอร์)",
    );
    assert.strictEqual(
        visitorPurposeLabel("contractor", "ช่างไฟ ส่วนกลาง"),
        "ช่าง/ซ่อมบำรุง (ช่างไฟ)",
    );
    assert.strictEqual(
        visitorPurposeLabel("contractor", "ช่างประปา ติดต่อ 38/14"),
        "ช่าง/ซ่อมบำรุง (ช่างประปา)",
    );
  });
  test("other => raw text", () => {
    assert.strictEqual(visitorPurposeLabel("other", "มาส่งเอกสาร"),
        "มาส่งเอกสาร");
  });
  test("unknown / empty => ไม่ระบุ", () => {
    assert.strictEqual(visitorPurposeLabel("unknown", ""), "ไม่ระบุ");
    assert.strictEqual(visitorPurposeLabel("other", ""), "ไม่ระบุ");
  });
});

describe("U-REPORT-LBL visitorReportPurposeLabel", () => {
  test("office report label omits common-area operational detail", () => {
    assert.strictEqual(
        visitorReportPurposeLabel(
            "office",
            "ติดต่อนิติ/ส่วนกลาง (38/69 (ช่างปรับปรุง))",
        ),
        "ติดต่อนิติ/ส่วนกลาง",
    );
  });

  test("non-office report labels keep their normal category detail", () => {
    assert.strictEqual(
        visitorReportPurposeLabel("contractor", "ช่างมาล้างแอร์"),
        "ช่าง/ซ่อมบำรุง (ล้างแอร์)",
    );
  });
});

describe("U-PARSE parseVisitorIntakeText", () => {
  test("house + purpose", () => {
    const r = parseVisitorIntakeText("38/13 ช่างมาทาสี");
    assert.strictEqual(r.houseNo, "38/13");
    assert.ok(r.purposeText.includes("ช่าง"));
    assert.strictEqual(r.purposeCategory, "contractor");
  });
  test("multiline house + purpose", () => {
    const r = parseVisitorIntakeText("38/8\nญาติมาเยี่ยม");
    assert.strictEqual(r.houseNo, "38/8");
    assert.strictEqual(r.purposeCategory, "guest");
  });
  test("two explicit houses split by hyphen count as two houses", () => {
    const r = parseVisitorIntakeText("มาส่งของลูกบ้าน 38/1 - 38/7");
    assert.strictEqual(r.houseNo, "38/1");
    assert.deepStrictEqual(r.houseNos, ["38/1", "38/7"]);
    assert.strictEqual(r.purposeCategory, "delivery");
    assert.strictEqual(r.purposeText, "มาส่งของลูกบ้าน");
  });
  test("two short houses joined by and are stored", () => {
    const r = parseVisitorIntakeText(
        "มีรถเข้าไปส่งพัสดุบ้านเลขที่ 14 และ 17 ครับผม",
    );
    assert.strictEqual(r.houseNo, "38/14");
    assert.deepStrictEqual(r.houseNos, ["38/14", "38/17"]);
    assert.strictEqual(r.purposeCategory, "delivery");
  });
  test("many short houses separated by commas are stored", () => {
    const r = parseVisitorIntakeText(
        "มาส่งพัสดุหลายบ้าน บ้าน 35, 40, 12",
    );
    assert.strictEqual(r.houseNo, "38/35");
    assert.deepStrictEqual(r.houseNos, ["38/35", "38/40", "38/12"]);
    assert.strictEqual(r.purposeCategory, "delivery");
  });
  test("slash house followed by comma suffixes are stored", () => {
    const compact = parseVisitorIntakeText("38/3,33ส่งพัสดุ");
    assert.strictEqual(compact.houseNo, "38/3");
    assert.deepStrictEqual(compact.houseNos, ["38/3", "38/33"]);
    assert.strictEqual(compact.purposeCategory, "delivery");
    const spaced = parseVisitorIntakeText("38/14,20 ส่งพัสดุ");
    assert.strictEqual(spaced.houseNo, "38/14");
    assert.deepStrictEqual(spaced.houseNos, ["38/14", "38/20"]);
  });
  test("voice typing can split house label words", () => {
    const r = parseVisitorIntakeText(
        "มี ตัว อย ไป ส่ง อาหาร บ้าน เลข ที่ 38/67 ครับ",
    );
    assert.strictEqual(r.houseNo, "38/67");
    assert.strictEqual(r.purposeCategory, "food_delivery");
  });
  test("compact Pattra house suffix after 38 is accepted", () => {
    const compact = parseVisitorIntakeText("ส่งอาหาร 3831 ครับผม");
    assert.strictEqual(compact.houseNo, "38/31");
    assert.strictEqual(compact.purposeCategory, "food_delivery");
    const spaced = parseVisitorIntakeText("ส่งอาหาร 38 31 ครับผม");
    assert.strictEqual(spaced.houseNo, "38/31");
    assert.strictEqual(spaced.purposeCategory, "food_delivery");
  });
  test("single digits split after house label are combined", () => {
    const r = parseVisitorIntakeText("จยยไปส่งอาหารบ้าน 6 7 ครับ");
    assert.strictEqual(r.houseNo, "38/67");
    assert.strictEqual(r.purposeCategory, "food_delivery");
  });
  test("ice delivery is food delivery", () => {
    const r = parseVisitorIntakeText("มีจยยไปส่งน้ำแข็ง 38/20 ครับ");
    assert.strictEqual(r.houseNo, "38/20");
    assert.strictEqual(r.purposeCategory, "food_delivery");
  });
  test("trailing short house number is accepted with clear purpose", () => {
    const r = parseVisitorIntakeText("มีรถมาส่งอาหารครับ 15 ครับ");
    assert.strictEqual(r.houseNo, "38/15");
    assert.strictEqual(r.purposeCategory, "food_delivery");
  });
  test("house number is not extracted as a typed plate", () => {
    const r = parseVisitorIntakeText("ไรเดอร์มาส่งอาหาร 38 ครับ");
    assert.strictEqual(r.houseNo, "38/38");
    assert.strictEqual(r.purposeCategory, "food_delivery");
    assert.strictEqual(r.vehiclePlate, "");
    assert.ok(!r.purposeText.includes("ไ เดอ"));
  });
  test("resident no-scan exception is saved without visitor images", () => {
    const r = parseVisitorIntakeText(
        "บอกเป็นลูกบ้าน38/42ไม่มีสแกนเข้าครับ",
    );
    assert.strictEqual(r.houseNo, "38/42");
    assert.strictEqual(r.purposeText, "บอกเป็นลูกบ้าน ไม่มีสแกนเข้า");
    assert.strictEqual(r.intakeException, "resident_no_scan");
    assert.strictEqual(r.ignored, false);
  });
  test("'บ้าน 8' label form", () => {
    const r = parseVisitorIntakeText("บ้าน 8 มาส่งของ shopee");
    assert.strictEqual(r.houseNo, "38/8");
    assert.strictEqual(r.purposeCategory, "delivery");
  });
  test("human sentence strips house label and polite ending", () => {
    const r = parseVisitorIntakeText("มาติดต่อลูกบ้านเลขที่ 38/59 ครับ");
    assert.strictEqual(r.houseNo, "38/59");
    assert.strictEqual(r.purposeText, "มาติดต่อ");
  });
  test("pickup resident keeps ลูกบ้าน wording", () => {
    const r = parseVisitorIntakeText("รับลูกบ้านเลขที่ 38/12 ครับ");
    assert.strictEqual(r.houseNo, "38/12");
    assert.strictEqual(r.purposeText, "รับลูกบ้าน");
    assert.strictEqual(r.purposeCategory, "pickup");
  });
  test("drop-off resident keeps ลูกบ้าน wording", () => {
    const r = parseVisitorIntakeText("38/9 ส่งลูกบ้าน");
    assert.strictEqual(r.houseNo, "38/9");
    assert.strictEqual(r.purposeText, "ส่งลูกบ้าน");
    assert.strictEqual(r.purposeCategory, "pickup");
  });
  test("house stuck to purpose is normalized before parsing", () => {
    const r = parseVisitorIntakeText("38/8ส่งรับบ้านครับ");
    assert.strictEqual(r.houseNo, "38/8");
    assert.strictEqual(r.purposeCategory, "pickup");
    assert.ok(r.warnings.includes("text_spacing_normalized"));
    assert.ok(r.warnings.includes("pickup_text_interpreted"));
  });
  test("ambiguous 3-digit house tail is warned", () => {
    const r = parseVisitorIntakeText("ส่งอาหาร 38/268ครับ");
    assert.strictEqual(r.houseNo, "");
    assert.ok(r.warnings.includes("house_format_ambiguous"));
  });
  test("house only => no purpose", () => {
    const r = parseVisitorIntakeText("38/5");
    assert.strictEqual(r.houseNo, "38/5");
    assert.strictEqual(r.purposeText, "");
  });
  test("purpose only => no house", () => {
    const r = parseVisitorIntakeText("มาส่งอาหาร grab");
    assert.strictEqual(r.houseNo, "");
    assert.strictEqual(r.purposeCategory, "food_delivery");
    assert.strictEqual(r.ignored, false);
  });
  test("technician sentence with house parses as contractor", () => {
    const r = parseVisitorIntakeText("ช่างไฟ มาหา 38/13");
    assert.strictEqual(r.houseNo, "38/13");
    assert.strictEqual(r.purposeText, "ช่างไฟ มาหา");
    assert.strictEqual(r.purposeCategory, "contractor");
  });
  test("cleans human contact sentence without house label noise", () => {
    const r = parseVisitorIntakeText("มาติดต่อลูกบ้านเลขที่ 38/59 ครับ");
    assert.strictEqual(r.houseNo, "38/59");
    assert.strictEqual(r.purposeText, "มาติดต่อ");
    assert.strictEqual(r.purposeCategory, "contact");
    assert.strictEqual(cleanVisitorPurposeText("มาติดต่อลูกบ้านเลขที่ ครับ"),
        "มาติดต่อ");
  });
  test("out-of-range house => not accepted", () => {
    const r = parseVisitorIntakeText("38/99 ญาติ");
    assert.strictEqual(r.houseNo, "");
  });
  test("empty => blank result", () => {
    const r = parseVisitorIntakeText("");
    assert.strictEqual(r.houseNo, "");
    assert.strictEqual(r.purposeText, "");
    assert.strictEqual(r.ignored, true);
    assert.strictEqual(r.ignoredReason, "empty");
  });
  test("acknowledgement chat is ignored", () => {
    const r = parseVisitorIntakeText("รับทราบครับ");
    assert.strictEqual(r.houseNo, "");
    assert.strictEqual(r.ignored, true);
    assert.strictEqual(r.ignoredReason, "acknowledgement");
  });
  test("instruction chat is ignored even if it contains sample data", () => {
    const r = parseVisitorIntakeText(
        "วาครับ ต่อไป visitor ทั้งรถยนต์ / มอเตอร์ไซต์ " +
        "ให้พิมพ์เข้า LINE กลุ่มนี้นะครับ · ตัวอย่างนะครับ · " +
        "ติดต่อบ้าน 38/8 ส่ง grab food · ผมทำระบบอ่านชื่อ / ทะเบียน",
    );
    assert.strictEqual(r.ignored, true);
    assert.strictEqual(r.ignoredReason, "instruction_chat");
  });
  test("real short visitor text is not ignored", () => {
    const r = parseVisitorIntakeText("38/8 ส่ง grab food");
    assert.strictEqual(r.houseNo, "38/8");
    assert.strictEqual(r.purposeCategory, "food_delivery");
    assert.strictEqual(r.ignored, false);
  });
  test("typed plate follow-up is accepted without house or purpose", () => {
    const r = parseVisitorIntakeText("ทะเบียน 7ขข 1159 กรุงเทพ");
    assert.strictEqual(r.houseNo, "");
    assert.strictEqual(r.purposeText, "");
    assert.strictEqual(r.vehiclePlate, "7ขข 1159 กรุงเทพ");
    assert.strictEqual(r.ignored, false);
  });
  test("compact typed plate follow-up is accepted", () => {
    const r = parseVisitorIntakeText("7ขข1159");
    assert.strictEqual(r.vehiclePlate, "7ขข 1159");
    assert.strictEqual(r.ignored, false);
  });
  test("nitibukkol contact defaults to common-area house", () => {
    const r = parseVisitorIntakeText("ติดต่อนิติ");
    assert.strictEqual(r.houseNo, "38/69");
    assert.strictEqual(r.purposeText, "ติดต่อนิติ");
    assert.strictEqual(r.purposeCategory, "office");
    assert.strictEqual(r.ignored, false);
  });
  test("nitibukkol contact keeps useful detail in parentheses", () => {
    const r = parseVisitorIntakeText("ช่างลูกระนาดติดต่อนิติครับ");
    assert.strictEqual(r.houseNo, "38/69");
    assert.strictEqual(
        r.purposeText,
        "ติดต่อนิติ (ช่างลูกระนาด)",
    );
    assert.strictEqual(r.purposeCategory, "office");
    assert.strictEqual(r.ignored, false);
  });
  test("garden technician meeting juristic office remains a contact", () => {
    const r = parseVisitorIntakeText("38/69 ติดต่อนิติ ช่างสวน");
    assert.strictEqual(r.houseNo, "38/69");
    assert.strictEqual(r.purposeText, "ติดต่อนิติ (ช่างสวน)");
    assert.strictEqual(r.purposeCategory, "office");
  });
  test("common-area detail drops 38/69 and normalizes work wording", () => {
    const clubhouse = parseVisitorIntakeText(
        "38/69 ติดต่อนิติ(ช่างปรับปรุงสโมสร)",
    );
    assert.strictEqual(
        clubhouse.purposeText,
        "งานปรับปรุงส่วนกลาง (ปรับปรุงสโมสร)",
    );
    const material = parseVisitorIntakeText(
        "38/69 ติดต่อนิติ(มาส่งปูนซีเมนต์)",
    );
    assert.strictEqual(
        material.purposeText,
        "งานส่วนกลาง (ส่งปูนซีเมนต์)",
    );
  });
  test("front project and clubhouse contact default to 38/69", () => {
    assert.strictEqual(
        parseVisitorIntakeText("ติดต่อหน้าโครงการ").houseNo,
        "38/69",
    );
    assert.strictEqual(
        parseVisitorIntakeText("ติดต่อสโมสร").purposeText,
        "ติดต่อนิติ",
    );
  });
  test("common-area operations infer 38/69 without typed house", () => {
    const waste = parseVisitorIntakeText("รถขยะเข้ามา");
    assert.strictEqual(waste.houseNo, "38/69");
    assert.strictEqual(waste.purposeCategory, "utility");
    assert.ok(waste.warnings.includes("common_area_inferred"));

    const contractor = parseVisitorIntakeText("ผู้รับเหมางานส่วนกลาง");
    assert.strictEqual(contractor.houseNo, "38/69");
    assert.strictEqual(contractor.purposeCategory, "contractor");
    assert.ok(contractor.warnings.includes("common_area_inferred"));
  });
});

describe("U-PLATE normalizeVisitorPlate", () => {
  test("plate-only gets a space", () => {
    assert.strictEqual(normalizeVisitorPlate("1กร4111"), "1กร 4111");
    assert.strictEqual(normalizeVisitorPlate("ชป306"), "ชป 306");
  });
  test("strips internal spaces before matching", () => {
    assert.strictEqual(normalizeVisitorPlate("1กร 4111"), "1กร 4111");
  });
  test("plate with province is normalized for storage/display", () => {
    assert.strictEqual(
        normalizeVisitorPlate("1กร4111กรุงเทพมหานคร"),
        "1กร 4111 กรุงเทพ",
    );
    assert.strictEqual(normalizeVisitorPlate("กษ7827ระยอง"), "กษ 7827 ระยอง");
    assert.strictEqual(
        normalizeVisitorPlate("1กฎอุตรดิตถ์ 1653"),
        "1กฎ 1653 อุตรดิตถ์",
    );
  });
  test("empty => empty", () => {
    assert.strictEqual(normalizeVisitorPlate(""), "");
    assert.strictEqual(normalizeVisitorPlate(null), "");
  });
});

describe("U-VEHICLE normalizeVisitorVehicleType", () => {
  test("maps common OCR values to Thai buckets", () => {
    assert.strictEqual(normalizeVisitorVehicleType("car"), "รถยนต์");
    assert.strictEqual(
        normalizeVisitorVehicleType("motorcycle"), "รถมอเตอร์ไซค์");
    assert.strictEqual(normalizeVisitorVehicleType("truck"), "รถบรรทุก");
    assert.strictEqual(normalizeVisitorVehicleType("garbage truck"), "รถขยะ");
  });
});

describe("U-DOC normalizeDocumentNumber", () => {
  test("keeps digits only for ID / driver license OCR", () => {
    assert.strictEqual(
        normalizeDocumentNumber("1-2345-67890-12-3"),
        "1234567890123",
    );
    assert.strictEqual(normalizeDocumentNumber("DL 8800 112233"), "8800112233");
  });
});

describe("U-STAT getVisitorIntakeStatus", () => {
  test("no house/purpose => pending_text", () => {
    assert.strictEqual(getVisitorIntakeStatus({}), "pending_text");
    assert.strictEqual(
        getVisitorIntakeStatus({houseNo: "38/8"}), "pending_text");
  });
  test("text present, no images => pending_image", () => {
    assert.strictEqual(getVisitorIntakeStatus(
        {houseNo: "38/8", purposeText: "ญาติ"}), "pending_image");
  });
  test("doc only => partial and no longer blocks saving", () => {
    assert.strictEqual(getVisitorIntakeStatus({
      houseNo: "38/8", purposeText: "ญาติ", images: [img("document")],
    }), "partial");
  });
  test("doc + plate => complete", () => {
    assert.strictEqual(getVisitorIntakeStatus({
      houseNo: "38/8", purposeText: "ญาติ",
      images: [img("document"), img("vehicle")],
      vehicleCapture: {plateText: "1กร 4111 กรุงเทพ"},
    }), "complete");
  });
  test("one mixed document and vehicle image can complete intake", () => {
    assert.strictEqual(getVisitorIntakeStatus({
      houseNo: "38/21", purposeText: "มาส่งอาหาร",
      images: [img("document_vehicle")],
      vehicleCapture: {plateText: "9ขก 6472 กรุงเทพ"},
    }), "complete");
  });
  test("doc + vehicle without readable plate => partial", () => {
    assert.strictEqual(getVisitorIntakeStatus({
      houseNo: "38/8", purposeText: "ญาติ",
      images: [img("document"), img("vehicle")],
    }), "partial");
  });
  test("typed plate without document => partial", () => {
    assert.strictEqual(getVisitorIntakeStatus({
      houseNo: "38/27",
      purposeText: "มาส่งลูกบ้าน",
      vehicleCapture: {plateText: "ทส 6337 กรุงเทพ"},
    }), "partial");
  });
  test("resident no-scan exception saves as partial", () => {
    assert.strictEqual(getVisitorIntakeStatus({
      houseNo: "38/42",
      purposeText: "บอกเป็นลูกบ้าน ไม่มีสแกนเข้า",
      intakeException: "resident_no_scan",
    }), "partial");
  });
  test("document image + typed plate => complete", () => {
    assert.strictEqual(getVisitorIntakeStatus({
      houseNo: "38/28", purposeText: "มาส่งอาหาร",
      images: [img("document"), img("other")],
      vehicleCapture: {plateText: "7ขข 1159 กรุงเทพ"},
    }), "complete");
  });
  test("only kind=other images => still pending_image", () => {
    assert.strictEqual(getVisitorIntakeStatus({
      houseNo: "38/8", purposeText: "ญาติ",
      images: [img("other"), img("other")],
    }), "pending_image");
  });
});

describe("U-WARN buildVisitorWarnings", () => {
  test("accepts valid plates from provinces with long names", () => {
    const out = buildVisitorWarnings({
      status: "complete",
      purposeText: "ส่งอาหาร",
      purposeCategory: "food_delivery",
      ocr: {personName: "นาย ทดสอบ", documentNumber: "1234", confidence: 0.95},
      vehicleCapture: {
        plateText: "1กร 9257 นครราชสีมา",
        vehicleType: "รถมอเตอร์ไซค์",
      },
    });
    assert.ok(!out.includes("ทะเบียนที่อ่านได้ดูผิดปกติ"));
  });
  test("adds warnings for incomplete and low-confidence fields", () => {
    const out = buildVisitorWarnings({
      status: "pending_image",
      purposeText: "มาทำความสะอาดบ้าน",
      purposeCategory: "other",
      textParse: {warnings: ["text_spacing_normalized"]},
      ocr: {personName: "นาย ทดสอบ", documentNumber: "", confidence: 0.8},
      vehicleCapture: {plateText: "70-4621"},
    });
    assert.ok(out.includes("ข้อมูลยังไม่ครบ"));
    assert.ok(out.includes("หมวดอัตโนมัติยังไม่ชัด"));
    assert.ok(out.includes("ข้อความพิมพ์ติดกัน ระบบช่วยแยกคำให้"));
    assert.ok(out.includes("อ่านเลขบัตร/ใบขับขี่ไม่ครบ"));
    assert.ok(out.includes("OCR บัตร/ใบขับขี่มั่นใจไม่สูง"));
  });
  test("includes parse warning label and suspicious plate label", () => {
    const out = buildVisitorWarnings({
      status: "complete",
      purposeText: "ส่งรับบ้าน",
      purposeCategory: "pickup",
      textParse: {warnings: ["pickup_text_interpreted"]},
      ocr: {personName: "นาย ทดสอบ", documentNumber: "1234", confidence: 0.95},
      vehicleCapture: {plateText: "70-4621"},
    });
    assert.ok(out.includes("ความหมายรับ-ส่งตีความจากข้อความ"));
    assert.ok(out.includes("ทะเบียนที่อ่านได้ดูผิดปกติ"));
  });
  test("labels inferred common-area operations", () => {
    const out = buildVisitorWarnings({
      status: "complete",
      purposeText: "รถขยะเข้ามา",
      purposeCategory: "utility",
      textParse: {warnings: ["common_area_inferred"]},
      ocr: {},
      vehicleCapture: {},
    });
    assert.ok(out.includes("ระบบตีความว่าเป็นงานส่วนกลาง"));
  });
});

describe("U-REPLY buildVisitorIntakeReply", () => {
  const complete = {
    houseNo: "38/8", purposeText: "ญาติมาเยี่ยม", purposeCategory: "guest",
    images: [img("document"), img("vehicle")],
    vehicleCapture: {plateText: "1กร4111กรุงเทพมหานคร"},
    ocr: {
      personName: "Miss Hathairat Tungtasana",
      thaiPersonName: "หทัยรัตน์ ตั้งทัศนา",
      englishPersonName: "Miss Hathairat Tungtasana",
    },
  };
  test("complete => ✅ + category label, not raw text", () => {
    const out = buildVisitorIntakeReply(complete);
    assert.ok(out.includes("✅ บันทึกเรียบร้อย"));
    assert.ok(out.includes("แขก/ผู้มาติดต่อ"));
    assert.ok(out.includes("38/8"));
    assert.ok(out.includes("หทัยรัตน์ ตั้งทัศนา"));
    assert.ok(!out.includes("Miss Hathairat"));
    assert.ok(out.includes("1กร 4111 กรุงเทพ"));
    assert.ok(!out.includes("กรุงเทพมหานคร"));
    assert.ok(!out.includes("ขอบคุณครับ"));
    assert.ok(!out.endsWith("━━━━━━━━━━━━━"));
  });
  test("common area house shows 38/69 suffix", () => {
    const out = buildVisitorIntakeReply(Object.assign({}, complete, {
      houseNo: "38/69",
      purposeText: "ติดต่อนิติ/ส่วนกลาง",
      purposeCategory: "office",
    }));
    assert.ok(out.includes("ติดต่อบ้าน : 38/69 (ส่วนกลาง)"));
    assert.ok(out.includes("เหตุผล : ติดต่อนิติ/ส่วนกลาง"));
  });
  test("common area reply keeps parsed detail", () => {
    const out = buildVisitorIntakeReply(Object.assign({}, complete, {
      houseNo: "38/69",
      purposeText: "ติดต่อนิติ/ส่วนกลาง (ช่างลูกระนาด)",
      purposeCategory: "office",
    }));
    assert.ok(out.includes("ติดต่อบ้าน : 38/69 (ส่วนกลาง)"));
    assert.ok(out.includes(
        "เหตุผล : ติดต่อนิติ/ส่วนกลาง (ช่างลูกระนาด)",
    ));
  });
  test("contractor reply includes subtype in parentheses", () => {
    const out = buildVisitorIntakeReply(Object.assign({}, complete, {
      purposeText: "ช่างมาล้างแอร์",
      purposeCategory: "contractor",
    }));
    assert.ok(out.includes("เหตุผล : ช่าง/ซ่อมบำรุง (ล้างแอร์)"));
  });
  test("complete falls back to English name when Thai is unavailable", () => {
    const out = buildVisitorIntakeReply(Object.assign({}, complete, {
      ocr: {
        personName: "Miss Hathairat Tungtasana",
        englishPersonName: "Miss Hathairat Tungtasana",
      },
    }));
    assert.ok(out.includes("Miss Hathairat Tungtasana"));
  });
  test("vehicle image without plate asks for typed plate", () => {
    const out = buildVisitorIntakeReply(
        Object.assign({}, complete, {vehicleCapture: null}));
    assert.ok(out.includes("✅ บันทึกเรียบร้อย"));
    assert.ok(out.includes("ข้อมูลขาดบางส่วน"));
    assert.ok(out.includes("อ่านทะเบียนได้ไม่ชัดครับ"));
    assert.ok(!out.includes("🔢"));
  });
  test("unknown second image asks for a clearer plate image", () => {
    const out = buildVisitorIntakeReply({
      houseNo: "38/28",
      purposeText: "มาส่งอาหาร",
      purposeCategory: "food_delivery",
      images: [img("document"), img("other")],
      ocr: {personName: "นาย ณฐกร จินตะนานุช"},
    });
    assert.ok(out.includes("✅ บันทึกเรียบร้อย"));
    assert.ok(out.includes("ข้อมูลขาดบางส่วน"));
    assert.ok(out.includes("อ่านทะเบียนได้ไม่ชัดครับ"));
    assert.ok(out.includes("รบกวน รปภ ส่งรูปป้ายทะเบียนใหม่"));
    assert.ok(out.includes("พิมพ์ทะเบียนให้หน่อยครับ"));
  });
  test("pending image analysis does not build an in-progress notice", () => {
    const out = buildVisitorIntakeReply({
      houseNo: "38/28",
      purposeText: "ส่งอาหาร",
      images: [img("pending"), img("pending")],
    });
    assert.ok(!out.includes("รับข้อมูลแล้วครับ"));
    assert.ok(!out.includes("กำลังอ่านรูป"));
    assert.ok(!out.includes("พิมพ์ทะเบียนเพิ่มได้เลย"));
  });
  test("incomplete => asks for the missing items", () => {
    const out = buildVisitorIntakeReply({houseNo: "38/8"});
    assert.ok(out.includes("ยังบันทึก Visitor ไม่ครบครับ"));
    assert.ok(out.includes("รบกวนส่งข้อมูลที่ขาดเพิ่ม"));
    assert.ok(out.includes("เหตุผลที่มา"));
    assert.ok(out.includes("รูปบัตร"));
    assert.ok(out.includes("ถ้าส่งรูปไม่ได้ ให้พิมพ์บอกได้เลย"));
    assert.ok(!out.includes("✅"));
  });
  test("empty => lists every required item", () => {
    const out = buildVisitorIntakeReply({});
    assert.ok(out.includes("บ้านเลขที่"));
    assert.ok(out.includes("เหตุผลที่มา"));
    assert.ok(out.includes("รูปบัตร/ใบขับขี่"));
    assert.ok(out.includes("รูปรถ/ทะเบียน"));
  });
  test("reply shows both houses when one message mentions two houses", () => {
    const out = buildVisitorIntakeReply(Object.assign({}, complete, {
      houseNo: "38/1",
      houseNos: ["38/1", "38/7"],
    }));
    assert.ok(out.includes("🏠 ติดต่อบ้าน : 38/1, 38/7"));
  });
  test("plate-only evidence saves as partial", () => {
    const out = buildVisitorIntakeReply({
      houseNo: "38/27",
      purposeText: "มาส่งลูกบ้าน",
      purposeCategory: "pickup",
      vehicleCapture: {plateText: "ทส6337กรุงเทพ"},
    });
    assert.ok(out.includes("✅ บันทึกเรียบร้อย"));
    assert.ok(out.includes("ทะเบียน : ทส 6337 กรุงเทพ"));
    assert.ok(out.includes("ข้อมูลขาดบางส่วน : รูปบัตร/ใบขับขี่"));
    assert.ok(!out.includes("📋 ขอเพิ่มอีกนิด"));
  });
  test("resident no-scan exception reply does not ask for images", () => {
    const out = buildVisitorIntakeReply({
      houseNo: "38/42",
      purposeText: "บอกเป็นลูกบ้าน ไม่มีสแกนเข้า",
      intakeException: "resident_no_scan",
    });
    assert.ok(out.includes("✅ บันทึกเรียบร้อย"));
    assert.ok(out.includes("ลูกบ้าน/ไม่มีสแกนเข้า"));
    assert.ok(!out.includes("รบกวนส่งข้อมูลที่ขาดเพิ่ม"));
  });
});

describe("U-SESSION shouldStartNewVisitorLog", () => {
  test("complete log + new house text starts a fresh log", () => {
    assert.strictEqual(shouldStartNewVisitorLog(
        {status: "complete", houseNo: "38/34", purposeText: "ส่งอาหาร"},
        {houseNo: "38/14", purposeText: "ส่งอาหาร"},
    ), true);
  });
  test("complete log + same house with new purpose starts a fresh log", () => {
    assert.strictEqual(shouldStartNewVisitorLog(
        {status: "complete", houseNo: "38/14", purposeText: "ส่งอาหาร"},
        {houseNo: "38/14", purposeText: "รับคน"},
    ), true);
  });
  test("incomplete same-house log keeps collecting into same log", () => {
    assert.strictEqual(shouldStartNewVisitorLog(
        {status: "pending_image", houseNo: "38/14", purposeText: "ส่งอาหาร"},
        {houseNo: "38/14", purposeText: "ส่งอาหาร"},
    ), false);
  });
  test("different house text starts fresh before complete", () => {
    assert.strictEqual(shouldStartNewVisitorLog(
        {status: "pending_image", houseNo: "38/34", purposeText: "ส่งอาหาร"},
        {houseNo: "38/14", purposeText: "ส่งอาหาร"},
    ), true);
  });
  test("image after a complete log starts a fresh image batch", () => {
    assert.strictEqual(shouldStartNewVisitorImageLog(
        {status: "complete", houseNo: "38/43", purposeText: "มารับพัสดุ"},
    ), true);
    assert.strictEqual(shouldStartNewVisitorImageLog(
        {status: "pending_image", houseNo: "38/43", purposeText: "มารับพัสดุ"},
    ), false);
  });
  test("image after a filled pending log starts fresh", () => {
    assert.strictEqual(shouldStartNewVisitorImageLog({
      status: "pending_image",
      houseNo: "38/34",
      purposeText: "ส่งอาหาร",
      images: [img("document"), img("other")],
    }), true);
  });
  test("concurrent pending images stay in the active log", () => {
    assert.strictEqual(shouldStartNewVisitorImageLog({
      status: "pending_image",
      houseNo: "38/21",
      purposeText: "ส่งอาหาร",
      images: [
        {kind: "pending", analysisPending: true},
        {kind: "pending", analysisPending: true},
      ],
    }), false);
  });
});

describe("U-REPLY-NOW shouldReplyVisitorIntakeNow", () => {
  test("complete record replies immediately", () => {
    assert.strictEqual(shouldReplyVisitorIntakeNow(
        {status: "pending_image"},
        {status: "complete", images: [img("document"), img("vehicle")]},
        {houseNo: "38/12", purposeText: "ส่งพัสดุ"},
        "ok",
    ), true);
  });

  test("partial record replies when text completes one evidence side", () => {
    assert.strictEqual(shouldReplyVisitorIntakeNow(
        {status: "pending_image"},
        {
          status: "partial",
          houseNo: "38/27",
          purposeText: "มาส่งลูกบ้าน",
          vehicleCapture: {plateText: "ทส 6337 กรุงเทพ"},
        },
        {houseNo: "38/27", purposeText: "มาส่งลูกบ้าน"},
        "ok",
    ), true);
  });

  test("partial image result waits for the rest of the image burst", () => {
    assert.strictEqual(shouldReplyVisitorIntakeNow(
        {status: "pending_image"},
        {
          status: "partial",
          houseNo: "38/3",
          purposeText: "รับ-ส่ง",
          images: [img("vehicle")],
          vehicleCapture: {plateText: "7กฐ 9201 กรุงเทพ"},
        },
        null,
        "ok",
    ), false);
  });

  test("text does not reply while image analysis is pending", () => {
    const merged = {
      status: "pending_image",
      images: [img("document"), img("pending")],
      houseNo: "38/12",
      purposeText: "ส่งพัสดุ",
    };
    const reply = buildVisitorIntakeReply(merged);
    assert.strictEqual(shouldReplyVisitorIntakeNow(
        {status: "pending_image", lastReplyText: ""},
        merged,
        {houseNo: "38/12", purposeText: "ส่งพัสดุ"},
        reply,
    ), false);
  });

  test("same incomplete reminder text is not resent immediately", () => {
    const merged = {
      status: "pending_image",
      images: [img("document"), img("other")],
      houseNo: "38/12",
      purposeText: "ส่งพัสดุ",
    };
    const reply = buildVisitorIntakeReply(merged);
    assert.strictEqual(shouldReplyVisitorIntakeNow(
        {
          status: "pending_image",
          lastReplyText: reply,
          lastReplyAt: {toMillis: () => Date.now() - 5 * 1000},
        },
        merged,
        {houseNo: "38/12", purposeText: "ส่งพัสดุ"},
        reply,
    ), false);
  });

  test("same incomplete reminder text can be resent after cooldown", () => {
    const merged = {
      status: "pending_image",
      images: [img("document"), img("other")],
      houseNo: "38/12",
      purposeText: "ส่งพัสดุ",
    };
    const reply = buildVisitorIntakeReply(merged);
    assert.strictEqual(shouldReplyVisitorIntakeNow(
        {
          status: "pending_image",
          lastReplyText: reply,
          lastReplyAt: {toMillis: () => Date.now() - 31 * 1000},
        },
        merged,
        {houseNo: "38/12", purposeText: "ส่งพัสดุ"},
        reply,
    ), true);
  });
});

describe("U-URL visitorIntakeImageUrl", () => {
  const path = "visitor-intake/2026-06-30/abc/log1/msg1.jpg";
  test("valid inputs => token url with encoded path", () => {
    const url = visitorIntakeImageUrl(path, "tok-123", "pattra8.appspot.com");
    assert.ok(url.startsWith(
        "https://firebasestorage.googleapis.com/v0/b/pattra8.appspot.com/o/"));
    assert.ok(url.includes(encodeURIComponent(path)));
    assert.ok(url.includes("alt=media&token=tok-123"));
    assert.ok(!url.includes("/o/visitor-intake/")); // must be encoded
  });
  test("missing token => empty", () => {
    assert.strictEqual(visitorIntakeImageUrl(path, "", "b"), "");
  });
  test("missing bucket => empty", () => {
    assert.strictEqual(visitorIntakeImageUrl(path, "tok", ""), "");
  });
  test("missing path => empty", () => {
    assert.strictEqual(visitorIntakeImageUrl("", "tok", "b"), "");
  });
});

describe("U-QUOTA getCarQuota", () => {
  test("resident record quota overrides fallback", () => {
    assert.strictEqual(getCarQuota("38/8", {car_quota: 6}), 6);
    assert.strictEqual(getCarQuota("38/8", {carQuota: "7"}), 7);
  });

  test("house 38/19 has 4-car quota", () => {
    assert.strictEqual(getCarQuota("38/19"), 4);
    assert.strictEqual(getCarQuota(" 38 / 19 "), 4);
  });

  test("house 38/41 has 5-car quota", () => {
    assert.strictEqual(getCarQuota("38/41"), 5);
    assert.strictEqual(getCarQuota(" 38 / 41 "), 5);
  });

  test("other houses keep default 3-car quota", () => {
    assert.strictEqual(getCarQuota("38/8"), 3);
  });
});

describe("U-KEY getTargetIdFromSource", () => {
  test("group precedence", () => {
    assert.strictEqual(getTargetIdFromSource(
        {groupId: "G1", userId: "U1"}), "G1");
  });
  test("room when no group", () => {
    assert.strictEqual(getTargetIdFromSource(
        {roomId: "R1", userId: "U1"}), "R1");
  });
  test("user when solo", () => {
    assert.strictEqual(getTargetIdFromSource({userId: "U1"}), "U1");
  });
  test("nothing => null", () => {
    assert.strictEqual(getTargetIdFromSource({}), null);
  });
});
