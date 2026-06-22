// Temp: dump full state of the acoustic job to diagnose RUNNING vs ACTIVE
require('dotenv').config();
const mongoose = require('mongoose');
const ScanJob = require('../models/ScanJob');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fi-email-automation');

  const job = await ScanJob.findOne({ jobId: 'SCAN-ACOUSTIC-1775066009779' }).lean();
  if (!job) { console.log('Job not found'); process.exit(0); }

  const cp = job.checkpoint || {};
  const now = Date.now();
  const ageMin = (d) => d ? ((now - new Date(d).getTime()) / 60000).toFixed(1) + ' min ago' : 'n/a';

  console.log('Name:', job.name);
  console.log('Status:', job.status);
  console.log('updatedAt:', job.updatedAt, '(', ageMin(job.updatedAt), ')');
  console.log('');
  console.log('--- Checkpoint ---');
  console.log('processedCount/totalDocuments:', cp.processedCount, '/', cp.totalDocuments);
  console.log('matchesFound:', cp.matchesFound);
  console.log('isResuming:', cp.isResuming);
  console.log('lastProcessedFile:', cp.lastProcessedFile);
  console.log('scanStartTime:', cp.scanStartTime, '(', ageMin(cp.scanStartTime), ')');
  console.log('lastCheckpointTime:', cp.lastCheckpointTime, '(', ageMin(cp.lastCheckpointTime), ')');
  console.log('');
  console.log('--- Delivery state ---');
  console.log(JSON.stringify(job.deliveryState || {}, null, 2));
  console.log('');
  console.log('--- Schedule ---');
  console.log(JSON.stringify(job.schedule || {}, null, 2));

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
