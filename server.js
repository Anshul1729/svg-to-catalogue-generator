const express = require('express');
const multer = require('multer');
const puppeteer = require('puppeteer');
const AdmZip = require('adm-zip');
const Papa = require('papaparse');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.static('public')); // Serve frontend
app.use('/temp', express.static(path.join(__dirname, 'public/temp'))); // Serve generated images

// Ensure directories exist
const PUBLIC_TEMP_DIR = path.join(__dirname, 'public/temp');
if (!fs.existsSync(PUBLIC_TEMP_DIR)) fs.mkdirSync(PUBLIC_TEMP_DIR, { recursive: true });

// --- GENERATOR ENGINE ---
async function generateBanners(svgPath, csvPath, outputDir, mapping) {
    let svgTemplate = fs.readFileSync(svgPath, 'utf8');
    const csvContent = fs.readFileSync(csvPath, 'utf8');
    const rows = Papa.parse(csvContent, { header: true, skipEmptyLines: true }).data;

    // 1. SCALING LOGIC
    let width = 800, height = 400;
    const widthMatch = svgTemplate.match(/width="([\d\.]+)"/);
    const heightMatch = svgTemplate.match(/height="([\d\.]+)"/);
    const viewBoxMatch = svgTemplate.match(/viewBox="[\d\.\s]+ ([\d\.]+) ([\d\.]+)"/);

    if (widthMatch && heightMatch) {
        width = parseFloat(widthMatch[1]);
        height = parseFloat(heightMatch[1]);
    } else if (viewBoxMatch) {
        width = parseFloat(viewBoxMatch[1]);
        height = parseFloat(viewBoxMatch[2]);
    }

    const scaleFactor = 3;
    const finalWidth = Math.round(width * scaleFactor);
    const finalHeight = Math.round(height * scaleFactor);

    svgTemplate = svgTemplate.replace(/width="[^"]+"/, `width="${finalWidth}"`);
    svgTemplate = svgTemplate.replace(/height="[^"]+"/, `height="${finalHeight}"`);

    // 2. FONT INJECTION
    const fontCss = `
        @import url('https://fonts.googleapis.com/css2?family=Mukta:wght@400;600;700&family=Poppins:wght@400;600;700&family=Tiro+Devanagari+Hindi&display=swap');
        body, html { margin: 0; padding: 0; overflow: hidden; }
        /* Fonts are now only available, not forced. SVG attributes will win. */
    `;
    // Append style instead of prepend to allow SVG internal styles to win if specific
    if (svgTemplate.includes('</style>')) {
        svgTemplate = svgTemplate.replace('</style>', `${fontCss}</style>`);
    } else {
        svgTemplate = `<style>${fontCss}</style>` + svgTemplate;
    }

    // Configure for Render deployment with Docker
    // In Puppeteer Docker image, Chrome is at /usr/bin/google-chrome-stable
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ||
        (fs.existsSync('/usr/bin/google-chrome-stable') ? '/usr/bin/google-chrome-stable' :
            fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            executablePath: executablePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-features=TranslateUI',
                '--disable-ipc-flooding-protection',
                '--memory-pressure-off'
            ],
            timeout: 60000,
            protocolTimeout: 60000
        });
    } catch (error) {
        console.error('Failed to launch browser:', error);
        throw new Error(`Browser launch failed: ${error.message}`);
    }

    let page;
    try {
        page = await browser.newPage();
    } catch (error) {
        console.error('Failed to create page:', error);
        await browser.close();
        throw new Error(`Page creation failed: ${error.message}`);
    }
    await page.setViewport({ width: finalWidth, height: finalHeight });
    await page.setBypassCSP(true);

    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));

    const generatedFiles = [];

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const safeName = (row.product_name || `banner_${i + 1}`).replace(/[^a-z0-9\u0900-\u097F]/gi, '_');
        const fileName = `${safeName}.png`;
        const outputPath = path.join(outputDir, fileName);

        // Use 'domcontentloaded' (Fast) instead of 'networkidle0' (Slow)
        await page.setContent(svgTemplate, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Explicitly wait for Fonts to load
        await page.evaluate(async () => {
            await document.fonts.ready;
        });

        // Apply Mapping
        console.log("Applying Mapping:", JSON.stringify(mapping));
        if (mapping && Object.keys(mapping).length > 0) {
            await page.evaluate((row, mapping) => {
                console.log("Inside page.evaluate");
                Object.keys(mapping).forEach(svgId => {
                    const csvHeader = mapping[svgId];
                    const value = row[csvHeader];
                    console.log(`Processing ID: ${svgId}, Header: ${csvHeader}, Value: ${value}`);

                    if (value) {
                        const el = document.getElementById(svgId);
                        if (el) {
                            console.log(`Element found: ${svgId}`);
                            const tagName = el.tagName.toLowerCase();

                            if (tagName === 'image') {
                                el.setAttribute('href', value);
                                el.setAttribute('preserveAspectRatio', 'xMidYMid slice');
                            } else if (['rect', 'path', 'circle', 'ellipse'].includes(tagName)) {
                                // Check if value looks like an image URL
                                const isImageUrl = value.match(/\.(jpeg|jpg|gif|png|webp)$/i) ||
                                    value.startsWith('http') ||
                                    value.startsWith('data:');

                                if (isImageUrl) {
                                    // Replace shape with image
                                    const img = document.createElementNS("http://www.w3.org/2000/svg", "image");

                                    // Copy geometry attributes
                                    if (tagName === 'rect') {
                                        ['x', 'y', 'width', 'height', 'rx', 'ry'].forEach(attr => {
                                            if (el.hasAttribute(attr)) img.setAttribute(attr, el.getAttribute(attr));
                                        });
                                    } else {
                                        // For other shapes, use BBox (approximation)
                                        const bbox = el.getBBox();
                                        img.setAttribute('x', bbox.x);
                                        img.setAttribute('y', bbox.y);
                                        img.setAttribute('width', bbox.width);
                                        img.setAttribute('height', bbox.height);
                                    }

                                    img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
                                    img.setAttribute('href', value);
                                    img.setAttribute('id', el.id); // Keep the same ID

                                    el.parentNode.replaceChild(img, el);
                                } else {
                                    // Assume it's a color fill
                                    el.setAttribute('fill', value);
                                }
                            } else {
                                // Text Replacement Logic
                                console.log(`Processing Text Element ${svgId} (Tag: ${tagName})`);

                                // Special handling for Groups (<g>)
                                if (tagName === 'g') {
                                    console.log("Element is a Group. Searching for text descendants.");
                                    console.log(`Group innerHTML: ${el.innerHTML}`); // DEBUG: See what's inside
                                    const textDescendants = el.querySelectorAll('text, tspan');
                                    let updated = false;

                                    textDescendants.forEach(child => {
                                        const currentHTML = child.innerHTML;
                                        const currentText = child.textContent;
                                        const specificRegex = new RegExp(`{{\\s*${csvHeader}\\s*}}`, 'g');
                                        const genericRegex = /{{\s*[^}]+\s*}}/g;

                                        if (currentHTML.match(specificRegex)) {
                                            console.log(`Specific match in group child ${child.id || child.tagName}! Replacing innerHTML.`);
                                            child.innerHTML = currentHTML.replace(specificRegex, value);
                                            updated = true;
                                        } else if (currentHTML.match(genericRegex)) {
                                            console.log(`Generic match in group child ${child.id || child.tagName}! Replacing innerHTML.`);
                                            child.innerHTML = currentHTML.replace(genericRegex, value);
                                            updated = true;
                                        } else if (currentText.match(specificRegex)) {
                                            console.log(`Specific match in group child textContent. Replacing.`);
                                            child.textContent = currentText.replace(specificRegex, value);
                                            updated = true;
                                        } else if (currentText.match(genericRegex)) {
                                            console.log(`Generic match in group child textContent. Replacing.`);
                                            child.textContent = currentText.replace(genericRegex, value);
                                            updated = true;
                                        }
                                    });

                                    if (!updated) {
                                        console.log("No placeholders found in group children. Attempting to set textContent on first text child.");
                                        // Fallback: If no placeholders found, update the first text element? 
                                        // Or do nothing? Setting textContent on <g> is BAD.
                                        // Let's try to find the most relevant text child.
                                        if (textDescendants.length > 0) {
                                            textDescendants[0].textContent = value;
                                        } else {
                                            console.log("Group has no text children. Cannot update.");
                                        }
                                    }
                                    return; // Done with Group
                                }

                                // Standard Text Element Logic (text, tspan)
                                // Use innerHTML to preserve <tspan> and other internal structure
                                const currentHTML = el.innerHTML;
                                const specificRegex = new RegExp(`{{\\s*${csvHeader}\\s*}}`, 'g');
                                const genericRegex = /{{\s*[^}]+\s*}}/g;

                                console.log(`Checking HTML content of ${svgId} for specific regex ${specificRegex}`);

                                if (currentHTML.match(specificRegex)) {
                                    console.log("Specific match found! Replacing in innerHTML.");
                                    el.innerHTML = currentHTML.replace(specificRegex, value);
                                } else if (currentHTML.match(genericRegex)) {
                                    console.log("Generic match found! Replacing first placeholder in innerHTML.");
                                    // Replace the first occurrence of any placeholder
                                    el.innerHTML = currentHTML.replace(genericRegex, value);
                                } else {
                                    // Check if it exists in textContent (Fragmented placeholder case)
                                    const currentText = el.textContent;
                                    if (currentText.match(specificRegex)) {
                                        console.log("Specific match found in textContent (Fragmented). Replacing textContent.");
                                        el.textContent = currentText.replace(specificRegex, value);
                                    } else if (currentText.match(genericRegex)) {
                                        console.log("Generic match found in textContent (Fragmented). Replacing textContent.");
                                        el.textContent = currentText.replace(genericRegex, value);
                                    } else {
                                        // Fallback: Pure ID mode.
                                        const tspans = el.getElementsByTagName('tspan');
                                        if (tspans.length === 1) {
                                            console.log("No placeholder, but found single tspan. Updating tspan content.");
                                            tspans[0].textContent = value;
                                        } else {
                                            console.log("No placeholder. Replacing textContent.");
                                            el.textContent = value;
                                        }
                                    }
                                }
                            }
                        }
                    }
                });
            }, row, mapping);
        }

        // Wait for image load logic if any images were updated
        try {
            await page.evaluate(async () => {
                const images = Array.from(document.querySelectorAll('image'));
                await Promise.all(images.map(img => {
                    if (img.href.baseVal && !img.href.baseVal.startsWith('data:')) {
                        return new Promise(r => {
                            const i = new Image();
                            i.onload = r;
                            i.onerror = r;
                            i.src = img.href.baseVal;
                        });
                    }
                    return Promise.resolve();
                }));
            });
        } catch (e) { }

        await page.screenshot({ path: outputPath });
        generatedFiles.push({ name: row.product_name || `Banner ${i + 1}`, fileName: fileName });
    }

    await browser.close();
    return generatedFiles;
}

