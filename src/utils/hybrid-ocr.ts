/**
 * Hybrid OCR Integration
 * 
 * Calls Python OCR service for math formula recognition.
 * Uses persistent OCR API service or falls back to spawning Python script.
 */

import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import logger from './logger.js';

// =========================================
// CONFIG
// =========================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// OCR Service API URL (persistent service that keeps models loaded)
const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || 'http://127.0.0.1:8766';

// Path to hybrid OCR script (fallback)
const PYTHON_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'math-ocr-v2.py');

// Python executable - use venv if available, fallback to system python3
const PYTHON_BIN = process.env.PYTHON_BIN || (() => {
  const venvPython = path.join(__dirname, '..', '..', 'venv', 'bin', 'python3');
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return 'python3';
})();

// =========================================
// TYPES
// =========================================

export interface HybridOcrResult {
  results: Record<string, string>;
  count: number;
  success_count: number;
  simple_count: number;
  complex_count: number;
  errors: Array<{ file: string; error: string }>;
}

export interface MathOcrResult {
  mathId: number;
  wmfFile: string;
  latex: string;
  source: 'easyocr' | 'pix2tex' | 'fallback';
}

export interface OcrLogger {
  log: (message: string) => void;
}

// =========================================
// FUNCTIONS
// =========================================

/**
 * Check if OCR Service API is available
 */
async function checkOcrServiceAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${OCR_SERVICE_URL}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json() as { status: string; models_loaded: { pix2tex: boolean; easyocr: boolean } };
      return (
        data.status === 'ok' &&
        data.models_loaded?.pix2tex === true &&
        data.models_loaded?.easyocr === true
      );
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if hybrid OCR (EasyOCR + pix2tex) is available
 * First tries OCR Service API, falls back to spawning Python script
 */
export async function checkHybridOcrAvailable(): Promise<boolean> {
  // First try OCR Service API (preferred - keeps GPU memory stable)
  const apiAvailable = await checkOcrServiceAvailable();
  if (apiAvailable) {
    logger.info('[OCR] Using persistent OCR Service API');
    return true;
  }

  // Check if Python script exists
  if (!fs.existsSync(PYTHON_SCRIPT)) {
    logger.warn({ script: PYTHON_SCRIPT }, '[OCR] Python script not found');
    return false;
  }

  // Fallback to spawning Python script
  logger.info('[OCR] OCR Service not available, checking Python script...');
  return new Promise((resolve) => {
    const child = spawn(PYTHON_BIN, [PYTHON_SCRIPT, '--check'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        try {
          const status = JSON.parse(stdout);
          resolve(status.hybrid_ready === true);
        } catch {
          resolve(false);
        }
      } else {
        resolve(false);
      }
    });

    child.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Run hybrid OCR via API service
 */
async function runHybridOcrViaApi(
  pngDir: string,
  ocrLogger?: OcrLogger
): Promise<HybridOcrResult> {
  ocrLogger?.log(`Running hybrid OCR via API service on: ${pngDir}`);

  const response = await fetch(`${OCR_SERVICE_URL}/ocr/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory: pngDir, pattern: '*.png' }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OCR Service error: ${response.status} - ${error}`);
  }

  const result = (await response.json()) as HybridOcrResult;
  ocrLogger?.log(`Hybrid OCR (API) completed: ${result.success_count}/${result.count} successful`);
  ocrLogger?.log(`  - Simple (EasyOCR): ${result.simple_count}`);
  ocrLogger?.log(`  - Complex (pix2tex): ${result.complex_count}`);

  return result;
}

/**
 * Run hybrid OCR via spawning Python script (fallback)
 */
async function runHybridOcrViaScript(
  pngDir: string,
  ocrLogger?: OcrLogger
): Promise<HybridOcrResult> {
  return new Promise((resolve, reject) => {
    ocrLogger?.log(`Running hybrid OCR via Python script on: ${pngDir}`);

    const child: ChildProcess = spawn(
      PYTHON_BIN,
      [PYTHON_SCRIPT, '--batch-dir', pngDir],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      }
    );

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });

    child.stderr?.on('data', (d: Buffer) => {
      const msg = d.toString();
      stderr += msg;
      // Print progress
      if (msg.includes('Processing')) {
        process.stdout.write('.');
      }
    });

    child.on('close', (code) => {
      console.log('');
      if (code === 0) {
        try {
          const result = JSON.parse(stdout) as HybridOcrResult;
          ocrLogger?.log(`Hybrid OCR (script) completed: ${result.success_count}/${result.count} successful`);
          ocrLogger?.log(`  - Simple (EasyOCR): ${result.simple_count}`);
          ocrLogger?.log(`  - Complex (pix2tex): ${result.complex_count}`);
          resolve(result);
        } catch (e) {
          reject(new Error(`Failed to parse hybrid OCR output: ${(e as Error).message}`));
        }
      } else {
        reject(new Error(`Hybrid OCR exited with code ${code}: ${stderr}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Run hybrid OCR on a directory of PNG images
 * First tries OCR Service API, falls back to spawning Python script
 */
export async function runHybridOcr(
  pngDir: string,
  ocrLogger?: OcrLogger
): Promise<HybridOcrResult> {
  // First try OCR Service API (preferred - no GPU memory accumulation)
  const apiAvailable = await checkOcrServiceAvailable();
  if (apiAvailable) {
    try {
      return await runHybridOcrViaApi(pngDir, ocrLogger);
    } catch (e) {
      ocrLogger?.log(`OCR API failed: ${(e as Error).message}, falling back to script`);
    }
  }

  // Fallback to spawning Python script
  return runHybridOcrViaScript(pngDir, ocrLogger);
}

/**
 * Build OCR results map from hybrid OCR output
 */
export function buildOcrResults(
  mathIdToWmf: Map<number, string>,
  wmfToPng: Map<string, string>,
  hybridResults: HybridOcrResult,
  ocrLogger?: OcrLogger
): Map<number, MathOcrResult> {
  const results = new Map<number, MathOcrResult>();
  let convertedCount = 0;
  let failedCount = 0;

  for (const [mathId, wmfFile] of mathIdToWmf) {
    const pngPath = wmfToPng.get(wmfFile);
    if (pngPath) {
      const pngFilename = path.basename(pngPath);
      const latex = hybridResults.results[pngFilename];

      if (latex && latex.trim() !== '') {
        results.set(mathId, {
          mathId,
          wmfFile,
          latex: latex,
          source: 'easyocr',
        });
        convertedCount++;
      } else {
        // OCR returned empty - use fallback
        results.set(mathId, {
          mathId,
          wmfFile,
          latex: `[công thức ${mathId}]`,
          source: 'fallback',
        });
        failedCount++;
        ocrLogger?.log(`  OCR empty for MATH_${mathId}: ${wmfFile}`);
      }
    } else {
      // WMF couldn't be converted to PNG
      results.set(mathId, {
        mathId,
        wmfFile,
        latex: `[công thức ${mathId}]`,
        source: 'fallback',
      });
      failedCount++;
      ocrLogger?.log(`  WMF not converted: MATH_${mathId} (${wmfFile})`);
    }
  }

  if (ocrLogger && failedCount > 0) {
    ocrLogger.log(`OCR Results: ${convertedCount} success, ${failedCount} fallback`);
  }

  return results;
}

export default {
  checkHybridOcrAvailable,
  runHybridOcr,
  buildOcrResults,
  PYTHON_SCRIPT,
  PYTHON_BIN,
  OCR_SERVICE_URL,
};
