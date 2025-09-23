// Mock the OpenAI requirement for testing
process.env.OPENAI_API_KEY = 'test-key';

const fiDetectionService = require('./services/fiDetectionService');

// Test the optimization features
async function testOptimizations() {
  console.log('Testing FI Detection Optimizations');
  console.log('===================================');

  // Test 1: Filename-based fast track
  console.log('\n1. Testing filename-based detection:');

  const testFiles = [
    'Further Information Request - Acoustic Report.pdf',
    'fi_request_transport_assessment.pdf',
    'Planning Application 123456.pdf',
    'Site Photos.pdf',
    'Additional Information - Heritage Study.pdf'
  ];

  testFiles.forEach(fileName => {
    const fiScore = fiDetectionService.calculateFILikelihoodScore(fileName);
    const hasFI = fiDetectionService.checkFilenameForFI(fileName);
    console.log(`  ${fileName}: Score=${fiScore}, HasFI=${hasFI}`);
  });

  // Test 2: Document prioritization
  console.log('\n2. Testing document prioritization:');
  const mockDocs = testFiles.map(fileName => ({ fileName }));
  const prioritized = fiDetectionService.prioritizeDocuments(mockDocs);

  console.log('  Original order vs Prioritized order:');
  prioritized.forEach((doc, index) => {
    const score = fiDetectionService.calculateFILikelihoodScore(doc.fileName);
    console.log(`  ${index + 1}. ${doc.fileName} (score: ${score})`);
  });

  // Test 3: Report type filename matching
  console.log('\n3. Testing report type filename matching:');
  const reportTypes = ['acoustic', 'transport', 'heritage'];
  testFiles.forEach(fileName => {
    reportTypes.forEach(reportType => {
      const matches = fiDetectionService.checkFilenameForReportType(fileName, reportType);
      if (matches) {
        console.log(`  ${fileName} matches ${reportType}: ${matches}`);
      }
    });
  });

  console.log('\n4. Cache statistics:');
  console.log('  ', fiDetectionService.getCacheStats());
  console.log('  Memory usage:', fiDetectionService.getCacheMemoryUsage());

  console.log('\nOptimization features ready! 🚀');
  console.log('Key benefits:');
  console.log('- Filename-based fast track for obvious FI documents');
  console.log('- Early termination when FI request found for report type');
  console.log('- Document prioritization (likely FI docs first)');
  console.log('- Result caching to avoid re-processing');
  console.log('- Enhanced pre-filtering to reduce API calls');
}

testOptimizations().catch(console.error);