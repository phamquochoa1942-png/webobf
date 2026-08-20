// Quốc Hòa Obf - Backend (Express)
// Deploy lên Render: chạy `npm install && npm start`
const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const API_URL = "https://xhider.xyz/nzcat.php/api/obfuscate";
const USERNAME = process.env.OBF_USERNAME || "quochoa0912";

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ===== Kho lưu script (in-memory) =====
// Render free tier sẽ xoá khi redeploy/sleep. Nếu muốn bền, gắn database ngoài.
const scripts = new Map();

function genId() {
  return crypto.randomBytes(6).toString("hex"); // 12 ký tự
}

function getBaseUrl(req) {
  const proto = req.get("x-forwarded-proto") || req.protocol;
  return `${proto}://${req.get("host")}`;
}

// ===== API: Obfuscate =====
app.post("/api/obfuscate", async (req, res) => {
  try {
    const { preset = "R4", content = "", visibility = "public" } = req.body || {};

    if (!content || !content.trim()) {
      return res.status(400).json({ error: "Thiếu nội dung code" });
    }
    if (!["public", "private"].includes(visibility)) {
      return res.status(400).json({ error: "visibility phải là 'public' hoặc 'private'" });
    }

    // Gọi API xhider (proxy để tránh CORS)
    const apiRes = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset, content, username: USERNAME }),
    });

    const text = await apiRes.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }

    if (!apiRes.ok) {
      const msg = (data && (data.message || data.error)) || `API lỗi HTTP ${apiRes.status}`;
      return res.status(apiRes.status).json({ error: msg });
    }

    let result = "";
    if (typeof data === "string") result = data;
    else if (data) {
      result = data.result ?? data.output ?? data.content ?? data.data ?? data.obfuscated ?? text;
    } else result = text;

    if (!result || !String(result).trim()) {
      return res.status(502).json({ error: "API trả về kết quả rỗng" });
    }
    result = String(result);

    // Lưu script
    const id = genId();
    scripts.set(id, {
      id,
      result,
      visibility,
      preset,
      createdAt: new Date().toISOString(),
    });

    const rawUrl = `${getBaseUrl(req)}/raw/${id}`;
    res.json({
      success: true,
      id,
      rawUrl,
      visibility,
      preset,
      length: result.length,
      result,
    });
  } catch (err) {
    console.error("Obfuscate error:", err);
    res.status(500).json({ error: err.message || "Lỗi server" });
  }
});

// ===== API: Xem thông tin script (cho trang hiển thị) =====
app.get("/api/scripts/:id", (req, res) => {
  const s = scripts.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Không tìm thấy script" });
  res.json({
    id: s.id,
    visibility: s.visibility,
    preset: s.preset,
    createdAt: s.createdAt,
    length: s.result.length,
  });
});

// ===== RAW: Lấy script để chạy =====
// - public: ai cũng xem được (browser và script loader đều thấy code obf)
// - private:
//     + Browser (dán link lên Chrome/Cốc Cốc/Edge...) -> trang cảnh báo, tự động đẩy về trang chính
//     + Script loader (game:HttpGet / curl / non-browser) -> VẪN trả code obf để script chạy bình thường
app.get("/raw/:id", (req, res) => {
  const s = scripts.get(req.params.id);
  const base = getBaseUrl(req);

  if (!s) {
    return sendBlockedPage(res, base,
      "Script không tồn tại hoặc đã bị xoá.",
      "Không tìm thấy script", 404);
  }

  // Nếu là riêng tư VÀ request đến từ trình duyệt -> chặn, đẩy về trang chính
  if (s.visibility === "private" && isBrowser(req)) {
    return sendBlockedPage(res, base,
      "Script này đang ở chế độ RIÊNG TƯ. Bạn không thể xem trực tiếp trên trình duyệt.",
      "🔒 Script riêng tư", 403);
  }

  // Mọi trường hợp còn lại (public, hoặc private gọi từ script loader) -> trả code obf
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(s.result);
});

