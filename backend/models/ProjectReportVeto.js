const mongoose = require('mongoose');

// A project that must never be delivered for a given report type, because one of its
// documents is a response to - rather than a request for - that report.
//
// Once an FI response, submission or consultee review of the target report exists, the
// work has already been commissioned or completed and the project is no longer a lead.
// Production report FI_1786352405931_fmnr44qki sent project 403501 to an acoustics
// consultancy on the strength of two files that were themselves the completed acoustic
// report answering the RFI.
//
// This is persisted rather than evaluated inline because the response usually arrives on
// a different day than the request - 28 days apart for project 384778 - while the scan
// window is a single day. A veto recorded on any day suppresses the project on every
// later delivery run.
//
// Scoped per report type: a transport response must not suppress an acoustic lead.
const ProjectReportVetoSchema = new mongoose.Schema({
  projectId: {
    type: String,
    required: true,
    index: true
  },
  // Canonical report type, as produced by services/reportTypes.normalizeReportType
  reportType: {
    type: String,
    required: true
  },
  // Which layer of classifyFIResponse fired: 'filename' | 'hard-marker' | 'contextual-marker' | 'ai'
  source: String,
  // Human-readable explanation, shown in audits
  reason: String,
  evidenceFileName: String,
  evidenceFilePath: String,
  // The text that triggered the veto, for review
  evidenceQuote: String,
  detectedAt: {
    type: Date,
    default: Date.now
  },
  // Job that observed the response, for traceability. Not part of the key: a veto
  // applies to the project regardless of which job found it.
  detectedByJobId: String
}, {
  timestamps: true
});

ProjectReportVetoSchema.index({ projectId: 1, reportType: 1 }, { unique: true });

module.exports = mongoose.model('ProjectReportVeto', ProjectReportVetoSchema);
