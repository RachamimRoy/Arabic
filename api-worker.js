const ALLOWED_ORIGINS = new Set([
  "https://rachamimroy.github.io",
  "http://localhost:8000",
]);

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "https://rachamimroy.github.io";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

const SPREADSHEET_ID = "1oOI5YFHJ2K8fDkMTykxogmslsszNNFZEd1Ol8Nwk6_U";
const GOOGLE_CLIENT_ID = "174097869132-96j8tu8po9hot556h35d92267gb52mc2.apps.googleusercontent.com";
const AUDIO_PILOT_TEXTS = new Set([
  "جُزْء",
  "هَادَا جُزْء مُهِمّ مِنَ الدَّرْس.",
  "اِسْتِمْرَار",
  "اِسْتِمْرَار الشُّغْل بِدُّه صَبْر.",
  "إِبْدَاع",
  "عِنْدَهَا إِبْدَاع بِالتَّصْمِيم.",
  "حَادِث طُرُق",
  "صَار حَادِث طُرُق قُرْب البَلَد.",
  "سَيَّارَة إِسْعَاف",
  "وِصْلِت سَيَّارَة إِسْعَاف بِسُرْعَة.",
]);

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (c === '"' && quoted && next === '"') { cell += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && next === "\n") i++;
      row.push(cell);
      if (row.some(value => value !== "")) rows.push(row);
      row = []; cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some(value => value !== "")) rows.push(row);
  return rows;
}

async function fetchSheet(sheet) {
  const source = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheet)}`;
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Could not load sheet: ${sheet}`);
  return response.text();
}

async function activeLessonSheets() {
  const rows = parseCsv(await fetchSheet("Lessons"));
  if (rows.length < 2) return new Set();
  const headers = rows[0].map(value => value.trim().toLowerCase());
  const sheetColumn = headers.indexOf("sheet");
  const activeColumn = headers.indexOf("active");
  return new Set(rows.slice(1).filter(row => {
    const active = String(row[activeColumn] || "").trim().toUpperCase();
    return sheetColumn >= 0 && activeColumn >= 0 && !["FALSE", "0", "NO"].includes(active);
  }).map(row => String(row[sheetColumn] || "").trim()).filter(Boolean));
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origin) },
  });
}

