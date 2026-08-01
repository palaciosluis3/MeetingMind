import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import {
    FileText, ListTodo, MessageSquare, ShieldCheck, Cpu, Terminal, Trash2, AlertCircle,
    Upload, Loader2, User, AlertTriangle, Gavel, Users, ChevronRight, CheckCircle2, Circle, Star, Download,
    Copy, Check, File, Plus, Search, Power, Settings
} from 'lucide-react';
import * as GoogleAIModule from "@google/genai";

// Robust detection of SDK exports (handles different versions and esm.sh bundling)
const GenAI = (GoogleAIModule as any).GoogleGenAI || (GoogleAIModule as any).default?.GoogleGenAI;
const ST = (GoogleAIModule as any).SchemaType || (GoogleAIModule as any).Type || (GoogleAIModule as any).default?.SchemaType || (GoogleAIModule as any).default?.Type || {
    OBJECT: "OBJECT",
    STRING: "STRING",
    ARRAY: "ARRAY",
    BOOLEAN: "BOOLEAN"
};

// Robust detection of FileManager (might not be available in all browser bundles)
const FileManager = (GoogleAIModule as any).GoogleAIFileManager || (GoogleAIModule as any).default?.GoogleAIFileManager;

// ==========================================
// 0. USER CONFIGURATION
// ==========================================
// Everything user-specific lives in `config.json`: the name of the person the
// app belongs to and the API keys. `server.pyw` serves that file as /config.js
// and index.html loads it BEFORE this module, so the settings are already here
// at import time — no async boot ordering to get wrong, and no key sitting in a
// file that gets distributed.

export interface AppConfig {
    ownerName: string;
    ownerAliases: string[];
    geminiApiKey: string;
    openaiApiKey: string;
}

const readConfig = (): AppConfig => {
    const w = window as any;
    const stored = w.MEETINGMIND_CONFIG || {};
    return {
        ownerName: String(stored.ownerName || '').trim(),
        ownerAliases: Array.isArray(stored.ownerAliases)
            ? stored.ownerAliases.map((a: any) => String(a).trim()).filter(Boolean)
            : [],
        // Keys set the old way — straight into index.html — still work.
        geminiApiKey: String(stored.geminiApiKey || w.GEMINI_API_KEY || '').trim(),
        openaiApiKey: String(stored.openaiApiKey || w.OPENAI_API_KEY || '').trim(),
    };
};

let appConfig: AppConfig = readConfig();
const getConfig = (): AppConfig => appConfig;

// A config is usable once we know who the user is and can talk to Gemini, which
// does both the analysis and the free transcription.
const isConfigured = (config: AppConfig): boolean => Boolean(config.ownerName && config.geminiApiKey);

// Persist through the backend and refresh the in-memory copy. A blank key field
// is left OUT of the payload, and the server treats an absent field as "keep
// what you have" — that is what stops an empty form from wiping a key the
// provider will never show again.
const saveConfig = async (next: AppConfig): Promise<AppConfig> => {
    const patch: Partial<AppConfig> = {
        ownerName: next.ownerName.trim(),
        ownerAliases: next.ownerAliases.map(a => a.trim()).filter(Boolean),
    };
    if (next.geminiApiKey.trim()) patch.geminiApiKey = next.geminiApiKey.trim();
    if (next.openaiApiKey.trim()) patch.openaiApiKey = next.openaiApiKey.trim();

    const response = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
    if (!response.ok) throw new Error(`El servidor no pudo guardar la configuración (HTTP ${response.status}).`);

    appConfig = { ...appConfig, ...patch };
    return appConfig;
};

const getGeminiKey = (): string => {
    const key = getConfig().geminiApiKey;
    if (!key) throw new Error("Falta la API Key de Google Gemini. Añádela en Configuración.");
    return key;
};

// The owner as the prompts need to see them. The real name and the nicknames
// people actually use stay in the prompt on purpose: with a generic placeholder
// a small model starts guessing who is who almost immediately.
interface OwnerIdentity {
    name: string;
    firstName: string;
    references: string;   // '"Luis", "Lucho", "Palacios"'
}

const getOwner = (): OwnerIdentity | null => {
    const { ownerName, ownerAliases } = getConfig();
    if (!ownerName) return null;
    const firstName = ownerName.split(/\s+/)[0];
    const references = Array.from(new Set([firstName, ...ownerAliases].filter(Boolean)));
    return { name: ownerName, firstName, references: references.map(r => `"${r}"`).join(', ') };
};

// Does a hand-typed assignee refer to the owner? Used by the manual task form,
// where the user writes a free-form name.
const assigneeIsOwner = (assignee: string): boolean => {
    const { ownerName, ownerAliases } = getConfig();
    const needle = assignee.trim().toLowerCase();
    if (!ownerName || !needle) return false;
    return [ownerName, ownerName.split(/\s+/)[0], ...ownerAliases]
        .filter(Boolean)
        .some(candidate => needle.includes(candidate.toLowerCase()));
};

// Gemini model used for analysis (minutes + tasks) and, optionally, transcription.
// Its display name comes from the provider registry below.
const MODEL = "gemini-3.1-flash-lite";

// Label used when a model returns text with no speaker attribution at all.
// Never call that "Hablante 1": the minutes would repeat the invented name.
const OPENAI_UNKNOWN_SPEAKER = 'Sin identificar';

// Transcription providers the user picks from before uploading.
const PROVIDER_GEMINI = 'gemini';
const PROVIDER_OPENAI_FAST = 'openai_fast';
const PROVIDER_OPENAI_DIARIZE = 'openai_diarize';
const STORAGE_KEY_PROVIDER = 'meetingmind_transcription_provider';

// Wall-clock cost of uploading the re-encoded WAV chunks, as a fraction of the
// recording's length. Measured at ~0.73 MB/s against an 18.3 MB segment; audio
// is 32 KB/s at 16 kHz mono 16-bit, so ≈0.045x. Applies to every provider.
const UPLOAD_TIME_FACTOR = 0.045;

// Real-time factors are MEASURED, not guessed — see the table below. They drive
// the time estimate shown before the user commits to a paid run.
const PROVIDERS: Record<string, {
    label: string;
    model: string;
    costPerMinute: number;   // USD
    realTimeFactor: number;  // processing seconds per second of audio
    diarizes: boolean;
    note: string;
}> = {
    [PROVIDER_GEMINI]: {
        label: 'Gemini 3.1 Flash Lite',
        model: 'gemini-3.1-flash-lite',
        costPerMinute: 0,
        realTimeFactor: 0.075,   // ~30-60 s per 10-min segment, observed in use
        diarizes: true,
        note: 'Separa hablantes por prompt.',
    },
    [PROVIDER_OPENAI_FAST]: {
        label: 'OpenAI GPT Transcribe',
        model: 'gpt-transcribe',
        costPerMinute: 0.0045,
        realTimeFactor: 0.027,   // measured: 16.1 s for a 600 s segment
        diarizes: false,
        note: 'NO separa hablantes: solo texto corrido.',
    },
    [PROVIDER_OPENAI_DIARIZE]: {
        label: 'OpenAI GPT-4o Transcribe Diarize',
        model: 'gpt-4o-transcribe-diarize',
        costPerMinute: 0.006,
        realTimeFactor: 0.324,   // measured: 194.6 s for a 600 s segment
        diarizes: true,
        note: 'Separa hablantes de forma nativa, la más precisa.',
    },
};

const isOpenAI = (provider: string) =>
    provider === PROVIDER_OPENAI_FAST || provider === PROVIDER_OPENAI_DIARIZE;

// Gemini model used for analysis (minutes + tasks) whatever transcribed the audio.
const MODEL_DISPLAY_NAME = PROVIDERS[PROVIDER_GEMINI].label;

// Audio chunking: split long recordings by DURATION, identically for every
// provider. 10 minutes of 16 kHz mono 16-bit WAV is ~19 MB, which also stays
// comfortably under OpenAI's 25 MB upload cap, so one rule serves both.
const CHUNK_SECONDS = 600;   // 10 minutes per segment
const TARGET_SAMPLE_RATE = 16000; // 16 kHz mono is plenty for speech and keeps uploads small

// Segments are cut mid-sentence, which used to strand the opening turn of every
// chunk with a guessed speaker. Overlap a few seconds so the model hears the
// run-up to its own first words.
const CHUNK_OVERLAP_SECONDS = 8;

// Only used for the last-resort case where the browser cannot decode the file
// at all and the raw upload would be rejected outright.
const OPENAI_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Containers the transcription endpoint accepts. OpenAI infers the format from
// the filename, so anything outside this list must be re-encoded to WAV first.
const OPENAI_SUPPORTED_EXT = /\.(mp3|mp4|mpeg|mpga|m4a|wav|webm)$/i;

// --- Helper: Upload to Gemini File API ---
const uploadAudioToGemini = async (blob: Blob, mimeType: string, apiKey: string, onProgress: (pct: number) => void): Promise<string | null> => {
    try {
        console.log(`Starting XHR Resumable Upload for ${Math.round(blob.size / (1024 * 1024))}MB file...`);

        // 1. Initial Request: Get Resumable Upload URL
        const initResponse = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`, {
            method: 'POST',
            headers: {
                'X-Goog-Upload-Protocol': 'resumable',
                'X-Goog-Upload-Command': 'start',
                'X-Goog-Upload-Header-Content-Length': blob.size.toString(),
                'X-Goog-Upload-Header-Content-Type': mimeType,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ file: { display_name: `Meeting_Session_${Date.now()}` } })
        });

        if (!initResponse.ok) throw new Error(`Upload Init Failed: ${initResponse.statusText}`);
        const uploadUrl = initResponse.headers.get('X-Goog-Upload-URL');
        if (!uploadUrl) throw new Error("No Resumable Upload URL received from Google.");

        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', uploadUrl);
            xhr.setRequestHeader('X-Goog-Upload-Offset', '0');
            xhr.setRequestHeader('X-Goog-Upload-Command', 'upload, finalize');

            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    const percentComplete = Math.round((event.loaded / event.total) * 100);
                    onProgress(percentComplete);
                }
            };

            xhr.onload = async () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const uploadData = JSON.parse(xhr.responseText);
                        const fileName = uploadData.file.name;
                        const fileUri = uploadData.file.uri;

                        let attempts = 0;
                        while (attempts < 60) {
                            await new Promise(r => setTimeout(r, 4000));
                            const pollResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`);
                            const pollData = await pollResponse.json();
                            if (pollData.state === "ACTIVE") return resolve(fileUri);
                            if (pollData.state === "FAILED") return reject(new Error("AI file error."));
                            attempts++;
                        }
                        reject(new Error("Timeout."));
                    } catch (e) { reject(e); }
                } else { reject(new Error(`Status ${xhr.status}`)); }
            };
            xhr.onerror = () => reject(new Error("Network link failed."));
            xhr.send(blob);
        });
    } catch (error) {
        console.warn("Upload failed:", error);
        return null;
    }
};

// --- Helper: Structured generation (single model, retry with backoff) ---
const generateStructured = async (
    ai: any,
    systemInstruction: string,
    promptText: string,
    contentPart: any,
    responseSchema: any,
    taskName: string
): Promise<any> => {
    const runOnce = async () => {
        console.log(`[${taskName}] Running on ${MODEL} | part:`, contentPart.fileData ? 'fileData' : (contentPart.inlineData ? 'inlineData' : 'text'));

        // Standard SDK vs New Architecture (Vertex-style) Support
        let result;
        if (typeof ai.getGenerativeModel === 'function') {
            const model = ai.getGenerativeModel({
                model: MODEL,
                systemInstruction,
                generationConfig: {
                    responseMimeType: "application/json",
                    responseSchema: responseSchema,
                }
            });
            result = await model.generateContent([
                contentPart,
                { text: promptText }
            ]);
        } else if (ai.models && typeof ai.models.generateContent === 'function') {
            // @google/genai only honors systemInstruction INSIDE `config`.
            // Passing it at the top level silently drops it.
            result = await ai.models.generateContent({
                model: MODEL,
                contents: [{ role: "user", parts: [contentPart, { text: promptText }] }],
                config: {
                    systemInstruction: systemInstruction,
                    responseMimeType: "application/json",
                    responseSchema: responseSchema,
                }
            });
        } else {
            console.error("SDK Structure mismatch:", ai);
            throw new Error("Instancia de API incompatible con getGenerativeModel.");
        }

        // Handle inconsistent response wrapper across SDK versions
        let text: string;
        if (result.response) {
            // Standard SDK: result.response is a getter/promise
            const response = await result.response;
            text = response.text();
        } else if (typeof result.text === 'function') {
            // New Architecture: result IS the response object
            text = result.text();
        } else if (result.candidates && result.candidates[0]?.content?.parts?.[0]?.text) {
            // Fallback: Direct property access
            text = result.candidates[0].content.parts[0].text;
        } else {
            console.warn("Unknown response structure:", result);
            text = JSON.stringify(result);
        }

        if (!text) throw new Error("Respuesta vacía de la IA.");

        console.log(`[${taskName}] Raw Output Snapshot:`, text.substring(0, 100));

        // Hallucination sentinel: the model is explicitly instructed to emit one
        // of these markers when the audio is empty/silent. Trust ONLY those
        // deliberate signals. Do NOT infer "no audio" from meeting content —
        // real meetings routinely mention names like "Luis" and words like
        // "mute" ("estaba en mute"), which previously produced false positives
        // and blocked perfectly valid transcriptions.
        const hasCriticalError = text.includes("CRITICAL_ERROR") ||
            text.includes("NO_AUDIO_DATA") ||
            text.includes("NO_AUDIO_DETECTED");

        if (hasCriticalError) {
            throw new Error("La IA no detectó tu audio real. Verifica que el archivo no esté vacío o en silencio.");
        }

        const extractJSON = (rawText: string): any => {
            let cleanText = rawText.trim();

            cleanText = cleanText.replace(/```json\n?|\n?```/g, "").trim();

            const firstBrace = cleanText.indexOf('{');
            const lastBrace = cleanText.lastIndexOf('}');

            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                cleanText = cleanText.substring(firstBrace, lastBrace + 1);
            }

            try {
                return JSON.parse(cleanText);
            } catch (firstError) {
                const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    try {
                        return JSON.parse(jsonMatch[0]);
                    } catch (secondError) {
                        // Continue to next strategy
                    }
                }

                try {
                    let fixed = cleanText
                        .replace(/,\s*}/g, '}')
                        .replace(/,\s*]/g, ']')
                        .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":')
                        .replace(/'/g, '"');
                    return JSON.parse(fixed);
                } catch (thirdError) {
                    console.error("All JSON extraction strategies failed. Raw text:", rawText);
                    throw new Error(`Error de formato en la respuesta de la IA: ${firstError.message}`);
                }
            }
        };

        return extractJSON(text);
    };

    // Retry the SAME model with exponential backoff on transient errors only
    // (429 rate limits / 5xx). Content errors (bad JSON, no-audio sentinel) are
    // not transient and propagate immediately.
    const MAX_ATTEMPTS = 3;
    let lastError: any;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            return await runOnce();
        } catch (error: any) {
            lastError = error;
            const msg = error?.message || '';
            const transient = error?.status === 429 || error?.status >= 500 ||
                /\b(429|500|502|503|overloaded|quota|unavailable)\b/i.test(msg);
            if (!transient || attempt === MAX_ATTEMPTS) throw error;
            const delay = 2000 * attempt;
            console.warn(`[${taskName}] Transient error (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${delay}ms:`, msg);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastError;
};

