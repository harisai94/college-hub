const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const express = require('express');
const multer = require('multer');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'campushub';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 24 * 60 * 60 * 1000;
const MAX_JSON_BODY = process.env.MAX_JSON_BODY || '1mb';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
const OPEN_SESSION_RATE_LIMIT = Number(process.env.OPEN_SESSION_RATE_LIMIT) || 20;
const OPEN_SESSION_WINDOW_MS = Number(process.env.OPEN_SESSION_WINDOW_MS) || 15 * 60 * 1000;

const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads');
const mongoClient = new MongoClient(MONGODB_URI);
let repositoriesCollection = null;

for (const dir of [dataDir, uploadsDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const sessions = new Map();
const liveClientsByCode = new Map();
const openSessionAttemptsByIp = new Map();

function getRepositoriesCollection() {
  if (!repositoriesCollection) {
    throw new Error('MongoDB is not initialized yet.');
  }
  return repositoriesCollection;
}

async function initMongo() {
  await mongoClient.connect();
  const db = mongoClient.db(DB_NAME);
  repositoriesCollection = db.collection('repositories');
  await repositoriesCollection.createIndex({ code: 1 }, { unique: true });
  console.log(`MongoDB connected: ${MONGODB_URI}/${DB_NAME}`);
}

async function getRepositoryByCode(code) {
  return getRepositoriesCollection().findOne({ code });
}

async function ensureRepository(code, nowIsoString) {
  const collection = getRepositoriesCollection();
  const result = await collection.findOneAndUpdate(
    { code },
    { $setOnInsert: { code, createdAt: nowIsoString, notes: [] } },
    { upsert: true, returnDocument: 'before' }
  );
  return { existed: Boolean(result.value) };
}

async function getNotesByCode(code) {
  const repo = await getRepositoryByCode(code);
  const notes = repo && Array.isArray(repo.notes) ? repo.notes.slice() : [];
  notes.sort((a, b) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  return notes;
}

function addLiveClient(code, res) {
  if (!liveClientsByCode.has(code)) {
    liveClientsByCode.set(code, new Set());
  }
  liveClientsByCode.get(code).add(res);
}

function removeLiveClient(code, res) {
  const listeners = liveClientsByCode.get(code);
  if (!listeners) return;
  listeners.delete(res);
  if (listeners.size === 0) {
    liveClientsByCode.delete(code);
  }
}

function broadcastToCode(code, payload) {
  const listeners = liveClientsByCode.get(code);
  if (!listeners) return;
  const encoded = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of listeners) {
    client.write(encoded);
  }
}

function sanitizeCode(code) {
  return String(code || '').trim().slice(0, 100);
}

function sanitizeDisplayName(name) {
  const cleaned = String(name || '').trim();
  return cleaned.slice(0, 60);
}

function inferFileType(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return ext === '.pdf' ? 'pdf' : 'doc';
}

function sanitizeText(value, maxLen = 200) {
  return String(value || '').trim().slice(0, maxLen);
}

function getIpAddress(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function isRateLimitedOpenSession(ip) {
  const now = Date.now();
  const item = openSessionAttemptsByIp.get(ip);
  if (!item || now > item.resetAt) {
    openSessionAttemptsByIp.set(ip, { count: 1, resetAt: now + OPEN_SESSION_WINDOW_MS });
    return false;
  }
  item.count += 1;
  return item.count > OPEN_SESSION_RATE_LIMIT;
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (now > session.expiresAt) {
      sessions.delete(token);
    }
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safeOriginal = path
      .basename(file.originalname)
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    const name = `${Date.now()}-${crypto.randomUUID()}-${safeOriginal}`;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.txt'];
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!allowed.includes(ext)) {
      cb(new Error('Only PDF, DOC, DOCX, and TXT files are allowed.'));
      return;
    }
    cb(null, true);
  }
});

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: MAX_JSON_BODY }));
app.use((req, res, next) => {
  if (CORS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-session-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(__dirname));

function getSession(req, res) {
  cleanupExpiredSessions();
  const token = req.header('x-session-token');
  if (!token || !sessions.has(token)) {
    res.status(401).json({ message: 'Session expired or invalid. Open repository again.' });
    return null;
  }
  return sessions.get(token);
}

function getSessionFromRequest(req) {
  cleanupExpiredSessions();
  const headerToken = req.header('x-session-token');
  const queryToken = typeof req.query?.token === 'string' ? req.query.token : '';
  const token = headerToken || queryToken;
  if (!token || !sessions.has(token)) {
    return null;
  }
  return sessions.get(token);
}

app.post('/api/session/open', async (req, res, next) => {
  try {
  const ip = getIpAddress(req);
  if (isRateLimitedOpenSession(ip)) {
    res.status(429).json({ message: 'Too many attempts. Please try again later.' });
    return;
  }

  const code = sanitizeCode(req.body?.code);
  const displayName = sanitizeDisplayName(req.body?.displayName);

  if (code.length < 6) {
    res.status(400).json({ message: 'Access code must be at least 6 characters.' });
    return;
  }

  if (displayName.length < 4) {
    res.status(400).json({ message: 'Name is required and must be at least 4 characters.' });
    return;
  }

  const now = new Date().toISOString();
  const { existed } = await ensureRepository(code, now);

  const token = crypto.randomUUID();
  sessions.set(token, {
    code,
    user: {
      displayName
    },
    createdAt: now,
    expiresAt: Date.now() + SESSION_TTL_MS
  });

  const notes = await getNotesByCode(code);

  res.json({
    created: !existed,
    token,
    user: { displayName },
    notes
  });
  } catch (error) {
    next(error);
  }
});

app.post('/api/session/logout', (req, res) => {
  const token = req.header('x-session-token');
  if (token) {
    const existing = sessions.get(token);
    sessions.delete(token);
    if (existing) {
      const listeners = liveClientsByCode.get(existing.code);
      if (listeners) {
        for (const client of listeners) {
          client.write(`data: ${JSON.stringify({ type: 'session-updated' })}\n\n`);
        }
      }
    }
  }
  res.json({ ok: true });
});

app.get('/api/notes', async (req, res, next) => {
  try {
  const session = getSession(req, res);
  if (!session) return;

  const notes = await getNotesByCode(session.code);

  res.json({ notes });
  } catch (error) {
    next(error);
  }
});

app.get('/api/notes/stream', (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ message: 'Session expired or invalid. Open repository again.' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  addLiveClient(session.code, res);
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    removeLiveClient(session.code, res);
  });
});

