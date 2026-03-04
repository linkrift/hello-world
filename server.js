const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT) || 4173;
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(ROOT, "trellix.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner TEXT NOT NULL,
    revision INTEGER NOT NULL,
    state_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS board_permissions (
    board_id TEXT NOT NULL,
    username TEXT NOT NULL,
    can_read INTEGER NOT NULL DEFAULT 1,
    can_write INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (board_id, username)
  );
`);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webm": "video/webm",
  ".mp4": "video/mp4"
};

const clients = new Set();

function defaultBoardState() {
  return {
    modules: {
      todo: true,
      notes: true,
      media: true,
      gating: true,
      rag: true,
      contacts: true
    },
    columns: [
      { id: randomId(), title: "To Do", cards: [newCard("Build Trello clone") ] },
      { id: randomId(), title: "Doing", cards: [newCard("Implement collaboration") ] },
      { id: randomId(), title: "Done", cards: [] }
    ]
  };
}

function newCard(text) {
  return {
    id: randomId(),
    text,
    completed: false,
    ragStatus: "red",
    todos: [],
    notes: "",
    media: [],
    gatingCardIds: [],
    contacts: []
  };
}

function randomId() {
  return Math.random().toString(36).slice(2, 11);
}

function initMainBoard() {
  const existing = db.prepare("SELECT id FROM boards WHERE id = ?").get("main");
  if (existing) return;

  db.prepare("INSERT INTO boards (id, name, owner, revision, state_json) VALUES (?, ?, ?, ?, ?)")
    .run("main", "Main Board", "system", 1, JSON.stringify(defaultBoardState()));

  db.prepare("INSERT OR IGNORE INTO board_permissions (board_id, username, can_read, can_write) VALUES (?, ?, 1, 1)")
    .run("main", "*");
}

initMainBoard();

function safeResolve(urlPath) {
  const normalized = path.normalize(decodeURIComponent(urlPath)).replace(/^\.{2}(\/|\\|$)+/, "");
  return path.join(ROOT, normalized);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5_000_000) reject(new Error("Payload too large"));
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function parseRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 25_000_000) {
        reject(new Error("File too large (max 25MB)"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function userPermission(boardId, username) {
  const exact = db.prepare("SELECT can_read, can_write FROM board_permissions WHERE board_id = ? AND username = ?")
    .get(boardId, username);
  if (exact) return exact;
  return db.prepare("SELECT can_read, can_write FROM board_permissions WHERE board_id = ? AND username = '*'")
    .get(boardId);
}

function canRead(boardId, username) {
  const perm = userPermission(boardId, username);
  return Boolean(perm && perm.can_read);
}

function canWrite(boardId, username) {
  const perm = userPermission(boardId, username);
  return Boolean(perm && perm.can_write);
}

function getBoard(boardId) {
  return db.prepare("SELECT id, name, owner, revision, state_json FROM boards WHERE id = ?").get(boardId);
}

function broadcastBoard(boardId, updatedBy = "system") {
  const row = getBoard(boardId);
  if (!row) return;

  const payload = JSON.stringify({
    type: "state",
    boardId,
    revision: row.revision,
    board: JSON.parse(row.state_json),
    updatedBy
  });

  for (const client of clients) {
    if (client.boardId === boardId) {
      client.res.write(`data: ${payload}\n\n`);
    }
  }
}

function collectAccessibleCards(username, query) {
  const boards = db.prepare("SELECT b.id, b.name, b.state_json FROM boards b").all();
  const normalized = (query || "").trim().toLowerCase();
  const cards = [];

  for (const boardRow of boards) {
    if (!canRead(boardRow.id, username)) continue;
    const board = JSON.parse(boardRow.state_json);
    for (const column of board.columns || []) {
      for (const card of column.cards || []) {
        if (normalized && !String(card.text || "").toLowerCase().includes(normalized)) continue;
        cards.push({
          id: card.id,
          text: card.text,
          completed: Boolean(card.completed),
          boardId: boardRow.id,
          boardName: boardRow.name,
          columnId: column.id,
          columnTitle: column.title
        });
      }
    }
  }

  return cards;
}

async function handleApi(req, res, parsedUrl) {
  const boardId = parsedUrl.searchParams.get("boardId") || "main";
  const username = (parsedUrl.searchParams.get("username") || "anonymous").trim().slice(0, 30) || "anonymous";

  if (req.method === "GET" && parsedUrl.pathname === "/api/state") {
    const row = getBoard(boardId);
    if (!row) return sendJson(res, 404, { error: "Board not found" });
    if (!canRead(boardId, username)) return sendJson(res, 403, { error: "Read permission denied" });

    return sendJson(res, 200, {
      boardId: row.id,
      boardName: row.name,
      revision: row.revision,
      board: JSON.parse(row.state_json)
    });
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/state") {
    const body = await parseJsonBody(req);
    const incomingBoardId = (body.boardId || boardId || "main").toString();
    const actor = (body.username || username || "anonymous").trim().slice(0, 30) || "anonymous";

    if (!canWrite(incomingBoardId, actor)) return sendJson(res, 403, { error: "Write permission denied" });
    if (!body.board || !Array.isArray(body.board.columns)) return sendJson(res, 400, { error: "Invalid board payload" });

    const row = getBoard(incomingBoardId);
    if (!row) return sendJson(res, 404, { error: "Board not found" });

    const nextRevision = row.revision + 1;
    db.prepare("UPDATE boards SET revision = ?, state_json = ? WHERE id = ?")
      .run(nextRevision, JSON.stringify(body.board), incomingBoardId);

    broadcastBoard(incomingBoardId, actor);
    return sendJson(res, 200, { ok: true, revision: nextRevision });
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/events") {
    if (!canRead(boardId, username)) return sendJson(res, 403, { error: "Read permission denied" });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.write("retry: 1000\n\n");

    const client = { res, boardId, username };
    clients.add(client);
    broadcastBoard(boardId, "system");

    req.on("close", () => clients.delete(client));
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/cards") {
    const q = parsedUrl.searchParams.get("q") || "";
    return sendJson(res, 200, { cards: collectAccessibleCards(username, q) });
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/boards/share") {
    const body = await parseJsonBody(req);
    const targetBoardId = (body.boardId || boardId || "main").toString();
    const owner = (body.owner || username || "anonymous").trim().slice(0, 30);
    const shareWith = (body.shareWith || "").trim().slice(0, 30);
    const canWritePerm = body.canWrite ? 1 : 0;

    const row = getBoard(targetBoardId);
    if (!row) return sendJson(res, 404, { error: "Board not found" });
    if (row.owner !== owner) return sendJson(res, 403, { error: "Only board owner can share" });
    if (!shareWith) return sendJson(res, 400, { error: "shareWith required" });

    db.prepare(`
      INSERT INTO board_permissions (board_id, username, can_read, can_write)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(board_id, username) DO UPDATE SET can_read = 1, can_write = excluded.can_write
    `).run(targetBoardId, shareWith, canWritePerm);

    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/upload") {
    if (!canWrite(boardId, username)) return sendJson(res, 403, { error: "Write permission denied" });

    const raw = await parseRawBody(req);
    const incomingName = (req.headers["x-filename"] || "upload.bin").toString();
    const safeName = incomingName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const fileName = `${Date.now()}-${randomId()}-${safeName}`;
    const filePath = path.join(UPLOAD_DIR, fileName);

    fs.writeFileSync(filePath, raw);

    return sendJson(res, 200, {
      ok: true,
      name: incomingName,
      url: `/uploads/${fileName}`
    });
  }

  sendJson(res, 404, { error: "Not found" });
}

function handleStatic(req, res, parsedUrl) {
  const reqPath = parsedUrl.pathname === "/" ? "/index.html" : parsedUrl.pathname;
  const filePath = safeResolve(reqPath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  if (parsedUrl.pathname.startsWith("/api/")) {
    handleApi(req, res, parsedUrl).catch((error) => {
      sendJson(res, 400, { error: error.message || "Request failed" });
    });
    return;
  }

  handleStatic(req, res, parsedUrl);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Trellix running at http://localhost:${PORT}`);
});