// --- API ENDPOINTS ---

// 1. Generate & Preview
app.post('/api/generate', upload.fields([{ name: 'svg' }, { name: 'csv' }]), async (req, res) => {
    try {
        if (!req.files.svg || !req.files.csv) return res.status(400).send("Missing files");

        const mapping = req.body.mapping ? JSON.parse(req.body.mapping) : {};

        // Create unique session folder
        const sessionId = Date.now().toString();
        const sessionDir = path.join(PUBLIC_TEMP_DIR, sessionId);
        fs.mkdirSync(sessionDir, { recursive: true });

        const files = await generateBanners(req.files.svg[0].path, req.files.csv[0].path, sessionDir, mapping);

        // Cleanup uploads
        try {
            fs.unlinkSync(req.files.svg[0].path);
            fs.unlinkSync(req.files.csv[0].path);
        } catch (e) {
            console.log("Cleanup warning:", e.message);
        }

        res.json({ success: true, sessionId, files });

    } catch (e) {
        console.error("Generation error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 2. Download All (Zip)
app.get('/api/download-zip/:sessionId', (req, res) => {
    const sessionDir = path.join(PUBLIC_TEMP_DIR, req.params.sessionId);
    if (!fs.existsSync(sessionDir)) return res.status(404).send("Session expired or not found");

    const zip = new AdmZip();
    zip.addLocalFolder(sessionDir);
    const zipBuffer = zip.toBuffer();

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename=banners.zip');
    res.send(zipBuffer);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Banner Generator Server running at http://localhost:${PORT}`);
});