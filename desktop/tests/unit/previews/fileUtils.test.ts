/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  getFileExtension,
  getContentTypeByExtension,
  isImageFile,
  isTextFile,
  isOfficeFile,
  isPanelPreviewable,
  FILE_EXTENSION_MAP,
} from '@/renderer/pages/conversation/Preview/fileUtils';

describe('fileUtils', () => {
  describe('getFileExtension', () => {
    it('extracts extension in lowercase', () => {
      expect(getFileExtension('document.PDF')).toBe('pdf');
      expect(getFileExtension('script.TS')).toBe('ts');
    });

    it('returns empty string for no extension', () => {
      expect(getFileExtension('noextension')).toBe('');
      expect(getFileExtension('')).toBe('');
    });

    it('returns empty string for dot at end', () => {
      expect(getFileExtension('file.')).toBe('');
    });

    it('extracts last extension for multi-dot names', () => {
      expect(getFileExtension('archive.tar.gz')).toBe('gz');
    });

    it('handles null-ish input gracefully', () => {
      expect(getFileExtension('')).toBe('');
    });
  });

  describe('getContentTypeByExtension', () => {
    it('returns markdown for .md', () => {
      expect(getContentTypeByExtension('README.md')).toBe('markdown');
    });

    it('returns html for .html', () => {
      expect(getContentTypeByExtension('index.html')).toBe('html');
    });

    it('returns pdf for .pdf', () => {
      expect(getContentTypeByExtension('report.pdf')).toBe('pdf');
    });

    it('returns word for .docx', () => {
      expect(getContentTypeByExtension('document.docx')).toBe('word');
    });

    it('returns ppt for .pptx', () => {
      expect(getContentTypeByExtension('slides.pptx')).toBe('ppt');
    });

    it('returns excel for .xlsx', () => {
      expect(getContentTypeByExtension('spreadsheet.xlsx')).toBe('excel');
    });

    it('returns image for .png', () => {
      expect(getContentTypeByExtension('photo.png')).toBe('image');
    });

    it('returns diff for .diff', () => {
      expect(getContentTypeByExtension('changes.diff')).toBe('diff');
    });

    it('returns code as default for unknown extension', () => {
      expect(getContentTypeByExtension('script.ts')).toBe('code');
      expect(getContentTypeByExtension('app.jsx')).toBe('code');
    });

    it('returns code for files without extension', () => {
      expect(getContentTypeByExtension('Makefile')).toBe('code');
    });
  });

  describe('isImageFile', () => {
    it('returns true for image extensions', () => {
      expect(isImageFile('photo.png')).toBe(true);
      expect(isImageFile('icon.svg')).toBe(true);
      expect(isImageFile('image.JPEG')).toBe(true);
    });

    it('returns false for non-image files', () => {
      expect(isImageFile('document.pdf')).toBe(false);
      expect(isImageFile('script.ts')).toBe(false);
    });
  });

  describe('isTextFile', () => {
    it('returns true for text types', () => {
      expect(isTextFile('README.md')).toBe(true);
      expect(isTextFile('index.html')).toBe(true);
      expect(isTextFile('script.ts')).toBe(true);
    });

    it('returns false for binary types', () => {
      expect(isTextFile('document.docx')).toBe(false);
      expect(isTextFile('photo.png')).toBe(false);
      expect(isTextFile('report.pdf')).toBe(false);
    });
  });

  describe('isOfficeFile', () => {
    it('returns true for Office types', () => {
      expect(isOfficeFile('document.docx')).toBe(true);
      expect(isOfficeFile('slides.pptx')).toBe(true);
      expect(isOfficeFile('data.xlsx')).toBe(true);
    });

    it('returns false for non-Office types', () => {
      expect(isOfficeFile('photo.png')).toBe(false);
      expect(isOfficeFile('script.ts')).toBe(false);
    });
  });

  describe('FILE_EXTENSION_MAP', () => {
    it('contains markdown extensions', () => {
      expect(FILE_EXTENSION_MAP.markdown).toContain('md');
      expect(FILE_EXTENSION_MAP.markdown).toContain('markdown');
    });

    it('contains image extensions', () => {
      expect(FILE_EXTENSION_MAP.image).toContain('png');
      expect(FILE_EXTENSION_MAP.image).toContain('svg');
    });
  });

  describe('isPanelPreviewable', () => {
    it('takes what the panel renders and text it shows as code', () => {
      for (const name of ['notes.md', 'index.html', 'report.pdf', 'data.csv', 'shot.png', 'fix.diff'])
        expect(isPanelPreviewable(name)).toBe(true);
      for (const name of ['src/app.tsx', 'main.py', 'config.yaml', 'Makefile', 'LICENSE', '.gitignore'])
        expect(isPanelPreviewable(name)).toBe(true);
    });

    it('leaves binaries, unknown types, Office files and what the panel cannot render to the system app', () => {
      for (const name of [
        'archive.zip',
        'app.dmg',
        'song.mp3',
        'clip.mov',
        'old.doc',
        'deck.pptx',
        'photo.heic',
        'build',
      ])
        expect(isPanelPreviewable(name)).toBe(false);
    });
  });
});

// buildPdfSrc's stream-URL contract is covered in previewUrls.dom.test.ts
// (it now builds a backend /api/fs/stream URL from a ChatFileRef, replacing the
// old file:// path behaviour).
