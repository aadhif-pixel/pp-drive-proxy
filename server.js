/*
  Pacific Power — Drive Proxy Backend
  ------------------------------------
  Purpose: lets the front-end HTML apps use ONE shared username/password
  instead of every teammate doing Google OAuth. This server holds a Google
  Service Account credential and talks to Drive on everyone's behalf.

  Endpoints:
    POST /api/login          { username, password } -> sets an httpOnly session cookie
    POST /api/logout         clears the cookie
    GET  /api/drive/file     ?name=<filename>  -> returns file content (JSON) or 404
    PUT  /api/drive/file     ?name=<filename>  -> upserts file content (creates if missing)
    GET  /api/drive/list     -> lists files (id, name, createdTime) in the shared folder

  All /api/drive/* routes require a valid session cookie.
  Session cookie is a signed, stateless token (HMAC) — no server-side session
  store needed, so it works fine across multiple Cloud Run instances/restarts.
*/

const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const { google } = require("googleapis");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());

// ---- config from environment ----
const {
  APP_USERNAME = "team",
  APP_PASSWORD,
  SESSION_SECRET,
  DRIVE_FOLDER_ID,
  ALLOWED_ORIGIN, // e.g. https://yourdomain.com  (comma-separated list allowed)
  GOOGLE_SERVICE_ACCOUNT_KEY, // full JSON key contents, as a string (from Secret Manager)
  PORT = 8080,
} = process.env;

if (!APP_PASSWORD || !SESSION_SECRET || !DRIVE_FOLDER_ID || !GOOGLE_SERVICE_ACCOUNT_KEY) {
  console.error(
    "Missing required env vars. Need APP_PASSWORD, SESSION_SECRET, DRIVE_FOLDER_ID, GOOGLE_SERVICE_ACCOUNT_KEY."
  );
}

// ---- CORS (only needed if the HTML files are hosted on a different origin than this backend) ----
const allowedOrigins = (ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.includes(origin) || allowedOrigins.includes("*"))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,PUT,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- stateless signed session token ----
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verify(token) {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const token = req.cookies?.pp_session;
  const session = verify(token);
  if (!session) return res.status(401).json({ error: "Not signed in." });
  next();
}

// ---- login / logout ----
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username !== APP_USERNAME || password !== APP_PASSWORD) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }
  const token = sign({ u: username, exp: Date.now() + SESSION_TTL_MS });
  res.cookie("pp_session", token, {
    httpOnly: true,
    secure: true,
    sameSite: "none", // needed if frontend is on a different origin than the backend
    maxAge: SESSION_TTL_MS,
  });
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("pp_session");
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const session = verify(req.cookies?.pp_session);
  res.json({ signedIn: !!session });
});

// ---- Google Drive client (service account) ----
let driveClientPromise = null;
function getDrive() {
  if (!driveClientPromise) {
    const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
    driveClientPromise = auth.getClient().then((authClient) => google.drive({ version: "v3", auth: authClient }));
  }
  return driveClientPromise;
}

async function findFile(drive, name) {
  const q = `name='${name.replace(/'/g, "\\'")}' and '${DRIVE_FOLDER_ID}' in parents and trashed=false`;
  const { data } = await drive.files.list({ q, fields: "files(id,name,createdTime)", orderBy: "createdTime" });
  return data.files || [];
}

// GET /api/drive/file?name=foo.json
app.get("/api/drive/file", requireAuth, async (req, res) => {
  try {
    const name = req.query.name;
    if (!name) return res.status(400).json({ error: "Missing ?name=" });
    const drive = await getDrive();
    const files = await findFile(drive, name);
    if (!files.length) return res.status(404).json({ error: "Not found" });
    const fileId = files[0].id;
    const { data } = await drive.files.get({ fileId, alt: "media" }, { responseType: "json" });
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Drive read failed", detail: e.message });
  }
});

// PUT /api/drive/file?name=foo.json   body: raw JSON to store
app.put("/api/drive/file", requireAuth, async (req, res) => {
  try {
    const name = req.query.name;
    if (!name) return res.status(400).json({ error: "Missing ?name=" });
    const drive = await getDrive();
    const files = await findFile(drive, name);
    const media = { mimeType: "application/json", body: JSON.stringify(req.body) };
    if (files.length) {
      await drive.files.update({ fileId: files[0].id, media });
      return res.json({ ok: true, fileId: files[0].id });
    }
    const created = await drive.files.create({
      requestBody: { name, parents: [DRIVE_FOLDER_ID], mimeType: "application/json" },
      media,
      fields: "id",
    });
    res.json({ ok: true, fileId: created.data.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Drive write failed", detail: e.message });
  }
});

// GET /api/drive/list — list json files in the shared folder
app.get("/api/drive/list", requireAuth, async (req, res) => {
  try {
    const drive = await getDrive();
    const q = `'${DRIVE_FOLDER_ID}' in parents and trashed=false and mimeType='application/json'`;
    const { data } = await drive.files.list({ q, fields: "files(id,name,createdTime,modifiedTime)" });
    res.json({ files: data.files || [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Drive list failed", detail: e.message });
  }
});

app.get("/", (req, res) => res.send("Pacific Power Drive proxy is running."));

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
