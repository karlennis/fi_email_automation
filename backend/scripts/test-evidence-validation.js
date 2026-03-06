/**
 * Test Evidence Validation & Customer Eligibility
 *
 * Verifies that:
 * 1. Placeholder quotes are NEVER customer-eligible
 * 2. Acoustic matches require BOTH request verb AND acoustic term
 * 3. matchFIRequestType enforces evidence-validity before customer emit
 * 4. DAA consultee-to-authority patterns are rejected
 */

require('dotenv').config();
const fiDetectionService = require('../services/fiDetectionService');

console.log('\n' + '='.repeat(80));
console.log('TEST 1: Evidence Validator (isValidCustomerEvidence)');
console.log('='.repeat(80) + '\n');

const evidenceTests = [
  {
    name: "PLACEHOLDER: 'Match confirmed by AI' should be INVALID",
    quote: "Match confirmed by AI but no specific quote extracted",
    reportType: "acoustic",
    shouldBeValid: false
  },
  {
    name: "PLACEHOLDER: 'No specific quote extracted' should be INVALID",
    quote: "No specific quote extracted",
    reportType: "acoustic",
    shouldBeValid: false
  },
  {
    name: "WEAK: 'noise' only without request verb should be INVALID",
    quote: "the noise insulation should be provided at no cost",
    reportType: "acoustic",
    shouldBeValid: false
  },
  {
    name: "WEAK: 'request' only without acoustic term should be INVALID",
    quote: "the applicant is requested to submit detailed plans for the development",
    reportType: "acoustic",
    shouldBeValid: false
  },
  {
    name: "VALID: Request verb + acoustic term = VALID",
    quote: "the applicant is requested to submit a noise impact assessment",
    reportType: "acoustic",
    shouldBeValid: true
  },
  {
    name: "VALID: 'requires' + multiple acoustic terms = VALID",
    quote: "the council requires submission of a revised noise assessment showing sound levels in decibels",
    reportType: "acoustic",
    shouldBeValid: true
  },
  {
    name: "VALID: 'recommends applicant submits' + acoustic = VALID",
    quote: "Environmental Health would recommend the applicant submits a noise impact assessment",
    reportType: "acoustic",
    shouldBeValid: true
  },
  {
    name: "DAA PATTERN: 'condition is attached requiring the noise' should be INVALID",
    quote: "in the event of a grant of permission, a condition is attached requiring the noise sensitive uses to be provided with noise insulation",
    reportType: "acoustic",
    shouldBeValid: false
  },
  {
    name: "HOUSING DEV: 'address site location relative to roads' should be INVALID (transport)",
    quote: "the application site is located adjacent to the partially completed road objective st kl 1 5 kill - johnstown road (a) to hartwell road (b) and map v the applicant is requested to address the development plan",
    reportType: "transport",
    shouldBeValid: false
  },
  {
    name: "VALID: 'requested to submit transport assessment' should be VALID (transport)",
    quote: "the applicant is requested to submit a transport impact assessment addressing traffic generation and parking provision",
    reportType: "transport",
    shouldBeValid: true
  },
  {
    name: "VALID: 'requires ecological survey' should be VALID (ecological)",
    quote: "the planning authority requires submission of an ecological survey and habitat impact assessment",
    reportType: "ecological",
    shouldBeValid: true
  },
  {
    name: "REAL CASE 375099: Site location description should be INVALID",
    quote: "the application site is located adjacent to the partially completed road objective st kl 1 5 kill - johnstown road (a) to hartwell road (b) and map v of the kill small towns and environs plan",
    reportType: "acoustic",
    shouldBeValid: false
  },
  {
    name: "REAL CASE 385584: Noise envelope design ensures compliance - VALID",
    quote: "the report concludes that the proposed building's envelope and design will ensure internal noise levels are within acceptable limits for future residents notwithstanding the above, we are mindful that the development sits within the contours of the noise abatement objective",
    reportType: "acoustic",
    shouldBeValid: true
  },
  {
    name: "REAL CASE 385584: 'shall be required to submit compliance reports' - VALID",
    quote: "the applicant shall adequately advise prospective purchasers and/or occupiers that the development is located within a noise zone pertaining to dublin airport and thus is subject to higher aviation noise levels. the applicant shall be required to submit compliance reports verify",
    reportType: "acoustic",
    shouldBeValid: true
  },
  {
    name: "REAL CASE 391927: 'applicant shall ensure' noise/dust ops - VALID",
    quote: "During the works the applicant shall ensure that all operations on site are carried out in a manner such that noise or dust emissions do not result in significant impairment of, or significant interference with, amenities or the environment beyond the immediate works areas",
    reportType: "acoustic",
    shouldBeValid: true
  },
  {
    name: "REAL CASE 396427: 'applicant shall be requested to provide' details to assess impacts - VALID",
    quote: "aeration system which could generate new noise and odour disturbances. the applicant shall be requested to provide these further details in addressing the lack of supporting information, to fully assess the potential impacts of the development upon the amenities",
    reportType: "acoustic",
    shouldBeValid: true
  }
];

let evidencePassed = 0;
let evidenceFailed = 0;

