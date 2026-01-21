#!/usr/bin/env python3
"""
Math OCR Service - Persistent API Server

Runs as a persistent service that:
1. Loads OCR models ONCE at startup
2. Handles requests sequentially (queue-based)
3. Maintains stable GPU memory usage (~3GB)

Usage:
    # Start service
    python math-ocr-service.py --port 8766
    
    # Check health
    curl http://localhost:8766/health
    
    # Process batch
    curl -X POST http://localhost:8766/ocr/batch -H "Content-Type: application/json" -d '{"directory": "/path/to/pngs"}'

Dependencies:
    pip install fastapi uvicorn pix2tex pillow easyocr torch --index-url https://download.pytorch.org/whl/cu124
"""

import sys
import os
import json
import asyncio
import warnings
import gc
from pathlib import Path
from typing import Optional, Dict, Any, List
from contextlib import asynccontextmanager
import threading
import queue

warnings.filterwarnings("ignore")

# =========================================
# GPU DETECTION
# =========================================

GPU_AVAILABLE = False
GPU_NAME = "N/A"
DEVICE = "cpu"
TORCH_AVAILABLE = False

try:
    import torch
    TORCH_AVAILABLE = True
    if torch.cuda.is_available():
        GPU_AVAILABLE = True
        GPU_NAME = torch.cuda.get_device_name(0)
        DEVICE = "cuda"
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        GPU_AVAILABLE = True
        GPU_NAME = "Apple Metal (MPS)"
        DEVICE = "mps"
except ImportError:
    pass

# =========================================
# DEPENDENCIES CHECK
# =========================================

PIL_AVAILABLE = False
PIX2TEX_AVAILABLE = False
EASYOCR_AVAILABLE = False

try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    print("Warning: Pillow not installed", file=sys.stderr)

try:
    from pix2tex.cli import LatexOCR
    PIX2TEX_AVAILABLE = True
except ImportError:
    print("Warning: pix2tex not installed", file=sys.stderr)

try:
    import easyocr
    EASYOCR_AVAILABLE = True
except ImportError:
    print("Warning: easyocr not installed", file=sys.stderr)


def get_gpu_memory_info() -> Dict[str, int]:
    """Get current GPU memory usage in MB"""
    if TORCH_AVAILABLE:
        import torch
        if torch.cuda.is_available():
            return {
                "allocated_mb": torch.cuda.memory_allocated(0) // (1024 * 1024),
                "reserved_mb": torch.cuda.memory_reserved(0) // (1024 * 1024),
                "total_mb": torch.cuda.get_device_properties(0).total_memory // (1024 * 1024),
            }
    return {"allocated_mb": 0, "reserved_mb": 0, "total_mb": 0}


# =========================================
# IMAGE PROCESSING
# =========================================

def crop_to_content(image_path: str, padding: int = 20, threshold: int = 250):
    """Crop image to content bounding box"""
    img = Image.open(image_path).convert("L")
    pixels = img.load()
    w, h = img.size

    min_x, min_y, max_x, max_y = w, h, 0, 0
    for y in range(h):
        for x in range(w):
            if pixels[x, y] < threshold:
                min_x = min(min_x, x)
                min_y = min(min_y, y)
                max_x = max(max_x, x)
                max_y = max(max_y, y)

    if max_x <= min_x or max_y <= min_y:
        return None, (0, 0, 0, 0)

    raw_w = max_x - min_x
    raw_h = max_y - min_y

    crop_min_x = max(0, min_x - padding)
    crop_min_y = max(0, min_y - padding)
    crop_max_x = min(w, max_x + padding)
    crop_max_y = min(h, max_y + padding)

    cropped = img.crop((crop_min_x, crop_min_y, crop_max_x, crop_max_y))
    return cropped, (raw_w, raw_h, crop_max_x - crop_min_x, crop_max_y - crop_min_y)


def is_simple_content(content_width: int, content_height: int, area_threshold: int = 5000, max_dimension: int = 80) -> bool:
    """Detect if content is likely simple (number/short text) vs complex (formula)"""
    area = content_width * content_height
    if content_height == 0:
        return True
    aspect_ratio = content_width / content_height
    
    if aspect_ratio > 2.5:
        return False
    if aspect_ratio < 0.35:
        return False
    if area < area_threshold and 0.35 <= aspect_ratio <= 2.0:
        return True
    if content_width < max_dimension and content_height < max_dimension:
        if 0.35 <= aspect_ratio <= 2.0:
            return True
    return False


# =========================================
# OCR SERVICE
# =========================================

