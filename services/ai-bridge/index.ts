/**
 * VITALORA AI — ai-bridge sidecar (Bun runtime)
 *
 * Provider-independent HTTP bridge in front of the z-ai-web-dev-sdk (Node-only SDK,
 * run here under Bun). Called server-side ONLY by the FastAPI backend
 * (services/ai-backend app/providers/*) at http://127.0.0.1:8100.
 * NEVER import this module from frontend code.
 *
 * Endpoints:
 *   GET  /health     → liveness + provider map
 *   POST /llm/chat   → LLM chat completion (thinking disabled for voice latency)
 *   POST /stt        → speech-to-text (base64 audio)
 *   POST /tts        → text-to-speech (wav; >1024 chars auto-chunked + PCM-merged)
 *   POST /embeddings → honest 501 stub (retrieval uses FTS5)
 *
 * Logging: one structured JSON line per request — {ts, level, route, duration_ms,
 * status, meta:{chars, audio_bytes}} — never payloads, never credentials.
 */

import ZAI from "z-ai-web-dev-sdk";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT: number = Number.parseInt(process.env.AI_BRIDGE_PORT ?? "", 10) || 8100;

const MAX_BODY_BYTES = 40 * 1024 * 1024; // ~40MB (STT audio arrives base64)
const MAX_STT_DECODED_BYTES = 25 * 1024 * 1024; // 25MB decoded
const MAX_LLM_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 32_000;
const PROVIDER_TIMEOUT_MS = 60_000;

const TTS_PROVIDER_CHAR_LIMIT = 1024; // hard ZAI TTS constraint per request
const TTS_CHUNK_TARGET = 950; // chunk below the provider limit, on sentence bounds
const TTS_MIN_CHUNK_CUT = 40; // never emit a tiny leading chunk
const TTS_CHUNK_CONCURRENCY = 1; // provider 429s concurrent TTS; sequential is reliable
const MAX_TTS_TEXT_CHARS = 50_000; // guardrail: ~53 provider calls worst case

// Transient provider failures worth one honest retry (SDK message embeds status).
const RETRYABLE_PROVIDER_STATUS_RE = /API request failed with status (?:429|500|502|503)\b/;
const PROVIDER_RETRY_DELAYS_MS = [1_200, 3_000] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChatRole = "system" | "user" | "assistant";

interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null } | null;
  }> | null;
  model?: string | null;
}

interface AsrResponse {
  text?: string | null;
}

interface WavInfo {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  pcm: Buffer;
}

