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
                                el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
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

                                    img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
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

                                // Truncation Logic: Prevent Overflow
                                try {
                                    const svg = document.querySelector('svg');
                                    const svgWidth = svg.viewBox.baseVal.width || parseFloat(svg.getAttribute('width'));

                                    // Only truncate if we can determine dimensions
                                    if (svgWidth) {
                                        const bbox = el.getBBox();
                                        const x = bbox.x;
                                        const width = bbox.width;
                                        const margin = 10; // Safety margin

                                        // Collision Detection (Disabled for stability - causing text to disappear)
                                        // let rightBoundary = svgWidth;
                                        // const allElements = document.querySelectorAll('text, image, rect, path, circle, ellipse, g');

                                        // console.log(`[Collision] Checking collisions for ${svgId} (x=${x}, width=${width}). Initial Boundary: ${rightBoundary}`);

                                        // allElements.forEach(other => {
                                        //     if (other === el || other.contains(el) || el.contains(other)) return; // Skip self and hierarchy
                                        //     if (other.tagName === 'g' && other.children.length === 0) return; // Skip empty groups

                                        //     try {
                                        //         const otherBBox = other.getBBox();

                                        //         // Check for Vertical Overlap (Are they on the same line?)
                                        //         const isVerticallyOverlapping = !(bbox.y + bbox.height < otherBBox.y || bbox.y > otherBBox.y + otherBBox.height);

                                        //         // Check if it is strictly to the RIGHT of our text (with a buffer)
                                        //         // Ignore elements that start at the same X or earlier (likely backgrounds/containers)
                                        //         const isToTheRight = otherBBox.x > (bbox.x + 5);

                                        //         // Ignore "Container" elements (much larger than the text)
                                        //         const isContainer = otherBBox.width > (bbox.width * 1.5) && otherBBox.height > (bbox.height * 1.5);

                                        //         if (isVerticallyOverlapping && isToTheRight && !isContainer) {
                                        //             console.log(`[Collision] Potential neighbor: ${other.id || other.tagName} at x=${otherBBox.x}, y=${otherBBox.y}`);
                                        //             if (otherBBox.x < rightBoundary) {
                                        //                 rightBoundary = otherBBox.x;
                                        //                 console.log(`[Collision] New Boundary set by ${other.id || other.tagName}: ${rightBoundary}`);
                                        //             }
                                        //         }
                                        //     } catch (err) {
                                        //         // Ignore elements without BBox (defs, etc)
                                        //     }
                                        // });

                                        // let availableWidth = rightBoundary - x - margin;

                                        // // Safety Check: If available width is too small (false collision?), default to SVG width
                                        // if (availableWidth < 30) {
                                        //     console.log(`[Collision] Available width ${availableWidth} is too small. Ignoring collisions and using full SVG width.`);
                                        //     availableWidth = svgWidth - x - margin;
                                        // }

                                        // console.log(`[Collision] Final Available Width: ${availableWidth} (Required: ${width})`);

                                        // Simple Width Calculation
                                        const availableWidth = svgWidth - x - margin;

                                        console.log(`[Truncation] Checking ${svgId}: Width=${width}, Available=${availableWidth}`);

                                        if (width > availableWidth) {
                                            console.log(`Text ${svgId} is too long. Truncating...`);

                                            // Find the actual text node/element to truncate
                                            // If we have tspans, we should truncate the one causing the overflow (or the last one)
                                            // For simplicity, let's try to find the tspan with the most text or the one we just updated.
                                            let targetEl = el;
                                            const tspans = el.querySelectorAll('tspan');
                                            if (tspans.length > 0) {
                                                // Assume the text is in the last tspan or the one with content
                                                // A better heuristic: find the tspan that contains the replacement value?
                                                // Or just target the longest one?
                                                // Let's target the last tspan as it's usually the one extending to the right.
                                                targetEl = tspans[tspans.length - 1];
                                                console.log(`[Truncation] Targeting tspan: ${targetEl.id || 'anonymous'}`);
                                            }

                                            let text = targetEl.textContent;
                                            let loopCount = 0;

                                            // Iteratively remove characters until the PARENT fits (or the target fits?)
                                            // We must check the PARENT's BBox because that's what matters for the layout.
                                            while (el.getBBox().width > availableWidth && text.length > 0) {
                                                text = text.slice(0, -1);
                                                targetEl.textContent = text + '...';
                                                loopCount++;
                                                if (loopCount % 10 === 0) console.log(`[Truncation] Loop ${loopCount}: "${targetEl.textContent}" Width=${el.getBBox().width}`);
                                            }
                                            console.log(`[Truncation] Final Result: "${targetEl.textContent}" Width=${el.getBBox().width}`);
                                        }
                                    }
                                } catch (e) {
                                    console.log("Error in truncation:", e);
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

    // Upload Images and Collect Data
    const reportData = [];

    for (let i = 0; i < generatedFiles.length; i++) {
        const fileInfo = generatedFiles[i];
        const filePath = path.join(outputDir, fileInfo.fileName);

        console.log(`Uploading ${fileInfo.fileName}...`);
        try {
            const uploadUrl = await uploadToApi(filePath, fileInfo.fileName);
            fileInfo.uploadedUrl = uploadUrl;
            console.log(`Uploaded: ${uploadUrl}`);
        } catch (err) {
            console.error(`Upload failed for ${fileInfo.fileName}:`, err.message);
            fileInfo.uploadedUrl = "UPLOAD_FAILED";
        }

        // Find original row data
        // generatedFiles indexes might match rows if 1:1. 
        // generateBanners iterates rows i=0..length.
        // generatedFiles.push matches this order.
        const originalRow = rows[i];

        // Merge original row with new data
        reportData.push({
            ...originalRow,
            generated_file: fileInfo.fileName,
            uploaded_url: fileInfo.uploadedUrl
        });
    }

    await browser.close();
    return { generatedFiles, reportData };
}

