const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const jsonPath = path.join(root, 'output', 'eleduck-jobs-preview.json');

function escapeSql(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function main() {
  if (!fs.existsSync(jsonPath)) {
    console.error(`Error: Precision JSON not found at ${jsonPath}`);
    console.log('Please run: node scripts/build-eleduck-preview-v2.js first.');
    process.exit(1);
  }

  const jobs = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  console.log(`Found ${jobs.length} precision jobs to import.`);

  for (const job of jobs) {
    // Generate a unique dedup key for Eleduck
    const dedupKey = `eleduck-precision-${job.apply_url}`;
    
    // We use a simplified insert because we only have basic info from the preview
    // The description_raw and description_clean are set to title initially
    // AI scoring will handle the rest if needed
    const sql = `
      INSERT INTO jobs (
        source, title, apply_url, dedup_key, 
        intent, market, pipeline_status, description_raw, description_clean, 
        location_raw, company
      ) 
      VALUES (
        'eleduck_precision', 
        ${escapeSql(job.title)}, 
        ${escapeSql(job.apply_url)}, 
        ${escapeSql(dedupKey)},
        'hiring', 
        'domestic',
        'new', 
        ${escapeSql(job.title)}, 
        ${escapeSql(job.title)},
        'Remote',
        ${escapeSql(job.publisher)}
      )
      ON CONFLICT (dedup_key) DO UPDATE SET
        last_seen_at = NOW(),
        is_stale = FALSE;
    `;

    try {
      // Execute via docker
      // Use a temporary file to avoid shell escaping issues with complex SQL
      const tmpFile = path.join(root, 'output', 'tmp_import.sql');
      fs.writeFileSync(tmpFile, sql, 'utf8');
      const command = `docker exec -i remote-job-monitor-postgres psql -U job_monitor -d job_monitor < "${tmpFile}"`;
      execSync(command, { stdio: 'inherit' });
      fs.unlinkSync(tmpFile);
    } catch (error) {
      console.error(`Failed to insert job: ${job.title}`);
    }
  }

  console.log('Import completed.');
}

main().catch(console.error);
