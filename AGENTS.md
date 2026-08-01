# AGENTS.md - MeetingMind Enterprise Guidelines

## Project Overview

MeetingMind Enterprise is a portable React application that transcribes and analyzes meetings using Google GenAI. The app processes audio/video files to generate detailed transcripts, meeting minutes, and task lists. It is single-user by design: one person installs it, configures their own name and API keys, and the app separates that person's tasks from the rest of the team's.

## Configuration

Everything user-specific lives in **`config.json`**, next to the app:

```json
{
    "ownerName": "Ana Torres",
    "ownerAliases": ["Ani", "Torres"],
    "geminiApiKey": "...",
    "openaiApiKey": ""
}
```

- **Never distribute `config.json`.** It holds the API keys. `config.example.json` is the empty copy that ships with the app; `index.html` contains no secrets.
- `server.pyw` serves the file as **`/config.js`** (`window.MEETINGMIND_CONFIG`), which `index.html` loads with a plain `<script>` *before* the app module. The configuration is therefore available synchronously at import time — no async boot ordering, no race.
- The settings dialog writes it back through **`POST /api/config`**. That endpoint **merges**: a field that is absent keeps its stored value. The dialog exploits this by sending a key only when the user typed one, so a blank field can never erase a key. OpenAI shows a key exactly once — treat erasing one as data loss.
- On a fresh install (`ownerName` or `geminiApiKey` empty) the dialog opens by itself and cannot be dismissed.
- Keys set the old way, straight into `index.html` as `window.GEMINI_API_KEY` / `window.OPENAI_API_KEY`, are still honored as a fallback.

### The owner's real name belongs in the prompts
`analysisSystem(owner)` and `transcriptionSystem(...)` interpolate `ownerName` and `ownerAliases` into the prompt text, and `buildAnalysisSchema(owner)` puts the name in the `is_owner` field description. This is deliberate and measured in use: with a generic placeholder instead of a real name, `gemini-3.1-flash-lite` starts guessing who is who almost immediately. **Do not "clean up" these prompts by replacing the name with a placeholder.** The aliases matter as much as the name — people get called by a nickname or by their surname in a meeting.

`getOwner()` returns `null` when nothing is configured; every prompt has a degraded branch for that case, and `is_owner` then stays false.

## Build, Lint & Test Commands

### Running the Application
```bash
# Start Python backend server (it serves the app; do not open index.html via file://)
python server.pyw

# Then browse to http://127.0.0.1:3000
# Or double-click start_meetingmind.bat on Windows, which does both
```

### Testing
- **No test framework configured** - Tests not currently implemented.
- Tests are typically handled via manual verification of audio processing and transcript generation.

## Code Style Guidelines

### Import Organization
```typescript
// 1. React core imports
import React, { useState, useEffect, useRef } from 'react';

// 2. External library imports
import { createRoot } from 'react-dom/client';
import { FileText, ListTodo, Upload, Search, etc } from 'lucide-react';
import * as GoogleAIModule from "@google/genai";

// 3. Type definitions (if any)
// Custom types are defined within the file, typically at top
```

### Naming Conventions
- **Components**: PascalCase (e.g., `TranscriptView`, `InputPanel`).
- **Props Interfaces**: PascalCase with "Props" suffix (e.g., `InputPanelProps`).
- **Type Definitions**: PascalCase (e.g., `TranscriptSegment`, `MinuteData`).
- **Variables/Functions**: camelCase (e.g., `handleFileUpload`, `audioSource`).
- **Constants**: UPPER_SNAKE_CASE (e.g., `MODEL`, `CHUNK_SECONDS`, `PROVIDERS`).
- **Enums**: UPPER_CASE (e.g., `Tab`, `ST` schema types).

