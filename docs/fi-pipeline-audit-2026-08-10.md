# FI Pipeline Audit — 10 August 2026

Scope: file ingestion integrity, AI filtering/extraction/detection quality, and duplicate results per project.

Method: full read of the ingestion, scan, detection and delivery paths, plus **read-only** aggregation queries against the production Atlas cluster (`fi-email-automation`). No writes were made to production.

---

## Executive summary

The pipeline is delivering **false leads to paying customers**, and the most damaging instance went to an acoustics consultancy.

Production headline numbers, as at 2026-08-10:

| Metric | Value |
|---|---|
| Documents processed (life of job `SCAN-ACOUSTIC-1775066009779`) | 227,799 |
| Documents skipped by baseline markers | 344,580 (**60% of all encountered**) |
| Total matches | 302 (**0.13% match rate**) |
| Distinct projects matched | 229 |
| Projects with **more than one** matched file | **52 (22.7%)** |
| Report/project pairs in `fi_reports` carrying 2–4 documents | **115** |
| Matched files whose filename indicates an FI *response* | 8 |
| Days covered vs elapsed | 130 of 132; 5 days processed zero documents |

Three findings are urgent:

1. **FI responses are being sold as live leads** (§3.1). A completed competitor acoustic report was delivered to WD Acoustics as a new opportunity.
2. **Matches are silently lost on every scan resume**, and a resumed scan silently scans the wrong day (§1.1). Confirmed against the live job's stored checkpoint.
3. **Genuine FI requests are discarded because of their sign-off.** `"kind regards"` is a hard rejection applied to the whole document before the AI runs (§2.1). This is the most likely explanation for the 0.13% match rate.

---

## 1. Data loss — ingestion and scan

### 1.1 CRITICAL — Matches lost on resume; resumed scans cover the wrong day

`scanJobProcessor` writes rich checkpoint state:

```js
// backend/services/scanJobProcessor.js:306
job.checkpoint.allMatchDetails = allMatchDetails;
job.checkpoint.scanStartDate = scanStartDate;
```

None of `allMatchDetails`, `scanStartDate`, `scanEndDate`, `triggeredBy`, `totalDocumentsRaw` exist in the `checkpoint` sub-schema (`backend/models/ScanJob.js:30-55`). Mongoose `strict` mode (default `true`) drops them on `save()`.

**Confirmed in production.** The live job's persisted checkpoint keys are exactly:

```
lastProcessedIndex, lastProcessedFile, lastProcessedPath,
totalDocuments, processedCount, matchesFound, isResuming
```

Two consequences:

- Every match found before a crash is **lost**. `saveDailyScanResult` (`:1665`) persists only post-resume matches.
- Because `checkpoint.scanStartDate` never persists, the resume branch at `:215` (`else if (isResuming && job.checkpoint.scanStartDate && …)`) is **dead code**. A resumed job re-derives "yesterday" from the *resume* time — so an overnight resume scans **a different day than the one it was scanning**. The original day is never completed and never revisited.

### 1.2 CRITICAL — A missing resume marker skips the entire day, then reports success

`backend/services/scanJobProcessor.js:332, 398-404`. On resume, `skipping` stays `true` until the stream re-encounters `lastProcessedPath`. If that key is not in the new stream — because it was deleted, or because §1.1 shifted the date window — **every document is skipped**. The scan then "completes" with 0 processed, clears the checkpoint (`:748-757`) and writes a 0-match daily result.

Production shows **5 zero-processed days**, consistent with this.

### 1.3 HIGH — Re-issued documents are permanently destroyed

`backend/services/documentIngestionService.js:232` dedups on filename alone:

```js
const newDocs = filterDocs.filter(doc => !existingFileNames.has(doc.fileName));
```

No size, ETag, hash or LastModified comparison. A revised document reusing its name — very common for `FI Request.pdf` — is never copied. With `INGESTION_CLEANUP_FILTER_DOCS=true` (production), `cleanupFilterDocs` (`:278-296`) then deletes the staged copy. **The new version is gone from both locations.**

