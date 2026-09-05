const fs = require('fs');
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Missing Playwright. Run: npm install -D playwright && npx playwright install chromium');
  process.exit(1);
}

const projectRoot = path.resolve(__dirname, '..');
const profileDir = path.join(projectRoot, 'data', 'eleduck-browser-profile');
const researchDir = path.join(projectRoot, 'research');
const targetUrl = 'https://eleduck.com/jobs-channel?tags=0-19';

async function main() {
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(researchDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1440, height: 1050 },
  });
  const page = context.pages()[0] || await context.newPage();

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('\nA browser window is open. Log in and complete any site verification yourself.');
  console.log('When the real job list is visible, return here and press Enter.');
  console.log('This script does not solve CAPTCHAs or submit forms.\n');
  await new Promise((resolve) => process.stdin.once('data', resolve));

  await page.waitForTimeout(1000);
  const html = await page.content();
  const verificationPage = /verification|验证码加载中|captcha-element/i.test(html);
  if (verificationPage) {
    console.error('The page is still a verification page. Nothing was saved. Complete verification and run again.');
    await context.close();
    process.exitCode = 2;
    return;
  }

  const htmlPath = path.join(researchDir, 'eleduck-jobs-channel-authenticated.html');
  const screenshotPath = path.join(researchDir, 'eleduck-jobs-channel-authenticated.png');
  fs.writeFileSync(htmlPath, html, 'utf8');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`Saved HTML: ${htmlPath}`);
  console.log(`Saved screenshot: ${screenshotPath}`);
  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
