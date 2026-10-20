/* 3D のウミガメ「リド」。モデルは Tripo3D で作ったもの（骨組みなし）。three.js で描く。
   骨組みが無いので、頂点の位置をその場で計算して動かす（頭のうなずき・前ひれ・後ろひれ）。
   話すときは、音声の大きさで頭を動かす。音声が無い・声がオフのときは、文の長さから作った波で動かす。
   声は ElevenLabs で先に作った mp3（audio/<key>.<lang>.mp3）を流すだけ。その場で声も文も作らない */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const R = window.REDUX;
const MODEL_URL = 'assets/turtle.glb';
const AUDIO_DIR = 'audio/';
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MS_PER_CHAR = { ja: 110, en: 60 };   // 声が無いときに口を動かす長さの目安
const MAX_TALK_MS = 9000;

const TXT = {
  soundOn: { ja: '声を出す', en: 'Turn voice on' },
  soundOff: { ja: '声を止める', en: 'Turn voice off' }
};

const state = {
  talk: 0, target: 0, fakeStart: 0, fakeUntil: 0,
  soundOn: false, ctx: null, analyser: null, wave: null, audio: null
};

/* ---------- 頂点を動かす（頭は x が前、ひれは横 z と後ろ -x） ---------- */
const DEFORM = `
  vec3 transformed = vec3(position);
  float az = abs(transformed.z);
  float head = smoothstep(0.27, 0.36, transformed.x) * (1.0 - smoothstep(0.11, 0.17, az));
  float nod = (uTalk * 0.5 + sin(uTime * 1.3) * uSwim * 0.05) * head;
  vec2 hp = vec2(transformed.x - 0.30, transformed.y);
  transformed.x = 0.30 + hp.x * cos(nod) - hp.y * sin(nod);
  transformed.y = hp.x * sin(nod) + hp.y * cos(nod);
  float front = smoothstep(0.19, 0.27, az) * smoothstep(-0.12, 0.05, transformed.x);
  transformed.y += sin(uTime * 1.6) * (az - 0.19) * 0.9 * front * uSwim;
  float back = (1.0 - smoothstep(-0.34, -0.26, transformed.x)) * smoothstep(0.05, 0.12, az);
  transformed.y += sin(uTime * 2.2 + 1.0) * 0.025 * back * uSwim;
`;

function patchMaterial(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = 'uniform float uTime;\nuniform float uTalk;\nuniform float uSwim;\n' +
      shader.vertexShader.replace('#include <begin_vertex>', DEFORM);
  };
  material.needsUpdate = true;
}

/* ---------- 声 ---------- */
function stopAudio() {
  if (state.audio) {
    state.audio.pause();
    state.audio = null;
  }
}

function fakeTalk(text) {
  const per = MS_PER_CHAR[R.lang] || MS_PER_CHAR.en;
  const now = performance.now();
  state.fakeStart = now;
  state.fakeUntil = now + Math.min(MAX_TALK_MS, 400 + text.length * per);
}

