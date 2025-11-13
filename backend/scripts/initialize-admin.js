const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config();

/**
 * Initialize the primary admin account
 */
async function initializePrimaryAdmin() {
  try {
    console.log('🔄 Initializing primary admin account...');

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Connected to MongoDB');

    // Call the ensurePrimaryAdmin method from the User model
    await User.ensurePrimaryAdmin();

    // Verify the primary admin exists
    const primaryAdmin = await User.findOne({ email: 'afatogun@buildinginfo.com' });

    if (primaryAdmin) {
      console.log(`✅ Primary admin verified: ${primaryAdmin.email}`);
      console.log(`   - Role: ${primaryAdmin.role}`);
      console.log(`   - Permissions: ${JSON.stringify(primaryAdmin.permissions, null, 2)}`);
    } else {
      console.error('❌ Primary admin not found after initialization');
    }

    // Show current user status
    const allUsers = await User.find().select('email role permissions.canManageUsers');
    console.log('\n📊 All users:');
    allUsers.forEach(user => {
      console.log(`   - ${user.email}: ${user.role} (canManageUsers: ${user.permissions.canManageUsers})`);
    });

  } catch (error) {
    console.error('❌ Initialization failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
    console.log('✅ Primary admin initialization completed');
  }
}

// Run the initialization if this script is executed directly
if (require.main === module) {
  initializePrimaryAdmin()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Initialization failed:', error);
      process.exit(1);
    });
}

module.exports = initializePrimaryAdmin;