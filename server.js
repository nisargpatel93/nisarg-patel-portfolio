const http = require("http");
const fs = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = __dirname;
const DATA_DIR = path.join(__dirname, "data");
const SUBMISSIONS_FILE = path.join(DATA_DIR, "contact-submissions.json");

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
  await fs.mkdir(DATA_DIR, { recursive: true });

  let submissions = [];
  try {
    const current = await fs.readFile(SUBMISSIONS_FILE, "utf8");
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
    id: `msg_${Date.now()}`,
    createdAt: new Date().toISOString(),
    ...contact
  };

  submissions.push(submission);
  await fs.writeFile(SUBMISSIONS_FILE, JSON.stringify(submissions, null, 2));
  return submission;
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
    sendJson(response, 201, {
      ok: true,
      id: submission.id,
      message: "Contact request saved."
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
