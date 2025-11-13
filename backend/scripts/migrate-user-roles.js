const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config();

/**
 * Migration script to update old 'user' roles to 'operator'
 */
async function migrateUserRoles() {
  try {
    console.log('🔄 Starting user role migration...');

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Connected to MongoDB');

    // Find all users with the old 'user' role
    const usersWithOldRole = await mongoose.connection.collection('users').find({
      role: 'user'
    }).toArray();

    console.log(`📊 Found ${usersWithOldRole.length} users with old 'user' role`);

    if (usersWithOldRole.length > 0) {
      // Update all 'user' roles to 'operator'
      const result = await mongoose.connection.collection('users').updateMany(
        { role: 'user' },
        {
          $set: {
            role: 'operator',
            // Ensure they have the default operator permissions
            'permissions.canManageUsers': false,
            'permissions.canManageJobs': true,
            'permissions.canViewAllJobs': false,
            'permissions.canManageSystem': false
          }
        }
      );

      console.log(`✅ Successfully updated ${result.modifiedCount} user records`);

      // List the updated users
      for (const user of usersWithOldRole) {
        console.log(`   - ${user.email}: user → operator`);
      }
    } else {
      console.log('✅ No users found with old role - migration not needed');
    }

    // Verify the migration
    const remainingOldRoles = await mongoose.connection.collection('users').countDocuments({
      role: 'user'
    });

    if (remainingOldRoles === 0) {
      console.log('✅ Migration completed successfully - no old roles remaining');
    } else {
      console.warn(`⚠️  Warning: ${remainingOldRoles} users still have old 'user' role`);
    }

    // Show current role distribution
    const roleCounts = await mongoose.connection.collection('users').aggregate([
      {
        $group: {
          _id: '$role',
          count: { $sum: 1 }
        }
      }
    ]).toArray();

    console.log('\n📊 Current role distribution:');
    roleCounts.forEach(roleCount => {
      console.log(`   - ${roleCount._id}: ${roleCount.count} users`);
    });

  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
    console.log('✅ Migration script completed');
  }
}

// Run the migration if this script is executed directly
if (require.main === module) {
  migrateUserRoles()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}

module.exports = migrateUserRoles;