// ==========================================
// 1. TYPES & ENUMS
// ==========================================
export enum Tab {
    TRANSCRIPT = 'transcription',
    MINUTES = 'minutes',
    TASKS = 'tasks',
}

export interface TranscriptSegment {
    timestamp: string;
    speaker: string;
    text: string;
}

// Canonical intermediate shape. BOTH transcription providers produce this, and
// `transcript_raw` is built from it in exactly one place (serializeTranscript).
// Before this existed the raw string was whatever the model felt like emitting,
// which is how 72 speaker turns ended up crammed onto 9 lines.
export interface TurnSegment {
    startSec: number;
    speaker: string;
    text: string;
}

export interface MinuteData {
    decisions: string[];
    discussion_points: string[];
    participants: string[];
    full_summary_text: string;
}

export interface Task {
    id: string;
    description: string;
    assignee: string;
    is_owner: boolean;      // the task belongs to whoever the app is configured for
    is_priority: boolean;
    completed: boolean;
}

// `is_owner` used to be `is_luis_palacios`, back when the app had exactly one
// user. Databases and exported task files written before that rename still carry
// the old field, so everything coming from storage goes through here.
const migrateTask = (task: any): Task => {
    const { is_luis_palacios, ...rest } = task || {};
    return {
        ...rest,
        is_owner: typeof task?.is_owner === 'boolean' ? task.is_owner : Boolean(is_luis_palacios),
    } as Task;
};

export interface MeetingData {
    language: string;
    transcript_raw: string;
    minutes: MinuteData;
    tasks: Task[];
}

// ==========================================
// 2. TRANSCRIPT NORMALIZATION
// ==========================================
// Everything in this block is provider-agnostic: Gemini and OpenAI both funnel
// their output through it so the rest of the app only ever sees one shape.

const pad2 = (n: number) => String(n).padStart(2, '0');

// Seconds -> "[MM:SS]" (or "[HH:MM:SS]" past the hour), matching the format the
// app has always used. Negative means "unknown timestamp".
const fmtTime = (sec: number): string => {
    if (!isFinite(sec) || sec < 0) return '--:--';
    const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = Math.floor(sec % 60);
    return hh > 0 ? `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}` : `${pad2(mm)}:${pad2(ss)}`;
};

// "MM:SS" or "HH:MM:SS" -> seconds.
const parseTimeToSeconds = (stamp: string): number => {
    const parts = stamp.split(':').map(Number);
    if (parts.some(isNaN)) return -1;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return -1;
};

// THE single place allowed to build `transcript_raw`. One turn per line is the
// whole point: the downloaded .txt must make it unambiguous who said what.
const serializeTranscript = (turns: TurnSegment[]): string =>
    turns
        .filter(t => t.text && t.text.trim())
        .map(t => `[${fmtTime(t.startSec)}] ${t.speaker}: ${t.text.trim()}`)
        .join('\n');

// Collapse a short token repeated absurdly many times. Models occasionally fall
// into a degeneration loop ("eh eh eh eh...") that can swallow an entire segment.
const collapseLoops = (s: string): string =>
    s.replace(/(\b[\wÀ-ÿ]{1,6}\b)(?:[\s,.]+\1\b){5,}/gi, '$1');

// A speaker turn marker: "[MM:SS] Name:". Deliberately NOT anchored to ^ and
// deliberately global — models routinely emit several turns on one line with
// nothing but a space between them, and an anchored match silently merges them
// all into the first speaker.
const TURN_MARKER_RE = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:\n\[\]]{2,40}?)\s*:\s+/g;

// Guard against mistaking a colon inside a sentence for a speaker label.
const looksLikeSpeaker = (candidate: string): boolean => {
    const name = candidate.trim();
    if (name.length < 2 || name.length > 40) return false;
    if (/[.?!;¿¡]/.test(name)) return false;           // sentence fragment, not a name
    if (name.split(/\s+/).length > 5) return false;    // real names are short
    return /^[A-ZÀ-ÞÑ0-9]/.test(name);                 // starts uppercase or digit
};

const cleanTurnText = (s: string): string =>
    s.replace(/^["″“”]+|["″“”]+$/g, '').replace(/\s+/g, ' ').trim();

// Parse a raw transcript string back into turns. Handles three shapes:
//   1. "[MM:SS] Name: text"  markers anywhere in the text (the normal case)
//   2. "Name: text"          line-based, no timestamps (pasted .txt files)
//   3. free prose            returned as a single unattributed turn
// Case 1 is what makes old, un-normalized transcripts render correctly.
const parseTranscriptTurns = (raw: string): TurnSegment[] => {
    if (!raw || !raw.trim()) return [];

    const turns: TurnSegment[] = [];
    let pending: { textFrom: number, startSec: number, speaker: string } | null = null;

    TURN_MARKER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TURN_MARKER_RE.exec(raw)) !== null) {
        if (!looksLikeSpeaker(m[2])) continue;  // e.g. "[01:10:27] Ahí lo importante..." — a bare timestamp

        if (pending) {
            turns.push({ startSec: pending.startSec, speaker: pending.speaker, text: cleanTurnText(raw.slice(pending.textFrom, m.index)) });
        } else if (m.index > 0) {
            const preamble = cleanTurnText(raw.slice(0, m.index));
            if (preamble) turns.push({ startSec: -1, speaker: 'Desconocido', text: preamble });
        }
        pending = { textFrom: TURN_MARKER_RE.lastIndex, startSec: parseTimeToSeconds(m[1]), speaker: m[2].trim() };
    }

    if (pending) {
        turns.push({ startSec: pending.startSec, speaker: pending.speaker, text: cleanTurnText(raw.slice(pending.textFrom)) });
        return turns.filter(t => t.text);
    }

    // No bracketed markers at all — fall back to line-based "Name: text".
    let current: TurnSegment | null = null;
    raw.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
        const head = line.match(/^([^:]{2,40}?)\s*:\s+(.*)$/);
        if (head && looksLikeSpeaker(head[1])) {
            if (current) turns.push(current);
            current = { startSec: -1, speaker: head[1].trim(), text: cleanTurnText(head[2]) };
        } else if (current) {
            current.text = (current.text ? current.text + ' ' : '') + cleanTurnText(line);
        } else {
            current = { startSec: -1, speaker: 'Desconocido', text: cleanTurnText(line) };
        }
    });
    if (current) turns.push(current);

    return turns.filter(t => t.text);
};

// ==========================================
// 3. GEMINI SERVICE
// ==========================================
// Note: transcription and analysis are two separate calls with two separate
// schemas. A combined "meetingSchema" that asked the model for `transcript_raw`
// as one free-form string used to live here; it was unused and it contradicted
// the normalization contract (see section 2), so it is gone. Do not bring it back.
// Built per run because the owner's real name goes into the `is_owner`
// description: the schema is part of what the model reads, so naming the person
// there gives the criterion twice — once in the prompt, once at the field.
const buildAnalysisSchema = (owner: OwnerIdentity | null) => ({
    type: ST.OBJECT,
    properties: {
        language: { type: ST.STRING, description: "The primary language of the meeting." },
        minutes: {
            type: ST.OBJECT,
            properties: {
                decisions: { type: ST.ARRAY, items: { type: ST.STRING } },
                discussion_points: { type: ST.ARRAY, items: { type: ST.STRING } },
                participants: { type: ST.ARRAY, items: { type: ST.STRING } },
                full_summary_text: { type: ST.STRING, description: "Minuta formal DETALLADA y EXTENSA con estructura corporativa, síntesis de argumentos y contexto estratégico." },
            },
            required: ["decisions", "discussion_points", "participants", "full_summary_text"],
        },
        tasks: {
            type: ST.ARRAY,
            items: {
                type: ST.OBJECT,
                properties: {
                    id: { type: ST.STRING },
                    description: { type: ST.STRING, description: "En español" },
                    assignee: { type: ST.STRING },
                    is_owner: {
                        type: ST.BOOLEAN,
                        description: owner
                            ? `true si la tarea es para ${owner.name}.`
                            : "true si la tarea es para quien usa esta aplicación.",
                    },
                    is_priority: { type: ST.BOOLEAN },
                    completed: { type: ST.BOOLEAN },
                },
                required: ["id", "description", "assignee", "is_owner", "is_priority", "completed"],
            },
        },
    },
    required: ["language", "minutes", "tasks"],
});

// One JSON object per speaker turn. A free-form string here was the root cause
// of the diarization bug: the model separated turns with a space instead of a
// newline, so the parser saw one giant turn per line. With an array the model
// physically cannot merge two interventions into one entry.
const transcriptionSchema = {
    type: ST.OBJECT,
    properties: {
        segments: {
            type: ST.ARRAY,
            description: "Intervenciones en orden cronológico. Una entrada por intervención.",
            items: {
                type: ST.OBJECT,
                properties: {
                    time: {
                        type: ST.STRING,
                        description: "Marca de tiempo 'MM:SS' relativa al inicio de ESTE segmento (empieza en 00:00)."
                    },
                    speaker: {
                        type: ST.STRING,
                        description: "Nombre real del hablante, o etiqueta estable 'Hablante N'. Nunca vacío."
                    },
                    text: {
                        type: ST.STRING,
                        description: "Lo dicho por ese hablante en esa intervención."
                    },
                },
                required: ["time", "speaker", "text"],
            },
        },
    },
    required: ["segments"],
};

// Speaker label resolution: map generic labels onto real names found in the talk.
const speakerNamesSchema = {
    type: ST.OBJECT,
    properties: {
        mappings: {
            type: ST.ARRAY,
            items: {
                type: ST.OBJECT,
                properties: {
                    label: { type: ST.STRING, description: "Etiqueta genérica tal cual aparece, ej. 'Hablante A'." },
                    name: { type: ST.STRING, description: "Nombre real, o cadena vacía si no hay evidencia clara." },
                },
                required: ["label", "name"],
            },
        },
    },
    required: ["mappings"],
};

const buildAudioPart = (audioSource: { uri?: string, inlineData?: any }, mimeType: string) =>
    audioSource.uri
        ? { fileData: { mimeType, fileUri: audioSource.uri } }
        : { inlineData: audioSource.inlineData };

// System prompt: turn an assembled transcript into minutes + tasks.
//
// The owner's real name is interpolated rather than generalized away. Naming the
// person explicitly — and listing the nicknames they are actually called by — is
// what keeps a small model from guessing whose tasks are whose.
const analysisSystem = (owner: OwnerIdentity | null) => `
        Eres un secretario ejecutivo de inteligencia artificial de élite${owner ? `, asignado para asistir a ${owner.name}` : ''}.
        Transformas la TRANSCRIPCIÓN de una reunión en registros corporativos impecables.

        REGLAS DE IDENTIFICACIÓN:
${owner ? `        1. ${owner.name.toUpperCase()}: No asumas que ${owner.firstName} lidera o inicia la reunión. Identifícalo por referencias en el texto (${owner.references}), si se presenta, o si se le asignan tareas.
        2. OTROS PARTICIPANTES: Identifícalos por el nombre que aparece en la transcripción. RESPETA los nombres ya presentes.
        3. CORRECCIÓN CONTEXTUAL: Corrige errores fonéticos o tipográficos según el contexto técnico de la conversación.`
        : `        1. PARTICIPANTES: Identifícalos por el nombre que aparece en la transcripción. RESPETA los nombres ya presentes.
        2. CORRECCIÓN CONTEXTUAL: Corrige errores fonéticos o tipográficos según el contexto técnico de la conversación.`}

        REGLAS DE ANÁLISIS:
        1. MINUTA ESTRUCTURADA: Extrae acuerdos, decisiones, rechazos y puntos clave REALES.
        2. ACTA FORMAL ("full_summary_text"): Redacta un acta detallada y extensa en el idioma original. Tono institucional de alta gerencia, sin formato de email. Profundiza en argumentos y contexto estratégico.
        3. GESTOR DE TAREAS:
           - Extrae cada acción concreta.
           - TRADUCE la descripción al ESPAÑOL.
           - Marca 'is_owner: true' si la tarea es para ${owner ? owner.name : 'quien usa esta aplicación'}.
           - Sé estricto con 'is_priority': actívalo solo ante urgencia real.

        ⚠️ FORMATO OBLIGATORIO: Responde ÚNICAMENTE con JSON válido según el esquema, sin preámbulos. NO devuelvas la transcripción, solo el análisis.
`;

