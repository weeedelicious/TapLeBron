"""Task-local timings and optional single-process model reuse; no result cache."""
import time
from contextlib import contextmanager
from ui_mask_core import atomic_json


class ModelStore:
    def __init__(self):
        self.enabled = False
        self.key = None
        self.model = None

    def clear(self):
        self.key = self.model = None

    def load(self, factory, weights, config, device):
        # Caller validates the actual weight digest on EVERY task.
        import json
        key = (str(weights), json.dumps(config, sort_keys=True), device)
        if self.enabled and key == self.key and self.model is not None:
            return self.model, True
        self.clear()
        model = factory(str(weights))
        if self.enabled:
            self.key, self.model = key, model
        return model, False


models = ModelStore()


@contextmanager
def import_watch(directory):
    """Capture a stalled import's stacks without a second inference or profiler."""
    import faulthandler
    with (directory / 'dependency-stall.log').open('a', encoding='utf-8') as stream:
        faulthandler.dump_traceback_later(30, file=stream)
        try:
            yield
        finally:
            faulthandler.cancel_dump_traceback_later()


class ModelTiming:
    def __init__(self, directory):
        self.path = directory / 'model-phase-times.json'
        self.started = self.tick = time.perf_counter()
        self.data = {'clock': 'wall-perf-counter', 'gpuKernelTiming': False}

    def mark(self, name):
        now = time.perf_counter()
        self.data[name] = now - self.tick
        self.tick = now

    def save(self, **extra):
        self.data.update(extra)
        self.data['elapsedSeconds'] = time.perf_counter() - self.started
        atomic_json(self.path, self.data)
