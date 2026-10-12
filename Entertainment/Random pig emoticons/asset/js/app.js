// 随机猪猪 —— 纯前端 7z 解压 + 随机抽图
import { Archive } from './libarchive.js';

// 让 libarchive 的 worker 与 wasm 都从本目录加载（同源即可，无需 CDN）
Archive.init({ workerUrl: new URL('./worker-bundle.js', import.meta.url).href });

const IMG_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];

const els = {
  btn:       document.getElementById('rollBtn'),
  wrap:      document.getElementById('progressWrap'),
  bar:       document.getElementById('bar'),
  barFill:   document.getElementById('barFill'),
  status:    document.getElementById('statusText'),
  steps:     Array.from(document.querySelectorAll('.step')),
  img:       document.getElementById('pigImage'),
  placeholder: document.getElementById('placeholder'),
  meta:      document.getElementById('meta'),
};

let currentURL = null;   // 当前显示的 object URL，切换时回收
let running = false;

/* ---------- 进度条动画 ---------- */
let barValue = 0;
let creepTimer = null;

function setBar(v) {
  barValue = Math.max(0, Math.min(100, v));
  els.barFill.style.width = barValue + '%';
}

// 解压阶段没有真实“百分比”，用一个缓慢爬升的小动画表示正在忙
function startCreep(cap) {
  stopCreep();
  creepTimer = setInterval(() => {
    if (barValue < cap) setBar(barValue + Math.random() * 2.2 + 0.4);
  }, 120);
}
function stopCreep() {
  if (creepTimer) { clearInterval(creepTimer); creepTimer = null; }
}

function setStep(n, state) {
  const el = els.steps.find(s => +s.dataset.step === n);
  if (!el) return;
  el.classList.remove('active', 'done');
  if (state) el.classList.add(state);
}

function setStatus(text, cls) {
  els.status.className = 'status' + (cls ? ' ' + cls : '');
  els.status.textContent = text;
}

/* ---------- 工具函数 ---------- */
async function loadArchiveList() {
  // 从清单读取 7z 列表；拿不到就回退到默认文件
  try {
    const r = await fetch('asset/pic/archives.json', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.archives) && j.archives.length) return j.archives;
    }
  } catch (_) { /* ignore */ }
  return ['pig-1.7z'];
}

// 流式下载，带真实字节进度（映射到 0~40%）
async function download7z(name) {
  const res = await fetch('asset/pic/' + encodeURIComponent(name), { cache: 'no-store' });
  if (!res.ok) throw new Error('下载失败（HTTP ' + res.status + '）');
  const total = +res.headers.get('Content-Length') || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const pct = total ? (received / total) : (received / (received + 1e6)); // 无长度时给个伪进度
    setBar(pct * 40);
    setStatus('正在加载 7z 压缩包… ' + Math.floor(pct * 100) + '%');
  }

  const buf = new Uint8Array(received);
  let pos = 0;
  for (const c of chunks) { buf.set(c, pos); pos += c.length; }
  return buf;
}

// 递归收集压缩包里的图片文件（extractFiles 返回的对象：目录是普通 object，文件是 File 实例）
function collectImages(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node instanceof File) {
    const name = (node.name || '').toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';
    if (IMG_EXT.includes(ext)) out.push({ file: node, name: node.name, ext });
    return;
  }
  // 目录：遍历子项继续递归
  for (const key of Object.keys(node)) collectImages(node[key], out);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* ---------- 主流程 ---------- */
async function roll() {
  if (running) return;
  running = true;
  els.btn.disabled = true;
  els.wrap.hidden = false;
  els.bar.classList.remove('error');
  setStatus('准备中…');
  setBar(2);
  els.steps.forEach(s => { s.classList.remove('active', 'done'); });

  let archiveName = '';
  try {
    // —— 阶段 1：随机选一个 7z 并下载 ——
    const list = await loadArchiveList();
    archiveName = pickRandom(list);
    setStep(1, 'active');
    const bytes = await download7z(archiveName);
    setBar(40);
    setStep(1, 'done');

    // —— 阶段 2：解压 ——
    setStep(2, 'active');
    setStatus('正在解压 ' + archiveName + ' …');
    startCreep(82);
    // 关键：必须传 Blob/File 给 Archive.open（传 Uint8Array 会被 Comlink 卡死）
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const archive = await Archive.open(blob);
    const tree = await archive.extractFiles();
    await archive.close();
    stopCreep();
    setBar(86);
    setStep(2, 'done');

    // —— 阶段 3：随机挑选一张图片 ——
    setStep(3, 'active');
    setStatus('正在随机挑选猪猪…');
    const images = [];
    collectImages(tree, images);
    if (!images.length) throw new Error('压缩包里没有找到图片（jpg/png/webp…）');

    const choice = pickRandom(images);
    const url = URL.createObjectURL(choice.file);
    if (currentURL) URL.revokeObjectURL(currentURL);
    currentURL = url;

    els.img.src = url;
    els.img.hidden = false;
    els.placeholder.hidden = true;
    setBar(100);
    setStep(3, 'done');
    setStatus('完成 🎉 抽到了一只猪猪！', 'ok');

    const fmt = choice.ext.toUpperCase();
    els.meta.innerHTML = '来自 <b>' + archiveName + '</b> · 共 <b>' + images.length +
      '</b> 张可选 · 格式 <b>' + fmt + '</b>';
  } catch (err) {
    stopCreep();
    els.bar.classList.add('error');
    setStatus('出错了：' + (err && err.message ? err.message : err), 'error');
    els.steps.forEach(s => { if (!s.classList.contains('done')) s.classList.remove('active'); });
    console.error(err);
  } finally {
    running = false;
    els.btn.disabled = false;
  }
}

els.btn.addEventListener('click', roll);
