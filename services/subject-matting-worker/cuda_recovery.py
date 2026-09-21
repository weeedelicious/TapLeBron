import os
import time
from dataclasses import dataclass
from typing import Any


CUDA_FATAL_ERROR_MARKERS = (
    "cuda error: unknown error",
    "device-side assert",
    "illegal memory access",
    "unspecified launch failure",
    "cuda driver error",
    "cudnn_status_internal_error",
    "cublas_status_not_initialized",
)


def is_fatal_cuda_error(exc: BaseException) -> bool:
    """Return True only for CUDA failures that can poison the process context."""
    current: BaseException | None = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        message = str(current).lower()
        if any(marker in message for marker in CUDA_FATAL_ERROR_MARKERS):
            return True
        current = current.__cause__ or current.__context__
    return False


def safe_cuda_error_summary(exc: BaseException) -> str:
    message = " ".join(str(exc).split())[:240]
    return f"{type(exc).__name__}: {message}" if message else type(exc).__name__


@dataclass
class CudaHealthState:
    fatal_error: str | None = None

    def mark_fatal(self, exc: BaseException) -> None:
        self.fatal_error = safe_cuda_error_summary(exc)

    def probe(self, torch_module: Any, device: str) -> tuple[bool, str | None]:
        if not str(device).lower().startswith("cuda"):
            return True, None
        if self.fatal_error:
            return False, self.fatal_error
        try:
            if not torch_module.cuda.is_available():
                raise RuntimeError("CUDA is not available")
            value = (torch_module.ones((1,), device=device) + 1.0).item()
            torch_module.cuda.synchronize()
            if value != 2.0:
                raise RuntimeError("CUDA probe returned an unexpected result")
        except Exception as exc:
            self.mark_fatal(exc)
            return False, self.fatal_error
        return True, None


def terminate_process_after_response(exit_code: int = 70, delay_seconds: float = 0.15) -> None:
    """Run as a Starlette background task, after the 503 response is flushed."""
    if delay_seconds > 0:
        time.sleep(delay_seconds)
    os._exit(exit_code)
