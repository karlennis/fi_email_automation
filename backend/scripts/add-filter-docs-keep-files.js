const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const s3Service = require('../services/s3Service');
const documentIngestionService = require('../services/documentIngestionService');

function parseArgs(argv) {
  const args = {
    projects: [],
    includeStaged: false,
    includeRoot: true,
    help: false
  };

  for (let index = 0; index < argv.length; index++) {
    const current = argv[index];

    if (current === '--project' || current === '-p') {
      const next = argv[index + 1];
      if (next) {
        args.projects.push(
          ...next
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)
        );
        index++;
      }
      continue;
    }

    if (current === '--include-staged') {
      args.includeStaged = true;
      continue;
    }

    if (current === '--no-staged') {
      args.includeStaged = false;
      continue;
    }

    if (current === '--root-only') {
      args.includeRoot = true;
      args.includeStaged = false;
      args.projects = [];
      continue;
    }

    if (current === '--no-root') {
      args.includeRoot = false;
      continue;
    }

    if (current === '--help' || current === '-h') {
      args.help = true;
      continue;
    }

    if (!current.startsWith('-')) {
      args.projects.push(
        ...current
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      );
    }
  }

  args.projects = [...new Set(args.projects)];
  return args;
}

function printHelp() {
  console.log(`
Add .keep sentinel files under filter-docs so prefixes remain visible and are preserved.
Default behavior adds only filter-docs/.keep.

Usage:
  node scripts/add-filter-docs-keep-files.js [options]

Options:
  --project, -p <id[,id]>   Add .keep to specific project folder(s) under filter-docs/
  --include-staged          Also add .keep for currently staged project folders
  --no-staged               Do not add for currently staged project folders
  --no-root                 Do not add filter-docs/.keep
  --root-only               Only add filter-docs/.keep
  --help, -h                Show this help text

Examples:
  node scripts/add-filter-docs-keep-files.js
  node scripts/add-filter-docs-keep-files.js --include-staged
  node scripts/add-filter-docs-keep-files.js --project 11080
  node scripts/add-filter-docs-keep-files.js --project 11080,11093 --no-staged
  node scripts/add-filter-docs-keep-files.js --root-only
`);
}

async function putKeepFile(key) {
  await s3Service.uploadDocument(
    Buffer.from('keep\n', 'utf8'),
    key,
    { sentinel: 'true', purpose: 'preserve-prefix' }
  );
  return key;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const projectIds = new Set(args.projects);

  if (args.includeStaged) {
    const staged = await documentIngestionService.listStagedProjects();
    staged.forEach((projectId) => projectIds.add(String(projectId).trim()));
  }

  const keysToCreate = [];

  if (args.includeRoot) {
    keysToCreate.push('filter-docs/.keep');
  }

  for (const projectId of projectIds) {
    if (!projectId) continue;
    keysToCreate.push(`filter-docs/${projectId}/.keep`);
  }

  if (keysToCreate.length === 0) {
    console.log('Nothing to do. Use --help for options.');
    process.exit(0);
  }

  console.log(`\n🧱 Creating ${keysToCreate.length} .keep file(s) in bucket ${s3Service.bucket}...`);

  let created = 0;
  const failures = [];

  for (const key of keysToCreate) {
    try {
      await putKeepFile(key);
      created++;
      console.log(`✅ ${key}`);
    } catch (error) {
      failures.push({ key, error: error.message });
      console.error(`❌ ${key}: ${error.message}`);
    }
  }

  console.log(`\nDone. Created ${created}/${keysToCreate.length} .keep file(s).`);

  if (failures.length > 0) {
    console.log('Failures:');
    failures.forEach((entry) => console.log(`  - ${entry.key}: ${entry.error}`));
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('❌ Failed to add .keep files:', error);
  process.exit(1);
});