### 1.4 HIGH — Cleanup deletes files that were never routed

`cleanupFilterDocs` (`:278-296`) **re-lists** the prefix at cleanup time and deletes everything except `.keep`. The routing snapshot was taken earlier at `:164`. Any file the scraper writes between those two points — a window spanning the entire batch run — is deleted without ever being copied to `planning-docs`.

### 1.5 HIGH — A daily re-run overwrites a complete result with a partial one

`saveDailyScanResult` (`:1670-1685`) upserts with `matches` as a plain value, replacing the array wholesale, and resets `delivered: false`. Any re-run or restart-triggered scan for the same `scanDate` (a startup scan fires at `:62`) **replaces** the stored result. The unique index `{jobId, scanDate}` guarantees one row exists — not that it is the best one.

### 1.6 HIGH — No backfill; a missed day is never rescanned

`lookbackDays` is hard-coded to `1` for the scan window (`:223`), and `fastS3Scanner.streamDocumentsSince` filters strictly to that window (`fastS3Scanner.js:59-60`). There is no gap detection and no catch-up. Combined with `:123-126`, where a job whose heartbeat is under 15 minutes old is skipped, **a scan that overruns 24h means the following day is never enqueued** and those documents are never examined.

Production: 130 days covered across a 132-day span.

### 1.7 MEDIUM — Silent format and size exclusions

| Site | Exclusion |
|---|---|
| `fastS3Scanner.js:69-74` | Only `.pdf` and `.docx`. `.doc`, `.msg`, `.eml`, `.xlsx`, images and archives are dropped silently — even though `getFileType()` (`:300`) recognises them |
| `scanJobProcessor.js:373-378` | Second `.pdf`/`.docx` gate |
| `scanJobProcessor.js:832-852` | `MAX_S3_OBJECT_MB` default **25MB** → dropped. A failed `headObject` (`:853`) is swallowed, leaving `sizeBytes = 0`, after which an oversized file is loaded fully into memory |
| `scanJobProcessor.js:779-808` | 25-second per-document timeout → **silently classified as no-match**, no retry, no record |
| `scanJobProcessor.js:935-943` | Text under 100 chars → dropped. This is the terminal fate of every scanned/image PDF when OCR is unavailable (`optimizedPdfExtractor.js:140-142`) |

### 1.8 MEDIUM — Text truncation hides FI requests, and disables a filter

`optimizedPdfExtractor` stops at 32,000 chars (`:41, 76-79`); `StreamingDocumentProcessor` caps at 10,000 chars and abandons the file after 5MB (`streamingDocumentProcessor.js:31, 57-60`). An FI request late in a long consultee report is invisible.

Side effect: the ">100 estimated pages" rejection at `scanJobProcessor.js:984-993` computes pages as `chars / 2500`. With text capped at 32k chars the maximum computable value is ~13 pages, so **this filter can never fire** on the non-streaming path.

### 1.9 MEDIUM — Jobs stick in PAUSED forever, with no alert

`scanJobWorker.js:30-33` sets `PAUSED` on failure; Bull retries 3× (`scanJobQueue.js:63`). After the third failure the job stays `PAUSED` permanently — invisible to the daily scheduler, with no dead-letter processing (`removeOnFail: 100`) and no alerting. The memory circuit breaker at RSS > 1700MB (`scanJobProcessor.js:492-498`) produces the same terminal state. The existence of `scripts/check-stuck-jobs.js` and `scripts/clear-stuck-jobs.js` shows this happens in practice.

### 1.10 Baseline markers exclude 60% of all documents

`skippedBaseline = 344,580` against `processed = 227,799`. This is by design — new projects are baselined for 2 days so their back-catalogue isn't scanned (`documentIngestionService.js:211-217`, `s3Service.js:854-883`) — but the ratio warrants verification that markers are being cleaned up. A marker that survives cleanup keeps its project excluded indefinitely; `cleanupOldBaselineMarkers` swallows failed delete batches (`s3Service.js:945-949`), and `document-register/audit-baseline-markers.js` exists for exactly this reason.

