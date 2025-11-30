# SVG to Catalogue Generator

A powerful tool to batch generate marketing banners by mapping CSV data to SVG templates.

## 🚀 How It Works

This tool takes an **SVG template** and a **CSV data file** as input. It allows you to map columns from your CSV (like Product Name, Price, Image URL) to specific elements in your SVG. It then generates a unique image for every row in your CSV.

### Key Features
- **Smart ID Mapping**: Automatically lists all editable elements from your SVG.
- **Visual Previews**: See exactly which element you are mapping with visual highlights.
- **Generic Text Replacement**: Works with *any* placeholder format (e.g., `{{price}}`, `{{value}}`) or even plain text.
- **Smart Image Fitting**: Images are automatically scaled to **contain** within their boxes, ensuring no cropping occurs.
- **Group Support**: Can update text inside grouped elements (`<g>`) without breaking the layout.
- **Font Preservation**: Respects the fonts defined in your SVG while ensuring correct rendering for Hindi/Regional text.

## 📂 Try it out!

Download these sample files to test the tool immediately:
- [Sample SVG Template](sample.svg)
- [Sample Data CSV](sample.csv)

---

## 🛠️ Setup & Installation

1.  **Prerequisites**: Ensure you have [Node.js](https://nodejs.org/) installed.
2.  **Install Dependencies**:
    ```bash
    npm install
    ```
3.  **Start the Server**:
    ```bash
    node server.js
    ```
    The tool will be available at `http://localhost:3000`.

---

## 📖 How to Use

### 1. Prepare Your SVG
*   **IDs are Key**: Ensure the elements you want to change have **IDs** in your design tool.
    *   *Example*: Name your price text layer `price_text` or `rate`.
*   **Figma Export Settings**:
    *   ✅ **Check** "Include 'id' attribute".
    *   ❌ **Uncheck** "Outline text" (keep text as text).
    *   ❌ **Uncheck** "Include bounding box" (optional, usually better unchecked).
*   **Text must be Text**: Export text as **"Text"** or **"Embed Fonts"**.
    *   ❌ Do **NOT** use "Create Outlines" or "Convert to Curves". The tool cannot edit shapes.
*   **Placeholders (Optional)**: You can use placeholders like `{{product}}` in your text to preserve surrounding symbols (e.g., `₹{{price}}`).

### 2. Prepare Your CSV
*   Create a CSV file where the first row contains **Headers** (e.g., `Product Name`, `MRP`, `Image URL`).
*   Each subsequent row represents one banner to be generated.

### 3. Generate Banners
1.  Open `http://localhost:3000`.
2.  **Upload SVG**: Select your `.svg` template.
3.  **Upload CSV**: Select your `.csv` data file.
4.  **Map Data**:
    *   The tool will show a list of all editable elements found in your SVG.
    *   Use the dropdowns to select which CSV column should populate which SVG element.
    *   *Auto-Match*: The tool tries to automatically match fields if the names are similar (e.g., ID `rate` matches CSV `Rate`).
5.  **Generate**: Click the "Generate" button.
6.  **Download**: Once complete, a ZIP file containing all your banners will download automatically.

---

## ❓ Troubleshooting

| Issue | Cause | Solution |
| :--- | :--- | :--- |
| **Element not in list** | The element has no ID or is a hidden type. | specific IDs to your layers in Illustrator/Figma. |
| **Text not changing** | The element is a Shape/Outline, not Text. | Re-export SVG and uncheck "Create Outlines". |
| **Output is empty/broken** | Mapping a Group (`<g>`) that contains only shapes. | Ensure the Group contains editable `<text>` elements. |
| **Image cropped** | Aspect ratio mismatch. | The tool now uses "Contain" mode to fit images perfectly. |

---

## 💻 Technical Details

*   **Backend**: Node.js, Express, Puppeteer (for high-fidelity SVG rendering).
*   **Frontend**: Vanilla JS, Tailwind CSS.
*   **Logic**:
    *   Uses `puppeteer` to render the SVG in a headless browser.
    *   Injects data into the DOM using ID references.
    *   Captures screenshots of the updated SVG for each CSV row.
