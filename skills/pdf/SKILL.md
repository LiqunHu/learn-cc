---
name: pdf
description: Process PDF files - extract text, create PDFs, merge documents. Use when user asks to read PDF, create PDF, or work with PDF files.
---

# PDF Processing Skill

You now have expertise in PDF manipulation with Node.js. Follow these workflows:

## Reading PDFs

**Option 1: Quick text extraction (preferred)**
```bash
# Using pdftotext (poppler-utils)
pdftotext input.pdf -  # Output to stdout
pdftotext input.pdf output.txt  # Output to file

# If pdftotext not available, use pdf-parse:
npm install pdf-parse
node -e "
import('pdf-parse').then(async ({ default: pdf }) => {
  const fs = await import('node:fs')
  const data = await pdf(fs.readFileSync('input.pdf'))
  console.log(data.text)
})
"
```

**Option 2: Page-by-page with metadata**
```javascript
import fs from 'node:fs'
import pdf from 'pdf-parse' // npm install pdf-parse

const data = await pdf(fs.readFileSync('input.pdf'))
console.log(`Pages: ${data.numpages}`)
console.log(`Info:`, data.info)
console.log(data.text)
```

## Creating PDFs

**Option 1: From Markdown (recommended)**
```bash
# Using pandoc
pandoc input.md -o output.pdf

# With custom styling
pandoc input.md -o output.pdf --pdf-engine=xelatex -V geometry:margin=1in
```

**Option 2: Programmatically with PDFKit**
```javascript
import PDFDocument from 'pdfkit' // npm install pdfkit
import fs from 'node:fs'

const doc = new PDFDocument()
doc.pipe(fs.createWriteStream('output.pdf'))
doc.fontSize(16).text('Hello, PDF!', 100, 100)
doc.end()
```

**Option 3: From HTML**
```bash
# Using wkhtmltopdf
wkhtmltopdf input.html output.pdf

# Or with Puppeteer
npm install puppeteer
```

```javascript
import puppeteer from 'puppeteer'

const browser = await puppeteer.launch()
const page = await browser.newPage()
await page.goto('file:///path/to/input.html', { waitUntil: 'networkidle0' })
await page.pdf({ path: 'output.pdf', format: 'A4' })
await browser.close()
```

## Merging PDFs

```javascript
import { PDFDocument } from 'pdf-lib' // npm install pdf-lib
import fs from 'node:fs'

const merged = await PDFDocument.create()
for (const pdfPath of ['file1.pdf', 'file2.pdf', 'file3.pdf']) {
  const src = await PDFDocument.load(fs.readFileSync(pdfPath))
  const pages = await merged.copyPages(src, src.getPageIndices())
  pages.forEach((p) => merged.addPage(p))
}
fs.writeFileSync('merged.pdf', await merged.save())
```

## Splitting PDFs

```javascript
import { PDFDocument } from 'pdf-lib'
import fs from 'node:fs'

const src = await PDFDocument.load(fs.readFileSync('input.pdf'))
for (let i = 0; i < src.getPageCount(); i++) {
  const single = await PDFDocument.create()
  const [page] = await single.copyPages(src, [i])
  single.addPage(page)
  fs.writeFileSync(`page_${i + 1}.pdf`, await single.save())
}
```

## Key Libraries

| Task | Library | Install |
|------|---------|---------|
| Read / extract text | pdf-parse | `npm install pdf-parse` |
| Create from scratch | PDFKit | `npm install pdfkit` |
| Merge / split / edit | pdf-lib | `npm install pdf-lib` |
| HTML to PDF | Puppeteer | `npm install puppeteer` |
| Text extraction (CLI) | pdftotext | `brew install poppler` / `apt install poppler-utils` |

## Best Practices

1. **Always check if tools are installed** before using them
2. **Handle encoding issues** - PDFs may contain various character encodings
3. **Large PDFs**: Process page by page to avoid memory issues
4. **OCR for scanned PDFs**: Use Tesseract (`tesseract.js`) if text extraction returns empty