Note also that the marker is created **after** the copies (`documentIngestionService.js:192-217`); a crash in between leaves documents in `planning-docs` with no marker, and they are scanned as if incremental.

---

## 2. AI filtering, extraction and detection

Provider is OpenAI only, `gpt-4o-mini`, hardcoded in three constructors (`fiDetectionService.js:38`, `docfilesService.js:26`, `aiVisionService.js:12`) with **no env override**. All calls use the legacy Chat Completions `functions`/`function_call` API — not `tools`, not structured outputs. `temperature: 0.0`, `top_p: 0.0`.

### 2.1 CRITICAL — A courtesy sign-off rejects genuine FI requests

`fiDetectionService.js:953-1006`, `matchFIRequestType` gate 1. The list is applied as `String.includes` **over the entire document**, before any AI call:

```js
"good morning", "good afternoon", "good evening",
"kind regards", "best regards",
"happy to discuss", "please let me know",
"please find attached", "please find enclosed",
"has been submitted", "was submitted",
"acknowledge receipt", …
```

A council FI request letter signed *"Kind regards"* is rejected outright. So is any request containing the phrase *"has been submitted"* anywhere in eight pages of text. This is almost certainly the single largest source of false negatives and the best explanation for the 0.13% match rate.

### 2.2 HIGH — Report-type enum drift silently disables matching

Three different taxonomies are in use:

| Source | Values |
|---|---|
| `Customer.js:32`, `ScheduledJob.js:105` | `acoustic, transport, ecological, flood, heritage, arboricultural, waste, lighting` |
| `ScanJob.js:16`, UI dropdown (`document-scan.js:687-695`) | `acoustic, transport, flood, contamination, ecology, arboricultural, other` |
| `reportTypeTerms` (`fiDetectionService.js:1039-1046`) | `acoustic, transport, ecological, flood, heritage, lighting` |

A ScanJob typed `ecology` finds no entry in `reportTypeTerms` (which has `ecological`) and falls back to a literal substring test for the word "ecology". `contamination` and `other` have no keyword entry anywhere. A customer subscribed to `ecological` can never be matched by a job typed `ecology`.

The report-type keyword map is duplicated **seven times** with divergent contents: `fiDetectionService.js:538-547, 680-715, 1039-1046, 1147-1153, 1252-1261, 1605-1614` and `docfilesService.js:241-248`.

### 2.3 HIGH — A rate-limit burst silently zeroes a night's matches

`runChat` (`fiDetectionService.js:328-367`) retries only on `APITimeoutError` and `ECONNRESET`. A 429 or 5xx throws immediately, is caught at `scanJobProcessor.js:1087-1094`, and becomes `stage: 'detection-error'`, `isMatch: false` — indistinguishable from a genuine non-match.

### 2.4 HIGH — Unguarded parse crashes on a text-only completion

```js
// fiDetectionService.js:346 — and duplicated at docfilesService.js:160
JSON.parse(response.choices[0].message.function_call.arguments)
```

If the model returns a message rather than a function call, `.function_call` is `undefined` and this throws `TypeError`. The retry handler at `:356` only catches `SyntaxError`, so the error propagates and the document is lost as `detection-error`.

### 2.5 MEDIUM — The AI can only reduce recall, never improve it

In `matchFIRequestType`, an AI "yes" is overridden unless a **deterministic regex** (`extractValidationQuote`, `:1171-1522`) independently produces a quote that passes `isValidCustomerEvidence` (`:1096-1165`). The result is `matches: false` with `aiConfirmedMatchButWeakEvidence: true` (`:1064-1072`).

The `needsReview` flag this produces (`scanJobProcessor.js:1074`) is written into the return object and **never persisted or surfaced anywhere**. Recall failures are therefore invisible and unmeasurable.

### 2.6 MEDIUM — The two AI paths encode opposite policies

