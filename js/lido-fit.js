/* リドの 3D モデル（assets/turtle.glb）に合わせた数値と、頂点を動かす計算。
   モデルは Higgsfield で描いた絵（gpt_image_2_5）を Tripo H3.1 で 3D にしたもの。骨組みは無い。
   モデルを作り直したら、このファイルだけ合わせ直す。数値は tools/measure-lido.py で測る。

   座標はモデルのまま（x が前、y が上）。顔は絵が斜め向きだったので、前（+x）から -z 側へ約 35° 向いている。
   口と目は絵（テクスチャ）で、口の部分は少しくぼんでいる */
export const MODEL_URL = 'assets/turtle.glb';

/* 顔がカメラを向くように回す角度と、カメラの位置 */
export const VIEW = {
  yaw: -2.05,
  fov: 30,
  camera: [0, 0.42, 2.05],
  target: [0, -0.02, 0]
};

export const UNIFORMS = ['uTime', 'uTalk', 'uSwim', 'uBlink', 'uNod', 'uYaw'];

/* 頂点を動かす順番: まばたき → 下あご → 頭（首を軸に上下、頭の中心を軸に左右） → ひれ */
export const DEFORM = `
  const vec3 HEAD_C = vec3(0.3005, 0.1139, 0.0183);
  const float HEAD_R = 0.194;
  const vec2 FACE = vec2(0.809, -0.588);
  const vec2 SIDE = vec2(0.588, 0.809);
  const float MOUTH_Y = 0.034;
  const vec3 EYE_A = vec3(0.3555, 0.1273, -0.1836);
  const vec3 EYE_B = vec3(0.4827, 0.0954, 0.0810);
  const float EYE_R = 0.06;
  const vec2 NECK = vec2(0.27, -0.04);

  vec3 transformed = vec3(position);
  float dHead = distance(position, HEAD_C);

  float ea = 1.0 - smoothstep(EYE_R * 1.05, EYE_R * 1.7, distance(position, EYE_A));
  float eb = 1.0 - smoothstep(EYE_R * 1.05, EYE_R * 1.7, distance(position, EYE_B));
  transformed.y -= (transformed.y - EYE_A.y) * uBlink * 0.9 * ea;
  transformed.y -= (transformed.y - EYE_B.y) * uBlink * 0.9 * eb;

  vec3 d = transformed - HEAD_C;
  float f = dot(d.xz, FACE);
  float s = dot(d.xz, SIDE);
  float jaw = (1.0 - smoothstep(HEAD_R, HEAD_R * 1.1, dHead))
    * smoothstep(0.0, 0.06, f)
    * (1.0 - smoothstep(0.05, 0.13, abs(s)))
    * (1.0 - smoothstep(MOUTH_Y - 0.012, MOUTH_Y + 0.004, transformed.y));
  float open = -uTalk * 0.42 * jaw;
  vec2 q = vec2(f - 0.02, transformed.y - MOUTH_Y);
  f = 0.02 + q.x * cos(open) - q.y * sin(open);
  transformed.y = MOUTH_Y + q.x * sin(open) + q.y * cos(open);
  transformed.xz = HEAD_C.xz + FACE * f + SIDE * s;

  float head = 1.0 - smoothstep(HEAD_R * 1.02, HEAD_R * 1.22, dHead);
  float yaw = uYaw * head;
  vec2 hz = transformed.xz - HEAD_C.xz;
  transformed.xz = HEAD_C.xz + vec2(hz.x * cos(yaw) - hz.y * sin(yaw), hz.x * sin(yaw) + hz.y * cos(yaw));
  float nod = uNod * head;
  vec2 hp = transformed.xy - NECK;
  transformed.xy = NECK + vec2(hp.x * cos(nod) - hp.y * sin(nod), hp.x * sin(nod) + hp.y * cos(nod));

  float az = abs(position.z);
  float front = smoothstep(0.24, 0.32, az) * smoothstep(0.12, 0.18, position.x) * (1.0 - smoothstep(-0.05, 0.0, position.y));
  float fa = sin(uTime * 1.6) * 0.32 * front * uSwim;
  vec2 fp = vec2(abs(transformed.z) - 0.24, transformed.y + 0.21);
  transformed.z = sign(transformed.z) * (0.24 + fp.x * cos(fa) - fp.y * sin(fa));
  transformed.y = fp.x * sin(fa) + fp.y * cos(fa) - 0.21;
  float back = (1.0 - smoothstep(-0.30, -0.24, position.x)) * smoothstep(0.22, 0.30, az) * (1.0 - smoothstep(-0.17, -0.14, position.y));
  transformed.y += sin(uTime * 2.2 + 1.0) * 0.02 * back * uSwim;
`;
