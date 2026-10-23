"use client";

/**
 * LIVE AI VOICE LABORATORY (spec §6E)
 *
 * A genuine two-way voice conversation with the configured AI receptionist:
 * - Browser microphone capture (MediaRecorder) with adaptive voice-activity
 *   detection: the ambient noise floor is calibrated on every call and the
 *   speech threshold adjusts to the room and the mic level.
 * - Utterances are decoded, resampled to 16 kHz mono WAV and peak-normalized
 *   before upload, so the recognizer always receives clean, well-levelled
 *   audio regardless of the recording container the browser produced.
 * - Echo-proof turn taking: the microphone is never armed while the assistant's
 *   audio is still playing (recording resumes the moment playback ends or the
 *   caller barges in), so the recognizer never transcribes the assistant's
 *   own voice.
 * - Turn-based WebSocket pipeline: mic → STT → LLM (+tools, +RAG, +safety) → TTS.
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

type Stage = "idle" | "connecting" | "listening" | "transcribing" | "thinking" | "speaking" | "ended" | "error";

interface Turn extends Pick<ConversationMessage, "role" | "content" | "tool_name"> {
  id: string;
}

const SILENCE_MS = 1300;
const MAX_UTTERANCE_MS = 15000;
const MIN_UTTERANCE_MS = 450; // discard noise blips
const CALIBRATION_FRAMES = 48; // ~0.8 s of ambient-noise sampling at 60 fps
const LOW_MIC_HINT_MS = 6000;

interface WavPacket {
  b64: string;
  durationMs: number;
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
  const recordingRef = useRef(false);
  const recStartRef = useRef(0);
  const barFrame = useRef(0);
  // Adaptive VAD state
  const thresholdRef = useRef(0.045);
  const calibSamplesRef = useRef<number[]>([]);
  const calibDoneRef = useRef(false);
  // Assistant-playback gating (echo-proof turn taking)
  const speakingRef = useRef(false);
  // Low-mic hint state
  const quietMsRef = useRef(0);
  const lastTickRef = useRef(0);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receptionists]);

  const selected = receptionists.find((r) => r.id === receptionistId);

  const addTurn = useCallback((role: Turn["role"], content: string | null, toolName?: string) => {
    setTurns((prev) => [
      ...prev,
      { id: `t${prev.length}-${Date.now()}`, role, content, tool_name: toolName ?? null },
    ]);
  }, []);

  const stopAudio = useCallback(() => {
    const el = audioElRef.current;
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
  }, []);

  // ── Microphone capture + VAD ────────────────────────────────────────────
  const sendUtterance = useCallback(
    async (blob: Blob, mimeType: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // Preferred path: decoded, resampled, peak-normalized WAV.
      const wav = audioCtxRef.current ? await blobToWav16k(blob, audioCtxRef.current) : null;
      if (wav) {
        if (wav.durationMs < MIN_UTTERANCE_MS) return; // noise blip — discard silently
        ws.send(JSON.stringify({ type: "audio", data: wav.b64 }));
        return;
      }
      // Fallback: upload the raw recording (recognizer handles webm/mp4/ogg too).
      const buf = await blob.arrayBuffer();
      if (buf.byteLength < 1200) return;
      ws.send(JSON.stringify({ type: "audio", data: await blobToRawBase64(new Blob([buf], { type: mimeType })) }));
    },
    [],
  );

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === "recording") {
      recorderRef.current.stop();
    }
    recordingRef.current = false;
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
          thresholdRef.current = Math.max(0.016, Math.min(0.06, floor * 3 + 0.008));
          calibDoneRef.current = true;
        }
      }
      const threshold = thresholdRef.current;

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
      } else if (st === "listening" && !mutedRef.current) {
        if (rms > threshold) {
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
              "Speak a little closer to the microphone — or use the text input below if your mic is unavailable.",
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
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      analyserRef.current = analyser;

      // Pick the first container this browser can actually record (Safari
      // only does mp4, Firefox prefers ogg/webm, Chrome webm/opus).
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
      resetVadCalibration();
      monitorLoop();
      return true;
    } catch {
      setMicError(
        "Microphone access was denied or is unavailable. You can still test with the keyboard input below — the full AI pipeline (STT skipped, LLM, tools, TTS) runs identically.",
      );
      return false;
    }
  }, [monitorLoop, resetVadCalibration, sendUtterance]);

  const teardownMic = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    stopRecording();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    void audioCtxRef.current?.close().catch(() => undefined);
    streamRef.current = null;
    audioCtxRef.current = null;
    analyserRef.current = null;
    recorderRef.current = null;
    speakingRef.current = false;
    setLevel(0);
  }, [stopRecording]);

  // ── Call lifecycle ──────────────────────────────────────────────────────
  const endCall = useCallback(
    async (reason: string) => {
      wsRef.current?.send(JSON.stringify({ type: "end" }));
      wsRef.current?.close();
      wsRef.current = null;
      teardownMic();
      stopAudio();
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
    [stopAudio, teardownMic],
  );

  const startCall = useCallback(async () => {
    if (!receptionistId) return;
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
        setStage((s) => (s === "ended" || s === "error" ? s : "listening"));
      };

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
        };
        switch (msg.type) {
          case "status":
            // Ignore the server's "listening" while assistant audio is still
            // playing locally — the mic must not arm during playback.
            if (msg.stage === "listening" && speakingRef.current) break;
            if (msg.stage === "listening") resetVadCalibration();
            if (msg.stage) setStage(msg.stage as Stage);
            break;
          case "transcript":
            addTurn((msg.role ?? "assistant") as Turn["role"], msg.text ?? "");
            break;
          case "tool":
            addTurn("tool", null, msg.tool);
            break;
          case "audio": {
            if (msg.data) {
              const binary = atob(msg.data);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              const blob = new Blob([bytes.buffer], { type: msg.format === "mp3" ? "audio/mpeg" : "audio/wav" });
              const url = URL.createObjectURL(blob);
              const el = audioElRef.current ?? new Audio();
              audioElRef.current = el;
              el.src = url;
              speakingRef.current = true;
              setStage("speaking");
              el.onended = () => {
                URL.revokeObjectURL(url);
                finishPlayback();
              };
              void el.play().catch(() => {
                speakingRef.current = false;
                setStage("listening");
                setErrorMsg("Autoplay was blocked by the browser. Click anywhere on the page, then start the call again.");
              });
            }
            break;
          }
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

      // Greet immediately — it must not depend on microphone availability.
      // Mic setup is asynchronous: if the browser blocks or denies access,
      // the call continues in keyboard mode (full pipeline, typed turns).
      ws.send(JSON.stringify({ type: "greet" }));
      void setupMic();
    } catch (err) {
      setStage("error");
      if (err instanceof ApiError) {
        setErrorMsg(mapApiError(err));
      } else {
        setErrorMsg("Could not start the call. Verify the backend and ai-bridge services are running, then try again.");
      }
    }
  }, [addTurn, language, receptionistId, resetVadCalibration, setupMic]);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
      teardownMic();
      const sid = sessionRef.current;
      if (sid) void api.endVoiceSession(sid, "caller_ended").catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Waveform bars animate from the live microphone RMS (genuinely audio-driven).
  useEffect(() => {
    if (!["listening", "transcribing", "thinking", "speaking"].includes(stage)) {
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
    speaking: "Receptionist is speaking — interrupt anytime",
    ended: "Call ended",
    error: "Error",
  };

  const isActive = ["connecting", "listening", "transcribing", "thinking", "speaking"].includes(stage);
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
            <span>{muted ? "Microphone muted" : micError ? "Keyboard mode" : isActive ? "Microphone live" : "Microphone off"}</span>
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
            turns.map((t) =>
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
            )
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
