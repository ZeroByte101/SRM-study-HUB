require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '30mb' }));

const sessions = new Map();

function getLocalIpv4() {
  const nets = os.networkInterfaces();
  for (const netSet of Object.values(nets)) {
    for (const net of netSet || []) {
      const isIpv4 = net.family === 'IPv4' || net.family === 4;
      if (isIpv4 && !net.internal) return net.address;
    }
  }
  return null;
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), String(salt), 100000, 64, 'sha512').toString('hex');
}

function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  return { salt, hash };
}

function getTokenFromRequest(req) {
  const authHeader = String(req.headers.authorization || '');
  if (!authHeader.startsWith('Bearer ')) return '';
  return authHeader.slice(7).trim();
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, createdAt: Date.now() });
  return token;
}

function toPublicUser(user) {
  return {
    id: user.id,
    name: user.name,
    studentId: user.studentId,
    email: user.email,
    createdAt: user.createdAt
  };
}

function summarizeAttendance(records) {
  const safeRecords = Array.isArray(records) ? records : [];
  const bySubject = new Map();
  let overallAttended = 0;
  let overallTotal = 0;

  safeRecords.forEach(record => {
    const subject = String(record.subject || '').trim() || 'Unknown Subject';
    const attended = Number(record.attended) || 0;
    const total = Number(record.total) || 0;
    if (total <= 0) return;

    const subjectAggregate = bySubject.get(subject) || { subject, attended: 0, total: 0 };
    subjectAggregate.attended += attended;
    subjectAggregate.total += total;
    bySubject.set(subject, subjectAggregate);

    overallAttended += attended;
    overallTotal += total;
  });

  const subjectTotals = [...bySubject.values()]
    .map(item => ({
      subject: item.subject,
      attended: item.attended,
      total: item.total,
      percentage: item.total > 0 ? Number(((item.attended / item.total) * 100).toFixed(2)) : 0
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject));

  const overall = {
    attended: overallAttended,
    total: overallTotal,
    percentage: overallTotal > 0 ? Number(((overallAttended / overallTotal) * 100).toFixed(2)) : 0
  };

  return { subjectTotals, overall };
}

function stripCodeFence(text) {
  if (!text) return '';
  const trimmed = String(text).trim();
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return match ? match[1].trim() : trimmed;
}

function parseJsonSafe(text) {
  const cleaned = stripCodeFence(text);
  try {
    return JSON.parse(cleaned);
  } catch (_err) {
    return null;
  }
}

function decodeTextFromBase64(base64, mimeType, fileName) {
  const name = String(fileName || '').toLowerCase();
  const type = String(mimeType || '').toLowerCase();
  const isPdf = type.includes('pdf') || name.endsWith('.pdf');
  const textLike =
    type.startsWith('text/') ||
    /\.(txt|md|csv|json|xml|html|js|ts|py|java|c|cpp|sql)$/i.test(name);

  try {
    const buffer = Buffer.from(base64, 'base64');

    if (isPdf) {
      // Basic PDF text extraction for many text-based PDFs (not scanned images).
      const raw = buffer.toString('latin1');
      const lines = [];

      const tjRegex = /\(([^)]*)\)\s*Tj/gm;
      let match = null;
      while ((match = tjRegex.exec(raw)) !== null) {
        const cleaned = String(match[1] || '')
          .replace(/\\\(/g, '(')
          .replace(/\\\)/g, ')')
          .replace(/\\n/g, ' ')
          .replace(/\\r/g, ' ')
          .replace(/\\t/g, ' ')
          .replace(/\\[0-7]{1,3}/g, ' ');
        if (cleaned.trim()) lines.push(cleaned.trim());
      }

      const tjArrayRegex = /\[(.*?)\]\s*TJ/gms;
      while ((match = tjArrayRegex.exec(raw)) !== null) {
        const segment = match[1] || '';
        const inParens = segment.match(/\(([^)]*)\)/g) || [];
        inParens.forEach(part => {
          const cleaned = part
            .slice(1, -1)
            .replace(/\\\(/g, '(')
            .replace(/\\\)/g, ')')
            .replace(/\\n|\\r|\\t/g, ' ')
            .replace(/\\[0-7]{1,3}/g, ' ')
            .trim();
          if (cleaned) lines.push(cleaned);
        });
      }

      const combined = lines.join(' ').replace(/\s+/g, ' ').trim();
      if (combined) return combined;
      return '';
    }

    if (!textLike) return '';
    return buffer.toString('utf8');
  } catch (_err) {
    return '';
  }
}