evidenceTests.forEach((test, idx) => {
  const isValid = fiDetectionService.isValidCustomerEvidence(test.quote, test.reportType);
  const testPassed = isValid === test.shouldBeValid;

  console.log(`${idx + 1}. ${test.name}`);
  console.log(`   Quote: "${test.quote.substring(0, 80)}..."`);
  console.log(`   Expected: ${test.shouldBeValid ? '✅ VALID' : '❌ INVALID'} | Got: ${isValid ? '✅ VALID' : '❌ INVALID'}`);
  console.log(`   Result: ${testPassed ? '✅ PASS' : '❌ FAIL'}\n`);

  if (testPassed) {
    evidencePassed++;
  } else {
    evidenceFailed++;
  }
});

console.log(`\nEvidence Validator: ${evidencePassed}/${evidenceTests.length} tests passed\n`);

// Test 2: matchFIRequestType integration tests
console.log('='.repeat(80));
console.log('TEST 2: matchFIRequestType Evidence Enforcement');
console.log('='.repeat(80) + '\n');

const integrationTests = [
  {
    name: "DAA consultee-to-authority - should be REJECTED",
    documentText: `
      DUBLIN AIRPORT AUTHORITY SUBMISSION
      In the interests of proper planning and sustainable development, DAA respectfully requests 
      that, in the event of a grant of permission, a condition is attached requiring the noise 
      sensitive uses to be provided with noise insulation to an appropriate standard.
    `,
    reportType: "acoustic",
    shouldMatch: false,
    shouldHaveValidEvidence: false,
    description: "DAA condition recommendation (consultee-to-authority), not FI to applicant"
  },
  {
    name: "Valid Planning Authority Noise FI - should be ACCEPTED",
    documentText: `
      FINGAL COUNTY COUNCIL - Further Information Request
      The Planning Authority requires the applicant to submit an acoustic assessment report 
      for the proposed development. The noise assessment must address baseline noise monitoring 
      and demonstrate that noise levels will not exceed 55 dB(A) at nearby residential receptors.
      Please submit this information within 4 weeks.
    `,
    reportType: "acoustic",
    shouldMatch: true,
    shouldHaveValidEvidence: true,
    description: "Valid FI with request verb (requires/submit) + acoustic terms (noise/dB)"
  },
  {
    name: "EHS Response about EXISTING assessment - should be REJECTED",
    documentText: `
      ENVIRONMENTAL HEALTH SERVICE RESPONSE
      We have reviewed the submitted acoustic assessment report. The noise impact assessment 
      indicates that background sound levels of 55dB(A) were recorded at the nearest receptors.
      The assessment demonstrates compliance with guidelines.
    `,
    reportType: "acoustic",
    shouldMatch: false,
    shouldHaveValidEvidence: false,
    description: "EHS reviewing existing report (no request for future assessment)"
  },
  {
    name: "Recommendation for Noise Study - should be ACCEPTED",
    documentText: `
      PLANNING AUTHORITY FEEDBACK
      Based on the objection received, we would recommend the applicant submits a comprehensive 
      noise impact assessment. The noise study should include sound monitoring data and demonstrate 
      that noise levels will not exceed 50dB(A) during day and night hours.
    `,
    reportType: "acoustic",
    shouldMatch: true,
    shouldHaveValidEvidence: true,
    description: "Valid recommendation with request+acoustic (recommend + applicant submits + noise)"
  }
];

let integrationPassed = 0;
let integrationFailed = 0;

(async () => {
  for (let idx = 0; idx < integrationTests.length; idx++) {
    const test = integrationTests[idx];

    try {
      const result = await fiDetectionService.matchFIRequestType(test.documentText, test.reportType);

      const matchCorrect = result.matches === test.shouldMatch;
      const evidenceCorrect = result.hasValidEvidence === test.shouldHaveValidEvidence;
      const testPassed = matchCorrect && evidenceCorrect;

      console.log(`${idx + 1}. ${test.name}`);
      console.log(`   ${test.description}`);
      console.log(`   Expected: matches=${test.shouldMatch}, validEvidence=${test.shouldHaveValidEvidence}`);
      console.log(`   Got:      matches=${result.matches}, validEvidence=${result.hasValidEvidence}`);
      console.log(`   Quote:    "${(result.validationQuote || 'N/A').substring(0, 80)}..."`);
      console.log(`   Result:   ${testPassed ? '✅ PASS' : '❌ FAIL'}\n`);

      if (testPassed) {
        integrationPassed++;
      } else {
        integrationFailed++;
      }
    } catch (error) {
      console.log(`${idx + 1}. ${test.name}`);
      console.log(`   ❌ ERROR: ${error.message}\n`);
      integrationFailed++;
    }
  }

  // Summary
  console.log('='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`\nTest 1 (Evidence Validator): ${evidencePassed}/${evidenceTests.length} passed`);
  console.log(`Test 2 (matchFIRequestType):  ${integrationPassed}/${integrationTests.length} passed`);
  console.log(`\nTotal: ${evidencePassed + integrationPassed}/${evidenceTests.length + integrationTests.length} passed\n`);

  if (evidenceFailed === 0 && integrationFailed === 0) {
    console.log('🎉 All evidence validation tests PASSED!\n');
    process.exit(0);
  } else {
    console.log(`❌ ${evidenceFailed + integrationFailed} test(s) FAILED.\n`);
    process.exit(1);
  }
})().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
