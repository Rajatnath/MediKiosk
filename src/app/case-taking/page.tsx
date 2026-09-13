'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import AccessibilityBar from '@/components/AccessibilityBar';
import RedFlagAlert from '@/components/RedFlagAlert';
import { loadSession, saveSession, ConversationMessage, ClinicalState, defaultClinicalState, KNOWN_CLINICAL_FIELDS } from '@/lib/store';
import { t } from '@/lib/translations';
import { detectRedFlags } from '@/lib/redFlagRules';
import { getDiseaseSpecificQuestion, calculateScaledSeverity, SeverityLevel } from '@/lib/questionEngine';
import { v4 as uuidv4 } from 'uuid';
import { KioskVoiceMic } from '@/components/KioskVoiceMic';
import {
  Thermometer,
  Wind,
  Activity,
  CircleDot,
  Zap,
  AlertCircle,
  RotateCcw,
  HeartPulse,
  Volume2,
  VolumeX,
  FileText,
  AlertTriangle,
  Keyboard,
  CheckCircle2,
  ArrowRight,
} from 'lucide-react';
import styles from './page.module.css';

/**
 * Recursively converts any non-primitive value in a report object to a safe
 * renderable string. This prevents "Objects are not valid as a React child"
 * errors when the AI returns nested objects instead of flat strings.
 */
function sanitizeReport(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val == null || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      result[key] = val;
    } else if (Array.isArray(val)) {
      result[key] = val.map((item) => {
        if (item == null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') return item;
        if (typeof item === 'object') return sanitizeReport(item as Record<string, unknown>);
        return String(item);
      });
    } else if (typeof val === 'object') {
      // For known string fields that the AI may mistakenly return as objects,
      // flatten the object into a readable string
      const knownStringFields = [
        'chief_complaint', 'history_of_present_illness', 'summary_text', 'ai_disclaimer',
        'priority', 'onset', 'character', 'location', 'radiation',
      ];
      if (knownStringFields.includes(key)) {
        result[key] = Object.entries(val as Record<string, unknown>)
          .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
          .join('. ');
      } else {
        result[key] = sanitizeReport(val as Record<string, unknown>);
      }
    } else {
      result[key] = String(val);
    }
  }
  return result;
}

type InputMode = 'idle' | 'speaking' | 'listening' | 'processing' | 'asking';

interface BrowserSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
}

interface DynamicQuestion {
  question: string;
  options: string[];
  field: string;
  is_complete: boolean;
}

// Absolute safety net only — the AI decides when the interview is actually
// done (via is_complete). This just guarantees we can never loop forever if
// that never happens for some reason.
const MAX_QUESTIONS = 12;

export default function CaseTakingPage() {
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);
  
  if (!isMounted) return null;
  return <CaseTakingContent />;
}

