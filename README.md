# 📄 DOCX to JSON Exam Converter

[![TypeScript](https://img.shields.io/badge/TypeScript-5.2-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Open-source** tool for converting Vietnamese high school exam documents (DOCX) to structured JSON format using Claude AI.

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🤖 **Claude CLI Integration** | Uses official Claude CLI instead of proprietary APIs |
| 📚 **Auto Subject Detection** | Detects Math, Vietnamese Literature, Physics, Chemistry, Biology |
| 📐 **LaTeX Conversion** | Automatically converts math formulas to LaTeX |
| 🖼️ **Image Extraction** | Extracts and references images from DOCX |
| 🔢 **Math OCR** | Optional pix2tex + EasyOCR for formula recognition |
| 🌐 **REST API** | Simple HTTP API for integration |
| 💻 **CLI Tool** | Command-line interface for batch processing |

---

## 📋 Prerequisites

| Requirement | Required | Description |
|-------------|----------|-------------|
| Node.js 18+ | ✅ Yes | JavaScript runtime |
| Claude CLI | ✅ Yes | Anthropic's official CLI |
| Python 3.10+ | ⚪ Optional | For OCR features |
| LibreOffice | ⚪ Optional | For WMF formula conversion |

### Install Claude CLI

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

---

## 🚀 Quick Start

```bash
# Clone and install
git clone <repo-url>
cd convert-docx-enhanced
npm install

# Check Claude CLI status
npm run convert -- --status

# Convert a DOCX file
npm run convert -- path/to/exam.docx
```

---

## 📖 Usage

### Command Line Interface

```bash
# Basic usage
npm run convert -- exam.docx

# Custom output directory
npm run convert -- exam.docx -o ./results

# Skip image extraction
npm run convert -- exam.docx --no-images

# Show help
npm run convert -- --help
```

### REST API

```bash
# Start server (port 7889)
npm run dev
```

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | API information |
| `GET` | `/health` | Health check with Claude CLI status |
| `GET` | `/detect?filename=exam.docx` | Preview subject detection |
| `POST` | `/convert` | Upload and convert DOCX file |

**Example: cURL**

```bash
curl -X POST http://localhost:7889/convert \
  -F "file=@exam.docx"
```

---

## 🐍 Python OCR Setup (Optional)

For advanced math formula OCR using pix2tex and EasyOCR:

```bash
# Create virtual environment
python3 -m venv venv
source venv/bin/activate  # macOS/Linux
# Windows: venv\Scripts\activate

# Install dependencies
pip install -r scripts/requirements.txt

# For NVIDIA GPU support
pip install torch --index-url https://download.pytorch.org/whl/cu124

# Start OCR service
python scripts/math-ocr-service.py --port 8766
```

**OCR Service Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Check models loaded |
| `POST` | `/ocr/batch` | Process directory of images |
| `POST` | `/ocr/single` | Process single image |

---

## 📦 Output JSON Schema

```json
{
  "exam_info": {
    "source": "Sở GD&ĐT Hà Nội",
    "exam_name": "Đề thi thử THPT Quốc gia",
    "school_year": "2024-2025",
    "subject": "Toán",
    "subject_key": "toan",
    "duration": "90 phút"
  },
  "part_1": {
    "title": "Phần I: Trắc nghiệm",
    "questions": [
      {
        "id": 1,
        "question": "Giá trị của $\\log_2 8$ bằng",
        "options": { "A": "$2$", "B": "$3$", "C": "$4$", "D": "$8$" },
        "answer": "B"
      }
    ]
  },
  "part_2": {
    "title": "Phần II: Đúng/Sai",
    "questions": [
      {
        "id": 1,
        "context": "Cho hàm số $y = x^3 - 3x$",
        "statements": {
          "a": { "content": "Hàm số đồng biến trên $\\mathbb{R}$", "answer": "S" },
          "b": { "content": "Hàm số có cực trị", "answer": "Đ" }
        }
      }
    ]
  },
  "part_3": {
    "title": "Phần III: Tự luận",
    "questions": [
      {
        "id": 1,
        "question": "Giải phương trình $x^2 - 5x + 6 = 0$",
        "answer": "$x = 2$ hoặc $x = 3$"
      }
    ]
  },
  "answer_key": {
    "part_1": { "1": "B", "2": "A" },
    "part_2": { "1": { "a": "S", "b": "Đ" } },
    "part_3": { "1": "x = 2 hoặc x = 3" }
  }
}
```

---

## ⚙️ Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `7889` | REST API server port |
| `CLAUDE_MODEL` | `claude-sonnet-4-20250514` | Claude model to use |
| `CLAUDE_TIMEOUT_MS` | `420000` | Timeout in ms (7 min) |
| `CLAUDE_CLI_PATH` | auto-detect | Path to Claude CLI binary |
| `UPLOAD_DIR` | `./uploads` | Upload directory |
| `OUTPUT_DIR` | `./output` | Output directory |
| `OCR_SERVICE_URL` | `http://127.0.0.1:8766` | Python OCR service URL |
| `PYTHON_BIN` | auto-detect | Python binary path |
| `LIBREOFFICE_PATH` | auto-detect | LibreOffice binary path |

---

## 📁 Project Structure

```
convert-docx-enhanced/
├── src/
│   ├── app.ts               # Express REST API server
│   ├── cli.ts               # Command-line interface
│   ├── config.ts            # System prompts & configuration
│   ├── services/
│   │   └── converter.ts     # Main conversion logic
│   └── utils/
│       ├── claude-cli.ts    # Claude CLI wrapper
│       ├── docx-parser.ts   # DOCX XML parsing
│       ├── hybrid-ocr.ts    # OCR integration
│       ├── wmf-converter.ts # WMF to PNG conversion
│       └── logger.ts        # Pino logger
├── scripts/
│   ├── math-ocr-service.py  # FastAPI OCR service
│   ├── math-ocr-v2.py       # Hybrid OCR CLI
│   └── requirements.txt     # Python dependencies
├── package.json
├── tsconfig.json
└── README.md
```

---

## 🔧 Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Run production build
npm start
```

---

## 📄 License

MIT © 2024
