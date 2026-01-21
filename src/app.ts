/**
 * Express Application Entry Point
 * 
 * Simple REST API for DOCX to JSON conversion
 */

import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { SERVER, DIRECTORIES, detectSubject } from './config.js';
import { convertDocx, validateExamJson, createSummary } from './services/converter.js';
import { checkCliAvailable, getClaudeUsage } from './utils/claude-cli.js';
import logger from './utils/logger.js';

// ===========================================
// EXPRESS SETUP
// ===========================================

const app = express();

// Create directories
const uploadDir = path.resolve(DIRECTORIES.UPLOAD_DIR);
const outputDir = path.resolve(DIRECTORIES.OUTPUT_DIR);

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// ===========================================
// MULTER CONFIGURATION
// ===========================================

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const uniqueId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uniqueId}${ext}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.doc', '.docx'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .doc and .docx files are allowed'));
    }
  },
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

// ===========================================
// MIDDLEWARE
// ===========================================

app.use(express.json());

// Request logging
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info({ method: req.method, path: req.path }, 'Request');
  next();
});

// ===========================================
// ROUTES
// ===========================================

/**
 * GET / - Welcome message
 */
app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'DOCX to JSON Exam Converter',
    version: '1.0.0',
    description: 'Open-source exam document converter using Claude CLI',
    endpoints: {
      'POST /convert': 'Upload and convert a DOCX file',
      'GET /health': 'Health check',
      'GET /detect': 'Preview subject detection',
    },
  });
});

/**
 * GET /health - Health check
 */
app.get('/health', async (_req: Request, res: Response) => {
  try {
    const cliAvailable = await checkCliAvailable();
    const usage = cliAvailable ? await getClaudeUsage() : null;

    res.json({
      status: cliAvailable ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      claude: {
        available: cliAvailable,
        version: usage?.cliVersion,
        model: usage?.model,
        authenticated: usage?.authenticated,
      },
    });
  } catch (error) {
    const err = error as Error;
    res.status(500).json({
      status: 'error',
      error: err.message,
    });
  }
});

/**
 * GET /detect - Preview subject detection
 */
app.get('/detect', (req: Request, res: Response) => {
  const filename = req.query.filename as string;
  if (!filename) {
    return res.status(400).json({ error: 'Missing filename query parameter' });
  }

  const subject = detectSubject(filename);
  return res.json({
    filename,
    detectedSubject: subject,
  });
});

/**
 * POST /convert - Convert DOCX to JSON
 */
app.post('/convert', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const startTime = Date.now();
  const uploadedPath = req.file.path;
  const originalFilename = req.file.originalname;

  logger.info({ filename: originalFilename, size: req.file.size }, 'File uploaded for conversion');

  try {
    // Check Claude CLI
    const cliAvailable = await checkCliAvailable();
    if (!cliAvailable) {
      return res.status(503).json({
        error: 'Claude CLI is not available. Please install and authenticate.',
        instructions: [
          'npm install -g @anthropic-ai/claude-code',
          'claude login',
        ],
      });
    }

    // Convert
    const result = await convertDocx(uploadedPath, {
      outputDir,
      extractImages: true,
    });

    // Build response
    const summary = createSummary(result.json);
    const validation = validateExamJson(result.json);

    return res.json({
      success: true,
      examId: result.examId,
      filename: originalFilename,
      subject: result.subject,
      summary: {
        questionCounts: summary.questionCounts,
        totalQuestions: summary.totalQuestions,
        hasAnswerKey: summary.hasAnswerKey,
      },
      validation: {
        valid: validation.valid,
        errors: validation.errors,
        warnings: validation.warnings,
      },
      result: result.json,
      outputPath: result.outputPath,
      timings: result.timings,
      totalTime: Date.now() - startTime,
    });

  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message, stack: err.stack }, 'Conversion failed');

    return res.status(500).json({
      success: false,
      error: err.message,
      filename: originalFilename,
    });

  } finally {
    // Clean up uploaded file
    try {
      if (fs.existsSync(uploadedPath)) {
        fs.unlinkSync(uploadedPath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
});

// ===========================================
// ERROR HANDLER
// ===========================================

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ error: err.message }, 'Unhandled error');
  res.status(500).json({
    error: err.message || 'Internal server error',
  });
});

// ===========================================
// START SERVER
// ===========================================

const PORT = SERVER.PORT;

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║      DOCX to JSON Exam Converter (Open Source)               ║
╠══════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}                     ║
║                                                              ║
║  Endpoints:                                                  ║
║    GET  /          - API info                                ║
║    GET  /health    - Health check                            ║
║    GET  /detect    - Subject detection preview               ║
║    POST /convert   - Upload and convert DOCX                 ║
╚══════════════════════════════════════════════════════════════╝
`);
});

export default app;
