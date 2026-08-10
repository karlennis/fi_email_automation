/**
 * Canonical report-type taxonomy and keyword vocabulary.
 *
 * Before this module the report-type keyword map was duplicated seven times across
 * fiDetectionService and docfilesService with divergent contents, and three different
 * enums were in use (Customer/ScheduledJob, ScanJob/UI, and the quote-validation map).
 * A ScanJob typed `ecology` found no entry in the quote map (which spelled it
 * `ecological`) and silently degraded to a literal substring test; `contamination`
 * and `other` had no entry anywhere.
 *
 * Three vocabularies are kept deliberately separate because they are used at
 * different precision points and must not be merged:
 *
 *   documentTerms - broad recall, used to gate a whole document. May contain loose
 *                   terms like "db" or "environment" that would be far too weak to
 *                   justify a customer-facing match on their own.
 *   quoteTerms    - high precision, used to validate the short quote shown to the
 *                   customer. Deliberately excludes the loose terms above.
 *   filenameTerms - matched against a filename only.
 */

// Canonical spelling for each report type. Aliases resolve to these.
const CANONICAL_REPORT_TYPES = [
  'acoustic',
  'transport',
  'ecological',
  'flood',
  'heritage',
  'arboricultural',
  'waste',
  'lighting',
  'contamination',
  'other'
];

// ScanJob.documentType and the UI use `ecology`; Customer.reportTypes uses `ecological`.
// Both must resolve to the same vocabulary or the two never match.
const REPORT_TYPE_ALIASES = {
  ecology: 'ecological',
  ecologic: 'ecological',
  biodiversity: 'ecological',
  noise: 'acoustic',
  sound: 'acoustic',
  traffic: 'transport',
  drainage: 'flood',
  archaeology: 'heritage',
  archaeological: 'heritage',
  arboriculture: 'arboricultural',
  trees: 'arboricultural',
  contaminated: 'contamination',
  'contaminated land': 'contamination'
};

