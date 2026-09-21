import unittest
from unittest.mock import patch

from cuda_recovery import CudaHealthState, is_fatal_cuda_error, terminate_process_after_response


class _FakeCuda:
    def __init__(self, available=True, synchronize_error=None):
        self.available = available
        self.synchronize_error = synchronize_error

    def is_available(self):
        return self.available

    def synchronize(self):
        if self.synchronize_error:
            raise self.synchronize_error


class _FakeTensor:
    def __init__(self, value):
        self.value = value

    def __add__(self, value):
        return _FakeTensor(self.value + value)

    def item(self):
        return self.value


class _FakeTorch:
    def __init__(self, cuda):
        self.cuda = cuda

    def ones(self, shape, device):
        return _FakeTensor(1.0)


class CudaRecoveryTest(unittest.TestCase):
    def test_real_cuda_probe_succeeds(self):
        state = CudaHealthState()
        ok, error = state.probe(_FakeTorch(_FakeCuda()), "cuda")
        self.assertTrue(ok)
        self.assertIsNone(error)

    def test_failed_cuda_probe_stays_unhealthy(self):
        state = CudaHealthState()
        torch_module = _FakeTorch(_FakeCuda(synchronize_error=RuntimeError("CUDA error: unknown error")))
        ok, error = state.probe(torch_module, "cuda")
        self.assertFalse(ok)
        self.assertIn("unknown error", error)
        ok_again, _ = state.probe(_FakeTorch(_FakeCuda()), "cuda")
        self.assertFalse(ok_again)

    def test_only_fatal_cuda_errors_trigger_restart_path(self):
        self.assertTrue(is_fatal_cuda_error(RuntimeError("CUDA error: unknown error")))
        self.assertTrue(is_fatal_cuda_error(RuntimeError("device-side assert triggered")))
        self.assertFalse(is_fatal_cuda_error(ValueError("invalid image payload")))
        self.assertFalse(is_fatal_cuda_error(RuntimeError("CUDA out of memory")))

    @patch("cuda_recovery.os._exit")
    @patch("cuda_recovery.time.sleep")
    def test_termination_runs_after_response_delay(self, sleep, exit_process):
        terminate_process_after_response(exit_code=70, delay_seconds=0.15)
        sleep.assert_called_once_with(0.15)
        exit_process.assert_called_once_with(70)


if __name__ == "__main__":
    unittest.main()
