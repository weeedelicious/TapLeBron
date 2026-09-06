# Shotflow MoGe-2 Worker

This service owns GPU inference for the Light Stage geometry pass. It loads
Microsoft MoGe-2 with the `Ruicheng/moge-2-vitb-normal` checkpoint and exposes
authenticated LAN-only geometry inference to the Shotflow application server.

Outputs:

- bounded diffuse approximation
- camera-space normal PNG
- normalized 16-bit depth PNG
- valid-pixel mask PNG
- sampled OpenGL point map
- normalized camera intrinsics and estimated horizontal field of view

The worker is intentionally separate from the Shotflow web process. A web
restart does not unload the model, and browser users never connect to this
service directly.

## Windows RTX setup

Use Python 3.11 and the stable CUDA 12.8 PyTorch build:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip install --no-deps torch==2.7.1+cu128 torchvision==0.22.1+cu128 --index-url https://download.pytorch.org/whl/cu128
.\.venv\Scripts\python.exe -m pip install --no-deps git+https://github.com/microsoft/MoGe.git
```

Install the official `utils3d` dependency required by MoGe and place the checkpoint at:

```text
C:\Shotflow\moge-worker\models\moge-2-vitb-normal\model.pt
```

The expected checkpoint size is `419110160` bytes.

Run `smoke_test.py <image.png>` after driver, PyTorch, or checkpoint changes. A valid result includes RGB diffuse and normal maps, a 16-bit depth map, a mask, a point map, and camera intrinsics.
