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
 
