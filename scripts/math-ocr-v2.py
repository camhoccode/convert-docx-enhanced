#!/usr/bin/env python3
"""
Math OCR V2 - Hybrid Approach (GPU Optimized + Memory Management)

Uses:
1. EasyOCR for simple content (numbers, short text) - GPU accelerated
2. pix2tex for complex math formulas - GPU accelerated

Key improvements over V1:
- Auto-crop images to content bounding box
- Detect simple vs complex content
- Use appropriate OCR for each type
- GPU acceleration for both EasyOCR and pix2tex
- AUTOMATIC CUDA MEMORY CLEANUP after batch processing

Dependencies:
    pip install pix2tex pillow easyocr torch --index-url https://download.pytorch.org/whl/cu124

Usage:
    python math-ocr-v2.py --batch-dir <png_dir>
    python math-ocr-v2.py --check
    python math-ocr-v2.py --check --verbose  # Show GPU info
"""

import sys
import os
import json
import argparse
import warnings
import gc
from pathlib import Path
from contextlib import contextmanager
from typing import Optional, Tuple, Dict, Any

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
        # Set default device
        torch.set_default_device("cuda")
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        GPU_AVAILABLE = True
        GPU_NAME = "Apple Metal (MPS)"
        DEVICE = "mps"
except ImportError:
    pass


def clear_gpu_memory():
    """Clear CUDA GPU memory cache"""
    if TORCH_AVAILABLE:
        import torch
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
            print(f"GPU memory cleared", file=sys.stderr)


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


@contextmanager
def redirect_stdout_to_stderr():
    """Redirect stdout to stderr"""
    old_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        yield
    finally:
        sys.stdout = old_stdout


# =========================================
# DEPENDENCIES CHECK
# =========================================

PIL_AVAILABLE = False
PIX2TEX_AVAILABLE = False
EASYOCR_AVAILABLE = False

with redirect_stdout_to_stderr():
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


# =========================================
# IMAGE PROCESSING
# =========================================


def crop_to_content(
    image_path: str, padding: int = 20, threshold: int = 250
) -> Tuple[Optional["Image.Image"], Tuple[int, int, int, int]]:
    """
    Crop image to content bounding box.

    Returns:
        Tuple of (cropped_image, (raw_content_width, raw_content_height, padded_width, padded_height))

    Note: Returns RAW content dimensions for classification (before padding),
          but the cropped image includes padding for better OCR.
    """
    img = Image.open(image_path).convert("L")
    pixels = img.load()
    w, h = img.size

    # Find content bounds
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

    # RAW content dimensions (for classification)
    raw_w = max_x - min_x
    raw_h = max_y - min_y

    # Add padding for cropping (better OCR results)
    crop_min_x = max(0, min_x - padding)
    crop_min_y = max(0, min_y - padding)
    crop_max_x = min(w, max_x + padding)
    crop_max_y = min(h, max_y + padding)

    cropped = img.crop((crop_min_x, crop_min_y, crop_max_x, crop_max_y))

    # Return RAW dimensions for classification, padded dimensions for reference
    return cropped, (raw_w, raw_h, crop_max_x - crop_min_x, crop_max_y - crop_min_y)


def is_simple_content(
    content_width: int,
    content_height: int,
    area_threshold: int = 5000,
    max_dimension: int = 80,
) -> bool:
    """
    Detect if content is likely simple (number/short text) vs complex (formula).

    Simple content (use EasyOCR):
    - Very small area (< 5000 px²) - likely single digit/number
    - Small dimensions (< 80px) - not a formula
    - Aspect ratio < 2.5 - nearly square, not a horizontal formula

    Complex content (use pix2tex):
    - Horizontal text with aspect ratio > 2.5 (formulas like y = x³ + 2x + 1)
    - Larger content that might contain math symbols

    Key insight: Formulas tend to be WIDE (horizontal), numbers are SQUARE
    """
    area = content_width * content_height

    # Avoid division by zero
    if content_height == 0:
        return True

    aspect_ratio = content_width / content_height

    # Wide content (aspect ratio > 2.5) is likely a formula → NOT simple
    # Examples: "y = x³ + 2x + 1" has aspect ~5:1
    if aspect_ratio > 2.5:
        return False

    # Tall content (aspect ratio < 0.35) might be fraction/complex → NOT simple
    if aspect_ratio < 0.35:
        return False

    # Very small AND nearly square → likely simple number
    if area < area_threshold and aspect_ratio >= 0.35 and aspect_ratio <= 2.0:
        return True

    # Small dimensions and square-ish → simple
    if content_width < max_dimension and content_height < max_dimension:
        if aspect_ratio >= 0.35 and aspect_ratio <= 2.0:
            return True

    return False


# =========================================
# HYBRID OCR
# =========================================