class OCRService:
    """Singleton OCR service with persistent models"""
    
    _instance = None
    _lock = threading.Lock()
    
    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        
        self.pix2tex_model = None
        self.easyocr_reader = None
        self._processing_lock = threading.Lock()  # Ensure sequential processing
        self._initialized = True
        
    def load_models(self):
        """Load all OCR models into GPU memory"""
        print(f"Loading OCR models (GPU: {GPU_NAME})...", file=sys.stderr)
        
        if PIX2TEX_AVAILABLE and self.pix2tex_model is None:
            print("Loading pix2tex...", file=sys.stderr)
            self.pix2tex_model = LatexOCR()
            print("pix2tex loaded", file=sys.stderr)
            
        if EASYOCR_AVAILABLE and self.easyocr_reader is None:
            print("Loading EasyOCR...", file=sys.stderr)
            self.easyocr_reader = easyocr.Reader(["en"], gpu=GPU_AVAILABLE, verbose=False)
            print("EasyOCR loaded", file=sys.stderr)
        
        mem = get_gpu_memory_info()
        print(f"Models loaded. GPU memory: {mem['allocated_mb']}MB / {mem['total_mb']}MB", file=sys.stderr)
    
    def ocr_simple(self, cropped_img) -> str:
        """OCR for simple content using EasyOCR"""
        if self.easyocr_reader is None:
            raise RuntimeError("EasyOCR not loaded")
        
        if cropped_img.mode != "RGB":
            cropped_img = cropped_img.convert("RGB")
        
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            cropped_img.save(f.name)
            temp_path = f.name
        
        try:
            result = self.easyocr_reader.readtext(temp_path)
            if result:
                texts = [(r[1], r[2]) for r in result]
                texts.sort(key=lambda x: x[1], reverse=True)
                return texts[0][0]
            return ""
        finally:
            os.unlink(temp_path)
    
    def ocr_complex(self, cropped_img) -> str:
        """OCR for complex content using pix2tex"""
        if self.pix2tex_model is None:
            raise RuntimeError("pix2tex not loaded")
        
        if cropped_img.mode != "RGB":
            cropped_img = cropped_img.convert("RGB")
        
        return self.pix2tex_model(cropped_img)
    
    def ocr_image(self, image_path: str) -> Dict[str, Any]:
        """OCR a single image"""
        try:
            cropped, (content_w, content_h, _, _) = crop_to_content(image_path)
            
            if cropped is None:
                return {
                    "success": False,
                    "latex": "",
                    "file": image_path,
                    "error": "No content found",
                    "method": "none",
                }
            
            is_simple = is_simple_content(content_w, content_h)
            
            if is_simple:
                text = self.ocr_simple(cropped)
                method = "easyocr"
                text = text.strip()
                
                if not text:
                    text = self.ocr_complex(cropped)
                    method = "easyocr+pix2tex"
                
                latex = text
            else:
                latex = self.ocr_complex(cropped)
                method = "pix2tex"
            
            return {
                "success": True,
                "latex": latex,
                "file": image_path,
                "error": None,
                "method": method,
                "is_simple": is_simple,
            }
        except Exception as e:
            return {
                "success": False,
                "latex": "",
                "file": image_path,
                "error": str(e),
                "method": "error",
            }
    
    def ocr_directory(self, directory: str, pattern: str = "*.png") -> Dict[str, Any]:
        """OCR all images in a directory - SEQUENTIAL PROCESSING"""
        with self._processing_lock:  # Ensure only one batch at a time
            dir_path = Path(directory)
            if not dir_path.exists():
                raise FileNotFoundError(f"Directory not found: {directory}")
            
            image_files = sorted(dir_path.glob(pattern))
            
            if not image_files:
                return {
                    "results": {},
                    "count": 0,
                    "success_count": 0,
                    "simple_count": 0,
                    "complex_count": 0,
                    "errors": [],
                }
            
            results = {}
            errors = []
            simple_count = 0
            complex_count = 0
            
            for i, img_path in enumerate(image_files, 1):
                print(f"Processing {i}/{len(image_files)}: {img_path.name}", file=sys.stderr)
                result = self.ocr_image(str(img_path))
                
                if result["success"]:
                    results[img_path.name] = result["latex"]
                    if result.get("is_simple"):
                        simple_count += 1
                    else:
                        complex_count += 1
                else:
                    errors.append({"file": img_path.name, "error": result["error"]})
                    results[img_path.name] = f"[ERROR: {result['error']}]"
            
            # Run garbage collection but DON'T clear CUDA cache (models stay loaded)
            gc.collect()
            
            return {
                "results": results,
                "count": len(results),
                "success_count": len(results) - len(errors),
                "simple_count": simple_count,
                "complex_count": complex_count,
                "errors": errors,
            }


# =========================================
# FASTAPI APP
# =========================================

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

ocr_service = OCRService()

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load models on startup"""
    ocr_service.load_models()
    yield
    # Cleanup on shutdown (optional)
    print("Shutting down OCR service...", file=sys.stderr)

app = FastAPI(title="Math OCR Service", lifespan=lifespan)


class BatchRequest(BaseModel):
    directory: str
    pattern: str = "*.png"


class SingleRequest(BaseModel):
    image_path: str


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    mem = get_gpu_memory_info()
    return {
        "status": "ok",
        "gpu_available": GPU_AVAILABLE,
        "gpu_name": GPU_NAME,
        "device": DEVICE,
        "models_loaded": {
            "pix2tex": ocr_service.pix2tex_model is not None,
            "easyocr": ocr_service.easyocr_reader is not None,
        },
        "gpu_memory": mem,
    }


@app.post("/ocr/batch")
async def ocr_batch(request: BatchRequest):
    """Process all images in a directory"""
    try:
        # Run in thread pool to not block event loop
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, 
            lambda: ocr_service.ocr_directory(request.directory, request.pattern)
        )
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/ocr/single")
async def ocr_single(request: SingleRequest):
    """Process a single image"""
    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: ocr_service.ocr_image(request.image_path)
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/memory")
async def get_memory():
    """Get current GPU memory usage"""
    return get_gpu_memory_info()


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Math OCR Service")
    parser.add_argument("--port", type=int, default=8766, help="Port to run service on")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind to")
    args = parser.parse_args()
    
    print(f"Starting Math OCR Service on {args.host}:{args.port}", file=sys.stderr)
    print(f"GPU: {GPU_NAME} ({DEVICE})", file=sys.stderr)
    
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
