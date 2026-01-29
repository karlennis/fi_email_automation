require('dotenv').config();
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

async function findSpecificFiles() {
  const targetFiles = [
    'db778aa3-952b-4d1b-86f8-60a7184322ef.pdf',
    'ab370e0bb9d5746be96471012293d0a2-20251250W_F.I._received_Noise_Impact_Assessment_report.pdf',
    '2ce07012-ef08-4d0c-aa20-996a4c62d61b.pdf'
  ];

  // From the logs, we know these are from projects: 392429, 396039, 400004
  const targetProjects = ['392429', '396039', '400004'];

  console.log('🔍 Searching for specific files in specific projects...\n');
  console.log('Target files:');
  targetFiles.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  console.log('\nTarget projects (from metadata API logs):');
  targetProjects.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  console.log('');
  
  const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'eu-west-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });

  const found = [];
  let totalScanned = 0;

  // Scan through S3 in batches
  for (let batch = 0; batch < 50; batch++) {
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
        
        // Check each file
        for (const obj of response.Contents) {
          const filename = obj.Key.split('/').pop();
          
          if (targetFiles.includes(filename)) {
            found.push({
              key: obj.Key,
              filename: filename,
              size: obj.Size,
              lastModified: obj.LastModified
            });
            
            console.log(`✅ FOUND: ${obj.Key}`);
            console.log(`   Size: ${(obj.Size / 1024).toFixed(2)} KB`);
            console.log(`   Modified: ${obj.LastModified}`);
            console.log('');
          }
        }
      }

      if (found.length === targetFiles.length) {
        console.log('✅ Found all target files!');
        break;
      }

      console.log(`Scanned ${totalScanned} files, found ${found.length}/${targetFiles.length}...`);

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
  console.log(`   Target files found: ${found.length}/${targetFiles.length}`);

  if (found.length > 0) {
    console.log(`\n📁 Found files:`);
    found.forEach((file, idx) => {
      console.log(`   ${idx + 1}. ${file.key}`);
    });
  }

  const notFound = targetFiles.filter(tf => !found.some(f => f.filename === tf));
  if (notFound.length > 0) {
    console.log(`\n❌ Not found in S3:`);
    notFound.forEach((file, idx) => {
      console.log(`   ${idx + 1}. ${file}`);
    });
  }

  return found;
}

findSpecificFiles().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
