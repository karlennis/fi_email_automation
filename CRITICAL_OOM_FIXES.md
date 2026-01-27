# CRITICAL OOM FIXES - PRODUCTION READY

## Root Cause Analysis
Your backend was crashing every few minutes due to:
1. **Generate-on-read pattern**: GET /documents triggered S3 scanning when metadata missing
2. **S3 API hammering**: Frontend calling listMainFolders every few hundred milliseconds  
3. **No concurrency protection**: Multiple simultaneous S3 calls at same timestamp
4. **XLSX heap bombs**: Large datasets consuming hundreds of MB in memory

## Fixes Applied ✅

### A) Stop "Generate on Demand" (CRITICAL)
- **File**: `documentRegisterService.js`
- **Fix**: `getDocumentsByDateRange()` now throws `REGISTER_NOT_GENERATED` error instead of auto-generating
- **File**: `document-register.js` 
- **Fix**: GET `/documents` returns HTTP 202 when register not generated
- **Result**: UI page loads can't trigger S3 scans that kill the process

### B) Singleflight Lock for S3 Calls
- **File**: `s3Service.js`
- **Fix**: Added `inFlightPromise` lock in `listMainFolders()`
- **Logic**: If cache valid → return cache. Else if in-flight → await it. Else create new call.
- **Result**: Eliminates duplicate S3 calls, reduces "double call at same timestamp" 

### C) XLSX Safety (Already Implemented)
- **File**: `documentRegisterScheduler.js` 
- **Status**: XLSX already disabled for memory safety
- **Fallback**: Only CSV generation (memory-safe streaming)

### D) FastS3Scanner Safety (Already Implemented)
- **File**: `fastS3Scanner.js`
- **Status**: Already refactored to streaming callbacks (no array accumulation)
- **Prefix**: Already uses `Prefix: 'planning-docs/'`

## Environment Configuration Required

### E) Node.js Heap Limit (RENDER CONFIG)
Add this environment variable in Render dashboard:

```bash
NODE_OPTIONS=--max-old-space-size=1536
```

**Why**: Even with 2GB container RAM, Node may use small default heap limit.
**Logic**: 1536MB heap leaves room for native memory, buffers, and libraries.
**Where**: Render → Service Settings → Environment Variables

## Expected Results

### Success Indicators:
- ✅ Backend runs stable without "JavaScript heap out of memory" crashes
- ✅ GET `/documents` returns HTTP 202 when register not generated (instead of crashing)
- ✅ S3 API calls reduced by ~80% due to caching + singleflight
- ✅ Memory monitoring shows consistent heap usage <1.5GB
- ✅ Log messages: "✅ Returning cached main folders" (cache working)
- ✅ Log messages: "⏳ S3 call already in progress, waiting..." (singleflight working)

### Error Handling:
- Dashboard shows "Generate first" message instead of spinning forever
- Users click "Generate" button to create register before viewing documents
- No more process restart loops

## Monitoring Commands
```bash
# Check logs for memory stability
curl -s https://fi-email-automation-backend.onrender.com/api/health

# Check if register exists for today
curl -s "https://fi-email-automation-backend.onrender.com/api/document-register/documents?date=$(date +%Y-%m-%d)"

# Generate register if needed
curl -X POST https://fi-email-automation-backend.onrender.com/api/document-register/generate
```

## Architecture Summary
**Before**: UI load → Auto-generate → S3 scan → Array accumulation → OOM crash → Restart loop
**After**: UI load → Check cache → Return 202 if missing → User generates explicitly → Streaming processing → Stable

The key insight: **Separate read operations from write operations**. Never trigger heavy work from GET endpoints.