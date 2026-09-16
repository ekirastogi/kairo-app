import { Injectable } from '@angular/core';
import { getDocument, GlobalWorkerOptions, PDFDocumentProxy } from 'pdfjs-dist';
import { ParsedContractNote } from '../models/contract-note.models';
import { parseContractNoteText } from '../utils/contract-note-parse.utils';

// Served from /assets (copied from pdfjs-dist via angular.json). import.meta.url
// resolves to a broken hosting path in production Firebase builds.
GlobalWorkerOptions.workerSrc = new URL(
  'assets/pdf.worker.min.mjs',
  document.baseURI
).toString();

@Injectable({ providedIn: 'root' })
export class ContractNoteParserService {
  async parseFile(file: File, password: string): Promise<ParsedContractNote> {
    if (!password?.trim()) {
      throw new Error('Contract note password is required. Save it under Settings → Contract notes.');
    }
    const buffer = await file.arrayBuffer();
    const text = await this.extractText(buffer, password.trim());
    return parseContractNoteText(text);
  }

  private async extractText(buffer: ArrayBuffer, password: string): Promise<string> {
    let pdf: PDFDocumentProxy;
    try {
      const loadingTask = getDocument({ data: new Uint8Array(buffer), password });
      pdf = await loadingTask.promise;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/password/i.test(message)) {
        throw new Error('Wrong contract note password. Update it in Settings → Contract notes.');
      }
      throw new Error(`Could not open contract note PDF: ${message}`);
    }

    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const line = content.items
        .map((item) => ('str' in item ? String(item.str) : ''))
        .filter(Boolean)
        .join(' ');
      pages.push(line);
    }
    await pdf.destroy();
    return pages.join('\n');
  }
}
