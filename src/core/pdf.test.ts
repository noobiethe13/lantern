import { describe, expect, test } from 'bun:test';
import { extractPdfText } from './pdf';

// Builds a minimal single-page PDF containing the given line of text. No xref
// table — pdf.js reconstructs the object index by scanning, which keeps the
// fixture builder simple and offset-free.
function minimalPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${stream.length} >> stream
${stream}
endstream
endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF`;
  return new TextEncoder().encode(pdf);
}

describe('extractPdfText', () => {
  test('extracts text content from a PDF', async () => {
    const text = await extractPdfText(minimalPdf('Hello lantern resume'));
    expect(text).toContain('Hello lantern resume');
  });

  test('throws on a non-PDF buffer', async () => {
    const garbage = new TextEncoder().encode('this is not a pdf at all');
    await expect(extractPdfText(garbage)).rejects.toThrow();
  });
});