`SYSTEM_FI_DETECT` and `SYSTEM_FI_MATCH` explicitly **accept** consultee recommendations as valuable leads. `SYSTEM_DOCFILES_FI_ANALYSIS` (`docfilesService.js:45-97`) explicitly **rejects** third-party and consultee recommendations. Which policy applies depends only on whether `docfiles.txt` exists for the project (`fiDetectionService.js:1955-2044`).

### 2.7 MEDIUM — All confidence values are fabricated

The model is never asked for a confidence score in the FI detection path. Every stored `confidence` is a hardcoded constant: `0.95` (`scanJobProcessor.js:1060`), `0.9` (`fiDetectionService.js:2127`), `0.5` for weak evidence (`scanJobProcessor.js:1072`), `0.8` default (`:2353`). Ranking, thresholding or reporting on these numbers is meaningless.

### 2.8 Stage-3 vision detection cannot work

`aiVisionService.extractFirstPageAsImage()` (`:76-105`) is an acknowledged stub — its own comments say a PDF-to-image library is still needed. It returns **PDF bytes** which are then sent as `image_url: data:image/png;base64,…` (`:45`). Every call fails, and the failure is swallowed at `:62-70` returning `{isAcoustic: false, confidence: 0}`.

### 2.9 Test coverage is effectively zero

One jest test exists in the entire backend: `backend/services/__tests__/s3Service.cleanupOldBaselineMarkers.test.js`. All AI "tests" are manual scripts printing to console with no assertions and no exit codes, not wired into CI. Two are broken:

- `scripts/verify-layer2-passes.js:9` destructures methods off the singleton, losing `this` — they throw on `this.runChat`.
- `scripts/test-fi-filtering.js:117` **re-implements** `shouldRejectByFilename` locally instead of importing it, so it validates a copy that can drift from the real function.

---

## 3. Duplicate and false-positive results

### 3.1 CRITICAL — Completed work delivered as a live lead

Report `FI_1786352405931_fmnr44qki`, 2026-08-10, delivered project **403501** to `sean.rocks@wdacoustics.com`, `tenders@wdacoustics.com`, `james.cousins@wdacoustics.com`. Both matched documents:

```
20e72bd350d45c69b39b93cb7fa2e9e6-noisevibrationassessment-rfinote.pdf
fe449bfc8c69c36525829d2786e6eacb-noisevibrationassessment-rfinote_-1-.pdf

quote: "this report responds to items relating to noise within the request
        for further information (rfi) under council ref. pf/0422/26"
```

That is a **completed acoustic report answering the RFI** — sold as a new opportunity to an acoustics consultancy. The same project was delivered to three other customers in the same run (`FI_1786352409047_uzg2k3ma4`, `FI_1786352408024_eurxd1bia`, `FI_1786352407087_5860m1l5i`).

Further confirmed instances:

| Project | Document | Quote | Reality |
|---|---|---|---|
| 406529 | `…noiseimpactassessmentfiresponse.pdf` | *"wave dynamics have been engaged by … to undertake a … noise impact assessment"* | Work already awarded |
| 401040 | `environmental-health-response-03.03.2026.pdf` | *"lester acoustics … the environmental health department have had the chance to review the document"* | Consultee reviewing a submitted report |
| 359353 | 4 × `…_PlanningReport.pdf` | *"the applicant **has provided** a noise impact assessment"* | FI already satisfied |
| 384778 | `…Env_Enf_FI.docx` (2026-06-18) | *"the applicant **was requested** to provide…"* | Response quoting the original request of 2026-05-21 |
| 421691 | `…pre-planningresponse….pdf` | *"the applicant **proposes to submit** a noise impact assessment"* | Already engaged |

**Root cause.** `processDocument` never calls `fiDetectionService.shouldRejectByFilename()` (`fiDetectionService.js:472-529`), which already contains `fi_response`, `rfi_response`, `fi_submission`, `substantive-reply`. The live path uses a weaker 9-entry inline list (`scanJobProcessor.js:961-971`) containing `'fi response'` **with a space** — so `…firesponseletter.pdf` and `…noiseimpactassessmentfiresponse.pdf` pass straight through to full AI analysis, where the embedded quotation of the original request scores as a request.

