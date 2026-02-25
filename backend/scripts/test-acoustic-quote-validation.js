/**
 * Test Acoustic Quote Validation
 * 
 * Verifies that acoustic FI detection returns quotes that actually mention
 * acoustic terms (noise, sound, vibration, etc.) and rejects irrelevant quotes.
 */

require('dotenv').config();
const fiDetectionService = require('../services/fiDetectionService');

// Test cases based on real examples
const testCases = [
  {
    name: "DAA Document 405439 - Aircraft conflicts (NO acoustic terms)",
    documentText: `
      DUBLIN AIRPORT AUTHORITY SUBMISSION
      
      Further Information Request Response
      Planning Application Reference: 2025/001
      
      Document Classification: Class 1 - General Development
      
      The proposed development should be restricted which would give rise to conflicts 
      with aircraft movements on environmental or safety grounds on lands in the vicinity 
      of Dublin Airport and on the main flight paths serving Dublin Airport.
      
      In the interests of proper planning and sustainable development of the area, DAA 
      respectfully requests that the applicant provides further details regarding the 
      proposed development timeline and construction methodology.
      
      The Planning Authority should consider the impact on aircraft safety and flight 
      path operations when making their decision.
    `,
    reportType: "acoustic",
    shouldMatch: false,  // This is a DAA submission/response, NOT an FI request TO the applicant
    expectedQuoteContains: null,
    description: "Should NOT match - DAA consultation response, not FI request"
  },
  {
    name: "DAA Document 405441 - Noise insulation condition (HAS acoustic terms)",
    documentText: `
      DUBLIN AIRPORT AUTHORITY SUBMISSION
      
      Planning Application Reference: 2025/002
      
      Document Classification: Class 1 - General
      
      In the interests of proper planning and sustainable development of the area, 
      DAA respectfully requests that, in the event of a grant of permission, a 
      condition is attached requiring the noise sensitive uses to be provided with 
      noise insulation to an appropriate standard, having regard to the location 
      of the development relative to Dublin Airport operations.
      
      The noise levels should be maintained within acceptable limits as per 
      standard guidelines for residential development near aviation facilities.
    `,
    reportType: "acoustic",
    shouldMatch: false,  // This is a DAA condition recommendation, NOT an FI request TO the applicant
    expectedQuoteContains: null,
    description: "Should NOT match - DAA suggesting permission condition, not FI request"
  },
  {
    name: "Legitimate Construction Noise FI Request",
    documentText: `
      FINGAL COUNTY COUNCIL
      Planning Department
      
      Further Information Request
      Planning Application Reference: 2025/003
      
      The Planning Authority requires the applicant to submit an acoustic assessment 
      report for the proposed development. The noise assessment must address:
      
      1. Baseline noise monitoring results for the site
      2. Predicted noise levels during construction phase
      3. Operational noise from plant and equipment
      4. Mitigation measures to reduce sound levels
      
      The assessment should demonstrate compliance with relevant noise standards 
      including BS 4142 and demonstrate that noise levels will not exceed 55 dB(A) 
      at the nearest noise-sensitive receptors.
      
      Please submit this information within 4 weeks from the date of this request.
    `,
    reportType: "acoustic",
    shouldMatch: true,
    expectedQuoteContains: "noise", // Should return relevant quote about noise assessment
    description: "Should return quote with multiple acoustic terms (noise, sound, dB, acoustic)"
  },
  {
    name: "Generic Planning Request - No Acoustics",
    documentText: `
      PLANNING AUTHORITY REQUEST
      
      Reference: 2025/004
      
      The Planning Authority requests that the applicant submit additional details
      regarding the proposed development including:
      
      - Site layout plans
      - Elevation drawings
      - Landscaping proposals
      - Parking arrangements
      
      Please provide this information at your earliest convenience.
    `,
    reportType: "acoustic",
    shouldMatch: false,
    expectedQuoteContains: null,
    description: "Should NOT match - no acoustic terms present"
  },
  {
    name: "Physical Work Only - Noise Insulation (No Report Request)",
    documentText: `
      PLANNING CONDITION
      
      Permission is granted subject to the following condition:
      
      The developer shall provide noise insulation and install acoustic glazing
      to all habitable rooms to achieve sound reduction of 30 dB minimum.
      
      All works shall be completed before occupation.
    `,
    reportType: "acoustic",
    shouldMatch: false, // Should be rejected - physical work without document request
    expectedQuoteContains: null,
    description: "Should NOT match - physical work requirement, not document request"
  }
];

