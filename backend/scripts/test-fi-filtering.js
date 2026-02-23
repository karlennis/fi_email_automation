/**
 * Test FI Detection Filtering Logic
 * Tests filename rejection and content-based rejection
 * Usage: node scripts/test-fi-filtering.js
 */

require('dotenv').config();

// Mock the fiDetectionService methods for testing
const testCases = {
  filenames: [
    // Should be REJECTED by filename (clear FI responses or submitted reports)
    { name: 'fi-response-acoustic.pdf', expectReject: true, reason: 'FI response' },
    { name: 'fi_received_docs.pdf', expectReject: true, reason: 'FI received' },
    { name: 'response-to-fi-request.pdf', expectReject: true, reason: 'Response to FI' },
    { name: 'acoustic-report-submitted.pdf', expectReject: true, reason: 'Submitted report' },
    { name: 'noise-assessment-final.pdf', expectReject: true, reason: 'Report filename (existing report)' },
    
    // Should PASS filename check (content analysis will evaluate)
    // Emails/correspondence may contain requests or recommendations
    { name: 'email-reply-to-agent.pdf', expectReject: false, reason: 'Email may contain request - content check needed' },
    { name: 'correspondence-with-agent-6-.pdf', expectReject: false, reason: 'Correspondence may contain request - content check needed' },
    { name: 'acknowledgement-of-submission.pdf', expectReject: false, reason: 'Acknowledgment context varies - content check needed' },
    // Consultation responses - may contain recommendations
    { name: 'PAO811847_EH-Belfast-City-Council3_Consultation-Response_20112019142130.pdf', expectReject: false, reason: 'Consultation may contain recommendations' },
    { name: 'PAO822555_EH-Belfast-City-Council3_Consultation-Response_25112019172829.pdf', expectReject: false, reason: 'Consultation may contain recommendations' },
    { name: 'PAO_LA04_2019_2299_F_Final-Substantive-Reply_20191129-10441488.pdf', expectReject: false, reason: 'Substantive reply may contain recommendations' },
    { name: 'PAO826083_EH-Belfast-City-Council3_Consultation-Response_2211201910934.pdf', expectReject: false, reason: 'Consultation may contain recommendations' },
    { name: 'PAO826349_EH-Belfast-City-Council3_Consultation-Response_29112019112359.pdf', expectReject: false, reason: 'Consultation may contain recommendations' },
    // FI requests - should pass
    { name: 'la01-2024-1005-f-further-information.pdf', expectReject: false, reason: 'FI letter' },
    { name: 'planning-authority-letter.pdf', expectReject: false, reason: 'Authority letter' },
    { name: 'fi-request-acoustic.pdf', expectReject: false, reason: 'FI request named' },
    { name: '8a6eb529-0062-4f44-b3c8-2b727d88645f.pdf', expectReject: false, reason: 'Generic UUID name' },
    { name: 'af9ce2f2-4f85-4820-b11d-764adb8c9a46.pdf', expectReject: false, reason: 'Generic UUID name' },
  ],

  content: [
    // Should be REJECTED (responses, acknowledgments, emails, consultations)
    {
      name: 'EHD Acknowledgment',
      text: 'the environmental health department acknowledge receipt of this application. the ehd has reviewed the submitted acoustic report (v3 iss, november 2025) in support of the proposed replacement wind turb...',
      expectPass: false,
      reason: 'Acknowledges receipt, reviews SUBMITTED report'
    },
    {
      name: 'Email Reply',
      text: 'good morning david yes this would be acceptable and we will condition it that the main access with be taken from john street. please submit the acoustic assessment',
      expectPass: false,
      reason: 'Email greeting, "we will condition"'
    },
    {
      name: 'Correspondence',
      text: 'just waiting to until the Noise Consultant can free up some time to complete the Noise Addendum. Can we please agree an extension of time until 20th February 2026? Happy to discuss.',
      expectPass: false,
      reason: 'Correspondence about waiting, extension request'
    },
    {
      name: 'EH Review',
      text: 'environmental health has reviewed the submitted acoustic consultancy report. the findings are acceptable.',
      expectPass: false,
      reason: 'Reviews SUBMITTED report'
    },
    // NEW: Consultation response patterns
    {
      name: 'EH Consultation - Reviewed',
      text: "o'donnell's gac 43 whiterock road, belfast bt12 7pf proposal: beer garden for exisiting clubhouse with acoustic fence fanels the environmental health service has received and reviewed the amended n...",
      expectPass: false,
      reason: 'EH has received and reviewed - consultation response'
    },
    {
      name: 'EH Consultation - Recommends Report (LEAD)',
      text: "this service has been consulted regarding the above full planning application. Environmental health would therefore recommend the applicant submits a noise impact assessment.",
      expectPass: true,
      reason: 'Recommends future report submission = valuable lead'
    },
    {
      name: 'EH Consultation - Would Recommend (LEAD)',
      text: "that future occupants of the proposal may be adversely impacted by noise. this service would therefore recommend, the applicant submits a noise impact assessment which identifies the potential noi...",
      expectPass: true,
      reason: 'Recommends future report = valuable lead'
    },

    // Should PASS (actual FI requests)
    {
      name: 'Genuine FI Request',
      text: 'the applicant is requested to provide details of extractor fans and any associated ventilation equipment. The applicant should submit a noise impact assessment.',
      expectPass: true,
      reason: 'Requests applicant to submit'
    },
    {
      name: 'Noise Assessment Request',
      text: 'upon review of the additional correspondence this department would request the following: noise impact assessment – bs 4142. The applicant is requested to submit an acoustic report.',
      expectPass: true,
      reason: 'Requests noise assessment'
    },
    {
      name: 'CMP Request',
      text: 'housing development, chapel road, greystones. please submit a construction management plan to include a traffic management plan, noise and dust mitigation measures',
      expectPass: true,
      reason: 'Requests submission of CMP with noise measures'
    },
    // NEW: Email containing a request (should pass content check)
    {
      name: 'Email With Request (LEAD)',
      text: 'hi john, following our discussion yesterday, the council requires the applicant to submit an acoustic report before we can proceed. please submit this at your earliest convenience. regards, planning officer',
      expectPass: true,
      reason: 'Email containing explicit request - valuable lead'
    },
  ]
};

