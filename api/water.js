// api/water.js
// Serverless proxy + cache สำหรับดึงข้อมูลจาก ThaiWater (api-v3.thaiwater.net) มาให้หน้าเว็บ
// เหตุผลที่ต้องมี proxy นี้ (ไม่ใช่เพราะ CORS — ThaiWater อนุญาตให้เว็บอื่นเรียกตรงได้อยู่แล้ว):
//   1) endpoint บางตัว (rain_today / rain_monthly / rain_yearly / analyst/dam) ส่งข้อมูลทั้งประเทศ
//      (~1–4 MB ต่อครั้ง) ทั้งที่หน้าเว็บนี้ใช้แค่จังหวัดยโสธร (~10–20 รายการ) จึงกรองที่นี่ก่อนส่งกลับ
//   2) ตั้ง Cache-Control ให้ Vercel Edge Network แคชคำตอบไว้สั้น ๆ ผู้ใช้หลายคนพร้อมกันจะไม่ยิง
//      ไปที่ ThaiWater ซ้ำทุกครั้ง — ดู https://vercel.com/docs/functions/serverless-functions/edge-caching
//      และ https://vercel.com/docs/caching/cache-control-headers (แคชได้จริงหรือไม่ขึ้นกับแผนบัญชีของคุณ
//      ให้ตรวจสอบ response header "x-vercel-cache" หลัง deploy จริง)
//   3) จำกัด path ที่ proxy ยอมส่งต่อ (whitelist) กันไม่ให้ endpoint นี้ถูกใช้เป็น open proxy ไปที่อื่น

const UPSTREAM_BASE = "https://api-v3.thaiwater.net/api/v1/thaiwater30/";
const PROVINCE = "35"; // รหัสจังหวัดยโสธร — เปลี่ยนที่นี่ถ้าจะทำจังหวัดอื่น

// path (ไม่รวม query) ที่อนุญาตให้ proxy ไปเรียกต่อได้ + อายุแคชที่ Vercel Edge (วินาที)
const ALLOWED = {
  "public/rain_24h": { sMaxAge: 120, swr: 300 },
  "public/rain_today": { sMaxAge: 120, swr: 300, filterProvince: true },
  "public/rain_monthly": { sMaxAge: 3600, swr: 86400, filterProvince: true },
  "public/rain_yearly": { sMaxAge: 3600, swr: 86400, filterProvince: true },
  "public/waterlevel_load": { sMaxAge: 120, swr: 300 },
  "public/waterlevel_graph": { sMaxAge: 300, swr: 600 },
  "public/rain7day_forecast": { sMaxAge: 1800, swr: 3600 },
  "provinces/rain3d_graph": { sMaxAge: 300, swr: 600 },
  "provinces/rain7d_graph": { sMaxAge: 300, swr: 600 },
  "provinces/rain15d_graph": { sMaxAge: 300, swr: 600 },
  "analyst/dam": { sMaxAge: 900, swr: 1800, filterDam: true },
};

function provinceCodeOf(item) {
  return String((item && item.geocode && item.geocode.province_code) || "");
}

// ตัดข้อมูลทั้งประเทศให้เหลือเฉพาะยโสธร ก่อนส่งกลับ (ลดขนาด response เป็น 10 เท่าขึ้นไป)
function filterPayload(pathname, json) {
  if (ALLOWED[pathname].filterProvince && json && Array.isArray(json.data)) {
    return { ...json, data: json.data.filter((x) => provinceCodeOf(x) === PROVINCE) };
  }
  if (ALLOWED[pathname].filterDam && json && json.data && Array.isArray(json.data.dam_medium)) {
    // หน้าเว็บใช้แค่ dam_medium (อ่างเก็บน้ำขนาดกลาง) — ตัดกลุ่มอื่นที่ไม่ใช้ทิ้งเพื่อลดขนาดอีกชั้น
    return {
      ...json,
      data: { dam_medium: json.data.dam_medium.filter((x) => provinceCodeOf(x) === PROVINCE) },
    };
  }
  return json;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const raw = req.query && req.query.path;
  const rawPath = Array.isArray(raw) ? raw[0] : raw;
  if (!rawPath || typeof rawPath !== "string") {
    res.status(400).json({ error: "missing path" });
    return;
  }
  const pathname = rawPath.split("?")[0];
  const rule = ALLOWED[pathname];
  if (!rule) {
    res.status(400).json({ error: "path not allowed", pathname });
    return;
  }

  const upstreamUrl = UPSTREAM_BASE + rawPath;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(upstreamUrl, { signal: ctl.signal, headers: { accept: "application/json" } });
    clearTimeout(timer);
    if (!r.ok) {
      res.status(502).json({ error: "upstream error", status: r.status });
      return;
    }
    const json = await r.json();
    const out = filterPayload(pathname, json);
    res.setHeader(
      "Cache-Control",
      `public, s-maxage=${rule.sMaxAge}, stale-while-revalidate=${rule.swr}`
    );
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(out);
  } catch (e) {
    clearTimeout(timer);
    const timedOut = e && e.name === "AbortError";
    res.status(502).json({ error: timedOut ? "upstream timeout" : "fetch failed: " + e.message });
  }
};