### 3.2 HIGH — Duplicates have three distinct causes

Only the first is the FI-response case:

1. **Response documents matching as requests** — §3.1.
2. **Councils republishing identical FI text** across several report documents. Project 408961 delivered `Planner-Report--2---SEP-.pdf`, `Environment-Report--1-.pdf` and `Planner-Report--1-.pdf` whose quotes differ only by OCR noise (`c ontrol` / `control` / `relate d`). Same for 389003, 402023, 390717.
3. **The same project re-matching months apart.** Project 395085 matched 2026-05-22 and again 2026-08-08; 412562 matched on three separate dates. Dedup is keyed `projectId::fileName` and only spans the delivery window (`scanJobProcessor.js:1772-1783`), so there is **no historical suppression**.

### 3.3 HIGH — Email, stored report and audit export disagree

`emailService.js:410` is the **only** project-level dedup in the codebase:

```js
if (!matchesByType[reportType][match.projectId]) { … }
```

It is **first-wins by array order** — no confidence, recency or evidence ranking. Whichever file S3 happened to return first supplies the customer's quote. If the FI response is scanned first, the customer sees the response's quote and the genuine request is discarded.

Meanwhile `FIReport.projectsFound` is built with `customerData.matches.map(...)` (`scanJobProcessor.js:1339-1357`) — **one entry per file, no dedup at all**. So the stored record, the UI details modal (`reports-list.component.ts:202`) and the plain-text audit export (`routes/reports.js:196-219`) all show 2–4 entries for a project where the email showed one. **This is the artefact users are reporting.**

### 3.4 MEDIUM — Resend cannot deselect a duplicate

The resend modal collects project IDs only (`reports-list.component.ts:939`) and `routes/reports.js:397-399` filters `projectsFound` by `projectId`. With two entries sharing project 1234, unticking one keeps both — the selection is unrepresentable.

---

## 4. Concurrency and state hazards

1. **Every cron fires twice.** `ecosystem.config.js` runs `fi-email-backend` with `instances: 2` in cluster mode, while `documentRegisterScheduler.isRunning` (`:101`), `dailyRunService.isScanning` (`:19`) and `scheduledJobManager` all guard with **in-process booleans**. Two instances write the same `document-register-<date>.csv` concurrently via two `createWriteStream`s (`:212`), interleaving the output.
2. **Ingestion idempotence is in-memory too.** `ingestionScheduler.js:61-70` guards on `isRunning` and `lastRunDate`; a restart resets both.
3. **Both ingestion jobs fail silently.** `ingestionScheduler.js:126-130, 149-151` wrap everything in `try/catch { logger.error }` — the routing and cleanup jobs can fail completely with no alert, no retry and no persisted state. Next attempt is 24 hours later.
4. **Temp files race with cleanup.** `diskCleanupService` deletes anything in `backend/temp` older than 1 hour (`:87-96`), and `forceCleanup()` (`:197-207`) deletes everything — while `scanJobProcessor.js:860-872` is actively writing temp PDFs there. `forceCleanup` is reachable from the CLI (`document-register/index.js:459`).
5. **A stale Bull job blocks all future enqueues** for that jobId (`scanJobQueue.js:106-109`).
6. **Per-document `ScanJob.findOne()`** purely to check a cancel flag (`scanJobProcessor.js:352`) — millions of queries per night, and a DB blip throws into the error handler that aborts the whole stream (`:559-574`).

### Silent failures that report success

