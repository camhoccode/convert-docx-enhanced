/**
 * DOCX Parser - Extract content from DOCX files
 * 
 * Parses DOCX XML structure to extract text and metadata
 */

import AdmZip from 'adm-zip';
import logger from './logger.js';

// ===========================================
// TYPES
// ===========================================

export interface ParsedDocx {
  text: string;
  paragraphs: string[];
  relationships: RelationshipMap;
  images: ImageReference[];
}

export interface RelationshipMap {
  [id: string]: {
    type: string;
    target: string;
  };
}

export interface ImageReference {
  id: string;
  filename: string;
  position: number; // Paragraph index where image appears
}

// ===========================================
// PARSING FUNCTIONS
// ===========================================

/**
 * Parse relationships from DOCX
 */
export function parseRelationships(zip: AdmZip): RelationshipMap {
  const relsEntry = zip.getEntry('word/_rels/document.xml.rels');
  if (!relsEntry) {
    return {};
  }

  const relsXml = relsEntry.getData().toString('utf8');
  const relationships: RelationshipMap = {};

  // Simple regex parsing for relationships
  const relPattern = /<Relationship\s+Id="([^"]+)"\s+Type="([^"]+)"\s+Target="([^"]+)"/g;
  let match;

  while ((match = relPattern.exec(relsXml)) !== null) {
    relationships[match[1]] = {
      type: match[2],
      target: match[3],
    };
  }

  return relationships;
}

/**
 * Extract text content from document.xml
 */
export function extractTextFromXml(documentXml: string): { text: string; paragraphs: string[] } {
  const paragraphs: string[] = [];
  
  // Match paragraph elements
  const paraPattern = /<w:p[^>]*>([\s\S]*?)<\/w:p>/g;
  let paraMatch;

  while ((paraMatch = paraPattern.exec(documentXml)) !== null) {
    const paraContent = paraMatch[1];
    
    // Extract text from w:t elements
    const textPattern = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let textMatch;
    let paragraphText = '';

    while ((textMatch = textPattern.exec(paraContent)) !== null) {
      paragraphText += textMatch[1];
    }

    if (paragraphText.trim()) {
      paragraphs.push(paragraphText.trim());
    }
  }

  return {
    text: paragraphs.join('\n'),
    paragraphs,
  };
}

/**
 * Find image references in document.xml
 */
export function findImageReferences(documentXml: string, relationships: RelationshipMap): ImageReference[] {
  const images: ImageReference[] = [];
  
  // Match drawing elements with relationship IDs
  const drawingPattern = /<a:blip[^>]*r:embed="([^"]+)"/g;
  let match;
  let position = 0;

  while ((match = drawingPattern.exec(documentXml)) !== null) {
    const relId = match[1];
    const rel = relationships[relId];

    if (rel && rel.type.includes('image')) {
      images.push({
        id: relId,
        filename: rel.target.replace('media/', ''),
        position: position++,
      });
    }
  }

  return images;
}

/**
 * Parse a DOCX file and extract content
 */
export async function parseDocx(filePath: string): Promise<ParsedDocx> {
  logger.info({ filePath }, 'Parsing DOCX file');

  const zip = new AdmZip(filePath);
  
  // Get document.xml
  const docEntry = zip.getEntry('word/document.xml');
  if (!docEntry) {
    throw new Error('No document.xml found in DOCX file');
  }

  const documentXml = docEntry.getData().toString('utf8');
  
  // Parse relationships
  const relationships = parseRelationships(zip);
  
  // Extract text
  const { text, paragraphs } = extractTextFromXml(documentXml);
  
  // Find images
  const images = findImageReferences(documentXml, relationships);

  logger.info({
    paragraphCount: paragraphs.length,
    imageCount: images.length,
    textLength: text.length,
  }, 'DOCX parsed successfully');

  return {
    text,
    paragraphs,
    relationships,
    images,
  };
}

/**
 * Extract images from DOCX to a directory
 */
export async function extractImages(filePath: string, outputDir: string): Promise<string[]> {
  const fs = await import('fs');
  const path = await import('path');

  const zip = new AdmZip(filePath);
  const extractedPaths: string[] = [];

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Find all media files
  const entries = zip.getEntries();
  for (const entry of entries) {
    if (entry.entryName.startsWith('word/media/')) {
      const filename = path.basename(entry.entryName);
      const outputPath = path.join(outputDir, filename);
      
      fs.writeFileSync(outputPath, entry.getData());
      extractedPaths.push(outputPath);
    }
  }

  logger.info({ count: extractedPaths.length, outputDir }, 'Images extracted');
  
  return extractedPaths;
}

export default {
  parseDocx,
  parseRelationships,
  extractTextFromXml,
  findImageReferences,
  extractImages,
};
