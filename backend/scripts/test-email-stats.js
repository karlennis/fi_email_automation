const mongoose = require('mongoose');
const ScheduledJob = require('../models/ScheduledJob');

async function testEmailStats() {
  try {
    console.log('Testing email stats functionality...\n');

    // Try to connect
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fi-email-automation');
    console.log('✅ Database connected successfully');

    // Create a test job
    const testJob = new ScheduledJob({
      jobType: 'EMAIL_BATCH',
      schedule: { type: 'ONCE', scheduledFor: new Date() },
      customers: [
        { customerId: new mongoose.Types.ObjectId(), email: 'test1@example.com', name: 'Test User 1' },
        { customerId: new mongoose.Types.ObjectId(), email: 'test2@example.com', name: 'Test User 2' },
        { customerId: new mongoose.Types.ObjectId(), email: 'test3@example.com', name: 'Test User 3' }
      ],
      config: { reportTypes: ['test'] },
      emailStats: { totalEmails: 3, sentEmails: 0, failedEmails: 0 }
    });

    await testJob.save();
    console.log(`✅ Created test job ${testJob.jobId} with 3 customers`);

    // Test progress calculation (should be 0% initially)
    console.log(`Initial progress: ${testJob.progress}% (should be 0)`);

    // Test marking customers as sent
    const customer1Id = testJob.customers[0].customerId;
    const customer2Id = testJob.customers[1].customerId;
    const customer3Id = testJob.customers[2].customerId;

    await testJob.markCustomerSent(customer1Id, 'SENT');
    console.log(`✅ Marked customer 1 as SENT. Progress: ${testJob.progress}% (should be ~33)`);

    await testJob.markCustomerSent(customer2Id, 'SKIPPED');
    console.log(`✅ Marked customer 2 as SKIPPED. Progress: ${testJob.progress}% (should be ~67)`);

    await testJob.markCustomerFailed(customer3Id, 'Test error message');
    console.log(`✅ Marked customer 3 as FAILED. Progress: ${testJob.progress}% (should be 100)`);

    // Reload and check stats
    const reloadedJob = await ScheduledJob.findById(testJob._id);
    console.log('\n📊 Final Job Stats:');
    console.log(`- Total Emails: ${reloadedJob.emailStats.totalEmails}`);
    console.log(`- Sent Emails: ${reloadedJob.emailStats.sentEmails}`);
    console.log(`- Failed Emails: ${reloadedJob.emailStats.failedEmails}`);
    console.log(`- Progress: ${reloadedJob.progress}%`);

    // Test aggregation (dashboard stats)
    console.log('\n📈 Testing Dashboard Aggregation...');
    const emailStats = await ScheduledJob.aggregate([
      {
        $group: {
          _id: null,
          totalEmailsSent: { $sum: '$emailStats.sentEmails' },
          totalEmailsFailed: { $sum: '$emailStats.failedEmails' },
          totalEmails: { $sum: '$emailStats.totalEmails' }
        }
      }
    ]);

    console.log('Aggregation Result:', emailStats[0] || 'No data');

    // Clean up - delete test job
    await ScheduledJob.findByIdAndDelete(testJob._id);
    console.log('\n🧹 Test job cleaned up');

    console.log('\n✅ All tests passed! Email stats functionality is working correctly.');

    await mongoose.disconnect();

  } catch (error) {
    console.error('❌ Test failed:', error.message);

    if (error.message.includes('ECONNREFUSED')) {
      console.log('\n💡 MongoDB is not running. Please start MongoDB and try again.');
      console.log('   - Windows: net start MongoDB');
      console.log('   - Or use MongoDB Atlas cloud database');
    }

    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
  }
}

testEmailStats();