const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config();

/**
 * Update the primary admin to have admin role and full permissions
 */
async function updatePrimaryAdmin() {
  try {
    console.log('🔄 Updating primary admin account...');

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Connected to MongoDB');

    // Update the primary admin account
    const result = await User.findOneAndUpdate(
      { email: 'afatogun@buildinginfo.com' },
      {
        $set: {
          role: 'admin',
          'permissions.canManageUsers': true,
          'permissions.canManageJobs': true,
          'permissions.canViewAllJobs': true,
          'permissions.canManageSystem': true
        }
      },
      { new: true }
    );

    if (result) {
      console.log(`✅ Successfully updated primary admin: ${result.email}`);
      console.log(`   - Role: ${result.role}`);
      console.log(`   - Permissions: ${JSON.stringify(result.permissions, null, 2)}`);
    } else {
      console.error('❌ Primary admin account not found');
    }

    // Show current user status
    const allUsers = await User.find().select('email role permissions.canManageUsers');
    console.log('\n📊 All users:');
    allUsers.forEach(user => {
      console.log(`   - ${user.email}: ${user.role} (canManageUsers: ${user.permissions.canManageUsers})`);
    });

  } catch (error) {
    console.error('❌ Update failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
    console.log('✅ Primary admin update completed');
  }
}

// Run the update if this script is executed directly
if (require.main === module) {
  updatePrimaryAdmin()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Update failed:', error);
      process.exit(1);
    });
}

module.exports = updatePrimaryAdmin;