class HybridOCR:
    """Hybrid OCR using EasyOCR for simple content and pix2tex for complex"""

    def __init__(self):
        self.pix2tex_model = None
        self.easyocr_reader = None
        self._pix2tex_initialized = False
        self._easyocr_initialized = False

    def _ensure_pix2tex(self):
        if self._pix2tex_initialized:
            return
        if not PIX2TEX_AVAILABLE:
            raise RuntimeError("pix2tex not available")
        gpu_status = "GPU" if GPU_AVAILABLE else "CPU"
        print(f"Loading pix2tex model ({gpu_status})...", file=sys.stderr)
        with redirect_stdout_to_stderr():
            # pix2tex uses PyTorch internally, it will auto-detect GPU
            self.pix2tex_model = LatexOCR()
        self._pix2tex_initialized = True
        print(f"pix2tex ready ({gpu_status})", file=sys.stderr)

    def _ensure_easyocr(self):
        if self._easyocr_initialized:
            return
        if not EASYOCR_AVAILABLE:
            raise RuntimeError("easyocr not available")
        gpu_status = "GPU" if GPU_AVAILABLE else "CPU"
        print(f"Loading EasyOCR model ({gpu_status})...", file=sys.stderr)
        with redirect_stdout_to_stderr():
            # Enable GPU if available (CUDA or MPS)
            self.easyocr_reader = easyocr.Reader(["en"], gpu=GPU_AVAILABLE, verbose=False)
        self._easyocr_initialized = True
        print(f"EasyOCR ready ({gpu_status})", file=sys.stderr)

    def cleanup(self):
        """Release models and clear GPU memory"""
        print(f"Cleaning up OCR models...", file=sys.stderr)
        
        # Get memory before cleanup
        mem_before = get_gpu_memory_info()
        
        # Delete model references
        if self.pix2tex_model is not None:
            del self.pix2tex_model
            self.pix2tex_model = None
            self._pix2tex_initialized = False
            
        if self.easyocr_reader is not None:
            del self.easyocr_reader
            self.easyocr_reader = None
            self._easyocr_initialized = False
        
        # Force garbage collection and clear CUDA cache
        clear_gpu_memory()
        
        # Get memory after cleanup
        mem_after = get_gpu_memory_info()
        
        if mem_before["allocated_mb"] > 0:
            freed = mem_before["allocated_mb"] - mem_after["allocated_mb"]
            print(f"GPU memory freed: {freed}MB (was {mem_before['allocated_mb']}MB, now {mem_after['allocated_mb']}MB)", file=sys.stderr)

    def ocr_simple(self, cropped_img: "Image.Image") -> str:
        """OCR for simple content using EasyOCR"""
        self._ensure_easyocr()

        # Convert to RGB for EasyOCR
        if cropped_img.mode != "RGB":
            cropped_img = cropped_img.convert("RGB")

        # Save to temp file (EasyOCR needs file path)
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            cropped_img.save(f.name)
            temp_path = f.name

        try:
            with redirect_stdout_to_stderr():
                result = self.easyocr_reader.readtext(temp_path)

            if result:
                # Return the text with highest confidence
                texts = [(r[1], r[2]) for r in result]  # (text, confidence)
                texts.sort(key=lambda x: x[1], reverse=True)
                return texts[0][0]
            return ""
        finally:
            os.unlink(temp_path)

    def ocr_complex(self, cropped_img: "Image.Image") -> str:
        """OCR for complex content using pix2tex"""
        self._ensure_pix2tex()

        # Convert to RGB for pix2tex
        if cropped_img.mode != "RGB":
            cropped_img = cropped_img.convert("RGB")

        with redirect_stdout_to_stderr():
            latex = self.pix2tex_model(cropped_img)

        return latex

    def ocr_image(self, image_path: str) -> Dict[str, Any]:
        """
        OCR a single image using hybrid approach.

        1. Crop to content
        2. Detect if simple or complex
        3. Use appropriate OCR
        """
        try:
            cropped, (content_w, content_h, _, _) = crop_to_content(image_path)

            if cropped is None:
                return {
                    "success": False,
                    "latex": "",
                    "file": image_path,
                    "error": "No content found",
                    "method": "none",
                    "content_size": (0, 0),
                }

            is_simple = is_simple_content(content_w, content_h)

            if is_simple:
                # Use EasyOCR for simple content
                text = self.ocr_simple(cropped)
                method = "easyocr"

                # Clean up common OCR artifacts
                text = text.strip()

                # FALLBACK: If EasyOCR returns empty, try pix2tex
                # This handles cases like single characters "0", "y" that EasyOCR misses
                if not text:
                    print(f"  EasyOCR empty, falling back to pix2tex...", file=sys.stderr)
                    text = self.ocr_complex(cropped)
                    method = "easyocr+pix2tex"

                # Try to detect if it's a number
                if text.isdigit():
                    latex = text
                elif text.replace(".", "").replace(",", "").isdigit():
                    latex = text
                else:
                    # Might be text or mixed, wrap appropriately
                    latex = text
            else:
                # Use pix2tex for complex content
                latex = self.ocr_complex(cropped)
                method = "pix2tex"

            return {
                "success": True,
                "latex": latex,
                "file": image_path,
                "error": None,
                "method": method,
                "content_size": (content_w, content_h),
                "is_simple": is_simple,
            }

        except Exception as e:
            return {
                "success": False,
                "latex": "",
                "file": image_path,
                "error": str(e),
                "method": "error",
                "content_size": (0, 0),
            }

    def ocr_directory(self, directory: str, pattern: str = "*.png", auto_cleanup: bool = True) -> Dict[str, Any]:
        """OCR all images in a directory
        
        Args:
            directory: Path to directory containing images
            pattern: Glob pattern for image files
            auto_cleanup: If True, automatically cleanup GPU memory after processing
        """
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

        total = len(image_files)
        
        # Show GPU memory at start
        mem_start = get_gpu_memory_info()
        if mem_start["total_mb"] > 0:
            print(f"GPU memory at start: {mem_start['allocated_mb']}MB / {mem_start['total_mb']}MB", file=sys.stderr)
        
        try:
            for i, img_path in enumerate(image_files, 1):
                print(f"Processing {i}/{total}: {img_path.name}", file=sys.stderr)

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
        finally:
            # ALWAYS cleanup after batch processing
            if auto_cleanup:
                self.cleanup()

        return {
            "results": results,
            "count": len(results),
            "success_count": len(results) - len(errors),
            "simple_count": simple_count,
            "complex_count": complex_count,
            "errors": errors,
        }


