const http = require("http");
const fsSync = require("fs");
const fs = require("fs/promises");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { URL, URLSearchParams } = require("url");

loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = __dirname;
const DATA_DIR = path.join(__dirname, "data");
const JSON_FALLBACK_FILE = path.join(DATA_DIR, "contact-submissions.json");
const SQLITE_DB_PATH = path.join(DATA_DIR, "contact.db");
const MAX_BODY_BYTES = 25 * 1024;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 8);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf"
};

const rateLimitBuckets = new Map();
let storage = null;

function loadEnvFile(filePath) {
  if (!fsSync.existsSync(filePath)) {
    return;
  }

  const lines = fsSync.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function requireOptional(packageName) {
  try {
    return require(packageName);
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

function normalizeSqlServerConfig() {
  if (process.env.MSSQL_CONNECTION_STRING) {
    return process.env.MSSQL_CONNECTION_STRING;
  }

  if (!process.env.MSSQL_SERVER || !process.env.MSSQL_DATABASE) {
    return null;
  }

  return {
    server: process.env.MSSQL_SERVER,
    database: process.env.MSSQL_DATABASE,
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    port: Number(process.env.MSSQL_PORT || 1433),
    options: {
      encrypt: process.env.MSSQL_ENCRYPT !== "false",
      trustServerCertificate: process.env.MSSQL_TRUST_SERVER_CERTIFICATE === "true"
    }
  };
}

async function createSqlServerStorage() {
  const config = normalizeSqlServerConfig();
  if (!config) {
    return null;
  }

  const sql = requireOptional("mssql");
  if (!sql) {
    console.warn("SQL Server is configured, but the 'mssql' package is not installed.");
    return null;
  }

  const pool = await sql.connect(config);
  await pool.request().query(`
    IF OBJECT_ID(N'dbo.ContactSubmissions', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.ContactSubmissions (
        Id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        Name NVARCHAR(120) NOT NULL,
        Email NVARCHAR(254) NOT NULL,
        Subject NVARCHAR(180) NOT NULL,
        Message NVARCHAR(2000) NOT NULL,
        IpAddress NVARCHAR(64) NULL,
        UserAgent NVARCHAR(300) NULL,
        SmsStatus NVARCHAR(80) NULL,
        SmsSid NVARCHAR(80) NULL,
        SmsError NVARCHAR(500) NULL,
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
      );
    END
  `);

  return {
    name: "sqlserver",
    async save(contact, meta) {
      const id = crypto.randomUUID();
      const createdAt = new Date();
      await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .input("name", sql.NVarChar(120), contact.name)
        .input("email", sql.NVarChar(254), contact.email)
        .input("subject", sql.NVarChar(180), contact.subject)
        .input("message", sql.NVarChar(2000), contact.message)
        .input("ipAddress", sql.NVarChar(64), meta.ipAddress)
        .input("userAgent", sql.NVarChar(300), meta.userAgent)
        .input("createdAt", sql.DateTime2, createdAt)
        .query(`
          INSERT INTO dbo.ContactSubmissions
            (Id, Name, Email, Subject, Message, IpAddress, UserAgent, CreatedAt)
          VALUES
            (@id, @name, @email, @subject, @message, @ipAddress, @userAgent, @createdAt)
        `);

      return { id, createdAt: createdAt.toISOString(), ...contact };
    },
    async updateSms(id, smsResult) {
      await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .input("smsStatus", sql.NVarChar(80), smsResult.status || null)
        .input("smsSid", sql.NVarChar(80), smsResult.sid || null)
        .input("smsError", sql.NVarChar(500), smsResult.error || null)
        .query(`
          UPDATE dbo.ContactSubmissions
          SET SmsStatus = @smsStatus, SmsSid = @smsSid, SmsError = @smsError
          WHERE Id = @id
        `);
    },
    async close() {
      await pool.close();
    }
  };
}

async function createSqliteStorage() {
  const sqlite3 = requireOptional("sqlite3");
  if (!sqlite3) {
    return null;
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  const db = new sqlite3.Database(SQLITE_DB_PATH);

  await new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        subject TEXT NOT NULL,
        message TEXT NOT NULL,
        ipAddress TEXT,
        userAgent TEXT,
        smsStatus TEXT,
        smsSid TEXT,
        smsError TEXT,
        createdAt TEXT NOT NULL
      )`,
      (error) => (error ? reject(error) : resolve())
    );
  });

  return {
    name: "sqlite",
    async save(contact, meta) {
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO submissions
            (id, name, email, subject, message, ipAddress, userAgent, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, contact.name, contact.email, contact.subject, contact.message, meta.ipAddress, meta.userAgent, createdAt],
          (error) => (error ? reject(error) : resolve())
        );
      });
      return { id, createdAt, ...contact };
    },
    async updateSms(id, smsResult) {
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE submissions
           SET smsStatus = ?, smsSid = ?, smsError = ?
           WHERE id = ?`,
          [smsResult.status || null, smsResult.sid || null, smsResult.error || null, id],
          (error) => (error ? reject(error) : resolve())
        );
      });
    },
    async close() {
      await new Promise((resolve) => db.close(resolve));
    }
  };
}