### TypeScript & Types
```typescript
// Use interface for object shapes, type for unions/intersections
export interface MeetingData {
  language: string;
  transcript_raw: string;
  minutes: MinuteData;
  tasks: Task[];
}

// Generic types for React components
const MyComponent: React.FC<MyComponentProps> = ({ prop1, prop2 }) => {
  // Component logic
};
```

### Error Handling
```typescript
// Use try-catch for async operations
try {
  const result = await ai.generateContent(input);
  onProcessingComplete(result);
} catch (err) {
  console.error(err);
  onError("Error processing audio: " + (err as Error).message);
}

// Always include proper error types in error messages
// Keep user-facing error messages clear and actionable
```

### Formatting & Styling
- **Tailwind CSS** is the primary styling framework.
- Custom color palette defined in Tailwind config:
  - `executive-black`: #0a0a0c (background)
  - `executive-slate`: #121216 (surfaces)
  - `executive-emerald`: #10b981 (primary accent)
  - `executive-indigo`: #818cf8 (secondary accent)
  - `executive-silver`: #e2e8f0 (text)
- Use `bg-executive-emerald`, `text-white`, `border-white/10` patterns.
- Glassmorphism effects: `backdrop-blur-xl`, `bg-white/[0.02]`.
- Dark theme only (class="dark" on html).

### Code Structure
```typescript
// 1. Imports
// 2. Helper functions
// 3. Type definitions
// 4. Schema definitions
// 5. Main component definitions
```

### React Best Practices
- Use `React.useMemo` for expensive calculations.
- Use `React.useCallback` for event handlers passed to children.
- Use TypeScript strict mode for all code.
- Prefer function components over class components.
- Use forwardRef for components that need to expose refs.

### Python Backend
- Simple HTTP server using Python's `http.server`.
- CORS enabled for all requests.
- JSON file for database storage.
- Mobile view auto-generated on database updates.
- Port: 3000.

### Comments
- English comments preferred for code documentation.
- Spanish comments allowed for user-facing text/explanations.
- Keep comments brief and focused.

### No Build System
This is a portable app using Babel standalone - no webpack/next.js/build process.
Just edit the TypeScript files and refresh the browser.

## Common Patterns

### Transcription Providers
Three providers, declared in the `PROVIDERS` registry. The user picks one in a modal shown
*after* selecting a file and *before* anything is uploaded (`ModelPickerModal`), which also
shows the estimated time and cost for that specific file. The choice persists in
`localStorage` under `STORAGE_KEY_PROVIDER`.

| Provider | Model | Real-time factor | Cost/min | Speakers |
|---|---|---|---|---|
| `PROVIDER_GEMINI` | `gemini-3.1-flash-lite` | ~0.075x | free | yes, by prompt |
| `PROVIDER_OPENAI_FAST` | `gpt-transcribe` | **0.027x** | $0.0045 | **no** |
| `PROVIDER_OPENAI_DIARIZE` | `gpt-4o-transcribe-diarize` | **0.324x** | $0.006 | yes, native |

The two OpenAI factors are **measured**, not estimated: 16.1 s and 194.6 s respectively for the
same real 600 s meeting segment. Re-measure before changing them — the modal's time estimate
is built from these plus `UPLOAD_TIME_FACTOR`.

Both OpenAI models are called straight from the browser with the key from `config.json`. CORS was
verified working (HTTP 200 from a browser fetch), so no proxy is needed. With no OpenAI key stored,
`ModelPickerModal` renders those two options disabled rather than letting the user pick one and hit
the error after the file has already been decoded and uploaded.

Per-model quirks that are easy to get wrong:
- `gpt-transcribe` accepts **only** `response_format: json` or `text`. `verbose_json` is
  rejected outright, so there are no timestamps and no segments — a whole chunk becomes ONE
  turn labelled `OPENAI_UNKNOWN_SPEAKER`. Never relabel that as "Hablante 1": the analysis pass
  would propagate the invented speaker into the minutes.
- Do **not** send `chunking_strategy` to `gpt-transcribe`. It needs no windowing and passing it
  measured ~40% slower (22.6 s vs 16.1 s).