| Site | Behaviour |
|---|---|
| `emailService.js:394-397` | Returns `{success: true, skipped: true}` when every match lacks BII metadata. Caller (`scanJobProcessor.js:1317`) counts `emailsSent++` and writes an `FIReport` with `status: 'SENT'`. **An email that was never sent is recorded as delivered.** |
| `scanJobProcessor.js:1887-1890` | `deliverResultsForJob` marks all daily results `delivered: true` even when `sendMatchEmails` threw (`:1406-1408`) |
| `scanJobProcessor.js:1160-1180` | Matches with placeholder quotes are dropped from the email with no record |
| `scanJobProcessor.js:1819-1822` | `PendingMetadataMatch` becomes `EXPIRED` after 4 retries — permanently dropped, never emailed, no alert. Production currently holds 1 EXPIRED, 2 PENDING, 1 RESOLVED |
| `documentIngestionService.js:199-208, 245-254` | Copy failures collected into `result.errors[]` and only logged. No retry, no dead-letter |
| `dailyRunService.js:130-156` | `insertMany({ordered:false})` swallows duplicate-key errors but increments counters by full batch length, so `counters.queued` never reaches 0 and the run never completes |

---

## 5. Ranked remediation backlog

**Tier 1 — in scope for the current fix pass**

| # | Finding | Section |
|---|---|---|
| 1 | FI responses delivered as leads → project-level veto | 3.1 |
| 2 | Matches lost on resume; resumed scan covers wrong day | 1.1 |
| 3 | Missing resume marker skips whole day, reports success | 1.2 |
| 4 | `"kind regards"` and friends rejecting genuine requests | 2.1 |
| 5 | Duplicate rows: email / report / audit export disagree | 3.3 |
| 6 | Daily re-run overwrites complete result with partial | 1.5 |
| 7 | Re-issued documents destroyed by filename-only dedup | 1.3 |
| 8 | Cleanup deletes never-routed files | 1.4 |
| 9 | Report-type enum drift; keyword map duplicated 7× | 2.2 |
| 10 | `runChat` crash on text completion; no 429/5xx retry | 2.3, 2.4 |
| 11 | Silent successes: `SKIPPED` status, `needsReview`, coverage logging | 4 |

**Tier 2 — the reliability subset shipped in the Phase 2 pass (§7); the rest still open**

| # | Finding | Section | Status |
|---|---|---|---|
| 12 | Cluster mode fires every cron twice | 4.1 | **Done** |
| 13 | No backfill for missed days | 1.6 | **Done** |
| 14 | Text truncation hides late-document FI requests; dead page filter | 1.8 | Open |
| 15 | Jobs stuck PAUSED with no alerting or dead-letter | 1.9 | **Done** |
| 16 | Baseline markers excluding 60% of documents — verify cleanup | 1.10 | **Done** |
| 17 | Stage-3 vision service non-functional | 2.8 | Open |
| 18 | Contradictory policies between docfiles and per-document AI paths | 2.6 | Open |
| 19 | Fabricated confidence values | 2.7 | Open |
| 20 | Format exclusions (`.doc`, `.msg`, `.eml`), 25MB cap, 25s timeout | 1.7 | Open |
| 21 | Resend cannot deselect duplicates | 3.4 | **Done** |
| 22 | `DailyRun` counter drift leaves runs permanently `processing` | 4 | **Done** |
| 23 | Broken test scripts; no CI coverage for AI logic | 2.9 | Open |
| 24 | `scheduledJobManager.js:491, 744, 754` call methods that don't exist on `fiDetectionService` | — | **Done** |
| 25 | `S3_BUCKET` vs `S3_BUCKET_NAME` env split between scanner and services | — | **Done** |

---

## 6. Outcome of the Tier 1 fix pass

Measured by replaying the new logic over the stored production results, read-only
(`node scripts/audit-duplicate-results.js`):

| Measure | Before | After |
|---|---|---|
| Projects with more than one matched file | **52** | **0** |
| Duplicate rows removed from delivery | — | 66 |
| Matches vetoed as FI responses | 0 | 11 (6 by filename, 5 by content) |
| Projects fully suppressed | 0 | 10 |
| Matches surviving to delivery | 304 | 285 |