function toTitleCase(text) {
  return String(text || '')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function inferTopicFromText(text, fileName) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const heading = lines.find(line => line.length > 4 && line.length < 90);
  if (heading) return heading;

  const words = String(text || '')
    .toLowerCase()
    .match(/[a-z]{4,}/g);

  if (!words || !words.length) {
    const baseName = path.parse(fileName || 'Uploaded Notes').name;
    return toTitleCase(baseName.replace(/[_-]+/g, ' ')) || 'Uploaded Notes';
  }

  const stopWords = new Set([
    'that', 'this', 'with', 'from', 'have', 'will', 'into', 'there', 'their',
    'about', 'which', 'using', 'these', 'those', 'were', 'been', 'being', 'also',
    'your', 'when', 'where', 'what', 'topic', 'notes', 'file', 'uploaded', 'summary'
  ]);

  const counts = new Map();
  words.forEach(word => {
    if (stopWords.has(word)) return;
    counts.set(word, (counts.get(word) || 0) + 1);
  });

  const topWords = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([word]) => word);

  return topWords.length ? toTitleCase(topWords.join(' ')) : 'Uploaded Notes';
}

function summarizeFromText(text, fileName, mimeType) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const topic = inferTopicFromText(text, fileName);

  if (!normalized) {
    return {
      topic,
      summary:
        `Uploaded file (${mimeType || 'unknown format'}) could not be parsed locally.`,
      keyPoints: [
        'Local fallback summarizes text-like files directly.',
        'PDF extraction works for many text-based PDFs.',
        'For images/scanned PDFs/office docs, Gemini quota must be available.'
      ],
      searchQuery: topic
    };
  }

  const sentences = normalized.match(/[^.!?]+[.!?]?/g) || [];
  const summary = sentences.slice(0, 3).join(' ').trim() || normalized.slice(0, 320);

  const keyPoints = sentences
    .slice(0, 5)
    .map(sentence => sentence.trim())
    .filter(Boolean)
    .map(sentence => (sentence.length > 140 ? sentence.slice(0, 137) + '...' : sentence));

  return {
    topic,
    summary,
    keyPoints: keyPoints.length ? keyPoints : [summary],
    searchQuery: topic
  };
}

async function analyzeWithGemini({ base64, mimeType, fileName }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const prompt =
    'Analyze the uploaded student notes file. Return strict JSON with keys: topic (string), summary (string, max 120 words), keyPoints (array of 3-6 concise bullets), searchQuery (string for YouTube search).';

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: mimeType || 'application/octet-stream',
              data: base64
            }
          },
          { text: `Original file name: ${fileName || 'uploaded-file'}` }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json'
    }
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();

  if (!response.ok) {
    const msg = data?.error?.message || 'Gemini API request failed';
    throw new Error(msg);
  }

  const rawText = data?.candidates?.[0]?.content?.parts
    ?.map(part => part.text || '')
    .join('\n')
    .trim();

  const parsed = parseJsonSafe(rawText);
  if (!parsed || !parsed.summary) {
    throw new Error('Gemini response could not be parsed');
  }

  return {
    topic: String(parsed.topic || '').trim() || inferTopicFromText('', fileName),
    summary: String(parsed.summary || '').trim(),
    keyPoints: Array.isArray(parsed.keyPoints)
      ? parsed.keyPoints.map(point => String(point).trim()).filter(Boolean).slice(0, 6)
      : [],
    searchQuery:
      String(parsed.searchQuery || '').trim() ||
      String(parsed.topic || '').trim() ||
      inferTopicFromText('', fileName)
  };
}

