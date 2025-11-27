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
async function generateBanners(svgPath, csvPath, outputDir) {
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
        svg { font-family: 'Poppins', 'Mukta', 'Tiro Devanagari Hindi', sans-serif !important; }
    `;
    svgTemplate = `<style>${fontCss}</style>` + svgTemplate;

    
    const browser = await puppeteer.launch({
        headless: 'new',
        // CRITICAL FIX: Tell it where Chrome lives in the Docker container
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-web-security'
        ]
    });


    const page = await browser.newPage();
    await page.setViewport({ width: finalWidth, height: finalHeight });
    await page.setBypassCSP(true);

    const generatedFiles = [];

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const safeName = (row.product_name || `banner_${i+1}`).replace(/[^a-z0-9\u0900-\u097F]/gi, '_');
        const fileName = `${safeName}.png`;
        const outputPath = path.join(outputDir, fileName);

        // Text Replacement
        let currentSvg = svgTemplate;
        Object.keys(row).forEach(key => {
            currentSvg = currentSvg.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), row[key] || "");
        });

        // CHANGE 1: Use 'domcontentloaded' (Fast) instead of 'networkidle0' (Slow)
        // CHANGE 2: Increase timeout to 60 seconds (60000ms) just in case
        await page.setContent(currentSvg, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // CHANGE 3: Explicitly wait for Fonts to load
        await page.evaluate(async () => {
            await document.fonts.ready; 
        });

        // Image Replacement
        if (row.image_url) {
            await page.evaluate((url) => {
                const shapes = Array.from(document.querySelectorAll('rect, path, image'));
                let el = document.getElementById('product_image_2');
                if (!el) el = shapes.find(x => x.getAttribute('fill') && x.getAttribute('fill').includes('url(#'));
                if (!el) el = document.querySelector('image:not([href^="data:"])');

                if (el) {
                    const img = document.createElementNS("http://www.w3.org/2000/svg", "image");
                    ['x', 'y', 'width', 'height'].forEach(attr => img.setAttribute(attr, el.getAttribute(attr) || 0));
                    img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
                    img.setAttribute('href', url);
                    el.parentNode.replaceChild(img, el);
                }
            }, row.image_url);

            // Wait for image load logic
            try {
                await page.evaluate(async () => {
                    const img = document.querySelector('image');
                    if (img && img.href.baseVal) {
                        await new Promise(r => { const i=new Image(); i.onload=r; i.onerror=r; i.src=img.href.baseVal; });
                    }
                });
            } catch(e) {}
        }

        await page.screenshot({ path: outputPath });
        generatedFiles.push({ name: row.product_name || `Banner ${i+1}`, fileName: fileName });
    }

    await browser.close();
    return generatedFiles;
}

// --- API ENDPOINTS ---

// 1. Generate & Preview
app.post('/api/generate', upload.fields([{ name: 'svg' }, { name: 'csv' }]), async (req, res) => {
    try {
        if (!req.files.svg || !req.files.csv) return res.status(400).send("Missing files");
        
        // Create unique session folder
        const sessionId = Date.now().toString();
        const sessionDir = path.join(PUBLIC_TEMP_DIR, sessionId);
        fs.mkdirSync(sessionDir);

        const files = await generateBanners(req.files.svg[0].path, req.files.csv[0].path, sessionDir);

        // Cleanup uploads
        fs.unlinkSync(req.files.svg[0].path);
        fs.unlinkSync(req.files.csv[0].path);

        res.json({ success: true, sessionId, files });

    } catch (e) {
        console.error(e);
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
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));