"use client";

/**
 * LIVE AI VOICE LABORATORY (spec §6E)
 *
 * A genuine two-way voice conversation with the configured AI receptionist:
 * - Browser microphone capture with adaptive voice-activity detection: the
 *   ambient noise floor is calibrated on every call and the speech threshold
 *   adjusts to the room and the mic level.
 * - Continuous PCM capture with a 700ms PRE-ROLL buffer: the ~700ms before
 *   speech onset is prepended to every utterance, so the recognizer receives
 *   the COMPLETE utterance (MediaRecorder-based capture clipped the first
 *   word, which misheard whole sentences). Utterances are resampled to
 *   16 kHz mono, peak-normalized and silence-trimmed before upload — no
 *   leading silence means no recognizer hallucinations ("#").
 * - Echo-proof turn taking: the microphone is never armed while the assistant's
 *   audio is still playing (recording resumes the moment playback ends or the
 *   caller barges in), so the recognizer never transcribes the assistant's
 *   own voice.
 * - Turn-based WebSocket pipeline: mic → STT → LLM (+tools, +web search,
 *   +RAG, +safety) → TTS.
 * - Keyboard text fallback for environments without microphone access.
 *
 * Every message below is produced by the real pipeline. If credentials or the
 * ai-bridge sidecar are missing, errors are shown honestly.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { PhoneCall, PhoneOff, Mic, MicOff, Keyboard, Loader2, AlertTriangle, Activity, Languages } from "lucide-react";
import { api, voiceWebSocketUrl, ApiError } from "@vitalora/api-client";
import type { ConversationMessage } from "@vitalora/shared-types";
import { SUPPORTED_LANGUAGES } from "@vitalora/shared-types";
import { GlassCard, PageHeader, StatusBadge, EmptyState } from "@/components/glass";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { mapApiError } from "@/lib/utils-api";

type Stage = "idle" | "connecting" | "listening" | "transcribing" | "thinking" | "thinking_ack" | "speaking" | "ended" | "error";

interface Turn extends Pick<ConversationMessage, "role" | "content" | "tool_name"> {
  id: string;
}

// Endpointing: real callers pause 300-600ms mid-sentence between phrases.
// A 330ms window chopped sentences in half, so the recognizer received
// fragments, the AI answered the wrong fragment, and callers had to repeat
// themselves — the single worst latency killer in the whole pipeline.
// 900ms is the classic phone-system endpointing window: turn taking still
// feels snappy, but a mid-sentence breath never fires the send.
const SILENCE_MS = 900;
const MAX_UTTERANCE_MS = 15000;
const MIN_UTTERANCE_MS = 320; // accept short utterances ("yes") quickly, still discard blips
const CALIBRATION_FRAMES = 12; // ~0.2 s ambient-noise sampling — barely delays first capture
const LOW_MIC_HINT_MS = 4500;
// Pre-roll: raw mic PCM is tapped CONTINUOUSLY and the ~700ms before speech
// onset is prepended to every utterance. MediaRecorder could only start AFTER
// the VAD fired (+recorder start latency), clipping the attack of the first
// word — the main source of misheard transcripts ("What kind of AI are you?"
// → "Can't AI you are?").
const PRE_ROLL_MS = 700;

interface WavPacket {
  b64: string;
  durationMs: number;
}

// ── Browser-native speech recognition (PRIMARY speech-to-text) ──────────────
// Chrome/Edge/Safari ship a Web Speech recognizer with Google-grade accuracy,
// streaming interim results and its own endpointing. Using it as the primary
// recognizer mirrors how ChatGPT's voice mode feels: words appear WHILE the
// caller speaks, and the turn is sent the moment the phrase completes —
// no audio upload, no server STT round-trip, no provider rate limits.
// The server STT path stays as an automatic fallback for browsers without
// the API or when the recognizer errors out mid-call.
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const BROWSER_STT_LANG: Record<string, string> = {
  en: "en-US",
  ur: "ur-PK",
  hi: "hi-IN",
  ar: "ar-SA",
};

interface AudioChunk {
  bytes: ArrayBuffer;
  mime: string;
}

/** Minimal valid silent WAV (1 sample) used to unlock <audio> playback in-gesture. */
function makeSilentWav(): ArrayBuffer {
  const buf = new ArrayBuffer(46);
  const v = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  v.setUint32(4, 38, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 16000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, 2, true);
  v.setInt16(44, 0, true);
  return buf;
}

/**
 * Unlock audio playback synchronously inside the user gesture.
 *
 * Browsers with strict autoplay policies (Safari, Chrome in embedded
 * previews) only allow programmatic audio that is triggered directly by a
 * user gesture — and a gesture EXPIRES after the first await (network calls,
 * getUserMedia prompts). So the very first thing the Start-Call click does
 * (before any await) is: create/resume an AudioContext, push one silent
 * sample through it, and prime an <audio> element. Every later reply is then
 * played through the RUNNING context (buffer sources), which is exempt from
 * per-media autoplay checks.
 */
function ensureAudioUnlocked(audioCtxRef: { current: AudioContext | null }, audioElRef: { current: HTMLAudioElement | null }): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (Ctx) {
      let ctx = audioCtxRef.current;
      if (!ctx || ctx.state === "closed") {
        ctx = new Ctx();
        audioCtxRef.current = ctx;
      }
      void ctx.resume().catch(() => undefined);
      // One silent sample through the context marks it "gesture-unlocked".
      const silent = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = silent;
      src.connect(ctx.destination);
      src.start(0);
    }
  } catch {
    /* element fallback below still applies */
  }
  try {
    // Prime an <audio> element too: once an element has played inside a
    // gesture, later programmatic play() on it is allowed (Safari rule).
    const el = audioElRef.current ?? new Audio();
    audioElRef.current = el;
    el.src = URL.createObjectURL(new Blob([makeSilentWav()], { type: "audio/wav" }));
    el.muted = true;
    const p = el.play();
    if (p) {
      p.then(() => {
        el.muted = false;
        el.pause();
        URL.revokeObjectURL(el.src);
      }).catch(() => {
        el.muted = false;
        URL.revokeObjectURL(el.src);
      });
    }
  } catch {
    /* nothing else to try here */
  }
}

/** Encode Float32 mono samples as a 16-bit PCM WAV ArrayBuffer. */
function encodeWav16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

