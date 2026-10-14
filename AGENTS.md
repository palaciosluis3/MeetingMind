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
`analysisSystem(owner)` and `transcriptionSystem(...)` interpolate `ownerName` and `ownerAliases` into the prompt text, and `buildAnalysisSchema(owner)` puts the name in the `is_owner` field description. This is deliberate and measured in use: with a generic placeholder instead of a real name, `gemini-3.5-flash-lite` starts guessing who is who almost immediately. **Do not "clean up" these prompts by replacing the name with a placeholder.** The aliases matter as much as the name — people get called by a nickname or by their surname in a meeting.

`getOwner()` returns `null` when nothing is configured; every prompt has a degraded branch for that case, and `is_owner` then stays false.
The transcription prompt keeps the full name and aliases as **textual context**.
This does not identify the owner's voice. Gemini outputs generic request-local
labels; `speaker_matches` separately compares them with attached acoustic samples.
The existing name-resolution pass handles supported human names later.

## Build, Lint & Test Commands

### Running the Application
```bash
# Start Python backend server (it serves the app; do not open index.html via file://)
python server.pyw

# Then browse to http://127.0.0.1:3000
# Or double-click start_meetingmind.bat on Windows, which does both
```

### Testing
- Current bounded regressions: `tests/small-corrections.cjs` compiles the complete
  TSX with pinned Babel 7.23.0 and runs 24 synthetic offline groups. See
  `tests/README.md` for execution and limits. It uses the actual compiled App,
  InputPanel and helpers with local hook/transport/SDK fixtures, never personal
  config/database or provider requests. Historical test files below may be absent;
  do not assume they survived cleanup.
- Persistence must distinguish a loaded database, the server's new-database `{}`
  response and a load failure. Failed reads block editing/automatic writes until
  a successful retry. Failed saves retain memory, show unsaved changes and offer
  retry of the latest state; success requires an OK HTTP response. Writes are
  serialized so stale requests cannot overwrite newer changes.
- Fresh model tasks use `createAnalysisTask`/`crypto.randomUUID()` in shared
  analysis and regeneration. Stored/restored/imported tasks use `migrateTask`
  without replacing their IDs.
- Invalid/empty Gemini interventions may be omitted from valid JSON while keeping
  usable speech in order and the original `source.interventionIndex`. Persist the
  content-loss warning on canonical turns and processing warnings; initial and
  regenerated analysis must receive the partial flag. All-unusable entries remain
  errors, distinct from explicit no-audio responses. Degeneration/JSON guards stay.
  Do not seed references from a chunk with discarded speech of unknown bounds.
  Other unknown endpoints conservatively screen only potentially intersecting
  sample windows; a known opposite bound can still prove separation.
- Gemini JSON validity does not prove coverage. For exceptionally sparse replies
  to long prepared WAV chunks, `geminiCompletenessIssue` uses bounded signal probes
  as corroboration, never as speech recognition. `transcribeCheckedGeminiSegment`
  shares the existing single validation-retry budget with degeneration. Suspected
  incompleteness retries the same uploaded main audio without references, preview
  or textual tail; do not bind tokens that were not sent in that retry. Preserve
  usable first speech if retry fails, record a possibly-incomplete warning and
  pass the partial flag to initial/regenerated analysis. Partial chunks cannot
  seed references or supply adjacent continuity/reconciliation for the next one.
  Optional `segmentsPartial` distinguishes them in progress and stored timings.
  Signal probes can mistake noise/music for speech or miss less extreme omissions;
  never promise full semantic coverage. A later authorized focused real test
  rejected a MAX_TOKENS loop, then recovered chunk 3 with one isolated retry;
  see `REVISION_SEGMENTO_GEMINI.md`. It does not validate the whole meeting.
- No test framework or build system is required. `tests/transcript-integrity.cjs` runs
  offline synthetic checks with Node and a local copy of the same Babel standalone
  7.23.0 used by `index.html`: `node tests/transcript-integrity.cjs <path-to-babel.cjs>`.
- Never load personal configuration/database files or send real audio to APIs in
  tests without specific authorization. Synthetic responses do not validate real
  model quality or browser codec support.
- Stage 2 and its Gemini regression correction have 25 offline check groups,
  including escaped UTF-8 repair, actual multipart audio wiring and a simulated
  two-speaker/four-chunk run. The simulation tests identity bookkeeping when a
  provider recognizes references; it does not test Gemini's acoustic accuracy.
  The original single authorized Gemini measurement is
  recorded in `tests/stage2-gemini-benchmark.json` (metrics only, no audio, speech,
  names or keys). Do not rerun it automatically or treat one sample as a benchmark
  of all recordings. Babel is available from the existing pinned CDN URL in
  `index.html`; it is test tooling, not a new application dependency.
- The later user-authorized continuity investigation is recorded in
  `tests/gemini-continuity-validation.json` (metrics only). It includes two
  complete adjacent chunks plus short excerpts of chunks 3/4, with checkpoint
  reuse to avoid resending already validated audio. Repeating three additional
  complete chunks was rejected by automatic approval review; the remaining test
  used the reduced scope. Do not claim the entire 30-minute transcript or every
  speaker assignment was independently audited.
- The three bounded stage-3 improvements below were reviewed in source only,
  at the user's explicit request for **no tests**. No test runner, compilation,
  real API call or mounted-app check was performed for these changes. The earlier
  25 check groups are historical evidence, not validation of these new UI/timing
  changes. Do not run extensive tests or repeat paid audio tests automatically.