- `gpt-4o-transcribe-diarize` **requires** `chunking_strategy: "auto"` above 30 s. Verified to
  cover a full 10-minute segment with no truncation (116 turns, 3 speakers, last segment ending
  at 599.9 s of 600), so the ~8-9 minute truncation bug reported for the older `gpt-4o-transcribe`
  does not apply here.

**Analysis is always Gemini.** OpenAI transcription models cannot produce minutes or tasks,
so `analyzeTranscript` runs on `MODEL` regardless of which provider transcribed the audio.

There is **no model routing and no cross-model fallback**. `generateStructured` retries the
*same* model up to 3 times with linear backoff, and only on transient errors (429/5xx).

### Transcript Normalization (section 2 of the file)
All three providers funnel into one intermediate shape, `TurnSegment { startSec, speaker, text }`.
`serializeTranscript` is the **only** place allowed to build `transcript_raw`, and it emits
exactly one turn per line.

This exists because a free-form transcript string caused a severe diarization bug: the model
separated turns with a space instead of a newline, and the line-anchored parser folded every
turn on a line into whoever spoke first — 72 real turns collapsed into 9 blocks, making one
participant appear to say everything.

- `parseTranscriptTurns` scans for `[MM:SS] Name:` markers **anywhere** in the text, not just
  at line start, so old un-normalized transcripts still render correctly. `looksLikeSpeaker`
  guards against mistaking a mid-sentence colon for a speaker label.
- **Never re-anchor that regex to `^`**, and never build `transcript_raw` by concatenating
  model output directly.

### Task Ownership
`Task.is_owner` marks a task as belonging to the configured user; it drives the two columns in
`TasksView`, the counter in the sidebar, and the two sections of the mobile view.

The field used to be `is_luis_palacios`, from when the app had exactly one user. **Everything
arriving from storage must go through `migrateTask`**, which maps the old field onto the new one:
the database, the `/api/db` payload and imported task JSON all predate the rename. `server.pyw`
does the same with `t.get('is_owner', t.get('is_luis_palacios', False))`.

For tasks typed by hand, `assigneeIsOwner()` matches the assignee against the full name, its first
word and every alias, so a task assigned to "Lucho" lands in the same column as one assigned to
"Luis Palacios".

### Audio Chunking
Segmentation is **by duration and identical for every provider**. Do not reintroduce
size-based or provider-specific branching here.

- `CHUNK_SECONDS = 600` for all providers. Ten minutes keeps Gemini under its output token
  limit, and at 16 kHz mono 16-bit WAV a chunk is ~18.3 MB, comfortably under OpenAI's 25 MB
  upload cap. One rule satisfies every constraint.
- `LIMIT_SECONDS = 180 * 60` is a cost rail against an accidental upload, not a capability
  limit — a 3-hour meeting is simply 18 segments.
