# リドの 3D モデルを測って、js/lido-fit.js に入れる数値を出す（頭の中心と半径・顔の向き・口の高さ・目の位置）。
# 口と目はテクスチャの色で見つける（口 = 赤み、目 = ほぼ黒）。座標は glTF のまま（x が前、y が上）。
# 実行: blender --background --python tools/measure-lido.py -- assets/turtle.glb
import bpy, sys, json, math
import numpy as np

glb = sys.argv[sys.argv.index('--') + 1:][0]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb)
ob = [o for o in bpy.context.scene.objects if o.type == 'MESH'][0]
me = ob.data
img = bpy.data.images[0]
W, H = img.size
px = np.array(img.pixels[:], dtype=np.float32).reshape(H, W, 4)
uv = me.uv_layers.active.data

n = len(me.vertices)
col = np.zeros((n, 3), np.float32)
seen = np.zeros(n, bool)
for loop in me.loops:
    vi = loop.vertex_index
    if seen[vi]:
        continue
    u, v = uv[loop.index].uv
    col[vi] = px[min(H - 1, max(0, int(v * H))), min(W - 1, max(0, int(u * W))), :3]
    seen[vi] = True
co = np.array([(v.co.x, v.co.z, -v.co.y) for v in me.vertices], np.float32)   # Blender (z 上) → glTF (y 上)
r, g, b = col.T

# 頭: 前の上側の頂点に球を当てはめる
x, y = co[:, 0], co[:, 1]
h = co[(x > x.max() - 0.2) & (y > y.min() + 0.26)]
sol = np.linalg.lstsq(np.c_[2 * h, np.ones(len(h))], (h ** 2).sum(1), rcond=None)[0]
center = sol[:3]
radius = math.sqrt(sol[3] + (center ** 2).sum())

# 口: 赤みのある色。顔の向きは、頭の中心から口の中心への向き（水平）
mouth = co[(r > 0.35) & (r - g > 0.18) & (r - b > 0.15)]
m = mouth.mean(0)
face_deg = math.degrees(math.atan2(-(m[2] - center[2]), m[0] - center[0]))

# 目: ほぼ黒。z で 2 つに分けて、それぞれの近くだけで中心を取り直す
dark = co[np.maximum(np.maximum(r, g), b) < 0.18]
zs = np.sort(dark[:, 2])
cut = (zs[np.argmax(np.diff(zs))] + zs[np.argmax(np.diff(zs)) + 1]) / 2
eyes = []
for part in (dark[dark[:, 2] < cut], dark[dark[:, 2] >= cut]):
    c = np.median(part, axis=0)
    for _ in range(3):
        sel = dark[np.linalg.norm(dark - c, axis=1) < 0.08]
        c = sel.mean(0)
    eyes.append({'center': c.round(4).tolist(), 'r90': round(float(np.percentile(np.linalg.norm(sel - c, axis=1), 90)), 4)})

print('LIDO_FIT ' + json.dumps({
    'head_center': center.round(4).tolist(),
    'head_radius': round(radius, 4),
    'face_deg_toward_minus_z': round(face_deg, 1),
    'mouth_y_range': [round(float(mouth[:, 1].min()), 3), round(float(mouth[:, 1].max()), 3)],
    'mouth_center': m.round(4).tolist(),
    'eyes': eyes,
}, ensure_ascii=False))