function clean(value, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

const USER_ID_PATTERN = /^[a-f0-9]{32}$/;
const SESSION_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

async function ensureProgressTable(env) {
  if (!env.DB) throw new Error("D1 binding DB is missing");
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_progress (
      user_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
}

async function ensureAuthTables(env) {
  await ensureProgressTable(env);
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY,
      email TEXT,
      name TEXT,
      picture TEXT,
      updated_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();
}

function randomHex(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
}

async function googleUserId(sub) {
  const data = new TextEncoder().encode(`google:${sub}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return `google_${[...digest].map(value => value.toString(16).padStart(2, "0")).join("")}`;
}

async function verifyGoogleCredential(credential) {
  const token = clean(credential, 5000);
  if (!token) throw new Error("Missing Google credential");
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
  const profile = await response.json();
  if (!response.ok) throw new Error("Google sign-in could not be verified");
  const issuerOk = profile.iss === "accounts.google.com" || profile.iss === "https://accounts.google.com";
  if (!issuerOk || profile.aud !== GOOGLE_CLIENT_ID || !profile.sub || Number(profile.exp || 0) * 1000 <= Date.now()) {
    throw new Error("Invalid Google credential");
  }
  return profile;
}

async function resolveProgressUser(env, userIdValue, sessionTokenValue) {
  const sessionToken = clean(sessionTokenValue, 64).toLowerCase();
  if (SESSION_TOKEN_PATTERN.test(sessionToken)) {
    await ensureAuthTables(env);
    const row = await env.DB.prepare(
      "SELECT user_id FROM auth_sessions WHERE token = ? AND expires_at > ?"
    ).bind(sessionToken, new Date().toISOString()).first();
    if (row?.user_id) return row.user_id;
    throw new Error("Session expired");
  }
  const anonymousUserId = validUserId(userIdValue);
  if (anonymousUserId) return anonymousUserId;
  throw new Error("Invalid user code");
}

function mergeWordProgress(first, second) {
  if (!first) return second;
  if (!second) return first;
  const firstTime = Date.parse(first.updatedAt || "") || 0;
  const secondTime = Date.parse(second.updatedAt || "") || 0;
  if (firstTime || secondTime) return secondTime > firstTime ? second : first;
  if (first.status === "retry" || second.status === "retry") {
    const candidates = [first, second].filter(value => value.status === "retry");
    return candidates.sort((a, b) => (a.successes || 0) - (b.successes || 0))[0];
  }
  return first.status === "known" ? first : second;
}

function mergeProgressStates(first, second) {
  if (!first) return second;
  if (!second) return first;
  const firstTime = Date.parse(first.savedAt || "") || 0;
  const secondTime = Date.parse(second.savedAt || "") || 0;
  const newer = secondTime > firstTime ? second : first;
  const merged = structuredClone(newer);
  merged.progress = {};
  const ids = new Set([...Object.keys(first.progress || {}), ...Object.keys(second.progress || {})]);
  for (const id of ids) merged.progress[id] = mergeWordProgress(first.progress?.[id], second.progress?.[id]);
  merged.sessionNumber = Math.max(first.sessionNumber || 0, second.sessionNumber || 0);
  merged.savedAt = new Date(Math.max(firstTime, secondTime, Date.now())).toISOString();
  return merged;
}

async function signInWithGoogle(env, credential, anonymousUserIdValue) {
  await ensureAuthTables(env);
  const google = await verifyGoogleCredential(credential);
  const userId = await googleUserId(google.sub);
  const now = new Date();
  const nowIso = now.toISOString();
  await env.DB.prepare(`
    INSERT INTO user_profiles (user_id, email, name, picture, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      picture = excluded.picture,
      updated_at = excluded.updated_at
  `).bind(userId, clean(google.email, 320), clean(google.name, 200), clean(google.picture, 1000), nowIso).run();

  const anonymousUserId = validUserId(anonymousUserIdValue);
  if (anonymousUserId && anonymousUserId !== userId) {
    const anonymousRow = await env.DB.prepare(
      "SELECT state_json, updated_at FROM user_progress WHERE user_id = ?"
    ).bind(anonymousUserId).first();
    const googleRow = await env.DB.prepare(
      "SELECT state_json, updated_at FROM user_progress WHERE user_id = ?"
    ).bind(userId).first();
    if (anonymousRow) {
      const anonymousState = JSON.parse(anonymousRow.state_json);
      const googleState = googleRow ? JSON.parse(googleRow.state_json) : null;
      const mergedState = mergeProgressStates(googleState, anonymousState);
      await env.DB.prepare(`
        INSERT INTO user_progress (user_id, state_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
      `).bind(userId, JSON.stringify(mergedState), new Date().toISOString()).run();
    }
    if (anonymousRow) await env.DB.prepare("DELETE FROM user_progress WHERE user_id = ?").bind(anonymousUserId).run();
  }

  const sessionToken = randomHex(32);
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO auth_sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).bind(sessionToken, userId, expiresAt, nowIso).run();
  return {
    sessionToken,
    expiresAt,
    profile: { email: google.email || "", name: google.name || "", picture: google.picture || "" },
  };
}

function validUserId(value) {
  const userId = clean(value, 32).toLowerCase();
  return USER_ID_PATTERN.test(userId) ? userId : "";
}

async function loadProgress(env, userId) {
  await ensureProgressTable(env);
  const row = await env.DB.prepare(
    "SELECT state_json, updated_at FROM user_progress WHERE user_id = ?"
  ).bind(userId).first();
  if (!row) return { found: false, state: null };
  return { found: true, state: JSON.parse(row.state_json), updatedAt: row.updated_at };
}

async function saveProgress(env, userId, state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Invalid progress state");
  await ensureProgressTable(env);
  const existingRow = await env.DB.prepare(
    "SELECT state_json FROM user_progress WHERE user_id = ?"
  ).bind(userId).first();
  let existingState = null;
  if (existingRow?.state_json) {
    try {
      existingState = JSON.parse(existingRow.state_json);
    } catch (error) {
      console.error("Could not parse existing progress state", error);
    }
  }
  // Progress is synced from more than one browser/device. Never let a stale or
  // empty full-state upload erase newer per-word results already stored in D1.
  // Explicit deletion remains the responsibility of resetProgress().
  const mergedState = mergeProgressStates(existingState, state) || state;
  const stateJson = JSON.stringify(mergedState);
  if (stateJson.length > 900000) throw new Error("Progress state is too large");
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO user_progress (user_id, state_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `).bind(userId, stateJson, updatedAt).run();
  return { ok: true, updatedAt, state: mergedState };
}

async function resetProgress(env, userId) {
  await ensureProgressTable(env);
  await env.DB.prepare("DELETE FROM user_progress WHERE user_id = ?").bind(userId).run();
  return { ok: true };
}

async function callOpenAI(env, instructions, input, schemaName, schema) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5-mini",
      instructions,
      input,
      reasoning: { effort: "minimal" },
      max_output_tokens: 1200,
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          strict: true,
          schema,
        },
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "OpenAI request failed");
  const outputText = data.output
    ?.flatMap(item => item.content || [])
    ?.find(item => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI returned no text");
  return JSON.parse(outputText);
}

async function generateExample(env, body) {
  const word = clean(body.word, 100);
  const meaning = clean(body.meaning, 200);
  const grammar = clean(body.grammar, 200);
  if (!word || !meaning) throw new Error("Missing word or meaning");

  return callOpenAI(
    env,
    "You are a careful Palestinian Arabic tutor. Use natural Palestinian colloquial Arabic, not Egyptian Arabic or formal MSA unless the supplied word itself is formal. Return only the requested structured data. The example must clearly use the supplied target word or a natural inflected form of it.",
    `Target word: ${word}\nHebrew meaning: ${meaning}\nGrammar: ${grammar || "not supplied"}`,
    "arabic_example",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        sentence: { type: "string" },
        translation: { type: "string" },
        word_transliteration_hebrew: { type: "string" },
      },
      required: ["sentence", "translation", "word_transliteration_hebrew"],
    }
  );
}