# =========================================
# MAIN
# =========================================


def check_system(verbose: bool = False) -> Dict[str, Any]:
    """Check system dependencies and GPU status"""
    status = {
        "pillow_available": PIL_AVAILABLE,
        "pix2tex_available": PIX2TEX_AVAILABLE,
        "easyocr_available": EASYOCR_AVAILABLE,
        "ready": PIL_AVAILABLE and (PIX2TEX_AVAILABLE or EASYOCR_AVAILABLE),
        "hybrid_ready": PIL_AVAILABLE and PIX2TEX_AVAILABLE and EASYOCR_AVAILABLE,
        "gpu_available": GPU_AVAILABLE,
        "gpu_name": GPU_NAME,
        "device": DEVICE,
    }

    if verbose:
        # Add more GPU details
        try:
            import torch
            status["torch_version"] = torch.__version__
            status["cuda_version"] = torch.version.cuda if torch.cuda.is_available() else "N/A"
            if torch.cuda.is_available():
                mem = get_gpu_memory_info()
                status["gpu_memory_total_mb"] = mem["total_mb"]
                status["gpu_memory_allocated_mb"] = mem["allocated_mb"]
                status["gpu_memory_reserved_mb"] = mem["reserved_mb"]
        except ImportError:
            status["torch_version"] = "not installed"

    return status


def main():
    parser = argparse.ArgumentParser(description="Hybrid Math OCR (EasyOCR + pix2tex) - GPU Optimized")
    parser.add_argument("input", nargs="?", help="Input image or directory")
    parser.add_argument(
        "--batch-dir", metavar="DIR", help="Process all PNGs in directory"
    )
    parser.add_argument("--output", "-o", metavar="FILE", help="Output file")
    parser.add_argument("--check", action="store_true", help="Check dependencies and GPU status")
    parser.add_argument("--verbose", "-v", action="store_true", help="Show detailed GPU info (with --check)")
    parser.add_argument("--no-cleanup", action="store_true", help="Disable automatic GPU memory cleanup after processing")

    args = parser.parse_args()

    if args.check:
        status = check_system(verbose=args.verbose)
        print(json.dumps(status, indent=2))
        # Print GPU status to stderr for visibility
        if status["gpu_available"]:
            print(f"GPU: {status['gpu_name']} ({status['device']})", file=sys.stderr)
        else:
            print("GPU: Not available, using CPU", file=sys.stderr)
        sys.exit(0 if status["hybrid_ready"] else 1)

    ocr = HybridOCR()
    auto_cleanup = not args.no_cleanup

    try:
        if args.batch_dir:
            result = ocr.ocr_directory(args.batch_dir, auto_cleanup=auto_cleanup)
            output = json.dumps(result, indent=2, ensure_ascii=False)
        elif args.input:
            if os.path.isdir(args.input):
                result = ocr.ocr_directory(args.input, auto_cleanup=auto_cleanup)
            else:
                result = ocr.ocr_image(args.input)
                # Cleanup after single image too
                if auto_cleanup:
                    ocr.cleanup()
            output = json.dumps(result, indent=2, ensure_ascii=False)
        else:
            parser.print_help()
            sys.exit(1)

        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(output)
            print(f"Results written to: {args.output}", file=sys.stderr)
        else:
            print(output)
    finally:
        # Final cleanup in case of errors
        if auto_cleanup and (ocr._pix2tex_initialized or ocr._easyocr_initialized):
            ocr.cleanup()


if __name__ == "__main__":
    main()