// Filename rejection function (same as in fiDetectionService)
// SELECTIVE REJECTION: Only reject clear FI responses and submitted reports
// Emails, correspondence, acknowledgments, consultations are NOT rejected by filename
// Content analysis will determine if they contain valuable requests/recommendations
function shouldRejectByFilename(fileName) {
  if (!fileName) return false;

  const filenameLower = fileName.toLowerCase();

  // Patterns that indicate FI RESPONSES (applicant responding, NOT the request itself)
  const responsePatterns = [
    'fi-response', 'fi_response', 'fi-return', 'fi_return',
    'response-to-fi', 'response_to_fi', 'response-to-further',
    'further-information-response', 'further_information_response',
    'fi-submission', 'fi_submission', 'fi-reply', 'fi_reply',
    'fi-received', 'fi_received', 'fi-rec', 'fi_rec',
    'further-information-received', 'further_information_received',
    'response-to-request', 'response_to_request',
    'applicant-response', 'applicant_response',
    'agent-response', 'agent_response'
  ];

  // Patterns that indicate submitted reports (existing reports, not requests)
  const submittedReportPatterns = [
    'acoustic-report', 'acoustic_report',
    'noise-assessment', 'noise_assessment',
    'noise-impact', 'noise_impact',
    'nia-report', 'nia_report',
    'transport-assessment', 'transport_assessment',
    'ecological-survey', 'ecological_survey',
    'flood-risk', 'flood_risk',
    '-submitted', '_submitted'
  ];

  // NOTE: The following are NOT rejected by filename (passed to content analysis):
  // - Consultation responses (EH, NIEA, etc.) - may contain recommendations
  // - Emails/correspondence - may contain explicit requests or recommendations
  // - Acknowledgments - context matters, content analysis will evaluate

  const allRejectPatterns = [
    ...responsePatterns,
    ...submittedReportPatterns
  ];

  return allRejectPatterns.some(pattern => filenameLower.includes(pattern));
}

