// sheet-render.js — reading PDFs and images with pdf.js.

import * as pdfjsLib from '../vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

async function openPdf(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return pdfjsLib.getDocument({ data: bytes }).promise;
}

// Opened PDFs stay open, so flipping between sheets of the same file is fast.
const openDocs = new Map(); // fileId -> Promise<PDFDocument>

export function getPdf(fileId, blob) {
  if (!openDocs.has(fileId)) openDocs.set(fileId, openPdf(blob));
  return openDocs.get(fileId);
}

// Page count and size of every page, used when a PDF is first imported.
export async function readPdfPages(blob) {
  const doc = await openPdf(blob);
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      pages.push({ pageNumber: n, width: vp.width, height: vp.height });
    }
    return pages;
  } finally {
    doc.destroy();
  }
}

export function readImageSize(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That image could not be read.'));
    };
    img.src = url;
  });
}