async function uploadToApi(filePath, fileName) {
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: 'image/png' }); // Node 18+ has Blob

    // In Node < 18 or if Blob issues, we might need 'form-data' package, 
    // but the environment check showed fetch/FormData/Blob are available (v24).

    const formData = new FormData();
    formData.append('file', blob, fileName);

    const response = await fetch('https://kc.retailpulse.ai/api/photoUpload?blob=widgets', {
        method: 'POST',
        headers: {
            'accept': '*/*',
            'accept-language': 'en-US,en;q=0.9',
            'authorization': 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImJhNjNiNDM2ODM2YTkzOWI3OTViNDEyMmQzZjRkMGQyMjVkMWM3MDAiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJhY2NvdW50cy5nb29nbGUuY29tIiwiYXpwIjoiMzQyNjIyMTM0Nzc3LWxvb2Q5b2I2dnNhdHNydW9xdWY3Y3VtbTRxbzc4b3JpLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29tIiwiYXVkIjoiMzQyNjIyMTM0Nzc3LWxvb2Q5b2I2dnNhdHNydW9xdWY3Y3VtbTRxbzc4b3JpLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29tIiwic3ViIjoiMTEwNTc5OTcxNDcxMTk4NTAwMjgzIiwiaGQiOiJraXJhbmEuY2x1YiIsImVtYWlsIjoiYW5zaHVsLnNoaXZoYXJlQGtpcmFuYS5jbHViIiwiZW1haWxfdmVyaWZpZWQiOnRydWUsImF0X2hhc2giOiJpX0VmY2R4cTJOdlA5ZXEzM1dmYnVnIiwibmJmIjoxNzU0NDYwODUwLCJuYW1lIjoiQW5zaHVsIFNoaXZoYXJlIiwicGljdHVyZSI6Imh0dHBzOi8vbGgzLmdvb2dsZXVzZXJjb250ZW50LmNvbS9hL0FDZzhvY0tKenVNd0JCUWdhbndwV3pEREhyQlRhNGFqWVVIUFlQMWFNYTNmTWdQWklWUXkwdz1zOTYtYyIsImdpdmVuX25hbWUiOiJBbnNodWwiLCJmYW1pbHlfbmFtZSI6IlNoaXZoYXJlIiwiaWF0IjoxNzU0NDYxMTUwLCJleHAiOjE3NTQ0NjQ3NTAsImp0aSI6IjY0ODIyYjU2MjExYmQ1ZjlmYjU1NzE4MDQ1ZDc2NTQyYzQzZGE2YjYifQ.m8epXZHpMahp-_A0IOZ2xTJ7PbFMx_6uTtXiak-dZSzbxskFya7TPjnzH56zBSGOExEKa9oIXSOvb31pcQ0CQQUwlXGtu76XW8vZRcQ0cj_fYk-zIWuX5ycB3CIxVxziNhSXqHdPzhzUO3W61cDNO4FpGSvu0AkyRfCGkqRDdKW4fnRN9WwyCOxybmOxt-6bq-y2NF0uRY0Ozu3Qi1xpQE4YA-wnk5NejIGkfF9y-klx5jg4oqQV5WKyINd-Yu6swAS9KD7D99hXDg3-QspWJmi4WC7nIVw8KCnJ4U240Vu3qRZ_gGSAiBCOk1iDXDD0-Qixcfmk0bHxHNlu6yJgtg',
            'origin': 'https://d2r.retailpulse.ai',
            'priority': 'u=1, i',
            'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"macOS"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-site',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
        },
        body: formData
    });

    if (!response.ok) {
        throw new Error(`API responded with ${response.status} ${response.statusText}`);
    }

    // The user said the response is just the string URL, e.g. "https://..."
    // But usually APIs return JSON. The example showed just the string. 
    // Let's try text first.
    const responseText = await response.text();
    // Remove quotes if present
    return responseText.replace(/^"|"$/g, '');
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

        const { generatedFiles, reportData } = await generateBanners(req.files.svg[0].path, req.files.csv[0].path, sessionDir, mapping);

        // Generate CSV Report
        const csvReport = Papa.unparse(reportData);
        const reportPath = path.join(sessionDir, 'report.csv');
        fs.writeFileSync(reportPath, csvReport);

        // Cleanup uploads
        try {
            fs.unlinkSync(req.files.svg[0].path);
            fs.unlinkSync(req.files.csv[0].path);
        } catch (e) {
            console.log("Cleanup warning:", e.message);
        }

        res.json({ success: true, sessionId, files: generatedFiles, report: 'report.csv' });

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

// 3. Download Report
app.get('/api/download-report/:sessionId', (req, res) => {
    const reportPath = path.join(PUBLIC_TEMP_DIR, req.params.sessionId, 'report.csv');
    if (!fs.existsSync(reportPath)) return res.status(404).send("Report not found");

    res.download(reportPath, 'upload_report.csv');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Banner Generator Server running at http://localhost:${PORT}`);
});