// Content negative indicators (same as in fiDetectionService)
// NOTE: Email signatures NOT rejected - email may contain valid request
function hasNegativeIndicators(text) {
  const negativeFIIndicators = [
    // Response patterns (applicant responding)
    "response to further information",
    "response to clarification of further information",
    "clarification response",
    "we have submitted", "we have provided", "the applicant has submitted",
    "in response to your request",
    "in response to the request",
    
    // Decision patterns
    "grant permission", "permission is granted", "conditions set out",
    "subject to conditions", "decision to grant", "decision: grant",
    "refuse permission", "decision to refuse",
    "we will condition", "this will be conditioned",
    
    // Review of existing submission
    "acknowledge receipt", "acknowledges receipt",
    "has reviewed the submitted", "reviewed the submitted",
    "receipt of this application",
    
    // NOTE: Email greetings/signatures NOT rejected
    // "good morning" + "please submit acoustic report" = valuable lead
    
    // Extension/waiting patterns
    "waiting until", "waiting to", "can we please agree",
    
    // Submitted report discussion patterns
    "the submitted acoustic", "submitted noise assessment",
    "the acoustic report shows", "the noise report indicates",
    "has been submitted", "was submitted",
    "further information received", "fi received", "f.i. received",
    "further information has been received",
    "enclosed please find", "attached please find",
    "please find enclosed", "please find attached",
    "has received and reviewed", "received and reviewed the",
    "environmental health service has received",
    "environmental health has reviewed"
    
    // NOTE: "would recommend" patterns NOT rejected - valuable leads
  ];

  const textLower = text.toLowerCase();
  return negativeFIIndicators.some(p => textLower.includes(p));
}

// Run tests
console.log('=' .repeat(80));
console.log('FI DETECTION FILTERING TEST');
console.log('='.repeat(80));

console.log('\n--- FILENAME REJECTION TESTS ---');
let filenamePass = 0, filenameFail = 0;

testCases.filenames.forEach(test => {
  const rejected = shouldRejectByFilename(test.name);
  const passed = rejected === test.expectReject;
  
  if (passed) {
    console.log(`  ✓ ${test.name}`);
    console.log(`    Expected: ${test.expectReject ? 'REJECT' : 'PASS'}, Got: ${rejected ? 'REJECT' : 'PASS'} (${test.reason})`);
    filenamePass++;
  } else {
    console.log(`  ✗ ${test.name}`);
    console.log(`    Expected: ${test.expectReject ? 'REJECT' : 'PASS'}, Got: ${rejected ? 'REJECT' : 'PASS'} (${test.reason})`);
    filenameFail++;
  }
});

console.log(`\n  Filename tests: ${filenamePass}/${testCases.filenames.length} passed`);

console.log('\n--- CONTENT NEGATIVE INDICATOR TESTS ---');
let contentPass = 0, contentFail = 0;

testCases.content.forEach(test => {
  const hasNegative = hasNegativeIndicators(test.text);
  const wouldPass = !hasNegative;
  const testPassed = wouldPass === test.expectPass;
  
  if (testPassed) {
    console.log(`  ✓ ${test.name}`);
    console.log(`    Expected: ${test.expectPass ? 'PASS' : 'REJECT'}, Got: ${wouldPass ? 'PASS' : 'REJECT'}`);
    console.log(`    Reason: ${test.reason}`);
    contentPass++;
  } else {
    console.log(`  ✗ ${test.name}`);
    console.log(`    Expected: ${test.expectPass ? 'PASS' : 'REJECT'}, Got: ${wouldPass ? 'PASS' : 'REJECT'}`);
    console.log(`    Reason: ${test.reason}`);
    contentFail++;
  }
});

console.log(`\n  Content tests: ${contentPass}/${testCases.content.length} passed`);

console.log('\n' + '='.repeat(80));
console.log('SUMMARY');
console.log('='.repeat(80));
console.log(`Filename tests: ${filenamePass}/${testCases.filenames.length}`);
console.log(`Content tests: ${contentPass}/${testCases.content.length}`);
console.log(`Total: ${filenamePass + contentPass}/${testCases.filenames.length + testCases.content.length}`);

if (filenameFail > 0 || contentFail > 0) {
  console.log('\n⚠️  Some tests failed - review filtering logic');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed!');
}
