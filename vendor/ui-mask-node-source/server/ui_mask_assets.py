"""Resolve immutable draft frames without duplicating component output files."""
from pathlib import Path
import hashlib
import cv2

COMPONENT_LAYOUT = 'component-native-v1'
FOLDERS = {'source': 'source', 'raw': 'raw-union',
           'repair': 'combined-repair', 'covered': 'black-preview'}


def write_png_digest(path, image):
    """Encode once, hash the actual encoded bytes, and propagate write errors."""
    ok, encoded = cv2.imencode('.png', image)
    if not ok:
        raise IOError('Cannot encode draft frame')
    data = encoded.tobytes()
    Path(path).write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def frame_path(directory, kind, frame, layout=None):
    if kind not in FOLDERS or not isinstance(frame, int) or frame < 0:
        raise ValueError('Invalid draft frame')
    directory = Path(directory)
    if layout == COMPONENT_LAYOUT:
        return directory / FOLDERS[kind] / f'v03-{frame:03d}.png'
    if layout is not None:
        raise ValueError('Unknown draft frame layout')
    return directory / 'frames' / kind / f'{frame:06d}.png'
