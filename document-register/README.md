# Document Register

A comprehensive document tracking and management system for all projects in AWS S3 `planning-docs` folder.

## Overview

The Document Register maintains a live inventory of all documents across all projects, tracking:
- File metadata (name, path, size, last modified)
- Project organization
- Document types
- Update history

Documents are sorted by **most recent updates first**, so the latest changes are always at the top.

## Features

- 📊 **Complete Inventory**: Tracks all documents in all projects
- 🔄 **Update Tracking**: Sorts by most recent modifications
- 📈 **Statistics**: Document counts, project stats, top updated projects
- 💾 **Multiple Formats**: Exports to CSV and XLSX (Excel)
- 🚀 **Fast Processing**: Efficient S3 scanning with metadata caching
- 🔌 **API Integration**: RESTful API endpoints for programmatic access
- 🖥️ **CLI Tool**: Command-line interface for manual operations
- 🧹 **S3 Cleanup**: Remove outdated/unneeded projects from AWS (NEW!)
- 📦 **Auto Batching**: Large files automatically split for Google Sheets

## File Structure

```
document-register/
├── index.js                       # CLI tool for register generation
├── cleanup-s3.js                  # NEW: S3 cleanup tool
├── documentRegisterService.js     # Core service
├── 2025_ids.csv                   # Your approved project IDs (create this)
├── README.md                      # This file
├── S3-CLEANUP.md                  # Cleanup tool documentation
├── S3-CLEANUP-QUICKSTART.md       # Quick start guide
├── BATCHING.md                    # Large file batching guide
└── outputs/
    ├── document-register.csv      # CSV export (or batched files)
    ├── document-register.xlsx     # Excel export (or batched files)
    ├── document-register-INDEX.txt # Batch index (if batched)
    ├── deletion-list.txt          # S3 cleanup list (after dry-run)
    └── register-metadata.json     # Scan metadata & stats
```

## Installation

Install required dependencies:

```bash
cd document-register
npm install csv-parser
```

## Tools

### 1. Document Register (Inventory)

Generate comprehensive inventory of all S3 documents.

### 2. S3 Cleanup (NEW!)

Remove unwanted projects from S3 to keep only approved IDs.

**Quick Start:**
```bash
# 1. Create 2025_ids.csv with your approved project IDs
# 2. Preview what will be deleted
node cleanup-s3.js --dry-run

# 3. Execute cleanup
node cleanup-s3.js --execute
```

See [S3-CLEANUP-QUICKSTART.md](./S3-CLEANUP-QUICKSTART.md) for details.

## Usage

### Via CLI

```bash
# Quick count (fast preview of totals)
node document-register/index.js count

# Generate document register (includes pre-scan count)
node document-register/index.js generate

# Check status
node document-register/index.js status

# View statistics
node document-register/index.js stats

# Show help
node document-register/index.js help
```

### Via API

Make sure your backend server is running, then use these endpoints:

#### 1. Quick Count (NEW!)

Get a fast count of projects and documents without generating the full register:

```bash
GET http://localhost:3001/api/document-register/count
```

Response:
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

#### 2. Generate Document Register

```bash
POST http://localhost:3001/api/document-register/generate
```

Response:
```json
{
  "success": true,
  "message": "Document register generated successfully",
  "data": {
    "totalDocuments": 15234,
    "totalProjects": 456,
    "processingTime": 12345,
    "outputs": {
      "csv": "/path/to/document-register.csv",
      "xlsx": "/path/to/document-register.xlsx",
      "metadata": "/path/to/register-metadata.json"
    },
    "topProjects": [...],
    "scanDate": "2025-10-09T12:00:00.000Z"
  }
}
```

#### 2. Get Status

```bash
GET http://localhost:3001/api/document-register/status
```

#### 3. Download Files

```bash
# Download CSV
GET http://localhost:3001/api/document-register/download/csv

# Download XLSX
GET http://localhost:3001/api/document-register/download/xlsx
```

#### 4. Get Statistics

```bash
GET http://localhost:3001/api/document-register/stats
```

## Output Files

### CSV Export
- Plain text format
- Easy to import into databases
- Columns: Project ID, File Name, File Path, File Size, Last Modified, Document Type, Extension

### XLSX Export
- Excel workbook with 2 sheets:
  1. **Document Register**: Full document list (sorted by most recent)
  2. **Summary**: Statistics and top document types
- Formatted columns with auto-sizing
- Ready for Excel analysis

### Metadata JSON
- Tracks scan history
- Project-level statistics
- Document counts per project
- Last update timestamps

## Document Sorting

**Documents are sorted by Last Modified date in DESCENDING order:**
- Newest updates appear at the top
- Oldest documents appear at the bottom
- Projects with recent activity are easy to identify

## Document Type Detection

The system automatically detects document types based on filenames:

- **FI Request**: Further Information requests
- **FI Response**: Responses to FI requests
- **Planning Application**: Application forms
- **Decision Notice**: Planning decisions
- **Report**: Assessments, statements, studies
- **Drawing**: Plans, elevations, sections
- **Supporting Document**: Appendices, annexes
- **Correspondence**: Letters, emails
- **Metadata**: docfiles.txt and other metadata

## Performance

- **Initial Scan**: ~10-30 seconds for 1000 projects (depends on S3 response time)
- **Incremental Updates**: Metadata tracking enables faster future updates
- **Memory Efficient**: Streams data from S3 without loading all files

## Future Enhancements

- ✅ **Incremental Updates**: Only scan changed projects (metadata foundation ready)
- 🔄 **Background Sync**: Continuous monitoring with scheduled updates
- 📊 **Change History**: Track document additions/removals over time
- 🔍 **Document Classification**: ML-based document type detection
- 📧 **Email Alerts**: Notify on significant changes
- 🎯 **Project Filtering**: Filter by region, type, date range

## Integration

The Document Register integrates with:
- **S3 Service**: Uses existing `s3Service` for AWS operations
- **Logger**: Winston logging for all operations
- **Backend API**: Express routes for HTTP access
- **Document Processor**: Can leverage document analysis capabilities

## Example Use Cases

1. **Audit Trail**: Track when documents were added/modified
2. **Project Monitoring**: Identify recently updated projects
3. **Data Analysis**: Export to Excel for reporting
4. **Compliance**: Maintain complete document inventory
5. **Integration**: Feed data to other systems via API

## Troubleshooting

**No documents found:**
- Check AWS credentials in `.env`
- Verify S3 bucket access
- Ensure `planning-docs` folder exists

**Slow scanning:**
- Normal for large projects (1000s of docs)
- Check network connection to AWS
- Consider running during off-peak hours

**XLSX export fails:**
- Ensure `xlsx` package is installed: `npm install xlsx`
- Check write permissions in `document-register/outputs/`

## API Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/document-register/generate` | Generate new register |
| GET | `/api/document-register/status` | Get current status |
| GET | `/api/document-register/stats` | Get detailed statistics |
| GET | `/api/document-register/download/csv` | Download CSV file |
| GET | `/api/document-register/download/xlsx` | Download XLSX file |

## License

Part of FI Email Automation system.