/**
 * Decode any recorded container (webm/opus, mp4/aac, ogg…), resample to
 * 16 kHz mono and peak-normalize. Returns null when decoding fails, in which
 * case the raw recording is uploaded unchanged.
 */
async function blobToWav16k(blob: Blob, decodeCtx: AudioContext): Promise<WavPacket | null> {
  try {
    const raw = await blob.arrayBuffer();
    const decoded = await decodeCtx.decodeAudioData(raw);
    const rate = 16000;
    const length = Math.max(1, Math.ceil(decoded.duration * rate));
    const offline = new OfflineAudioContext(1, length, rate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    const data = rendered.getChannelData(0);

    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const a = data[i] < 0 ? -data[i] : data[i];
      if (a > peak) peak = a;
    }
    const gain = peak > 0.001 ? Math.min(0.92 / peak, 8) : 1; // normalize, never squash loud voices
    const normalized = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const v = data[i] * gain;
      normalized[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }

    const wav = encodeWav16(normalized, rate);
    let binary = "";
    const bytes = new Uint8Array(wav);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return { b64: btoa(binary), durationMs: Math.round(decoded.duration * 1000) };
  } catch {
    return null;
  }
}

async function blobToRawBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Linear-interpolation resample to 16 kHz — the recognizer's native rate. */
function resampleTo16k(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === 16000 || input.length === 0) return input;
  const ratio = fromRate / 16000;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = input[i0] ?? 0;
    const b = i0 + 1 < input.length ? input[i0 + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Peak-normalize to 0.92 (max gain 8x), clamped — same levelling as before. */
function normalizeAudio(samples: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i] < 0 ? -samples[i] : samples[i];
    if (a > peak) peak = a;
  }
  const gain = peak > 0.001 ? Math.min(0.92 / peak, 8) : 1;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] * gain;
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return out;
}

/**
 * Trim leading/trailing near-silence (post-normalization), keeping padMs of
 * breathing room. Leading silence is the #1 trigger for recognizer
 * hallucinations (measured live: silence in → '#' transcript out), and
 * trailing silence wastes upload time. Pure silence yields a zero-length
 * array so the sender can discard it without an upload at all.
 */
function trimAudio(samples: Float32Array, rate: number, threshold = 0.02, padMs = 150): Float32Array {
  let first = -1;
  let last = -1;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] > threshold || samples[i] < -threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return new Float32Array(0);
  const pad = Math.floor((rate * padMs) / 1000);
  return samples.slice(Math.max(0, first - pad), Math.min(samples.length, last + pad));
}

