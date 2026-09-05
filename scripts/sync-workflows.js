const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const workflowsDir = path.join(__dirname, '..', 'workflows');

async function importWorkflows() {
  console.log('Starting to sync workflows to n8n...');
  
  const files = fs.readdirSync(workflowsDir).filter(f => f.endsWith('.json'));
  
  for (const file of files) {
    const filePath = path.join(workflowsDir, file);
    console.log(`Syncing ${file}...`);
    
    try {
      // We use docker exec to run n8n's import command
      // We pipe the file content directly into the container
      const command = `docker exec -i remote-job-monitor-n8n n8n import:workflow --input=-`;
      execSync(command, { input: fs.readFileSync(filePath), stdio: 'inherit' });
    } catch (error) {
      console.error(`Failed to sync ${file}: ${error.message}`);
    }
  }
  
  console.log('Sync completed! Refresh your n8n browser tab now.');
}

importWorkflows().catch(console.error);