const VOCABULARY = {
  acoustic: {
    documentTerms: [
      'noise', 'sound', 'decibel', 'db', 'vibration', 'noise assessment', 'sound level', 'acoustic',
      'noise impact', 'nia', 'nir', 'bns', 'background noise', 'noise survey', 'acoustic survey',
      'sound insulation', 'noise mitigation', 'ambient noise', 'plant noise'
    ],
    quoteTerms: ['noise', 'sound', 'acoustic', 'decibel', 'db', 'vibration'],
    filenameTerms: ['noise', 'sound', 'acoustic', 'decibel', 'audio', 'vibration']
  },
  transport: {
    documentTerms: [
      'traffic', 'vehicle', 'highway', 'road', 'parking', 'transport assessment', 'car park', 'mobility',
      'transport', 'ta', 'tia', 'traffic impact', 'travel plan', 'tp', 'access', 'junction', 'pedestrian', 'cycle'
    ],
    quoteTerms: ['traffic', 'vehicle', 'highway', 'road', 'parking', 'transport', 'mobility'],
    filenameTerms: ['traffic', 'transport', 'parking', 'vehicle', 'highway', 'road', 'mobility']
  },
  ecological: {
    documentTerms: [
      'ecology', 'wildlife', 'habitat', 'species', 'biodiversity', 'environment', 'ecological', 'nature',
      'flora', 'fauna', 'eia', 'bng', 'biodiversity net gain', 'pea', 'preliminary ecological', 'bat survey',
      'bat', 'newt', 'dormouse', 'protected species', 'nesting birds', 'breeding birds'
    ],
    quoteTerms: ['ecology', 'ecological', 'habitat', 'species', 'biodiversity', 'wildlife'],
    filenameTerms: ['ecology', 'ecological', 'wildlife', 'habitat', 'species', 'biodiversity', 'environment']
  },
  flood: {
    documentTerms: [
      'drainage', 'water', 'sewage', 'storm', 'rainfall', 'suds', 'surface water', 'attenuation', 'flood',
      'fra', 'flood risk', 'hydrology', 'runoff', 'soakaway', 'infiltration', 'watercourse', 'pluvial'
    ],
    quoteTerms: ['flood', 'drainage', 'suds', 'hydrology', 'water', 'surface water'],
    filenameTerms: ['flood', 'drainage', 'water', 'sewage', 'storm', 'surface water', 'suds']
  },
  heritage: {
    documentTerms: [
      'archaeological', 'historic', 'conservation', 'listed', 'cultural', 'monument', 'archaeology', 'heritage',
      'hia', 'heritage impact', 'wsi', 'written scheme', 'desk-based assessment', 'dba', 'historic environment'
    ],
    quoteTerms: ['heritage', 'archaeological', 'historic', 'conservation', 'listed'],
    filenameTerms: ['heritage', 'archaeological', 'historic', 'conservation', 'listed', 'cultural']
  },
  arboricultural: {
    documentTerms: [
      'tree', 'trees', 'vegetation', 'landscape', 'planting', 'hedge', 'woodland', 'green', 'arboricultural',
      'aia', 'arboricultural impact', 'tree survey', 'root protection', 'rpa', 'tree protection'
    ],
    quoteTerms: ['tree', 'arboricultural', 'woodland', 'hedgerow', 'root protection'],
    filenameTerms: ['tree', 'arboricultural', 'vegetation', 'landscape', 'planting', 'forestry']
  },
  waste: {
    documentTerms: [
      'waste', 'refuse', 'recycling', 'bin', 'storage', 'collection', 'disposal', 'management plan',
      'waste management', 'skip', 'compactor'
    ],
    quoteTerms: ['waste', 'refuse', 'recycling', 'disposal'],
    filenameTerms: ['waste', 'refuse', 'recycling', 'disposal', 'bin']
  },
  lighting: {
    documentTerms: [
      'lighting', 'light', 'illumination', 'lumens', 'lux', 'lamp',
      'light pollution', 'spillage', 'luminaire', 'obtrusive light', 'sky glow'
    ],
    quoteTerms: ['lighting', 'light', 'illumination', 'luminaire', 'lux'],
    filenameTerms: ['lighting', 'light', 'illumination', 'lumens', 'lux', 'lamp']
  },
  // Previously had no entry in any map, so `quickKeywordFilter` degraded to a
  // literal substring test for the word "contamination".
  contamination: {
    documentTerms: [
      'contamination', 'contaminated', 'contaminated land', 'ground investigation', 'remediation',
      'geoenvironmental', 'soil', 'groundwater', 'asbestos', 'hydrocarbon', 'landfill gas',
      'desk study', 'phase 1', 'phase i', 'phase ii', 'risk assessment', 'made ground'
    ],
    quoteTerms: [
      'contamination', 'contaminated', 'remediation', 'ground investigation',
      'geoenvironmental', 'asbestos', 'landfill gas'
    ],
    filenameTerms: ['contamination', 'contaminated', 'remediation', 'geoenvironmental', 'ground-investigation']
  },
  // Catch-all. No meaningful vocabulary exists; callers fall back to the literal
  // type string, which is the pre-existing behaviour made explicit.
  other: {
    documentTerms: [],
    quoteTerms: [],
    filenameTerms: []
  }
};

/**
 * Resolve any spelling used anywhere in the system to its canonical form.
 * Unknown types are returned lowercased and trimmed rather than throwing, so a
 * new report type added to an enum degrades to literal matching instead of
 * silently matching nothing.
 */
function normalizeReportType(reportType) {
  if (!reportType) return null;
  const key = String(reportType).toLowerCase().trim();
  return REPORT_TYPE_ALIASES[key] || key;
}

function lookup(reportType, vocabulary) {
  const canonical = normalizeReportType(reportType);
  if (!canonical) return [];
  const entry = VOCABULARY[canonical];
  // Fall back to the literal type so an unrecognised type still matches its own
  // name rather than matching nothing at all.
  if (!entry) return [canonical];
  const terms = entry[vocabulary] || [];
  return terms.length > 0 ? terms : [canonical];
}

/** Broad vocabulary for gating a whole document. Favours recall. */
const getDocumentTerms = (reportType) => lookup(reportType, 'documentTerms');

/** Precise vocabulary for validating a customer-facing quote. Favours precision. */
const getQuoteTerms = (reportType) => lookup(reportType, 'quoteTerms');

/** Vocabulary for matching against a filename. */
const getFilenameTerms = (reportType) => lookup(reportType, 'filenameTerms');

/** True if `text` contains any term from the given vocabulary for this report type. */
function textMentionsReportType(text, reportType, vocabulary = 'quoteTerms') {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  return lookup(reportType, vocabulary).some(term => lower.includes(term));
}

module.exports = {
  CANONICAL_REPORT_TYPES,
  REPORT_TYPE_ALIASES,
  normalizeReportType,
  getDocumentTerms,
  getQuoteTerms,
  getFilenameTerms,
  textMentionsReportType
};
