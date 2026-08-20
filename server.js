// Quốc Hòa Obf - Backend (Express)
// Auth + kho lưu script theo user + proxy obfuscate API + raw link public/private
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const API_URL = "https://xhider.xyz/nzcat.php/api/obfuscate";
const DEFAULT_USERNAME = process.env.OBF_USERNAME || "quochoa0912";

// ===== Static & body =====
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.json({ limit: "8mb" }));
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));
else app.use(express.static(__dirname));

// ===== In-memory store (mất khi restart/sleep trên Render free) =====
const users = new Map();      // username -> { passwordHash, salt, createdAt }
const tokens = new Map();     // token -> username
const scripts = new Map();    // id -> script object

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function genId(len = 8) { return crypto.randomBytes(len).toString("hex"); }
function getBaseUrl(req) {
  return `${req.get("x-forwarded-proto") || req.protocol}://${req.get("host")}`;
}

// ===== Auth middleware =====
function auth(req, res, next) {
  const h = req.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  const username = token && tokens.get(token);
  if (!username) return res.status(401).json({ error: "Chưa đăng nhập" });
  const user = users.get(username);
  if (!user) return res.status(401).json({ error: "Token không hợp lệ" });
  req.user = { username };
  next();
}

// ===== Auth routes =====
app.post("/api/auth/register", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Thiếu username hoặc password" });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
    return res.status(400).json({ error: "Username 3-20 ký tự, chỉ chữ/số/gạch dưới" });
  if (password.length < 4) return res.status(400).json({ error: "Password tối thiểu 4 ký tự" });
  if (users.has(username)) return res.status(409).json({ error: "Username đã tồn tại" });

  const salt = crypto.randomBytes(16).toString("hex");
  users.set(username, { passwordHash: hashPassword(password, salt), salt, createdAt: Date.now() });
  const token = genId(24);
  tokens.set(token, username);
  res.json({ success: true, token, username });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = users.get(username);
  if (!user) return res.status(401).json({ error: "Sai username hoặc password" });
  if (user.passwordHash !== hashPassword(password, user.salt))
    return res.status(401).json({ error: "Sai username hoặc password" });
  const token = genId(24);
  tokens.set(token, username);
  res.json({ success: true, token, username });
});

app.post("/api/auth/logout", auth, (req, res) => {
  const h = req.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (token) tokens.delete(token);
  res.json({ success: true });
});

app.get("/api/me", auth, (req, res) => {
  const myScripts = [...scripts.values()]
    .filter(s => s.username === req.user.username)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(s => ({ id: s.id, name: s.name, visibility: s.visibility, preset: s.preset,
      hasObfuscated: !!s.obfuscated, createdAt: s.createdAt, updatedAt: s.updatedAt,
      size: (s.obfuscated || s.content || "").length }));
  res.json({ username: req.user.username, scripts: myScripts });
});

// ===== Script CRUD (kho lưu source của user) =====
app.get("/api/scripts", auth, (req, res) => {
  const list = [...scripts.values()]
    .filter(s => s.username === req.user.username)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ scripts: list });
});

app.get("/api/scripts/:id", auth, (req, res) => {
  const s = scripts.get(req.params.id);
  if (!s || s.username !== req.user.username) return res.status(404).json({ error: "Không tìm thấy script" });
  res.json(s);
});

app.post("/api/scripts", auth, (req, res) => {
  const { name = "Untitled", content = "" } = req.body || {};
  const id = genId();
  const now = Date.now();
  const s = {
    id, username: req.user.username, name: String(name).slice(0, 80),
    content, obfuscated: "", visibility: "public", preset: "R4",
    rawUrl: "", createdAt: now, updatedAt: now,
  };
  scripts.set(id, s);
  res.json(s);
});

app.put("/api/scripts/:id", auth, (req, res) => {
  const s = scripts.get(req.params.id);
  if (!s || s.username !== req.user.username) return res.status(404).json({ error: "Không tìm thấy script" });
  const { name, content, visibility, preset } = req.body || {};
  if (name !== undefined) s.name = String(name).slice(0, 80);
  if (content !== undefined) s.content = content;
  if (visibility) s.visibility = visibility === "private" ? "private" : "public";
  if (preset) s.preset = preset;
  s.updatedAt = Date.now();
  res.json(s);
});

app.delete("/api/scripts/:id", auth, (req, res) => {
  const s = scripts.get(req.params.id);
  if (!s || s.username !== req.user.username) return res.status(404).json({ error: "Không tìm thấy script" });
  scripts.delete(req.params.id);
  res.json({ success: true });
});

