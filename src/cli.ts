/**
 * CLI Entry Point
 * 
 * Command-line interface for converting DOCX files
 */

import fs from 'fs';
import path from 'path';
import { convertDocx, validateExamJson, createSummary } from './services/converter.js';
import { checkCliAvailable, getClaudeUsage } from './utils/claude-cli.js';
import { DIRECTORIES } from './config.js';
import logger from './utils/logger.js';

async function main() {
  const args = process.argv.slice(2);

  // Show help
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║        DOCX to JSON Exam Converter (Open Source)             ║
╠══════════════════════════════════════════════════════════════╣
║  Uses Claude CLI for AI-powered conversion                   ║
╚══════════════════════════════════════════════════════════════╝

Usage:
  npm run convert -- <input.docx> [options]
  npm run convert -- --status

Options:
  --output, -o <dir>    Output directory (default: ./output)
  --no-images           Skip image extraction
  --status              Check Claude CLI status
  --help, -h            Show this help message

Examples:
  npm run convert -- exam.docx
  npm run convert -- exam.docx -o ./results
  npm run convert -- --status
`);
    process.exit(0);
  }

  // Check status
  if (args.includes('--status')) {
    console.log('\n📊 Checking Claude CLI status...\n');
    
    const available = await checkCliAvailable();
    if (!available) {
      console.log('❌ Claude CLI is NOT available');
      console.log('   Install with: npm install -g @anthropic-ai/claude-code');
      console.log('   Then login with: claude login');
      process.exit(1);
    }

    const usage = await getClaudeUsage();
    console.log('✅ Claude CLI is available');
    console.log(`   Version: ${usage.cliVersion}`);
    console.log(`   Path: ${usage.cliPath}`);
    console.log(`   Authenticated: ${usage.authenticated ? 'Yes' : 'No'}`);
    console.log(`   Model: ${usage.model}`);
    console.log(`   Status: ${usage.status}`);
    process.exit(0);
  }

  // Get input file
  const inputFile = args.find(arg => !arg.startsWith('-'));
  if (!inputFile) {
    console.error('❌ Error: No input file specified');
    console.log('   Use --help for usage information');
    process.exit(1);
  }

  // Resolve input path
  const inputPath = path.resolve(inputFile);
  if (!fs.existsSync(inputPath)) {
    console.error(`❌ Error: File not found: ${inputPath}`);
    process.exit(1);
  }

  // Get output directory
  let outputDir = DIRECTORIES.OUTPUT_DIR;
  const outputIdx = args.findIndex(arg => arg === '--output' || arg === '-o');
  if (outputIdx !== -1 && args[outputIdx + 1]) {
    outputDir = args[outputIdx + 1];
  }

  // Check image extraction option
  const extractImages = !args.includes('--no-images');

  // Check Claude CLI availability
  console.log('\n🔍 Checking Claude CLI...');
  const cliAvailable = await checkCliAvailable();
  if (!cliAvailable) {
    console.error('❌ Claude CLI is not available');
    console.log('   Install: npm install -g @anthropic-ai/claude-code');
    console.log('   Login: claude login');
    process.exit(1);
  }
  console.log('✅ Claude CLI ready\n');

  // Start conversion
  console.log('═══════════════════════════════════════════════════');
  console.log(`📄 Converting: ${path.basename(inputPath)}`);
  console.log(`📁 Output: ${path.resolve(outputDir)}`);
  console.log('═══════════════════════════════════════════════════\n');

  try {
    const result = await convertDocx(inputPath, {
      outputDir,
      extractImages,
    });

    // Show results
    console.log('\n═══════════════════════════════════════════════════');
    console.log('✅ CONVERSION COMPLETE');
    console.log('═══════════════════════════════════════════════════');
    console.log(`📝 Exam ID: ${result.examId}`);
    console.log(`📚 Subject: ${result.subject}`);
    
    const summary = createSummary(result.json);
    console.log(`\n📊 Questions:`);
    console.log(`   Part 1 (MCQ): ${summary.questionCounts.part_1}`);
    console.log(`   Part 2 (T/F): ${summary.questionCounts.part_2}`);
    console.log(`   Part 3 (Essay): ${summary.questionCounts.part_3}`);
    console.log(`   Total: ${summary.totalQuestions}`);
    console.log(`   Answer Key: ${summary.hasAnswerKey ? 'Yes' : 'No'}`);

    if (result.imagePaths && result.imagePaths.length > 0) {
      console.log(`\n🖼️  Images: ${result.imagePaths.length} extracted`);
    }

    console.log(`\n⏱️  Timings:`);
    console.log(`   Parse: ${result.timings.parse}ms`);
    console.log(`   Images: ${result.timings.imageExtract}ms`);
    console.log(`   LLM: ${result.timings.llm}ms`);
    console.log(`   Total: ${result.timings.total}ms`);

    if (result.outputPath) {
      console.log(`\n📁 Output saved to: ${result.outputPath}`);
    }

    // Validate
    const validation = validateExamJson(result.json);
    if (!validation.valid) {
      console.log('\n⚠️  Validation issues:');
      validation.errors.forEach(e => console.log(`   ❌ ${e}`));
    }
    if (validation.warnings.length > 0) {
      console.log('\n⚠️  Warnings:');
      validation.warnings.forEach(w => console.log(`   ⚠️  ${w}`));
    }

    console.log('\n═══════════════════════════════════════════════════\n');

  } catch (error) {
    const err = error as Error;
    console.error('\n❌ Conversion failed:', err.message);
    logger.error({ error: err.message, stack: err.stack }, 'Conversion failed');
    process.exit(1);
  }
}

main().catch(console.error);
