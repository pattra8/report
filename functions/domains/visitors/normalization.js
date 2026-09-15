"use strict";

const THAI_PROVINCES = Object.freeze([
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
].sort((a, b) => b.length - a.length));

/**
 * Normalizes one manually editable visitor name.
 * @param {*} raw Candidate name.
 * @return {string}
 */
function normalizeVisitorName(raw) {
  return String(raw || "").normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
}

/**
 * Normalizes Thai province names for visitor plate storage/display.
 * @param {*} raw Candidate province.
 * @return {string}
 */
function normalizeThaiProvince(raw) {
  const value = String(raw || "").trim();
  return value === "กรุงเทพมหานคร" ? "กรุงเทพ" : value;
}

/**
 * Normalizes a Thai plate candidate for display/storage.
 * @param {*} raw Candidate plate.
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
 * Produces the compact plate key used by LPR vehicle profiles.
 * @param {*} plateText Display/storage plate.
 * @return {string}
 */
function stripThaiProvinceForLookup(plateText) {
  let clean = String(plateText || "").replace(/\s+/g, "");
  for (const candidate of THAI_PROVINCES) {
    const normalized = normalizeThaiProvince(candidate);
    if (clean.includes(candidate)) {
      clean = clean.replace(candidate, "");
      break;
    }
    if (clean.includes(normalized)) {
      clean = clean.replace(normalized, "");
      break;
    }
  }
  return clean.toUpperCase();
}

/**
 * Normalizes vehicle type into committee-facing Thai buckets.
 * @param {*} raw Candidate vehicle type.
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
 * @param {*} raw Candidate document number.
 * @return {string}
 */
function maskDocumentNumber(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 4) return "";
  return `${"*".repeat(Math.max(4, digits.length - 4))}${digits.slice(-4)}`;
}

/**
 * Normalizes Thai ID / driver license OCR into digits-only storage.
 * @param {*} raw Candidate document number.
 * @return {string}
 */
function normalizeDocumentNumber(raw) {
  return String(raw || "").replace(/\D/g, "").slice(0, 20);
}

module.exports = {
  maskDocumentNumber,
  normalizeDocumentNumber,
  normalizeThaiProvince,
  normalizeVisitorName,
  normalizeVisitorPlate,
  normalizeVisitorVehicleType,
  stripThaiProvinceForLookup,
  THAI_PROVINCES,
};