app.post('/api/notes', upload.single('file'), async (req, res, next) => {
  try {
  const session = getSession(req, res);
  if (!session) return;

  const title = sanitizeText(req.body?.title, 140);
  const department = sanitizeText(req.body?.department, 80);
  const semester = sanitizeText(req.body?.semester, 80);
  const noteText = sanitizeText(req.body?.noteText, 1200);

  if (!title || !department || !semester) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(400).json({ message: 'Title, department, and semester are required.' });
    return;
  }

  const now = new Date().toISOString();
  const note = {
    id: crypto.randomUUID(),
    title,
    department,
    semester,
    noteText,
    uploaderName: session.user.displayName,
    fileType: req.file ? inferFileType(req.file.originalname) : 'doc',
    filePath: req.file ? `/uploads/${req.file.filename}` : '',
    createdAt: now
  };

  await ensureRepository(session.code, now);
  await getRepositoriesCollection().updateOne(
    { code: session.code },
    { $push: { notes: note } }
  );
  broadcastToCode(session.code, { type: 'note-added', noteId: note.id });

  res.status(201).json({ note });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/notes/:id', async (req, res, next) => {
  try {
  const session = getSession(req, res);
  if (!session) return;

  const noteId = sanitizeText(req.params?.id, 100);
  if (!noteId) {
    res.status(400).json({ message: 'Note id is required.' });
    return;
  }

  const repo = await getRepositoryByCode(session.code);
  const notes = repo && Array.isArray(repo.notes) ? repo.notes : [];
  const noteToDelete = notes.find((note) => note.id === noteId);

  if (!noteToDelete) {
    res.status(404).json({ message: 'Note not found.' });
    return;
  }

  if (noteToDelete.filePath) {
    const filename = path.basename(noteToDelete.filePath);
    const absolutePath = path.join(uploadsDir, filename);
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
    }
  }

  await getRepositoriesCollection().updateOne(
    { code: session.code },
    { $pull: { notes: { id: noteId } } }
  );

  broadcastToCode(session.code, { type: 'note-deleted', noteId });
  res.json({ ok: true, deletedId: noteId });
  } catch (error) {
    next(error);
  }
});

app.get('/api/health', async (_req, res, next) => {
  try {
    const repositories = await getRepositoriesCollection().countDocuments();
    res.json({
      ok: true,
      uptimeSec: Math.floor(process.uptime()),
      sessions: sessions.size,
      repositories
    });
  } catch (error) {
    next(error);
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ message: err.message });
    return;
  }
  if (err && err.message) {
    res.status(400).json({ message: err.message });
    return;
  }
  res.status(500).json({ message: 'Unexpected server error.' });
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

initMongo()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`CampusHub server running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });

setInterval(() => {
  cleanupExpiredSessions();
}, 5 * 60 * 1000);