async function evaluateAnswer(env, body) {
  const word = clean(body.word, 100);
  const accepted = Array.isArray(body.acceptedMeanings)
    ? body.acceptedMeanings.slice(0, 10).map(v => clean(v, 100)).filter(Boolean)
    : [];
  const answer = clean(body.answer, 300);
  if (!word || !accepted.length || !answer) throw new Error("Missing evaluation fields");

  return callOpenAI(
    env,
    "You are a careful Palestinian Arabic tutor checking a Hebrew translation of one Arabic vocabulary item. Accept synonymous Hebrew wording when semantically correct. Ignore harmless spelling and punctuation differences. If the answer is wrong, return a concise accepted correction in Hebrew only. If it is correct, correction must be an empty string. Return only the requested structured data.",
    `Arabic word: ${word}\nAccepted Hebrew meanings: ${accepted.join(" / ")}\nLearner answer: ${answer}`,
    "vocabulary_evaluation",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        correct: { type: "boolean" },
        correction: { type: "string" },
      },
      required: ["correct", "correction"],
    }
  );
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function generatePilotSpeech(env, body) {
  const text = clean(body.text, 500);
  if (!AUDIO_PILOT_TEXTS.has(text)) throw new Error("Text is not part of the audio pilot");
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing");
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "cedar",
      input: text,
      instructions: "Speak in natural Palestinian Arabic, clearly and conversationally, slightly slower than normal for a language learner. Preserve the exact wording. Do not translate or add words.",
      response_format: "mp3",
    }),
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Speech generation failed (${response.status}): ${details.slice(0, 300)}`);
  }
  return { audioBase64: arrayBufferToBase64(await response.arrayBuffer()), mimeType: "audio/mpeg" };
}

function sheetRowById(rows, requestedId) {
  if (rows.length < 2) return null;
  const headers = rows[0].map(value => value.trim().toLowerCase());
  const idColumn = headers.indexOf("id");
  const arabicColumn = headers.indexOf("arabic");
  const exampleColumn = headers.indexOf("example");
  const activeColumn = headers.indexOf("active");
  if (idColumn < 0 || arabicColumn < 0) return null;
  const row = rows.slice(1).find(value => String(value[idColumn] || "").trim() === requestedId);
  if (!row) return null;
  const active = activeColumn < 0 ? "TRUE" : String(row[activeColumn] || "").trim().toUpperCase();
  if (["FALSE", "0", "NO"].includes(active)) return null;
  return {
    word: clean(row[arabicColumn], 500),
    sentence: exampleColumn < 0 ? "" : clean(row[exampleColumn], 500),
  };
}

async function generateVocabularySpeech(env, body) {
  const sheet = clean(body.sheet, 120);
  const id = clean(body.id, 160);
  const kind = clean(body.kind, 20);
  if (!sheet || !id || !["word", "sentence"].includes(kind)) throw new Error("Missing or invalid audio fields");
  if (!(await activeLessonSheets()).has(sheet)) throw new Error("Unknown or inactive lesson");
  const item = sheetRowById(parseCsv(await fetchSheet(sheet)), id);
  if (!item) throw new Error("Vocabulary item was not found");
  const text = kind === "word" ? item.word : item.sentence;
  if (!text) throw new Error("This item has no text for the requested audio");
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing");
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "cedar",
      input: text,
      instructions: "Speak in natural Palestinian Arabic, clearly and conversationally, slightly slower than normal for a language learner. Preserve the exact wording. Do not translate or add words.",
      response_format: "mp3",
    }),
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Speech generation failed (${response.status}): ${details.slice(0, 300)}`);
  }
  return { id, kind, audioBase64: arrayBufferToBase64(await response.arrayBuffer()), mimeType: "audio/mpeg" };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (request.method === "GET") {
      const url = new URL(request.url);
      const action = url.searchParams.get("action");
      if (action === "lessons" || action === "vocabulary") {
        if (!ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin not allowed" }, 403, origin);
        try {
          const sheet = action === "lessons" ? "Lessons" : url.searchParams.get("sheet");
          if (!sheet) return json({ error: "Missing sheet" }, 400, origin);
          if (action === "vocabulary" && !(await activeLessonSheets()).has(sheet)) return json({ error: "Unknown or inactive lesson" }, 400, origin);
          return new Response(await fetchSheet(sheet), {headers:{"Content-Type":"text/csv; charset=utf-8","Cache-Control":"public, max-age=60",...cors(origin)}});
        } catch (error) {
          return json({ error: error.message || "Could not load spreadsheet" }, 502, origin);
        }
      }
      if (action === "progress") {
        if (!ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin not allowed" }, 403, origin);
        const userId = await resolveProgressUser(env, url.searchParams.get("user"), url.searchParams.get("session"));
        return json(await loadProgress(env, userId), 200, origin);
      }
      return json({ ok: true, service: "arabic-app-api", version: "17.6-audio-batch" }, 200, origin);
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
    if (!ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin not allowed" }, 403, origin);

    try {
      const body = await request.json();
      let result;
      if (body.action === "generate") result = await generateExample(env, body);
      else if (body.action === "evaluate") result = await evaluateAnswer(env, body);
      else if (body.action === "pilot-speech") result = await generatePilotSpeech(env, body);
      else if (body.action === "vocabulary-speech") result = await generateVocabularySpeech(env, body);
      else if (body.action === "google-login") result = await signInWithGoogle(env, body.credential, body.anonymousUserId);
      else if (body.action === "save-progress") {
        const userId = await resolveProgressUser(env, body.userId, body.sessionToken);
        result = await saveProgress(env, userId, body.state);
      }
      else if (body.action === "reset-progress") {
        const userId = await resolveProgressUser(env, body.userId, body.sessionToken);
        result = await resetProgress(env, userId);
      }
      else return json({ error: "Unknown action" }, 400, origin);
      return json(result, 200, origin);
    } catch (error) {
      console.error(error);
      return json({ error: error.message || "Unexpected error" }, 500, origin);
    }
  },
};
