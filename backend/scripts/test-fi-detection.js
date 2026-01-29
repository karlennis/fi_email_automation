require('dotenv').config();
const fiDetectionService = require('../services/fiDetectionService');
const s3Service = require('../services/s3Service');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

// Test with the ACTUAL files from production logs + KNOWN good FI requests
async function getTestFiles() {
  return [
    {
      s3Key: 'planning-docs/11554/2560090---F.I.-Request-Letter.pdf',
      planningRef: '11554',
      description: 'KNOWN FI REQUEST - Standard FI request letter (not acoustic)',
      expectFI: true,
      expectAcousticMatch: false
    },
    {
      s3Key: 'planning-docs/396039/ab370e0bb9d5746be96471012293d0a2-20251250W_F.I._received_Noise_Impact_Assessment_report.pdf',
      planningRef: '396039',
      description: 'FALSE POSITIVE - Noise report submitted (should be rejected at Layer 1)',
      expectFI: false,
      expectAcousticMatch: false,
      expectLayerRejection: 1
    },
    {
      s3Key: 'planning-docs/392429/db778aa3-952b-4d1b-86f8-60a7184322ef.pdf',
      planningRef: '392429',
      description: 'FI request for housing density/CEMP - NOT acoustic (FALSE POSITIVE TEST)',
      expectFI: true,
      expectAcousticMatch: false
    }
  ];
}

// Test cases with sample text
const testCases = [
  {
    name: 'Valid FI Request - Acoustic',
    text: `
      Further Information Request
      Planning Application Ref: 2025/1234
      
      Dear Applicant,
      
      Further to your recent planning application, the Planning Authority requests 
      that you submit the following additional information:
      
      1. A comprehensive noise impact assessment report prepared by a qualified 
         acoustic consultant, addressing potential noise impacts from the proposed 
         development on surrounding residential properties.
      
      2. The assessment should include baseline noise monitoring and predictions
         of operational noise levels.
      
      Please submit this information within 4 weeks.
      
      Regards,
      Planning Department
    `,
    expectedFI: true,
    expectedMatch: true,
    description: 'Clear FI request asking for acoustic assessment'
  },
  {
    name: 'FI Response Document',
    text: `
      Response to Further Information Request
      Planning Application Ref: 2025/1234
      
      F.I. Received: Noise Impact Assessment Report
      
      We have submitted the requested noise impact assessment report prepared
      by ABC Acoustics Ltd. The assessment demonstrates that noise levels from
      the proposed development will comply with all relevant standards.
      
      The report includes:
      - Baseline noise monitoring results
      - Predicted operational noise levels
      - Mitigation measures
      
      Submitted on behalf of the applicant.
    `,
    expectedFI: false,
    expectedMatch: false,
    description: 'Response document - should be rejected (contains "F.I. received" and "we have submitted")'
  },
  {
    name: 'Grant Decision',
    text: `
      Decision Notification
      Planning Application Ref: 2025/1234
      
      Permission is Granted
      
      The Planning Authority has decided to grant permission for the proposed
      development subject to the following conditions:
      
      1. Development shall commence within 5 years
      2. Noise from construction works shall be limited to 70 dB(A)
      3. Final grant decision
      
      Signed: Planning Officer
    `,
    expectedFI: false,
    expectedMatch: false,
    description: 'Grant decision - should be rejected (contains "permission is granted")'
  },
  {
    name: 'FI Request - Varied Language',
    text: `
      Clarification of Further Information
      Ref: 2025/5678
      
      The planning authority requires additional information regarding your application.
      
      You are requested to provide an acoustic impact study addressing noise from
      the proposed commercial development. The study must include measurements of
      existing sound levels and predictions for the operational phase.
      
      This information is required before the application can be determined.
    `,
    expectedFI: true,
    expectedMatch: true,
    description: 'FI request with varied language - should match'
  }
];