function ensureAudioGraph() {
  if (state.ctx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  state.ctx = new Ctx();
  state.analyser = state.ctx.createAnalyser();
  state.analyser.fftSize = 512;
  state.wave = new Uint8Array(state.analyser.fftSize);
  state.analyser.connect(state.ctx.destination);
}

function speak(key, text) {
  stopAudio();
  state.fakeUntil = 0;
  if (!state.soundOn || !state.ctx) { fakeTalk(text); return; }
  const audio = new Audio(`${AUDIO_DIR}${key}.${R.lang === 'ja' ? 'ja' : 'en'}.mp3`);
  state.audio = audio;
  const fallback = () => { if (state.audio === audio) { state.audio = null; fakeTalk(text); } };
  audio.addEventListener('error', fallback, { once: true });
  audio.addEventListener('ended', () => { if (state.audio === audio) state.audio = null; }, { once: true });
  try {
    state.ctx.createMediaElementSource(audio).connect(state.analyser);
  } catch (e) {
    // 音の大きさが取れなくても、声だけは流す
  }
  audio.play().catch(fallback);
}

function talkLevel(now) {
  if (state.audio && state.analyser && !state.audio.paused) {
    state.analyser.getByteTimeDomainData(state.wave);
    let sum = 0;
    for (let i = 0; i < state.wave.length; i += 1) {
      const v = (state.wave[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.max(0, (Math.sqrt(sum / state.wave.length) - 0.02) * 6));
  }
  if (now < state.fakeUntil) {
    const t = now - state.fakeStart;
    return Math.max(0, 0.45 + 0.4 * Math.sin(t * 0.019) * Math.sin(t * 0.0071 + 0.6));
  }
  return 0;
}

/* ---------- 描く ---------- */
/* スピーカーの絵（自作）。音が出ていないときは ×、出ているときは音の波 */
const SPEAKER = '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/>';
const ICON_OFF = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${SPEAKER}` +
  '<path d="M15.5 9.5l5 5M20.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_ON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${SPEAKER}` +
  '<path d="M15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

function soundButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lido-sound';
  const label = () => {
    const text = R.L(state.soundOn ? TXT.soundOff : TXT.soundOn);
    btn.innerHTML = state.soundOn ? ICON_ON : ICON_OFF;
    btn.setAttribute('aria-label', text);
    btn.title = text;
    btn.setAttribute('aria-pressed', String(state.soundOn));
  };
  btn.addEventListener('click', () => {
    state.soundOn = !state.soundOn;
    if (state.soundOn) {
      ensureAudioGraph();
      if (state.ctx && state.ctx.state === 'suspended') state.ctx.resume();
      speak('greet', R.L(R.T.greet));
    } else {
      stopAudio();
    }
    label();
  });
  R.onLang(label);
  label();
  return btn;
}

async function start() {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (e) {
    return;   // WebGL が使えない端末。2D のリドのまま
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 2, 0.1, 20);
  camera.position.set(0.05, 0.66, 1.62);
  camera.lookAt(0, -0.05, 0);
  scene.add(new THREE.HemisphereLight(0xe6f8ff, 0x1d4f5a, 1.7));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(0.8, 2, 1.4);
  scene.add(sun);

  const uniforms = { uTime: { value: 0 }, uTalk: { value: 0 }, uSwim: { value: REDUCED ? 0.3 : 1 } };
  const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
  const turtle = gltf.scene;
  turtle.traverse((o) => { if (o.isMesh) patchMaterial(o.material, uniforms); });
  const holder = new THREE.Group();
  holder.add(turtle);
  holder.rotation.y = -0.95;   // 頭（+x）をこちらへ向ける
  scene.add(holder);

  const button = soundButton();
  let stage = null;
  const mount = (el) => {
    if (!el) return;
    stage = el;
    stage.append(renderer.domElement, button);
    stage.classList.add('is-ready');
    document.getElementById('chat').classList.add('has-3d');
    resize();
  };
  function resize() {
    if (!stage) return;
    const w = stage.clientWidth || 300;
    const h = stage.clientHeight || 170;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(document.getElementById('chat'));
  R.mountLido = mount;
  R.lidoSpeak = speak;
  mount(document.getElementById('lido-stage'));

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    if (document.hidden || !stage || !stage.isConnected || stage.offsetParent === null) return;
    const t = clock.getElapsedTime();
    const swim = uniforms.uSwim.value;
    state.target = talkLevel(performance.now());
    state.talk += (state.target - state.talk) * 0.3;
    uniforms.uTime.value = t;
    uniforms.uTalk.value = state.talk;
    holder.position.y = Math.sin(t * 0.9) * 0.025 * swim;
    holder.rotation.z = Math.sin(t * 0.9 + 0.5) * 0.05 * swim + state.talk * 0.04;
    holder.rotation.x = Math.sin(t * 0.7) * 0.04 * swim;
    renderer.render(scene, camera);
  });
}

start().catch((e) => {
  // モデルが読めないとき（ファイルが無い・壊れている）は 2D のリドのまま
  console.warn('lido 3d: not available', e && e.message);
});
