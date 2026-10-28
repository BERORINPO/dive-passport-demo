/* 3D のウミガメ「リド」。three.js で描く。モデルに合わせた数値と頂点の動かし方は lido-fit.js にある。
   骨組みが無いので、頂点の位置をその場で計算して動かす（下あご・まばたき・頭・ひれ）。
   話すときは、音声の大きさで口を開ける。音声が無い・声がオフのときは、文の長さから作った波で動かす。
   声は ElevenLabs で先に作った mp3（audio/<key>.<lang>.mp3）を流すだけ。その場で声も文も作らない */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MODEL_URL, VIEW, UNIFORMS, DEFORM } from './lido-fit.js';

const R = window.REDUX;
const AUDIO_DIR = 'audio/';
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MS_PER_CHAR = { ja: 110, en: 60 };   // 声が無いときに口を動かす長さの目安
const MAX_TALK_MS = 9000;
const BLINK = { closeMs: 70, openMs: 110, minGapMs: 2200, extraGapMs: 3800, doubleRate: 0.2, doubleGapMs: 160 };

const TXT = {
  soundOn: { ja: '声を出す', en: 'Turn voice on' },
  soundOff: { ja: '声を止める', en: 'Turn voice off' }
};

const state = {
  talk: 0, target: 0, fakeStart: 0, fakeUntil: 0,
  soundOn: false, ctx: null, analyser: null, wave: null, audio: null,
  blinkStart: -1, blinkNext: 0
};

function patchMaterial(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = UNIFORMS.map((name) => `uniform float ${name};`).join('\n') + '\n' +
      shader.vertexShader.replace('#include <begin_vertex>', DEFORM);
  };
  material.needsUpdate = true;
}

/* まばたき: 数秒おきに目を閉じて開く。ときどき 2 回続ける */
function blinkLevel(now) {
  if (state.blinkStart < 0) {
    if (now < state.blinkNext) return 0;
    state.blinkStart = now;
  }
  const t = now - state.blinkStart;
  if (t < BLINK.closeMs) return t / BLINK.closeMs;
  if (t < BLINK.closeMs + BLINK.openMs) return 1 - (t - BLINK.closeMs) / BLINK.openMs;
  state.blinkStart = -1;
  state.blinkNext = now + (Math.random() < BLINK.doubleRate
    ? BLINK.doubleGapMs
    : BLINK.minGapMs + Math.random() * BLINK.extraGapMs);
  return 0;
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
    btn.innerHTML = state.soundOn ? ICON_ON : ICON_OFF; // arch-allow: 固定のアイコン
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
  const camera = new THREE.PerspectiveCamera(VIEW.fov, 2, 0.1, 20);
  camera.position.set(...VIEW.camera);
  camera.lookAt(...VIEW.target);
  scene.add(new THREE.HemisphereLight(0xe6f8ff, 0x1d4f5a, 1.7));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(0.8, 2, 1.4);
  scene.add(sun);

  const uniforms = Object.fromEntries(UNIFORMS.map((name) => [name, { value: 0 }]));
  uniforms.uSwim.value = REDUCED ? 0.3 : 1;
  const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
  const turtle = gltf.scene;
  turtle.traverse((o) => { if (o.isMesh) patchMaterial(o.material, uniforms); });
  const holder = new THREE.Group();
  holder.add(turtle);
  holder.rotation.y = VIEW.yaw;   // 顔をこちらへ向ける
  scene.add(holder);
  state.blinkNext = performance.now() + 1500;

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
  R.lidoSoundOn = () => state.soundOn;
  mount(document.getElementById('lido-stage'));

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    if (document.hidden || !stage || !stage.isConnected || stage.offsetParent === null) return;
    const t = clock.getElapsedTime();
    const now = performance.now();
    const swim = uniforms.uSwim.value;
    state.target = talkLevel(now);
    state.talk += (state.target - state.talk) * 0.3;
    uniforms.uTime.value = t;
    uniforms.uTalk.value = state.talk;
    uniforms.uBlink.value = blinkLevel(now);
    uniforms.uNod.value = state.talk * 0.12 + Math.sin(t * 1.3) * 0.035 * swim;
    uniforms.uYaw.value = Math.sin(t * 0.55) * 0.09 * swim;
    holder.position.y = Math.sin(t * 0.9) * 0.025 * swim;
    holder.rotation.z = Math.sin(t * 0.9 + 0.5) * 0.04 * swim + state.talk * 0.04;
    holder.rotation.x = Math.sin(t * 0.7) * 0.03 * swim;
    holder.scale.set(1 - state.talk * 0.012, 1 + state.talk * 0.025, 1 - state.talk * 0.012);
    renderer.render(scene, camera);
  });
}

start().catch((e) => {
  // モデルが読めないとき（ファイルが無い・壊れている）は 2D のリドのまま
  console.warn('lido 3d: not available', e && e.message);
});