async function testWithS3Files() {
  console.log('\n' + '='.repeat(80));
  console.log('🧪 Testing FI Detection with REAL FI REQUEST files from S3');
  console.log('='.repeat(80));

  const testFiles = await getTestFiles();
  
  if (testFiles.length === 0) {
    console.log('\n❌ No test files found in S3. Cannot proceed.');
    return;
  }

  let tested = 0;
  let errors = 0;
  let failures = [];

  for (const testFile of testFiles) {
    console.log(`\n📄 Testing: ${testFile.s3Key}`);
    console.log(`   Planning Ref: ${testFile.planningRef}`);
    console.log(`   Description: ${testFile.description}`);
    console.log('-'.repeat(80));

    try {
      // Download file
      console.log('⬇️  Downloading from S3...');
      const downloadResult = await s3Service.downloadDocument(testFile.s3Key);

      if (!downloadResult || !downloadResult.localPath) {
        console.log('❌ Failed to download file');
        errors++;
        continue;
      }

      // Extract text
      console.log('📝 Extracting text...');
      const documentText = await fiDetectionService.extractPdfText(downloadResult.localPath);
      console.log(`   Extracted ${documentText.length} characters`);

      // Truncate to 32k
      const truncatedText = documentText.length > 32000 
        ? documentText.substring(0, 32000) 
        : documentText;

      if (truncatedText.length < 100) {
        console.log('⚠️  Insufficient text extracted - skipping');
        continue;
      }

      // LAYER 1: Structural Pre-screening
      console.log('\n🔍 LAYER 1: Structural Pre-screening');
      
      // 1a. Filename check
      const filenameLower = testFile.s3Key.split('/').pop().toLowerCase();
      const fiResponseIndicators = [
        'fi_received', 'f.i._received', 'fi received',
        'response to fi', 'fi response', 'submitted',
        'final grant', 'decision notification', 'grant permission'
      ];
      
      const filenameMatch = fiResponseIndicators.find(indicator => filenameLower.includes(indicator));
      if (filenameMatch) {
        console.log(`   ❌ REJECTED by filename: Contains "${filenameMatch}"`);
        
        // Validate expectation
        if (testFile.expectLayerRejection === 1) {
          console.log('✅ VALIDATION: Correctly rejected at Layer 1 as expected');
        } else if (testFile.expectFI === true) {
          console.log('❌ VALIDATION FAILED: Expected FI request but rejected at Layer 1');
          failures.push({file: testFile.s3Key, issue: 'Rejected at Layer 1 but expected to be FI request'});
        }
        
        console.log('\n🎯 FINAL RESULT: ❌ Rejected at Layer 1 (Filename)');
        tested++;
        continue;
      }
      console.log('   ✅ Filename passed');

      // 1b. Length check
      const estimatedPages = Math.ceil(truncatedText.length / 2500);
      if (estimatedPages > 100) {
        console.log(`   ❌ REJECTED by length: ${estimatedPages} pages (>100)`);
        console.log('\n🎯 FINAL RESULT: ❌ Rejected at Layer 1 (Length)');
        tested++;
        continue;
      }
      console.log(`   ✅ Length passed (${estimatedPages} pages)`);

      // 1c. Structure check
      const reportStructureMarkers = [
        /table of contents/i,
        /executive summary/i,
        /\d+\.\d+\s+(introduction|background|methodology)/i,
        /this report (?:was|has been) prepared by/i,
        /prepared on behalf of/i
      ];
      
      const structureMatch = reportStructureMarkers.find(pattern => pattern.test(truncatedText));
      if (structureMatch) {
        console.log(`   ❌ REJECTED by structure: Report formatting detected`);
        console.log('\n🎯 FINAL RESULT: ❌ Rejected at Layer 1 (Structure)');
        tested++;
        continue;
      }
      console.log('   ✅ Structure passed');

      // LAYER 2: Cheap AI Pre-filter
      console.log('\n🔍 LAYER 2: Cheap AI Pre-filter (first 10k + last 5k chars)');
      const passesLayer2 = await fiDetectionService.cheapFIFilter(truncatedText);
      if (!passesLayer2) {
        console.log('   ❌ REJECTED by cheap AI filter');
        console.log('\n🎯 FINAL RESULT: ❌ Rejected at Layer 2 (Cheap AI)');
        
        // Validate expectation
        if (testFile.expectLayerRejection === 2) {
          console.log('✅ VALIDATION: Correctly rejected at Layer 2 as expected');
        } else if (testFile.expectFI === true) {
          console.log('❌ VALIDATION FAILED: Expected FI request but rejected at Layer 2');
          failures.push({file: testFile.s3Key, issue: 'Rejected at Layer 2 but expected to be FI request'});
        }
        
        tested++;
        continue;
      }
      console.log('   ✅ Cheap AI filter passed');

      // LAYER 3: Full AI Detection
      console.log('\n🔍 LAYER 3: Full AI Detection');
      console.log('Step 1: Is this an FI request?');
      const isFIRequest = await fiDetectionService.detectFIRequest(truncatedText);
      console.log(`   Result: ${isFIRequest ? '✅ Yes (is FI request)' : '❌ No (not FI request)'}`);

      // Validate Step 1
      if (testFile.expectFI !== undefined) {
        if (isFIRequest === testFile.expectFI) {
          console.log(`✅ VALIDATION: Step 1 correct (expected ${testFile.expectFI})`);
        } else {
          console.log(`❌ VALIDATION FAILED: Step 1 returned ${isFIRequest}, expected ${testFile.expectFI}`);
          failures.push({file: testFile.s3Key, issue: `Step 1: got ${isFIRequest}, expected ${testFile.expectFI}`});
        }
      }

      // Step 2: If FI, does it match acoustic report type?
      if (isFIRequest) {
        console.log('\n🔍 Step 2: Does it request an acoustic report?');
        const matchResult = await fiDetectionService.matchFIRequestType(truncatedText, 'acoustic');
        console.log(`   Result: ${matchResult.matches ? '✅ Matches acoustic' : '❌ No match for acoustic'}`);
        
        // Validate Step 2
        if (testFile.expectAcousticMatch !== undefined) {
          if (matchResult.matches === testFile.expectAcousticMatch) {
            console.log(`✅ VALIDATION: Step 2 correct (expected ${testFile.expectAcousticMatch})`);
          } else {
            console.log(`❌ VALIDATION FAILED: Step 2 returned ${matchResult.matches}, expected ${testFile.expectAcousticMatch}`);
            failures.push({file: testFile.s3Key, issue: `Step 2: got ${matchResult.matches}, expected ${testFile.expectAcousticMatch}`});
          }
        }
        
        if (matchResult.matches) {
          console.log(`   Validation Quote: "${matchResult.validationQuote.substring(0, 200)}..."`);
          console.log('\n🎯 FINAL RESULT: ✅ FI REQUEST FOR ACOUSTIC REPORT DETECTED');
        } else {
          console.log('\n🎯 FINAL RESULT: ℹ️  FI request but NOT for acoustic report');
        }
      } else {
        console.log('\n🎯 FINAL RESULT: ❌ Not an FI request');
      }

      tested++;

      // Cleanup
      const fs = require('fs');
      try {
        fs.unlinkSync(downloadResult.localPath);
      } catch (err) {
        // Ignore cleanup errors
      }

    } catch (error) {
      console.log(`\n❌ Error processing file: ${error.message}`);
      console.error(error);
      errors++;
    }

    console.log('='.repeat(80));
  }

  console.log(`\n📊 Test Summary:`);
  console.log(`   ✅ Tested: ${tested} files`);
  console.log(`   ❌ Errors: ${errors} files`);
  
  if (failures.length > 0) {
    console.log(`\n❌ VALIDATION FAILURES: ${failures.length}`);
    failures.forEach((f, i) => {
      console.log(`\n${i+1}. ${f.file.split('/').pop()}`);
      console.log(`   Issue: ${f.issue}`);
    });
    console.log('\n⚠️  Detection logic needs improvement to fix these false positives/negatives');
  } else {
    console.log('\n✅ All validations passed!');
  }
}

// Run the test
testWithS3Files().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
