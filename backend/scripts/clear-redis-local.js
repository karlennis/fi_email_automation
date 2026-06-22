const Redis = require('ioredis');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

if (!process.env.REDIS_URL) {
  console.error('❌ REDIS_URL not found in environment variables');
  console.error('Make sure backend/.env file exists and contains REDIS_URL');
  process.exit(1);
}

console.log('✅ Connecting to Redis:', process.env.REDIS_URL.substring(0, 30) + '...');
const redis = new Redis(process.env.REDIS_URL);

(async () => {
  console.log('🔍 Searching for stuck jobs...');
  const keys = await redis.keys('bull:scanJobQueue:*');
  console.log('📋 Found', keys.length, 'keys');

  if (keys.length > 0) {
    console.log('🧹 Deleting...');
    await redis.del(...keys);
    console.log('✅ Deleted all scan job queue keys');
  } else {
    console.log('✅ Queue already empty');
  }

  await redis.quit();
  process.exit(0);
})();
