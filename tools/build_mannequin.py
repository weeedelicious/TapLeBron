"""把 MakeHuman 的 CC0 资产合成成三维空间节点用的白模 glTF（带手指骨）。

为什么是离线脚本而不是运行时：
  · 源文件是 1.7MB 的 obj + 900KB 的权重表，不该进前端包，也不该让浏览器现算；
  · 最难的那一步（把 A-pose 烘成我们的静止姿势）放在这里才能单测、能重跑、能核对数字。

许可证：用到的三个文件本身就是 CC0，不依赖「未修改官方版导出可选 CC0」那条例外。
  data/3dobjs/base.obj        中性基础网格（2020-09 CC0 发布）
  data/rigs/default.mhskel    骨架，文件内写着 "license": "CC0"
  data/rigs/default_weights.mhw  蒙皮权重，同目录同一次发布
MakeHuman 程序本体是 AGPL —— 我们没有链接它、没有跑它，只读了它的数据文件。

── 三条关键设计 ────────────────────────────────────────────────────────────────

① **关节表是唯一真源，网格来适配它。**
   输出的 glTF 里每根骨的静止局部变换**只有平移、旋转是单位**，和 `skeleton.ts` 里那棵
   `Object3D` 树完全同构。所以 `ik.ts` 的正向运动学、`poseFromLandmarks.ts` 的重定向、
   `clampJointAngles` / `axisEulerSign` 的全部符号约定一行都不用改。

② **把「手臂朝下」烘进静止姿势。**
   MakeHuman 的静止姿势是 A-pose（上臂偏离垂直 39.5°），而我们全 0 的姿势是自然站立、
   手臂垂下。差量在这里一次性烘掉：按目标方向算出每根骨的局部旋转、做一次蒙皮变换、
   把结果当成新的静止姿势写出。烘完之后骨的局部旋转重新归零 —— 也就是 ① 说的同构。

③ **只烘该烘的。** 躯干的自然曲度、腿的轻微外张、手指的自然微屈都保留 ——
   把它们强行掰直会让白模显得僵硬，而这些偏差都在「骨头大体朝 ±Y」的范围内，
   `bend/turn/tilt` 的语义照旧成立。

用法：
    python tools/build_mannequin.py            # 抓资产（已存在则跳过）→ 合成 → 自检 → 写文件
    python tools/build_mannequin.py --report   # 只打印数字，不写文件
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / 'assets-src' / 'makehuman'
# 放 public/ 而不是 dist/：`vite build` 会清空 dist、但会把 public 整份拷进去。
# 放 dist 的话每次本地构建都得重跑这个脚本，白模就没了。
# （21MB 的 MediaPipe 模型仍留在 dist/models/ 单独推 —— 那个不该每次构建都拷一遍。）
OUT_GLB = ROOT / 'public' / 'models' / 'mannequin.glb'
OUT_TS = ROOT / 'src' / 'canvas' / 'features' / 'director-stage' / 'mannequinRest.generated.ts'

BASE_URL = 'https://raw.githubusercontent.com/makehumancommunity/makehuman/master/makehuman/data'
SOURCES = {
    'base.obj': f'{BASE_URL}/3dobjs/base.obj',
    'default.mhskel': f'{BASE_URL}/rigs/default.mhskel',
    'default_weights.mhw': f'{BASE_URL}/rigs/default_weights.mhw',
}

# MakeHuman 的基础网格是分米单位（body 组高 16.659 → 1.666m，是个合理身高）
SCALE = 0.1
# 渲染进白模的组：body 是皮肤，两个 helper-*-eye 是半径 1.5cm 的正球（真眼球，
# 圆心恰在 eye.L/R 关节上，72 个顶点全有权重）—— 不包进来的话眼窝是两个洞。
RENDER_GROUPS = ('body', 'helper-l-eye', 'helper-r-eye')

# ── 我们的关节 → MakeHuman 代表骨 ────────────────────────────────────────────
# 顺序即 DIRECTOR_JOINTS 的顺序：父必须在子之前（ik.ts 的正向运动学依赖这一点，有测试锁着）。
# 没列进来的 MakeHuman 骨不会消失 —— 它们的权重并到「最近的已保留祖先」上（见 build_rep_map）。
# 所以 upperarm02 并进上臂、lowerarm02 并进前臂、掌骨并进手、脚趾并进脚、全部面部骨并进头。
JOINT_MAP: list[tuple[str, str, str | None]] = [
    ('hips',      'spine05',      None),
    ('spine',     'spine03',      'hips'),
    ('chest',     'spine01',      'spine'),
    ('neck',      'neck01',       'chest'),
    ('head',      'head',         'neck'),
]
FINGERS = (
    ('thumb',  'finger1'),
    ('index',  'finger2'),
    ('middle', 'finger3'),
    ('ring',   'finger4'),
    ('little', 'finger5'),
)
for side in ('L', 'R'):
    JOINT_MAP += [
        (f'shoulder{side}', f'clavicle.{side}',    'chest'),
        (f'upperArm{side}', f'upperarm01.{side}',  f'shoulder{side}'),
        (f'elbow{side}',    f'lowerarm01.{side}',  f'upperArm{side}'),
        (f'wrist{side}',    f'wrist.{side}',       f'elbow{side}'),
    ]
    # 拇指在 MakeHuman 里直接挂手腕，其余四指挂掌骨；掌骨并进手之后它们也都挂到手上。
    for name, mh in FINGERS:
        JOINT_MAP += [
            (f'{name}1{side}', f'{mh}-1.{side}', f'wrist{side}'),
            (f'{name}2{side}', f'{mh}-2.{side}', f'{name}1{side}'),
            (f'{name}3{side}', f'{mh}-3.{side}', f'{name}2{side}'),
        ]
for side in ('L', 'R'):
    JOINT_MAP += [
        (f'thigh{side}', f'upperleg01.{side}', 'hips'),
        (f'knee{side}',  f'lowerleg01.{side}', f'thigh{side}'),
        (f'ankle{side}', f'foot.{side}',       f'knee{side}'),
    ]

# 胸部骨在 MakeHuman 里挂在 spine02 下（→ 会并进「腰」），但解剖上它该跟着胸走。
REP_OVERRIDE = {'breast.L': 'chest', 'breast.R': 'chest'}

# ── 烘：把哪几根骨掰到什么方向 ───────────────────────────────────────────────
# 只有手臂需要 —— A-pose 的上臂偏离垂直 39.5°，而我们全 0 姿势是垂下。
# 方向的定义是「本骨原点 → 参考子关节原点」。
DOWN = np.array([0.0, -1.0, 0.0])
AIM: dict[str, tuple[str, np.ndarray]] = {}
for side in ('L', 'R'):
    AIM[f'upperArm{side}'] = (f'elbow{side}', DOWN)
    AIM[f'elbow{side}']    = (f'wrist{side}', DOWN)
    AIM[f'wrist{side}']    = (f'middle1{side}', DOWN)
# 手掌的滚转：单纯瞄方向不约束绕自身轴的旋转。自然站立时拇指朝前，
# 也就是「小指→食指」这条横穿手掌的向量朝 +Z。两只手都是。
FORWARD = np.array([0.0, 0.0, 1.0])
TWIST = {f'wrist{s}': (f'little1{s}', f'index1{s}', FORWARD) for s in ('L', 'R')}

MAX_INFLUENCES = 4  # glTF 的 JOINTS_0/WEIGHTS_0 一组就是 4 个


# ── 小工具 ──────────────────────────────────────────────────────────────────
def unit(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    if n < 1e-12:
        raise ValueError('零向量没有方向')
    return v / n


def skew(v: np.ndarray) -> np.ndarray:
    return np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])


def rot_between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """把向量 a 转到 b 的最小旋转（不引入多余的绕轴扭转）。"""
    a, b = unit(a), unit(b)
    c = float(np.dot(a, b))
    if c > 1 - 1e-12:
        return np.eye(3)
    if c < -1 + 1e-9:
        # 反向：绕任意一条垂直轴转 180°
        axis = np.cross(a, np.array([1.0, 0.0, 0.0]))
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, np.array([0.0, 1.0, 0.0]))
        return rot_axis(unit(axis), np.pi)
    v = np.cross(a, b)
    vx = skew(v)
    return np.eye(3) + vx + vx @ vx * (1.0 / (1.0 + c))


def rot_axis(axis: np.ndarray, angle: float) -> np.ndarray:
    a = unit(axis)
    K = skew(a)
    return np.eye(3) + np.sin(angle) * K + (1 - np.cos(angle)) * (K @ K)


def signed_angle_about(a: np.ndarray, b: np.ndarray, axis: np.ndarray) -> float:
    """a 绕 axis 转多少度能对上 b（只看垂直于 axis 的分量）。"""
    ax = unit(axis)
    pa = a - ax * np.dot(a, ax)
    pb = b - ax * np.dot(b, ax)
    if np.linalg.norm(pa) < 1e-9 or np.linalg.norm(pb) < 1e-9:
        return 0.0
    pa, pb = unit(pa), unit(pb)
    return float(np.arctan2(np.dot(np.cross(pa, pb), ax), np.dot(pa, pb)))


def angle_deg(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.degrees(np.arccos(np.clip(np.dot(unit(a), unit(b)), -1.0, 1.0))))


# ── 读源文件 ────────────────────────────────────────────────────────────────
def fetch_sources() -> None:
    SRC_DIR.mkdir(parents=True, exist_ok=True)
    for name, url in SOURCES.items():
        dest = SRC_DIR / name
        if dest.exists() and dest.stat().st_size > 0:
            continue
        print(f'  下载 {name} …', end=' ', flush=True)
        with urllib.request.urlopen(url, timeout=120) as resp:
            dest.write_bytes(resp.read())
        print(f'{dest.stat().st_size} bytes')


def load_obj() -> tuple[np.ndarray, dict[str, list[list[int]]]]:
    """返回 (全部顶点, 组名 → 面列表)。面里的下标已经转成 0-based。"""
    verts: list[list[float]] = []
    faces: dict[str, list[list[int]]] = {}
    group = None
    for line in (SRC_DIR / 'base.obj').read_text(encoding='utf-8', errors='replace').splitlines():
        if line.startswith('v '):
            verts.append([float(x) for x in line.split()[1:4]])
        elif line.startswith('g '):
            group = line[2:].strip()
            faces.setdefault(group, [])
        elif line.startswith('f '):
            faces[group].append([int(t.split('/')[0]) - 1 for t in line.split()[1:]])
    return np.array(verts, dtype=np.float64), faces


def joint_positions(verts: np.ndarray, skel: dict) -> dict[str, np.ndarray]:
    """mhskel 不写死坐标 —— 每个关节是一串**基础网格顶点下标**（0-based），取平均即位置。
    这样骨架会随网格形变自动跟上，也是 MakeHuman 能捏体型的原因。"""
    return {name: verts[idx].mean(axis=0) for name, idx in skel['joints'].items()}


def build_rep_map(bones: dict, kept: dict[str, str]) -> dict[str, str]:
    """每根 MakeHuman 骨的权重该并给谁：**最近的已保留祖先（含自己）**。
    走到顶还没找到的（root 那一支）归胯。"""
    by_mh = {mh: ours for ours, mh in kept.items()}
    rep: dict[str, str] = {}
    for bone in bones:
        if bone in REP_OVERRIDE:
            rep[bone] = REP_OVERRIDE[bone]
            continue
        cur: str | None = bone
        rep[bone] = 'hips'  # 走到顶还没找到就归胯（root 那一支）
        while cur is not None:
            if cur in by_mh:
                rep[bone] = by_mh[cur]
                break
            cur = bones[cur]['parent']
    return rep


# ── 烘静止姿势 ──────────────────────────────────────────────────────────────
def bake(rest: dict[str, np.ndarray], order: list[str], parent: dict[str, str | None]):
    """算出每根骨的世界旋转 Q 和烘完的世界位置 H。

    公式（和 glTF 的蒙皮定义对齐）：
        H[j] = H[parent] + Q[parent] · (rest[j] - rest[parent])
        Q[j] = Q[parent] · R_local[j]
    有了这两个，顶点的蒙皮矩阵就是  translate(H[j]) · Q[j] · translate(-rest[j])。
    """
    Q: dict[str, np.ndarray] = {}
    H: dict[str, np.ndarray] = {}
    for j in order:
        p = parent[j]
        Qp = Q[p] if p else np.eye(3)
        H[j] = (H[p] + Qp @ (rest[j] - rest[p])) if p else rest[j].copy()

        R_local = np.eye(3)
        if j in AIM:
            child, target = AIM[j]
            d = rest[child] - rest[j]
            R_local = rot_between(d, Qp.T @ target)
            if j in TWIST:
                a_name, b_name, want = TWIST[j]
                across = rest[b_name] - rest[a_name]
                after = Qp @ R_local @ across
                ang = signed_angle_about(after, want, target)
                # 额外的扭转是绕**世界**目标轴的，换算回局部：Q = Rtwist·Qp·R_local
                R_local = Qp.T @ rot_axis(target, ang) @ Qp @ R_local
        Q[j] = Qp @ R_local
    return Q, H


def skin_vertices(verts: np.ndarray, joints_idx: np.ndarray, weights: np.ndarray,
                  order: list[str], Q: dict[str, np.ndarray], H: dict[str, np.ndarray],
                  rest: dict[str, np.ndarray]) -> np.ndarray:
    """按烘的姿势做一次蒙皮，结果就是新的静止网格。"""
    out = np.zeros_like(verts)
    mats = []
    for j in order:
        M = np.eye(4)
        M[:3, :3] = Q[j]
        M[:3, 3] = H[j] - Q[j] @ rest[j]
        mats.append(M)
    mats = np.array(mats)
    for slot in range(joints_idx.shape[1]):
        w = weights[:, slot]
        active = w > 0
        if not active.any():
            continue
        M = mats[joints_idx[active, slot]]
        v = verts[active]
        moved = np.einsum('nij,nj->ni', M[:, :3, :3], v) + M[:, :3, 3]
        out[active] += moved * w[active, None]
    return out


def vertex_normals(verts: np.ndarray, tris: np.ndarray) -> np.ndarray:
    n = np.zeros_like(verts)
    a, b, c = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    fn = np.cross(b - a, c - a)  # 不归一化 → 天然按面积加权
    for k in range(3):
        np.add.at(n, tris[:, k], fn)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    ln[ln < 1e-12] = 1.0
    return n / ln


# ── 写 glb ──────────────────────────────────────────────────────────────────
def write_glb(path: Path, positions, normals, joints_idx, weights, tris,
              order: list[str], parent: dict[str, str | None], H: dict[str, np.ndarray]) -> int:
    blobs: list[bytes] = []
    views: list[dict] = []
    offset = 0

    def add(data: np.ndarray, target: int | None = None) -> int:
        nonlocal offset
        raw = data.tobytes()
        pad = (-len(raw)) % 4
        blobs.append(raw + b'\x00' * pad)
        views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(raw)})
        offset += len(raw) + pad
        return len(views) - 1

    # min/max 要和实际存进去的 f32 精度一致，所以先降精度再取
    pos32 = positions.astype('<f4')
    v_pos = add(pos32)
    v_nrm = add(normals.astype('<f4'))
    v_jnt = add(joints_idx.astype('<u1'))
    v_wgt = add(weights.astype('<f4'))
    v_idx = add(tris.astype('<u2'))

    ibm = np.zeros((len(order), 16), dtype='<f4')
    for i, j in enumerate(order):
        m = np.eye(4)
        m[:3, 3] = -H[j]
        ibm[i] = m.T.reshape(-1)  # glTF 是列主序
    v_ibm = add(ibm)

    n_vert = len(positions)
    accessors = [
        {'bufferView': v_pos, 'componentType': 5126, 'count': n_vert, 'type': 'VEC3',
         'min': [float(x) for x in pos32.min(axis=0)], 'max': [float(x) for x in pos32.max(axis=0)]},
        {'bufferView': v_nrm, 'componentType': 5126, 'count': n_vert, 'type': 'VEC3'},
        {'bufferView': v_jnt, 'componentType': 5121, 'count': n_vert, 'type': 'VEC4'},
        {'bufferView': v_wgt, 'componentType': 5126, 'count': n_vert, 'type': 'VEC4'},
        {'bufferView': v_idx, 'componentType': 5123, 'count': tris.size, 'type': 'SCALAR'},
        {'bufferView': v_ibm, 'componentType': 5126, 'count': len(order), 'type': 'MAT4'},
    ]

    # 节点 0 是蒙皮网格本体，1.. 是骨。网格节点不能挂在骨下面，否则会被变换两次。
    nodes: list[dict] = [{'name': 'mannequin', 'mesh': 0, 'skin': 0}]
    node_of = {j: i + 1 for i, j in enumerate(order)}
    for j in order:
        p = parent[j]
        local = H[j] - H[p] if p else H[j]
        node: dict = {'name': j, 'translation': [round(float(x), 6) for x in local]}
        kids = [node_of[k] for k in order if parent[k] == j]
        if kids:
            node['children'] = kids
        nodes.append(node)

    gltf = {
        'asset': {'version': '2.0',
                  'generator': 'tools/build_mannequin.py — MakeHuman CC0 base mesh + default skeleton'},
        'scene': 0,
        'scenes': [{'nodes': [0, node_of[order[0]]]}],
        'nodes': nodes,
        'skins': [{'name': 'mannequin', 'skeleton': node_of[order[0]],
                   'joints': [node_of[j] for j in order], 'inverseBindMatrices': v_ibm_acc(accessors)}],
        'materials': [{'name': 'mannequin', 'doubleSided': False,
                       'pbrMetallicRoughness': {'baseColorFactor': [0.82, 0.83, 0.86, 1.0],
                                                'metallicFactor': 0.04, 'roughnessFactor': 0.72}}],
        'meshes': [{'name': 'mannequin', 'primitives': [{
            'attributes': {'POSITION': 0, 'NORMAL': 1, 'JOINTS_0': 2, 'WEIGHTS_0': 3},
            'indices': 4, 'material': 0}]}],
        'accessors': accessors,
        'bufferViews': [{k: v for k, v in view.items() if k != 'bufferTarget'} for view in views],
        'buffers': [{'byteLength': offset}],
    }

    bin_blob = b''.join(blobs)
    json_blob = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
    json_blob += b' ' * ((-len(json_blob)) % 4)
    total = 12 + 8 + len(json_blob) + 8 + len(bin_blob)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('wb') as fh:
        fh.write(b'glTF' + struct.pack('<II', 2, total))
        fh.write(struct.pack('<II', len(json_blob), 0x4E4F534A) + json_blob)
        fh.write(struct.pack('<II', len(bin_blob), 0x004E4942) + bin_blob)
    return total


def v_ibm_acc(accessors: list[dict]) -> int:
    """逆绑定矩阵那个 accessor 的下标（固定是最后一个）。"""
    return len(accessors) - 1


# ── 主流程 ──────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--report', action='store_true', help='只打印数字，不写文件')
    args = ap.parse_args()

    print('抓取 CC0 源文件 …')
    fetch_sources()

    verts_raw, faces = load_obj()
    skel = json.loads((SRC_DIR / 'default.mhskel').read_text(encoding='utf-8'))
    wraw = json.loads((SRC_DIR / 'default_weights.mhw').read_text(encoding='utf-8'))['weights']
    if skel.get('license') != 'CC0':
        print(f"  !! mhskel 的 license 不是 CC0 而是 {skel.get('license')!r} —— 停手", file=sys.stderr)
        return 1
    bones = skel['bones']
    jpos = joint_positions(verts_raw, skel)

    order = [ours for ours, _, _ in JOINT_MAP]
    kept = {ours: mh for ours, mh, _ in JOINT_MAP}
    parent = {ours: par for ours, _, par in JOINT_MAP}
    missing = [mh for mh in kept.values() if mh not in bones]
    if missing:
        print(f'  !! 这些骨在 mhskel 里不存在：{missing}', file=sys.stderr)
        return 1

    # 派生的父子关系必须和写死的那份一致 —— 不一致说明 MakeHuman 改了绑定。
    # rep 已经把任意骨映射到「最近的已保留祖先」，所以直接查代表骨的父即可。
    rep = build_rep_map(bones, kept)
    for ours, mh, declared in JOINT_MAP:
        if declared is None:
            continue
        mh_parent = bones[mh]['parent']
        derived = rep[mh_parent] if mh_parent else None
        if derived != declared:
            print(f'  !! {ours}: 写死的父是 {declared!r}，按骨架推出来是 {derived!r}', file=sys.stderr)
            return 1

    # ── 顶点：只要要渲染的那几组，重编号 ────────────────────────────────────
    used: list[int] = []
    seen: dict[int, int] = {}
    tris: list[tuple[int, int, int]] = []
    for group in RENDER_GROUPS:
        if group not in faces:
            print(f'  !! base.obj 里没有 {group!r} 组', file=sys.stderr)
            return 1
        for face in faces[group]:
            remapped = []
            for vi in face:
                if vi not in seen:
                    seen[vi] = len(used)
                    used.append(vi)
                remapped.append(seen[vi])
            # 四边形 → 两个三角形（base.obj 全是四边形）
            for k in range(1, len(remapped) - 1):
                tris.append((remapped[0], remapped[k], remapped[k + 1]))
    used_arr = np.array(used)
    tris_arr = np.array(tris, dtype=np.int64)

    # ── 权重：并到代表骨上，取最重的 4 个再归一化 ──────────────────────────
    slot_of = {j: i for i, j in enumerate(order)}
    per_vertex: dict[int, dict[int, float]] = {}
    for bone, entries in wraw.items():
        target = slot_of[rep[bone]]
        for vi, w in entries:
            if vi not in seen or w <= 0:
                continue
            bucket = per_vertex.setdefault(seen[vi], {})
            bucket[target] = bucket.get(target, 0.0) + float(w)

    n_vert = len(used)
    joints_idx = np.zeros((n_vert, MAX_INFLUENCES), dtype=np.int64)
    weights = np.zeros((n_vert, MAX_INFLUENCES), dtype=np.float64)
    unweighted = 0
    for vi in range(n_vert):
        bucket = per_vertex.get(vi)
        if not bucket:
            unweighted += 1
            joints_idx[vi, 0] = slot_of['head']  # 只可能是眼球那一小撮，兜底跟着头
            weights[vi, 0] = 1.0
            continue
        top = sorted(bucket.items(), key=lambda kv: -kv[1])[:MAX_INFLUENCES]
        total = sum(w for _, w in top)
        for slot, (bone_slot, w) in enumerate(top):
            joints_idx[vi, slot] = bone_slot
            weights[vi, slot] = w / total

    # ── 烘 ──────────────────────────────────────────────────────────────────
    rest = {j: jpos[bones[kept[j]]['head']] * SCALE for j in order}
    Q, H = bake(rest, order, parent)
    posed = skin_vertices(verts_raw[used_arr] * SCALE, joints_idx, weights, order, Q, H, rest)

    # 脚底归零（烘完再量：手臂垂下之后最低点仍然是脚）
    lift = float(posed[:, 1].min())
    posed[:, 1] -= lift
    for j in order:
        H[j] = H[j] - np.array([0.0, lift, 0.0])

    normals = vertex_normals(posed, tris_arr)

    # ── 自检 ────────────────────────────────────────────────────────────────
    print('\n自检：')
    ok = True

    def check(label: str, passed: bool, detail: str = '') -> None:
        nonlocal ok
        ok = ok and passed
        print(f"  {'✓' if passed else '✗'} {label}{('  ' + detail) if detail else ''}")

    check('关节数 = 49', len(order) == 49, f'实际 {len(order)}')
    check('父在子之前', all(parent[j] is None or order.index(parent[j]) < i
                            for i, j in enumerate(order)))
    finger_ids = [f'{name}{k}{s}' for name, _ in FINGERS for k in (1, 2, 3) for s in ('L', 'R')]
    check('30 根指骨都在', len(finger_ids) == 30 and all(j in slot_of for j in finger_ids))
    wsum = weights.sum(axis=1)
    check('每顶点权重和为 1', bool(np.allclose(wsum, 1.0, atol=1e-6)),
          f'min {wsum.min():.6f} max {wsum.max():.6f}')
    check('没有无权重的顶点（眼球兜底除外）', unweighted <= 144, f'兜底 {unweighted} 个')
    check('坐标没有 NaN/Inf', bool(np.isfinite(posed).all() and np.isfinite(normals).all()))
    for side in ('L', 'R'):
        d = angle_deg(H[f'elbow{side}'] - H[f'upperArm{side}'], DOWN)
        check(f'上臂({side}) 与 −Y 的夹角 < 1°', d < 1.0, f'{d:.3f}°')
        d = angle_deg(H[f'wrist{side}'] - H[f'elbow{side}'], DOWN)
        check(f'前臂({side}) 与 −Y 的夹角 < 1°', d < 1.0, f'{d:.3f}°')
        # 手掌滚转：小指→食指 这条横穿手掌的向量，投到水平面上应该贴着 +Z（拇指朝前）
        across = H[f'index1{side}'] - H[f'little1{side}']
        palm = angle_deg(across - np.array([0.0, across[1], 0.0]), FORWARD)
        check(f'手掌({side}) 拇指朝前（小指→食指 贴 +Z）< 15°', palm < 15.0, f'{palm:.1f}°')
    height = float(posed[:, 1].max())
    check('身高在 1.5–1.9m', 1.5 < height < 1.9, f'{height:.3f}m')
    check('腿没被烘动（膝盖仍在髋下方）',
          all(H[f'knee{s}'][1] < H[f'thigh{s}'][1] for s in ('L', 'R')))

    # ── 报告 ────────────────────────────────────────────────────────────────
    print(f'\n网格：{n_vert} 顶点 / {len(tris_arr)} 三角形（body + 两颗眼球），身高 {height:.3f}m')
    print('关节世界位置（烘完，脚底 y=0）与骨长：')
    finger_prefixes = tuple(name for name, _ in FINGERS)
    for j in order:
        par = parent[j]
        # 30 根指骨太占地方：每根手指只列第一节，中/远节的长度汇总在后面
        if par and par.startswith(finger_prefixes):
            continue
        p = H[j]
        seg = f'  ← {np.linalg.norm(p - H[par]) * 100:5.1f}cm' if par else ''
        print(f'    {j:<12} ({p[0]:+.3f}, {p[1]:.3f}, {p[2]:+.3f}){seg}')
    print('  手指总长（近+中+远，cm）：', '  '.join(
        f'{name}={sum(np.linalg.norm(H[f"{name}{k + 1}L"] - H[f"{name}{k}L"]) for k in (1, 2)) * 100 + np.linalg.norm(H[f"{name}1L"] - H["wristL"]) * 100:.1f}'
        for name, _ in FINGERS))

    if args.report:
        print('\n--report：不写文件')
        return 0 if ok else 1
    if not ok:
        print('\n自检没过 —— 不写文件', file=sys.stderr)
        return 1

    size = write_glb(OUT_GLB, posed, normals, joints_idx, weights, tris_arr, order, parent, H)
    print(f'\n写出 {OUT_GLB.relative_to(ROOT)}  {size / 1024:.0f} KB')

    lines = [
        '/**',
        ' * 白模骨架的静止偏移 —— **由 tools/build_mannequin.py 生成，不要手改。**',
        ' *',
        ' * 数字来自 MakeHuman 的 CC0 基础网格 + CC0 默认骨架（见那个脚本的注释），',
        ' * 已经把 A-pose 烘成我们的静止姿势（手臂垂下）。glTF 里的骨和这里的偏移',
        ' * 是同一套数字 —— 所以蒙皮白模和程序化兜底白模的骨架完全一致，两者切换姿势不会跳。',
        ' */',
        '',
        'export const MANNEQUIN_REST_OFFSETS: Record<string, [number, number, number]> = {',
    ]
    for j in order:
        par = parent[j]
        local = H[j] - H[par] if par else H[j]
        vals = ', '.join(f'{v:.4f}' for v in local)
        lines.append(f'  {j}: [{vals}],')
    lines += ['}', '']
    OUT_TS.write_text('\n'.join(lines), encoding='utf-8')
    print(f'写出 {OUT_TS.relative_to(ROOT)}  ({len(order)} 个关节的偏移)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
