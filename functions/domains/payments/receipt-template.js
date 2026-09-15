/* eslint-disable */
// Moved verbatim out of index.js (which disables lint for this section);
// reformatting an HTML template by hand risks changing what it renders.

/**
 * The receipt document.
 *
 * Lives in its own module so the Cloud Function and one-off maintenance
 * scripts render the exact same document — a receipt re-rendered by a script
 * must not drift from one issued by the backend.
 */

const PP_BLOCK = "38";

const PP_MONTHS_FULL = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน",
  "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม",
  "พฤศจิกายน", "ธันวาคม"];
const PP_MONTHS = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];

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

/**
 * Spell a "YYYY-MM" period out in full — a receipt is filed and argued over
 * later, so it says "กันยายน 2026", not "ก.ย. 2026".
 * @param {string} period period key
 * @return {string} full Thai month and year
 */
function ppFullMonth(period) {
  const [y, m] = String(period || "").split("-");
  const name = PP_MONTHS_FULL[parseInt(m, 10) - 1];
  return name ? `${name} ${y}` : String(period || "");
}

function ppPeriodLabel(p) {
  // A receipt covering several months names the whole span it paid for.
  if (Array.isArray(p.periods) && p.periods.length > 1) {
    return `${ppFullMonth(p.periods[0])} – ` +
      `${ppFullMonth(p.periods[p.periods.length - 1])}`;
  }
  if (p.periodLabel) return p.periodLabel;
  if (p.feeType === "common") {
    return p.period === "H1" ? "ครึ่งปีแรก (ม.ค.–มิ.ย.)" : "ครึ่งปีหลัง (ก.ค.–ธ.ค.)";
  }
  return ppFullMonth(p.period);
}

function ppMoney(n) {
  return Number(n).toLocaleString("th-TH", {minimumFractionDigits: 2});
}

function ppInstallmentLine(p) {
  if (!p.installmentTotal) return "";
  const remaining = Number(p.installmentRemaining);
  const tail = Number.isFinite(remaining) && remaining > 0 ?
    `คงเหลือ ฿${ppMoney(remaining)}` : "ชำระครบแล้ว";
  return `<br/>ผ่อนชำระ · ชำระแล้ว ฿${ppMoney(p.installmentPaid)} ` +
    `จาก ฿${ppMoney(p.installmentTotal)} · ${tail}`;
}