interface LogMeta {
  chars?: number | null;
  audio_bytes?: number | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// ZAI singleton (lazy create on first use, retry creation on failure)
// ---------------------------------------------------------------------------

type ZAIClient = Awaited<ReturnType<typeof ZAI.create>>;

let zaiPromise: Promise<ZAIClient> | null = null;

function getZai(): Promise<ZAIClient> {
  if (zaiPromise === null) {
    zaiPromise = ZAI.create().catch((err: unknown) => {
      // Reset so the NEXT request retries creation instead of caching the failure.
      zaiPromise = null;
      throw err;
    });
  }
  return zaiPromise;
}

// ---------------------------------------------------------------------------
// Errors & timeout
// ---------------------------------------------------------------------------

class ProviderTimeoutError extends Error {}

class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProviderTimeoutError(`${what} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Retry transient provider failures (429/500/502/503) with fixed backoff.
 * The SDK only surfaces status codes inside its error message. After the
 * retries are exhausted the last error is thrown and mapped to 502 — no fake
 * success, ever.
 */
async function withProviderRetries<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= PROVIDER_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = PROVIDER_RETRY_DELAYS_MS[attempt - 1] ?? 1_000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : "";
      if (!RETRYABLE_PROVIDER_STATUS_RE.test(message)) throw err;
    }
  }
  throw lastError;
}

/** Strip anything credential-like and cap length before surfacing an SDK error. */
function sanitizeProviderMessage(raw: string): string {
  let msg = raw.replace(/\s+/g, " ").trim();
  msg = msg.replace(
    /((?:api[_-]?key|authorization|bearer|token|x-token)["':\s=]+)[^\s"',}]+/gi,
    "$1[redacted]",
  );
  return msg.length > 500 ? `${msg.slice(0, 497)}...` : msg;
}

/** Map any thrown value to an honest (status, code, message) tuple. */
function toApiError(err: unknown, what: string): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ProviderTimeoutError) {
    return new ApiError(504, "timeout", err.message);
  }
  const message =
    err instanceof Error ? sanitizeProviderMessage(err.message) : "unknown provider failure";
  return new ApiError(502, "provider_error", `${what}: ${message}`);
}

// ---------------------------------------------------------------------------
// Structured logging (no payloads, no credentials)
// ---------------------------------------------------------------------------

function logRequest(
  level: "info" | "warn" | "error",
  route: string,
  startedAt: number,
  status: number,
  meta: LogMeta = {},
): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      route,
      duration_ms: Date.now() - startedAt,
      status,
      meta,
    }),
  );
}

function logEvent(level: "info" | "warn" | "error", route: string, meta: LogMeta): void {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), level, route, duration_ms: 0, status: 0, meta }),
  );
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function apiError(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read + parse a JSON body with a hard size cap. */
async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number.parseInt(declared, 10) > MAX_BODY_BYTES) {
    throw new ApiError(413, "payload_too_large", `Body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw new ApiError(413, "payload_too_large", `Body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  if (raw.trim().length === 0) {
    throw new ApiError(400, "invalid_json", "Request body is empty; expected JSON");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "invalid_json", "Request body is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new ApiError(400, "invalid_body", "Request body must be a JSON object");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_ROLES: ReadonlySet<string> = new Set(["system", "user", "assistant"]);

function validateMessages(body: Record<string, unknown>): ChatMessage[] {
  const raw = body.messages;
  if (!Array.isArray(raw)) {
    throw new ApiError(400, "invalid_messages", "`messages` must be an array");
  }
  if (raw.length < 1 || raw.length > MAX_LLM_MESSAGES) {
    throw new ApiError(
      400,
      "invalid_messages",
      `\`messages\` must contain 1-${MAX_LLM_MESSAGES} items, got ${raw.length}`,
    );
  }
  return raw.map((item, idx) => {
    if (!isRecord(item)) {
      throw new ApiError(400, "invalid_messages", `messages[${idx}] must be an object`);
    }
    const { role, content } = item;
    if (typeof role !== "string" || !VALID_ROLES.has(role)) {
      throw new ApiError(
        400,
        "invalid_messages",
        `messages[${idx}].role must be one of system|user|assistant`,
      );
    }
    if (typeof content !== "string") {
      throw new ApiError(400, "invalid_messages", `messages[${idx}].content must be a string`);
    }
    if (content.length === 0) {
      throw new ApiError(400, "invalid_messages", `messages[${idx}].content must not be empty`);
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      throw new ApiError(
        400,
        "invalid_messages",
        `messages[${idx}].content exceeds ${MAX_MESSAGE_CHARS} chars`,
      );
    }
    return { role: role as ChatRole, content };
  });
}

