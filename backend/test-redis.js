const Bull = require('bull');

// Your Upstash Redis URL from .env
const redisUrl = process.env.REDIS_URL || 'rediss://default:AXM7AAIncDFlODk4M2ViY2M0Njc0ZGJiODhhMWJkM2I5NTBiMDBmMnAxMjk0OTk@frank-toad-29499.upstash.io:6379';

console.log('🔍 Testing Redis connection...');
console.log('URL format:', redisUrl.split('@')[1] || 'localhost');

// Parse URL to extract components
const url = new URL(redisUrl);
const host = url.hostname;
const port = parseInt(url.port || '6379', 10);
const password = url.password;
const useTLS = url.protocol === 'rediss:';

console.log('Parsed config:', { host, port, useTLS, hasPassword: !!password });

// Test with Bull configuration + explicit TLS settings for Upstash
const config = {
  port,
  host,
  tls: useTLS ? {} : undefined, // Empty object enables TLS
  maxRetriesPerRequest: 3
};

if (password) {
  config.password = password;
}

console.log('Bull config:', { ...config, password: config.password ? '***' : undefined });

const testQueue = new Bull('test-queue', {
  redis: config,
  settings: {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    enableOfflineQueue: false
  }
});

testQueue.on('error', (err) => {
  console.error('❌ Queue error:', err.message);
});

testQueue.on('failed', (job, err) => {
  console.error('❌ Job failed:', err.message);
});

// Listen to the underlying ioredis client events
testQueue.client.on('connect', () => {
  console.log('📡 ioredis: connect event');
});

testQueue.client.on('ready', () => {
  console.log('📡 ioredis: ready event');
});

testQueue.client.on('error', (err) => {
  console.error('📡 ioredis error:', err.message);
});

testQueue.client.on('close', () => {
  console.log('📡 ioredis: close event');
});

// Wait for queue to be ready
testQueue.isReady().then(async () => {
  console.log('✅ Bull queue ready! Connection successful.');

  // Try adding a test job
  try {
    const job = await testQueue.add('test-job', { message: 'Hello Redis!' });
    console.log('✅ Test job added:', job.id);

    // Check job count
    const waiting = await testQueue.getWaitingCount();
    console.log('✅ Jobs waiting:', waiting);

    // Clean up
    await testQueue.close();
    console.log('✅ Connection closed cleanly');
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to add job:', error.message);
    process.exit(1);
  }
}).catch(err => {
  console.error('❌ Queue failed to be ready:', err.message);
  process.exit(1);
});

// Timeout after 10 seconds
setTimeout(() => {
  console.error('❌ Connection timeout after 10 seconds');
  process.exit(1);
}, 10000);