// ===== Obfuscate (cần đăng nhập, lưu vào kho user) =====
app.post("/api/obfuscate", auth, async (req, res) => {
  try {
    const {
      preset = "R4", content = "", visibility = "public", name = "", id = null
    } = req.body || {};

    if (!content || !content.trim()) return res.status(400).json({ error: "Thiếu nội dung code" });
    if (!["public", "private"].includes(visibility))
      return res.status(400).json({ error: "visibility phải public/private" });

    // Gọi API xhider (proxy tránh CORS)
    const apiRes = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset, content, username: DEFAULT_USERNAME }),
    });
    const text = await apiRes.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    if (!apiRes.ok) {
      const msg = (data && (data.message || data.error)) || `API lỗi HTTP ${apiRes.status}`;
      return res.status(apiRes.status).json({ error: msg });
    }
    let result = "";
    if (typeof data === "string") result = data;
    else if (data) result = data.result ?? data.output ?? data.content ?? data.data ?? data.obfuscated ?? text;
    if (!result || !String(result).trim()) return res.status(502).json({ error: "API trả về rỗng" });
    result = String(result);

    // Tạo mới hoặc cập nhật script trong kho user
    let s = id ? scripts.get(id) : null;
    if (s && s.username !== req.user.username) s = null;
    const now = Date.now();
    if (!s) {
      s = {
        id: genId(), username: req.user.username,
        name: name ? String(name).slice(0, 80) : "Untitled",
        content, obfuscated: result, visibility, preset,
        rawUrl: "", createdAt: now, updatedAt: now,
      };
      scripts.set(s.id, s);
    } else {
      s.content = content; s.obfuscated = result;
      s.visibility = visibility; s.preset = preset;
      if (name) s.name = String(name).slice(0, 80);
      s.updatedAt = now;
    }
    s.rawUrl = `${getBaseUrl(req)}/raw/${s.id}`;

    res.json({
      success: true, id: s.id, name: s.name, rawUrl: s.rawUrl,
      visibility, preset, length: result.length, result,
    });
  } catch (err) {
    console.error("Obfuscate error:", err);
    res.status(500).json({ error: err.message || "Lỗi server" });
  }
});

// ===== RAW link =====
// public  -> ai cũng thấy code obf
// private -> browser: trang cảnh báo tự đẩy về trang chính; loader (game:HttpGet): VẪN trả code obf
app.get("/raw/:id", (req, res) => {
  const s = scripts.get(req.params.id);
  const base = getBaseUrl(req);
  if (!s) return sendBlocked(res, base, "Script không tồn tại hoặc đã bị xoá.", "Không tìm thấy", 404);
  if (s.visibility === "private" && isBrowser(req))
    return sendBlocked(res, base, "Script này đang ở chế độ RIÊNG TƯ. Không thể xem trực tiếp trên trình duyệt.", "🔒 Script riêng tư", 403);

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(s.obfuscated || s.content || "");
});

function isBrowser(req) {
  const accept = (req.get("accept") || "").toLowerCase();
  if (accept.includes("text/html")) return true;
  if ((req.get("sec-fetch-mode") || "").toLowerCase() === "navigate") return true;
  return false;
}

function sendBlocked(res, base, message, title, status) {
  res.status(status).setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="3;url=${base}/">
<title>${title} — Quốc Hòa Obf</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:grid;place-items:center;
 background:radial-gradient(800px 400px at 50% -10%,rgba(255,92,124,.18),transparent),
 radial-gradient(800px 400px at 50% 110%,rgba(124,92,255,.18),transparent),#0b0f17;color:#e6edf7;padding:20px}
.card{max-width:480px;width:100%;text-align:center;background:linear-gradient(180deg,#0f1623,#131c2e);
 border:1px solid #2a1f2d;border-radius:18px;padding:42px 30px;box-shadow:0 20px 60px rgba(0,0,0,.6);animation:pop .4s ease}
@keyframes pop{from{transform:translateY(10px);opacity:0}to{transform:none;opacity:1}}
.lock{width:80px;height:80px;margin:0 auto 20px;border-radius:50%;background:rgba(255,92,124,.14);
 display:grid;place-items:center;font-size:40px;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}
h1{font-size:22px;margin-bottom:10px;background:linear-gradient(135deg,#ff5c7c,#ffb84d);
 -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
p{color:#aab4c8;font-size:14px;line-height:1.65;margin-bottom:10px}
.count{color:#8a99b5;font-size:13px;margin-bottom:24px}.count b{color:#ff5c7c}
a.btn{display:inline-block;background:linear-gradient(135deg,#7c5cff,#5b8bff);color:#fff;text-decoration:none;
 padding:13px 28px;border-radius:12px;font-weight:600;font-size:14px;box-shadow:0 8px 24px rgba(124,92,255,.45)}
a.btn:hover{transform:translateY(-2px)}
.foot{margin-top:26px;font-size:12px;color:#56657f}
.bar{height:4px;background:rgba(255,255,255,.06);border-radius:99px;margin:0 auto 24px;max-width:200px;overflow:hidden}
.bar i{display:block;height:100%;width:100%;background:linear-gradient(90deg,#ff5c7c,#7c5cff);animation:shrink 3s linear forwards;transform-origin:left}
@keyframes shrink{from{transform:scaleX(1)}to{transform:scaleX(0)}}
</style></head><body><div class="card"><div class="lock">🔒</div><h1>${title}</h1><p>${message}</p>
<div class="bar"><i></i></div><p class="count">Tự động quay về trang chính sau <b id="s">3</b> giây...</p>
<a class="btn" href="${base}/">← Về trang chính Quốc Hòa Obf</a>
<div class="foot">Quốc Hòa Obf · Powered by xhider.xyz</div></div>
<script>(function(){var n=3,el=document.getElementById('s');var t=setInterval(function(){n--;if(el)el.textContent=n;
if(n<=0){clearInterval(t);window.location.href='${base}/';}},1000);})();</script>
</body></html>`);
}

app.get("/", (req, res) => {
  const idx = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(idx)) return res.sendFile(idx);
  const root = path.join(__dirname, "index.html");
  if (fs.existsSync(root)) return res.sendFile(root);
  res.status(404).send("Không tìm thấy index.html");
});

app.listen(PORT, () => console.log(`🔒 Quốc Hòa Obf chạy tại http://localhost:${PORT}`));