// Transcription prompt with strong diarization + cross-segment speaker continuity.
// The examples use the owner's own first name for the same reason the analysis
// prompt does: a concrete, real name anchors the rule better than a placeholder.
const transcriptionSystem = (knownSpeakers: string[], previousTail: string) => {
    const owner = getOwner();
    const self = owner ? owner.firstName : 'Carlos';   // one side of the "no atribuyas por mención" examples
    return `
        Estatuto: Eres un Estenógrafo Profesional de "Clean Read" (Lectura Limpia) con oído experto para DIARIZACIÓN (separación de hablantes).
        Generas una transcripción fiel, detallada y optimizada para lectura ejecutiva.

        DIARIZACIÓN (SEPARACIÓN DE HABLANTES) — PRIORIDAD MÁXIMA:
        1. Distingue a cada persona por su voz (timbre, tono, cadencia) y asigna cada intervención al hablante correcto.
        2. NOMBRES: Usa el nombre real cuando la persona se identifica, se le nombra o se le saluda ("Gracias, Ana", "${self}, ¿qué opinas?"). Si no hay nombre, usa etiquetas estables: "Hablante 1", "Hablante 2", etc.
        3. CONSISTENCIA: La MISMA voz debe llevar SIEMPRE la MISMA etiqueta/nombre dentro de este segmento.
        4. UNA ENTRADA POR INTERVENCIÓN: cada vez que cambia la voz, abre una entrada NUEVA en "segments". NUNCA metas dos hablantes distintos en la misma entrada. Es preferible dividir de más que de menos.
        5. NO ATRIBUYAS POR MENCIÓN: que alguien diga "${self}" o "gracias, Ana" significa que habla DE esa persona, no que sea esa persona. Solo el timbre de voz determina el hablante.
${knownSpeakers.length ? `
        CONTINUIDAD CON SEGMENTOS ANTERIORES:
        - Ya se identificaron estas voces: ${knownSpeakers.join(", ")}.
        - Reutiliza EXACTAMENTE esas etiquetas cuando reconozcas la misma voz.
        - ⚠️ Si NO estás seguro de que una voz sea una de las conocidas, crea una etiqueta nueva ("Hablante N"). Adjudicar por defecto al primer nombre de la lista es un ERROR GRAVE.` : ''}
${previousTail ? `
        EMPALME:
        - Este segmento solapa unos segundos con el anterior, que terminaba así:
          "${previousTail}"
        - NO repitas ese contenido: empieza justo donde termina.
        - La primera intervención que oigas puede ser la continuación de una frase ya empezada.` : ''}

        REGLAS DE EDICIÓN (VERBATIM INTELIGENTE):
        1. ELIMINA DISFLUENCIAS: muletillas (eh, em, este...), tartamudeos y falsos comienzos.
        2. LIMPIA REPETICIONES accidentales ("el el proyecto" -> "el proyecto"), salvo énfasis intencional.
        3. PRESERVA EL DETALLE: no resumas. Mantén el 100% del contenido, tecnicismos, nombres e ideas.
        4. PROHIBIDO repetir la misma palabra más de tres veces seguidas. Si un tramo es ininteligible, escribe "[inaudible]" y sigue adelante.
        5. "time" es RELATIVO a este segmento y empieza en 00:00.

        REGLA DE ORO CONTRA ALUCINACIONES:
        - Si NO escuchas voces o el audio es incomprensible, responde ÚNICAMENTE: {"segments": [{"time": "00:00", "speaker": "SYSTEM", "text": "CRITICAL_ERROR: NO_AUDIO_DATA"}]}.
        - PROHIBIDO INVENTAR diálogos de prueba de sonido, "estás en mute" o "me escuchas" si no existen en el audio real.

        ⚠️ FORMATO OBLIGATORIO: Responde ÚNICAMENTE con JSON válido según el esquema, sin preámbulos.
`;
};

// Normal Spanish speech runs ~15 chars/sec. Anything far above that means the
// model looped instead of transcribing (a real segment hit 70+).
const MAX_CHARS_PER_SECOND = 35;

// Transcribe one audio segment into absolute-timestamped turns.
const transcribeAudioSegment = async (
    ai: any,
    audioSource: { uri?: string, inlineData?: any },
    mimeType: string,
    knownSpeakers: string[],
    previousTail: string,
    offsetSec: number
): Promise<TurnSegment[]> => {
    const res = await generateStructured(
        ai,
        transcriptionSystem(knownSpeakers, previousTail),
        "Realiza la transcripción completa y verbatim de este segmento de audio, separando a los hablantes en entradas distintas.",
        buildAudioPart(audioSource, mimeType),
        transcriptionSchema,
        "TRANSCRIPTION"
    );

    const rawSegments = (res && Array.isArray(res.segments)) ? res.segments : [];
    return rawSegments
        .map((s: any) => {
            const rel = parseTimeToSeconds(String(s?.time || ''));
            return {
                startSec: (rel < 0 ? 0 : rel) + offsetSec,
                speaker: String(s?.speaker || 'Desconocido').trim() || 'Desconocido',
                text: cleanTurnText(String(s?.text || '')),
            };
        })
        .filter((t: TurnSegment) => t.text);
};

// Reject a segment that degenerated into a repetition loop, so it can be retried.
// Returns the cleaned turns, or null if the segment is unusable.
const sanitizeSegmentTurns = (turns: TurnSegment[], durationSec: number): TurnSegment[] | null => {
    const before = turns.reduce((n, t) => n + t.text.length, 0);
    if (!before) return null;

    const cleaned = turns
        .map(t => ({ ...t, text: collapseLoops(t.text).replace(/\s+/g, ' ').trim() }))
        .filter(t => t.text);
    const after = cleaned.reduce((n, t) => n + t.text.length, 0);

    const removedRatio = (before - after) / before;
    const charsPerSecond = durationSec > 0 ? before / durationSec : 0;

    if (removedRatio > 0.2 || charsPerSecond > MAX_CHARS_PER_SECOND) {
        console.warn(`[TRANSCRIPTION] Degeneración detectada: ${Math.round(charsPerSecond)} car/s, ${Math.round(removedRatio * 100)}% del texto era repetición.`);
        return null;
    }
    return cleaned;
};

// Turn an assembled transcript into { language, minutes, tasks }.
const analyzeTranscript = async (ai: any, fullTranscript: string): Promise<any> => {
    const owner = getOwner();
    return await generateStructured(
        ai,
        analysisSystem(owner),
        "A continuación la transcripción completa de la reunión. Analízala estratégicamente (minuta, decisiones y tareas).",
        { text: fullTranscript },
        buildAnalysisSchema(owner),
        "ANALYSIS"
    );
};

// Map generic speaker labels ("Hablante A") onto the real names people use in
// the conversation. OpenAI returns bare A/B/C, and Gemini falls back to
// "Hablante N" whenever nobody is addressed by name early on.
const resolveSpeakerNames = async (ai: any, turns: TurnSegment[]): Promise<TurnSegment[]> => {
    const generic = Array.from(new Set(turns.map(t => t.speaker)))
        .filter(label => /^(hablante|speaker)\b/i.test(label) || /^[A-Z]$/.test(label));
    if (!generic.length) return turns;

    // Give the model a representative sample per label instead of the whole
    // transcript — introductions and greetings are what carry the evidence.
    const samples = generic.map(label => {
        const excerpt = turns
            .filter(t => t.speaker === label)
            .slice(0, 12)
            .map(t => t.text)
            .join(' ')
            .slice(0, 1200);
        return `### ${label}\n${excerpt}`;
    }).join('\n\n');

    const context = turns.slice(0, 40).map(t => `${t.speaker}: ${t.text}`).join('\n').slice(0, 6000);

    try {
        const res = await generateStructured(
            ai,
            `Eres un analista de reuniones. Recibes una transcripción ya diarizada donde algunos hablantes tienen etiquetas genéricas.
        Tu tarea: deducir el NOMBRE REAL de cada etiqueta genérica a partir de la conversación.

        EVIDENCIA VÁLIDA (y solo esta):
        - La persona se presenta ("mi nombre es Perla Soto", "soy Ana María").
        - Otro participante le habla directamente por su nombre y esa persona responde a continuación.
        - Se le cede la palabra por nombre ("adelante, Esteban") y esa persona empieza a hablar.

        ⚠️ REGLA CRÍTICA: si no hay evidencia CLARA, devuelve name = "" (cadena vacía). Mantener "Hablante B" es CORRECTO; inventar un nombre es un ERROR GRAVE.
        Que alguien sea mencionado en la reunión NO significa que sea uno de los hablantes.
        Nunca asignes el mismo nombre a dos etiquetas distintas.

        ⚠️ Responde ÚNICAMENTE con JSON válido según el esquema.`,
            "Deduce el nombre real de cada etiqueta genérica. Si no hay evidencia clara, devuelve cadena vacía.",
            { text: `Etiquetas genéricas a resolver: ${generic.join(", ")}\n\nINICIO DE LA REUNIÓN (donde suelen estar las presentaciones):\n${context}\n\nMUESTRAS POR ETIQUETA:\n${samples}` },
            speakerNamesSchema,
            "SPEAKER_NAMES"
        );

        const taken = new Set(turns.map(t => t.speaker).filter(s => !generic.includes(s)));
        const map: Record<string, string> = {};
        (res?.mappings || []).forEach((m: any) => {
            const label = String(m?.label || '').trim();
            const name = String(m?.name || '').trim();
            if (!label || !name || !generic.includes(label) || taken.has(name)) return;
            map[label] = name;
            taken.add(name);
        });

        if (!Object.keys(map).length) return turns;
        console.log('[SPEAKER_NAMES] Etiquetas resueltas:', map);
        return turns.map(t => (map[t.speaker] ? { ...t, speaker: map[t.speaker] } : t));
    } catch (err) {
        // Never let a cosmetic pass sink a finished transcription.
        console.warn('[SPEAKER_NAMES] No se pudieron resolver los nombres, se mantienen las etiquetas:', err);
        return turns;
    }
};

// Entry point for the "Cargar Transcripción" (text file) flow.
const processTextWithGemini = async (rawText: string): Promise<MeetingData> => {
    const ai = new GenAI({ apiKey: getGeminiKey() });
    // Normalize pasted transcripts too, so they get one turn per line like the rest.
    const turns = parseTranscriptTurns(rawText);
    const normalized = turns.length ? serializeTranscript(turns) : rawText;
    const analysis = await analyzeTranscript(ai, normalized);

    return {
        ...analysis,
        transcript_raw: normalized
    } as MeetingData;
};

// ==========================================
// 4. OPENAI TRANSCRIPTION SERVICE
// ==========================================
// Called straight from the browser, same pattern as the Gemini key.

const getOpenAIKey = (): string => {
    const key = getConfig().openaiApiKey;
    if (!key) {
        throw new Error("Falta la API Key de OpenAI. Añádela en Configuración, o transcribe con Gemini.");
    }
    return key;
};

// Transcribe one blob with either OpenAI model.
//
// gpt-transcribe returns plain text only — no speakers, and no timestamps either
// (verbose_json is rejected: "not compatible ... Use 'json' or 'text'"). A whole
// segment therefore becomes ONE turn stamped at the segment's own start. Nothing
// here may invent a speaker or a finer timestamp than the API actually gave.
//
// gpt-4o-transcribe-diarize returns segments[] with speaker/start/end. Its labels
// are per REQUEST, so `references` carries voice samples forward to keep them
// stable across chunks.

// known_speaker_references[] is typed as an array of STRINGS: each voice sample
// travels as a data URI, not as a file part. Appending the Blob directly made the
// API reject the whole request with "Input should be a valid string".
const blobToDataURL = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
});

const transcribeWithOpenAI = async (
    provider: string,
    blob: Blob,
    offsetSec: number,
    onProgress: (pct: number) => void,
    references: { name: string, clip: Blob }[] = []
): Promise<TurnSegment[]> => {
    const apiKey = getOpenAIKey();
    const spec = PROVIDERS[provider];
    const diarizing = spec.diarizes;

    // An untouched upload must keep its own name so OpenAI reads the right
    // container; re-encoded chunks really are WAV.
    const original = (blob as File).name;
    const filename = OPENAI_SUPPORTED_EXT.test(original || '') ? original : 'segment.wav';

    const form = new FormData();
    form.append('file', blob, filename);
    form.append('model', spec.model);
    form.append('response_format', diarizing ? 'diarized_json' : 'json');
    if (diarizing) {
        // Required for audio over 30 s on the diarize model. Deliberately NOT
        // sent to gpt-transcribe: it needs no windowing, and passing it measured
        // ~40% slower (22.6 s vs 16.1 s on the same 10-minute segment).
        form.append('chunking_strategy', 'auto');
        for (const ref of references.slice(0, OPENAI_MAX_REFERENCES)) {
            form.append('known_speaker_names[]', ref.name);
            form.append('known_speaker_references[]', await blobToDataURL(ref.clip));
        }
    }

    const body: any = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://api.openai.com/v1/audio/transcriptions');
        xhr.setRequestHeader('Authorization', `Bearer ${apiKey}`);
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
            try {
                const parsed = JSON.parse(xhr.responseText);
                if (xhr.status >= 200 && xhr.status < 300) return resolve(parsed);
                reject(new Error(parsed?.error?.message || `OpenAI respondió ${xhr.status}.`));
            } catch {
                reject(new Error(`OpenAI respondió ${xhr.status}: ${xhr.responseText.slice(0, 200)}`));
            }
        };
        // A browser-blocked (CORS) request surfaces here as an opaque network error.
        xhr.onerror = () => reject(new Error(
            "No se pudo contactar con api.openai.com. Si la API Key es correcta, lo más probable es que el navegador " +
            "esté bloqueando la petición por CORS; en ese caso hay que enrutar la llamada por server.pyw."
        ));
        xhr.send(form);
    });

    if (!diarizing) {
        const text = cleanTurnText(String(body?.text || ''));
        return text ? [{ startSec: offsetSec, speaker: OPENAI_UNKNOWN_SPEAKER, text }] : [];
    }

    const segments = Array.isArray(body?.segments) ? body.segments : [];
    if (!segments.length && body?.text) {
        // Shouldn't happen with diarized_json, but never throw away a transcript.
        return [{ startSec: offsetSec, speaker: OPENAI_UNKNOWN_SPEAKER, text: cleanTurnText(String(body.text)) }];
    }

    return segments
        .map((s: any) => {
            // Unrecognized voices come back as bare letters ("A"); voices matched
            // against a reference come back with the name we supplied, already
            // in final form.
            const raw = String(s?.speaker || '?').trim();
            return {
                startSec: Math.round(Number(s?.start) || 0) + offsetSec,
                speaker: /^[A-Za-z]$/.test(raw) ? `Hablante ${raw.toUpperCase()}` : raw,
                text: cleanTurnText(String(s?.text || '')),
            };
        })
        .filter((t: TurnSegment) => t.text);
};

// Wrap already-encoded 16-bit mono PCM in a WAV container.
const wrapPCM16 = (pcm: ArrayBuffer, sampleRate: number): Blob => {
    const buffer = new ArrayBuffer(44 + pcm.byteLength);
    const view = new DataView(buffer);
    const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + pcm.byteLength, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);           // PCM
    view.setUint16(22, 1, true);           // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, pcm.byteLength, true);
    new Uint8Array(buffer, 44).set(new Uint8Array(pcm));
    return new Blob([buffer], { type: 'audio/wav' });
};

// OpenAI labels speakers per REQUEST, so segment 2's "A" is not segment 1's "A".
// Build short voice references from the first segment and pass them along, which
// is exactly what known_speaker_names/known_speaker_references are for. Without
// this, splitting a recording would silently scramble who said what.
const OPENAI_MAX_REFERENCES = 4;   // API limit
const REFERENCE_CLIP_SECONDS = 6;  // must land in the API's 2-10 s window

