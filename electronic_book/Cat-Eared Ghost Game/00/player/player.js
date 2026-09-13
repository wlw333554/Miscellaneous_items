/* ねこみみおばけっこ MIDI Player
 * FluidSynth WASM (js-synthesizer) + custom SF2 (00/MIDI/NEKOMIMI.SF2)
 * UI: play/pause + seekable progress bar + time, auto-loop
 */
(function () {
  'use strict';

  // ---- locate this script's base URL ----
  var BASE = (function () {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      var src = scripts[i].getAttribute('src') || '';
      if (/(^|\/)player\.js(\?|$)/.test(src)) {
        return src.replace(/player\.js(\?.*)?$/, '');
      }
    }
    return './player/';
  })();
  var SF2_URL = BASE + '../MIDI/NEKOMIMI.SF2';
  var LIB_FLUID = BASE + 'libfluidsynth-2.4.6.js';
  var LIB_SYNTH = BASE + 'js-synthesizer.min.js';

  // ---- style ----
  var css = [
    '.nm-p{display:inline-flex;align-items:center;gap:8px;background:#fff;',
    'border:2px solid #e898ac;border-radius:16px;padding:4px 12px 4px 6px;',
    'box-shadow:1px 2px 0 rgba(0,0,0,.10);margin:4px 0 8px 4px;',
    'font:12px/1 Consolas,monospace;color:#7a4450;user-select:none;}',
    '.nm-btn{width:28px;height:28px;border-radius:50%;border:2px solid #e898ac;',
    'background:#fdd9dd;color:#c81e32;font-size:12px;line-height:1;cursor:pointer;',
    'padding:0;flex:none;}',
    '.nm-btn:hover{background:#fbc9d4;}',
    '.nm-btn:disabled{opacity:.45;cursor:wait;}',
    '.nm-bar{position:relative;width:150px;height:10px;background:#f3c3cd;',
    'border-radius:5px;cursor:pointer;overflow:hidden;flex:none;}',
    '.nm-fill{position:absolute;left:0;top:0;bottom:0;width:0;',
    'background:#e0455f;border-radius:5px;}',
    '.nm-time{white-space:nowrap;min-width:74px;text-align:right;}',
    '.nm-err{color:#c81e32;}'
  ].join('');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ---- library loading (shared) ----
  var libPromise = null;
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function ensureLibs() {
    if (!libPromise) {
      libPromise = loadScript(LIB_FLUID)
        .then(function () { return loadScript(LIB_SYNTH); })
        .then(function () { return window.JSSynth.waitForReady(); });
    }
    return libPromise;
  }
  function fetchBuf(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
      return r.arrayBuffer();
    });
  }

  // ---- helpers ----
  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function Player(el) {
    this.el = el;
    this.midiUrl = el.getAttribute('data-midi');
    this.sf2Url = el.getAttribute('data-sfont') || SF2_URL;
    this.ready = false;
    this.playing = false;
    this.pausedTick = null;
    this.totalTicks = 0;
    this.division = 480;
    this.bpm = 120;
    this.lastBpmAt = 0;
    this.buildUI();
    this.init();
  }

  Player.prototype.buildUI = function () {
    var self = this;
    var root = document.createElement('div');
    root.className = 'nm-p';
    this.btn = document.createElement('button');
    this.btn.className = 'nm-btn';
    this.btn.disabled = true;
    this.btn.textContent = '\u25B6'; // play
    this.btn.title = '\u518d\u751f / \u505c\u6b62';
    this.fill = document.createElement('div');
    this.fill.className = 'nm-fill';
    this.bar = document.createElement('div');
    this.bar.className = 'nm-bar';
    this.bar.appendChild(this.fill);
    this.time = document.createElement('span');
    this.time.className = 'nm-time';
    this.time.textContent = '-:-- / -:--';
    root.appendChild(this.btn);
    root.appendChild(this.bar);
    root.appendChild(this.time);
    this.el.appendChild(root);
    this.el._nmPlayer = this;

    this.btn.addEventListener('click', function () { self.toggle(); });

    var seeking = false;
    function posFromEvent(ev) {
      var r = self.bar.getBoundingClientRect();
      var x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      return Math.max(0, Math.min(1, x / r.width));
    }
    function applyPreview(p) {
      self.fill.style.width = (p * 100) + '%';
      self.time.textContent = fmt(self.tickToSec(p * self.totalTicks)) +
        ' / ' + fmt(self.tickToSec(self.totalTicks));
    }
    function onDown(ev) {
      if (!self.ready) return;
      seeking = true;
      applyPreview(posFromEvent(ev));
      ev.preventDefault();
    }
    function onMove(ev) {
      if (seeking) applyPreview(posFromEvent(ev));
    }
    function onUp(ev) {
      if (!seeking) return;
      seeking = false;
      var p = posFromEvent(ev.changedTouches ? { clientX: ev.changedTouches[0].clientX } : ev);
      var tick = Math.round(p * self.totalTicks);
      if (self.playing) {
        self.synth.seekPlayer(tick);
      } else {
        self.pausedTick = tick;
      }
      applyPreview(p);
    }
    this.bar.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    this.bar.addEventListener('touchstart', onDown, { passive: false });
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onUp);
  };

  Player.prototype.tickToSec = function (tick) {
    return tick / this.division * (60 / (this.bpm || 120));
  };

  Player.prototype.init = function () {
    var self = this;
    ensureLibs().then(function () {
      return Promise.all([fetchBuf(self.sf2Url), fetchBuf(self.midiUrl)]);
    }).then(function (bufs) {
      var sf2 = bufs[0], smf = bufs[1];
      var u8 = new Uint8Array(smf);
      if (u8.length > 14 && u8[12] < 0x80) {
        self.division = (u8[12] << 8) | u8[13];
      }
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx = new Ctx();
      self.ctx = ctx;
      var synth = new JSSynth.Synthesizer();
      synth.init(ctx.sampleRate);
      self.node = synth.createAudioNode(ctx, 2048);
      self.node.connect(ctx.destination);
      self.synth = synth;
      return synth.loadSFont(sf2).then(function () {
        return synth.addSMFDataToPlayer(smf);
      }).then(function () {
        synth.setPlayerLoop(-1); // infinite loop (original embed: loop=true)
        return synth.retrievePlayerTotalTicks();
      }).then(function (total) {
        self.totalTicks = total;
        self.ready = true;
        self.btn.disabled = false;
        self.tryAutostart();
      });
    }).catch(function (e) {
      console.error('[nm-player]', e);
      self.time.className = 'nm-time nm-err';
      self.time.textContent = 'ERROR';
      self.btn.disabled = true;
    });
  };

  Player.prototype.tryAutostart = function () {
    var self = this;
    if (!this.ctx) return;
    this.ctx.resume().then(function () {
      if (self.ctx.state === 'running') {
        return self.synth.playPlayer().then(function () {
          self.playing = true;
          self.btn.textContent = '\u23F8'; // pause
          self.loop();
        });
      }
    }).catch(function () { /* stay paused until user clicks */ });
  };

  Player.prototype.toggle = function () {
    var self = this;
    if (!this.ready) return;
    if (this.playing) {
      // pause
      this.playing = false;
      this.btn.textContent = '\u25B6';
      this.synth.retrievePlayerCurrentTick().then(function (t) {
        self.pausedTick = t;
        self.synth.stopPlayer();
      });
    } else {
      // play / resume
      this.ctx.resume().then(function () {
        return self.synth.playPlayer();
      }).then(function () {
        if (self.pausedTick != null) {
          self.synth.seekPlayer(self.pausedTick);
        }
        self.playing = true;
        self.btn.textContent = '\u23F8';
        self.loop();
      }).catch(function (e) {
        console.error('[nm-player]', e);
      });
    }
  };

  Player.prototype.loop = function () {
    var self = this;
    if (this.raf) cancelAnimationFrame(this.raf);
    function step() {
      if (!self.playing) { self.raf = null; return; }
      self.synth.retrievePlayerCurrentTick().then(function (t) {
        if (self.totalTicks > 0) {
          var p = Math.max(0, Math.min(1, t / self.totalTicks));
          self.fill.style.width = (p * 100) + '%';
        }
        self.raf = requestAnimationFrame(step);
      });
    }
    this.raf = requestAnimationFrame(step);
    // time text refresh + bpm/total poll (created only once)
    // note: totalTicks is only available after the player has started once
    if (!this.timer) {
      this.timer = setInterval(function () {
        self.synth.retrievePlayerTotalTicks().then(function (tt) {
          if (tt > 0) self.totalTicks = tt;
        }).catch(function () { /* ignore */ });
        if (!self.playing) return;
        self.synth.retrievePlayerCurrentTick().then(function (t) {
          self.time.textContent = fmt(self.tickToSec(t)) + ' / ' +
            fmt(self.tickToSec(self.totalTicks));
        });
        self.synth.retrievePlayerBpm().then(function (bpm) {
          if (bpm > 0) self.bpm = bpm;
        }).catch(function () { /* keep last bpm */ });
      }, 500);
    }
  };

  // ---- boot ----
  function boot() {
    var els = document.querySelectorAll('.nm-player, [data-midi].midiplayer');
    for (var i = 0; i < els.length; i++) {
      if (!els[i]._nmPlayer) new Player(els[i]);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