Project **403501** — the completed acoustic report delivered to WD Acoustics — is fully
suppressed, as are 406529, 405998, 359353, 411230, 401040, 383212, 385400 and 421691.

The veto was deliberately calibrated down twice against real data. A first version
suppressed 23 projects, but three of those were false positives worth understanding:

- Irish councils publish their own consultee reports under names that read as
  deliverables — `FW25A.0216E_Air_and_Noise_Report.pdf` (383115) *contains* the request
  *"a noise impact assessment (NIA) shall be carried out by the applicant"*. A filename
  that merely looks like a deliverable is now only a hint, overturned when the content
  requests the report.
- OCR splits words unpredictably. Project 403501 reads *"this report respond s to"* and
  389452 reads *"the air and noise unit recommend s that"*, neither of which literal
  phrase matching catches. Marker matching now also runs against the text with
  whitespace removed.
- A file named `Request-for-Further-Information.pdf` (418804) was vetoed on the phrase
  *"the submitted environmental audit"* — which is not the acoustic report at all. A
  filename declaring the document to be a request now blocks the weaker content markers.

Three suppressed rows still read as genuine requests when viewed alone. All three are
correct under the agreed rule: 411230 has *"the applicant has appointed an acoustic
consultant and environmental health await submission of an acoustic report"*, and 399460
has *"reviewed the details submitted as part of the further information response"*. In
both the work is already awarded, so the lead is dead even though an earlier document in
the same project asked for the report.

Regression cover for all of the above is in
`backend/services/__tests__/fiResponseVeto.test.js` (30 tests, `npm test`), built from the
real stored quotes and filenames rather than synthetic examples.

**Not addressed in this pass** — Tier 2 above remains open, most importantly the absence
of any backfill for missed days (§1.6) and the double-firing crons under cluster mode
(§4.1). Both are addressed in §7.

---

## 7. Outcome of the Phase 2 (Tier 2 reliability) pass

Scope was the subset of Tier 2 that silently loses leads or corrupts state: items
**12, 13, 15, 16, 21, 22, 24, 25**. Recall work (14, 20), AI quality (17, 18, 19) and
CI/test hygiene (23) were explicitly deferred to a Phase 3.

| Item | Change | Commit |
|---|---|---|
| 25 | `backend/utils/awsConfig.js` — one resolver for bucket and region; boot asserts refuse to start when two spellings disagree | `6406d3d` |
| 24 | Deleted `executeReportGeneration`, `executeFIDetection`, `createPreprocessSchedule` and the pre-processing triggers (−386 lines); retired job types blocked at creation and at boot | `829c7a3` |
| 12 | `models/JobLock.js` + `services/jobLock.js` (`withLock`) and `utils/clusterRole.js`; 8 locked call sites; atomic `.part`→rename for the register CSV | `12e68c0` |
| 22 | `$inc` by the count that actually inserted; `reconcileCounters()`; `checkRunCompletion` counts items, not counters; `POST /api/runs/:runId/reconcile` | `c878297` |
| 15 | `ScanJob.recovery` sub-doc; `sweepStuckJobs()` every 15 min; dead-letter drain; `emailService.sendJobAlertEmail()`; per-`targetDate` Bull keys | `f99ac3a` |
| 13 | `ScanJobDailyResult.scanAttempts`; `findCoverageGaps()`, `enqueueBackfill()`, `buildDeliveryWindowFilter()` | `7111c35` |
| 16 | `hasBaselineMarker` fails closed and counts failures; single retention constant; marker written **before** the copies; ingestion jobs now alert | `025bb23` |
| 21 | `selectProjectsForResend()` keyed on the subdocument `_id`; both modals send `includedMatchIds`; cards show the document name | `1310d60` |

Three defects were found while writing the tests, and are worth recording because each
would have shipped as a new bug:

- **The sweeper would have started jobs nobody enabled.** `status` defaults to `PAUSED`
  on the schema, so "PAUSED" means both "the worker failed this" and "an admin created
  this and never turned it on". The recovery query now also requires
  `recovery.consecutiveFailures >= 1`.
