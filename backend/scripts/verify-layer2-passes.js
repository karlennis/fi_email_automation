/**
 * Verify Layer 2 passes - Check documents that passed cheap AI but were rejected at Layer 3
 * This helps ensure we're not missing real FI requests
 */

require('dotenv').config();
const AWS = require('aws-sdk');
const pdf = require('pdf-parse');
const { detectFIRequest, matchFIRequestType } = require('../services/fiDetectionService');

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'eu-north-1'
});

const s3 = new AWS.S3();
const bucket = process.env.S3_BUCKET || 'planning-documents-2';

const LAYER2_PASSES = [
  { file: 'email-to-agent-re-dfi-roads-response.pdf', project: '404436', rejection: 'not-fi-request' },
  { file: 'la10-2026-0017-f-1-boa-island.pdf', project: '404436', rejection: 'wrong-report-type' },
  { file: '78d3fae9-36ca-4aa6-aea5-2f681bc28299.pdf', project: '404524', rejection: 'wrong-report-type' },
  { file: '8b6ecd74-374a-43d6-9f12-49832bcd2c9b.pdf', project: '404524', rejection: 'not-fi-request' },
  { file: 'dbcaffb6-8286-4daa-9240-b2442d109a08.pdf', project: '404653', rejection: 'wrong-report-type' },
  { file: '5d1fc7b9-db0b-4c23-afd6-512a6ea4b45a.pdf', project: '404659', rejection: 'not-fi-request' },
  { file: '3b170390-551a-428e-b28c-52e1ced9a8a9.pdf', project: '404660', rejection: 'wrong-report-type' }
];

async function verifyDocument(doc) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📄 FILE: ${doc.file}`);
  console.log(`   Project: ${doc.project}`);
  console.log(`   Layer 3 Rejection: ${doc.rejection}`);
  console.log('='.repeat(80));

  const s3Key = `planning-docs/${doc.project}/${doc.file}`;
  
  try {
    // Download and extract text from S3
    const params = { Bucket: bucket, Key: s3Key };
    const s3Response = await s3.getObject(params).promise();
    const fileBuffer = s3Response.Body;
    
    const pdfData = await pdf(fileBuffer);
    const extractedText = pdfData.text;
    
    if (!extractedText || extractedText.trim().length < 100) {
      console.log('❌ Insufficient text extracted');
      return;
    }

    console.log(`\n📊 Extracted ${extractedText.length} characters`);
    console.log(`\n--- FIRST 500 CHARS ---`);
    console.log(extractedText.substring(0, 500));
    console.log(`\n--- LAST 500 CHARS ---`);
    console.log(extractedText.substring(Math.max(0, extractedText.length - 500)));

    // Step 1: Check if it's an FI request
    console.log(`\n🔍 STEP 1: Checking if document is an FI request...`);
    const step1Result = await detectFIRequest(extractedText, doc.file);
    console.log(`Result: ${step1Result.isFIRequest ? '✅ YES' : '❌ NO'}`);
    if (step1Result.reason) {
      console.log(`Reason: ${step1Result.reason}`);
    }
    if (step1Result.validationQuote) {
      console.log(`Quote: "${step1Result.validationQuote.substring(0, 200)}..."`);
    }

    if (!step1Result.isFIRequest) {
      console.log(`\n✅ VERIFIED: Document correctly rejected at Step 1 (not an FI request)`);
      return;
    }

    // Step 2: Check for acoustic match
    console.log(`\n🔍 STEP 2: Checking for acoustic report match...`);
    const step2Result = await matchFIRequestType(extractedText, 'acoustic', doc.file);
    console.log(`Result: ${step2Result.matches ? '✅ MATCH' : '❌ NO MATCH'}`);
    if (step2Result.validationQuote) {
      console.log(`Quote: "${step2Result.validationQuote.substring(0, 200)}..."`);
    }

    if (!step2Result.matches) {
      console.log(`\n✅ VERIFIED: Document correctly rejected at Step 2 (wrong report type)`);
    } else {
      console.log(`\n⚠️ WARNING: Document passed both steps - this should have been a MATCH!`);
    }

  } catch (error) {
    console.error(`❌ Error processing ${doc.file}:`, error.message);
  }
}

async function main() {
  console.log(`\n${'*'.repeat(80)}`);
  console.log('VERIFYING LAYER 2 PASSES - Checking documents that passed cheap AI filter');
  console.log(`Found ${LAYER2_PASSES.length} documents to verify`);
  console.log('*'.repeat(80));

  for (const doc of LAYER2_PASSES) {
    await verifyDocument(doc);
  }

  console.log(`\n\n${'*'.repeat(80)}`);
  console.log('✅ VERIFICATION COMPLETE');
  console.log('*'.repeat(80));
}

main().catch(console.error);
