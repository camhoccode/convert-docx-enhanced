/**
 * Configuration and System Prompts for DOCX to JSON Conversion
 * 
 * Adapted from original config.ts for open-source use with Claude CLI
 */

// ===========================================
// SERVER CONFIGURATION
// ===========================================

export interface ServerConfig {
  PORT: number | string;
  MAX_FILE_SIZE: string;
}

export const SERVER: ServerConfig = {
  PORT: process.env.PORT || 7889,
  MAX_FILE_SIZE: process.env.MAX_FILE_SIZE || "50mb",
};

// ===========================================
// CLAUDE CLI CONFIGURATION
// ===========================================

export interface ClaudeConfig {
  MODEL: string;
  MAX_TOKENS: number;
  TIMEOUT_MS: number;
}

export const CLAUDE: ClaudeConfig = {
  MODEL: process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514",
  MAX_TOKENS: parseInt(process.env.CLAUDE_MAX_TOKENS || "8192", 10),
  TIMEOUT_MS: parseInt(process.env.CLAUDE_TIMEOUT_MS || "420000", 10), // 7 minutes
};

// ===========================================
// DIRECTORIES
// ===========================================

export const DIRECTORIES = {
  UPLOAD_DIR: process.env.UPLOAD_DIR || "./uploads",
  OUTPUT_DIR: process.env.OUTPUT_DIR || "./output",
  TEMP_DIR: process.env.TEMP_DIR || "./temp",
};

// ===========================================
// SYSTEM PROMPT - Core Instructions for Claude
// ===========================================

export const SYSTEM_PROMPT = `
Bạn là chuyên gia convert đề thi Việt Nam sang JSON.

NHIỆM VỤ: Đọc đề thi DOCX và trả về JSON thuần (KHÔNG markdown).

QUY TẮC CHÍNH:
1) Mọi phân số → $\\dfrac{a}{b}$
2) Mũ x² → $x^2$, căn √x → $\\sqrt{x}$
3) Công thức vật lý/toán phải dùng LaTeX
4) Nếu có đáp án cuối đề → điền answer_key
5) Part_2 đúng/sai: dùng Đ/S.

GÁN HÌNH ẢNH (QUAN TRỌNG):
- Ảnh được đánh số theo THỨ TỰ XUẤT HIỆN trong document (img_1, img_2...)
- Mỗi ảnh CHỈ xuất hiện 1 lần; dùng sharedImageRef cho shared images
- MATCH keywords câu hỏi với aspect ratio của ảnh:
  * "ống chữ U/thủy tinh/nghiệm" → ảnh portrait (cao, hẹp)
  * "đồ thị/hàm số/biểu đồ" → ảnh landscape (rộng)
- Câu không nhắc hình → KHÔNG gán image

XÁC ĐỊNH THÔNG TIN THANG ĐIỂM:
- grading_year: Lấy năm từ school_year (vd: "2024-2025" → "2025", "2025-2026" → "2025"). Nếu không rõ, để null.
- subject_key: Map tên môn sang key tiếng Việt không dấu:
  * Toán → "toan"
  * Vật lý/Vật Lý → "vatLy"
  * Hóa học/Hóa Học → "hoaHoc"
  * Sinh học/Sinh Học → "sinhHoc"
  * Lịch sử → "lichSu"
  * Địa lý → "diaLy"
  * GDCD → "gdcd"
  * Tiếng Anh → "tiengAnh"
  * Tin học → "tinHoc"
  * Ngữ văn → "nguVan"
`.trim();

// ===========================================
// SCHEMA - JSON Structure Definition
// ===========================================