function ppReceiptHtml(p) {
  const house = `${PP_BLOCK}/${p.houseNo}`;
  const dateStr = new Date(p.verifiedAt || Date.now())
      .toLocaleDateString("th-TH-u-ca-gregory", {day: "numeric", month: "long", year: "numeric"});
  const fee = p.feeType === "common" ? "ค่าส่วนกลาง" : "ค่าจอดรถ";
  const months = Array.isArray(p.periods) && p.periods.length > 1 ?
    p.periods.length : 1;
  const amt = ppMoney(p.amount);
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ใบเสร็จรับเงิน ${p.receiptNo || ""}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sriracha&family=Cormorant+Garamond:wght@500;600;700&family=IBM+Plex+Sans+Thai:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"IBM Plex Sans Thai",system-ui,sans-serif;color:#2a2218;background:#efe7d8;margin:0;padding:0;-webkit-font-smoothing:antialiased}
.page{background:#efe7d8}
.num{font-family:"IBM Plex Sans Thai",system-ui,sans-serif;font-feature-settings:"lnum" 1,"tnum" 1}
.doc{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e0d3ba;border-radius:22px;overflow:hidden;box-shadow:0 20px 50px rgba(80,60,30,.14)}
.bar{height:6px;background:linear-gradient(90deg,#d4913f,#c47a2c)}
.brand{padding:28px 30px 0;text-align:center}
.wm{font-family:"Cormorant Garamond",serif;font-size:40px;font-weight:600;letter-spacing:.05em;color:#2a2218;line-height:1}
.wmsub{font-size:14.5px;color:#6b5d4a;margin-top:7px}
.doctitle{width:100%;border-collapse:collapse}
.doctitle .rule{border-bottom:1px solid #e6dcc7;width:50%;font-size:0;line-height:0}
.doctitle .ttl{white-space:nowrap;padding:0 14px;text-align:center;font-size:19px;font-weight:600;color:#c47a2c}
.doctitle .ttlfee{display:block;font-size:23px;font-weight:700;color:#2a2218;margin-top:5px}
.docmeta{margin:13px 30px 0;text-align:center;font-size:13.5px;color:#6b5d4a}
.paid{display:inline-block;background:#e2ecd6;color:#4a6238;font-size:12.5px;font-weight:600;padding:5px 13px;border-radius:999px;white-space:nowrap;margin-right:8px}
.rno2 b{color:#2a2218;font-weight:600}
.hero{padding:20px 30px 16px;text-align:center}
.hero .l{font-size:14.5px;color:#6b5d4a;letter-spacing:.01em}
.hero .h{font-size:46px;font-weight:700;color:#2a2218;line-height:1.05;margin:6px 0 4px;letter-spacing:.01em}
.hero .p{font-size:13.5px;color:#8a7b66}
.hero .per{font-size:19px;font-weight:700;color:#2a2218;margin:2px 0 4px;letter-spacing:.01em}
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

  /* Receipt hierarchy: plain Thai heading, distinct fee type, quiet reference. */
  .doctitle .ttl{font-family:"IBM Plex Sans Thai",Tahoma,sans-serif;font-size:18px;font-weight:500;letter-spacing:normal;line-height:1.65;white-space:normal;padding:0 10px;color:#6b5d4a}
  .doctitle .ttlfee{font-family:"IBM Plex Sans Thai",Tahoma,sans-serif;font-size:32px;font-weight:700;letter-spacing:normal;line-height:1.5;color:#a45f1c;margin-top:2px;white-space:nowrap}
  .hero .h{font-size:36px;line-height:1.3}
  .paid{margin-right:0}
  .receipt-reference{padding:0 24px 18px;text-align:right;font-size:10px;line-height:1.6;color:#786e61;overflow-wrap:anywhere}
  .receipt-parking .bar{background:#397568}
  .receipt-parking .ttlfee,.receipt-parking .amtline .v{color:#2f6b5d}
  .receipt-parking .amtline{background:#f0f7f4;border-color:#d4e5dd}
  @media(max-width:420px){.brand{padding:22px 16px 0}.wm{font-size:32px}.wmsub{font-size:13px}.doctitle .ttlfee{font-size:28px}.hero{padding:16px}.amtline{margin:0 16px;padding:14px 12px}.amtline .k{font-size:12px}.amtline .v{font-size:24px}.klist{margin:16px 16px 0}.krow td{font-size:13px}.foot{margin:14px 16px 20px}.foot .note{font-size:10px}.sign .sig{font-size:15px}}


  /* Compact receipt spacing, retaining readable Thai text. */
  .brand{padding:18px 24px 0}
  .wm{font-size:32px}
  .wmsub{font-size:13px;margin-top:4px}
  .brand + div{padding-top:10px!important}
  .doctitle .ttl{font-size:16px;line-height:1.5}
  .doctitle .ttlfee{font-size:28px;line-height:1.4;margin-top:0}
  .docmeta{margin-top:7px}
  .paid{padding:3px 11px;font-size:11.5px}
  .hero{padding:10px 24px 12px}
  .hero .l,.hero .h{display:inline-block;vertical-align:baseline}
  .hero .l{font-size:13px;margin-right:8px}
  .hero .h{font-size:28px;line-height:1.3;margin:0 0 4px}
  .hero .p{font-size:13px;line-height:1.5}
  .hero .per{font-size:17px;line-height:1.5;margin:0}
  .amtline{padding:11px 16px}
  .amtline .v{font-size:26px}
  .words{margin-top:6px;font-size:12.5px}
  .klist{margin-top:10px}
  .krow td{padding:7px 0;font-size:13px}
  .foot{margin-top:10px;margin-bottom:12px;padding-top:10px}
  .sign .sig{font-size:17px}
  .receipt-reference{padding-bottom:12px}
  @media(max-width:420px){.brand{padding:16px 16px 0}.wm{font-size:29px}.hero{padding:9px 16px 10px}.amtline{padding:10px 12px}.amtline .v{font-size:24px}.klist{margin-top:8px}.foot{margin-top:8px;margin-bottom:10px}.sign .sig{font-size:15px}}


  .receipt-logo{position:relative;width:290px;max-width:100%;height:44px;overflow:hidden;margin:0 auto}
  .receipt-logo img{position:absolute;width:480px;max-width:none;height:480px;left:50%;top:-184px;transform:translateX(-50%)}
  .hero .period-inline{font-size:14px;line-height:1.6;color:#6b5d4a}
  .hero .period-inline b{font-size:16px;color:#2a2218;font-weight:600}

@media print{body,.page{background:#fff}.doc{box-shadow:none;border:0;border-radius:0}}</style></head>
<body>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#efe7d8" class="page"><tr><td align="center" style="padding:28px 16px">
<div class="doc ${p.feeType === "parking" ? "receipt-parking" : "receipt-common"}">
<div class="bar"></div>
<div class="brand"><div class="receipt-logo"><img src="https://pattra8.com/myreceipt/assets/pattra-villa-logo.jpg" alt="Pattra Villa" width="480" height="480"></div></div>
<div style="padding:20px 30px 0"><table class="doctitle" role="presentation" cellpadding="0" cellspacing="0"><tr><td class="rule"></td><td class="ttl">ใบเสร็จรับเงิน<span class="ttlfee">${fee}</span></td><td class="rule"></td></tr></table></div>
<div class="docmeta"><span class="paid">✓ ชำระแล้ว</span></div>
<div class="hero"><div class="l">บ้านเลขที่</div><div class="h num">${PP_BLOCK} / ${p.houseNo}</div><div class="period-inline">งวด <b>${ppPeriodLabel(p)}</b></div>${months > 1 ? `<div class="p">รวม ${months} เดือน</div>` : ""}${ppInstallmentLine(p) ? `<div class="p">${ppInstallmentLine(p)}</div>` : ""}</div>
<div class="amtline"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td class="k">จำนวนเงินที่ได้รับ</td><td class="v num">฿${amt}</td></tr></table></div>
<div class="words">(${ppBahtText(p.amount)})</div>
<div class="klist">
<table class="krow" role="presentation" cellpadding="0" cellspacing="0"><tr><td class="k">ใบเสร็จในนาม</td><td class="v">${p.payerName || "บ้าน " + house}</td></tr></table>
<table class="krow" role="presentation" cellpadding="0" cellspacing="0"><tr><td class="k">วันที่</td><td class="v">${dateStr}</td></tr></table>
<table class="krow" role="presentation" cellpadding="0" cellspacing="0"><tr><td class="k">โอนผ่าน</td><td class="v">ธนาคารไทยพาณิชย์ (SCB)</td></tr></table>
</div>
<div class="foot"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td class="note">ได้รับเงินไว้เป็นการถูกต้องแล้ว</td>
<td class="signcell"><div class="sign"><div class="sig">กรรมการนิติบุคคล ชุด 5</div><div class="line"></div><div class="cap">ผู้รับเงิน</div></div></td></tr></table></div>
${p.receiptNo ? `<div class="receipt-reference num">เลขที่ใบเสร็จ ${p.receiptNo}</div>` : ""}
</div>
</td></tr></table>
</body></html>`;
}

module.exports = {
  PP_BLOCK,
  MONTHS_FULL: PP_MONTHS_FULL,
  MONTHS: PP_MONTHS,
  bahtText: ppBahtText,
  fullMonth: ppFullMonth,
  periodLabel: ppPeriodLabel,
  money: ppMoney,
  renderReceiptHtml: ppReceiptHtml,
};
