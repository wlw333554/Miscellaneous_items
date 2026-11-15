/**
 * audio-to-opus.app.js —— 本页面的 UI 逻辑（文件列表、设置、下载），转码能力来自 opus-transcoder.js
 */
(function () {
  'use strict';

  // 转码库未加载时给出可见提示并停用（正常情况下由页面的启动自检兜底）
  if (typeof OpusTranscoder === 'undefined') {
    document.addEventListener('DOMContentLoaded', function () {
      var b = document.createElement('div');
      b.style.cssText = 'margin:18px 0;padding:14px 18px;border:1px solid #f3c8c4;background:#fffbfa;' +
        'color:#c5221f;border-radius:12px;font-size:14px;line-height:1.8';
      b.innerHTML = '<b>⚠ 转码库 opus-transcoder.js 未加载：</b>请确认它与本页面在同一目录。';
      (document.querySelector('.wrap') || document.body).insertBefore(b, document.body.firstChild);
    });
    return;
  }

  var $ = function (id) { return document.getElementById(id); };
  var drop = $('drop'), picker = $('picker'), listEl = $('list'), totalsEl = $('totals');
  var startBtn = $('start'), dlAllBtn = $('downloadAll'), clearBtn = $('clear'), tip = $('tip');
  var engineBox = $('engine'), engineText = $('engineText'), enginePct = $('enginePct'), engineBar = $('engineBar');
  var bitrateInput = $('bitrate'), channelsSel = $('channels'), metaChk = $('meta'), voipChk = $('voip'), frameSel = $('frameMs');

  var EXT_RE = /\.(flac|mp3|m4a|wav|aac|ogg|oga|opus|wma|aiff?|mp4|m4b)$/i;
  var items = [];
  var busy = false;

  var transcoder = new OpusTranscoder();

  function fmtSize(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }
  function fmtDur(s) {
    if (!s || !isFinite(s)) return '—';
    var m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }
  function baseName(name) { return name.replace(/\.[^.]+$/, ''); }

  function uniqueName(name) {
    var used = {};
    items.forEach(function (it) { if (it.outName) used[it.outName] = true; });
    if (!used[name]) { used[name] = true; return name; }
    var b = baseName(name), i = 2;
    while (used[b + '-' + i + '.opus']) i++;
    return b + '-' + i + '.opus';
  }

  function readOptions() {
    return {
      channels: channelsSel.value,            // 'keep' | '1' | '2'
      bitrate: Math.max(6, Math.min(510, parseInt(bitrateInput.value, 10) || 32)),
      frameMs: parseInt(frameSel.value, 10) || 60,
      voip: voipChk.checked,
      keepMeta: metaChk.checked
    };
  }

  /* ---------------- 文件列表 ---------------- */
  function addFiles(fileList) {
    var added = 0;
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      if (!f) continue;
      if (!EXT_RE.test(f.name) && !/^audio\//.test(f.type || '')) continue;
      var it = { id: ++uid, file: f, name: f.name, size: f.size,
                 status: 'pending', outBlob: null, outName: null, outSize: null, err: null, dur: null, prog: 0, phaseLabel: '' };
      items.push(it);
      renderItem(it);
      added++;
    }
    refresh();
    if (added && !busy) startAll();
  }
  var uid = 0;

  function renderItem(it) {
    var el = document.createElement('div');
    el.className = 'file';
    el.innerHTML =
      '<div class="name"></div>' +
      '<div class="right">' +
        '<button class="btn btn-ghost btn-sm dl" disabled>下载</button>' +
        '<button class="rm" title="移除">×</button>' +
      '</div>' +
      '<div class="meta"></div>' +
      '<div></div>' +
      '<div class="pbar hide"><div class="bar"><i></i></div></div>';
    el.querySelector('.name').textContent = it.name;
    el.querySelector('.rm').onclick = function () { if (!busy) removeItem(it); };
    el.querySelector('.dl').onclick = function () { saveItem(it); };
    it.el = el;
    it.metaEl = el.querySelector('.meta');
    it.dlBtn = el.querySelector('.dl');
    it.pbar = el.querySelector('.pbar');
    it.barFill = el.querySelector('.pbar i');
    listEl.appendChild(el);
    paintMeta(it);
  }

  function paintMeta(it) {
    var parts = [];
    parts.push('<span>' + fmtSize(it.size) + '</span>');
    if (it.dur) parts.push('<span>' + fmtDur(it.dur) + '</span>');
    if (it.status === 'pending') parts.push('<span class="warn">待转换</span>');
    if (it.status === 'running') parts.push('<span>' + (it.phaseLabel || '转换中') + ' ' + Math.round(it.prog * 100) + '%</span>');
    if (it.status === 'done') {
      parts.push('<span class="ok">✓ ' + fmtSize(it.outSize) + '</span>');
      var ratio = it.size > 0 ? (1 - it.outSize / it.size) : 0;
      if (ratio > 0) parts.push('<span class="ok">缩小 ' + (ratio * 100).toFixed(1) + '%</span>');
      if (it.dur && it.outSize) parts.push('<span>实际 ' + ((it.outSize * 8 / it.dur) / 1000).toFixed(1) + ' kbps</span>');
    }
    if (it.status === 'error') parts.push('<span class="err">✕ ' + (it.err || '转换失败') + '</span>');
    it.metaEl.innerHTML = parts.join('');
    var running = it.status === 'running';
    it.pbar.classList.toggle('hide', !running);
    it.barFill.style.width = Math.max(3, Math.round(it.prog * 100)) + '%';
    it.dlBtn.disabled = it.status !== 'done';
    it.el.className = 'file' + (it.status === 'done' ? ' done' : it.status === 'error' ? ' fail' : '');
  }

  function removeItem(it) {
    var i = items.indexOf(it);
    if (i >= 0) items.splice(i, 1);
    if (it.el && it.el.parentNode) it.el.parentNode.removeChild(it.el);
    refresh();
  }

  function refresh() {
    var n = items.length, done = 0;
    items.forEach(function (x) { if (x.status === 'done') done++; });
    startBtn.disabled = busy || n === 0;
    clearBtn.disabled = busy || n === 0;
    dlAllBtn.disabled = busy || done === 0;
    startBtn.textContent = busy ? '转换中…' : (n > 0 && done === n ? '重新转换' : '开始转换');
    tip.textContent = n === 0 ? '先添加文件'
      : (busy ? '正在处理，请勿关闭页面' : (done === n ? '全部完成 ✓' : n + ' 个文件'));
    var inSum = 0, outSum = 0;
    items.forEach(function (x) { inSum += x.size || 0; if (x.status === 'done') outSum += x.outSize || 0; });
    if (done > 0) {
      totalsEl.className = 'totals show';
      totalsEl.innerHTML = '原始合计 <b>' + fmtSize(inSum) + '</b> → 已转换 <b>' + fmtSize(outSum) + '</b>，节省 <b>' + fmtSize(inSum - outSum) + '</b>' +
        (inSum ? '（压缩到原来的 <b>' + (outSum / inSum * 100).toFixed(1) + '%</b>）' : '');
    } else {
      totalsEl.className = 'totals';
    }
  }

  /* ---------------- 转换 ---------------- */
  function showEngine(text, pct) {
    engineBox.classList.add('show');
    engineText.textContent = text;
    if (pct != null) {
      enginePct.textContent = Math.round(pct * 100) + '%';
      engineBar.style.width = Math.round(pct * 100) + '%';
    }
  }
  function hideEngine() { engineBox.classList.remove('show'); }

  async function startAll() {
    if (busy || items.length === 0) return;
    busy = true; refresh();
    try {
      await transcoder.load(function (p) { showEngine(p.text, p.pct); });
    } catch (e) {
      showEngine('引擎加载失败：' + (e && e.message || e), 0);
      busy = false; refresh();
      return;
    }
    hideEngine();
    var allDone = items.length > 0 && items.every(function (x) { return x.status === 'done'; });
    var list = allDone ? items.slice()
                       : items.filter(function (x) { return x.status === 'pending' || x.status === 'error'; });
    for (var j = 0; j < list.length; j++) await convertOne(list[j]);
    busy = false;
    refresh();
  }

  async function convertOne(it) {
    it.status = 'running'; it.prog = 0; it.err = null; it.phaseLabel = '准备中';
    paintMeta(it); refresh();

    var opts = readOptions();
    try {
      var r = await transcoder.convert(it.file, opts, function (p) {
        it.phaseLabel = p.phase === 'decode' ? '解码中' : '编码中';
        it.prog = p.ratio;
        paintMeta(it);
      });
      it.outBlob = r.blob;
      it.outSize = r.bytes;
      it.dur = r.duration || it.dur;
      it.outName = uniqueName(r.name || (baseName(it.name) + '.opus'));
      it.status = 'done';
      it.prog = 1;
    } catch (e) {
      it.status = 'error';
      it.err = (e && e.message) ? String(e.message).replace(/^Error:\s*/, '') : '未知错误';
    } finally {
      paintMeta(it);
      refresh();
    }
  }

  /* ---------------- 下载 ---------------- */
  function saveItem(it) {
    if (!it.outBlob) return;
    var a = document.createElement('a');
    a.href = URL.createObjectURL(it.outBlob);
    a.download = it.outName;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  /* ---- 极简 ZIP（store 模式） ---- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function makeZip(entries) {
    var enc = new TextEncoder();
    var chunks = [], central = [], offset = 0;
    entries.forEach(function (e) {
      var nameBytes = enc.encode(e.name);
      var crc = crc32(e.data);
      var local = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, e.data.length, true);
      dv.setUint32(22, e.data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);
      chunks.push(local, e.data);
      var cen = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, e.data.length, true);
      cv.setUint32(24, e.data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      central.push(cen);
      offset += local.length + e.data.length;
    });
    var cenSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cenSize, true);
    ev.setUint32(16, offset, true);
    return new Blob(chunks.concat(central, [end]), { type: 'application/zip' });
  }

  async function downloadAll() {
    var done = items.filter(function (x) { return x.status === 'done'; });
    if (!done.length) return;
    var entries = [];
    for (var i = 0; i < done.length; i++) {
      entries.push({ name: done[i].outName, data: new Uint8Array(await done[i].outBlob.arrayBuffer()) });
    }
    var zip = makeZip(entries);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(zip);
    a.download = 'opus-' + new Date().toISOString().slice(0, 10) + '.zip';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  /* ---------------- 事件 ---------------- */
  drop.addEventListener('click', function () { if (!busy) picker.click(); });
  drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } });
  picker.addEventListener('change', function () { addFiles(picker.files); picker.value = ''; });
  ['dragenter', 'dragover'].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); e.stopPropagation(); drop.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); e.stopPropagation(); drop.classList.remove('drag'); });
  });
  drop.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  var presetBtns = document.querySelectorAll('#presets button');
  Array.prototype.forEach.call(presetBtns, function (b) {
    b.addEventListener('click', function () {
      Array.prototype.forEach.call(presetBtns, function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      var br = b.getAttribute('data-br');
      if (br !== '0') bitrateInput.value = br; else bitrateInput.focus();
    });
  });
  bitrateInput.addEventListener('input', function () {
    var v = bitrateInput.value;
    Array.prototype.forEach.call(presetBtns, function (x) {
      x.classList.toggle('on', x.getAttribute('data-br') === v);
    });
  });

  startBtn.addEventListener('click', startAll);
  clearBtn.addEventListener('click', function () {
    if (busy) return;
    items = [];
    listEl.innerHTML = '';
    refresh();
  });
  dlAllBtn.addEventListener('click', downloadAll);

  // 空闲时预加载引擎
  if ('requestIdleCallback' in window) {
    requestIdleCallback(function () { transcoder.load().catch(function () {}); }, { timeout: 4000 });
  } else {
    setTimeout(function () { transcoder.load().catch(function () {}); }, 2500);
  }

  // 供自动化测试使用
  window.__opusApp = {
    addFiles: addFiles,
    items: function () { return items; },
    loadEngine: function () { return transcoder.load(function (p) { showEngine(p.text, p.pct); }); },
    startAll: startAll,
    isReady: function () { return transcoder.isReady(); },
    debugLog: function () { return transcoder.debugLog(); },
    options: readOptions
  };
})();
