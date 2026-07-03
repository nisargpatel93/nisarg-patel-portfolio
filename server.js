const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const https = require("https");
const { URLSearchParams } = require("url");
const sqlite3 = require("sqlite3").verbose();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = __dirname;
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "contact.db");

let db = null;

// initialize SQLite DB (create folder + table)
(async () => {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error("Unable to create data directory:", err);
  }

  db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      console.error("Failed to open SQLite DB:", err);
      db = null;
      return;
    }
    db.run(
      `CREATE TABLE IF NOT EXISTS submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT,
        subject TEXT,
        message TEXT,
        createdAt TEXT
      )`
    );
  });
})();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sanitizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateContact(body) {
  const contact = {
    name: sanitizeText(body.name),
    email: sanitizeText(body.email).toLowerCase(),
    subject: sanitizeText(body.subject),
    message: String(body.message || "").trim()
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

  if (contact.message.length > 2000) {
    return { error: "Please keep the message under 2000 characters.", contact };
  }

  return { contact };
}

async function readJsonBody(request) {
  let body = "";

  for await (const chunk of request) {
    body += chunk;
    if (body.length > 100000) {
      throw new Error("Request body is too large.");
    }
  }

  return body ? JSON.parse(body) : {};
}

async function saveSubmission(contact) {
  // Prefer SQLite storage if DB is available; otherwise fall back to JSON file
  const createdAt = new Date().toISOString();

  if (db) {
    return new Promise((resolve, reject) => {
      const stmt = db.prepare(
        `INSERT INTO submissions (name, email, subject, message, createdAt) VALUES (?,?,?,?,?)`
      );
      stmt.run(contact.name, contact.email, contact.subject, contact.message, createdAt, function (err) {
        if (err) return reject(err);
        const id = `msg_${this.lastID}`;
        resolve({ id, createdAt, ...contact });
      });
      stmt.finalize();
    });
  }

  // fallback: write to JSON file (kept for compatibility)
  await fs.mkdir(DATA_DIR, { recursive: true });
  const SUBMISSIONS_FILE = path.join(DATA_DIR, "contact-submissions.json");

  let submissions = [];
  try {
    const current = await fs.readFile(SUBMISSIONS_FILE, "utf8");
    submissions = JSON.parse(current);
    if (!Array.isArray(submissions)) submissions = [];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const submission = { id: `msg_${Date.now()}`, createdAt, ...contact };
  submissions.push(submission);
  await fs.writeFile(SUBMISSIONS_FILE, JSON.stringify(submissions, null, 2));
  return submission;
}

function buildSmsBody(contact, id) {
  const name = contact.name || "(no name)";
  const email = contact.email || "(no email)";
  const subject = contact.subject || "(no subject)";
  const message = (contact.message || "").slice(0, 300);

  return `New contact (${id}) from ${name} (${email}) — ${subject}: ${message}`;
}

function sendSms(contact, id) {
  return new Promise((resolve, reject) => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;
    const to = process.env.SMS_TO;

    if (!accountSid || !authToken || !from || !to) {
      return reject(new Error("Twilio SMS not configured."));
    }

    const body = buildSmsBody(contact, id);

    const postData = new URLSearchParams({
      From: from,
      To: to,
      Body: body
    }).toString();

    const options = {
      method: "POST",
      hostname: "api.twilio.com",
      path: `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ sid: parsed.sid, status: parsed.status });
          } else {
            reject(new Error(parsed.message || `Twilio error: ${res.statusCode}`));
          }
        } catch (err) {
          reject(new Error("Invalid response from Twilio"));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

async function handleContact(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST" });
    response.end("Method Not Allowed");
    return;
  }

  try {
    const body = await readJsonBody(request);
    const { error, contact } = validateContact(body);

    if (error) {
      sendJson(response, 400, { error });
      return;
    }

    const submission = await saveSubmission(contact);
    // attempt optional SMS notification if Twilio env vars are provided
    let smsInfo = null;
    try {
      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM && process.env.SMS_TO) {
        const smsResult = await sendSms(contact, submission.id);
        smsInfo = { sms: smsResult };
      }
    } catch (err) {
      // don't fail the request if SMS sending fails; include info in response
      smsInfo = { smsError: String(err && err.message ? err.message : err) };
    }

    sendJson(response, 201, {
      ok: true,
      id: submission.id,
      message: "Contact request saved.",
      ...smsInfo
    });
  } catch (error) {
    const message = error instanceof SyntaxError ? "Invalid JSON request." : "Unable to save your message right now.";
    sendJson(response, error instanceof SyntaxError ? 400 : 500, { error: message });
  }
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/") {
    pathname = "/index.html";
  }

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));

  if (!filePath.startsWith(PUBLIC_DIR) || filePath.includes(`${path.sep}data${path.sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": contentTypes[extension] || "application/octet-stream"
    });
    response.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not Found");
      return;
    }

    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Server Error");
  }
}

const server = http.createServer((request, response) => {
  if (request.url.startsWith("/api/contact")) {
    handleContact(request, response);
    return;
  }

  serveStatic(request, response);
});

server.listen(PORT, () => {
  console.log(`Portfolio server running at http://localhost:${PORT}`);
});
