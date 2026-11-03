from pathlib import Path
from PIL import Image
pairs = [
    (r"C:\Users\wuyixiang\AppData\Roaming\Cindy\cindy-media\blobs\85\85fd58ea681376c1f3d40d36def52c4151ea0e2bd4bb14dd375a9679fdb4f4b1.png", r"C:\Users\wuyixiang\Documents\TapLeBron\tools\_ref_a.jpg"),
    (r"C:\Users\wuyixiang\AppData\Roaming\Cindy\cindy-media\blobs\1b\1bfb73cbf65f9eca774a608bffb407e3972a1dac3de6f94fc12199923129e3c1.png", r"C:\Users\wuyixiang\Documents\TapLeBron\tools\_ref_b.jpg"),
]
for src, dst in pairs:
    im = Image.open(src).convert("RGB")
    im.thumbnail((960, 960))
    im.save(dst, "JPEG", quality=72)
    print(dst, im.size)
