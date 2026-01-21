/**
 * Claude CLI Wrapper
 * 
 * Calls Claude CLI (claude command) via child_process instead of local API.
 * Based on: https://code.claude.com/docs/en/cli-reference
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CLAUDE, SYSTEM_PROMPT } from '../config.js';
import logger from './logger.js';

// ===========================================
// CLI PATH DETECTION
// ===========================================

function getClaudeCliPath(): string {
  if (process.env.CLAUDE_CLI_PATH) {
    return process.env.CLAUDE_CLI_PATH;
  }

  const homeDir = os.homedir();
  const possiblePaths = [
    // Linux/Server paths
    `${homeDir}/.nvm/versions/node/v20.19.6/bin/claude`,
    `${homeDir}/.nvm/versions/node/v20.18.0/bin/claude`,
    // Mac paths
    `${homeDir}/.nvm/versions/node/v21.7.3/bin/claude`,
    // Global npm
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Fallback to 'claude' in PATH
  return 'claude';
}

const CLAUDE_CLI = getClaudeCliPath();

// ===========================================
// TYPES
// ===========================================

export interface CliOptions {
  model?: string;
  maxTurns?: number;
  outputFormat?: 'text' | 'json' | 'stream-json';
  verbose?: boolean;
  timeout?: number;
  systemPrompt?: string;
}

const DEFAULT_OPTIONS: CliOptions = {
  model: CLAUDE.MODEL,
  maxTurns: 1,
  outputFormat: 'text',
  verbose: false,
  timeout: CLAUDE.TIMEOUT_MS,
};

export interface ExamJson {
  exam_info?: Record<string, unknown>;
  part_1?: { questions?: unknown[] };
  part_2?: { questions?: unknown[] };
  part_3?: { questions?: unknown[] };
  answer_key?: unknown;
  // Metadata fields added during conversion
  _exam_id?: string;
  _original_filename?: string;
  _subject?: string;
  _pipeline_version?: string;
  [key: string]: unknown;
}

export interface CliUsageInfo {
  cliVersion?: string;
  cliPath: string;
  authenticated?: boolean;
  model: string;
  lastCheck: string;
  status: string;
  error?: string;
}

// ===========================================
// MAIN FUNCTIONS
// ===========================================

/**
 * Call Claude CLI with a prompt
 */