- The later manual stage-3 block has six small offline check groups in
  `tests/stage3-manual.cjs`. Run with the same pinned local Babel copy:
  `node tests/stage3-manual.cjs <path-to-babel.cjs>`. It compiles the complete TSX,
  checks corrections/undo/legacy metadata/task protection and simulates a
  successful-failed-successful three-chunk run with provisional updates.
  No personal config/database, real audio or provider API is read/called.
  These checks do not validate mounted UI behavior or real provider quality.

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
| `PROVIDER_GEMINI` | `gemini-3.5-flash-lite` | ~0.03x | free tier as configured | yes, local labels / attached samples |
| `PROVIDER_OPENAI_FAST` | `gpt-transcribe` | **0.027x** | $0.0045 | **no** |
| `PROVIDER_OPENAI_DIARIZE` | `gpt-4o-transcribe-diarize` | **0.324x** | $0.006 | yes, native |

The two OpenAI factors are **measured**, not estimated: 16.1 s and 194.6 s respectively for the
same real 600 s meeting segment. Re-measure before changing them — the modal's time estimate
is built from these plus `UPLOAD_TIME_FACTOR`.

On 2026-10-13, one authorized paid-Gemini test of the first 600 s of the local
30-minute M4A measured **9.4294 s transcription (0.01572x)** and **6.5226 s upload
+ file readiness (0.01087x)**, using the stage-2 prompt and unchanged model. Local
decoding/chunking of the complete 1836.977 s file took 5.5475 s. The response had
31 turns, two local labels, STOP, 9139 text characters and no timing/loop warnings.
Only one generateContent request ran; no names/analysis calls or real OpenAI
requests were made. This is not a before/after experiment or a semantic accuracy
evaluation. It preceded the acoustic-reference correction, so it does not measure
the new sample/prompt overhead or cross-chunk continuity. Subscription, demand,
audio and output length can affect latency.
The default Gemini factor is a conservative **0.03x** baseline, not the literal
single-sample factor. Shared upload factor 0.045x and measured OpenAI factors stay
unchanged. The picker estimates transcription + upload; it excludes local decode,
name resolution, minutes/tasks, backoff and degeneration retries. It is not an
end-to-end completion promise. Free-tier labels/pricing do not prove that a key
with paid billing has no cost; tariff/billing UI changes are separate work.

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
After the provider, a second modal asks whether the recording is a meeting or a conference —
see *Session Modes* below.

There is **no model routing and no cross-model fallback**. `generateStructured` retries the
*same* model up to 3 times with linear backoff, and only on transient errors (429/5xx).

### Transcript Normalization (section 2 of the file)
All three providers funnel into `TurnSegment { startSec?, endSec?, speaker, text,
sourceId?, source?, integrityWarnings?, overlapStatus?, localSpeakerId?, speakerReferenceName?, speakerId?,
speakerName?, speakerIdentityMethod?, speakerIdentityEvidence?, speakerNameEvidence?,
textEncodingRepair? }`. Times remain full-precision
absolute seconds internally. Missing/invalid times stay absent; neither the chunk
start nor the next intervention supplies a missing turn time/duration. `source`
records provider, zero-based chunk/intervention indices, actual audio start,
content start and blob duration. API intervention IDs are retained when supplied.
Gemini timing is marked `generated`, native OpenAI timing `api`, and plain blocks
`unavailable`; these distinctions are not confidence scores.

### Speaker Identities and Names (stage 2)
- `localSpeakerId` is the provider's label scoped to a request (provider + chunk).
  `speakerId` is the stable ID inside this processing run/meeting (`speaker_N`).
  `speakerName` is a human name backed by textual evidence or a manual rename.
  `speaker` remains the compatible visible label. Named identities display as
  `Ana (Hablante N)` so equal names cannot silently collapse distinct voices.
- `speakerReferenceName` is Gemini's separate acoustic-match proposal. Binding
  it requires the exact token to have been sent in this request; an unknown,
  conflicting or shared reference proposal does not fuse local voices.
- `SpeakerRegistry.requestBindings` maps request-local labels to meeting IDs.
  Repeated A/B or Hablante 1 labels, introduction order and subject matter never
  link requests. Plain GPT Transcribe blocks remain untimed and without a speaker
  identity; they do not become an invented Hablante 1.
- `speakerIdentityMethod` is `request-local`, `voice-reference`, or
  `adjacent-overlap`. A request-local identity after the first chunk remains
  pending continuity, with a visible warning. IDs/evidence survive JSON storage,
  import, export and renames; raw-only legacy records keep their existing labels.
  This does not retroactively re-identify voices in old recordings.
- The registry is per meeting. Audio references and its Maps are transient; only
  scalar identity/label/evidence metadata is persisted on canonical turns. There
  are no voice profiles or automatic identity links between meetings.

New records persist `transcript_turns` as the canonical source. `transcript_raw`
is its compatibility projection, never a second independently editable transcript.
`withTranscript` synchronizes both fields; rename, rendering, import and export
consume the same turns. Any future manual editor must also use `withTranscript`.
Migration supports raw-only records and the older `transcript` array, without
inventing missing metadata. Invalid structured data falls back to available raw text
with a warning. Valid structured turns take precedence over the raw projection.

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
- The parser also recognizes `[--:--]` and fractional input seconds. TXT/Markdown
  and the UI display whole seconds; they cannot carry precise end times/provenance.
  The transcript's **JSON** download preserves those fields and warnings and can
  be loaded via **Cargar Transcripción** (same mode picker and Gemini analysis,
  without an audio transcription call). It never exports configuration or keys.
  TXT/Markdown/JSON imports also preserve their transcript with empty analysis
  fields and a warning if Gemini analysis fails.