const buildSpeakerReferences = async (
    chunkWav: Blob,
    turns: TurnSegment[],
    audioStartSec: number
): Promise<{ name: string, clip: Blob }[]> => {
    const HEADER_BYTES = 44;
    const bytesPerSecond = TARGET_SAMPLE_RATE * 2;

    // Rank speakers by how much they talk, then take each one's longest turn.
    const bySpeaker = new Map<string, { chars: number, best: TurnSegment, span: number }>();
    turns.forEach((t, i) => {
        const span = (turns[i + 1] ? turns[i + 1].startSec : t.startSec + REFERENCE_CLIP_SECONDS) - t.startSec;
        const entry = bySpeaker.get(t.speaker);
        if (!entry) bySpeaker.set(t.speaker, { chars: t.text.length, best: t, span });
        else {
            entry.chars += t.text.length;
            if (span > entry.span) { entry.best = t; entry.span = span; }
        }
    });

    const ranked = Array.from(bySpeaker.entries())
        .sort((a, b) => b[1].chars - a[1].chars)
        .slice(0, OPENAI_MAX_REFERENCES);

    const references: { name: string, clip: Blob }[] = [];
    for (const [name, info] of ranked) {
        // Skip half a second of lead-in so the clip is not clipped mid-consonant.
        const fromSec = Math.max(0, info.best.startSec - audioStartSec + 0.5);
        const takeSec = Math.min(REFERENCE_CLIP_SECONDS, Math.max(2, info.span - 0.5));
        const from = HEADER_BYTES + Math.floor(fromSec) * bytesPerSecond;
        const to = Math.min(chunkWav.size, from + Math.ceil(takeSec) * bytesPerSecond);
        if (to - from < 2 * bytesPerSecond) continue; // under 2 s, the API rejects it
        references.push({ name, clip: wrapPCM16(await chunkWav.slice(from, to).arrayBuffer(), TARGET_SAMPLE_RATE) });
    }
    return references;
};

// ==========================================
// 5. COMPONENTS
// ==========================================

// --- InputPanel ---
interface InputPanelProps {
    onProcessingStart: (msg: string) => void;
    onProcessingComplete: (data: any) => void;
    onError: (msg: string) => void;
}

const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const base64String = reader.result as string;
            const base64 = base64String.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
};

// Encode one sample range of a decoded buffer as a 16-bit mono PCM WAV, averaging
// the channels on the fly. Doing the downmix here rather than up front avoids
// materializing a second full-length copy of the recording, which matters a lot
// for a 90-minute meeting.
const encodeWAVRange = (channels: Float32Array[], from: number, to: number, sampleRate: number): Blob => {
    const count = Math.max(0, to - from);
    const bytes = count * 2;
    const buffer = new ArrayBuffer(44 + bytes);
    const view = new DataView(buffer);
    const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + bytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);          // PCM
    view.setUint16(22, 1, true);          // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, bytes, true);

    const nch = channels.length;
    let off = 44;
    for (let i = from; i < to; i++) {
        let sum = 0;
        for (let c = 0; c < nch; c++) sum += channels[c][i];
        const s = Math.max(-1, Math.min(1, sum / nch));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        off += 2;
    }
    return new Blob([view], { type: 'audio/wav' });
};

// Decode any browser-supported audio/video, downmix to mono + resample to 16 kHz,
// and split into fixed-length WAV segments. Throws if the browser can't decode
// the container/codec (caller then falls back to uploading the raw file whole).
interface AudioChunk {
    blob: Blob;
    audioStartSec: number;    // where this blob's audio begins in the full recording
    contentStartSec: number;  // where its *new* content begins (audioStartSec + overlap)
    durationSec: number;
    mimeType: string;
}

const decodeAndChunk = async (
    blob: Blob,
    chunkSeconds: number
): Promise<{ chunks: AudioChunk[], duration: number }> => {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;

    // Decode STRAIGHT to the target rate. decodeAudioData resamples to the
    // context's sampleRate, so asking for 16 kHz up front avoids materializing a
    // full 48 kHz stereo buffer first — for a 90-minute meeting that alone was
    // over 2 GB of PCM, which is what made decoding fail on long recordings.
    let ctx: any;
    try {
        ctx = new AC({ sampleRate: TARGET_SAMPLE_RATE });
    } catch {
        ctx = new AC(); // older engines ignore/reject the option
    }

    let decoded: AudioBuffer;
    try {
        decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    } finally {
        try { ctx.close(); } catch { /* ignore */ }
    }

    const duration = decoded.duration;
    let source: AudioBuffer = decoded;
    if (decoded.sampleRate !== TARGET_SAMPLE_RATE) {
        // The engine ignored the requested rate; fall back to resampling offline.
        const offline = new OfflineAudioContext(1, Math.ceil(duration * TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);
        const src = offline.createBufferSource();
        src.buffer = decoded;
        src.connect(offline.destination);
        src.start();
        source = await offline.startRendering();
    }

    const channels: Float32Array[] = [];
    for (let c = 0; c < source.numberOfChannels; c++) channels.push(source.getChannelData(c));
    const totalSamples = source.length;

    const samplesPerChunk = chunkSeconds * TARGET_SAMPLE_RATE;
    // Overlap the cut so the model hears the run-up to its own first words.
    // Without it, every segment opened mid-sentence and the speaker was guessed.
    const overlapSamples = Math.min(CHUNK_OVERLAP_SECONDS * TARGET_SAMPLE_RATE, Math.floor(samplesPerChunk / 4));
    const chunks: AudioChunk[] = [];

    for (let start = 0; start < totalSamples; start += samplesPerChunk) {
        const from = start === 0 ? 0 : start - overlapSamples;
        const to = Math.min(start + samplesPerChunk, totalSamples);
        chunks.push({
            blob: encodeWAVRange(channels, from, to, TARGET_SAMPLE_RATE),
            // Where this blob's audio actually begins — model timestamps are relative to it.
            audioStartSec: Math.round(from / TARGET_SAMPLE_RATE),
            // Where this segment's *new* content begins; anything earlier is overlap.
            contentStartSec: Math.round(start / TARGET_SAMPLE_RATE),
            durationSec: (to - from) / TARGET_SAMPLE_RATE,
            mimeType: 'audio/wav',
        });
    }
    return { chunks, duration };
};

// Drop leading turns that land in the previous segment's territory, in case the
// model transcribed the overlap anyway despite being told to skip it. If every
// turn looks early the model's clock is simply off, so keep them all rather than
// throw away real content.
const dropOverlapTurns = (turns: TurnSegment[], contentStartSec: number): TurnSegment[] => {
    let i = 0;
    while (i < turns.length && turns[i].startSec < contentStartSec - 3) i++;
    return i >= turns.length ? turns : turns.slice(i);
};

// Speaker labels seen so far, carried into the next segment to keep diarization
// consistent. Timestamps no longer need shifting here: turns come back with
// absolute seconds already applied.
const collectSpeakers = (turns: TurnSegment[], into: string[]): void => {
    turns.forEach(t => {
        if (t.speaker && t.speaker !== 'Desconocido' && !into.includes(t.speaker)) into.push(t.speaker);
    });
};

// Last couple of turns, handed to the next segment so it knows where to resume.
const tailContext = (turns: TurnSegment[]): string =>
    turns.slice(-2).map(t => `${t.speaker}: ${t.text}`).join(' ').slice(-500);

// Safety rail against runaway cost on an accidental upload. Duration-based
// chunking handles long recordings fine — a 3-hour meeting is just 18 segments —
// so this is about intent, not capability.
const LIMIT_SECONDS = 180 * 60; // 3 hours

const InputPanel: React.FC<InputPanelProps> = ({ onProcessingStart, onProcessingComplete, onError }) => {
    // The provider modal sits between picking a file and uploading it, so the
    // choice is always made *before* any paid API call happens.
    const [pendingFile, setPendingFile] = React.useState<File | null>(null);
    const [provider, setProvider] = React.useState<string>(() => {
        try { return localStorage.getItem(STORAGE_KEY_PROVIDER) || PROVIDER_GEMINI; } catch { return PROVIDER_GEMINI; }
    });

    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow re-picking the same file after a cancel
        if (file) setPendingFile(file);
    };

    const startTranscription = (chosen: string) => {
        const file = pendingFile;
        setPendingFile(null);
        if (!file) return;
        try { localStorage.setItem(STORAGE_KEY_PROVIDER, chosen); } catch { /* ignore */ }
        setProvider(chosen);
        handleAudioData(file, file.type, chosen);
    };

    // Split the recording into segments by DURATION — identically for every
    // provider. 10-minute chunks keep Gemini under its output token limit and,
    // at ~19 MB each, also stay under OpenAI's 25 MB upload cap, so there is no
    // reason to branch on provider or on file size here.
    const prepareSegments = async (blob: Blob, mimeType: string, chosen: string): Promise<AudioChunk[] | null> => {
        onProcessingStart("Decodificando y segmentando el audio…");
        try {
            const { chunks, duration } = await decodeAndChunk(blob, CHUNK_SECONDS);
            console.log(`Audio duration: ${Math.round(duration)}s -> ${chunks.length} segment(s)`);
            if (duration > LIMIT_SECONDS) {
                alert(`El audio dura ${Math.round(duration / 60)} minutos y el límite es de ${Math.round(LIMIT_SECONDS / 60)}. Recorta el archivo antes de procesarlo.`);
                return null;
            }
            return chunks;
        } catch (decodeErr) {
            // Last resort: the browser could not decode the container at all, so
            // upload it untouched. Gemini's File API takes it; OpenAI will only
            // accept it under 25 MB.
            console.warn("No se pudo decodificar el audio en el navegador; se subirá el archivo completo:", decodeErr);
            if (isOpenAI(chosen) && blob.size > OPENAI_MAX_UPLOAD_BYTES) {
                throw new Error(
                    `El navegador no pudo decodificar este archivo para segmentarlo, y sin segmentar pesa ` +
                    `${(blob.size / 1024 / 1024).toFixed(0)} MB, por encima del límite de 25 MB de OpenAI. ` +
                    `Conviértelo a MP3 o WAV, o usa Gemini.`
                );
            }
            return [{ blob, audioStartSec: 0, contentStartSec: 0, durationSec: 0, mimeType }];
        }
    };

    const handleAudioData = async (blob: Blob, mimeType: string, chosen: string) => {
        try {
            const apiKey = getGeminiKey();
            const ai = new GenAI({ apiKey });
            const displayName = (PROVIDERS[chosen] || PROVIDERS[PROVIDER_GEMINI]).label;

            // 1. Decide how (and whether) to split.
            const segments = await prepareSegments(blob, mimeType, chosen);
            if (!segments) { onProcessingComplete(null); return; }

            // Upload one segment to Gemini (File API, with small base64 fallback).
            const uploadSegment = async (segBlob: Blob, segMime: string, label: string): Promise<{ uri?: string, inlineData?: any }> => {
                const uri = await uploadAudioToGemini(segBlob, segMime, apiKey, (pct) => {
                    onProcessingStart(`${label} · Subiendo ${pct}%`);
                });
                if (uri) return { uri };
                const mb = segBlob.size / (1024 * 1024);
                if (mb > 18) throw new Error("Falló la subida de un segmento de audio. Verifica tu conexión o tu API Key.");
                const base64 = await blobToBase64(segBlob);
                return { inlineData: { mimeType: segMime, data: base64 } };
            };

            // 2. Transcribe each segment, threading speakers and the tail of the
            //    previous segment forward so diarization survives the cuts.
            const knownSpeakers: string[] = [];
            let openAIReferences: { name: string, clip: Blob }[] = [];
            let allTurns: TurnSegment[] = [];

            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                const label = segments.length > 1 ? `Segmento ${i + 1}/${segments.length}` : 'Audio';
                let turns: TurnSegment[];

                if (isOpenAI(chosen)) {
                    onProcessingStart(`${label} · Subiendo a OpenAI`);
                    turns = await transcribeWithOpenAI(chosen, seg.blob, seg.audioStartSec, (pct) => {
                        onProcessingStart(pct < 100 ? `${label} · Subiendo ${pct}%` : `${label} · Transcribiendo (${displayName})`);
                    }, openAIReferences);

                    // Diarize model only: capture voice references from the first
                    // segment that yields any, so later segments reuse the same
                    // speaker labels. gpt-transcribe has no speakers to carry.
                    if (PROVIDERS[chosen].diarizes && !openAIReferences.length && turns.length && segments.length > 1) {
                        try {
                            openAIReferences = await buildSpeakerReferences(seg.blob, turns, seg.audioStartSec);
                            console.log('[OPENAI] Referencias de voz:', openAIReferences.map(r => r.name));
                        } catch (refErr) {
                            console.warn('[OPENAI] No se pudieron construir referencias de voz:', refErr);
                        }
                    }
                } else {
                    onProcessingStart(`${label} · Preparando`);
                    const source = await uploadSegment(seg.blob, seg.mimeType, label);
                    onProcessingStart(`${label} · Transcribiendo (${displayName})`);

                    const runSegment = () => transcribeAudioSegment(
                        ai, source, seg.mimeType, knownSpeakers, tailContext(allTurns), seg.audioStartSec
                    );

                    // Retry once if the model fell into a repetition loop: a single
                    // degenerate segment used to poison both the transcript and the
                    // minutes generated from it.
                    turns = await runSegment();
                    let sane = sanitizeSegmentTurns(turns, seg.durationSec);
                    if (!sane) {
                        onProcessingStart(`${label} · Reintentando (respuesta degenerada)`);
                        turns = await runSegment();
                        sane = sanitizeSegmentTurns(turns, seg.durationSec);
                    }
                    turns = sane || turns.map(t => ({ ...t, text: collapseLoops(t.text) })).filter(t => t.text);
                }

                if (i > 0) turns = dropOverlapTurns(turns, seg.contentStartSec);
                allTurns = allTurns.concat(turns);
                collectSpeakers(turns, knownSpeakers);

                if (i < segments.length - 1) await new Promise(r => setTimeout(r, 1200));
            }

            if (!allTurns.length) {
                throw new Error("No se obtuvo transcripción del audio.");
            }

            // 3. Put real names on generic labels where the audio justifies it.
            onProcessingStart("Identificando hablantes…");
            allTurns = await resolveSpeakerNames(ai, allTurns);

            // 4. Serialize once — one turn per line — then analyze.
            const fullTranscript = serializeTranscript(allTurns);
            onProcessingStart(`Generando minuta y tareas (${MODEL_DISPLAY_NAME})`);
            const analysis = await analyzeTranscript(ai, fullTranscript);

            const fullData: MeetingData = {
                ...analysis,
                transcript_raw: fullTranscript
            };
            onProcessingComplete(fullData);
        } catch (err) {
            console.error(err);
            onProcessingComplete(null);
            onError("No se pudo procesar el audio: " + (err as Error).message);
        }
    };

    const handleTextFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (ev) => {
            try {
                const content = ev.target?.result as string;
                onProcessingStart(`Procesando transcripción (${MODEL_DISPLAY_NAME})…`);
                const data = await processTextWithGemini(content);
                onProcessingComplete(data);
            } catch (err) {
                console.error(err);
                onProcessingComplete(null);
                onError("No se pudo procesar la transcripción: " + (err as Error).message);
            }
        };
        reader.readAsText(file);
    };

    return (
        <>
            <div className="flex items-center gap-2 bg-slate-900 shadow-inner p-1 rounded-xl border border-white/10">
                <label className="flex items-center gap-2 px-4 py-2 hover:bg-slate-800 text-slate-300 rounded-lg cursor-pointer transition-all text-xs font-bold tracking-widest uppercase">
                    <Upload size={14} className="text-executive-emerald" />
                    <span>Cargar Audio</span>
                    <input
                        type="file"
                        accept="audio/*,video/*"
                        className="hidden"
                        onChange={handleFileUpload}
                    />
                </label>

                <div className="h-4 w-px bg-slate-800"></div>

                <label className="flex items-center gap-2 px-4 py-2 hover:bg-slate-800 text-slate-300 rounded-lg cursor-pointer transition-all text-xs font-bold tracking-widest uppercase">
                    <FileText size={14} className="text-executive-emerald" />
                    <span>Cargar Transcripción</span>
                    <input
                        type="file"
                        accept=".txt,.md"
                        className="hidden"
                        onChange={handleTextFileUpload}
                    />
                </label>
            </div>

            {pendingFile && (
                <ModelPickerModal
                    file={pendingFile}
                    initialProvider={provider}
                    onCancel={() => setPendingFile(null)}
                    onConfirm={startTranscription}
                />
            )}
        </>
    );
};

