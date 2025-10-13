# Quick Reference: Document Register Pre-Scan Count

## New Feature: Quick Count Before Full Scan

The document register now shows you the total project and document counts **BEFORE** running the full scan!

## How It Works

### Option 1: Automatic (During Generate)

When you run `generate`, you'll automatically see a pre-scan count:

```bash
node document-register/index.js generate
```

**Output:**
```
🚀 Generating document register...

═══════════════════════════════════════════════════
  PRE-SCAN: Quick Count
═══════════════════════════════════════════════════
📊 Getting quick count of projects and documents...
📂 Total projects in planning-docs: 4567
🔢 Counting documents (this may take a moment)...
   Progress: 500/4567 projects counted (5234 documents so far)
   Progress: 1000/4567 projects counted (10789 documents so far)
   ...
✅ Count complete: 45678 documents across 4567 projects (avg: 10.00 docs/project)

📊 ESTIMATED TOTALS:
   Projects:  4,567
   Documents: 45,678
   Average:   10.00 docs per project

═══════════════════════════════════════════════════
  FULL SCAN: Starting detailed document scan...
═══════════════════════════════════════════════════

🔍 Starting document register scan...
📂 Found 4567 projects in planning-docs
...
```

### Option 2: Standalone Count Command

Get just the count without generating the full register:

```bash
node document-register/index.js count
```

**Output:**
```
📋 Document Register CLI

🔢 Counting projects and documents in planning-docs...

📊 Getting quick count of projects and documents...
📂 Total projects in planning-docs: 4567
🔢 Counting documents (this may take a moment)...
   Progress: 500/4567 projects counted (5234 documents so far)
...
✅ Count complete: 45678 documents across 4567 projects (avg: 10.00 docs/project)

✅ Count Complete!

📊 Totals:
   Projects:  4,567
   Documents: 45,678
   Average:   10.00 documents per project
```

### Option 3: Via API

```bash
GET http://localhost:3001/api/document-register/count
```

**Response:**
```json
{
  "success": true,
  "data": {
    "totalProjects": 4567,
    "totalDocuments": 45678,
    "averageDocsPerProject": "10.00"
  }
}
```

## Why Is This Useful?

1. **Know Before You Commit** - See the scope before running the full scan
2. **Estimate Time** - Gauge how long the full scan will take
3. **Verify Pagination** - Confirm you're getting ALL projects (not capped at 1000)
4. **Quick Check** - Fast way to check S3 bucket status without full processing

## Performance

- **Quick Count**: ~30-60 seconds for 1000s of projects
- **Full Scan**: ~20-40 minutes for 1000s of projects with full document metadata

The quick count is much faster because it only counts documents, it doesn't:
- Download document metadata
- Process file details
- Sort by date
- Generate exports

## Skip the Pre-Scan

If you want to skip the automatic pre-scan during generation (for automation):

```javascript
// In code:
await documentRegisterService.generateRegister(skipQuickCount = true);
```

## Commands Summary

| Command | Purpose | Speed |
|---------|---------|-------|
| `count` | Quick count only | ⚡ Fast (30-60s) |
| `generate` | Count + full scan + exports | 🐌 Slow (20-40min) |
| `status` | Show last scan metadata | ⚡⚡ Instant |
| `stats` | Show detailed statistics | ⚡⚡ Instant |

## Example Usage

```bash
# 1. First, check the totals
node document-register/index.js count

# 2. If counts look good, run full scan
node document-register/index.js generate

# 3. Check the results
node document-register/index.js stats
```

## What You'll See

The count feature shows:
- ✅ Total number of projects in `planning-docs/`
- ✅ Total number of documents across all projects
- ✅ Average documents per project
- ✅ Progress updates every 500 projects
- ✅ No 1000-project limit (thanks to pagination!)

Enjoy! 🎉