async function fetchYouTubeVideos(topic, maxResults = 6) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error('YouTube API key not configured');

  const apiUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${maxResults}&q=${encodeURIComponent(topic)}&key=${key}`;
  const response = await fetch(apiUrl);
  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message || 'YouTube API error');
  }

  if (!Array.isArray(data.items)) {
    throw new Error('Invalid response from YouTube');
  }

  return data.items.map(item => ({
    title: item.snippet.title,
    url: 'https://youtube.com/watch?v=' + item.id.videoId
  }));
}

(function initDb() {
  const defaultSqlitePath = process.env.VERCEL
    ? path.join('/tmp', 'db.sqlite')
    : path.join(__dirname, 'db.sqlite');
  const sqlitePath = process.env.SQLITE_PATH
    ? path.resolve(process.env.SQLITE_PATH)
    : defaultSqlitePath;
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new DatabaseSync(sqlitePath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      studentId TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      passwordSalt TEXT NOT NULL,
      passwordHash TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      date TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attendance (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attendanceProfiles (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      subject TEXT NOT NULL,
      attended INTEGER NOT NULL,
      total INTEGER NOT NULL,
      percentage REAL NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attendanceProfiles_user_createdAt
      ON attendanceProfiles (userId, createdAt DESC);
  `);

  function safeParseJson(raw, fallback) {
    try {
      return JSON.parse(String(raw || ''));
    } catch (_err) {
      return fallback;
    }
  }

  function tableCount(tableName) {
    const allowed = new Set(['users', 'chats', 'events', 'attendance', 'attendanceProfiles']);
    if (!allowed.has(tableName)) return 0;
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get();
    return Number(row?.count || 0);
  }

  const insertUserStmt = db.prepare(
    'INSERT INTO users (id, name, studentId, email, passwordSalt, passwordHash, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const getUserByIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');
  const getUserByEmailStmt = db.prepare('SELECT * FROM users WHERE email = ?');

  const insertChatStmt = db.prepare(
    'INSERT INTO chats (payload, createdAt) VALUES (?, ?)'
  );
  const getChatsStmt = db.prepare(
    'SELECT payload FROM chats ORDER BY id ASC'
  );

  const insertEventStmt = db.prepare(
    'INSERT INTO events (name, date) VALUES (?, ?)'
  );
  const getEventsStmt = db.prepare(
    'SELECT name, date FROM events ORDER BY id ASC'
  );

  const upsertAttendanceStmt = db.prepare(`
    INSERT INTO attendance (id, payload, updatedAt)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload = excluded.payload,
      updatedAt = excluded.updatedAt
  `);
  const getAttendanceRowsStmt = db.prepare(
    'SELECT id, payload FROM attendance ORDER BY id ASC'
  );

  const insertProfileAttendanceStmt = db.prepare(`
    INSERT INTO attendanceProfiles (id, userId, subject, attended, total, percentage, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const getProfileAttendanceByUserStmt = db.prepare(`
    SELECT id, subject, attended, total, percentage, createdAt
    FROM attendanceProfiles
    WHERE userId = ?
    ORDER BY createdAt DESC
  `);

  function getChats() {
    return getChatsStmt.all().map(row => safeParseJson(row.payload, row.payload));
  }

  function getEvents() {
    return getEventsStmt.all().map(row => ({
      name: row.name,
      date: row.date
    }));
  }

  function getAttendanceMap() {
    const rows = getAttendanceRowsStmt.all();
    const result = {};
    rows.forEach(row => {
      const payload = safeParseJson(row.payload, { id: row.id });
      result[row.id] = payload && typeof payload === 'object' ? payload : { id: row.id };
    });
    return result;
  }

  function migrateLegacyJsonIfNeeded() {
    const isEmpty =
      tableCount('users') === 0 &&
      tableCount('chats') === 0 &&
      tableCount('events') === 0 &&
      tableCount('attendance') === 0 &&
      tableCount('attendanceProfiles') === 0;
    if (!isEmpty) return;

    const legacyPath = path.join(__dirname, 'db.json');
    if (!fs.existsSync(legacyPath)) return;

    try {
      const legacyRaw = fs.readFileSync(legacyPath, 'utf8');
      const legacy = safeParseJson(legacyRaw, {});

      if (Array.isArray(legacy.users)) {
        legacy.users.forEach(user => {
          const id = String(user?.id || '').trim();
          if (!id) return;
          const name = String(user?.name || '').trim();
          const studentId = String(user?.studentId || '').trim();
          const email = String(user?.email || '').trim().toLowerCase();
          const passwordSalt = String(user?.passwordSalt || '').trim();
          const passwordHash = String(user?.passwordHash || '').trim();
          const createdAt = String(user?.createdAt || new Date().toISOString());
          if (!name || !studentId || !email || !passwordSalt || !passwordHash) return;
          try {
            insertUserStmt.run(id, name, studentId, email, passwordSalt, passwordHash, createdAt);
          } catch (_err) {
            // Ignore duplicate/bad rows from legacy import.
          }
        });
      }

      if (Array.isArray(legacy.chats)) {
        legacy.chats.forEach(chat => {
          const payload = JSON.stringify(chat);
          const createdAt =
            chat && typeof chat === 'object' && chat.time
              ? String(chat.time)
              : new Date().toISOString();
          insertChatStmt.run(payload, createdAt);
        });
      }

      if (Array.isArray(legacy.events)) {
        legacy.events.forEach(eventInfo => {
          const name = String(eventInfo?.name || '').trim();
          const date = String(eventInfo?.date || '').trim();
          if (!name || !date) return;
          insertEventStmt.run(name, date);
        });
      }

      if (legacy.attendance && typeof legacy.attendance === 'object') {
        Object.entries(legacy.attendance).forEach(([id, payload]) => {
          const safeId = String(id || '').trim();
          if (!safeId) return;
          const packed = JSON.stringify(payload || {});
          upsertAttendanceStmt.run(safeId, packed, new Date().toISOString());
        });
      }

      if (legacy.attendanceProfiles && typeof legacy.attendanceProfiles === 'object') {
        Object.entries(legacy.attendanceProfiles).forEach(([userId, records]) => {
          const safeUserId = String(userId || '').trim();
          if (!safeUserId || !Array.isArray(records)) return;
          records.forEach(record => {
            const subject = String(record?.subject || '').trim();
            const attended = Number(record?.attended);
            const total = Number(record?.total);
            if (!subject || Number.isNaN(attended) || Number.isNaN(total) || total <= 0) return;

            const id = String(record?.id || '').trim() || (
              typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID()
                : crypto.randomBytes(12).toString('hex')
            );
            const percentage =
              Number.isFinite(Number(record?.percentage))
                ? Number(record.percentage)
                : Number(((attended / total) * 100).toFixed(2));
            const createdAt = String(record?.createdAt || new Date().toISOString());

            try {
              insertProfileAttendanceStmt.run(
                id,
                safeUserId,
                subject,
                attended,
                total,
                percentage,
                createdAt
              );
            } catch (_err) {
              // Ignore duplicate rows during import.
            }
          });
        });
      }
    } catch (err) {
      console.error('Legacy db.json migration skipped:', err.message);
    }
  }

  migrateLegacyJsonIfNeeded();

  if (tableCount('events') === 0) {
    insertEventStmt.run('Texus 2026', 'Feb 27 & 28');
  }

  function requireAuth(req, res, next) {
    const token = getTokenFromRequest(req);
    if (!token) return res.status(401).json({ error: 'Sign in required' });

    const session = sessions.get(token);
    if (!session) return res.status(401).json({ error: 'Session expired. Sign in again.' });

    const user = getUserByIdStmt.get(session.userId);
    if (!user) {
      sessions.delete(token);
      return res.status(401).json({ error: 'User not found. Sign in again.' });
    }

    req.auth = { token, user };
    next();
  }

  // Chat
  io.on('connection', socket => {
    socket.on('message', msg => {
      insertChatStmt.run(JSON.stringify(msg), new Date().toISOString());
      io.emit('messages', getChats());
    });
  });

  // Auth
  app.post('/auth/signup', (req, res) => {
    const { name, studentId, email, password } = req.body || {};
    const safeName = String(name || '').trim();
    const safeStudentId = String(studentId || '').trim();
    const safeEmail = String(email || '').trim().toLowerCase();
    const safePassword = String(password || '');

    if (!safeName || !safeStudentId || !safeEmail || !safePassword) {
      return res.status(400).json({ error: 'All signup fields are required' });
    }
    if (safePassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = getUserByEmailStmt.get(safeEmail);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const id = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString('hex');
    const passwordRecord = createPasswordRecord(safePassword);
    const createdAt = new Date().toISOString();

    insertUserStmt.run(
      id,
      safeName,
      safeStudentId,
      safeEmail,
      passwordRecord.salt,
      passwordRecord.hash,
      createdAt
    );

    const token = createSession(id);
    const user = getUserByIdStmt.get(id);
    res.json({ token, user: toPublicUser(user) });
  });

  app.post('/auth/signin', (req, res) => {
    const { email, password } = req.body || {};
    const safeEmail = String(email || '').trim().toLowerCase();
    const safePassword = String(password || '');
    if (!safeEmail || !safePassword) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = getUserByEmailStmt.get(safeEmail);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const expectedHash = hashPassword(safePassword, user.passwordSalt);
    if (expectedHash !== user.passwordHash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = createSession(user.id);
    res.json({ token, user: toPublicUser(user) });
  });

  app.get('/auth/me', requireAuth, (req, res) => {
    res.json({ user: toPublicUser(req.auth.user) });
  });

  app.post('/auth/signout', requireAuth, (req, res) => {
    sessions.delete(req.auth.token);
    res.json({ success: true });
  });

  // Private profile attendance
  app.get('/profile', requireAuth, (req, res) => {
    const userId = req.auth.user.id;
    const records = getProfileAttendanceByUserStmt.all(userId).map(record => ({
      id: record.id,
      subject: record.subject,
      attended: Number(record.attended),
      total: Number(record.total),
      percentage: Number(record.percentage),
      createdAt: record.createdAt
    }));
    const summary = summarizeAttendance(records);

    res.json({
      user: toPublicUser(req.auth.user),
      overall: summary.overall,
      subjectTotals: summary.subjectTotals,
      history: records
    });
  });

  app.post('/profile/attendance', requireAuth, (req, res) => {
    const subject = String(req.body?.subject || '').trim();
    const attended = Number(req.body?.attended);
    const total = Number(req.body?.total);

    if (!subject) return res.status(400).json({ error: 'Subject is required' });
    if (Number.isNaN(attended) || attended < 0) {
      return res.status(400).json({ error: 'Attended classes must be 0 or higher' });
    }
    if (Number.isNaN(total) || total <= 0) {
      return res.status(400).json({ error: 'Total classes must be greater than 0' });
    }
    if (attended > total) {
      return res.status(400).json({ error: 'Attended classes cannot exceed total classes' });
    }

    const userId = req.auth.user.id;
    const id = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : crypto.randomBytes(12).toString('hex');
    const percentage = Number(((attended / total) * 100).toFixed(2));
    const createdAt = new Date().toISOString();

    insertProfileAttendanceStmt.run(
      id,
      userId,
      subject,
      attended,
      total,
      percentage,
      createdAt
    );

    res.json({
      saved: true,
      record: { id, subject, attended, total, percentage, createdAt }
    });
  });

  // APIs
  app.get('/events', (req, res) => res.json(getEvents()));
  app.get('/chats', (req, res) => res.json(getChats()));
  app.get('/attendance', (req, res) => res.json(getAttendanceMap()));

  app.post('/attendance', (req, res) => {
    const id = String(req.body?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Student ID is required' });
    const payload = Object.assign({}, req.body, { id });
    upsertAttendanceStmt.run(id, JSON.stringify(payload), new Date().toISOString());
    res.json('Saved');
  });

  app.get('/videos/:topic', async (req, res) => {
    const topic = req.params.topic;
    try {
      const items = await fetchYouTubeVideos(topic, 6);
      res.json(items);
    } catch (err) {
      console.error('YouTube fetch error', err);
      res.status(500).json({ error: err.message || 'Failed to fetch videos' });
    }
  });

  app.post('/ai/analyze-note', async (req, res) => {
    const { fileName, mimeType, dataUrl, extractedText } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string') {
      return res.status(400).json({ error: 'Missing uploaded file data' });
    }

    const dataMatch = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    const detectedMime = dataMatch?.[1] || mimeType || 'application/octet-stream';
    const base64 = dataMatch?.[2] || dataUrl;

    if (!base64 || base64.length < 10) {
      return res.status(400).json({ error: 'Invalid uploaded file data' });
    }

    let analysis = null;
    let engine = 'fallback';
    let engineNote = '';

    try {
      analysis = await analyzeWithGemini({ base64, mimeType: detectedMime, fileName });
      if (analysis) {
        engine = 'gemini';
        engineNote = 'Gemini analysis completed.';
      }
    } catch (err) {
      console.error('Gemini analyze error', err.message);
      const cleanedError = String(err.message || 'Unknown Gemini error').replace(/\s+/g, ' ').trim();
      const lowered = cleanedError.toLowerCase();

      if (lowered.includes('quota') || lowered.includes('resource_exhausted')) {
        engineNote = 'Gemini quota exceeded. Using local fallback summary.';
      } else if (lowered.includes('api key') || lowered.includes('permission') || lowered.includes('unauthorized')) {
        engineNote = 'Gemini key/permission issue. Using local fallback summary.';
      } else {
        const shortError = (cleanedError.split('. ')[0] || cleanedError).slice(0, 110);
        engineNote = `Gemini unavailable. Using local fallback summary. (${shortError})`;
      }
    }

    if (!analysis) {
      const text =
        typeof extractedText === 'string' && extractedText.trim()
          ? extractedText.trim()
          : decodeTextFromBase64(base64, detectedMime, fileName);
      analysis = summarizeFromText(text, fileName, detectedMime);
    }

    const searchTopic = analysis.searchQuery || analysis.topic || 'study notes';
    let videos = [];
    try {
      videos = await fetchYouTubeVideos(searchTopic, 4);
    } catch (err) {
      console.error('YouTube suggestion error', err.message);
    }

    res.json({
      topic: analysis.topic,
      summary: analysis.summary,
      keyPoints: analysis.keyPoints || [],
      searchTopic,
      videos,
      engine,
      engineNote
    });
  });

  const pageRoutes = {
    '/': 'index.html',
    '/resources': 'resources.html',
    '/gradepilot': 'gradepilot.html',
    '/study-plus': 'study-plus.html',
    '/ai-tutor': 'ai-tutor.html',
    '/developer': 'developer.html',
    '/contributors': 'contributors.html'
  };

  Object.entries(pageRoutes).forEach(([routePath, fileName]) => {
    app.get(routePath, (req, res) => {
      res.sendFile(path.join(__dirname, fileName));
    });
  });

  // Fallback page for unknown browser routes.
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || '0.0.0.0';

  server.listen(PORT, HOST, () => {
    const lanIp = getLocalIpv4();
    console.log(`Run at http://localhost:${PORT}`);
    if (lanIp) console.log(`LAN URL: http://${lanIp}:${PORT}`);
  });

  process.on('exit', () => {
    try {
      db.close();
    } catch (_err) {
      // Ignore close errors during process shutdown.
    }
  });
})();
