/**
 * WMF/EMF to PNG Converter
 * 
 * Batch converts WMF/EMF formula files to PNG using LibreOffice.
 * Includes deduplication to avoid redundant conversions.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import AdmZip from 'adm-zip';
import logger from './logger.js';

// =========================================
// CONFIG
// =========================================

function getLibreOfficePath(): string {
  // 1. Check environment variable first
  if (process.env.LIBREOFFICE_PATH) {
    return process.env.LIBREOFFICE_PATH;
  }

  // 2. Try common Linux paths
  const linuxPaths = [
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/usr/local/bin/soffice',
    '/snap/bin/libreoffice',
  ];

  for (const p of linuxPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // 3. macOS default
  const macPath = '/Applications/LibreOffice.app/Contents/MacOS/soffice';
  if (fs.existsSync(macPath)) {
    return macPath;
  }

  // 4. Fallback to soffice in PATH
  return 'soffice';
}

const LIBREOFFICE_PATH = getLibreOfficePath();
const LIBREOFFICE_BATCH_SIZE = 50;

// =========================================
// TYPES
// =========================================

export interface ConversionResult {
  wmfToPng: Map<string, string>;
  pngDir: string;
  dedupStats: {
    total: number;
    unique: number;
    saved: number;
  };
}

export interface ConversionLogger {
  log: (message: string) => void;
}

// =========================================
// HELPER FUNCTIONS
// =========================================

/**
 * Ensure directory exists
 */
function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Compute MD5 hash of a file for deduplication
 */
function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Batch convert WMF files to PNG using LibreOffice
 */
async function batchConvertWmfToPng(
  wmfPaths: string[],
  pngDir: string
): Promise<Map<string, string>> {
  const wmfToPng = new Map<string, string>();

  if (wmfPaths.length === 0) return wmfToPng;

  const totalBatches = Math.ceil(wmfPaths.length / LIBREOFFICE_BATCH_SIZE);

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batchStart = batchIdx * LIBREOFFICE_BATCH_SIZE;
    const batchEnd = Math.min(batchStart + LIBREOFFICE_BATCH_SIZE, wmfPaths.length);
    const batch = wmfPaths.slice(batchStart, batchEnd);

    try {
      const filesArg = batch.map((f) => `"${f}"`).join(' ');
      const cmd = `"${LIBREOFFICE_PATH}" --headless --convert-to png --outdir "${pngDir}" ${filesArg}`;

      execSync(cmd, {
        timeout: 120000,
        stdio: 'pipe',
        maxBuffer: 50 * 1024 * 1024,
      });

      for (const wmfPath of batch) {
        const pngFile = path.basename(wmfPath).replace(/\.(wmf|emf)$/i, '.png');
        const pngPath = path.join(pngDir, pngFile);
        if (fs.existsSync(pngPath)) {
          wmfToPng.set(path.basename(wmfPath), pngPath);
        }
      }
    } catch {
      // Fallback to individual conversion
      for (const wmfPath of batch) {
        try {
          execSync(
            `"${LIBREOFFICE_PATH}" --headless --convert-to png --outdir "${pngDir}" "${wmfPath}"`,
            { timeout: 30000, stdio: 'pipe' }
          );
          const pngFile = path.basename(wmfPath).replace(/\.(wmf|emf)$/i, '.png');
          const pngPath = path.join(pngDir, pngFile);
          if (fs.existsSync(pngPath)) {
            wmfToPng.set(path.basename(wmfPath), pngPath);
          }
        } catch {
          // Skip failed files
        }
      }
    }

    process.stdout.write(
      `\r  Converting: ${batchEnd}/${wmfPaths.length} (batch ${batchIdx + 1}/${totalBatches})`
    );
  }
  console.log('');

  return wmfToPng;
}

// =========================================
// MAIN FUNCTIONS
// =========================================

/**
 * Extract WMF files from DOCX and convert to PNG
 * Uses deduplication to avoid redundant conversions
 */
export async function extractAndConvertWmf(
  zip: AdmZip,
  wmfFiles: string[],
  outputDir: string,
  conversionLogger?: ConversionLogger
): Promise<ConversionResult> {
  const mediaDir = path.join(outputDir, 'media');
  const pngDir = path.join(outputDir, 'png');

  ensureDir(mediaDir);
  ensureDir(pngDir);

  const uniqueWmfFiles = [...new Set(wmfFiles)];
  conversionLogger?.log(`Total WMF refs: ${wmfFiles.length}, Unique: ${uniqueWmfFiles.length}`);

  const hashToWmf = new Map<string, string>();
  const wmfToHash = new Map<string, string>();
  const wmfPathsToConvert: string[] = [];

  conversionLogger?.log('Extracting WMF and computing hashes...');
  for (const wmfFile of uniqueWmfFiles) {
    const entry = zip.getEntry(`word/media/${wmfFile}`);
    if (entry) {
      const wmfPath = path.join(mediaDir, wmfFile);
      fs.writeFileSync(wmfPath, entry.getData());

      const hash = computeFileHash(wmfPath);
      wmfToHash.set(wmfFile, hash);

      if (!hashToWmf.has(hash)) {
        hashToWmf.set(hash, wmfFile);
        wmfPathsToConvert.push(wmfPath);
      }
    }
  }

  const dedupStats = {
    total: uniqueWmfFiles.length,
    unique: hashToWmf.size,
    saved: uniqueWmfFiles.length - hashToWmf.size,
  };

  conversionLogger?.log(`Dedup: ${dedupStats.total} → ${dedupStats.unique} unique (saved ${dedupStats.saved})`);
  conversionLogger?.log(`Converting ${wmfPathsToConvert.length} unique WMFs to PNG...`);

  const uniqueWmfToPng = await batchConvertWmfToPng(wmfPathsToConvert, pngDir);

  // Build full mapping
  const wmfToPng = new Map<string, string>();
  for (const wmfFile of uniqueWmfFiles) {
    const hash = wmfToHash.get(wmfFile);
    if (hash) {
      const originalWmf = hashToWmf.get(hash)!;
      const pngPath = uniqueWmfToPng.get(originalWmf);
      if (pngPath) {
        wmfToPng.set(wmfFile, pngPath);
      }
    }
  }

  conversionLogger?.log(`Converted: ${uniqueWmfToPng.size} unique, mapped: ${wmfToPng.size} total`);

  return { wmfToPng, pngDir, dedupStats };
}

/**
 * Check if LibreOffice is available for WMF conversion
 */
export function isLibreOfficeAvailable(): boolean {
  try {
    execSync(`"${LIBREOFFICE_PATH}" --version`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export { LIBREOFFICE_PATH };

export default {
  extractAndConvertWmf,
  isLibreOfficeAvailable,
  LIBREOFFICE_PATH,
};