async function runTests() {
  console.log('\n🧪 Testing Acoustic Quote Validation\n');
  console.log('='.repeat(80));
  
  let passed = 0;
  let failed = 0;
  
  for (let i = 0; i < testCases.length; i++) {
    const test = testCases[i];
    console.log(`\n📋 Test ${i + 1}/${testCases.length}: ${test.name}`);
    console.log(`   ${test.description}`);
    console.log('-'.repeat(80));
    
    try {
      const result = await fiDetectionService.matchFIRequestType(test.documentText, test.reportType);
      
      // Check if match result is as expected
      const matchCorrect = result.matches === test.shouldMatch;
      
      // Check quote quality if it matched
      let quoteCorrect = true;
      let quoteMessage = '';
      
      if (result.matches && result.validationQuote) {
        const quoteLower = result.validationQuote.toLowerCase();
        
        if (test.expectedQuoteContains) {
          // Should contain expected term
          quoteCorrect = quoteLower.includes(test.expectedQuoteContains);
          quoteMessage = quoteCorrect 
            ? `✅ Quote contains "${test.expectedQuoteContains}"` 
            : `❌ Quote missing "${test.expectedQuoteContains}"`;
        } else {
          // Should either have acoustic terms OR be default message
          const hasAcousticTerms = ["noise", "sound", "vibration", "acoustic", "db(a)", "dba", "decibel"]
            .some(term => quoteLower.includes(term));
          const isDefaultMessage = result.validationQuote.includes("Match confirmed by AI");
          
          quoteCorrect = hasAcousticTerms || isDefaultMessage;
          if (hasAcousticTerms) {
            quoteMessage = `✅ Quote contains acoustic terms`;
          } else if (isDefaultMessage) {
            quoteMessage = `✅ Default message (no valid quote found)`;
          } else {
            quoteMessage = `❌ Quote lacks acoustic terms and isn't default message`;
          }
        }
        
        console.log(`   Quote: "${result.validationQuote.substring(0, 150)}..."`);
        console.log(`   ${quoteMessage}`);
      } else if (result.matches && !result.validationQuote) {
        console.log(`   ⚠️  Matched but no quote extracted`);
      } else {
        console.log(`   No match (as expected)`);
      }
      
      // Overall test result
      const testPassed = matchCorrect && quoteCorrect;
      
      if (testPassed) {
        console.log(`   ✅ PASS`);
        passed++;
      } else {
        console.log(`   ❌ FAIL`);
        if (!matchCorrect) {
          console.log(`      Expected match: ${test.shouldMatch}, Got: ${result.matches}`);
        }
        failed++;
      }
      
    } catch (error) {
      console.log(`   ❌ ERROR: ${error.message}`);
      failed++;
    }
  }
  
  console.log('\n' + '='.repeat(80));
  console.log(`\n📊 Test Results: ${passed} passed, ${failed} failed\n`);
  
  if (failed === 0) {
    console.log('🎉 All tests passed! Acoustic quote validation is working correctly.\n');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed. Review the output above for details.\n');
    process.exit(1);
  }
}

// Run tests
console.log('Starting acoustic quote validation tests...');
console.log('This will test that quotes returned for acoustic FI requests');
console.log('actually mention acoustic terms (noise, sound, vibration, etc.)');

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