export const SCHEMA_COMPACT = `
Schema:
{
  exam_info: {
    source, exam_name, school_year, subject, duration,
    grading_year?: string,  // Năm áp dụng thang điểm, format "2025" hoặc "2025-2026"
    subject_key?: string    // Key tiếng Việt không dấu (toan, vatLy, hoaHoc...)
  },
  part_1: {
    title, description,
    questions: [{
      id:number, question:string,
      options:{A:string, B:string, C:string, D:string},
      answer?:"A"|"B"|"C"|"D",
      image?:string, images?:string[],
      sharedImageRef?:number, sharedContextRef?:number,
      solution?:{text:string, steps?:string[]}
    }]
  },
  part_2: {
    title, description,
    questions: [{
      id:number, context:string,
      statements:{
        a?:{content:string, answer:"Đ"|"S", image?:string},
        b?:{content:string, answer:"Đ"|"S", image?:string},
        c?:{content:string, answer:"Đ"|"S", image?:string},
        d?:{content:string, answer:"Đ"|"S", image?:string}
      },
      solution?:{text:string, steps?:string[]}
    }]
  },
  part_3: {
    title, description,
    questions: [{
      id:number, question:string,
      answer?:string, unit?:string,
      image?:string, images?:string[],
      sharedImageRef?:number, sharedContextRef?:number,
      solution?:{text:string, steps?:string[]},
      note?:string
    }]
  },
  answer_key?: {
    part_1?:Record<string,"A"|"B"|"C"|"D">,
    part_2?:Record<string,Record<string,"Đ"|"S">>,
    part_3?:Record<string,string>
  }
}
`.trim();

// ===========================================
// RULE SNIPPETS
// ===========================================

const RULE_LATEX_MIN = `
LaTeX bắt buộc:
- 1/2, ½ -> $\\dfrac{1}{2}$
- x² -> $x^2$
- √x -> $\\sqrt{x}$
- 10^5 -> $10^5$
`.trim();

const RULE_OUTPUT = `
Output:
- Chỉ JSON thuần, không markdown code block, không text ngoài JSON
- Part thiếu vẫn giữ key part_1/part_2/part_3 với questions=[]
- Nếu có đáp án cuối đề => điền answer_key
`.trim();

// ===========================================
// IMAGE METADATA TYPE
// ===========================================

export interface ImageInfo {
  index: number;
  relativePath: string;
  originalFilename: string;
  width?: number;
  height?: number;
  aspectHint?: string;
}

// ===========================================
// PROMPT BUILDER
// ===========================================

function buildImageRules(images: ImageInfo[]): string {
  if (images.length === 0) return "";
  
  const imageList = images
    .map((img, i) => {
      const hint = img.aspectHint || "unknown";
      return `  - img_${i + 1}: ${img.originalFilename} [${hint}]`;
    })
    .join("\n");

  return `
HÌNH ẢNH TRONG ĐỀ:
${imageList}

Quy tắc gán ảnh:
- Dùng tên file chính xác (vd: "image1.png")
- Mỗi ảnh chỉ dùng 1 lần
- Câu không nhắc hình → KHÔNG gán
`.trim();
}

/**
 * Build the user prompt for Claude
 */
export function buildUserPrompt(
  filename: string,
  text: string,
  images: ImageInfo[] = []
): string {
  const imageRules = buildImageRules(images);
  
  const parts = [
    `FILE: ${filename}`,
    "",
    SCHEMA_COMPACT,
    "",
    RULE_LATEX_MIN,
    "",
    ...(imageRules ? [imageRules, ""] : []),
    RULE_OUTPUT,
    "",
    "NỘI DUNG ĐỀ THI:",
    "---",
    text,
    "---",
    "",
    "Trả về JSON:",
  ];

  return parts.join("\n");
}

// ===========================================
// SUBJECT DETECTION
// ===========================================

export type SubjectType = 'toan' | 'nguVan' | 'vatLy' | 'hoaHoc' | 'sinhHoc' | 'unknown';

const SUBJECT_PATTERNS: Record<SubjectType, RegExp[]> = {
  toan: [/toán/i, /toan/i, /math/i],
  nguVan: [/ngữ văn/i, /ngu van/i, /văn/i, /literature/i],
  vatLy: [/vật lý/i, /vat ly/i, /lý/i, /physics/i],
  hoaHoc: [/hóa học/i, /hoa hoc/i, /hóa/i, /chemistry/i],
  sinhHoc: [/sinh học/i, /sinh hoc/i, /sinh/i, /biology/i],
  unknown: [],
};

/**
 * Detect subject type from filename
 */
export function detectSubject(filename: string): SubjectType {
  const normalized = filename.normalize('NFC');
  
  for (const [subject, patterns] of Object.entries(SUBJECT_PATTERNS)) {
    if (subject === 'unknown') continue;
    for (const pattern of patterns) {
      if (pattern.test(normalized)) {
        return subject as SubjectType;
      }
    }
  }
  
  return 'unknown';
}

export default {
  SERVER,
  CLAUDE,
  DIRECTORIES,
  SYSTEM_PROMPT,
  SCHEMA_COMPACT,
  buildUserPrompt,
  detectSubject,
};
