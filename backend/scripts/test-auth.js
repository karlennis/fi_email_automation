const axios = require('axios');
require('dotenv').config();

const API_BASE = process.env.API_BASE_URL || 'http://localhost:5000/api';

/**
 * Test the authentication system after role migration
 */
async function testAuthentication() {
  try {
    console.log('🧪 Testing authentication system...');
    console.log(`📡 API Base URL: ${API_BASE}`);

    // The password is never written in this file. Supply it for the one run:
    //   TEST_ADMIN_PASSWORD=... node scripts/test-auth.js
    const adminPassword = process.env.TEST_ADMIN_PASSWORD;
    if (!adminPassword) {
      console.error('❌ TEST_ADMIN_PASSWORD is not set. Pass the admin password in the environment for this run.');
      return;
    }

    // Test login with the primary admin account
    console.log('\n1️⃣ Testing admin login...');

    const loginResponse = await axios.post(`${API_BASE}/auth/login`, {
      email: process.env.TEST_ADMIN_EMAIL || 'afatogun@buildinginfo.com',
      password: adminPassword
    });

    if (loginResponse.data.success) {
      console.log('✅ Login successful!');
      console.log(`   - User: ${loginResponse.data.data.user.name} (${loginResponse.data.data.user.email})`);
      console.log(`   - Role: ${loginResponse.data.data.user.role}`);
      console.log(`   - Permissions: ${JSON.stringify(loginResponse.data.data.user.permissions, null, 2)}`);

      const token = loginResponse.data.data.token;

      // Test protected route
      console.log('\n2️⃣ Testing protected route access...');

      const meResponse = await axios.get(`${API_BASE}/auth/me`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (meResponse.data.success) {
        console.log('✅ Protected route access successful!');
        console.log(`   - Current user: ${meResponse.data.data.user.name}`);
        console.log(`   - Can manage users: ${meResponse.data.data.user.permissions?.canManageUsers}`);
      }

      // Test user management endpoint
      console.log('\n3️⃣ Testing user management access...');

      const usersResponse = await axios.get(`${API_BASE}/auth/users`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (usersResponse.data.success) {
        console.log('✅ User management access successful!');
        console.log(`   - Found ${usersResponse.data.data.users.length} users`);
        usersResponse.data.data.users.forEach(user => {
          console.log(`     • ${user.email}: ${user.role}`);
        });
      }

      console.log('\n🎉 All authentication tests passed!');

    } else {
      console.error('❌ Login failed:', loginResponse.data.error);
    }

  } catch (error) {
    console.error('❌ Authentication test failed:');

    if (error.response) {
      console.error(`   - Status: ${error.response.status}`);
      console.error(`   - Error: ${error.response.data?.error || error.response.data?.message}`);
      console.error(`   - Details: ${JSON.stringify(error.response.data, null, 2)}`);
    } else if (error.request) {
      console.error('   - No response received. Is the server running?');
      console.error(`   - Request URL: ${error.config?.url}`);
    } else {
      console.error(`   - Error: ${error.message}`);
    }
  }
}

// Run the test if this script is executed directly
if (require.main === module) {
  testAuthentication()
    .then(() => {
      console.log('\n✅ Authentication test completed');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ Test suite failed:', error.message);
      process.exit(1);
    });
}

module.exports = testAuthentication;