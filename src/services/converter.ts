/**
 * Conversion Service
 * 
 * Main service for converting DOCX files to JSON
 */

import fs from 'fs';
import path from 'path';
import { parseDocx, extractImages } from '../utils/docx-parser.js';
import { convertToJson, type ExamJson } from '../utils/claude-cli.js';
import { detectSubject, DIRECTORIES, type SubjectType, type ImageInfo } from '../config.js';
import logger from '../utils/logger.js';

// ===========================================
// TYPES
// ===========================================

export interface ConversionOptions {
  subject?: SubjectType;
  outputDir?: string;
  extractImages?: boolean;
}

export interface ConversionResult {
  success: boolean;
  examId: string;
  filename: string;
  subject: SubjectType;
  json: ExamJson;
  imagePaths?: string[];
  outputPath?: string;
  timings: {
    parse: number;
    imageExtract: number;
    llm: number;
    total: number;
  };
}

// ===========================================
// MAIN CONVERSION FUNCTION
// ===========================================

/**
 * Generate unique exam ID
 */
function generateExamId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const timestamp = Date.now().toString(36);
  const random = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${timestamp}-${random}`;
}

/**
 * Convert a DOCX file to JSON
 */
export async function convertDocx(
  filePath: string,
  options: ConversionOptions = {}
): Promise<ConversionResult> {
  const startTime = Date.now();
  const timings = {
    parse: 0,
    imageExtract: 0,
    llm: 0,
    total: 0,
  };

  // Validate file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const filename = path.basename(filePath);
  const examId = generateExamId();
  
  // Detect subject from filename
  const subject = options.subject || detectSubject(filename);
  
  logger.info({ filename, examId, subject }, 'Starting DOCX conversion');

  // Step 1: Parse DOCX
  const parseStart = Date.now();
  const parsed = await parseDocx(filePath);
  timings.parse = Date.now() - parseStart;

  // Step 2: Extract images (optional)
  let imagePaths: string[] = [];
  let imageInfos: ImageInfo[] = [];
  
  if (options.extractImages !== false && parsed.images.length > 0) {
    const imageExtractStart = Date.now();
    const imageDir = path.join(options.outputDir || DIRECTORIES.OUTPUT_DIR, examId, 'images');
    imagePaths = await extractImages(filePath, imageDir);
    timings.imageExtract = Date.now() - imageExtractStart;

    // Build image metadata
    imageInfos = imagePaths.map((p, idx) => ({
      index: idx,
      relativePath: path.relative(options.outputDir || DIRECTORIES.OUTPUT_DIR, p),
      originalFilename: path.basename(p),
    }));
  }

  // Step 3: Call Claude CLI for conversion
  const llmStart = Date.now();
  
  // Build user prompt with images if available
  const { buildUserPrompt } = await import('../config.js');
  const userPrompt = buildUserPrompt(filename, parsed.text, imageInfos);
  
  const json = await convertToJson(parsed.text, filename, {});
  timings.llm = Date.now() - llmStart;

  // Step 4: Add metadata to result
  json._exam_id = examId;
  json._original_filename = filename;
  json._subject = subject;
  json._pipeline_version = 'v1-opensource';

  // Step 5: Save output (optional)
  let outputPath: string | undefined;
  if (options.outputDir) {
    const outputDir = path.join(options.outputDir, examId);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    outputPath = path.join(outputDir, 'result.json');
    fs.writeFileSync(outputPath, JSON.stringify(json, null, 2), 'utf8');
    logger.info({ outputPath }, 'Result saved');
  }

  timings.total = Date.now() - startTime;

  logger.info({
    examId,
    subject,
    questionCounts: {
      part_1: json.part_1?.questions?.length || 0,
      part_2: json.part_2?.questions?.length || 0,
      part_3: json.part_3?.questions?.length || 0,
    },
    timings,
  }, 'Conversion completed');

  return {
    success: true,
    examId,
    filename,
    subject,
    json,
    imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
    outputPath,
    timings,
  };
}

/**
 * Validate exam JSON structure
 */
export function validateExamJson(json: ExamJson): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check exam_info
  if (!json.exam_info) {
    errors.push('Missing exam_info');
  }

  // Check for at least one part with questions
  const hasPart1 = json.part_1?.questions && json.part_1.questions.length > 0;
  const hasPart2 = json.part_2?.questions && json.part_2.questions.length > 0;
  const hasPart3 = json.part_3?.questions && json.part_3.questions.length > 0;

  if (!hasPart1 && !hasPart2 && !hasPart3) {
    errors.push('No questions found in any part');
  }

  // Check answer_key
  if (!json.answer_key) {
    warnings.push('Missing answer_key');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Create summary of conversion result
 */
export function createSummary(json: ExamJson): {
  examInfo: Record<string, unknown>;
  questionCounts: { part_1: number; part_2: number; part_3: number };
  totalQuestions: number;
  hasAnswerKey: boolean;
} {
  const questionCounts = {
    part_1: json.part_1?.questions?.length || 0,
    part_2: json.part_2?.questions?.length || 0,
    part_3: json.part_3?.questions?.length || 0,
  };

  return {
    examInfo: (json.exam_info as Record<string, unknown>) || {},
    questionCounts,
    totalQuestions: questionCounts.part_1 + questionCounts.part_2 + questionCounts.part_3,
    hasAnswerKey: !!json.answer_key,
  };
}

export default {
  convertDocx,
  validateExamJson,
  createSummary,
};