// --- ModelPickerModal ---
// Shown after picking a file and before anything is uploaded, so a paid run is
// never started by accident.
const ModelPickerModal: React.FC<{
    file: File;
    initialProvider: string;
    onCancel: () => void;
    onConfirm: (provider: string) => void;
}> = ({ file, initialProvider, onCancel, onConfirm }) => {
    // Without an OpenAI key those two providers cannot run at all. Showing them
    // disabled here beats letting the user pick one and only finding out after
    // the file has already been decoded and uploaded.
    const hasOpenAIKey = Boolean(getConfig().openaiApiKey);
    const canUse = (id: string) => !isOpenAI(id) || hasOpenAIKey;

    const [choice, setChoice] = React.useState(() => canUse(initialProvider) ? initialProvider : PROVIDER_GEMINI);
    const [durationSec, setDurationSec] = React.useState<number | null>(null);
    const sizeMB = file.size / (1024 * 1024);

    // Read the real duration off the media element's metadata. This only parses
    // the header — no decoding — so it stays cheap even for a 90-minute file,
    // and it prices a paid run far more honestly than guessing from file size.
    React.useEffect(() => {
        const url = URL.createObjectURL(file);
        const probe = document.createElement('audio');
        probe.preload = 'metadata';
        probe.onloadedmetadata = () => {
            if (isFinite(probe.duration) && probe.duration > 0) setDurationSec(probe.duration);
            URL.revokeObjectURL(url);
        };
        probe.onerror = () => URL.revokeObjectURL(url);
        probe.src = url;
        return () => URL.revokeObjectURL(url);
    }, [file]);

    // Fall back to ~1 MB/min until (or unless) the metadata probe answers.
    const estimatedMinutes = durationSec ? durationSec / 60 : Math.max(1, sizeMB);
    const segmentCount = durationSec ? Math.max(1, Math.ceil(durationSec / CHUNK_SECONDS)) : null;

    const fmtDuration = (mins: number) => mins < 1
        ? `${Math.max(1, Math.round(mins * 60))} s`
        : `${Math.round(mins)} min`;

    const options = [PROVIDER_GEMINI, PROVIDER_OPENAI_FAST, PROVIDER_OPENAI_DIARIZE].map(id => {
        const spec = PROVIDERS[id];
        const free = spec.costPerMinute === 0;
        // Processing plus the upload of the re-encoded chunks, which is the same
        // for every provider and is a real part of the wait.
        const etaMinutes = estimatedMinutes * (spec.realTimeFactor + UPLOAD_TIME_FACTOR);
        return {
            id,
            title: spec.label,
            badge: free ? 'Incluido' : 'De pago',
            badgeClass: free
                ? 'bg-executive-emerald/15 text-executive-emerald'
                : 'bg-amber-500/15 text-amber-400',
            diarizes: spec.diarizes,
            note: canUse(id) ? spec.note : 'Requiere una API Key de OpenAI en Configuración.',
            available: canUse(id),
            eta: `~${fmtDuration(etaMinutes)}`,
            cost: free ? 'Sin costo' : `~$${(estimatedMinutes * spec.costPerMinute).toFixed(2)}`,
        };
    });

    const fileLine = segmentCount
        ? `${sizeMB.toFixed(1)} MB · ${Math.round(estimatedMinutes)} min → ${segmentCount} segmento${segmentCount > 1 ? 's' : ''} de 10 min`
        : `${sizeMB.toFixed(1)} MB · se divide en segmentos de 10 min`;

    // Rendered through a portal on purpose. InputPanel lives inside the sticky
    // <header>, which carries `backdrop-blur-xl`; a non-none backdrop-filter makes
    // that header the containing block for `position: fixed` descendants, so
    // `inset-0` would resolve to the header strip instead of the viewport and the
    // dialog would sit clipped against the top of the page.
    return createPortal(
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto"
            onClick={onCancel}
        >
            <div
                className="w-full max-w-4xl my-auto bg-executive-slate border border-white/10 rounded-2xl shadow-2xl p-6 animate-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center gap-3 mb-1">
                    <Cpu size={18} className="text-executive-emerald" />
                    <h2 className="text-sm font-bold tracking-widest uppercase text-white">Modelo de transcripción</h2>
                </div>
                <p className="text-xs text-slate-500 truncate" title={file.name}>{file.name}</p>
                <p className="text-[11px] text-slate-600 mb-5 font-mono">{fileLine}</p>

                <div className="grid gap-3 sm:grid-cols-3">
                    {options.map(opt => (
                        <button
                            key={opt.id}
                            onClick={() => setChoice(opt.id)}
                            disabled={!opt.available}
                            className={`text-left p-4 rounded-xl border transition-all flex flex-col ${!opt.available
                                ? 'border-white/5 bg-white/[0.01] opacity-40 cursor-not-allowed'
                                : choice === opt.id
                                    ? 'border-executive-emerald bg-executive-emerald/[0.07]'
                                    : 'border-white/10 bg-white/[0.02] hover:border-white/20'}`}
                        >
                            <div className="flex items-start justify-between gap-2 mb-3">
                                <span className="text-xs font-bold text-white leading-tight">{opt.title}</span>
                                <span className={`shrink-0 text-[9px] font-black px-2 py-0.5 rounded tracking-widest ${opt.badgeClass}`}>
                                    {opt.badge}
                                </span>
                            </div>

                            {/* Speaker separation is the whole point of the app, so it leads. */}
                            <div className={`flex items-center gap-1.5 text-[11px] font-bold mb-3 ${opt.diarizes ? 'text-executive-emerald' : 'text-amber-400'}`}>
                                {opt.diarizes ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                                <span>{opt.diarizes ? 'Separa hablantes' : 'Sin hablantes'}</span>
                            </div>
                            <p className="text-[11px] text-slate-400 leading-relaxed mb-4 flex-1">{opt.note}</p>

                            <dl className="grid grid-cols-2 gap-2 pt-3 border-t border-white/5">
                                <div>
                                    <dt className="text-[9px] uppercase tracking-widest text-slate-600 mb-0.5">Tiempo</dt>
                                    <dd className="text-xs font-mono text-slate-300">{opt.eta}</dd>
                                </div>
                                <div>
                                    <dt className="text-[9px] uppercase tracking-widest text-slate-600 mb-0.5">Costo</dt>
                                    <dd className="text-xs font-mono text-slate-300">{opt.cost}</dd>
                                </div>
                            </dl>
                        </button>
                    ))}
                </div>

                <p className="text-[10px] text-slate-600 mt-4 leading-relaxed">
                    Tiempo y costo son estimados para este archivo, a partir de mediciones reales sobre un segmento de 10 min
                    (0,027× GPT Transcribe · 0,324× Diarize) más la subida. Varían con tu conexión.
                </p>

                <div className="flex items-center justify-end gap-2 mt-4">
                    <button
                        onClick={onCancel}
                        className="px-4 py-2 text-xs font-bold tracking-widest uppercase text-slate-400 hover:text-white rounded-lg transition-all"
                    >
                        Cancelar
                    </button>
                    <button
                        onClick={() => onConfirm(choice)}
                        className="px-5 py-2 text-xs font-bold tracking-widest uppercase bg-executive-emerald text-black rounded-lg hover:brightness-110 transition-all"
                    >
                        Transcribir
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
};

// --- TranscriptView ---
const TranscriptView: React.FC<{ transcriptRaw: string, minutes: MinuteData, tasks: Task[] }> = ({ transcriptRaw, minutes, tasks }) => {
    const [copied, setCopied] = React.useState(false);
    const [searchTerm, setSearchTerm] = React.useState('');

    // Uses the shared parser, which scans for turn markers ANYWHERE in the text
    // rather than only at the start of a line. That matters for transcripts
    // produced before normalization existed: the model separated turns with a
    // space, so a line-anchored parser folded dozens of turns into whoever spoke
    // first — which is exactly why one person appeared to say everything.
    const segments = React.useMemo<TranscriptSegment[]>(
        () => parseTranscriptTurns(transcriptRaw).map(t => ({
            timestamp: fmtTime(t.startSec),
            speaker: t.speaker,
            text: t.text,
        })),
        [transcriptRaw]
    );

    // Generic labels worth renaming: "Hablante 2" (what this app emits),
    // "Speaker 2" (English transcripts) and the bare "A"/"B" OpenAI returns.
    const hasGenericSpeakers = segments.some((t: TranscriptSegment) =>
        /^(hablante|speaker|desconocido)\b/i.test(t.speaker) || /^[A-Z]$/.test(t.speaker)
    );

    // What gets copied and downloaded: rebuilt from the parsed turns, one per
    // line, so the file always matches what is on screen. Dumping `transcriptRaw`
    // straight out would re-export the un-separated blob for meetings recorded
    // before normalization existed.
    const exportedTranscript = React.useMemo(
        () => segments.map(s => `[${s.timestamp}] ${s.speaker}: ${s.text}`).join('\n'),
        [segments]
    );

    const handleRename = (oldName: string) => {
        const newName = prompt(`Renombrar "${oldName}" a: `, oldName);
        if (newName && newName !== oldName) {
            window.dispatchEvent(new CustomEvent('RENAME_SPEAKER', { detail: { oldName, newName } }));
        }
    };

    const copyFullTranscript = () => {
        navigator.clipboard.writeText(exportedTranscript);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const downloadTranscript = () => {
        const blob = new Blob([exportedTranscript], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Meeting_Mind_Transcript_${new Date().toISOString().slice(0, 10)}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // Full meeting minute (acta + tareas + transcripción) as Markdown.
    const downloadMinute = () => {
        const meeting = { language: '', transcript_raw: exportedTranscript, minutes, tasks: [] } as MeetingData;
        const md = buildMeetingMarkdown(meeting, tasks);
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `MeetingMind_Minuta_${new Date().toISOString().slice(0, 10)}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const filteredSegments = React.useMemo(() => {
        if (!searchTerm) return segments;
        return segments.filter((s: any) =>
            s.text.toLowerCase().includes(searchTerm.toLowerCase()) ||
            s.speaker.toLowerCase().includes(searchTerm.toLowerCase())
        );
    }, [segments, searchTerm]);

    return (
        <div className="flex flex-col lg:flex-row gap-10 font-sans">
            {/* Left Column: Transcription Feed */}
            <div className="flex-1 min-w-0">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8">
                    <div>
                        <h3 className="text-white font-outfit font-bold text-2xl tracking-tight mb-1">Transcripción</h3>
                        <p className="text-[10px] text-slate-500 font-mono tracking-[0.2em] opacity-70">
                            {segments.length > 0 ? `${segments.length} intervenciones` : 'Sin transcripción cargada'}
                        </p>
                    </div>

                    <div className="flex items-center gap-3">
                        <div className="relative group">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-executive-emerald transition-colors" size={14} />
                            <input
                                type="text"
                                placeholder="Buscar en la sesión..."
                                value={searchTerm}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchTerm(e.target.value)}
                                className="bg-white/5 border border-white/10 rounded-xl pl-9 pr-4 py-2 text-xs text-slate-200 outline-none focus:border-executive-emerald/50 focus:bg-white/[0.08] transition-all w-48 md:w-64"
                            />
                        </div>
                        <div className="flex gap-1.5 p-1 bg-white/5 rounded-xl border border-white/5">
                            <button onClick={copyFullTranscript} className="p-2 text-slate-400 hover:text-white hover:bg-white/5 rounded-lg transition-all" title="Copiar Todo"><Copy size={16} /></button>
                            <button onClick={downloadTranscript} className="p-2 text-slate-400 hover:text-white hover:bg-white/5 rounded-lg transition-all" title="Descargar .TXT"><Download size={16} /></button>
                            <button onClick={downloadMinute} className="p-2 text-slate-400 hover:text-executive-emerald hover:bg-white/5 rounded-lg transition-all" title="Descargar Minuta (.MD)"><FileText size={16} /></button>
                        </div>
                    </div>
                </div>

                {hasGenericSpeakers && (
                    <div className="bg-executive-emerald/5 border border-executive-emerald/20 text-indigo-200/60 px-4 py-3 rounded-2xl mb-8 flex items-center gap-3 text-xs backdrop-blur-md">
                        <Star size={14} className="text-executive-emerald animate-pulse" />
                        <span>Hay hablantes sin identificar. Haz clic en un nombre para cambiarlo.</span>
                    </div>
                )}

                <div className="pr-4 space-y-4">
                    {filteredSegments.length > 0 ? filteredSegments.map((segment: any, idx: number) => (
                        <div key={idx} className="group relative flex gap-6 p-6 rounded-3xl border border-transparent hover:border-white/5 hover:bg-white/[0.02] transition-all duration-500">
                            {/* Accent line for active speaker effect */}
                            <div className="absolute left-0 top-6 bottom-6 w-0.5 bg-executive-emerald opacity-0 group-hover:opacity-40 transition-opacity rounded-full"></div>

                            <div className="flex-shrink-0">
                                <div
                                    onClick={() => handleRename(segment.speaker)}
                                    className="w-12 h-12 rounded-2xl bg-slate-900 border border-white/10 flex items-center justify-center text-slate-500 group-hover:bg-executive-emerald group-hover:text-white group-hover:border-executive-emerald/50 transition-all duration-500 cursor-pointer shadow-2xl relative overflow-hidden"
                                >
                                    <User size={20} />
                                    <div className="absolute inset-0 bg-gradient-to-tr from-executive-emerald/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                                </div>
                            </div>

                            <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between mb-2">
                                    <span
                                        onClick={() => handleRename(segment.speaker)}
                                        className="font-bold text-slate-200 text-[15px] hover:text-executive-emerald transition-colors cursor-pointer font-outfit tracking-tighter"
                                    >
                                        {segment.speaker}
                                    </span>
                                    <span className="text-[10px] text-slate-600 font-mono bg-white/5 px-2 py-0.5 rounded-full border border-white/5">{segment.timestamp}</span>
                                </div>
                                <p className="text-slate-400 text-[15px] leading-relaxed font-sans selection:bg-executive-emerald/30">
                                    {segment.text}
                                </p>
                            </div>
                        </div>
                    )) : segments.length === 0 ? (
                        // No transcript at all is a different state from a search
                        // that matched nothing, and used to render as "no results
                        // for ''" on a freshly opened app.
                        <div className="flex flex-col items-center justify-center py-20 text-slate-600">
                            <MessageSquare size={40} className="opacity-20 mb-4" />
                            <p className="text-sm font-medium">Carga un audio o una transcripción para empezar.</p>
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-20 text-slate-600">
                            <Search size={40} className="opacity-20 mb-4" />
                            <p className="text-sm font-medium">No se encontraron resultados para "{searchTerm}"</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Right Column: Live Context Sidebar */}
            <div className="w-full lg:w-96 flex flex-col gap-6 lg:sticky lg:top-32 h-fit">
                {/* Mini Summary Card */}
                <div className="bg-executive-slate/50 backdrop-blur-xl p-6 rounded-[2rem] border border-white/10 shadow-xl flex-1 flex flex-col">
                    <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                        <FileText size={12} className="text-executive-emerald" />
                        Resumen
                    </h4>
                    <div className="text-slate-300 text-xs leading-relaxed italic selection:bg-executive-emerald/40 flex-1">
                        {minutes.full_summary_text || "Aún no hay resumen para esta reunión."}
                    </div>
                </div>

                {/* Decisions Sidebar */}
                <div className="bg-slate-900/40 backdrop-blur-md p-6 rounded-[2rem] border border-white/5 shadow-xl flex-1 flex flex-col">
                    <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                        <Gavel size={12} className="text-executive-accent" />
                        Decisiones
                    </h4>
                    <div className="space-y-4 flex-1">
                        {minutes.decisions.length > 0 ? minutes.decisions.map((d: string, i: number) => (
                            <div key={i} className="flex gap-3 group/item">
                                <span className="text-executive-accent font-mono text-[10px] mt-0.5 opacity-50 font-bold">{(i + 1).toString().padStart(2, '0')}</span>
                                <p className="text-[11px] leading-relaxed text-slate-400 group-hover/item:text-slate-200 transition-colors">
                                    {d}
                                </p>
                            </div>
                        )) : (
                            <p className="text-[11px] text-slate-600 italic">No se registraron decisiones.</p>
                        )}
                    </div>
                </div>

            </div>
        </div>
    );
};

// --- MinutesView ---
const MinutesView: React.FC<{ minutes: MinuteData }> = ({ minutes }: { minutes: MinuteData }) => {
    const [copied, setCopied] = React.useState(false);

    const copySummary = () => {
        navigator.clipboard.writeText(minutes.full_summary_text || '');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="space-y-10 pb-12 font-sans">
            {/* Executive Memo Card */}
            <div className="relative group">
                <div className="absolute -inset-0.5 bg-gradient-to-r from-executive-emerald/20 to-transparent rounded-[2.5rem] blur opacity-20 group-hover:opacity-40 transition duration-1000"></div>
                <div className="relative bg-executive-slate/50 backdrop-blur-xl p-10 rounded-[2.5rem] border border-white/5 shadow-2xl">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-10 border-b border-white/5 pb-10">
                        <div className="flex items-center gap-5">
                            <div className="p-4 bg-executive-emerald/10 rounded-2xl border border-executive-emerald/20 shadow-inner">
                                <FileText className="text-executive-emerald" size={28} />
                            </div>
                            <div>
                                <h3 className="text-2xl font-bold text-white tracking-tight font-outfit">Minuta</h3>
                                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-1 tracking-widest leading-none">
                                    <span>{new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>
                                </div>
                            </div>
                        </div>
                        <button
                            onClick={copySummary}
                            className="flex items-center gap-3 px-8 py-3 bg-executive-emerald text-white rounded-2xl text-sm font-bold shadow-xl shadow-executive-emerald/20 hover:scale-[1.02] active:scale-[0.98] transition-all duration-300"
                        >
                            {copied ? <Check size={18} className="animate-in zoom-in" /> : <Copy size={18} />}
                            {copied ? 'Copiado' : 'Copiar resumen'}
                        </button>
                    </div>

                    <div className="relative">
                        <div className="absolute -left-10 top-0 bottom-0 w-1 bg-executive-emerald/30 rounded-full"></div>
                        <div className="text-slate-300 font-sans text-[16px] leading-[1.8] whitespace-pre-wrap pl-2 italic selection:bg-executive-emerald/40">
                            {minutes.full_summary_text || "Procesa una reunión para generar el acta."}
                        </div>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Critical Decisions */}
                <div className="bg-slate-900/40 backdrop-blur-md p-8 rounded-[2rem] border border-white/5 lg:col-span-2 shadow-xl">
                    <div className="flex items-center gap-4 mb-8">
                        <div className="p-3 bg-executive-accent/10 rounded-xl border border-executive-accent/20">
                            <Gavel className="text-executive-accent" size={22} />
                        </div>
                        <div>
                            <h3 className="text-lg font-bold text-white tracking-tight font-outfit">Decisiones</h3>
                            <p className="text-[10px] text-slate-500 font-mono tracking-widest opacity-70">Acuerdos de la reunión</p>
                        </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {minutes.decisions.length > 0 ? minutes.decisions.map((d: string, i: number) => (
                            <div key={i} className="flex gap-4 p-5 bg-white/[0.02] rounded-2xl border border-white/[0.05] group hover:border-executive-accent/30 hover:bg-white/[0.04] transition-all duration-300">
                                <div className="text-executive-accent font-mono text-xs mt-0.5 font-bold opacity-30 group-hover:opacity-100 transition-opacity">{(i + 1).toString().padStart(2, '0')}</div>
                                <p className="text-slate-300 text-sm leading-relaxed font-sans">{d}</p>
                            </div>
                        )) : <p className="text-slate-600 italic text-sm py-4">No se registraron decisiones en esta reunión.</p>}
                    </div>
                </div>

                {/* Discussion Points */}
                <div className="bg-slate-900/40 backdrop-blur-md p-8 rounded-[2rem] border border-white/5 shadow-xl">
                    <div className="flex items-center gap-4 mb-8">
                        <div className="p-3 bg-executive-emerald/10 rounded-xl border border-executive-emerald/20">
                            <MessageSquare className="text-executive-emerald" size={22} />
                        </div>
                        <div>
                            <h3 className="text-lg font-bold text-white tracking-tight font-outfit">Puntos clave</h3>
                            <p className="text-[10px] text-slate-500 font-mono tracking-widest opacity-70">Temas discutidos</p>
                        </div>
                    </div>
                    <ul className="space-y-4">
                        {minutes.discussion_points.map((p: string, i: number) => (
                            <li key={i} className="flex items-start gap-3 text-slate-400 text-sm group">
                                <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-executive-emerald/40 group-hover:scale-150 group-hover:bg-executive-emerald transition-all duration-300 flex-shrink-0" />
                                <span className="group-hover:text-slate-200 transition-colors leading-relaxed">{p}</span>
                            </li>
                        ))}
                    </ul>
                </div>

                {/* Participants */}
                <div className="bg-slate-900/40 backdrop-blur-md p-8 rounded-[2rem] border border-white/5 shadow-xl">
                    <div className="flex items-center gap-4 mb-8">
                        <div className="p-3 bg-slate-800 rounded-xl border border-white/5">
                            <Users className="text-slate-400" size={22} />
                        </div>
                        <div>
                            <h3 className="text-lg font-bold text-white tracking-tight font-outfit">Participantes</h3>
                            <p className="text-[10px] text-slate-500 font-mono tracking-widest opacity-70">Asistentes detectados</p>
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-2.5">
                        {minutes.participants.map((p: string) => (
                            <span key={p} className="px-4 py-2 bg-white/5 rounded-xl text-[11px] font-bold text-slate-400 border border-white/5 hover:border-executive-emerald/20 hover:text-executive-emerald transition-all duration-300 cursor-default uppercase tracking-tight">
                                {p}
                            </span>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};

// --- TasksView ---
const TasksView: React.FC<{
    initialTasks: Task[];
    ownerName: string;
    onTaskToggle: (id: string) => void;
}> = ({ initialTasks, ownerName, onTaskToggle }) => {
    const ownerTasks = initialTasks.filter((t: Task) => t.is_owner);
    const otherTasks = initialTasks.filter((t: Task) => !t.is_owner);
    const ownerFirstName = ownerName.trim().split(/\s+/)[0];

    const exportTasks = () => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(initialTasks, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", "meeting_mind_tasks.json");
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    };

    const TaskCard: React.FC<{ task: Task }> = ({ task }) => (
        <div
            onClick={() => onTaskToggle(task.id)}
            className={`group relative p-5 rounded-2xl border transition-all duration-300 cursor-pointer select-none shadow-sm ${task.is_owner
                ? 'bg-executive-emerald/[0.03] border-executive-emerald/10 hover:border-executive-emerald/40 hover:bg-executive-emerald/[0.06]'
                : 'bg-white/[0.02] border-white/5 hover:border-white/20 hover:bg-white/[0.04]'
                } ${task.completed ? 'opacity-30 grayscale saturate-0' : 'opacity-100 hover:shadow-xl hover:shadow-indigo-500/5'} `}
        >
            <div className="flex items-start gap-4">
                <div className="mt-1">
                    {task.completed ? (
                        <CheckCircle2 size={20} className={task.is_owner ? 'text-executive-emerald' : 'text-slate-500'} />
                    ) : (
                        <div className={`w-5 h-5 rounded-full border-2 transition-all ${task.is_owner
                            ? 'border-executive-emerald/30 group-hover:border-executive-emerald group-hover:bg-executive-emerald/10'
                            : 'border-slate-700 group-hover:border-slate-500'
                            }`} />
                    )}
                </div>
                <div className="flex-1">
                    <div className="mb-3">
                        <p className={`text-[15px] font-medium transition-all font-sans leading-relaxed ${task.completed ? 'line-through text-slate-500' : 'text-slate-200 group-hover:text-white'}`}>
                            {task.description}
                        </p>
                    </div>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <span className={`text-[9px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wide flex items-center gap-1.5 ${task.is_owner ? 'bg-executive-emerald/10 text-executive-emerald border border-executive-emerald/20' : 'bg-white/5 text-slate-500 border border-white/5'
                                }`}>
                                <User size={10} />
                                {task.assignee}
                            </span>
                        </div>
                        {task.is_priority && (
                            <span className="flex items-center gap-1.5 px-2 py-0.5 bg-executive-accent/10 text-executive-accent text-[9px] font-black rounded-md border border-executive-accent/20 uppercase tracking-widest">
                                <AlertTriangle size={8} />
                                Prioridad
                            </span>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );

    return (
        <div className="space-y-12">
            <div className="space-y-6">
                <div className="flex items-center gap-3 border-b border-white/10 pb-4">
                    <span className="w-3 h-3 bg-executive-emerald rounded-full animate-pulse shadow-lg shadow-executive-emerald/5"></span>
                    <h2 className="text-xl font-bold text-white tracking-[0.2em] uppercase">
                        Tareas
                    </h2>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <button
                        onClick={() => {
                            window.dispatchEvent(new CustomEvent('OPEN_MANUAL_TASK_MODAL'));
                        }}
                        className="flex flex-col items-center justify-center gap-3 p-6 bg-executive-emerald/5 hover:bg-executive-emerald/10 text-executive-emerald rounded-2xl border border-executive-emerald/20 hover:border-executive-emerald/50 transition-all group"
                    >
                        <div className="p-3 rounded-xl bg-executive-emerald/10 group-hover:scale-110 transition-transform">
                            <Plus size={24} />
                        </div>
                        <span className="text-[10px] font-black uppercase tracking-widest">Nueva tarea</span>
                    </button>

                    <button
                        onClick={() => {
                            if (confirm("¿Deseas eliminar permanentemente todas las tareas completadas?")) {
                                window.dispatchEvent(new CustomEvent('CLEAN_TASKS'));
                            }
                        }}
                        className="flex flex-col items-center justify-center gap-3 p-6 bg-red-500/5 hover:bg-red-500/10 text-red-400 rounded-2xl border border-red-500/20 hover:border-red-500/50 transition-all group"
                    >
                        <div className="p-3 rounded-xl bg-red-500/10 group-hover:scale-110 transition-transform">
                            <Trash2 size={24} />
                        </div>
                        <span className="text-[10px] font-black uppercase tracking-widest">Limpiar completadas</span>
                    </button>

                    <label className="flex flex-col items-center justify-center gap-3 p-6 bg-slate-800/30 hover:bg-slate-800/50 text-slate-300 rounded-2xl border border-slate-700/50 hover:border-slate-500 transition-all group cursor-pointer">
                        <div className="p-3 rounded-xl bg-slate-700/30 group-hover:scale-110 transition-transform">
                            <Upload size={24} />
                        </div>
                        <span className="text-[10px] font-black uppercase tracking-widest">Importar JSON</span>
                        <input
                            type="file"
                            accept=".json"
                            className="hidden"
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                const reader = new FileReader();
                                reader.onload = (ev) => {
                                    try {
                                        const imported = JSON.parse(ev.target?.result as string);
                                        window.dispatchEvent(new CustomEvent('IMPORT_TASKS', { detail: imported }));
                                    } catch (err) {
                                        alert("No se pudo importar el archivo: no es un JSON válido.");
                                    }
                                };
                                reader.readAsText(file);
                            }}
                        />
                    </label>

                    <button
                        onClick={exportTasks}
                        className="flex flex-col items-center justify-center gap-3 p-6 bg-slate-800/30 hover:bg-slate-800/50 text-slate-300 rounded-2xl border border-slate-700/50 hover:border-slate-500 transition-all group"
                    >
                        <div className="p-3 rounded-xl bg-slate-700/30 group-hover:scale-110 transition-transform">
                            <Download size={24} />
                        </div>
                        <span className="text-[10px] font-black uppercase tracking-widest">Exportar JSON</span>
                    </button>
                </div>
            </div>

            <div className="space-y-8">
                <section>
                    <h3 className="text-xs font-black text-executive-emerald uppercase tracking-[0.3em] mb-4">
                        {ownerFirstName ? `Tareas de ${ownerFirstName}` : 'Mis tareas'}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {ownerTasks.length > 0 ? (
                            ownerTasks.map(t => <TaskCard key={t.id} task={t} />)
                        ) : (
                            <div className="col-span-2 py-8 border-2 border-dashed border-white/10 rounded-2xl flex flex-col items-center justify-center text-slate-600">
                                <p className="text-sm">Sin tareas pendientes.</p>
                            </div>
                        )}
                    </div>
                </section>

                <section>
                    <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.3em] mb-4">
                        Equipo
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {otherTasks.length > 0 ? (
                            otherTasks.map(t => <TaskCard key={t.id} task={t} />)
                        ) : (
                            <div className="col-span-2 py-8 border-2 border-dashed border-white/10 rounded-2xl flex flex-col items-center justify-center text-slate-700">
                                <p className="text-sm">No se detectaron tareas para el resto del equipo.</p>
                            </div>
                        )}
                    </div>
                </section>
            </div>
        </div>
    );
};

// ==========================================
// 6. MANUAL TASK MODAL
// ==========================================
const ManualTaskModal: React.FC<{
    isOpen: boolean,
    ownerName: string,
    onClose: () => void,
    onAdd: (task: Task) => void
}> = ({ isOpen, ownerName, onClose, onAdd }) => {
    const [description, setDescription] = useState('');
    const [assignee, setAssignee] = useState(ownerName);
    const [isPriority, setIsPriority] = useState(false);

    // The modal stays mounted between openings, so reset the default assignee
    // each time it opens — otherwise a name changed in Settings would not show
    // up here until the page is reloaded.
    React.useEffect(() => { if (isOpen) setAssignee(ownerName); }, [isOpen, ownerName]);

    if (!isOpen) return null;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!description.trim()) return;

        const finalAssignee = assignee.trim() || ownerName;
        const newTask: Task = {
            id: crypto.randomUUID(),
            description: description.trim(),
            assignee: finalAssignee,
            // Matches the configured name, its first word, or any of the aliases,
            // so "Lucho" lands in the same column as "Luis Palacios".
            is_owner: assigneeIsOwner(finalAssignee),
            is_priority: isPriority,
            completed: false
        };

        onAdd(newTask);
        setDescription('');
        setIsPriority(false);
        onClose();
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose}></div>
            <form
                onSubmit={handleSubmit}
                className="relative w-full max-w-md bg-executive-slate border border-executive-emerald/30 p-8 rounded-3xl space-y-6 shadow-2xl animate-in zoom-in-95 duration-200"
            >
                <div className="flex items-center justify-between border-b border-white/10 pb-4">
                    <h2 className="text-xl font-bold text-white tracking-wider flex items-center gap-3">
                        <Plus className="text-executive-emerald" />
                        Nueva tarea
                    </h2>
                    <button type="button" onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
                        <Trash2 size={20} />
                    </button>
                </div>

                <div className="space-y-4">
                    <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Descripción</label>
                        <textarea
                            autoFocus
                            required
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            className="w-full bg-slate-900/50 border border-slate-700 rounded-xl px-4 py-3 text-white text-sm focus:border-executive-emerald focus:ring-1 focus:ring-executive-emerald outline-none transition-all h-32 resize-none"
                            placeholder="¿Qué hay que hacer?"
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Responsable</label>
                        <input
                            type="text"
                            value={assignee}
                            onChange={(e) => setAssignee(e.target.value)}
                            className="w-full bg-slate-900/50 border border-slate-700 rounded-xl px-4 py-2 text-white text-sm focus:border-executive-emerald outline-none"
                            placeholder="Nombre del responsable"
                        />
                    </div>

                    <div className="flex items-center gap-3 py-2">
                        <div
                            onClick={() => setIsPriority(!isPriority)}
                            className={`w-5 h-5 rounded border flex items-center justify-center transition-all cursor-pointer ${isPriority ? 'bg-red-500 border-red-500' : 'border-slate-700 hover:border-slate-500'
                                }`}
                        >
                            {isPriority && <Check size={14} className="text-white" />}
                        </div>
                        <span className="text-sm text-slate-300 select-none cursor-pointer" onClick={() => setIsPriority(!isPriority)}>
                            Marcar como prioritaria
                        </span>
                    </div>
                </div>

                <div className="pt-4 flex gap-3">
                    <button
                        type="button"
                        onClick={onClose}
                        className="flex-1 py-3 text-sm font-bold text-slate-400 hover:bg-slate-800 rounded-xl transition-colors border border-transparent hover:border-slate-700"
                    >
                        Cancelar
                    </button>
                    <button
                        type="submit"
                        className="flex-1 py-3 bg-executive-emerald text-black text-sm font-black rounded-xl hover:shadow-lg shadow-executive-emerald/5 transition-all active:scale-95"
                    >
                        Crear tarea
                    </button>
                </div>
            </form>
        </div>
    );
};

// ==========================================
// 7. SETTINGS MODAL
// ==========================================
// The only place where config.json gets written. It opens by itself on a fresh
// install and from the gear icon afterwards, so nobody ever has to edit a file
// by hand to use the app.
const describeKey = (key: string): string =>
    key ? `Guardada · termina en …${key.slice(-4)}` : 'Sin configurar';

const SettingsModal: React.FC<{
    isOpen: boolean;
    isFirstRun: boolean;
    onClose: () => void;
    onSaved: (config: AppConfig) => void;
}> = ({ isOpen, isFirstRun, onClose, onSaved }) => {
    const stored = getConfig();
    const [ownerName, setOwnerName] = React.useState(stored.ownerName);
    const [aliases, setAliases] = React.useState(stored.ownerAliases.join(', '));
    const [geminiKey, setGeminiKey] = React.useState('');
    const [openaiKey, setOpenaiKey] = React.useState('');
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState('');

    // Re-read on every opening: the key fields deliberately start empty, because
    // blank means "keep the key you already have".
    React.useEffect(() => {
        if (!isOpen) return;
        const current = getConfig();
        setOwnerName(current.ownerName);
        setAliases(current.ownerAliases.join(', '));
        setGeminiKey('');
        setOpenaiKey('');
        setError('');
    }, [isOpen]);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!ownerName.trim()) { setError('Escribe tu nombre para poder separar tus tareas de las del equipo.'); return; }
        if (!geminiKey.trim() && !stored.geminiApiKey) { setError('Hace falta una API Key de Google Gemini: es la que genera la minuta y las tareas.'); return; }

        setError('');
        setSaving(true);
        try {
            const saved = await saveConfig({
                ownerName,
                ownerAliases: aliases.split(',').map(a => a.trim()).filter(Boolean),
                geminiApiKey: geminiKey,
                openaiApiKey: openaiKey,
            });
            onSaved(saved);
            onClose();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setSaving(false);
        }
    };

    const fieldClass = "w-full bg-slate-900/50 border border-slate-700 rounded-xl px-4 py-2 text-white text-sm focus:border-executive-emerald outline-none transition-all";
    const labelClass = "text-[10px] font-black text-slate-500 uppercase tracking-widest";

    return (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 overflow-y-auto">
            <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={isFirstRun ? undefined : onClose}></div>
            <form
                onSubmit={handleSubmit}
                className="relative w-full max-w-lg my-auto bg-executive-slate border border-white/10 p-8 rounded-3xl space-y-6 shadow-2xl animate-in zoom-in-95 duration-200"
            >
                <div className="border-b border-white/10 pb-4">
                    <h2 className="text-xl font-bold text-white tracking-tight font-outfit flex items-center gap-3">
                        <Settings className="text-executive-emerald" size={20} />
                        {isFirstRun ? 'Bienvenido a MeetingMind' : 'Configuración'}
                    </h2>
                    <p className="text-xs text-slate-500 mt-2 leading-relaxed">
                        {isFirstRun
                            ? 'Antes de empezar necesitamos tu nombre y tu API Key de Google Gemini. Se guardan solo en este equipo, en el archivo config.json.'
                            : 'Estos datos se guardan en config.json, junto a la app. No los compartas con nadie.'}
                    </p>
                </div>

                <div className="space-y-4">
                    <div className="space-y-2">
                        <label className={labelClass}>Tu nombre completo</label>
                        <input
                            autoFocus
                            type="text"
                            value={ownerName}
                            onChange={(e) => setOwnerName(e.target.value)}
                            className={fieldClass}
                            placeholder="Ej. Ana Torres"
                        />
                        <p className="text-[11px] text-slate-600 leading-relaxed">
                            La app usa tu nombre para separar tus tareas de las del resto del equipo.
                        </p>
                    </div>

                    <div className="space-y-2">
                        <label className={labelClass}>Otros nombres con los que te llaman</label>
                        <input
                            type="text"
                            value={aliases}
                            onChange={(e) => setAliases(e.target.value)}
                            className={fieldClass}
                            placeholder="Ej. Ani, Torres"
                        />
                        <p className="text-[11px] text-slate-600 leading-relaxed">
                            Separados por comas. Ayuda a reconocerte cuando en la reunión te llaman por un apodo o solo por el apellido.
                        </p>
                    </div>

                    <div className="space-y-2">
                        <label className={labelClass}>API Key de Google Gemini</label>
                        <input
                            type="password"
                            value={geminiKey}
                            onChange={(e) => setGeminiKey(e.target.value)}
                            className={fieldClass}
                            placeholder={stored.geminiApiKey ? 'Déjala vacía para no cambiarla' : 'Pega aquí tu API Key'}
                        />
                        <p className="text-[11px] text-slate-600 leading-relaxed">
                            {describeKey(stored.geminiApiKey)} · Se obtiene gratis en{' '}
                            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-executive-emerald hover:underline">
                                aistudio.google.com/apikey
                            </a>
                        </p>
                    </div>

                    <div className="space-y-2">
                        <label className={labelClass}>API Key de OpenAI (opcional)</label>
                        <input
                            type="password"
                            value={openaiKey}
                            onChange={(e) => setOpenaiKey(e.target.value)}
                            className={fieldClass}
                            placeholder={stored.openaiApiKey ? 'Déjala vacía para no cambiarla' : 'Solo si quieres los modelos de pago'}
                        />
                        <p className="text-[11px] text-slate-600 leading-relaxed">
                            {describeKey(stored.openaiApiKey)} · Sin ella, la transcripción se hace con Gemini, que es gratuita.
                        </p>
                    </div>
                </div>

                {error && (
                    <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/5 border border-red-500/20 rounded-xl px-4 py-3">
                        <AlertCircle size={14} className="mt-0.5 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                <div className="pt-2 flex gap-3">
                    {!isFirstRun && (
                        <button
                            type="button"
                            onClick={onClose}
                            className="flex-1 py-3 text-sm font-bold text-slate-400 hover:bg-slate-800 rounded-xl transition-colors border border-transparent hover:border-slate-700"
                        >
                            Cancelar
                        </button>
                    )}
                    <button
                        type="submit"
                        disabled={saving}
                        className="flex-1 py-3 bg-executive-emerald text-black text-sm font-black rounded-xl hover:brightness-110 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {saving ? 'Guardando…' : 'Guardar'}
                    </button>
                </div>
            </form>
        </div>
    );
};

// ==========================================
// 8. MAIN APP COMPONENT
// ==========================================
const STORAGE_KEY_TASKS = 'meeting_tasks_persistent';
const STORAGE_KEY_MEETING = 'last_meeting_data';

const EMPTY_MEETING: MeetingData = {
    language: 'es',
    transcript_raw: '',
    minutes: { decisions: [], discussion_points: [], participants: [], full_summary_text: '' },
    tasks: []
};

// Build a self-contained Markdown export of the current meeting + task list.
const buildMeetingMarkdown = (meeting: MeetingData, tasks: Task[]): string => {
    const date = new Date().toISOString().slice(0, 10);
    const m: any = meeting?.minutes || {};
    const lines: string[] = [`# Minuta de Reunión — ${date}`, ''];

    if (meeting?.language) lines.push(`*Idioma: ${meeting.language}*`, '');
    if (m.participants?.length) lines.push('## Participantes', ...m.participants.map((p: string) => `- ${p}`), '');
    if (m.full_summary_text) lines.push('## Acta', m.full_summary_text, '');
    if (m.decisions?.length) lines.push('## Decisiones', ...m.decisions.map((d: string) => `- ${d}`), '');
    if (m.discussion_points?.length) lines.push('## Puntos de Discusión', ...m.discussion_points.map((d: string) => `- ${d}`), '');

    if (tasks?.length) {
        lines.push('## Tareas');
        tasks.forEach(t => {
            const box = t.completed ? '[x]' : '[ ]';
            const pri = t.is_priority ? ' **(PRIORIDAD)**' : '';
            lines.push(`- ${box}${pri} ${t.description} — _${t.assignee || 'Sin asignar'}_`);
        });
        lines.push('');
    }

    if (meeting?.transcript_raw) lines.push('## Transcripción', '', '```', meeting.transcript_raw, '```', '');
    return lines.join('\n');
};

function App() {
    const migrateMeetingData = (data: any): MeetingData => {
        if (!data) return EMPTY_MEETING;

        // Auto-Migration for Legacy Data (Array -> String)
        if (Array.isArray(data.transcript) && !data.transcript_raw) {
            data.transcript_raw = data.transcript
                .map((t: any) => `[${t.timestamp || '00:00'}] ${t.speaker || 'Unknown'}: ${t.text || ''} `)
                .join('\n');
            delete data.transcript;
        }

        // Fallback for missing raw field
        if (!data.transcript_raw) data.transcript_raw = '';

        // Ensure sub-objects exist
        if (!data.minutes) data.minutes = EMPTY_MEETING.minutes;
        data.tasks = Array.isArray(data.tasks) ? data.tasks.map(migrateTask) : [];

        return data as MeetingData;
    };

    const [activeTab, setActiveTab] = useState<Tab>(Tab.TASKS);
    const [meetingData, setMeetingData] = useState<MeetingData>(EMPTY_MEETING);
    const [persistentTasks, setPersistentTasks] = useState<Task[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState("Procesando la reunión…");
    const [isManualTaskModalOpen, setIsManualTaskModalOpen] = useState(false);
    const [isInitialLoad, setIsInitialLoad] = useState(true);
    const [config, setConfig] = useState<AppConfig>(() => getConfig());
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);

    // A fresh copy has no owner and no Gemini key, so the settings dialog opens
    // by itself and cannot be dismissed until both are filled in.
    const needsSetup = !isConfigured(config);

    // 1. Initial Load from Backend (Priority) or LocalStorage
    useEffect(() => {
        const initData = async () => {
            try {
                const response = await fetch('/api/db');
                if (response.ok) {
                    const data = await response.json();
                    if (data.meetingData) {
                        setMeetingData(migrateMeetingData(data.meetingData));
                    }
                    if (data.persistentTasks) {
                        setPersistentTasks(Array.isArray(data.persistentTasks) ? data.persistentTasks.map(migrateTask) : []);
                    }
                }
            } catch (err) {
                console.log("Sistema Portable: Usando almacenamiento local (Backend no detectado)");
            } finally {
                setIsInitialLoad(false);
            }
        };
        initData();
    }, []);

    // 2. Persistent Saving (LocalStorage + Backend)
    useEffect(() => {
        if (isInitialLoad) return; // Don't save back during initial fetch

        const saveToBackend = async () => {
            try {
                await fetch('/api/db', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        persistentTasks,
                        meetingData,
                        lastSync: new Date().toISOString()
                    })
                });
            } catch (err) {
                // Silently fail if backend is not running
            }
        };
        saveToBackend();
    }, [persistentTasks, meetingData, isInitialLoad]);

    // Handle Import Event
    useEffect(() => {
        const handleImport = (e: any) => {
            const importedTasks = e.detail as Task[];
            if (Array.isArray(importedTasks)) {
                setPersistentTasks(prev => {
                    const existingMap = new Map(prev.map(t => [t.id, t]));
                    let count = 0;
                    importedTasks.forEach(t => {
                        if (t.id && t.description) {
                            existingMap.set(t.id, migrateTask(t));
                            count++;
                        }
                    });
                    alert(`Se importaron / actualizaron ${count} tareas correctamente.`);
                    return Array.from(existingMap.values());
                });
            }
        };
        window.addEventListener('IMPORT_TASKS', handleImport);
        return () => window.removeEventListener('IMPORT_TASKS', handleImport);
    }, []);

    // Handle Rename Speaker Event
    useEffect(() => {
        const handleRename = (e: any) => {
            const { oldName, newName } = e.detail;
            if (!oldName || !newName) return;

            // Update Meeting Data (Transcript & Minutes)
            setMeetingData(prev => {
                // Safely handle potential undefined/null
                const currentRaw = prev.transcript_raw || '';

                // Rename the speaker in the raw transcript. The timestamp bracket
                // is optional: turns parsed without one ("Name: text") must be
                // renamed too, otherwise they silently keep the old label.
                const escapedOldName = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`(^|\\]\\s*|\\n)${escapedOldName}:\\s`, 'g');
                const nextRaw = currentRaw.replace(regex, (_m, prefix) => `${prefix}${newName}: `);

                return {
                    ...prev,
                    transcript_raw: nextRaw,
                    minutes: {
                        ...prev.minutes,
                        participants: (prev.minutes.participants || []).map(p => p === oldName ? newName : p),
                    },
                    tasks: (prev.tasks || []).map(t => ({
                        ...t,
                        assignee: t.assignee === oldName ? newName : t.assignee
                    }))
                };
            });

            // Update Persistent Tasks
            setPersistentTasks(prev => prev.map(t => ({
                ...t,
                assignee: t.assignee === oldName ? newName : t.assignee
            })));
        };

        window.addEventListener('RENAME_SPEAKER', handleRename);
        return () => window.removeEventListener('RENAME_SPEAKER', handleRename);
    }, []);

    // Handle Clean Tasks Event
    useEffect(() => {
        const handleClean = () => {
            setPersistentTasks(prev => prev.filter(t => !t.completed));
            setMeetingData(prev => ({
                ...prev,
                tasks: prev.tasks.filter(t => !t.completed)
            }));
        };

        const handleOpenModal = () => setIsManualTaskModalOpen(true);

        window.addEventListener('CLEAN_TASKS', handleClean);
        window.addEventListener('OPEN_MANUAL_TASK_MODAL', handleOpenModal);
        return () => {
            window.removeEventListener('CLEAN_TASKS', handleClean);
            window.removeEventListener('OPEN_MANUAL_TASK_MODAL', handleOpenModal);
        };
    }, []);

    // Handle Window Close to gracefully shutdown the local server
    useEffect(() => {
        const handleUnload = () => {
            navigator.sendBeacon('http://127.0.0.1:3000/api/shutdown');
        };
        window.addEventListener('beforeunload', handleUnload);
        return () => window.removeEventListener('beforeunload', handleUnload);
    }, []);

    const addManualTask = (task: Task) => {
        setPersistentTasks(prev => [task, ...prev]);
        setActiveTab(Tab.TASKS);
    };

    const handleProcessingStart = (message?: string) => {
        if (message) setLoadingMessage(message);
        setIsLoading(true);
    };

    const handleProcessingComplete = (newData: MeetingData) => {
        if (!newData) return;
        setMeetingData(newData);
        setPersistentTasks(prev => {
            const existingIds = new Set(prev.map(t => t.id));
            const tasksToAdd = (newData.tasks || []).filter(t => !existingIds.has(t.id));
            return [...prev, ...tasksToAdd];
        });
        setIsLoading(false);
        setActiveTab(Tab.TASKS);
    };

    const clearDatabase = () => {
        if (confirm("Se borrarán todas las tareas y la reunión cargada. ¿Continuar?")) {
            setPersistentTasks([]);
            setMeetingData(EMPTY_MEETING);
            localStorage.removeItem(STORAGE_KEY_TASKS);
            localStorage.removeItem(STORAGE_KEY_MEETING);
        }
    };

    const toggleTaskStatus = (taskId: string) => {
        setPersistentTasks(prev => prev.map(t =>
            t.id === taskId ? { ...t, completed: !t.completed } : t
        ));
    };

    const turnOffSystem = async () => {
        if (confirm("¿Deseas cerrar MeetingMind y apagar el servidor local?")) {
            try {
                await fetch('http://127.0.0.1:3000/api/shutdown', { method: 'POST' });
            } catch (e) { /* ignore */ }
            window.close();
            // Fallback for browsers preventing window.close()
            document.body.innerHTML = "<div style='display:flex;justify-content:center;align-items:center;height:100vh;background:#020617;color:#fff;font-family:sans-serif;'><h1>MeetingMind se cerró. Ya puedes cerrar esta ventana.</h1></div>";
        }
    };

    return (
        <div className="min-h-screen pb-12 font-sans selection:bg-executive-emerald/30">
            <header className="sticky top-0 z-50 bg-executive-black/60 backdrop-blur-xl border-b border-white/5 px-6 py-4">
                <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                        <div className="flex items-center justify-center w-10 h-10 bg-executive-emerald/10 rounded-xl border border-executive-emerald/20 shadow-lg shadow-executive-emerald/20 animate-pulse">
                            <Cpu className="text-executive-emerald" size={22} />
                        </div>
                        <div>
                            <h1 className="text-xl font-bold tracking-tight text-white font-outfit flex items-center gap-2">
                                MEETING<span className="text-executive-emerald">MIND</span>
                            </h1>
                            <div className="flex items-center gap-2 text-[10px] text-slate-500 font-mono tracking-widest opacity-80">
                                <Terminal size={10} />
                                <span>{config.ownerName || 'Sin configurar'}</span>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        <InputPanel
                            onProcessingStart={handleProcessingStart}
                            onProcessingComplete={handleProcessingComplete}
                            onError={(err) => { setIsLoading(false); alert(err); }}
                        />
                        <button
                            onClick={() => setIsSettingsOpen(true)}
                            className="p-2 text-slate-500 hover:text-white transition-colors rounded-lg hover:bg-slate-800"
                            title="Configuración"
                        >
                            <Settings size={20} />
                        </button>
                        <button
                            onClick={clearDatabase}
                            className="p-2 text-slate-500 hover:text-red-400 transition-colors rounded-lg hover:bg-slate-800"
                            title="Borrar todos los datos"
                        >
                            <Trash2 size={20} />
                        </button>
                        <div className="w-px h-6 bg-white/10 mx-1"></div>
                        <button
                            onClick={turnOffSystem}
                            className="p-2 text-slate-500 hover:text-red-500 transition-colors rounded-lg hover:bg-red-500/10"
                            title="Cerrar MeetingMind"
                        >
                            <Power size={20} />
                        </button>
                    </div>
                </div>
            </header>

            <main className="max-w-7xl mx-auto px-6 mt-8">

                {isLoading ? (
                    <div className="flex flex-col items-center justify-center py-32 space-y-8">
                        <div className="relative w-32 h-32">
                            {/* Executive Spinner */}
                            <div className="absolute inset-0 border-[3px] border-white/5 rounded-full"></div>
                            <div className="absolute inset-0 border-[3px] border-t-executive-emerald rounded-full animate-spin"></div>
                            <div className="absolute inset-0 flex items-center justify-center">
                                <ShieldCheck className="text-executive-emerald/40 animate-pulse" size={40} />
                            </div>
                        </div>
                        <div className="text-center animate-in fade-in zoom-in duration-700">
                            <h2 className="text-2xl font-bold text-white tracking-tight font-outfit">{loadingMessage}</h2>
                            <p className="text-slate-500 mt-2 font-mono text-xs tracking-[0.2em]">Puede tardar varios minutos. No cierres esta ventana.</p>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="flex gap-2 p-1.5 bg-white/5 backdrop-blur-md rounded-2xl border border-white/10 mb-10 w-fit shadow-2xl">
                            {[
                                { id: Tab.TASKS, label: 'Tareas', icon: ListTodo },
                                { id: Tab.MINUTES, label: 'Minuta', icon: FileText },
                                { id: Tab.TRANSCRIPT, label: 'Transcripción', icon: MessageSquare },
                            ].map(t => (
                                <button
                                    key={t.id}
                                    onClick={() => setActiveTab(t.id as Tab)}
                                    className={`flex items-center gap-3 px-6 py-2.5 rounded-xl font-bold text-[11px] tracking-wider uppercase transition-all duration-300 ${activeTab === t.id
                                        ? 'bg-executive-emerald text-white shadow-lg shadow-executive-emerald/20 scale-[1.02]'
                                        : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                                        }`}
                                >
                                    <t.icon size={14} className={activeTab === t.id ? 'text-white' : 'text-slate-500'} />
                                    {t.label}
                                </button>
                            ))}
                        </div>

                        <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
                            {activeTab === Tab.TASKS && (
                                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                                    <div className="lg:col-span-2">
                                        <TasksView
                                            initialTasks={persistentTasks}
                                            ownerName={config.ownerName}
                                            onTaskToggle={toggleTaskStatus}
                                        />
                                    </div>
                                    <div className="space-y-6">
                                        <div className="bg-executive-slate/50 backdrop-blur-xl p-6 rounded-2xl border border-executive-emerald/30">
                                            <h3 className="text-executive-emerald font-bold text-sm mb-4 flex items-center gap-2">
                                                <ShieldCheck size={16} />
                                                Resumen
                                            </h3>
                                            <div className="space-y-4">
                                                <div className="flex justify-between items-center text-sm">
                                                    <span className="text-slate-400">Total de tareas:</span>
                                                    <span className="text-white font-mono">{persistentTasks.length}</span>
                                                </div>
                                                <div className="flex justify-between items-center text-sm">
                                                    <span className="text-slate-400">Completadas:</span>
                                                    <span className="text-emerald-400 font-mono">
                                                        {persistentTasks.filter(t => t.completed).length}
                                                    </span>
                                                </div>
                                                <div className="flex justify-between items-center text-sm">
                                                    <span className="text-slate-400">
                                                        {config.ownerName ? `Para ${config.ownerName.split(/\s+/)[0]}:` : 'Mías:'}
                                                    </span>
                                                    <span className="text-executive-emerald font-mono">
                                                        {persistentTasks.filter(t => t.is_owner).length}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="bg-executive-slate/50 backdrop-blur-xl p-6 rounded-2xl border border-white/10">
                                            <h3 className="text-slate-400 font-bold text-xs mb-3">Última reunión</h3>
                                            <div className="text-sm text-slate-300">
                                                {meetingData.minutes.participants.length > 0 ? (
                                                    <div className="flex flex-wrap gap-2">
                                                        {meetingData.minutes.participants.map(p => (
                                                            <span key={p} className="px-2 py-1 bg-slate-800 rounded text-[10px] uppercase font-bold tracking-wider">
                                                                {p}
                                                            </span>
                                                        ))}
                                                    </div>
                                                ) : (
                                                    <p className="italic text-slate-500">Aún no has procesado ninguna reunión.</p>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeTab === Tab.MINUTES && (
                                <div className="max-w-4xl">
                                    <MinutesView minutes={meetingData.minutes} />
                                </div>
                            )}

                            {activeTab === Tab.TRANSCRIPT && (
                                <div className="max-w-7xl bg-executive-slate/50 backdrop-blur-xl border border-white/10 p-8 rounded-[2.5rem] shadow-2xl">
                                    <TranscriptView
                                        transcriptRaw={meetingData.transcript_raw}
                                        minutes={meetingData.minutes}
                                        tasks={persistentTasks}
                                    />
                                </div>
                            )}
                        </div>
                    </>
                )}
            </main>

            <ManualTaskModal
                isOpen={isManualTaskModalOpen}
                ownerName={config.ownerName}
                onClose={() => setIsManualTaskModalOpen(false)}
                onAdd={addManualTask}
            />

            <SettingsModal
                isOpen={isSettingsOpen || needsSetup}
                isFirstRun={needsSetup}
                onClose={() => setIsSettingsOpen(false)}
                onSaved={setConfig}
            />
        </div>
    );
}

// ==========================================
// 9. ENTRY POINT
// ==========================================
const rootElement = document.getElementById('root');
if (!rootElement) {
    throw new Error("Could not find root element to mount to");
}

const root = createRoot(rootElement);
root.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);