function validateNumber(
  body: Record<string, unknown>,
  key: string,
  opts: { min: number; max: number; required: boolean; fallback: number },
): number {
  const value = body[key];
  if (value === undefined || value === null) {
    if (opts.required) {
      throw new ApiError(400, "invalid_request", `\`${key}\` is required`);
    }
    return opts.fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiError(400, "invalid_request", `\`${key}\` must be a finite number`);
  }
  if (value < opts.min || value > opts.max) {
    throw new ApiError(
      400,
      "invalid_request",
      `\`${key}\` must be between ${opts.min} and ${opts.max}, got ${value}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// POST /llm/chat
// ---------------------------------------------------------------------------

async function handleLlmChat(req: Request, startedAt: number): Promise<Response> {
  const body = await readJsonBody(req);
  const messages = validateMessages(body);
  const temperature = validateNumber(body, "temperature", {
    min: 0,
    max: 2,
    required: false,
    fallback: 0.4,
  });
  let maxTokens: number | undefined;
  if (body.max_tokens !== undefined && body.max_tokens !== null) {
    const value = body.max_tokens;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new ApiError(400, "invalid_request", "`max_tokens` must be a positive integer");
    }
    maxTokens = value;
  }

  const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0);

  const zai = await getZai();
  const completion = (await withTimeout(
    withProviderRetries(() =>
      zai.chat.completions.create({
        messages,
        temperature,
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        thinking: { type: "disabled" }, // always disabled for voice latency
      }),
    ),
    PROVIDER_TIMEOUT_MS,
    "llm.chat",
  )) as ChatCompletionResponse;

  const content = completion?.choices?.[0]?.message?.content ?? "";
  const model = typeof completion?.model === "string" && completion.model.length > 0
    ? completion.model
    : "unknown";

  logRequest("info", "/llm/chat", startedAt, 200, {
    chars: promptChars,
    audio_bytes: null,
    chars_out: content.length,
    model,
  });
  return json(200, { content, model });
}

// ---------------------------------------------------------------------------
// POST /stt
// ---------------------------------------------------------------------------

const DATA_URI_PREFIX = /^data:audio\/[^;]+;base64,/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeAudioBase64(body: Record<string, unknown>): Buffer {
  const raw = body.file_base64;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiError(400, "invalid_request", "`file_base64` must be a non-empty string");
  }
  const stripped = raw.replace(DATA_URI_PREFIX, "").replace(/\s+/g, "");
  if (stripped.length === 0 || stripped.length % 4 !== 0 || !BASE64_RE.test(stripped)) {
    throw new ApiError(400, "invalid_base64", "`file_base64` is not valid base64");
  }
  const decoded = Buffer.from(stripped, "base64");
  if (decoded.length === 0) {
    throw new ApiError(400, "invalid_base64", "`file_base64` decodes to zero bytes");
  }
  if (decoded.length > MAX_STT_DECODED_BYTES) {
    throw new ApiError(
      413,
      "payload_too_large",
      `Decoded audio exceeds ${MAX_STT_DECODED_BYTES} bytes`,
    );
  }
  return decoded;
}

async function handleStt(req: Request, startedAt: number): Promise<Response> {
  const body = await readJsonBody(req);
  // `language` accepted for forward-compat; ZAI ASR auto-detects.
  if (body.language !== undefined && typeof body.language !== "string") {
    throw new ApiError(400, "invalid_request", "`language` must be a string when provided");
  }
  const decoded = decodeAudioBase64(body);

  const zai = await getZai();
  const response = (await withTimeout(
    withProviderRetries(() => zai.audio.asr.create({ file_base64: decoded.toString("base64") })),
    PROVIDER_TIMEOUT_MS,
    "stt",
  )) as AsrResponse;

  // Empty transcription is still a 200 — the caller decides it is silence.
  const text = typeof response?.text === "string" ? response.text : "";
  logRequest("info", "/stt", startedAt, 200, {
    chars: text.length,
    audio_bytes: decoded.length,
  });
  return json(200, { text });
}

// ---------------------------------------------------------------------------
// POST /tts — WAV synthesis + PCM merge for multi-chunk
// ---------------------------------------------------------------------------
// Provider reality (probed): ZAI TTS accepts response_format "wav" (and pcm for
// streaming) but REJECTS "mp3" with error 1214 ("unsupported response_format").
// The returned WAV carries a non-standard extra "AIGC" chunk before "data", so
// chunk merging MUST parse the RIFF chunk list instead of assuming a 44-byte
// header. Strategy: synthesize every chunk as WAV, extract raw PCM, and
// re-encode ONE canonical 44-byte WAV header with the shared fmt parameters.

// LRU cache for finished audio. Voice calls repeat fixed phrases constantly
// (greetings, "I did not catch that", confirmations) and the provider can take
// 2-16s per synthesis — replaying cached audio turns those into ~0ms.
const TTS_CACHE_MAX_ENTRIES = 80;
const ttsCache = new Map<string, { audio: Buffer; createdAt: number }>();
// In-flight dedupe: concurrent requests for the same (voice, speed, text) —
// e.g. the session-start warmer racing the first greet frame — share ONE
// synthesis promise instead of doubling provider load (and 429 risk).
const ttsInFlight = new Map<string, Promise<Buffer>>();

function ttsCacheKey(text: string, voice: string, speed: number): string {
  return `${voice}|${speed}|${text}`;
}

function ttsCacheGet(key: string): Buffer | null {
  const hit = ttsCache.get(key);
  if (!hit) return null;
  // Refresh insertion order for LRU behavior.
  ttsCache.delete(key);
  ttsCache.set(key, hit);
  return hit.audio;
}

/**
 * Synthesize-or-join: returns cached audio instantly, joins an identical
 * in-flight synthesis, or starts one and registers it for others to join.
 */
function synthesizeDeduped(
  key: string,
  run: () => Promise<Buffer>,
): Promise<Buffer> {
  const cached = ttsCacheGet(key);
  if (cached) return Promise.resolve(cached);
  const existing = ttsInFlight.get(key);
  if (existing) return existing;
  const p = run()
    .then((audio) => {
      ttsCachePut(key, audio);
      return audio;
    })
    .finally(() => {
      ttsInFlight.delete(key);
    });
  ttsInFlight.set(key, p);
  return p;
}

function ttsCachePut(key: string, audio: Buffer): void {
  if (ttsCache.size >= TTS_CACHE_MAX_ENTRIES) {
    const oldest = ttsCache.keys().next().value;
    if (oldest !== undefined) ttsCache.delete(oldest);
  }
  ttsCache.set(key, { audio, createdAt: Date.now() });
}

function readAscii(buf: Buffer, start: number, len: number): string {
  return buf.subarray(start, start + len).toString("latin1");
}

function parseWav(buf: Buffer): WavInfo {
  if (buf.length < 12 || readAscii(buf, 0, 4) !== "RIFF" || readAscii(buf, 8, 4) !== "WAVE") {
    throw new ApiError(502, "provider_error", "TTS provider returned malformed WAV (bad RIFF header)");
  }
  let offset = 12;
  let fmt: Omit<WavInfo, "pcm"> | null = null;
  const pcmParts: Buffer[] = [];
  while (offset + 8 <= buf.length) {
    const chunkId = readAscii(buf, offset, 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (dataStart + chunkSize > buf.length) {
      throw new ApiError(502, "provider_error", "TTS provider returned malformed WAV (truncated chunk)");
    }
    if (chunkId === "fmt " && chunkSize >= 16) {
      fmt = {
        audioFormat: buf.readUInt16LE(dataStart),
        channels: buf.readUInt16LE(dataStart + 2),
        sampleRate: buf.readUInt32LE(dataStart + 4),
        bitsPerSample: buf.readUInt16LE(dataStart + 14),
      };
    } else if (chunkId === "data") {
      pcmParts.push(buf.subarray(dataStart, dataStart + chunkSize));
    }
    offset = dataStart + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  if (fmt === null || pcmParts.length === 0) {
    throw new ApiError(502, "provider_error", "TTS provider returned malformed WAV (missing fmt/data chunk)");
  }
  if (fmt.audioFormat !== 1) {
    throw new ApiError(502, "provider_error", `Unsupported WAV format tag ${fmt.audioFormat} (expected PCM=1)`);
  }
  return { ...fmt, pcm: Buffer.concat(pcmParts) };
}

function buildWavHeader(pcmLength: number, wav: Omit<WavInfo, "pcm">): Buffer {
  const blockAlign = (wav.channels * wav.bitsPerSample) / 8;
  const byteRate = wav.sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + pcmLength, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(wav.channels, 22);
  header.writeUInt32LE(wav.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(wav.bitsPerSample, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(pcmLength, 40);
  return header;
}

const SENTENCE_END_RE = /[.!?。！？]/;

/** Split text into <= TTS_CHUNK_TARGET-char chunks on sentence → word → hard bounds. */
function splitTtsText(text: string): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > TTS_CHUNK_TARGET) {
    const window = rest.slice(0, TTS_CHUNK_TARGET);
    let cut = -1;
    for (let i = window.length - 1; i >= TTS_MIN_CHUNK_CUT; i--) {
      if (SENTENCE_END_RE.test(window[i] ?? "")) {
        cut = i + 1; // keep the punctuation with the sentence
        break;
      }
    }
    if (cut < TTS_MIN_CHUNK_CUT) {
      const spaceIdx = window.lastIndexOf(" ");
      cut = spaceIdx >= TTS_MIN_CHUNK_CUT ? spaceIdx + 1 : TTS_CHUNK_TARGET;
    }
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks.filter((c) => c.length > 0);
}

/** Bounded-concurrency map that preserves input order. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function synthesizeChunk(
  zai: ZAIClient,
  chunk: string,
  voice: string,
  speed: number,
): Promise<WavInfo> {
  if (chunk.length > TTS_PROVIDER_CHAR_LIMIT) {
    throw new ApiError(
      500,
      "internal_error",
      `TTS chunk exceeds provider limit (${chunk.length} > ${TTS_PROVIDER_CHAR_LIMIT} chars)`,
    );
  }
  // The SDK returns the raw fetch Response for TTS.
  const response = (await withTimeout(
    withProviderRetries(() =>
      zai.audio.tts.create({
        input: chunk,
        voice,
        speed,
        response_format: "wav",
        stream: false,
      }),
    ),
    PROVIDER_TIMEOUT_MS,
    "tts.chunk",
  )) as Response;
  const arrayBuffer = await withTimeout(
    response.arrayBuffer(),
    PROVIDER_TIMEOUT_MS,
    "tts.chunk.read",
  );
  return parseWav(Buffer.from(new Uint8Array(arrayBuffer)));
}

async function handleTts(req: Request, startedAt: number): Promise<Response> {
  const body = await readJsonBody(req);

  const text = body.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new ApiError(400, "invalid_request", "`text` must be a non-empty string");
  }
  if (text.length > MAX_TTS_TEXT_CHARS) {
    throw new ApiError(
      400,
      "text_too_long",
      `\`text\` exceeds ${MAX_TTS_TEXT_CHARS} chars (got ${text.length})`,
    );
  }
  const voice = body.voice === undefined ? "tongtong" : body.voice;
  if (typeof voice !== "string" || voice.length === 0) {
    throw new ApiError(400, "invalid_request", "`voice` must be a non-empty string");
  }
  const speed = validateNumber(body, "speed", {
    min: 0.5,
    max: 2.0,
    required: false,
    fallback: 1.0,
  });
  const format = body.format === undefined ? "wav" : body.format;
  if (format !== "wav" && format !== "mp3") {
    throw new ApiError(400, "invalid_request", `\`format\` must be "wav" or "mp3", got ${JSON.stringify(format)}`);
  }
  if (format === "mp3") {
    // Honest refusal: probed ZAI TTS rejects response_format "mp3" (error 1214).
    throw new ApiError(
      400,
      "unsupported_format",
      'ZAI TTS provider only supports "wav"; "mp3" was requested but cannot be produced honestly',
    );
  }

  const zai = await getZai();
  const cacheKey = ttsCacheKey(text, voice, speed);
  const cached = ttsCacheGet(cacheKey);
  if (cached) {
    logRequest("info", "/tts", startedAt, 200, {
      chars: text.length,
      audio_bytes: cached.length,
      chunks: 0,
      cache: "hit",
    });
    return json(200, { audio_base64: cached.toString("base64"), format: "wav", duration_hint_ms: null });
  }

  // Dedupe across concurrent identical requests (warm-vs-greet race): whoever
  // arrives first synthesizes; joiners await the same promise.
  const audio = await synthesizeDeduped(cacheKey, async () => {
    const chunks = splitTtsText(text);
    if (chunks.length === 0) {
      throw new ApiError(400, "invalid_request", "`text` contains no synthesizable content");
    }

    let merged: Buffer;
    if (chunks.length === 1) {
      const wav = await synthesizeChunk(zai, chunks[0] as string, voice, speed);
      merged = Buffer.concat([buildWavHeader(wav.pcm.length, wav), wav.pcm]);
    } else {
      // Multi-chunk: parse each WAV, verify identical fmt params, merge PCM under
      // one canonical header taken from the first chunk's parameters.
      const parts = await mapPool(chunks, TTS_CHUNK_CONCURRENCY, (chunk) =>
        synthesizeChunk(zai, chunk, voice, speed),
      );
      const first = parts[0] as WavInfo;
      for (const part of parts.slice(1)) {
        if (
          part.audioFormat !== first.audioFormat ||
          part.channels !== first.channels ||
          part.sampleRate !== first.sampleRate ||
          part.bitsPerSample !== first.bitsPerSample
        ) {
          throw new ApiError(
            502,
            "provider_error",
            "TTS chunks returned inconsistent audio formats; refusing to concatenate",
          );
        }
      }
      const pcm = Buffer.concat(parts.map((p) => p.pcm));
      merged = Buffer.concat([
        buildWavHeader(pcm.length, {
          audioFormat: first.audioFormat,
          channels: first.channels,
          sampleRate: first.sampleRate,
          bitsPerSample: first.bitsPerSample,
        }),
        pcm,
      ]);
    }
    return merged;
  });

  logRequest("info", "/tts", startedAt, 200, {
    chars: text.length,
    audio_bytes: audio.length,
    cache: "synthesized",
  });
  // duration_hint_ms stays null — we do not guess; caller can decode the WAV.
  return json(200, {
    audio_base64: audio.toString("base64"),
    format: "wav",
    duration_hint_ms: null,
  });
}