export function VoiceLabClient() {
  const params = useSearchParams();
  const presetReceptionistId = params.get("receptionist") ?? "";

  const [receptionistId, setReceptionistId] = useState("");
  const [language, setLanguage] = useState("en");
  const [stage, setStage] = useState<Stage>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [muted, setMuted] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [micHint, setMicHint] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [textInput, setTextInput] = useState("");
  const [level, setLevel] = useState(0);
  const [bars, setBars] = useState<number[]>(() => Array.from({ length: 36 }, () => 3));

  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number>(0);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const stageRef = useRef<Stage>("idle");
  const mutedRef = useRef(false);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // App-level WS keepalive: intermediary proxies may drop idle connections;
  // a tiny ping frame every 20s keeps the path alive end to end.
  const keepaliveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingRef = useRef(false);
  const recStartRef = useRef(0);
  const barFrame = useRef(0);
  // Adaptive VAD state
  const thresholdRef = useRef(0.045);
  const calibSamplesRef = useRef<number[]>([]);
  const calibDoneRef = useRef(false);
  // Assistant-playback gating (echo-proof turn taking)
  const speakingRef = useRef(false);
  // Sentence-streamed replies arrive as several audio messages; they are
  // decoded and scheduled on the unlocked AudioContext as a gapless queue.
  const audioQueueRef = useRef<AudioChunk[]>([]);
  const audioPlayingRef = useRef(false);
  const pumpingRef = useRef(false);
  const nextStartRef = useRef(0); // context timeline for back-to-back scheduling
  const scheduledSrcsRef = useRef<AudioBufferSourceNode[]>([]);
  const playbackGenRef = useRef(0); // bumped on every stop so stale callbacks no-op
  const finishPlaybackRef = useRef<() => void>(() => undefined);
  // Low-mic hint state
  const quietMsRef = useRef(0);
  const lastTickRef = useRef(0);
  // Set while assistant audio is queued but held back because the caller's
  // microphone is mid-utterance: playback starts the moment the utterance is
  // flushed, so the assistant never talks over (or discards) live speech.
  const holdForMicRef = useRef(false);
  // ── PCM pre-roll capture pipeline ────────────────────────────────────────
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micNodeRef = useRef<ScriptProcessorNode | null>(null);
  const micSinkRef = useRef<GainNode | null>(null);
  const pcmActiveRef = useRef(false); // PCM pipeline owns onset/endpointing
  const preRollRef = useRef<Float32Array[]>([]);
  const preRollFramesRef = useRef(0);
  const utteranceRef = useRef<Float32Array[]>([]);
  const utteranceFramesRef = useRef(0);
  const utteranceSilenceMsRef = useRef(0);
  // ── Browser-native recognizer (primary STT) state ────────────────────────
  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  const browserSttRef = useRef(false); // true → the browser recognizer owns turns
  const recogRunningRef = useRef(false);
  const recogRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recogFailuresRef = useRef(0); // exponential backoff across restarts
  const [browserSttActive, setBrowserSttActive] = useState(false);
  // Live partial transcript while the caller speaks (ChatGPT-style ghost text)
  const [interimText, setInterimText] = useState("");

  stageRef.current = stage;
  mutedRef.current = muted;

  const { data: receptionistData, isLoading: recsLoading, error: recsError, refetch } = useQuery({
    queryKey: ["voice-lab-receptionists"],
    queryFn: () => api.listReceptionists("active"),
  });
  const receptionists = receptionistData?.items ?? [];

  useEffect(() => {
    if (receptionistId && receptionists.some((r) => r.id === receptionistId)) return;
    const preset = receptionists.find((r) => r.id === presetReceptionistId) ?? receptionists[0];
    if (preset) {
      setReceptionistId(preset.id);
      setLanguage(preset.primary_language);
    }
  }, [receptionists]);

  const selected = receptionists.find((r) => r.id === receptionistId);

  const addTurn = useCallback((role: Turn["role"], content: string | null, toolName?: string) => {
    setTurns((prev) => [
      ...prev,
      { id: `t${prev.length}-${Date.now()}`, role, content, tool_name: toolName ?? null },
    ]);
  }, []);

  const stopAudio = useCallback(() => {
    playbackGenRef.current += 1;
    pumpingRef.current = false;
    holdForMicRef.current = false;
    for (const s of scheduledSrcsRef.current) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    scheduledSrcsRef.current = [];
    audioQueueRef.current = [];
    nextStartRef.current = 0;
    const el = audioElRef.current;
    if (el) {
      el.pause();
      try {
        el.currentTime = 0;
      } catch {
        /* not seekable yet */
      }
    }
    audioPlayingRef.current = false;
  }, []);

  /**
   * Gapless reply player.
   *
   * Primary path: decode each queued chunk on the gesture-unlocked
   * AudioContext and schedule buffer sources back-to-back on the context
   * timeline. Playback through a running context is NOT subject to per-media
   * autoplay checks, and scheduled buffers transition without gaps.
   * Fallback path: the primed <audio> element (also unlocked in-gesture).
   */
  const pumpQueue = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    const gen = playbackGenRef.current;
    try {
      while (audioQueueRef.current.length > 0) {
        const ctx = audioCtxRef.current;
        const item = audioQueueRef.current[0];
        if (!item) break;
        if (ctx && ctx.state === "running") {
          let buf: AudioBuffer;
          try {
            buf = await ctx.decodeAudioData(item.bytes);
          } catch {
            audioQueueRef.current.shift(); // undecodable chunk — drop and continue
            continue;
          }
          if (gen !== playbackGenRef.current) return;
          audioQueueRef.current.shift();
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          const startAt = Math.max(ctx.currentTime + 0.02, nextStartRef.current);
          src.start(startAt);
          nextStartRef.current = startAt + buf.duration;
          scheduledSrcsRef.current.push(src);
          audioPlayingRef.current = true;
          src.onended = () => {
            scheduledSrcsRef.current = scheduledSrcsRef.current.filter((s) => s !== src);
            if (gen !== playbackGenRef.current) return;
            if (scheduledSrcsRef.current.length === 0 && audioQueueRef.current.length === 0 && !pumpingRef.current) {
              audioPlayingRef.current = false;
              finishPlaybackRef.current();
            }
          };
        } else {
          // Element fallback (no AudioContext or context suspended).
          audioQueueRef.current.shift();
          const el = audioElRef.current ?? new Audio();
          audioElRef.current = el;
          const url = URL.createObjectURL(new Blob([item.bytes], { type: item.mime }));
          el.src = url;
          audioPlayingRef.current = true;
          try {
            await el.play();
          } catch {
            URL.revokeObjectURL(url);
            audioPlayingRef.current = false;
            pumpingRef.current = false;
            if (gen === playbackGenRef.current) {
              // Do NOT drop the queue: a tap anywhere re-resumes audio and
              // re-pumps what is still pending (see global pointerdown effect).
              setStage("listening");
              setErrorMsg("Tap anywhere on the page to enable sound — your receptionist is ready.");
            }
            return;
          }
          if (gen !== playbackGenRef.current) {
            URL.revokeObjectURL(url);
            return;
          }
          await new Promise<void>((resolve) => {
            el.onended = () => resolve();
          });
          URL.revokeObjectURL(url);
          if (gen !== playbackGenRef.current) return;
        }
      }
    } finally {
      pumpingRef.current = false;
      if (gen === playbackGenRef.current && scheduledSrcsRef.current.length === 0 && audioQueueRef.current.length === 0 && audioPlayingRef.current) {
        audioPlayingRef.current = false;
        finishPlaybackRef.current();
      }
    }
  }, []);

  // Safety net: if the context somehow gets suspended mid-call, ANY tap on
  // the page resumes it and re-pumps whatever is still queued.
  useEffect(() => {
    const resumeAudio = () => {
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state === "suspended") {
        void ctx
          .resume()
          .then(() => {
            if (audioQueueRef.current.length > 0 && !audioPlayingRef.current && !pumpingRef.current) {
              void pumpQueue();
            }
          })
          .catch(() => undefined);
      }
    };
    window.addEventListener("pointerdown", resumeAudio);
    return () => window.removeEventListener("pointerdown", resumeAudio);
  }, [pumpQueue]);

  // ── Microphone capture + VAD ────────────────────────────────────────────
  // Starts playback of any assistant audio that was held while the caller was
  // still speaking (see the "audio" WS handler). Called from sendUtterance so
  // the held reply begins the instant the utterance is flushed — even when the
  // recording turned out to be a discarded blip.
  const releaseHeldAudio = useCallback(() => {
    if (!holdForMicRef.current) return;
    holdForMicRef.current = false;
    if (audioQueueRef.current.length > 0 && !audioPlayingRef.current && !pumpingRef.current) {
      // Take the speaking state BEFORE pumping: the mic must disarm (barge-in
      // ownership) the instant held assistant audio starts, or the recorder
      // would capture the assistant's own voice.
      speakingRef.current = true;
      setStage("speaking");
      void pumpQueue();
    }
  }, [pumpQueue]);

  /** Send a captured utterance: resample → normalize → trim silence → WAV. */
  const sendPcmUtterance = useCallback(
    (chunks: Float32Array[], frameCount: number, rate: number) => {
      // Browser-native recognition owns turns when available — uploading the
      // same utterance as audio would DOUBLE every turn (text + server STT).
      // The PCM pipeline still runs for levels/barge-in; its utterances are
      // simply not sent.
      if (browserSttRef.current) {
        releaseHeldAudio();
        return;
      }
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || frameCount <= 0) {
        releaseHeldAudio();
        return;
      }
      const merged = new Float32Array(frameCount);
      let off = 0;
      for (const c of chunks) {
        if (off + c.length <= frameCount) {
          merged.set(c, off);
          off += c.length;
        }
      }
      const normalized = normalizeAudio(resampleTo16k(merged, rate));
      const trimmed = trimAudio(normalized, 16000);
      // Speech-duration check on the TRIMMED audio: blips and pure noise are
      // discarded locally and never reach the recognizer.
      if ((trimmed.length / 16000) * 1000 < MIN_UTTERANCE_MS) {
        releaseHeldAudio();
        return;
      }
      const wav = encodeWav16(trimmed, 16000);
      let binary = "";
      const bytes = new Uint8Array(wav);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      ws.send(JSON.stringify({ type: "audio", data: btoa(binary) }));
      releaseHeldAudio();
    },
    [releaseHeldAudio],
  );

  const sendUtterance = useCallback(
    async (blob: Blob, mimeType: string) => {
      if (browserSttRef.current) {
        releaseHeldAudio(); // browser recognizer owns turns — see sendPcmUtterance
        return;
      }
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        releaseHeldAudio();
        return;
      }
      // Preferred path: decoded, resampled, peak-normalized WAV.
      const wav = audioCtxRef.current ? await blobToWav16k(blob, audioCtxRef.current) : null;
      if (wav) {
        if (wav.durationMs < MIN_UTTERANCE_MS) {
          releaseHeldAudio(); // noise blip — discard, but never strand held audio
          return;
        }
        ws.send(JSON.stringify({ type: "audio", data: wav.b64 }));
        releaseHeldAudio();
        return;
      }
      // Fallback: upload the raw recording (recognizer handles webm/mp4/ogg too).
      const buf = await blob.arrayBuffer();
      if (buf.byteLength < 1200) {
        releaseHeldAudio();
        return;
      }
      ws.send(JSON.stringify({ type: "audio", data: await blobToRawBase64(new Blob([buf], { type: mimeType })) }));
      releaseHeldAudio();
    },
    [releaseHeldAudio],
  );

  const stopRecording = useCallback(() => {
    // PCM pipeline: drop any in-flight utterance (mute / end call / barge-in
    // discard). The chunks are garbage-collected; nothing is ever sent.
    utteranceRef.current = [];
    utteranceFramesRef.current = 0;
    utteranceSilenceMsRef.current = 0;
    recordingRef.current = false;
    if (recorderRef.current && recorderRef.current.state === "recording") {
      recorderRef.current.stop(); // fallback MediaRecorder path
    }
  }, []);

  const startRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recordingRef.current || mutedRef.current) return;
    chunksRef.current = [];
    recordingRef.current = true;
    recStartRef.current = Date.now();
    recorder.start();
    setTimeout(() => {
      if (recordingRef.current) stopRecording();
    }, MAX_UTTERANCE_MS);
  }, [stopRecording]);

  const monitorLoop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    let speechFrames = 0;
    lastTickRef.current = performance.now();

    const tick = () => {
      const now = performance.now();
      const dt = Math.min(100, now - lastTickRef.current);
      lastTickRef.current = now;
      const st = stageRef.current;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      if (++barFrame.current % 3 === 0) {
        setLevel(rms);
      }

      // ── Adaptive threshold: calibrate on the ambient noise floor once per
      // listening phase, then clamp to a sane band. min() keeps the floor
      // robust even if the caller starts speaking during calibration.
      if (st === "listening" && !calibDoneRef.current) {
        calibSamplesRef.current.push(rms);
        if (calibSamplesRef.current.length >= CALIBRATION_FRAMES) {
          const floor = Math.min(...calibSamplesRef.current);
          // More sensitive than the old cap (0.06): a noisy room must never
          // make the mic deaf — the user's #1 complaint was "not listening".
          thresholdRef.current = Math.max(0.014, Math.min(0.048, floor * 2.6 + 0.006));
          calibDoneRef.current = true;
        }
      }
      const threshold = thresholdRef.current;

      // The mic arms for the WHOLE active call — not only the "listening"
      // stage. Previously the recorder disarmed during transcribing/thinking,
      // so any speech the caller produced while the AI was working (1.5-3s per
      // turn) was silently dropped — the #1 "it is not listening to me"
      // complaint. The server processes frames sequentially, so an early next
      // utterance simply queues as the following turn. During assistant
      // playback the barge-in branch owns the mic instead.
      const micArmed = st === "listening" || st === "transcribing" || st === "thinking" || st === "thinking_ack";
      if (speakingRef.current) {
        // Barge-in: sustained caller speech interrupts assistant playback.
        if (rms > threshold) {
          speechFrames += 1;
          if (speechFrames > 8) {
            stopAudio();
            speakingRef.current = false;
            if (stageRef.current === "speaking") setStage("listening");
          }
        } else {
          speechFrames = 0;
        }
      } else if (micArmed && !mutedRef.current) {
        if (pcmActiveRef.current) {
          // The PCM pipeline (onaudioprocess) owns speech onset and
          // endpointing — it sees raw samples and keeps a 700ms pre-roll.
          // The RAF loop only keeps the low-mic hint alive here.
          if (rms > threshold) {
            quietMsRef.current = 0;
          } else {
            quietMsRef.current += dt;
            if (quietMsRef.current > LOW_MIC_HINT_MS && !recordingRef.current) {
              setMicHint(
                "We can barely hear you — speak a little louder and closer to the mic, or type your question in the box below.",
              );
              quietMsRef.current = 0;
            }
          }
        } else if (rms > threshold) {
          // Legacy MediaRecorder fallback path (no ScriptProcessorNode).
          quietMsRef.current = 0;
          if (!recordingRef.current) startRecording();
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
        } else {
          if (recordingRef.current && !silenceTimerRef.current) {
            silenceTimerRef.current = setTimeout(() => {
              silenceTimerRef.current = null;
              stopRecording();
            }, SILENCE_MS);
          }
          quietMsRef.current += dt;
          if (quietMsRef.current > LOW_MIC_HINT_MS && !recordingRef.current) {
            setMicHint(
              "We can barely hear you — speak a little louder and closer to the mic, or type your question in the box below.",
            );
            quietMsRef.current = 0;
          }
        }
      } else {
        quietMsRef.current = 0;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [startRecording, stopAudio, stopRecording]);

  const resetVadCalibration = useCallback(() => {
    calibSamplesRef.current = [];
    calibDoneRef.current = false;
    quietMsRef.current = 0;
    thresholdRef.current = 0.045;
  }, []);

  const setupMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      // Reuse the context created (and gesture-unlocked) by Start Call; only
      // create a fresh one when the component entered keyboard-only mode.
      let ctx = audioCtxRef.current;
      if (!ctx || ctx.state === "closed") {
        ctx = new Ctx();
        audioCtxRef.current = ctx;
      }
      if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      analyserRef.current = analyser;

      // ── Preferred capture: continuous PCM tap with pre-roll ──────────────
      // The raw (echo-cancelled, noise-suppressed) stream is tapped on every
      // render quantum. Speech onset prepends the last PRE_ROLL_MS of audio
      // to the utterance, endpointing applies the SILENCE_MS window, and the
      // finished utterance is resampled to 16 kHz, normalized and
      // silence-trimmed before upload. The recognizer therefore receives the
      // COMPLETE utterance — first word intact, zero leading silence.
      if (typeof ctx.createScriptProcessor === "function") {
        const sampleRate = ctx.sampleRate;
        const node = ctx.createScriptProcessor(4096, 1, 1);
        const sink = ctx.createGain();
        sink.gain.value = 0; // keep the node pumping without audible feedback
        node.onaudioprocess = (e: AudioProcessingEvent) => {
          const input = e.inputBuffer.getChannelData(0);
          if (!input || input.length === 0) return;
          const chunk = input.slice(); // copy — the buffer is reused
          const chunkMs = (chunk.length / sampleRate) * 1000;
          let sum = 0;
          for (let i = 0; i < chunk.length; i++) {
            const v = chunk[i];
            sum += v * v;
          }
          const rms = Math.sqrt(sum / chunk.length);

          if (recordingRef.current) {
            // ── Live utterance: append speech, watch the silence window ──
            if (rms > thresholdRef.current && !mutedRef.current) {
              utteranceRef.current.push(chunk);
              utteranceFramesRef.current += chunk.length;
              utteranceSilenceMsRef.current = 0;
            } else {
              utteranceSilenceMsRef.current += chunkMs;
              if (utteranceSilenceMsRef.current <= 240) {
                // Keep a little natural trailing room.
                utteranceRef.current.push(chunk);
                utteranceFramesRef.current += chunk.length;
              }
            }
            const elapsedMs = (utteranceFramesRef.current / sampleRate) * 1000;
            const finished = utteranceSilenceMsRef.current >= SILENCE_MS || elapsedMs >= MAX_UTTERANCE_MS;
            if (finished) {
              const chunks = utteranceRef.current;
              const frames = utteranceFramesRef.current;
              utteranceRef.current = [];
              utteranceFramesRef.current = 0;
              utteranceSilenceMsRef.current = 0;
              recordingRef.current = false;
              if (frames > 0) sendPcmUtterance(chunks, frames, sampleRate);
            }
            return;
          }

          // ── Idle: maintain the pre-roll, arm on speech onset ────────────
          const st = stageRef.current;
          const armed =
            st === "listening" || st === "transcribing" || st === "thinking" || st === "thinking_ack";
          if (!armed || mutedRef.current || speakingRef.current || audioPlayingRef.current) {
            if (preRollFramesRef.current > 0) {
              preRollRef.current = [];
              preRollFramesRef.current = 0;
            }
            return;
          }
          preRollRef.current.push(chunk);
          preRollFramesRef.current += chunk.length;
          const maxFrames = Math.ceil((sampleRate * PRE_ROLL_MS) / 1000);
          while (
            preRollRef.current.length > 0 &&
            preRollFramesRef.current - (preRollRef.current[0]?.length ?? 0) >= maxFrames
          ) {
            const dropped = preRollRef.current.shift();
            if (dropped) preRollFramesRef.current -= dropped.length;
          }
          if (rms > thresholdRef.current) {
            // Speech onset: pre-roll + this chunk become the utterance, so
            // even the very first phoneme reaches the recognizer.
            const chunks = [...preRollRef.current, chunk];
            const frames = preRollFramesRef.current + chunk.length;
            preRollRef.current = [];
            preRollFramesRef.current = 0;
            utteranceRef.current = chunks;
            utteranceFramesRef.current = frames;
            utteranceSilenceMsRef.current = 0;
            recordingRef.current = true;
            recStartRef.current = Date.now();
          }
        };
        source.connect(node);
        node.connect(sink);
        sink.connect(ctx.destination);
        micSourceRef.current = source;
        micNodeRef.current = node;
        micSinkRef.current = sink;
        pcmActiveRef.current = true;
      } else {
        // ── Legacy fallback: MediaRecorder (no PCM tap available) ───────────
        pcmActiveRef.current = false;
        const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
        const mime = candidates.find(
          (m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m),
        );
        const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          if (chunksRef.current.length > 0) {
            const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
            chunksRef.current = [];
            if (Date.now() - recStartRef.current >= MIN_UTTERANCE_MS) {
              void sendUtterance(blob, recorder.mimeType || "audio/webm");
            }
          }
        };
        recorderRef.current = recorder;
      }
      resetVadCalibration();
      monitorLoop();
      return true;
    } catch {
      setMicError(
        "Microphone access was denied or is unavailable. You can still test with the keyboard input below — the full AI pipeline (STT skipped, LLM, tools, TTS) runs identically.",
      );
      return false;
    }
  }, [monitorLoop, resetVadCalibration, sendPcmUtterance, sendUtterance]);

  const teardownMic = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    stopRecording();
    // Detach the PCM tap (mic source → processor → zero-gain sink).
    try {
      micNodeRef.current?.disconnect();
      micSinkRef.current?.disconnect();
      micSourceRef.current?.disconnect();
    } catch {
      /* nodes may already be disconnected */
    }
    micNodeRef.current = null;
    micSinkRef.current = null;
    micSourceRef.current = null;
    pcmActiveRef.current = false;
    preRollRef.current = [];
    preRollFramesRef.current = 0;
    utteranceRef.current = [];
    utteranceFramesRef.current = 0;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    void audioCtxRef.current?.close().catch(() => undefined);
    streamRef.current = null;
    audioCtxRef.current = null;
    analyserRef.current = null;
    recorderRef.current = null;
    speakingRef.current = false;
    setLevel(0);
  }, [stopRecording]);

  // ── Browser-native speech recognition (primary STT) ─────────────────────
  const clearRecogRestartTimer = useCallback(() => {
    if (recogRestartTimerRef.current) {
      clearTimeout(recogRestartTimerRef.current);
      recogRestartTimerRef.current = null;
    }
  }, []);

  const stopBrowserRecognition = useCallback(() => {
    clearRecogRestartTimer();
    const rec = recogRef.current;
    recogRef.current = null;
    recogRunningRef.current = false;
    if (rec) {
      rec.onresult = null;
      rec.onend = null;
      rec.onerror = null;
      try {
        rec.abort();
      } catch {
        /* already stopped */
      }
    }
    setInterimText("");
  }, [clearRecogRestartTimer]);

  const startBrowserRecognition = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!browserSttRef.current || mutedRef.current || speakingRef.current || audioPlayingRef.current) return;
    if (recogRunningRef.current || recogRef.current) return;

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = BROWSER_STT_LANG[language] ?? "en-US";

    rec.onresult = (event) => {
      recogFailuresRef.current = 0;
      // Echo guard: never accept results captured while the assistant's own
      // voice is out of the speakers (recognition is aborted during playback;
      // this catches the stragglers that were already in flight).
      if (speakingRef.current || audioPlayingRef.current) return;
      // The recognizer arms slightly before the greeting's first audio chunk
      // arrives — without this guard it would transcribe the greeting's first
      // word and send it back as a phantom caller turn.
      if (stageRef.current === "connecting") return;
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const alt = result[0];
        if (!alt) continue;
        if (result.isFinal) final += alt.transcript;
        else interim += alt.transcript;
      }
      if (interim.trim()) {
        setInterimText(interim.trim());
      }
      const finalText = final.replace(/\s+/g, " ").trim();
      if (finalText.length >= 2 && /[\p{L}\p{N}]/u.test(finalText)) {
        // Must contain real letters/digits — pure punctuation or '#' noise is
        // discarded instead of becoming a ghost turn.
        setInterimText("");
        const sock = wsRef.current;
        if (sock && sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ type: "text", data: finalText.slice(0, 4000) }));
          setStage("thinking");
        }
      }
    };

    rec.onerror = (event) => {
      const kind = event.error;
      if (kind === "not-allowed" || kind === "service-not-allowed" || kind === "audio-capture") {
        // Browser recognition is unavailable (permission/iframe policy) —
        // fall back to the server audio path for the rest of the call.
        browserSttRef.current = false;
        setBrowserSttActive(false);
        stopBrowserRecognition();
      }
      // "no-speech" / "network" / "aborted" → onend decides whether to restart.
    };

    rec.onend = () => {
      recogRunningRef.current = false;
      if (recogRef.current !== rec) return; // replaced/stopped intentionally
      recogRef.current = null;
      // Auto-restart with exponential backoff while the call is live, the mic
      // is armed and the assistant is not talking. Chrome ends the recognizer
      // after every pause — continuous conversation needs this loop.
      if (!browserSttRef.current || mutedRef.current || speakingRef.current || audioPlayingRef.current) return;
      const st = stageRef.current;
      if (st === "ended" || st === "error" || st === "idle") return;
      const failures = Math.min(recogFailuresRef.current, 4);
      const delay = failures === 0 ? 180 : Math.min(250 * 2 ** failures, 3000);
      clearRecogRestartTimer();
      recogRestartTimerRef.current = setTimeout(() => {
        recogRestartTimerRef.current = null;
        startBrowserRecognition();
      }, delay);
    };

    recogRef.current = rec;
    try {
      rec.start();
      recogRunningRef.current = true;
      setBrowserSttActive(true);
    } catch {
      recogRef.current = null;
      recogRunningRef.current = false;
    }
  }, [clearRecogRestartTimer, language, stopBrowserRecognition]);

  /** Pause recognition while assistant audio plays (echo-proof turn taking). */
  const pauseBrowserRecognition = useCallback(() => {
    if (!browserSttRef.current) return;
    const rec = recogRef.current;
    if (rec) {
      try {
        rec.abort();
      } catch {
        /* already stopped */
      }
      recogRef.current = null;
      recogRunningRef.current = false;
    }
    setInterimText("");
  }, []);

  /** Resume recognition after assistant playback finishes / unmute. */
  const resumeBrowserRecognition = useCallback(() => {
    if (!browserSttRef.current) return;
    clearRecogRestartTimer();
    recogRestartTimerRef.current = setTimeout(() => {
      recogRestartTimerRef.current = null;
      startBrowserRecognition();
    }, 220);
  }, [clearRecogRestartTimer, startBrowserRecognition]);

  // ── Call lifecycle ──────────────────────────────────────────────────────
  const endCall = useCallback(
    async (reason: string) => {
      // Kill the browser recognizer first so it cannot restart mid-teardown.
      browserSttRef.current = false;
      setBrowserSttActive(false);
      stopBrowserRecognition();
      wsRef.current?.send(JSON.stringify({ type: "end" }));
      wsRef.current?.close();
      wsRef.current = null;
      teardownMic();
      stopAudio();
      if (keepaliveRef.current) {
        clearInterval(keepaliveRef.current);
        keepaliveRef.current = null;
      }
      const sid = sessionRef.current;
      sessionRef.current = null;
      setSessionId(null);
      setStage("ended");
      if (sid) {
        try {
          await api.endVoiceSession(sid, reason);
        } catch {
          /* session may already be finalized server-side */
        }
      }
    },
    [stopAudio, stopBrowserRecognition, teardownMic],
  );

  const startCall = useCallback(async () => {
    if (!receptionistId) return;
    // MUST run synchronously inside the click gesture, before ANY await:
    // browsers expire the gesture after the first async step, and audio can
    // only be unlocked while the gesture is live. See ensureAudioUnlocked.
    ensureAudioUnlocked(audioCtxRef, audioElRef);
    // Decide the STT path up front: the browser's native recognizer (primary,
    // ChatGPT-style live transcript) or the server audio path (fallback).
    browserSttRef.current = getSpeechRecognitionCtor() !== null;
    setBrowserSttActive(browserSttRef.current);
    setErrorMsg(null);
    setMicError(null);
    setMicHint(null);
    setTurns([]);
    setStage("connecting");
    try {
      const { session } = await api.createVoiceSession({ receptionist_id: receptionistId, language });
      sessionRef.current = session.id;
      setSessionId(session.id);
      const token = api.getToken() ?? "";
      const ws = new WebSocket(voiceWebSocketUrl(session.id, token));
      wsRef.current = ws;

      const finishPlayback = () => {
        if (!speakingRef.current) return;
        speakingRef.current = false;
        resetVadCalibration();
        setStage((s) => (s === "ended" || s === "error" ? s : "listening"));
        // Assistant finished talking → the caller can speak again.
        resumeBrowserRecognition();
      };
      finishPlaybackRef.current = finishPlayback;

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as {
          type: string;
          stage?: string;
          role?: string;
          text?: string;
          tool?: string;
          format?: string;
          data?: string;
          message?: string;
          ack?: boolean;
        };
        switch (msg.type) {
          case "status":
            // Ignore the server's "listening" while reply audio is still
            // queued/playing locally — the mic must not arm during playback.
            if (msg.stage === "listening" && (speakingRef.current || audioPlayingRef.current)) break;
            if (msg.stage === "listening") resetVadCalibration();
            if (msg.stage) setStage(msg.stage as Stage);
            break;
          case "transcript": {
            const tText = msg.text ?? "";
            const tRole = (msg.role ?? "assistant") as Turn["role"];
            // Belt-and-braces: a user transcript made only of symbols (the
            // recognizer's '#' breath artifact) is never rendered, never kept.
            if (tRole === "user" && !/[\p{L}\p{N}]/u.test(tText)) break;
            addTurn(tRole, tText);
            break;
          }
          case "tool":
            addTurn("tool", null, msg.tool);
            break;
          case "audio": {
            if (msg.data) {
              const binary = atob(msg.data);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              const chunk: AudioChunk = {
                bytes: bytes.buffer,
                mime: msg.format === "mp3" ? "audio/mpeg" : "audio/wav",
              };

              if (recordingRef.current && !speakingRef.current && !audioPlayingRef.current && !pumpingRef.current) {
                if (msg.ack) {
                  // A backchannel ack is worthless once the caller has kept
                  // the floor — drop it instead of queuing stale audio.
                  break;
                }
                // Caller is mid-utterance and nothing is playing yet: the
                // recording is pure caller speech (the mic never arms while
                // the assistant talks), so DISCARDING it — the old behaviour —
                // silently ate half of every conversation. HOLD the reply
                // instead: playback starts the moment the utterance flushes
                // (sendUtterance → releaseHeldAudio).
                audioQueueRef.current.push(chunk);
                holdForMicRef.current = true;
                setStage("listening");
                break;
              }
              if (recordingRef.current) {
                // Recording in flight while assistant audio IS playing: the
                // recording began during playback (barged-in) and is
                // contaminated with the assistant's own voice — discard it.
                if (silenceTimerRef.current) {
                  clearTimeout(silenceTimerRef.current);
                  silenceTimerRef.current = null;
                }
                chunksRef.current = [];
                stopRecording();
              }
              speakingRef.current = true;
              setStage("speaking");
              // Assistant takes the floor: the browser recognizer must not
              // hear (and transcribe) the assistant's own TTS voice.
              pauseBrowserRecognition();
              audioQueueRef.current.push(chunk);
              if (!audioPlayingRef.current && !pumpingRef.current) void pumpQueue();
            }
            break;
          }
          case "pong":
            break;
          case "error":
            setErrorMsg(msg.message ?? "An error occurred during the call.");
            break;
          case "ended":
            speakingRef.current = false;
            setStage("ended");
            break;
        }
      };

      ws.onclose = () => {
        if (!["idle", "ended", "error"].includes(stageRef.current)) {
          setStage("ended");
        }
      };

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("WebSocket failed to connect"));
      });

      // Keepalive: the server answers {"type":"pong"} and ignores the frame.
      if (keepaliveRef.current) clearInterval(keepaliveRef.current);
      keepaliveRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, 20_000);

      // Greet immediately — it must not depend on microphone availability.
      // Mic setup is asynchronous: if the browser blocks or denies access,
      // the call continues in keyboard mode (full pipeline, typed turns).
      ws.send(JSON.stringify({ type: "greet" }));
      void setupMic();
      // Arm the browser-native recognizer (primary STT) — it owns the live
      // transcript and turn submission; the server audio path is the fallback.
      if (browserSttRef.current) startBrowserRecognition();
    } catch (err) {
      setStage("error");
      if (err instanceof ApiError) {
        setErrorMsg(mapApiError(err));
      } else {
        setErrorMsg("Could not start the call. Verify the backend and ai-bridge services are running, then try again.");
      }
    }
  }, [addTurn, language, pauseBrowserRecognition, pumpQueue, receptionistId, resetVadCalibration, resumeBrowserRecognition, setupMic, startBrowserRecognition, stopAudio, stopRecording]);

  // Mute gates the browser recognizer too: muted → stop listening entirely.
  useEffect(() => {
    if (muted) {
      pauseBrowserRecognition();
    } else if (sessionId) {
      resumeBrowserRecognition();
    }
  }, [muted, sessionId, pauseBrowserRecognition, resumeBrowserRecognition]);

  useEffect(() => {
    return () => {
      browserSttRef.current = false;
      stopBrowserRecognition();
      wsRef.current?.close();
      teardownMic();
      const sid = sessionRef.current;
      if (sid) void api.endVoiceSession(sid, "caller_ended").catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Waveform bars animate from the live microphone RMS (genuinely audio-driven).
  useEffect(() => {
    if (!["listening", "transcribing", "thinking", "thinking_ack", "speaking"].includes(stage)) {
      setBars(Array.from({ length: 36 }, () => 3));
      return;
    }
    const id = setInterval(() => {
      setBars(() =>
        Array.from({ length: 36 }, (_, i) => {
          const base = muted || micError ? 4 : Math.max(3, Math.min(34, level * 420 * (0.55 + 0.45 * Math.abs(Math.sin(i * 0.7 + Date.now() / 140)))));
          return base;
        }),
      );
    }, 90);
    return () => clearInterval(id);
  }, [stage, level, muted, micError]);

  const sendText = useCallback(() => {
    const text = textInput.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "text", data: text }));
    setTextInput("");
  }, [textInput]);

  const stageLabel: Record<Stage, string> = {
    idle: "Ready",
    connecting: "Connecting…",
    listening: "Listening — speak naturally",
    transcribing: "Transcribing your speech…",
    thinking: "Receptionist is thinking…",
    thinking_ack: "Receptionist is checking…",
    speaking: "Receptionist is speaking — interrupt anytime",
    ended: "Call ended",
    error: "Error",
  };

  const isActive = ["connecting", "listening", "transcribing", "thinking", "thinking_ack", "speaking"].includes(stage);
  const levelPct = Math.min(100, Math.round(level * 400));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Live Voice Laboratory"
        description="Two-way voice conversation with your AI receptionist — real speech recognition, real language model, real speech synthesis. Every transcript below comes from the live pipeline."
      />

      <GlassCard className="p-4 md:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-end">
          <div className="flex-1 space-y-2">
            <label className="text-sm font-medium" htmlFor="vl-receptionist">AI Receptionist</label>
            <Select
              value={receptionistId}
              onValueChange={(v) => {
                setReceptionistId(v);
                const rec = receptionists.find((r) => r.id === v);
                if (rec) setLanguage(rec.primary_language);
              }}
              disabled={isActive || recsLoading}
            >
              <SelectTrigger id="vl-receptionist" className="min-h-11 w-full">
                <SelectValue placeholder={recsLoading ? "Loading receptionists…" : "Select an active receptionist"} />
              </SelectTrigger>
              <SelectContent>
                {receptionists.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name} · {r.voice_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 space-y-2">
            <label className="flex items-center gap-1.5 text-sm font-medium" htmlFor="vl-language">
              <Languages className="h-4 w-4" aria-hidden /> Conversation language
            </label>
            <Select value={language} onValueChange={setLanguage} disabled={isActive}>
              <SelectTrigger id="vl-language" className="min-h-11 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(selected?.languages ?? ["en"]).map((code) => {
                  const lang = SUPPORTED_LANGUAGES.find((l) => l.code === code);
                  return (
                    <SelectItem key={code} value={code}>
                      {lang?.label ?? code}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            {!isActive ? (
              <Button
                onClick={startCall}
                disabled={!receptionistId || stage === "connecting"}
                className="min-h-11 bg-teal-600 text-white hover:bg-teal-700"
                aria-label="Start call"
              >
                {stage === "connecting" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <PhoneCall className="h-4 w-4" aria-hidden />}
                Start Call
              </Button>
            ) : (
              <Button
                onClick={() => void endCall("caller_ended")}
                variant="destructive"
                className="min-h-11"
                aria-label="End call"
              >
                <PhoneOff className="h-4 w-4" aria-hidden />
                End Call
              </Button>
            )}
            {isActive && (
              <Button
                variant="outline"
                size="icon"
                className="min-h-11 min-w-11"
                onClick={() => setMuted((m) => !m)}
                aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                aria-pressed={muted}
              >
                {muted ? <MicOff className="h-4 w-4" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
              </Button>
            )}
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-3 rounded-xl border border-black/5 bg-stone-50/60 p-4 dark:border-white/10 dark:bg-white/5 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2 text-sm font-medium">
            {stage === "error" ? (
              <AlertTriangle className="h-4 w-4 text-rose-500" aria-hidden />
            ) : isActive ? (
              <Activity className="h-4 w-4 animate-pulse text-teal-600" aria-hidden />
            ) : null}
            {stageLabel[stage]}
          </div>
          <div className="flex h-10 flex-1 items-end justify-center gap-[3px]" aria-hidden>
            {bars.map((h, i) => (
              <div
                key={i}
                className="w-[4px] rounded-full bg-teal-500/70 transition-[height] duration-100"
                style={{ height: `${h}px` }}
              />
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
            <span className="sr-only" aria-live="polite">Microphone input level {levelPct}%</span>
            {isActive && !micError && !muted && (
              <span className="h-1.5 w-20 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700" aria-hidden>
                <span
                  className="block h-full rounded-full bg-teal-500 transition-[width] duration-150"
                  style={{ width: `${levelPct}%` }}
                />
              </span>
            )}
            <span>{muted ? "Microphone muted" : micError ? "Keyboard mode" : isActive ? (browserSttActive ? "Live mic · instant transcription" : "Microphone live") : "Microphone off"}</span>
          </div>
        </div>

        {errorMsg && (
          <div role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
            {errorMsg}
          </div>
        )}
        {micError && (
          <div role="status" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            {micError}
          </div>
        )}
        {micHint && !micError && (
          <div role="status" className="mt-4 flex items-start gap-2 rounded-lg border border-teal-200 bg-teal-50 p-3 text-sm text-teal-800 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300">
            <Mic className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {micHint}
          </div>
        )}
      </GlassCard>

      <GlassCard className="flex max-h-[52vh] min-h-[320px] flex-col p-4 md:p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
            Live transcript {sessionId ? <span className="font-normal normal-case">· session active</span> : null}
          </h2>
          {selected && <StatusBadge status={selected.status} />}
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto pr-1">
          {turns.length === 0 ? (
            <EmptyState
              icon={PhoneCall}
              title="No conversation yet"
              description="Start a call and speak — or type a message below. The transcript, tool actions and audio responses you see here are produced live by the real AI pipeline."
            />
          ) : (
            <>
              {turns.map((t) =>
                t.role === "tool" ? (
                  <div key={t.id} className="flex justify-center">
                    <span className="rounded-full border border-teal-200 bg-teal-50 px-3 py-1 font-mono text-xs text-teal-700 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300">
                      ⚙ {t.tool_name}
                    </span>
                  </div>
                ) : (
                  <motion.div
                    key={t.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      t.role === "user" ? "ml-auto bg-teal-600 text-white" : "glass-subtle mr-auto"
                    }`}
                  >
                    <span className="sr-only">{t.role === "user" ? "Caller" : "Receptionist"}: </span>
                    {t.content}
                  </motion.div>
                ),
              )}
              {interimText && (
                <motion.div
                  key="interim"
                  initial={{ opacity: 0.5 }}
                  animate={{ opacity: 0.8 }}
                  className="ml-auto max-w-[85%] rounded-2xl border border-dashed border-teal-400/60 bg-teal-600/10 px-4 py-2.5 text-sm italic leading-relaxed text-teal-700 dark:text-teal-300"
                  aria-live="polite"
                >
                  <span className="sr-only">You are saying: </span>
                  {interimText}…
                </motion.div>
              )}
            </>
          )}
        </div>
        <div className="mt-4 flex gap-2 border-t border-black/5 pt-4 dark:border-white/10">
          <Keyboard className="mt-2.5 h-4 w-4 shrink-0 text-stone-400" aria-hidden />
          <Input
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendText();
              }
            }}
            placeholder={isActive ? "Type a message instead of speaking…" : "Start a call first, then type here"}
            disabled={!isActive}
            className="min-h-11"
            aria-label="Type a message to the receptionist"
          />
          <Button onClick={sendText} disabled={!isActive || !textInput.trim()} className="min-h-11">
            Send
          </Button>
        </div>
      </GlassCard>

      {recsError && (
        <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
          Could not load receptionists: {mapApiError(recsError)}{" "}
          <button onClick={() => void refetch()} className="underline">Retry</button>
        </div>
      )}
      {!recsLoading && receptionists.length === 0 && !recsError && (
        <EmptyState
          icon={PhoneCall}
          title="No active receptionists"
          description="Create and activate an AI receptionist first — then return here to talk to it."
        />
      )}
    </div>
  );
}