// Nhận diện trình duyệt: kiểm tra Accept có chứa text/html (script loader thường gửi '*\/*' hoặc không gửi)
function isBrowser(req) {
  const accept = (req.get("accept") || "").toLowerCase();
  const secFetch = (req.get("sec-fetch-mode") || "").toLowerCase();
  // Trình duyệt luôn gửi Accept chứa text/html khi gõ link vào thanh địa chỉ
  if (accept.includes("text/html")) return true;
  // sec-fetch-mode: navigate chắc chắn là browser điều hướng
  if (secFetch === "navigate") return true;
  return false;
}

// Trang cảnh báo cho người mở link raw bằng trình duyệt -> tự đẩy về trang chính
function sendBlockedPage(res, base, message, title = "🔒 Script riêng tư", status = 403) {
  res.status(status).setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Quốc Hòa Obf</title>
<meta http-equiv="refresh" content="3;url=${base}/">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    min-height: 100vh; display: grid; place-items: center;
    background: radial-gradient(800px 400px at 50% -10%, rgba(255,92,124,.18), transparent),
                radial-gradient(800px 400px at 50% 110%, rgba(124,92,255,.18), transparent),
                #0b0f17;
    color: #e6edf7; padding: 20px; }
  .card { max-width: 480px; width: 100%; text-align: center;
    background: linear-gradient(180deg,#0f1623,#131c2e);
    border: 1px solid #2a1f2d; border-radius: 18px; padding: 42px 30px;
    box-shadow: 0 20px 60px rgba(0,0,0,.6);
    animation: pop .4s ease; }
  @keyframes pop { from { transform: translateY(10px); opacity: 0; } to { transform: none; opacity: 1; } }
  .lock { width: 80px; height: 80px; margin: 0 auto 20px; border-radius: 50%;
    background: rgba(255,92,124,.14); display: grid; place-items: center;
    font-size: 40px; animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.08); } }
  h1 { font-size: 22px; margin-bottom: 10px;
    background: linear-gradient(135deg,#ff5c7c,#ffb84d);
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
  p { color: #aab4c8; font-size: 14px; line-height: 1.65; margin-bottom: 10px; }
  .count { color: #8a99b5; font-size: 13px; margin-bottom: 24px; }
  .count b { color: #ff5c7c; }
  a.btn { display: inline-block; background: linear-gradient(135deg,#7c5cff,#5b8bff);
    color: #fff; text-decoration: none; padding: 13px 28px; border-radius: 12px;
    font-weight: 600; font-size: 14px; box-shadow: 0 8px 24px rgba(124,92,255,.45);
    transition: transform .15s; }
  a.btn:hover { transform: translateY(-2px); }
  .foot { margin-top: 26px; font-size: 12px; color: #56657f; }
  .bar { height: 4px; background: rgba(255,255,255,.06); border-radius: 99px;
    margin: 0 auto 24px; max-width: 200px; overflow: hidden; }
  .bar i { display: block; height: 100%; width: 100%;
    background: linear-gradient(90deg,#ff5c7c,#7c5cff);
    animation: shrink 3s linear forwards; transform-origin: left; }
  @keyframes shrink { from { transform: scaleX(1); } to { transform: scaleX(0); } }
</style></head>
<body>
  <div class="card">
    <div class="lock">🔒</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <div class="bar"><i></i></div>
    <p class="count">Tự động quay về trang chính sau <b id="s">3</b> giây...</p>
    <a class="btn" href="${base}/">← Về trang chính Quốc Hòa Obf</a>
    <div class="foot">Quốc Hòa Obf · Powered by xhider.xyz</div>
  </div>
  <script>
    (function(){
      var s = 3;
      var el = document.getElementById('s');
      var t = setInterval(function(){
        s--; if (el) el.textContent = s;
        if (s <= 0) { clearInterval(t); window.location.href = '${base}/'; }
      }, 1000);
    })();
  </script>
</body></html>`);
}

// Khoi dong
app.listen(PORT, () => {
  console.log(`🔒 Quốc Hòa Obf đang chạy tại http://localhost:${PORT}`);
});
