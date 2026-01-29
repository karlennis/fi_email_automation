require('dotenv').config();
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

async function findFIFiles() {
  console.log('🔍 Searching for FI-related files in S3...\n');
  
  const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'eu-west-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });

  const fiKeywords = ['f.i.', 'f_i_', 'further', 'information', 'clarification', 'additional'];
  const foundFiles = [];
  let totalScanned = 0;
  let continuationToken = undefined;

  // Scan through S3 in batches
  for (let batch = 0; batch < 20; batch++) {
    try {
      const command = new ListObjectsV2Command({
        Bucket: process.env.AWS_S3_BUCKET_NAME || 'planning-documents-2',
        Prefix: 'planning-docs/',
        MaxKeys: 1000,
        ContinuationToken: continuationToken
      });

      const response = await s3Client.send(command);
      
      if (response.Contents) {
        totalScanned += response.Contents.length;
        
        // Check each file for FI keywords in filename
        for (const obj of response.Contents) {
          const lowerKey = obj.Key.toLowerCase();
          
          // Look for FI keywords
          if (fiKeywords.some(keyword => lowerKey.includes(keyword))) {
            foundFiles.push({
              key: obj.Key,
              size: obj.Size,
              lastModified: obj.LastModified
            });
            
            console.log(`✅ Found: ${obj.Key}`);
          }
        }
      }

      console.log(`Scanned ${totalScanned} files, found ${foundFiles.length} FI-related files...`);

      // Check if there are more results
      if (!response.IsTruncated) {
        console.log('✅ Reached end of S3 bucket');
        break;
      }

      continuationToken = response.NextContinuationToken;

    } catch (error) {
      console.error(`❌ Error scanning S3: ${error.message}`);
      break;
    }
  }

  console.log(`\n📊 Results:`);
  console.log(`   Total files scanned: ${totalScanned}`);
  console.log(`   FI-related files found: ${foundFiles.length}`);

  if (foundFiles.length > 0) {
    console.log(`\n📁 Top 10 FI files:`);
    foundFiles.slice(0, 10).forEach((file, idx) => {
      console.log(`   ${idx + 1}. ${file.key}`);
      console.log(`      Size: ${(file.size / 1024).toFixed(2)} KB, Modified: ${file.lastModified}`);
    });
  }

  return foundFiles;
}

findFIFiles().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