- `CHUNK_OVERLAP_SECONDS = 8` gives the model the run-up to its own first words. Chunks carry
  both `audioStartSec` (where the blob's audio begins; model timestamps are relative to it)
  and `contentStartSec` (where new content begins). `dropOverlapTurns` trims the re-transcribed
  overlap.

**Decoding is memory-bound, and that is why it used to fail on long recordings.**
`decodeAudioData` resamples to the AudioContext's rate, so `decodeAndChunk` builds the context
with `{ sampleRate: TARGET_SAMPLE_RATE }`. Decoding a 96-minute meeting at the hardware rate
(48 kHz stereo) needed ~2.1 GB of PCM plus a second full copy from the OfflineAudioContext
resample; asking for 16 kHz up front cuts that to ~0.7 GB, and `encodeWAVRange` downmixes per
chunk so no full-length mono copy is ever allocated. The OfflineAudioContext path remains only
as a fallback for engines that ignore the requested rate.

### OpenAI Speaker Continuity Across Chunks
Applies to `PROVIDER_OPENAI_DIARIZE` only; `gpt-transcribe` has no speakers to carry.

`diarized_json` labels speakers **per request**, so segment 2's "A" is not segment 1's "A".
`buildSpeakerReferences` cuts short WAV clips of the top speakers out of the first segment and
passes them as `known_speaker_names[]` / `known_speaker_references[]` on later segments (max 4,
2-10 s each, per the API). Recognized voices then come back with the supplied name instead of a
bare letter — which is why `transcribeWithOpenAI` only prefixes `"Hablante "` onto single
letters. Removing this would silently scramble attribution on any split recording.

### Anti-Degeneration Guard
Models occasionally fall into a repetition loop (a real run produced 37 k characters of
"eh eh eh…", 32 % of the transcript, which then poisoned the generated minutes).
`sanitizeSegmentTurns` rejects a segment exceeding `MAX_CHARS_PER_SECOND` (35; normal Spanish
speech is ~15) or losing over 20 % of its characters to `collapseLoops`, and the segment is
retried once. Keep this guard in place when touching the transcription loop.

### Audio Upload Flow
```typescript
// 1. Pick file -> ModelPickerModal (provider choice, duration + cost shown)
// 2. prepareSegments: decode + split into 10-min chunks, same for every provider
// 3. Transcribe per segment -> TurnSegment[], threading knownSpeakers + tailContext
// 4. resolveSpeakerNames: map "Hablante A" onto real names where the audio proves it
// 5. serializeTranscript -> analyzeTranscript -> render
```

### Reloading the Page Stops the Local Server
A `beforeunload` handler `sendBeacon`s `/api/shutdown`, so **any** reload or navigation shuts the
backend down, and every request after that fails until it is started again. Open a fresh tab
instead of reloading, or neutralize the beacon first:

```js
const orig = navigator.sendBeacon.bind(navigator);
navigator.sendBeacon = (u, d) => String(u).includes('/api/shutdown') ? true : orig(u, d);
```

For UI-only checks, load `VISTA_MOVIL.html` instead: same origin, static, no React app and no
auto-save.

### Serving Note
`server.pyw` is a single-threaded `HTTPServer`. Serving a large audio file blocks every other
request — a 66 MB fetch delayed an `index.html` request by 20 s during testing. Switch to
`ThreadingHTTPServer` if concurrency ever matters.

### Distributing a Copy
Ship: `index.html`, `index.css`, `MeetingMindPortable.tsx`, `server.pyw`, `LaunchMeetingMind.vbs`,
`start_meetingmind.bat`, `favicon.ico`, `config.example.json`.

Leave out — these are personal, generated, or both:

| File | Why |
|---|---|
| `config.json` | API keys and the owner's name |
| `database.json`, `database.json.bak` | real meeting transcripts and tasks |
| `VISTA_MOVIL.html` | regenerated on the first save |
| `server_errors.log`, `__pycache__/` | local runtime artifacts |

The recipient needs Python on `PATH` (the launcher falls back to a few hardcoded install paths that
are specific to the original machine) and Microsoft Edge for the app-mode window. On first launch the
settings dialog asks for their name and Gemini key, so nobody has to open a file in a text editor.

### Gemini API Integration
```typescript
// Check for SDK structure compatibility
if (typeof ai.getGenerativeModel === 'function') {
  // Standard SDK usage
} else if (ai.models && typeof ai.models.generateContent === 'function') {
  // New architecture usage
}

// Always use JSON schema for responses — prefer a structured array over a
// free-form string whenever the shape matters (see Transcript Normalization)
```

### State Management
```typescript
const [data, setData] = useState<MeetingData | null>(null);
const [processing, setProcessing] = useState(false);

// Use descriptive state names
const [searchTerm, setSearchTerm] = useState('');
const [copied, setCopied] = useState(false);
```

## No Additional Rules Files

No `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` files exist. Follow the conventions above.