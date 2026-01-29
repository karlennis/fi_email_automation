require('dotenv').config();
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

async function findInSpecificProjects() {
  const targetFiles = [
    'db778aa3-952b-4d1b-86f8-60a7184322ef.pdf',
    'ab370e0bb9d5746be96471012293d0a2-20251250W_F.I._received_Noise_Impact_Assessment_report.pdf',
    '2ce07012-ef08-4d0c-aa20-996a4c62d61b.pdf'
  ];

  // From the logs: projects 392429, 396039, 400004
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

  // Search in specific project folders
  for (const projectId of targetProjects) {
    console.log(`\n🔍 Searching in planning-docs/${projectId}/...`);
    
    try {
      const command = new ListObjectsV2Command({
        Bucket: process.env.AWS_S3_BUCKET_NAME || 'planning-documents-2',
        Prefix: `planning-docs/${projectId}/`,
        MaxKeys: 1000
      });

      const response = await s3Client.send(command);
      
      if (response.Contents) {
        totalScanned += response.Contents.length;
        console.log(`   Found ${response.Contents.length} files in this project`);
        
        // List ALL files in this project
        console.log(`   Files in project ${projectId}:`);
        response.Contents.slice(0, 10).forEach(obj => {
          const filename = obj.Key.split('/').pop();
          console.log(`      - ${filename}`);
        });
        if (response.Contents.length > 10) {
          console.log(`      ... and ${response.Contents.length - 10} more files`);
        }
        
        // Check for target files
        for (const obj of response.Contents) {
          const filename = obj.Key.split('/').pop();
          
          if (targetFiles.includes(filename)) {
            found.push({
              key: obj.Key,
              filename: filename,
              size: obj.Size,
              lastModified: obj.LastModified,
              projectId: projectId
            });
            
            console.log(`\n   ✅ FOUND TARGET FILE: ${obj.Key}`);
            console.log(`      Size: ${(obj.Size / 1024).toFixed(2)} KB`);
            console.log(`      Modified: ${obj.LastModified}`);
          }
        }
      } else {
        console.log(`   No files found in this project`);
      }
    } catch (error) {
      console.error(`   ❌ Error: ${error.message}`);
    }
  }

  console.log(`\n📊 Final Results:`);
  console.log(`   Total files scanned: ${totalScanned}`);
  console.log(`   Target files found: ${found.length}/${targetFiles.length}`);

  if (found.length > 0) {
    console.log(`\n✅ Found files:`);
    found.forEach((file, idx) => {
      console.log(`   ${idx + 1}. ${file.key}`);
    });
  }

  const notFound = targetFiles.filter(tf => !found.some(f => f.filename === tf));
  if (notFound.length > 0) {
    console.log(`\n❌ Not found in target projects:`);
    notFound.forEach((file, idx) => {
      console.log(`   ${idx + 1}. ${file}`);
    });
  }

  return found;
}

findInSpecificProjects().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