### Gemini Response Integrity (stage 1)
`generateStructured` checks actual SDK `candidates[0].finishReason` and
`promptFeedback.blockReason` before reading/parsing text, supporting both the
`@google/genai` text getter and the legacy `response.text()` wrapper. `MAX_TOKENS`
is truncation even if the returned JSON parses; blocked/abnormal terminations
are content errors. Missing metadata does not prove completeness.
`GeminiResponseError.kind` distinguishes format, content, truncated and degenerate
responses. Format repair is limited to enclosing fences/prose and trailing commas
outside strings; never rewrite quoted speech or complete missing JSON/turns.

`normalizeGeminiTurns` requires a segments array and time/speaker/text fields with
nonempty speech. Invalid/out-of-range times are omitted while text survives with
an integrity warning. Backward starts over three seconds are suspicious, not proof
of invalid speech: keep the original order and flag them. Overlapping intervals
are not inherently errors. Warnings persist and appear in the existing banner
and Markdown export; they indicate uncertainty as well as skipped audio.
Do not infer word times, confidence or missing turns.

### Literal UTF-8 Byte Escapes
Some Gemini responses contain literal `\xc2\xbf` / `\xc3\xa1` in human text rather
than normal `¿` / `á`. The observed recording already stored these sequences
inside JSON text values; the Python server reads/writes UTF-8 with
`ensure_ascii=False`. Do not change the server's encoding or decode the entire
document as Python escapes.

`repairEscapedUtf8` decodes only contiguous byte-escape runs that are valid,
printable UTF-8 containing non-ASCII bytes. Invalid sequences, ASCII-only escapes,
double backslashes and backtick code spans/fences remain unchanged. Existing
Unicode is untouched. Gemini normalization and canonical load/import migration
repair speech; each changed structured turn retains the original text in
`textEncodingRepair`. Raw-only legacy migration retains
`transcript_encoding_original`. `transcript_raw` is rebuilt by the existing
serializer. JSON round trips and speaker renames preserve this audit metadata.
The repair also applies to human analysis/name text and stored minute/task text,
never configuration, keys or existing task/identity IDs. Prompts request normal
Unicode. Loading an old transcript repairs its displayed text without an API
call; its existing speaker IDs are not merged or acoustically re-identified.

### Text encoding follow-up (2026-10-14)

`repairTextEncoding` extends the existing byte repair with a small whitelist of
text entities and printable numeric Unicode scalars. It never parses or renders
HTML; React text children remain the rendering path. Code spans/fences, unknown
entities, malformed strings and invalid scalars stay intact. Original speech
survives in `textEncodingRepair` (`escaped-utf8`, `html-entities`, `mixed-encoding`)
or `transcript_encoding_original` for legacy raw data. IDs/times/source indices
are unchanged. This is representation repair, not missing-word reconstruction.

Controls/replacement characters, unconvertible codes and a bounded suspicious-ú
heuristic produce a persistent partial warning. The heuristic needs >=300 text
characters, >=8 ú, no other usual Spanish diacritics/signs and >=10 common Spanish
function words; it can miss other corruption and can flag unusual legitimate
text. It never replaces ú. Gemini checks this alongside sparse/repetition guards
using the same single validation retry; encoding retries isolate the already
uploaded main audio. If still suspect, preserve usable speech, warn and give
initial/imported/regenerated analysis the partial flag. Partial chunks cannot
supply new references or adjacent tail. Loading saved data makes no API call.

The prompt uses affirmative natural-orthography wording with actual Spanish
characters; the prior prompt already requested Unicode, not HTML. Four manual
File API tests sent 180+180+120+120 seconds total, with the same model/SDK. All
returned STOP and correct characters; original HTTP text equalled SDK text and
the normalized/stored projection. They did NOT reproduce the user's intermittent
full-chunk failure or establish that prompt wording caused/fixed it. No reference
samples, preview, prior tail, speaker naming or analysis API calls were included.
The server/config/database/backup/mobile view were not edited. See metrics-only
`tests/gemini-text-encoding-validation.json` and `REVISION_CODIFICACION_GEMINI.md`.
Do not repeat these calls automatically; their 600-second budget is exhausted.

`tests/text-encoding.cjs` has 12 offline groups on actual compiled functions,
including migration/import, text rendering and retry/failure handling; the existing
24 small-correction groups also passed. Babel compilation is not static typing or
a mounted-browser/end-to-end audio test. The live App was never mounted in these
checks. Private raw responses/audio outputs remain outside the repository.

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
  and `contentStartSec` (where new content begins), without rounding either value.
  Gemini transcribes the full attached audio, including overlap; reconciliation
  belongs to the application, so the prompt and code do not each discard it.
- `reconcileOverlapTurns` compares only adjacent successful chunks in the shared
  interval. Removing a whole turn requires an interval wholly within overlap,
  intersecting prior timing, matching speaker and substantial identical text.
  A crossing turn is never removed based on its start alone. A substantial unique
  suffix/prefix may be trimmed at adjacent edges, with the original interval kept
  and `prefix-trimmed` recorded: no new word time is inferred. Otherwise retain
  content with `uncertain` and a visible warning. Repetitions after the cut remain.
  Text search is capped by the shared duration and existing 35 chars/s safety
  bound; this is not a timing measurement.
- GPT Transcribe remains a single untimed, unattributed block per chunk. It bypasses
  interval-based dropping. Only a unique adjacent suffix/prefix of at least 12
  words / 80 characters can be trimmed, and never the entire block. Without
  sufficient evidence, preserve text and flag uncertainty. A failed preceding
  chunk disables reconciliation and clears both its adjacent turns and tail.