function CaseTakingContent() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [session, setSession] = useState(loadSession());
  const lang = session.language;

  useEffect(() => {
    setMounted(true);
  }, []);

  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [clinicalState, setClinicalState] = useState<ClinicalState>(
    { ...defaultClinicalState, ...session.clinicalState }
  );
  const [currentQuestion, setCurrentQuestion] = useState<DynamicQuestion | null>(() =>
    getDiseaseSpecificQuestion({ ...defaultClinicalState, ...session.clinicalState }, 0, session.language || 'hi')
  );
  const [lastAnswer, setLastAnswer] = useState('');
  const [questionCount, setQuestionCount] = useState(0);
  const [inputMode, setInputMode] = useState<InputMode>('idle');
  const [textInput, setTextInput] = useState('');
  const [showTypeInput, setShowTypeInput] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [redFlags, setRedFlags] = useState(session.redFlags);
  const [showRedFlag, setShowRedFlag] = useState(false);
  const [micHint, setMicHint] = useState<string | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [generatedReport, setGeneratedReport] = useState<Record<string, any> | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [severityLevel, setSeverityLevel] = useState<SeverityLevel>('MILD');

  // Refs — these hold live/mutable objects that don't need re-renders
  const messagesRef = useRef<ConversationMessage[]>([]);
  const voiceEnabledRef = useRef(true);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const speechRecognitionRef = useRef<any | null>(null);
  const recordedMimeTypeRef = useRef<string>('audio/webm');
  const browserTranscriptRef = useRef<string>('');
  const hasSpokenRef = useRef<boolean>(false);
  const audioChunksRef = useRef<Blob[]>([]);
  const skipProcessRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const silenceFallbackTimerRef = useRef<number | null>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const speakResolveRef = useRef<(() => void) | null>(null);
  const consecutiveFailuresRef = useRef(0);
  const isInitializedRef = useRef(false);
  const isProcessingAnswerRef = useRef(false);
  const currentSpeechIdRef = useRef(0);
  const ttsAbortRef = useRef<AbortController | null>(null);

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { voiceEnabledRef.current = voiceEnabled; }, [voiceEnabled]);

  function addAIMessage(text: string, options?: string[]) {
    setMessages(prev => {
      const lastMsg = prev[prev.length - 1];
      if (lastMsg && lastMsg.speaker === 'AI' && lastMsg.text === text) return prev;
      const msg: ConversationMessage = { id: uuidv4(), speaker: 'AI', text, timestamp: new Date().toISOString(), options };
      return [...prev, msg];
    });
  }

  function addPatientMessage(text: string) {
    const msg: ConversationMessage = { id: uuidv4(), speaker: 'PATIENT', text, timestamp: new Date().toISOString() };
    setMessages(prev => [...prev, msg]);
  }

  // ─── Text-to-speech playback (Sarvam) ─────────────────────────────────────
  function interruptSpeech() {
    currentSpeechIdRef.current += 1;
    if (ttsAbortRef.current) {
      try { ttsAbortRef.current.abort(); } catch {}
      ttsAbortRef.current = null;
    }
    if (currentAudioRef.current) {
      try {
        currentAudioRef.current.pause();
        currentAudioRef.current.currentTime = 0;
      } catch {}
      currentAudioRef.current = null;
    }
    if (speakResolveRef.current) {
      const resolve = speakResolveRef.current;
      speakResolveRef.current = null;
      resolve();
    }
  }

  async function speak(text: string): Promise<void> {
    if (!voiceEnabledRef.current || !text) return;
    interruptSpeech();

    const speechId = ++currentSpeechIdRef.current;
    const abortController = new AbortController();
    ttsAbortRef.current = abortController;

    setInputMode('speaking');
    try {
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, lang }),
        signal: abortController.signal,
      });

      if (speechId !== currentSpeechIdRef.current) return;

      if (resp.ok) {
        const data = await resp.json();
        if (speechId !== currentSpeechIdRef.current) return;

        if (data.audio_base64) {
          const audio = new Audio(`data:audio/wav;base64,${data.audio_base64}`);
          currentAudioRef.current = audio;
          await new Promise<void>((resolve) => {
            speakResolveRef.current = resolve;
            audio.onended = () => {
              if (currentAudioRef.current === audio) currentAudioRef.current = null;
              speakResolveRef.current = null;
              resolve();
            };
            audio.onerror = () => {
              if (currentAudioRef.current === audio) currentAudioRef.current = null;
              speakResolveRef.current = null;
              resolve();
            };
            audio.play().catch(() => {
              if (currentAudioRef.current === audio) currentAudioRef.current = null;
              speakResolveRef.current = null;
              resolve();
            });
          });
        }
      }
    } catch {
      // Voice playback is best-effort — the on-screen caption + tap options still work.
    }
  }

  // ─── Silence detection & Voice Activity Watcher while the mic is listening ──
  function cleanupSilenceWatch() {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (silenceFallbackTimerRef.current) { window.clearTimeout(silenceFallbackTimerRef.current); silenceFallbackTimerRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null; }
  }

  function stopListening(discard = false) {
    skipProcessRef.current = discard;
    cleanupSilenceWatch();
    if (speechRecognitionRef.current) {
      try {
        if (discard) speechRecognitionRef.current.abort?.();
        else speechRecognitionRef.current.stop?.();
      } catch {}
      speechRecognitionRef.current = null;
    }
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      setInputMode(discard ? 'idle' : 'processing');
      try { recorder.stop(); } catch {}
    } else if (discard) {
      setInputMode('idle');
    }
  }

  function startSilenceWatch(stream: MediaStream) {
    try {
      const AudioContextClass = window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioContextClass();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const startedAt = Date.now();
      let silenceStart: number | null = null;
      let hasSpoken = false;

      // Intelligent thresholds for kiosk audio
      const SPEECH_THRESHOLD = 8;          // RMS amplitude indicating human voice
      const SILENCE_THRESHOLD = 5;         // RMS amplitude below this counts as quiet
      const INITIAL_MAX_SILENCE_MS = 8000; // Allow user 8s to start speaking before returning to idle
      const TRAILING_SILENCE_MS = 2200;    // 2.2s of silence after speech indicates user is done
      const MAX_RECORDING_MS = 25000;      // 25s hard safety limit

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = data[i] - 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        const elapsed = Date.now() - startedAt;

        if (!hasSpoken) {
          if (rms >= SPEECH_THRESHOLD) {
            hasSpoken = true;
            hasSpokenRef.current = true;
            silenceStart = null;
          } else if (elapsed > INITIAL_MAX_SILENCE_MS) {
            // Patient hasn't started speaking within 8 seconds — cleanly return to idle without showing an error
            stopListening(true);
            return;
          }
        } else {
          // Patient has started speaking; monitor for trailing pause
          if (rms < SILENCE_THRESHOLD) {
            if (silenceStart === null) silenceStart = Date.now();
            if (Date.now() - silenceStart > TRAILING_SILENCE_MS) {
              stopListening(false);
              return;
            }
          } else {
            silenceStart = null;
          }
        }

        if (elapsed > MAX_RECORDING_MS) {
          stopListening(false);
          return;
        }

        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // AudioContext unsupported or blocked — fall back to a generous 12s duration
      silenceFallbackTimerRef.current = window.setTimeout(() => stopListening(false), 12000);
    }
  }

  async function startListening() {
    if (isProcessingAnswerRef.current || inputMode === 'processing' || inputMode === 'asking') return;
    interruptSpeech();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      setMicHint(null);
      hasSpokenRef.current = false;
      browserTranscriptRef.current = '';

      // Determine best supported MIME type
      let chosenMime = 'audio/webm;codecs=opus';
      if (typeof MediaRecorder !== 'undefined') {
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
          chosenMime = 'audio/webm;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/webm')) {
          chosenMime = 'audio/webm';
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
          chosenMime = 'audio/mp4';
        } else if (MediaRecorder.isTypeSupported('audio/aac')) {
          chosenMime = 'audio/aac';
        } else {
          chosenMime = '';
        }
      }
      recordedMimeTypeRef.current = chosenMime || 'audio/webm';

      const recorder = chosenMime ? new MediaRecorder(stream, { mimeType: chosenMime }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      skipProcessRef.current = false;

      recorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach(tr => tr.stop());
        cleanupSilenceWatch();
        if (speechRecognitionRef.current) {
          try { speechRecognitionRef.current.stop?.(); } catch {}
          speechRecognitionRef.current = null;
        }
        if (skipProcessRef.current) {
          skipProcessRef.current = false;
          setInputMode('idle');
          return;
        }
        const blob = new Blob(audioChunksRef.current, { type: recordedMimeTypeRef.current });
        await processVoice(blob);
      };

      // Optional Web Speech API parallel fallback (in supported browsers)
      try {
        const SpeechRec = (window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any }).SpeechRecognition ||
          (window as unknown as { webkitSpeechRecognition?: any }).webkitSpeechRecognition;
        if (SpeechRec) {
          const recognition = new SpeechRec();
          recognition.lang = lang === 'hi' ? 'hi-IN' : 'en-IN';
          recognition.continuous = false;
          recognition.interimResults = false;
          recognition.maxAlternatives = 1;
          recognition.onresult = (event: any) => {
            const transcript = event.results?.[0]?.[0]?.transcript;
            if (transcript) browserTranscriptRef.current = transcript;
          };
          recognition.onerror = () => {};
          recognition.onend = () => {};
          speechRecognitionRef.current = recognition;
          recognition.start();
        }
      } catch {}

      // We record as a single continuous block. Using timeslice (e.g., start(250)) 
      // can cause chunk stitching issues or missing EBML headers in some browsers (like Brave on Mac), 
      // causing the STT API to reject the file as corrupt.
      recorder.start();
      setInputMode('listening');
      startSilenceWatch(stream);
    } catch {
      setInputMode('idle');
      setMicHint(lang === 'hi'
        ? 'माइक उपलब्ध नहीं। कृपया नीचे विकल्प चुनें या टाइप करें।'
        : 'Microphone unavailable. Please tap an option below or type your answer.');
    }
  }

  async function processVoice(blob: Blob) {
    // If the recording is empty/negligible and user didn't speak
    if (!blob || blob.size < 1200) {
      if (browserTranscriptRef.current && browserTranscriptRef.current.trim()) {
        await processAnswer(browserTranscriptRef.current.trim());
        return;
      }
      if (!hasSpokenRef.current) {
        setInputMode('idle');
        return;
      }
    }

    setInputMode('processing');

    // 1. Try Sarvam AI STT
    try {
      const formData = new FormData();
      const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : blob.type.includes('wav') ? 'wav' : 'webm';
      formData.append('audio', blob, `recording.${ext}`);
      formData.append('lang', lang);

      const resp = await fetch('/api/stt', { method: 'POST', body: formData });
      if (resp.ok) {
        const data = await resp.json();
        if (data.transcript && data.transcript.trim()) {
          await processAnswer(data.transcript.trim());
          return;
        }
      }
    } catch (err) {
      console.error('STT API error:', err);
    }

    // 2. Fallback to Browser Speech Recognition transcript if Sarvam failed or returned empty
    if (browserTranscriptRef.current && browserTranscriptRef.current.trim()) {
      await processAnswer(browserTranscriptRef.current.trim());
      return;
    }

    // 3. Prompt user cleanly if voice was not understood
    setInputMode('idle');
    setMicHint(lang === 'hi'
      ? 'समझ नहीं आया। कृपया फिर से बोलें या नीचे विकल्प चुनें।'
      : 'Sorry, I could not understand that. Please try again or tap an option below.');
  }

  // ─── Fetch next question from AI / engine, then speak it, then auto-listen ────
  async function fetchNextQuestion(state: ClinicalState, msgs: ConversationMessage[], count: number) {
    if (count >= MAX_QUESTIONS) {
      await finishInterview(state);
      return;
    }

    try {
      const resp = await fetch('/api/next-question', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clinical_state: state,
          conversation_history: msgs.map(m => ({ speaker: m.speaker, text: m.text })),
          question_count: count,
          lang,
        }),
      });

      let q: DynamicQuestion;
      if (resp.ok) {
        q = await resp.json();
      } else {
        q = buildFallbackQuestion(state, lang, count);
      }
      consecutiveFailuresRef.current = 0;

      if (q.is_complete || count >= MAX_QUESTIONS) {
        await finishInterview(state);
        return;
      }

      // Display question & options IMMEDIATELY without waiting for audio
      // Clear previous answer pill before showing the next question (voice state machine: SUCCESS -> NEXT QUESTION)
      setLastAnswer('');
      setCurrentQuestion(q);
      addAIMessage(q.question, q.options);
      setInputMode('idle');

      await speak(q.question);
      if (!isProcessingAnswerRef.current) {
        await startListening();
      }
    } catch {
      consecutiveFailuresRef.current += 1;
      if (consecutiveFailuresRef.current >= 3) {
        await finishInterview(state);
        return;
      }
      const fallback = buildFallbackQuestion(state, lang, count);
      if (fallback.is_complete || count >= MAX_QUESTIONS) {
        await finishInterview(state);
        return;
      }
      setLastAnswer('');
      setCurrentQuestion(fallback);
      addAIMessage(fallback.question, fallback.options);
      setInputMode('idle');
      await speak(fallback.question);
      if (!isProcessingAnswerRef.current) {
        await startListening();
      }
    }
  }

  async function finishInterview(stateToUse?: ClinicalState, flagsToUse?: typeof redFlags) {
    setIsComplete(true);
    setCurrentQuestion(null);
    setInputMode('idle');
    setReportLoading(true);

    const activeState = stateToUse || clinicalState;
    const activeFlags = flagsToUse || redFlags;

    const closingText = lang === 'hi'
      ? 'आपकी सभी जानकारी दर्ज कर ली गई है। आपकी संपूर्ण रिपोर्ट तैयार की जा रही है।'
      : 'All your information has been recorded. Generating your complete report.';
    addAIMessage(closingText);
    await speak(closingText);

    try {
      const resp = await fetch('/api/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clinical_state: activeState,
          red_flags: activeFlags,
          documents: session.documents || [],
          lang,
        }),
      });

      if (resp.ok) {
        const data = await resp.json();
        // Sanitize the report so any nested objects the AI returned are
        // flattened into strings before React tries to render them.
        const summaryData = sanitizeReport(data.summary as Record<string, unknown>);
        setGeneratedReport(summaryData);
        const updSession = {
          ...session,
          clinicalState: activeState,
          messages: messagesRef.current,
          redFlags: activeFlags,
          summary: JSON.stringify(summaryData),
        };
        setSession(updSession);
        saveSession(updSession);

        const readyText = lang === 'hi'
          ? 'आपकी पूर्ण रिपोर्ट तैयार हो गई है। कृपया इसे देखें।'
          : 'Your complete report is ready. Please review it.';
        await speak(readyText);
      }
    } catch (err) {
      console.error('Failed to generate report after interview:', err);
    } finally {
      setReportLoading(false);
    }
  }

  // ─── Initial greeting + first question ───────────────────────────────────
  useEffect(() => {
    if (isInitializedRef.current) return;
    isInitializedRef.current = true;

    const initialQ = buildFallbackQuestion(clinicalState, lang, 0);
    setCurrentQuestion(initialQ);
    setInputMode('idle');

    if (messages.length === 0) {
      const greeting = lang === 'hi'
        ? `नमस्ते${session.patient ? ` ${session.patient.name.split(' ')[0]}` : ''}! मैं आपकी AI सहायक हूँ। बताइए, आज आपको क्या तकलीफ है?`
        : `Hello${session.patient ? ` ${session.patient.name.split(' ')[0]}` : ''}! I'm your AI assistant. Tell me, what brings you in today?`;

      const greetMsg: ConversationMessage = { id: uuidv4(), speaker: 'AI', text: greeting, timestamp: new Date().toISOString(), options: initialQ.options };
      setMessages([greetMsg]);

      (async () => {
        await speak(greeting);
        if (!isProcessingAnswerRef.current) {
          setInputMode('idle');
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop any audio/mic activity if the user navigates away mid-conversation
  useEffect(() => {
    return () => {
      interruptSpeech();
      stopListening(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Process patient answer (from voice, tap, or typed text) ─────────────
  async function processAnswer(answer: string) {
    if (isProcessingAnswerRef.current) return;
    if (!answer.trim() || !currentQuestion || inputMode === 'processing' || inputMode === 'asking') return;

    isProcessingAnswerRef.current = true;
    interruptSpeech();
    stopListening(true);
    addPatientMessage(answer);
    setLastAnswer(answer);
    setMicHint(null);
    setInputMode('processing');
    setTextInput('');
    setShowTypeInput(false);

    try {
      const resp = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question_id: currentQuestion.field,
          question_field: currentQuestion.field,
          answer,
          clinical_state: clinicalState,
          lang,
        }),
      });

      let newState: ClinicalState;
      if (resp.ok) {
        const data = await resp.json();
        newState = data.updated_state
          ? mergeExtractedState(clinicalState, data.updated_state, currentQuestion, answer)
          : applyAnswerFallback(currentQuestion, answer, clinicalState);
      } else {
        newState = applyAnswerFallback(currentQuestion, answer, clinicalState);
      }

      // Automatically scale severity according to disease question & patient answer
      const scaled = calculateScaledSeverity(answer, currentQuestion.field, newState.severity ?? null);
      if (scaled.score > (newState.severity || 0) || currentQuestion.field === 'severity') {
        newState.severity = scaled.score;
      }
      setSeverityLevel(scaled.level);

      setClinicalState(newState);

      const flags = detectRedFlags(newState, lang);
      if (flags.length > 0 && flags.length > redFlags.length) {
        setRedFlags(flags);
        setShowRedFlag(true);
      }

      const updSession = { ...session, clinicalState: newState, messages: messagesRef.current, redFlags: flags };
      saveSession(updSession);

      // If a severe red flag is detected, skip remaining questions immediately
      if (flags.some(f => f.severity === 'HIGH')) {
        await finishInterview(newState, flags);
        return;
      }

      const newCount = questionCount + 1;
      setQuestionCount(newCount);
      await fetchNextQuestion(newState, messagesRef.current, newCount);
    } catch {
      const newCount = questionCount + 1;
      setQuestionCount(newCount);
      await fetchNextQuestion(clinicalState, messagesRef.current, newCount);
    } finally {
      isProcessingAnswerRef.current = false;
    }
  }

  // ─── Fallback: pick the disease-specific question when API fails ─────────
  function buildFallbackQuestion(state: ClinicalState, lang: 'hi' | 'en', count: number = 0): DynamicQuestion {
    return getDiseaseSpecificQuestion(state, count, lang);
  }

  // ─── Helpers for complaint-specific (non-fixed) fields ───────────────────
  // The dynamic AI question engine can invent a field name for anything that
  // doesn't fit the fixed ClinicalState schema (e.g. "which animal bit you").
  // Those get preserved verbatim here instead of being silently dropped.
  function isKnownField(field: string): field is keyof ClinicalState {
    return (KNOWN_CLINICAL_FIELDS as string[]).includes(field);
  }

  function withAdditionalFinding(state: ClinicalState, field: string, question: string, answer: string): ClinicalState {
    const existingIdx = state.additional_findings.findIndex(f => f.field === field);
    const entry = { field, question, answer };
    const nextFindings = existingIdx >= 0
      ? state.additional_findings.map((f, i) => (i === existingIdx ? entry : f))
      : [...state.additional_findings, entry];
    return { ...state, additional_findings: nextFindings };
  }

  // Merge whatever /api/extract returned into clinicalState: known fields go
  // into their typed slot, anything complaint-specific is kept verbatim in
  // additional_findings so it always flows through to the final report.
  function mergeExtractedState(
    base: ClinicalState,
    extracted: Record<string, unknown>,
    question: DynamicQuestion,
    rawAnswer: string
  ): ClinicalState {
    let next = { ...base };

    for (const [key, value] of Object.entries(extracted)) {
      if (isKnownField(key)) {
        (next as Record<string, unknown>)[key] = value;
      }
    }

    if (isKnownField(question.field)) {
      if (!(question.field in extracted)) {
        if (Array.isArray(next[question.field])) {
          next = { ...next, [question.field]: [...(next[question.field] as string[]), rawAnswer] };
        } else {
          (next as Record<string, unknown>)[question.field] = rawAnswer;
        }
      }
    } else {
      const answerText = typeof extracted[question.field] === 'string' ? String(extracted[question.field]) : rawAnswer;
      next = withAdditionalFinding(next, question.field, question.question, answerText);
    }

    return next;
  }

  // ─── Fallback: apply answer without any AI (extraction API unreachable) ──
  function applyAnswerFallback(question: DynamicQuestion, answer: string, state: ClinicalState): ClinicalState {
    const field = question.field;
    let s = { ...state };
    const lower = answer.toLowerCase();
    const boolYes = lower.includes('हाँ') || lower.includes('yes') || lower.includes('ha') || lower.includes('haa');
    const boolFields = ['breathlessness', 'sweating', 'dizziness', 'nausea', 'previous_episode'];

    if (isKnownField(field)) {
      if (boolFields.includes(field)) {
        (s as Record<string, unknown>)[field] = boolYes;
      } else if (field === 'severity') {
        const scaled = calculateScaledSeverity(answer, 'severity', s.severity ?? null);
        s.severity = scaled.score;
      } else if (Array.isArray(s[field])) {
        s = { ...s, [field]: [...(s[field] as string[]), answer] };
      } else {
        (s as Record<string, unknown>)[field] = answer;
      }
    } else {
      s = withAdditionalFinding(s, field, question.question, answer);
    }

    // Auto-detect symptoms from text
    if (lower.includes('सांस') || lower.includes('breath')) s.breathlessness = true;
    if (lower.includes('पसीना') || lower.includes('sweat')) s.sweating = true;
    if (lower.includes('चक्कर') || lower.includes('dizzy')) s.dizziness = true;
    if (lower.includes('उल्टी') || lower.includes('vomit') || lower.includes('जी मिचलाना') || lower.includes('nausea')) s.nausea = true;

    // Check if answer contains scaled severity information
    const scaled = calculateScaledSeverity(answer, String(field), s.severity ?? null);
    if (scaled.score > (s.severity || 0)) {
      s.severity = scaled.score;
    }

    return s;
  }

  // ─── UI event handlers ────────────────────────────────────────────────────
  function handleMicTap() {
    if (inputMode === 'listening') { stopListening(false); return; }
    if (inputMode === 'speaking') { interruptSpeech(); startListening(); return; }
    if (inputMode === 'idle') { startListening(); return; }
  }

  function handleOptionTap(opt: string) {
    if (isProcessingAnswerRef.current || inputMode === 'processing') return;
    if (inputMode === 'listening') stopListening(true);
    if (inputMode === 'speaking') interruptSpeech();
    processAnswer(opt);
  }

  function handleTypedSubmit() {
    if (!textInput.trim()) return;
    if (inputMode === 'listening') stopListening(true);
    else if (inputMode === 'speaking') interruptSpeech();
    processAnswer(textInput);
  }

  function handleContinue() {
    interruptSpeech();
    stopListening(true);
    saveSession({
      ...session,
      clinicalState,
      messages,
      redFlags,
      summary: generatedReport ? JSON.stringify(generatedReport) : session.summary,
    });
    router.push('/upload');
  }

  function updateSession(updates: Partial<typeof session>) {
    const updated = { ...session, ...updates };
    setSession(updated);
    saveSession(updated);
  }

  // The interview length is now dynamic (the AI decides when it's done), so
  // this is a soft/asymptotic indicator of progress rather than a literal
  // fraction of a fixed total — it keeps growing but never falsely implies
  // "almost done" too early.
  const progress = isComplete ? 100 : Math.min(85, 15 + questionCount * 12);

  const isChiefComplaintPhase = !clinicalState.chief_complaint && questionCount === 0;

  const quickSymptoms = [
    { icon: <Thermometer size={22} strokeWidth={2.2} color="#DC2626" />, label: t(lang, 'chief_fever') },
    { icon: <Wind size={22} strokeWidth={2.2} color="#2563EB" />, label: t(lang, 'chief_cough') },
    { icon: <Activity size={22} strokeWidth={2.2} color="#D97706" />, label: t(lang, 'chief_stomach') },
    { icon: <CircleDot size={22} strokeWidth={2.2} color="#7C3AED" />, label: t(lang, 'chief_headache') },
    { icon: <Zap size={22} strokeWidth={2.2} color="#EA580C" />, label: t(lang, 'chief_bodyache') },
    { icon: <AlertCircle size={22} strokeWidth={2.2} color="#059669" />, label: t(lang, 'chief_vomiting') },
    { icon: <RotateCcw size={22} strokeWidth={2.2} color="#4B5563" />, label: t(lang, 'chief_weakness') },
    { icon: <HeartPulse size={22} strokeWidth={2.2} color="#DC2626" />, label: t(lang, 'chief_chest_pain') },
  ];

  return (
    <div className="page-container" style={{ minHeight: '100dvh', height: '100dvh', maxHeight: '100dvh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <AccessibilityBar
        lang={lang}
        onLangChange={(l) => updateSession({ language: l })}
        fontScale={session.fontScale}
        onFontChange={(s) => updateSession({ fontScale: s })}
      />

      <main id="main-content" tabIndex={-1} className={styles.main}>
        {/* Top bar */}
        <div className={styles.topBar}>
          <div>
            <div className={styles.topTitle}>
              {lang === 'hi' ? 'स्वास्थ्य इतिहास' : 'Clinical History'}
            </div>
            {mounted && session.patient && (
              <div className={styles.topPatient}>
                {session.patient.name} · {session.patient.age} {lang === 'hi' ? 'वर्ष' : 'yrs'} · {session.patient.gender}
              </div>
            )}
          </div>

          <div className={styles.progressWrap}>
            <button
              className={styles.voiceToggleBtn}
              onClick={() => setVoiceEnabled(v => !v)}
              title={voiceEnabled ? 'Mute voice output' : 'Enable voice output'}
              aria-label={voiceEnabled ? 'Mute voice output' : 'Enable voice output'}
            >
              {voiceEnabled ? <Volume2 size={18} strokeWidth={2} /> : <VolumeX size={18} strokeWidth={2} />}
            </button>
            <div className={styles.progressLabel}>
              {isComplete
                ? (lang === 'hi' ? 'परामर्श पूर्ण' : 'Consultation Complete')
                : isChiefComplaintPhase
                ? (lang === 'hi' ? 'शुरुआती समस्या' : 'Chief Problem')
                : questionCount < 4
                ? (lang === 'hi' ? 'शुरू हो रहे हैं…' : 'Getting started…')
                : questionCount < 8
                ? (lang === 'hi' ? 'थोड़े सवाल बचे हैं' : 'A few questions left')
                : (lang === 'hi' ? 'लगभग पूरा' : 'Almost done')}
            </div>
            <div className="progress-bar-track" style={{ width: 140 }}>
              <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>

        {/* Red flag */}
        {showRedFlag && redFlags.length > 0 && (
          <div style={{ padding: '0 20px', maxWidth: 800, margin: '0 auto', width: '100%' }}>
            <RedFlagAlert flags={redFlags} lang={lang} onClose={() => setShowRedFlag(false)} />
          </div>
        )}

        {/* Voice-first conversation stage */}
        <div className={`${styles.stage} ${isComplete ? styles.stageComplete : ''}`}>
          {currentQuestion && !isComplete && (
            <div
              className={styles.questionBubble}
              data-read-aloud="true"
            >
              <p className={styles.questionText}>
                {isChiefComplaintPhase ? t(lang, 'chief_prompt') : currentQuestion.question}
              </p>
              <button
                className={styles.replaySpeechBtn}
                onClick={() => speak(isChiefComplaintPhase ? t(lang, 'chief_prompt') : currentQuestion.question)}
                aria-label={lang === 'hi' ? 'दोबारा सुनें' : 'Listen again'}
                title={lang === 'hi' ? 'दोबारा सुनें' : 'Listen again'}
              >
                <Volume2 size={22} strokeWidth={2} />
              </button>
            </div>
          )}
          {isComplete && (
            <p className={styles.questionCaption}>
              {lang === 'hi' ? 'आपके सभी उत्तर दर्ज हो गए हैं।' : 'Your answers are all recorded.'}
            </p>
          )}

          {/* Hero Microphone Interaction (Reusable 4-state KioskVoiceMic) */}
          {!isComplete && (
            <KioskVoiceMic
              state={
                inputMode === 'listening'
                  ? 'listening'
                  : inputMode === 'processing' || inputMode === 'asking' || reportLoading
                  ? 'processing'
                  : inputMode === 'speaking'
                  ? 'speaking'
                  : 'idle'
              }
              lang={lang}
              onStart={startListening}
              onStop={() => stopListening(false)}
              onSpeakAgain={startListening}
              recognizedText={lastAnswer}
              hint={micHint}
              exampleText={
                isChiefComplaintPhase
                  ? (lang === 'hi' ? 'उदाहरण: "मुझे 3 दिन से बुखार है"' : 'Example: “I have had a fever for 3 days.”')
                  : (lang === 'hi' ? 'अपना उत्तर बोलें या विकल्प चुनें' : 'Speak your answer or tap an option')
              }
            />
          )}


          {/* Complete Clinical Report Card generated right after disease questions finish */}
          {isComplete && (
            <div className={styles.reportPreviewCard}>
              <div className={styles.reportHeader}>
                <div className={styles.reportTitleWrap}>
                  <div className={styles.reportIcon}>
                    <FileText size={26} strokeWidth={2.2} color="#1E5B2B" />
                  </div>
                  <div>
                    <h2 className={styles.reportTitle}>
                      {lang === 'hi' ? 'आपका चिकित्सा इतिहास सारांश' : 'Medical History Summary'}
                    </h2>
                    <p className={styles.reportSubtitle}>
                      {lang === 'hi' ? 'AI-सहायक इतिहास सारांश — चिकित्सक समीक्षा आवश्यक' : 'AI-assisted history summary — physician review required'}
                    </p>
                  </div>
                </div>
                {generatedReport?.priority && (
                  <span className={`${styles.priorityBadge} ${styles['priority_' + String(generatedReport.priority).toLowerCase()] || ''}`}>
                    {generatedReport.priority}
                  </span>
                )}
              </div>

              {reportLoading ? (
                <div className={styles.reportLoadingWrap}>
                  <div className={styles.loadingChecklist}>
                    <div className={styles.loadingCheckItem}>
                      <CheckCircle2 size={18} strokeWidth={2.5} color="#166534" />
                      <span>{lang === 'hi' ? 'बातचीत पूरी हो गई' : 'Conversation completed'}</span>
                    </div>
                    <div className={styles.loadingCheckItem}>
                      <CheckCircle2 size={18} strokeWidth={2.5} color="#166534" />
                      <span>{lang === 'hi' ? 'आपके उत्तर सहेजे गए' : 'Your answers organised'}</span>
                    </div>
                    <div className={`${styles.loadingCheckItem} ${styles.loadingCheckActive}`}>
                      <div className="spinner" style={{ width: 18, height: 18, borderWidth: 2, flexShrink: 0 }} />
                      <span>{lang === 'hi' ? 'डॉक्टर सारांश तैयार हो रहा है…' : 'Preparing doctor summary…'}</span>
                    </div>
                  </div>
                  <p className={styles.loadingHint}>{lang === 'hi' ? 'इसमें एक पल लग सकता है।' : 'This may take a moment.'}</p>
                </div>
              ) : generatedReport ? (
                <div className={styles.reportBody}>
                  {/* Scaled Severity Row */}
                  <div className={styles.reportSeverityRow}>
                    <span className={styles.reportSectionLabel} style={{ marginBottom: 0 }}>
                      {lang === 'hi' ? 'तकलीफ की तीव्रता:' : 'Severity Level:'}
                    </span>
                    <span className={`${styles.severityBadgeLive} ${styles[`sev_${severityLevel.toLowerCase()}`] || styles.sev_mild}`}>
                      <span className={styles.severityDot} />
                      {severityLevel === 'MILD' && (lang === 'hi' ? 'सामान्य (Mild - 1-3/10)' : 'Mild (1-3/10)')}
                      {severityLevel === 'MODERATE' && (lang === 'hi' ? 'मध्यम (Moderate - 4-6/10)' : 'Moderate (4-6/10)')}
                      {severityLevel === 'SEVERE' && (lang === 'hi' ? 'गंभीर (Severe - 7-8/10)' : 'Severe (7-8/10)')}
                      {severityLevel === 'CRITICAL' && (lang === 'hi' ? 'अति-गंभीर (Critical - 9-10/10)' : 'Critical (9-10/10)')}
                    </span>
                  </div>

                  {generatedReport.summary_text && (
                    <p className={styles.reportSummaryText}>{generatedReport.summary_text}</p>
                  )}

                  <div className={styles.reportDetailsGrid}>
                    {generatedReport.chief_complaint && (
                      <div className={styles.reportSection}>
                        <span className={styles.reportSectionLabel}>
                          {lang === 'hi' ? 'मुख्य समस्या' : 'Chief Complaint'}:
                        </span>
                        <span className={styles.reportSectionValue}>{generatedReport.chief_complaint}</span>
                      </div>
                    )}

                    {generatedReport.history_of_present_illness && (
                      <div className={styles.reportSection}>
                        <span className={styles.reportSectionLabel}>
                          {lang === 'hi' ? 'लक्षण इतिहास' : 'History of Present Illness'}:
                        </span>
                        <span className={styles.reportSectionValue}>{generatedReport.history_of_present_illness}</span>
                      </div>
                    )}

                    {generatedReport.associated_symptoms && Array.isArray(generatedReport.associated_symptoms) && generatedReport.associated_symptoms.length > 0 && (
                      <div className={styles.reportSection}>
                        <span className={styles.reportSectionLabel}>
                          {lang === 'hi' ? 'संबद्ध लक्षण' : 'Associated Symptoms'}:
                        </span>
                        <div className={styles.symptomPills}>
                          {generatedReport.associated_symptoms.map((s: string, idx: number) => (
                            <span key={idx} className={styles.symptomPill}>{s}</span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Red flags warning if detected */}
                    {((generatedReport.red_flags && generatedReport.red_flags.length > 0) || redFlags.length > 0) && (
                      <div className={styles.reportRedFlags}>
                        <div className={styles.reportRedFlagTitle}>
                          <AlertTriangle size={18} strokeWidth={2.2} color="#DC2626" />
                          <span>{lang === 'hi' ? 'चेतावनी संकेत (Red Flags)' : 'Warning Signs (Red Flags)'}</span>
                        </div>
                        {(generatedReport.red_flags || redFlags.map(f => f.description)).map((rf: string, idx: number) => (
                          <div key={idx} className={styles.reportRedFlagItem}>
                            <span>•</span>
                            <span>{rf}</span>
                          </div>
                        ))}
                      </div>
                    )}

                  </div>

                  {/* AI Disclaimer — Physician Review Notice */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 12, color: '#166534', marginTop: 4 }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
                      <path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                    <span>{lang === 'hi' ? 'AI-सहायक इतिहास सारांश — चिकित्सक समीक्षा आवश्यक' : 'AI-assisted history summary — physician review required.'}</span>
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {/* Chief Complaint Quick Tap Symptoms */}
          {!isComplete && isChiefComplaintPhase && (
            <div className={styles.quickSymptomSection}>
              <p className={styles.quickSymptomTitle}>{t(lang, 'chief_quick_tap')}</p>
              <div className={styles.quickSymptomGrid}>
                {quickSymptoms.map((s, idx) => (
                  <button
                    key={idx}
                    className={styles.quickSymptomCard}
                    onClick={() => handleOptionTap(s.label)}
                    disabled={inputMode === 'processing'}
                  >
                    <span className={styles.quickSymptomIcon}>{s.icon}</span>
                    <span className={styles.quickSymptomLabel}>{s.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* MCQ tap options for adaptive questions */}
          {!isComplete && !isChiefComplaintPhase && currentQuestion && currentQuestion.options?.length > 0 && (
            <div className={styles.mcqGrid}>
              {currentQuestion.options.map(opt => (
                <button
                  key={opt}
                  className={styles.mcqBtn}
                  onClick={() => handleOptionTap(opt)}
                  disabled={inputMode === 'processing'}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}

          {/* Secondary "type instead" fallback */}
          {!isComplete && (
            <div className={styles.typeSection}>
              <button className={styles.typeInsteadBtn} onClick={() => setShowTypeInput(v => !v)}>
                <Keyboard size={16} strokeWidth={2} />
                <span>{t(lang, 'case_type_instead')}</span>
              </button>

              {showTypeInput && (
                <div className={styles.typeInputRow}>
                  <input
                    id="case-text-input"
                    className="input"
                    type="text"
                    placeholder={t(lang, 'case_type_placeholder')}
                    value={textInput}
                    onChange={e => setTextInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleTypedSubmit()}
                    autoFocus
                  />
                  <button id="case-send-btn" className="btn btn-primary" onClick={handleTypedSubmit} disabled={!textInput.trim()}>
                    {t(lang, 'case_send')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {isComplete && (
          <div className={styles.completeBar}>
            <div className={styles.completeBarInner}>
              <div className={styles.completeMsg}>
                <CheckCircle2 size={24} strokeWidth={2.5} color="#166534" style={{ flexShrink: 0 }} />
                <div>
                  <div>{lang === 'hi' ? 'आपके उत्तर दर्ज हो गए हैं।' : 'Your answers have been recorded.'}</div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)', marginTop: 2 }}>
                    {lang === 'hi' ? 'आप अपनी पुरानी दवाएं या रिपोर्ट जोड़ सकते हैं।' : 'You can now add previous prescriptions or reports.'}
                  </div>
                </div>
              </div>
              <button id="case-continue-btn" className="btn btn-primary btn-lg" onClick={handleContinue}>
                <span>{lang === 'hi' ? 'दस्तावेज़ अपलोड करें' : 'Upload Documents'}</span>
                <ArrowRight size={20} strokeWidth={2.2} />
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