// ---------------------------------------------------------------------------
// POST /tts/check — cache probe (no synthesis)
// ---------------------------------------------------------------------------

/**
 * Fast liveness probe for the TTS LRU cache. The backend uses it to decide
 * whether an instant pre-warmed acknowledgment can be spoken with ~0ms
 * latency: probe (~1ms) first, and only request audio when it is a hit.
 * Never synthesizes — a miss returns {cached:false} immediately.
 */
async function handleTtsCheck(req: Request, startedAt: number): Promise<Response> {
  const body = await readJsonBody(req);
  const text = body.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new ApiError(400, "invalid_request", "`text` must be a non-empty string");
  }
  const voice = body.voice === undefined ? "tongtong" : body.voice;
  if (typeof voice !== "string" || voice.length === 0) {
    throw new ApiError(400, "invalid_request", "`voice` must be a non-empty string");
  }
  const speed = validateNumber(body, "speed", { min: 0.5, max: 2.0, required: false, fallback: 1.0 });
  const cached = ttsCacheGet(ttsCacheKey(text, voice, speed)) !== null;
  logRequest("info", "/tts/check", startedAt, 200, { chars: text.length, cache: cached ? "hit" : "miss" });
  return json(200, { cached });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(req: Request): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(req.url);
  const routeKey = `${req.method} ${url.pathname}`;

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    if (url.pathname === "/health") {
      if (req.method !== "GET") {
        return apiError(405, "method_not_allowed", "Use GET /health");
      }
      logRequest("info", "/health", startedAt, 200, {});
      return json(200, {
        status: "ok",
        service: "ai-bridge",
        providers: { llm: "zai", stt: "zai", tts: "zai" },
      });
    }

    if (url.pathname === "/llm/chat") {
      if (req.method !== "POST") {
        return apiError(405, "method_not_allowed", "Use POST /llm/chat");
      }
      return await handleLlmChat(req, startedAt);
    }

    if (url.pathname === "/stt") {
      if (req.method !== "POST") {
        return apiError(405, "method_not_allowed", "Use POST /stt");
      }
      return await handleStt(req, startedAt);
    }

    if (url.pathname === "/tts") {
      if (req.method !== "POST") {
        return apiError(405, "method_not_allowed", "Use POST /tts");
      }
      return await handleTts(req, startedAt);
    }

    if (url.pathname === "/tts/check") {
      if (req.method !== "POST") {
        return apiError(405, "method_not_allowed", "Use POST /tts/check");
      }
      return await handleTtsCheck(req, startedAt);
    }

    if (url.pathname === "/embeddings") {
      if (req.method !== "POST") {
        return apiError(405, "method_not_allowed", "Use POST /embeddings");
      }
      logRequest("info", "/embeddings", startedAt, 501, {});
      return apiError(
        501,
        "not_implemented",
        "Embedding provider not configured; retrieval uses FTS5",
      );
    }

    logRequest("warn", routeKey, startedAt, 404, {});
    return apiError(404, "not_found", `No route for ${routeKey}`);
  } catch (err) {
    const apiErr = toApiError(err, routeKey);
    const level: "warn" | "error" = apiErr.status >= 500 ? "error" : "warn";
    logRequest(level, routeKey, startedAt, apiErr.status, { code: apiErr.code });
    return apiError(apiErr.status, apiErr.code, apiErr.message);
  }
}

// ---------------------------------------------------------------------------
// Server + lifecycle
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255, // long provider calls must not idle-kill the connection
  fetch: (req) => route(req),
});

logEvent("info", "startup", { meta_note: `listening on :${PORT}` });

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    process.exit(0);
  }
  shuttingDown = true;
  logEvent("info", "shutdown", { signal });
  // Stop accepting new connections; in-flight requests are allowed to finish.
  server.stop(false);
  // Safety net in case a hung provider call keeps sockets open.
  setTimeout(() => process.exit(0), 8_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
