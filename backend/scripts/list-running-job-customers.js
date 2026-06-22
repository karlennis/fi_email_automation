// Temp script: list customers for currently RUNNING scan job(s)
require('dotenv').config();
const mongoose = require('mongoose');
const ScanJob = require('../models/ScanJob');
require('../models/Customer'); // ensure Customer model is registered for populate

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fi-email-automation');

  const jobs = await ScanJob.find({ status: { $in: ['RUNNING', 'CANCELLING'] } })
    .populate('customers.customerId', 'email company name projectId filters')
    .lean();

  if (!jobs.length) {
    console.log('No RUNNING jobs found. Showing ACTIVE jobs instead:\n');
    const active = await ScanJob.find({ status: 'ACTIVE' })
      .populate('customers.customerId', 'email company name projectId filters')
      .lean();
    printJobs(active);
  } else {
    printJobs(jobs);
  }

  await mongoose.disconnect();
  process.exit(0);
}

function printJobs(jobs) {
  for (const job of jobs) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Job: ${job.name}  (jobId: ${job.jobId})`);
    console.log(`Status: ${job.status} | Type: ${job.documentType} | Schedule: ${job.schedule?.type || 'DAILY'}`);
    console.log(`Progress: ${job.checkpoint?.processedCount || 0} / ${job.checkpoint?.totalDocuments || 0}`);
    const customers = job.customers || [];
    console.log(`Customers (${customers.length}):`);
    customers.forEach((c, i) => {
      const cust = c.customerId || {};
      const id = cust._id ? cust._id.toString() : (c.customerId ? c.customerId.toString() : 'UNKNOWN');
      const counties = cust.filters?.allowedCounties?.length ? cust.filters.allowedCounties.join(', ') : 'all';
      const sectors = cust.filters?.allowedSectors?.length ? cust.filters.allowedSectors.join(', ') : 'all';
      console.log(
        `  ${String(i + 1).padStart(2)}. ${cust.email || 'NO EMAIL'}` +
        `  | ${cust.company || cust.name || 'N/A'}` +
        `  | customerId: ${id}` +
        `  | counties: ${counties} | sectors: ${sectors}`
      );
    });
    console.log('');
    console.log('To remove a customer from this run, call:');
    console.log(`  DELETE /api/document-scan/jobs/${job.jobId}/customers/{customerId}`);
    console.log('');
  }
}

run().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