async function createJsonStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  return {
    name: "json",
    async save(contact, meta) {
      let submissions = [];
      try {
        const current = await fs.readFile(JSON_FALLBACK_FILE, "utf8");
        submissions = JSON.parse(current);
        if (!Array.isArray(submissions)) {
          submissions = [];
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }

      const submission = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        ...contact
      };
      submissions.push(submission);
      await fs.writeFile(JSON_FALLBACK_FILE, JSON.stringify(submissions, null, 2));
      return submission;
    },
    async updateSms(id, smsResult) {
      let submissions = [];
      try {
        submissions = JSON.parse(await fs.readFile(JSON_FALLBACK_FILE, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }

      const index = submissions.findIndex((submission) => submission.id === id);
      if (index >= 0) {
        submissions[index] = { ...submissions[index], sms: smsResult };
        await fs.writeFile(JSON_FALLBACK_FILE, JSON.stringify(submissions, null, 2));
      }
    },
    async close() {}
  };
}

async function initializeStorage() {
  const providers = [createSqlServerStorage, createSqliteStorage, createJsonStorage];
  for (const createProvider of providers) {
    try {
      const provider = await createProvider();
      if (provider) {
        console.log(`Contact submissions storage: ${provider.name}`);
        return provider;
      }
    } catch (error) {
      console.error("Storage provider failed:", error.message);
    }
  }

  throw new Error("No contact submission storage is available.");
}

function securityHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Access-Control-Allow-Origin": process.env.CORS_ALLOW_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(
    statusCode,
    securityHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    })
  );
  response.end(JSON.stringify(payload));
}

function sanitizeSingleLine(value, maxLength) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function sanitizeMessage(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim().slice(0, 2000);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateContact(body) {
  const contact = {
    name: sanitizeSingleLine(body.name, 120),
    email: sanitizeSingleLine(body.email, 254).toLowerCase(),
    subject: sanitizeSingleLine(body.subject, 180),
    message: sanitizeMessage(body.message)
  };

  if (contact.name.length < 2) {
    return { error: "Please enter your name.", contact };
  }

  if (!isEmail(contact.email)) {
    return { error: "Please enter a valid email address.", contact };
  }

  if (contact.subject.length < 3) {
    return { error: "Please enter a subject.", contact };
  }

  if (contact.message.length < 10) {
    return { error: "Please write a message with at least 10 characters.", contact };
  }

  return { contact };
}

async function readJsonBody(request) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.includes("application/json")) {
    const error = new Error("Please send JSON.");
    error.statusCode = 415;
    throw error;
  }

  let body = "";
  let bytes = 0;

  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    body += chunk;
  }

  return body ? JSON.parse(body) : {};
}

function getClientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim().slice(0, 64);
  }

  return (request.socket.remoteAddress || "unknown").slice(0, 64);
}

function checkRateLimit(request) {
  const now = Date.now();
  const ipAddress = getClientIp(request);
  const bucket = rateLimitBuckets.get(ipAddress) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  bucket.count += 1;
  rateLimitBuckets.set(ipAddress, bucket);

  for (const [key, value] of rateLimitBuckets.entries()) {
    if (value.resetAt <= now) {
      rateLimitBuckets.delete(key);
    }
  }

  return {
    allowed: bucket.count <= RATE_LIMIT_MAX,
    retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000)
  };
}