export function callClaudeCli(prompt: string, options: CliOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    // Create temp directory
    const tempDir = path.join(os.tmpdir(), `claude-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // Write prompt to temp file
    const promptFile = path.join(tempDir, 'prompt.txt');
    fs.writeFileSync(promptFile, prompt, 'utf8');

    // Write system prompt if provided
    let systemPromptFile: string | null = null;
    if (opts.systemPrompt) {
      systemPromptFile = path.join(tempDir, 'system-prompt.txt');
      fs.writeFileSync(systemPromptFile, opts.systemPrompt, 'utf8');
    }

    // Build shell command
    let shellCommand: string;
    if (systemPromptFile) {
      shellCommand = `cat "${promptFile}" | "${CLAUDE_CLI}" --print --output-format ${opts.outputFormat} --model "${opts.model}" --max-turns ${opts.maxTurns} --system-prompt "$(cat "${systemPromptFile}")" --tools ""`;
    } else {
      shellCommand = `cat "${promptFile}" | "${CLAUDE_CLI}" --print --output-format ${opts.outputFormat} --model "${opts.model}" --max-turns ${opts.maxTurns} --tools ""`;
    }

    logger.info({
      model: opts.model,
      maxTurns: opts.maxTurns,
      outputFormat: opts.outputFormat,
      promptLength: prompt.length,
    }, 'Executing Claude CLI');

    const child: ChildProcess = spawn('bash', ['-c', shellCommand], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd: process.cwd(),
    });

    let stdout = '';
    let stderr = '';
    let isTimedOut = false;
    let isKilled = false;

    // Set timeout
    const timeoutMs = opts.timeout || CLAUDE.TIMEOUT_MS;
    const timeoutHandle = setTimeout(() => {
      isTimedOut = true;
      logger.error({ timeoutMs }, 'Claude CLI timeout - killing process');
      child.kill('SIGTERM');

      setTimeout(() => {
        if (!isKilled) {
          child.kill('SIGKILL');
        }
      }, 5000);
    }, timeoutMs);

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
      process.stdout.write('.');
    });

    child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      stderr += msg;
      if (!msg.includes('DeprecationWarning') && !msg.includes('punycode')) {
        if (opts.verbose) {
          process.stderr.write(msg);
        }
      }
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      isKilled = true;
      clearTimeout(timeoutHandle);
      cleanupTempDir(tempDir);
      console.log(''); // New line after dots

      if (isTimedOut) {
        const error = new Error(`Claude CLI timeout after ${timeoutMs / 1000} seconds`) as NodeJS.ErrnoException;
        error.code = 'TIMEOUT';
        reject(error);
        return;
      }

      if (signal) {
        const error = new Error(`Claude CLI was killed with signal ${signal}`) as NodeJS.ErrnoException;
        error.code = 'KILLED';
        reject(error);
        return;
      }

      if (code === 0) {
        logger.info({ responseLength: stdout.length }, 'Claude CLI completed');
        resolve(stdout.trim());
      } else {
        const cleanStderr = stderr
          .split('\n')
          .filter(line => !line.includes('DeprecationWarning') && !line.includes('punycode'))
          .join('\n')
          .trim();

        logger.error({ code, stderr: cleanStderr }, 'Claude CLI error');
        reject(new Error(`Claude CLI exited with code ${code}: ${cleanStderr}`));
      }
    });

    child.on('error', (err: Error) => {
      clearTimeout(timeoutHandle);
      cleanupTempDir(tempDir);
      logger.error({ error: err.message }, 'Failed to spawn Claude CLI');
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });
  });
}

/**
 * Clean up temporary directory
 */
function cleanupTempDir(dir: string): void {
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      fs.unlinkSync(path.join(dir, file));
    }
    fs.rmdirSync(dir);
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Parse JSON from Claude response
 * Enhanced to handle LaTeX escape sequences
 */
export function parseJsonResponse(response: string): ExamJson {
  let jsonStr = response.trim();

  // Remove markdown code blocks
  if (jsonStr.startsWith('```json')) {
    jsonStr = jsonStr.slice(7);
  } else if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.slice(3);
  }

  if (jsonStr.endsWith('```')) {
    jsonStr = jsonStr.slice(0, -3);
  }

  jsonStr = jsonStr.trim();

  // Remove trailing commas (common LLM error)
  jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');

  // Fix LaTeX backslash escapes
  const dblBackslashPlaceholder = '<<<DBL_BACKSLASH>>>';
  jsonStr = jsonStr.replace(/\\\\/g, dblBackslashPlaceholder);
  jsonStr = jsonStr.replace(/\\/g, '\\\\');
  jsonStr = jsonStr.replace(new RegExp(dblBackslashPlaceholder, 'g'), '\\\\');

  try {
    return JSON.parse(jsonStr) as ExamJson;
  } catch (firstError) {
    logger.warn('First JSON parse attempt failed, trying extraction...');

    // Extract JSON object between first { and last }
    const startIdx = response.indexOf('{');
    const endIdx = response.lastIndexOf('}');

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      try {
        let extracted = response.substring(startIdx, endIdx + 1);
        extracted = extracted.replace(/,(\s*[}\]])/g, '$1');

        const dblPlaceholder = '<<<DBL_BS>>>';
        extracted = extracted.replace(/\\\\/g, dblPlaceholder);
        extracted = extracted.replace(/\\/g, '\\\\');
        extracted = extracted.replace(new RegExp(dblPlaceholder, 'g'), '\\\\');

        return JSON.parse(extracted) as ExamJson;
      } catch (secondError) {
        const err = firstError as Error;
        logger.error({ error: err.message, preview: response.substring(0, 500) }, 'Failed to parse JSON');
        throw new Error(`Failed to parse JSON: ${err.message}`);
      }
    }

    const err = firstError as Error;
    throw new Error(`Failed to parse JSON: ${err.message}`);
  }
}

/**
 * Check if Claude CLI is available
 */
export async function checkCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_CLI, ['--version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.on('close', (code) => {
      resolve(code === 0);
    });

    child.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Get Claude CLI version
 */
export async function getCliVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_CLI, ['--version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error('Failed to get CLI version'));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Get Claude CLI usage info
 */
export async function getClaudeUsage(): Promise<CliUsageInfo> {
  try {
    const authPath = path.join(os.homedir(), '.claude', 'credentials.json');
    const hasCredentials = fs.existsSync(authPath);

    return {
      cliVersion: await getCliVersion().catch(() => 'unknown'),
      cliPath: CLAUDE_CLI,
      authenticated: hasCredentials,
      model: CLAUDE.MODEL,
      lastCheck: new Date().toISOString(),
      status: 'ready',
    };
  } catch (error) {
    const err = error as Error;
    return {
      error: err.message,
      status: 'error',
      lastCheck: new Date().toISOString(),
      cliPath: CLAUDE_CLI,
      model: CLAUDE.MODEL,
    };
  }
}

/**
 * Convert text to JSON using Claude CLI
 */
export async function convertToJson(
  text: string,
  filename: string,
  options: CliOptions = {}
): Promise<ExamJson> {
  const { buildUserPrompt } = await import('../config.js');
  const userPrompt = buildUserPrompt(filename, text, []);

  logger.info({ filename, model: options.model || CLAUDE.MODEL }, 'Converting with Claude CLI');

  const result = await callClaudeCli(userPrompt, {
    ...options,
    systemPrompt: SYSTEM_PROMPT,
    maxTurns: 1,
  });

  return parseJsonResponse(result);
}

export { CLAUDE_CLI, DEFAULT_OPTIONS };

export default {
  callClaudeCli,
  parseJsonResponse,
  checkCliAvailable,
  getCliVersion,
  getClaudeUsage,
  convertToJson,
  CLAUDE_CLI,
  DEFAULT_OPTIONS,
};
