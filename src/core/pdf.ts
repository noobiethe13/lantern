import { extractText } from 'unpdf';

/**
 * Extract plain text from a PDF buffer. Pages are joined with blank lines;
 * whitespace is collapsed per line. Throws on encrypted/corrupt PDFs — the
 * caller maps that to a user-facing error.
 */
export async function extractPdfText(buf: ArrayBuffer | Uint8Array): Promise<string> {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const { text } = await extractText(data, { mergePages: false });
  return text
    .map(page =>
      page
        .split('\n')
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n'),
    )
    .filter(Boolean)
    .join('\n\n')
    .trim();
}
