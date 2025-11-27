// Install Chrome for Puppeteer on Render
const { execSync } = require('child_process');

try {
    console.log('Installing Chrome for Puppeteer...');
    execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });
    console.log('Chrome installed successfully');
} catch (error) {
    console.error('Error installing Chrome:', error.message);
    console.log('Note: Chrome will be downloaded on first Puppeteer launch if installation fails');
    // Don't exit with error, let Puppeteer handle it
    process.exit(0);
}