function buildSmsBody(contact, id) {
  const subject = contact.subject || "New contact request";
  const message = (contact.message || "").replace(/\s+/g, " ").slice(0, 280);
  return `New portfolio message ${id}: ${contact.name} <${contact.email}> - ${subject}. ${message}`;
}

function sendSms(contact, id) {
  return new Promise((resolve, reject) => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;
    const to = process.env.SMS_TO;

    if (!accountSid || !authToken || !from || !to) {
      resolve({ skipped: true, status: "not_configured" });
      return;
    }

    const postData = new URLSearchParams({
      From: from,
      To: to,
      Body: buildSmsBody(contact, id)
    }).toString();

    const options = {
      method: "POST",
      hostname: "api.twilio.com",
      path: `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        let parsed = {};
        try {
          parsed = data ? JSON.parse(data) : {};
        } catch (error) {
          reject(new Error("Invalid response from SMS provider."));
          return;
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ sid: parsed.sid, status: parsed.status || "sent" });
          return;
        }

        reject(new Error(parsed.message || `SMS provider error: ${res.statusCode}`));
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error("SMS provider timed out."));
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

async function handleContact(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405, securityHeaders({ Allow: "POST" }));
    response.end("Method Not Allowed");
    return;
  }

  const rateLimit = checkRateLimit(request);
  if (!rateLimit.allowed) {
    response.writeHead(
      429,
      securityHeaders({
        "Content-Type": "application/json; charset=utf-8",
        "Retry-After": String(rateLimit.retryAfterSeconds)
      })
    );
    response.end(JSON.stringify({ error: "Too many messages. Please try again later." }));
    return;
  }

  try {
    const body = await readJsonBody(request);
    const { error, contact } = validateContact(body);

    if (error) {
      sendJson(response, 400, { error });
      return;
    }

    const meta = {
      ipAddress: getClientIp(request),
      userAgent: sanitizeSingleLine(request.headers["user-agent"], 300)
    };

    const submission = await storage.save(contact, meta);
    let sms = null;

    try {
      sms = await sendSms(contact, submission.id);
      await storage.updateSms(submission.id, sms);
    } catch (error) {
      sms = { status: "failed", error: error.message };
      await storage.updateSms(submission.id, sms).catch(() => {});
      console.error("SMS delivery failed:", error.message);
    }

    sendJson(response, 201, {
      ok: true,
      id: submission.id,
      message: "Contact request saved.",
      smsStatus: sms.status
    });
  } catch (error) {
    const statusCode = error.statusCode || (error instanceof SyntaxError ? 400 : 500);
    const message =
      error instanceof SyntaxError
        ? "Invalid JSON request."
        : error.statusCode
          ? error.message
          : "Unable to save your message right now.";
    sendJson(response, statusCode, { error: message });
  }
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  let pathname;

  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    response.writeHead(400, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    response.end("Bad Request");
    return;
  }

  if (pathname === "/") {
    pathname = "/index.html";
  }

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  const dataPath = path.relative(path.join(PUBLIC_DIR, "data"), filePath);

  if (!isPathInside(PUBLIC_DIR, filePath) || !dataPath.startsWith("..")) {
    response.writeHead(403, securityHeaders());
    response.end("Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(
      200,
      securityHeaders({
        "Content-Type": contentTypes[extension] || "application/octet-stream",
        "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=3600"
      })
    );
    response.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      response.writeHead(404, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
      response.end("Not Found");
      return;
    }

    response.writeHead(500, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    response.end("Server Error");
  }
}

async function handleHealth(response) {
  sendJson(response, 200, {
    ok: true,
    storage: storage.name,
    smsConfigured: Boolean(
      process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_AUTH_TOKEN &&
        process.env.TWILIO_FROM &&
        process.env.SMS_TO
    )
  });
}

async function start() {
  storage = await initializeStorage();

  const server = http.createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, securityHeaders());
      response.end();
      return;
    }

    if (request.url.startsWith("/api/contact")) {
      handleContact(request, response);
      return;
    }

    if (request.url.startsWith("/api/health")) {
      handleHealth(response);
      return;
    }

    serveStatic(request, response);
  });

  process.on("SIGINT", async () => {
    await storage.close();
    server.close(() => process.exit(0));
  });

  server.listen(PORT, () => {
    console.log(`Portfolio server running at http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