- **Backfill could never have looked past yesterday.** The gap horizon was
  `min(lookbackDays, 14)`, and `lookbackDays` is 1 on essentially every job — so the
  horizon collapsed to the single day the nightly run had just enqueued. `lookbackDays`
  governs *delivery* aggregation; coverage is now bounded by `SCAN_BACKFILL_HORIZON_DAYS`
  alone.
- **Day keys drifted by one on any non-UTC host.** `scanDate` is normalised with
  `setHours(0,0,0,0)` (local midnight) but keys were formatted with `toISOString()`.
  Agrees on a UTC server, off by a day anywhere else.

Test coverage went from 35 tests in 2 suites to **161 tests in 11 suites**, all offline
(no mongo, no redis, no S3, no OpenAI). `npm test` in `backend/` also exits cleanly now:
`emailService` calls `dotenv.config()` at import and verified its SMTP transport, which
left a live socket open and hung the runner.

### Rollout order

Each phase is independently deployable, in commit order. Two need care:

1. **`ecosystem.config.js` changed** — needs `pm2 delete fi-email-backend && pm2 start
   ecosystem.config.js`. `pm2 reload` does not pick up env changes.
2. **Backfill ships disabled.** Run `node backend/scripts/audit-scan-coverage.js` first:
   it reports the gap list *and* how many undelivered rows the widened delivery window
   would sweep into the next send. If that number is large, backdate `delivered: true`
   on rows older than the horizon before setting `SCAN_BACKFILL_ENABLED=true`, or the
   first night dumps weeks of stale leads on customers.

New environment variables, all with safe defaults: `SCAN_BACKFILL_ENABLED` (off),
`SCAN_BACKFILL_HORIZON_DAYS` (14), `SCAN_BACKFILL_MAX_DAYS_PER_NIGHT` (1),
`SCAN_STUCK_SWEEP_ENABLED` (on), `SCAN_MAX_AUTO_RECOVERY` (3), `ALERT_COOLDOWN_HOURS`
(6), `ALERT_EMAIL`, `BASELINE_MARKER_RETENTION_DAYS` (2), `SCHEDULERS_ENABLED` (on).

### Read-only verification scripts

```sh
node backend/scripts/audit-scan-coverage.js        # gap list + undelivered backlog
node backend/scripts/audit-scheduled-jobs.js       # retired job types still active
node backend/scripts/reconcile-daily-runs.js       # DailyRun counter drift (dry run)
node document-register/audit-baseline-markers.js   # stale marker count
node backend/scripts/audit-duplicate-results.js    # Tier 1 — must not regress
```

**Still open after this pass:** items 14, 17, 18, 19, 20 and 23 — the recall and AI-quality
work. The `"kind regards"` class of false negative was fixed in Tier 1, but text
truncation (§1.8) and the silent format/size/timeout exclusions (§1.7) remain the most
likely remaining causes of the 0.13% match rate.

## Appendix — reproducing the evidence

All queries are read-only. Collection and field names:

```js
// Projects with more than one matched file
db.scanjobdailyresults.aggregate([
  { $unwind: '$matches' },
  { $group: { _id: { projectId: '$matches.projectId', fiType: '$matches.fiType' },
              files: { $addToSet: '$matches.fileName' },
              rows:  { $push: { f: '$matches.fileName', q: '$matches.validationQuote' } } } },
  { $addFields: { n: { $size: '$files' } } },
  { $match: { n: { $gt: 1 } } }
])

// What the customer actually received
db.fi_reports.aggregate([
  { $unwind: '$projectsFound' },
  { $group: { _id: { reportId: '$reportId', projectId: '$projectsFound.projectId' },
              docs: { $addToSet: '$projectsFound.metadata.documentName' } } },
  { $addFields: { n: { $size: '$docs' } } },
  { $match: { n: { $gt: 1 } } }
])
```

A reusable dry-run version is kept at `backend/scripts/audit-duplicate-results.js`.