**Decoding is memory-bound, and that is why it used to fail on long recordings.**
`decodeAudioData` resamples to the AudioContext's rate, so `decodeAndChunk` builds the context
with `{ sampleRate: TARGET_SAMPLE_RATE }`. Decoding a 96-minute meeting at the hardware rate
(48 kHz stereo) needed ~2.1 GB of PCM plus a second full copy from the OfflineAudioContext
resample; asking for 16 kHz up front cuts that to ~0.7 GB, and `encodeWAVRange` downmixes per
chunk so no full-length mono copy is ever allocated. The OfflineAudioContext path remains only
as a fallback for engines that ignore the requested rate.

The normal downmix averages input channels into mono while encoding each chunk.
Stereo does **not** imply separate speakers per channel. Stage 1 adds neither a
second complete audio copy nor a multichannel processing path.

Decoding failure is **fail-closed**: if the browser cannot decode and split the
selected container/codec, `prepareSegments` throws, the outer handler shows the
user a conversion message, and nothing is uploaded. Never restore the old raw-file
fallback; it could send a multi-hour recording to a provider as one segment.

### OpenAI Speaker Continuity Across Chunks
Applies to `PROVIDER_OPENAI_DIARIZE` only; `gpt-transcribe` has no speakers to carry.

`diarized_json` labels speakers **per request**, so segment 2's "A" is not segment 1's "A".
The API's known_speaker_names/references limits were verified against official
[OpenAI Docs](https://developers.openai.com/api/docs/guides/speech-to-text): at
most **4** references per request, each **2-10 seconds**, transmitted as data URLs.
`buildSpeakerReferences` targets at most 6 s and uses **actual startSec/endSec**,
never time until the next turn. It requires native validated timing for every
turn in that response, excludes detected overlapping intervals, removes a 0.15 s
edge margin, and clips within the WAV's real sample bounds at sample precision.
If fewer than 2 s remain, skip the turn; never extend it to meet a minimum.
Only the application's 16 kHz mono PCM16 WAV layout is accepted. Silence, mostly
inactive signal, severe clipping, invalid headers/times and out-of-file ranges
cannot become references. RMS/activity/clipping checks are deterministic signal
controls, **not** acoustic speaker verification, confidence or a noise detector.
Background voices, erroneous diarization and music can still fool these gates.

Reference names are opaque `mm_speaker_N` tokens, with stable registry bindings.
Only a token actually **sent in the current request** can bind a returned speaker
to that meeting ID. Other labels, even old opaque tokens or real-looking names,
remain scoped to this request. Human name resolution never changes these bindings.
The cache keeps at most **8** clips (~1.47 MiB of PCM WAV payload at 6 s each),
sending the 4 most recently active identities, preferring unsent/least recently
sent clips among equally active identities. Later validated participants can
enter it; an existing retained clip is not replaced. Inactive clips may be evicted
only for candidates passing the same gates; scalar token/identity bindings survive
eviction. No adequate sample means continue without one. Unrecognized voices can
produce duplicate pending identities; do not merge them using labels or names.

### Gemini Fidelity and Acoustic/Adjacent Continuity (stage 2)
Transcription prioritizes pronounced words, figures, units, negations, names,
commitments, corrections and legitimate repetitions. It uses local Hablante N
labels and structured segments. Acoustic comparison is separately expressed once
per local voice in `speaker_matches`, not by choosing a reference token on every
speech entry. It does not request executive clean-read editing,
paraphrase, filler deletion or an arbitrary maximum number of audible repetitions.
The stage-1 loop/truncation/timing guards and full-overlap transcription remain.

The initial stage-2 implementation depended only on two textual anchors inside
8 seconds of overlap. A real two-speaker/four-chunk recording consequently became
eight IDs. Do not restore global label/order/topic merging to conceal that problem.
Gemini now receives up to **4 short acoustic samples inside the same transcription
request**, with text markers identifying their opaque tokens and the main audio.
[Gemini's official audio documentation](https://ai.google.dev/gemini-api/docs/generate-content/audio)
supports multiple audio inputs and inline audio parts; this is a prompt-guided
comparison, not OpenAI's native known-speaker parameter or a verification model.
`generateStructured` handles multipart input in both supported SDK structures.
Only the main audio is transcribed, including its overlap, and its clock starts
at its own zero; sample words/durations must not enter the transcript.

An observed failure omitted `end` in every turn, so the old all-turns gate
rejected every sample. The response schema now requires the **key** `end`, with
an audible MM:SS estimate or **null** when unknown. The normalized `endSec` stays
optional. Gemini start/end remain `source.timing = generated`, never measured
timestamps. Missing/invalid bounds reject that candidate; other clean candidates
can still qualify. Native OpenAI retains its stricter whole-response gate.

After the existing response/degeneration validation, Gemini sample selection
prefers early validated intervals to reduce clock drift. It may join consecutive
same-voice intervals **only when their supplied endpoints touch exactly** and
their source intervention indices are consecutive. This changes neither stored
turns nor their durations; gaps, missing bounds and other voices are never joined.
Samples are **4-10 s**, with **0.75 s trimmed at each edge**, bounded by real WAV
samples and screened for detected overlap in the actual sample window. A crossing
elsewhere in a long turn does not contaminate an earlier isolated sample. Unknown
endpoints of other turns are not converted into speech durations; approximate
timing and unresolved overlap can still contaminate samples. Fully unlocated
speech blocks sample selection. Silence/activity/clipping gates remain controls,
not acoustic purity verification. OpenAI keeps 2-6 s samples, a 0.15 s margin and
its full-turn overlap checks. No usable sample means continue without it.

The per-meeting Gemini cache remains bounded at 8 clips (~2.44 MiB PCM at 10 s
each), with at most 4 sent per request (at most 40 reference seconds). Names are
random opaque `voz_abcdefgh` tokens, independent of local Hablante N numbering,
and remain stable in the registry across cache rotation. OpenAI keeps its
`mm_speaker_N` convention. These Gemini bounds are application choices,
not a claimed provider reference limit. Later validated voices can enter the
cache without replacing a retained sample for the same ID. An inline-size budget
leaves room below the documented 20 MB request limit; omit references that do not
fit, and stop transcription if the main inline payload exceeds the safe budget.
Only returned tokens actually sent in that request reuse a meeting ID. A
one-to-one acoustic proposal is required: contradictory entries or two local
voices assigned the same token remain pending. The stored
`speakerIdentityEvidence.referenceTiming` preserves whether sample boundaries
were generated or native. Acoustic recognition remains model-dependent; unclear
voices keep separate pending identities. There is no additional generateContent
request, upload of a second full recording, cross-meeting voice profile or model.
Short samples add bounded input/cost overhead to the existing call.

Long requests (>180 s of prepared PCM) with available references also include a
**40-second unlabelled preview of the current chunk's beginning** after the
reference samples. It supplies short current audio for comparison, with no
pre-assigned speaker ID, inferred word timing or new content. The main audio is
first; references and preview are explicitly marked as context, not extra speech
to transcribe. This addressed an observed swap that survived sample extraction:
two IDs alone did not establish correct continuity. The checked shared utterance
then agreed across the two complete adjacent chunks. This is still a
model-dependent comparison, not a guarantee of every turn's diarization.

`buildGeminiVoicePreview` accepts only prepared 16 kHz mono PCM16 WAV, copies at
most 40 s (~1.22 MiB), and creates no second complete recording. It is transient,
omitted for short chunks or when it cannot fit. The **same** generation request
contains main audio, references and optional preview; there is no extra upload
or transcription call. Together, preview and four maximum references add at most
80 audio seconds per long request. `fitGeminiReferences` accounts for their base64
payload in the existing safe request budget. Samples/preview must never enter
the transcript or offset the main clock. Preserve normal partial-failure guards.

`collectSpeakers` retains separately supported names and previous labels for app
state, but the prompt no longer sends previous Hablante N labels. The textual tail
is parsed to spoken words without its old speaker/time markers, which otherwise
primed label/order matching. Mentioned persons, confirmed textual names and owner
context are not an acoustic identity list. The bounded tail is conversational
context, not voice memory; the prompt never
asks to recognize previous audio that is absent from the request. Failed chunks
clear the tail/context and disable adjacent mapping and overlap deletion.

For no usable voices in the main audio, request empty `segments` and
`speaker_matches`. Legacy SYSTEM/no-audio sentinels remain supported as control
metadata. An embedded exact legacy sentinel beside real speech is removed with
a warning and original intervention indices retained; it never becomes another
speaker. Genuine spoken mentions of the marker remain speech.

`adjacentGeminiSpeakerLinks` requires **two distinct exact textual anchors for the
same local/meeting pair**, each at least 6 words / 40 characters, unique in both
shared windows, ordered, with start estimates differing by at most 2 s. Both must
fall inside the existing shared audio and in immediately adjacent chunks. The
mapping must be one-to-one and conflict-free. A lone match, matching label/theme,
or a person absent from the overlap cannot link identities through this text rule.
Evidence is stored as
`adjacent-overlap`, not acoustic certainty or a confidence score. Short overlap,
different wording or approximate clocks can still leave duplicates for review
when acoustic references are unavailable or unrecognized. This rule is a fallback,
not the sole continuity mechanism.
`reconcileOverlapTurns` then compares stable IDs, retaining the conservative
stage-1 protections and content when evidence is insufficient. No new API call,
speaker-recognition engine, concurrent processing, model or chunk policy is added.

### Supported Human Names (stage 2)
The single existing `resolveSpeakerNames` call receives selected turns in original
order with their real indices, identities, chunk boundaries and neighboring
responses (18k character context cap). It no longer concatenates speech by label
and loses conversational order. The model must supply a literal quote and indices
for an explicit self-introduction, or same-chunk adjacent direct-address/handoff
and response. Deterministic checks verify quote, name, target ID, indices and
the corresponding linguistic pattern; a mere mention, negative introduction,
missing citation or uncertain response leaves the generic label. Selection/pattern
limits can miss valid introductions; conflicting supported names for one ID also
leave its generic label instead of selecting a proposal by output order. These
cases correctly remain unnamed identities.
Names are text-supported proposals, not independent acoustic proof. The same name
may appear on distinct IDs, visibly disambiguated; naming never fuses voices.
Failures stay best-effort and cannot discard a completed transcript. Manual rename
updates the human-name/evidence fields while preserving ID and source/times.

### Anti-Degeneration Guard
Models occasionally fall into a repetition loop (a real run produced 37 k characters of
"eh eh eh…", 32 % of the transcript, which then poisoned the generated minutes).
`sanitizeSegmentTurns` rejects a segment exceeding `MAX_CHARS_PER_SECOND` (35; normal Spanish
speech is ~15) or losing over 20 % of its characters to `collapseLoops`, and the segment is
retried once. The ratio check applies to responses of at least 240 characters,
so a brief emphatic repetition is not classified as a poisoned chunk. It also
detects dominant repeated phrases/identical long turns.
The collapse is a detection probe only; normal repetitions are not edited out.
If the retry is still degenerate, skip that chunk with a warning instead of
publishing the poisoned response. Keep this guard in the transcription loop.

### Partial-Failure Resilience
One bad segment must never discard the valid segments already transcribed. The segment loop has
its own `try/catch`: an explicit Gemini no-audio sentinel is represented by
`NoAudioDetectedError`, an empty OpenAI response or Gemini segments array is treated the same way, and any other
segment-level error is recorded in `processing_warnings`. In every case the loop continues with
the next segment. Only a recording where **every** segment fails remains a fatal transcription
error.

`allTurns` is the in-memory checkpoint. It intentionally does not survive a reload or app crash,
but it must survive later AI failures in the same run. After a failed segment, clear
`previousTail` so an older conversation tail is not presented as adjacent context, and keep the
next segment's leading overlap because those seconds may recover a small part of the missing
audio. Stable registry bindings and validated OpenAI/Gemini acoustic references
may continue across the gap; Gemini adjacent textual continuity does not.
Only skipped/failed audio sets `hasMissingAudio` for the analysis prompt; an
identity/overlap review warning by itself does not falsely claim missing audio.

If at least one segment succeeds, `analyzeTranscript(..., isPartial = true)` still generates the
minute/relatoría and any tasks supported by the available transcript. Its prompt explicitly
forbids filling gaps or inventing decisions, participants, or tasks. The warnings travel with
`MeetingData`, are persisted in `database.json`, and are included in the Markdown
export. The **Resultado parcial** heading is reserved for omitted/failed audio or
failed/interrupted analysis; review-only warnings use the presentation below.

The final analysis call is isolated too: if minute/task generation fails after transcription,
publish the assembled transcript with empty analysis fields and a warning instead of discarding
it. `resolveSpeakerNames` remains best-effort and must likewise never sink a completed transcript.

### Bounded Stage-3 Improvements (2026-10-13)

The user's subsequent real run of the same clear two-voice audio reported a good
transcript with only uncertain-overlap warnings on chunks 2/3/4. This is user
feedback, not an independent accuracy audit. Preserve the stage-1 reconciliation,
stage-2 speaker/reference logic, model, sequential requests and 600 s / 8 s policy.
At that checkpoint, only the following three improvements had been implemented:

1. **Review notices:** `processingNotice` classifies existing warning strings for
   presentation without deleting them or changing transcription. Overlap-only
   results read "Transcripción generada · N empalmes por revisar", grouped by chunk.
   Where canonical provenance exists, a button opens the transcript and scrolls
   to its first uncertain intervention; affected turns have a visible review
   marker. Legacy warnings without turn provenance remain visible without an
   invented jump location. Missing/failed chunks or failed analysis retain
   "Resultado parcial"; other/unknown warnings read "Resultado con advertencias".
   Markdown uses the same heading and retains all original warnings; JSON retains
   `processing_warnings` and the canonical turn metadata. Speaker/sample/timing
   uncertainty alone does not establish missing audio.
2. **Rename scope:** the global rename within the current transcript is preserved.
   `RENAME_SPEAKER` updates accumulated task assignees only when their IDs belong
   to tasks assigned to that label in the currently loaded meeting, and their
   current assignee still matches. Equal names in older meeting tasks are not
   sufficient. Minutes participants/current meeting tasks follow the existing
   rename behavior; times, provenance and stable speaker IDs stay unchanged.
   A legacy task without an ID cannot be reliably linked to an accumulated task
   and is not updated there by name alone.
3. **Observed timings/progress:** optional `processing_timings` stores finite
   nonnegative `totalMs`, `stagesMs` (preparation, upload, transcription,
   reconciliation, names, analysis), segment total/success/failure counts and two
   booleans describing upload measurement. There is no audio, speech, key, name,
   URL or filename in these metrics. Full precision is retained in storage/JSON;
   display/Markdown rounds to seconds (positive durations below 1 s show "<1 s").
   Old meetings without metrics remain supported and get no invented timings.
   The loading screen shows elapsed total/current phase and settled fragment
   counts, including omitted/failed chunks. Only actual upload events show a
   percentage. Results expose a collapsible stage-duration summary; Markdown/JSON
   include it. Live clock/progress is transient and does not trigger database
   saves; metrics are persisted once with the result through the existing flow.

`createProcessingClock` observes the existing sequential execution using the
browser's monotonic clock; it does not schedule requests or alter retries. The
API stage combines network wait, provider processing and response handling, with
the existing request preparation/validation inside that operation; it is never
labelled pure remote inference. Gemini upload includes File API readiness polling;
inline fallback transfer is included in the transcription API time. OpenAI splits
upload/API only on actual XHR upload-completion events; if absent, the combined
operation is attributed to API with an explicit note. Local reference extraction
is preparation; identity/overlap assembly is reconciliation. Stage totals include
failed attempts/retry delays inside that stage. Overall total also includes the
existing between-chunk pauses, so stage durations need not sum to total. Text
imports measure parsing and analysis from after FileReader completion, not audio
stages or file-reading time. Existing measured factors/benchmarks are unchanged.

The later manual block below continues that checkpoint. Preserve these three
improvements and their original measurement/validation limits.

### Manual Stage-3 Block (2026-10-13)

- `applySpeakerEdit` handles rename by meeting identity, one-turn reassignment
  and explicit source-to-target fusion. Canonical turns remain the source and
  `withTranscript` rebuilds the compatible projection. Times, speech, source IDs,
  request-local labels, overlap/encoding metadata stay intact. Reassigned/fused
  turns use `speakerIdentityMethod = manual`; `speakerCorrections` retains prior
  identity/name/evidence fields. Storage migration and JSON preserve this audit
  metadata. Equal human names never trigger a fusion. Ambiguous bare names cannot
  rename tasks for two distinct IDs; raw-only meetings remain editable without
  inventing speaker IDs or times. A legacy rename to another existing legacy
  label is rejected; joining them requires the explicit fusion control.
- Rename retains the previous current-meeting task-ID scope and checks the
  accumulated task's current assignee. Ownership is recomputed for changed task
  assignees. Reassignment/fusion leave participants/minutes/tasks unchanged;
  there is no reliable task-to-turn link to rewrite them automatically.
- `analysis_review` marks the minute/relatoría and this meeting's tasks pending
  after an edit (conferences have no current tasks). The UI and Markdown/JSON
  expose this state. Rename changes labels as before but never claims that the
  analysis prose was regenerated. Speaker edits make no API calls.
- Undo keeps at most 20 transient edit snapshots, per currently loaded meeting.
  It restores canonical/raw data and the previous review state. Accumulated
  tasks restore only rename fields still matching that edit; later description,
  priority, completion and manually changed assignees survive. Loading/deleting
  a meeting, task cleanup, applying analysis or marking tasks reviewed clears
  the history. Reload/crash recovery of undo is outside this block.
- **Regenerar análisis con Gemini** explicitly reuses `analyzeTranscript` with
  the corrected transcript and existing meeting/conference mode. It makes no
  new audio transcription/upload. Existing analysis stays visible until the user
  applies the proposal; failures leave it intact. A request token and meeting
  snapshot guard reject a stale response. Audio/text inputs are disabled while
  processing or regenerating; deleting the meeting invalidates pending analysis.
- Regenerated tasks are proposals, unchecked by default. Applying analysis
  replaces the current minute and appends only selected new tasks, with fresh
  IDs, after rechecking the latest accumulated list. No existing task is updated
  or removed. NFKC/case/whitespace/punctuation-normalized descriptions deduplicate
  against current/accumulated tasks and within proposals, regardless of assignee,
  preserving manual assignment corrections. Semantic paraphrases still require
  user review. Existing tasks remain pending until explicitly marked reviewed.
  Conferences add no tasks. Earlier analysis-failure warnings are retained with
  an `Análisis anterior:` prefix after successful application, and no longer mark
  the current analysis partial; audio-gap warnings remain unchanged.
- The provisional transcript displays successful canonical fragments and notices
  after each settled chunk. It is transient state, separate from `meetingData`
  and the automatic save, and is removed when the final/partial result arrives.
  Existing checkpoint/failure handling and sequential requests are unchanged;
  successful fragments are not retranscribed. No reload/crash recovery is added.
- Existing provider factors and processing timings remain unchanged. The draft
  separately displays observed regeneration duration (network + API), without
  relabelling the original run's timings or claiming pure remote inference.

Validation in this block: complete TSX compiled with the app's pinned Babel
7.23.0 and six small synthetic groups passed. The mounted UI and real Gemini/
OpenAI API flows were left for the user's own tests; no paid/API test was run.

**Still pending from stage 3:** active cancellation across upload/SDK calls,
polling/backoff/retry waits; new bounded timeout policies; reload/crash checkpoint
recovery; concurrency for plain GPT Transcribe. Cancellation/timeouts require a
separate coordinated block with small simulated late-response/retry checks.
Gemini and diarization stay sequential; plain GPT Transcribe also stays sequential
until concurrency is separately authorized and checked. Never promise that local
cancellation stops remote processing/billing or retry a request of uncertain
completion automatically. The original `ETAPA_3_PENDIENTE.md` remains the scope
reference, read together with this updated implementation status.

### UI follow-up and continuity review (2026-10-13)

Warnings now have an X control and a `Mostrar avisos ocultos` action. Dismissal is
transient App state, shared with TranscriptView so it survives tab changes.
Processing/generic/analysis-review/individual-overlap/provisional messages can be
hidden without changing canonical metadata, exports or review status. A new
result resets dismissal; a new speaker edit exposes the analysis-review notice
again. Fusion labels are `Actual` and `Reemplazar por:`.

A read-only review of saved meeting metadata found five fully unlocated turns
in its first Gemini chunk. All 29 time/length candidates were rejected by the
existing conservative overlap screen; the saved notice reports no usable samples
for chunk 1. Chunk 2 had no matched references and created separate identities;
chunks 3/4 did match references. This explains an observed continuity failure,
not independently verified acoustic attribution for every turn. No real audio
was replayed/uploaded and no configuration, database or backup was modified.
Preserve the sample safety gate; do not invent missing times or infer identity
from equal names, local labels or order.

`PLAN_GEMINI_35_TRANSCRIBE.md` records this review and the user-requested plan for
an additional model. It is NOT implemented. Check the dedicated API contract,
native output and cross-request identity behavior before integration; keep
current providers/models, portable architecture and 600 s / 8 s policy.

Validation for these UI changes: complete TSX compilation with pinned Babel
7.23.0 and comparison confirming the transcription flow is unchanged. No mounted
UI or real provider tests were run; do not attribute the six prior offline groups
to these follow-up UI changes.

### Segment speaker correction and Gemini conflict guard (2026-10-13)

The user reported two recognized voices becoming swapped in later Gemini chunks
and authorized review plus manual corrections by segment. This block extends the
earlier identity/editing scope; it does not change model, chunk policy, prompt,
request count, sample limits, sample safety gates or provider sequencing.

- `assignSpeakerIdentities` now checks Gemini reference proposals against the
  existing strong `adjacentGeminiSpeakerLinks` evidence before accepting them.
  A disagreement, or two local voices resolving to one ID through different
  mechanisms, rejects reuse for every local voice connected to the disputed IDs.
  Keep them request-local; do not select a winner or infer a mapping by elimination.
  Unrelated voices and compatible evidence follow the existing binding behavior.
  Gemini binds only `speakerReferenceName` from validated `speaker_matches`, never
  a reference token used directly as a local speech label. OpenAI's native token
  handling is unchanged.
- Rejected proposals, conflicting IDs and available overlap anchors persist in
  `speakerIdentityEvidence`; warnings survive storage/JSON/Markdown. Such turns
  cannot seed new samples, satisfy subsequent adjacent anchors or justify overlap
  deletion/trimming. Existing cached samples remain. These warnings do not imply
  missing audio. With no strong contradictory evidence, a wrong one-to-one
  acoustic match can still pass; two surviving IDs alone do not prove attribution.
- `speakerSegmentKey`/`transcriptSpeakerSegments` use persisted provider, chunk
  index and actual audio/content bounds, independent of turn timing. No inferred
  segment membership for legacy raw text. `SegmentSpeakerEditor` selects one
  chunk or an inclusive range of available chunks. Per-speaker replacements can
  target any identity in the meeting; the A↔B shortcut prepares a simultaneous
  mapping. The preview counts all scoped turns, even if search hides some.
  Segment numbers on each turn and an `Ir al inicio` action support inspection.
- `segment-map` validates the entire scope/mapping before mutation, reads targets
  from the original turn snapshot and calls `withTranscript` once. All changes
  share one undo entry. Speech, times, source IDs, local labels and encoding/
  overlap metadata survive; `speakerCorrections` retains the prior attribution.
  Missing targets/scope, duplicate source mappings and no-ops change nothing.
  Explicit many-to-one replacements are allowed; never perform an A↔B swap as
  sequential fusions. Minutes, participants and task assignees remain intact,
  with the existing analysis-review state set. No API call on manual editing.

Validation: complete TSX compilation with pinned Babel 7.23.0; 27 existing/new
transcript-integrity groups and 8 manual-edit groups passed offline. The integrity
fixture now supplies the browser's `performance` clock. Added checks cover
contradiction propagation, cross-evidence collisions, sample exclusion, atomic
swaps, ranges, untimed turns, migration/export, legacy data and undo snapshots.
An isolated mounted TranscriptView with three synthetic chunks confirmed range
selection, preview, simultaneous swap including search-hidden turns, undo and
navigation. It never loads the personal configuration/database or mounts App's
auto-save flow. No real audio, keys or provider calls were used. Model quality
and the exact attribution error in the user's latest recording remain unaudited.

`REVISION_HABLANTES_SEGMENTOS.md` records the review and remaining improvement
options. Stage-3 cancellation, bounded timeouts, crash/reload recovery and plain
GPT concurrency remain pending; Gemini 3.5 Transcribe remains only a separate plan.

### Session Modes: Meeting vs Conference
Every processed recording carries a `mode` on `MeetingData`: `MODE_MEETING` or `MODE_CONFERENCE`.
The user picks it in `SessionTypeModal`, shown *after* `ModelPickerModal` and still before anything
is uploaded. The choice persists in `localStorage` under `STORAGE_KEY_MODE`.

A conference (a talk, panel, class or webinar) produces the transcript and the minutes, but **no
tasks** — nobody in an audience is being assigned work, and asking the model for tasks anyway is
what made it invent them. So `buildConferenceSchema()` has no `tasks` property at all and
`conferenceAnalysisSystem()` has no task-manager section.

`analyzeTranscript(ai, transcript, mode)` is the **only** branch point, and it normalizes both
paths to the same shape: `tasks` is always an array (empty for a conference) and `mode` rides
along to `database.json`. Records written before this existed have no `mode`; `migrateMeetingData`
reads those as meetings.

`MinuteData` is **not** duplicated per mode — a conference fills the same four fields and only the
titles change, via the `MODE_COPY` table (`decisions` → "Conclusiones y anuncios",
`discussion_points` → "Ideas clave", `participants` → "Ponentes y participantes"). That is what
keeps persistence, the Markdown export and the `RENAME_SPEAKER` handler mode-agnostic.

Two things that are easy to get wrong:
- **The generic speaker label stays `"Hablante N"` in both modes.** Recognized
  attached acoustic samples return their tokens separately in `speaker_matches`. Speaker
  roles (ponente/moderador/público) and human names do not replace labels or tokens
  during Gemini transcription. Meeting IDs/names are applied afterward.
- **A conference must export an empty task list.** `persistentTasks` accumulates across meetings,
  so passing it to `buildMeetingMarkdown` from a conference would staple unrelated meeting tasks
  onto the relatoría. `downloadMinute` passes `[]` in that mode.

The Tasks tab stays visible in both modes — it is the global accumulator, not a per-session view —
but `handleProcessingComplete` lands on `Tab.MINUTES` after a conference, since Tasks would be
unchanged. Only the Gemini transcription prompt is mode-aware; OpenAI providers take no system
prompt, so with those the transcription is identical and only the analysis differs.

### Audio Upload Flow
```typescript
// 1. Pick file -> ModelPickerModal (provider choice, duration + cost shown)
// 2.          -> SessionTypeModal (meeting or conference; "Atrás" returns to step 1)
// 3. prepareSegments: decode + split into 10-min chunks, same for every provider
// 4. Transcribe per segment -> validate -> request-local/stable IDs -> overlap
//    OpenAI: native sent reference tokens; Gemini: per-voice acoustic matches,
//    bounded current-voice preview, adjacent fallback + unlabelled text tail
// 5. resolveSpeakerNames: text-supported names with quotes/indices, never voice fusion
// 6. serializeTranscript -> analyzeTranscript(mode) -> render
```
The `.txt`/`.md` "Cargar Transcripción" flow shows `SessionTypeModal` too (without the "Atrás"
button — there is no provider step) and threads the mode into `processTextWithGemini`.

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
