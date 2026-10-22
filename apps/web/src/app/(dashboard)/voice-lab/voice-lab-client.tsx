"use client";

/**
 * LIVE AI VOICE LABORATORY (spec §6E)
 *
 * A genuine two-way voice conversation with the configured AI receptionist:
 * - Browser microphone capture (MediaRecorder, webm/opus) with voice-activity
 *   detection (RMS silence detection) — no prerecorded audio, no fake waveforms.
 * - Turn-based WebSocket pipeline: mic → STT → LLM (+tools, +RAG, +safety) → TTS.
 * - Barge-in: speaking interrupts assistant playback.
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

const SILENCE_MS = 1100;
const MAX_UTTERANCE_MS = 15000;
const SPEAK_RMS = 0.045;

export function VoiceLabClient() {
  const params = useSearchParams();
  const presetReceptionistId = params.get("receptionist") ?? "";

  const [receptionistId, setReceptionistId] = useState("");
  const [language, setLanguage] = useState("en");
  const [stage, setStage] = useState<Stage>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [muted, setMuted] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
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
  const barFrame = useRef(0);

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
  const sendUtterance = useCallback(async (blob: Blob) => {
    const buf = await blob.arrayBuffer();
    if (buf.byteLength < 1200) return; // noise gate
    let binary = "";
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const b64 = btoa(binary);
    wsRef.current?.send(JSON.stringify({ type: "audio", data: b64 }));
  }, []);

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

    const tick = () => {
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

      if (st === "speaking" && rms > SPEAK_RMS) {
        speechFrames += 1;
        if (speechFrames > 10) {
          stopAudio(); // barge-in
        }
      } else {
        speechFrames = 0;
      }

      if (st === "listening" && !mutedRef.current) {
        if (rms > SPEAK_RMS) {
          if (!recordingRef.current) startRecording();
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
        } else if (recordingRef.current && !silenceTimerRef.current) {
          silenceTimerRef.current = setTimeout(() => {
            silenceTimerRef.current = null;
            stopRecording();
          }, SILENCE_MS);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [startRecording, stopAudio, stopRecording]);

  const setupMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      analyserRef.current = analyser;

      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        if (chunksRef.current.length > 0) {
          const blob = new Blob(chunksRef.current, { type: mime });
          void sendUtterance(blob);
          chunksRef.current = [];
        }
      };
      recorderRef.current = recorder;
      monitorLoop();
      return true;
    } catch {
      setMicError(
        "Microphone access was denied or is unavailable. You can still test with the keyboard input below — the full AI pipeline (STT skipped, LLM, tools, TTS) runs identically.",
      );
      return false;
    }
  }, [monitorLoop, sendUtterance]);

  const teardownMic = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    stopRecording();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    void audioCtxRef.current?.close().catch(() => undefined);
    streamRef.current = null;
    audioCtxRef.current = null;
    analyserRef.current = null;
    recorderRef.current = null;
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
    setTurns([]);
    setStage("connecting");
    try {
      const { session } = await api.createVoiceSession({ receptionist_id: receptionistId, language });
      sessionRef.current = session.id;
      setSessionId(session.id);
      const token = api.getToken() ?? "";
      const ws = new WebSocket(voiceWebSocketUrl(session.id, token));
      wsRef.current = ws;

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
              el.onended = () => URL.revokeObjectURL(url);
              void el.play().catch(() => {
                setErrorMsg("Autoplay was blocked by the browser. Click anywhere on the page, then start the call again.");
              });
            }
            break;
          }
          case "error":
            setErrorMsg(msg.message ?? "An error occurred during the call.");
            break;
          case "ended":
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
  }, [addTurn, language, receptionistId, setupMic]);

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
    speaking: "Receptionist is speaking (interrupt anytime)",
    ended: "Call ended",
    error: "Error",
  };

  const isActive = ["connecting", "listening", "transcribing", "thinking", "speaking"].includes(stage);

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
          <div className="text-xs text-stone-500 dark:text-stone-400">
            {muted ? "Microphone muted" : micError ? "Keyboard mode" : isActive ? "Microphone live" : "Microphone off"}
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
