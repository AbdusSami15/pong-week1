(() => {
  const CONFIG = {
    world: { w: 800, h: 450 },
    paddle: { w: 16, h: 90, speed: 520 },
    ball: { r: 10, speed: 420, maxSpeed: 900, speedUpPerHit: 18 },
    ai: { followSpeed: 420, deadZone: 14 },
    net: { dash: 14, gap: 10, w: 4 },
    scoreToWin: 7,
    bounce: { maxAngleDeg: 55, spinFactor: 0.18 },
    match: { durationSeconds: 9 * 60 },
    colors: {
      outerBg: "#0a0e16",
      innerBg: "#0e1422",
      fg: "#e9f1ff",
      net: "rgba(233,241,255,0.45)",
      scoreL: "#6ee7b7",
      scoreR: "#fca5a5",
      barL: "linear-gradient(90deg, #22c55e, #16a34a)",
        barR: "#7c3aed",
        frame: "rgba(236, 72, 153, 0.35)"
    },
      view: {
        // Dynamic padding around the world to keep consistent margins/letterboxing
        padScaleX: 0.01, // 1% of width
        padScaleY: 0.01, // 1% of height (below HUD)
        minPadX: 4,
        minPadY: 4,
        maxPadX: 18,
        maxPadY: 18,
        frameRadius: 10,
        frameWidth: 2,
        showFrame: false
      },
    effects: {
      playerMissFlash: "rgba(239, 68, 68, 0.55)",
      flashMs: 320
    },
    trail: {
      size: 28,            // fixed-length ring buffer entries
      alphaStart: 0.45,    // leading opacity
      alphaEnd: 0.0,       // oldest opacity
      color: "#e9f1ff"     // base color (tinted by alpha)
      , colorful: true,     // enable rainbow trail when true
      hueSpeedDegPerSec: 120, // hue rotation speed based on time
      hueSweepAlongTrail: 320, // hue range from oldest->newest
      saturationPct: 85,    // HSL saturation for rainbow
      lightnessPct: 65      // HSL lightness for rainbow
    },
    serve: {
      countdownSeconds: 3,
      goHold: 0.25
    },
    audio: {
      enabled: true,
      volume: 0.08,
      hit: {
        type: "square",
        paddleFreq: 740,
        wallFreq: 520,
        duration: 0.05
      },
      cues: {
        startFreq: 660,
        countFreq: 520,
        goFreq: 880,
        scoreFreq: 440,
        winFreq: 990,
        duration: 0.09
      },
      miss: {
        type: "sawtooth",
        startFreq: 480,
        endFreq: 180,
        duration: 0.14
      }
    }
  };

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sign = (v) => (v < 0 ? -1 : 1);

  class Sound {
    constructor(cfg) {
      this.cfg = cfg;
      this.ctx = null;
      this.master = null;
      this.armed = false; // true after first user gesture
    }

    arm() {
      if (!this.cfg.enabled || this.armed) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.cfg.volume;
      this.master.connect(this.ctx.destination);
      if (this.ctx.state !== "running") {
        // resume will succeed due to user gesture that called arm()
        this.ctx.resume?.();
      }
      this.armed = true;
    }

    hit(type) {
      if (!this.armed || !this.ctx) return;
      const { hit } = this.cfg;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = hit.type;
      const freq = type === "paddle" ? hit.paddleFreq : hit.wallFreq;
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + hit.duration);
      osc.connect(gain).connect(this.master);
      osc.start(now);
      osc.stop(now + hit.duration);
    }

    cue(kind) {
      if (!this.armed || !this.ctx) return;
      const { cues } = this.cfg;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      let freq = cues.countFreq;
      if (kind === "start") freq = cues.startFreq;
      else if (kind === "go") freq = cues.goFreq;
      else if (kind === "score") freq = cues.scoreFreq;
      else if (kind === "win") freq = cues.winFreq;
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + cues.duration);
      osc.connect(gain).connect(this.master);
      osc.start(now);
      osc.stop(now + cues.duration);
    }

    miss() {
      if (!this.armed || !this.ctx) return;
      const { miss } = this.cfg;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = miss.type || "sawtooth";
      osc.frequency.setValueAtTime(miss.startFreq, now);
      osc.frequency.linearRampToValueAtTime(miss.endFreq, now + miss.duration);
      gain.gain.setValueAtTime(1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + miss.duration);
      osc.connect(gain).connect(this.master);
      osc.start(now);
      osc.stop(now + miss.duration);
    }
  }

  class TrailBuffer {
    constructor(size) {
      this.size = size | 0;
      this.x = new Float32Array(this.size);
      this.y = new Float32Array(this.size);
      this.count = 0;
      this.head = 0;
    }

    clear() {
      this.count = 0;
      this.head = 0;
    }

    push(px, py) {
      const i = this.head;
      this.x[i] = px;
      this.y[i] = py;
      this.head = (i + 1) % this.size;
      if (this.count < this.size) this.count++;
    }

    // iterate oldest -> newest without allocations
    forEach(callback) {
      const n = this.count;
      const base = (this.head - n + this.size) % this.size;
      for (let k = 0; k < n; k++) {
        const idx = (base + k) % this.size;
        callback(k, n, this.x[idx], this.y[idx]);
      }
    }
  }

  class Input {
    constructor(canvas) {
      this.canvas = canvas;
      this.pointerY = null; // legacy single-pointer (left)
      this.isDown = false;
      this.twoPlayer = false;
      // Multi-touch support: independent pointers per side
      this.pointerYLeft = null;
      this.pointerYRight = null;
      this.isDownLeft = false;
      this.isDownRight = false;
      this._pointerIdToSide = new Map(); // pointerId -> "left" | "right"
      this.leftUp = false;
      this.leftDown = false;
      this.rightUp = false;
      this.rightDown = false;

      const onPointer = (e) => {
        const p = this._eventToWorld(e);
        this.pointerY = p.y;
      };

      canvas.addEventListener("pointerdown", (e) => {
        // Determine side by screen-space position; right half goes to Player 2 only when twoPlayer is enabled
        const rect = canvas.getBoundingClientRect();
        const xCss = e.clientX - rect.left;
        const side = (this.twoPlayer && xCss > rect.width / 2) ? "right" : "left";
        this._pointerIdToSide.set(e.pointerId, side);
        canvas.setPointerCapture?.(e.pointerId);
        const p = this._eventToWorld(e);
        if (side === "right") {
          this.isDownRight = true;
          this.pointerYRight = p.y;
        } else {
          // left (and legacy single-pointer for compatibility)
          this.isDownLeft = true;
          this.pointerYLeft = p.y;
          this.isDown = true;
          this.pointerY = p.y;
        }
        this.onAnyInput?.();
      });

      canvas.addEventListener("pointermove", (e) => {
        const side = this._pointerIdToSide.get(e.pointerId);
        if (!side) return;
        const p = this._eventToWorld(e);
        if (side === "right" && this.isDownRight) {
          this.pointerYRight = p.y;
        } else if (side === "left" && this.isDownLeft) {
          this.pointerYLeft = p.y;
          this.pointerY = p.y; // legacy
        }
      });

      const end = (e) => {
        const side = this._pointerIdToSide.get(e.pointerId);
        if (side === "right") {
          this.isDownRight = false;
          this.pointerYRight = null;
        } else if (side === "left") {
          this.isDownLeft = false;
          this.pointerYLeft = null;
          this.isDown = false; // legacy
          this.pointerY = null;
        }
        this._pointerIdToSide.delete(e.pointerId);
      };
      canvas.addEventListener("pointerup", end);
      canvas.addEventListener("pointercancel", end);

      window.addEventListener("keydown", (e) => {
        if (e.code === "Space") this.onStart?.();
        if (e.code === "KeyR") this.onRestart?.();
        if (e.code === "KeyP" || e.code === "Escape") this.onPauseToggle?.();
        if (e.code === "KeyW") this.leftUp = true;
        if (e.code === "KeyS") this.leftDown = true;
        if (e.code === "ArrowUp") this.rightUp = true;
        if (e.code === "ArrowDown") this.rightDown = true;
        this.onAnyInput?.();
      });
      window.addEventListener("keyup", (e) => {
        if (e.code === "KeyW") this.leftUp = false;
        if (e.code === "KeyS") this.leftDown = false;
        if (e.code === "ArrowUp") this.rightUp = false;
        if (e.code === "ArrowDown") this.rightDown = false;
      });
    }

    setTwoPlayer(enabled) {
      const flag = !!enabled;
      if (this.twoPlayer === flag) return;
      this.twoPlayer = flag;
      if (!flag) {
        // When turning off 2P, clear any right-side touch
        this.isDownRight = false;
        this.pointerYRight = null;
        // Remap active left as legacy if present
        if (this.isDownLeft) {
          this.isDown = true;
          this.pointerY = this.pointerYLeft;
        }
      }
    }

    setTransform({ scale, offsetX, offsetY }) {
      this.scale = scale;
      this.offsetX = offsetX;
      this.offsetY = offsetY;
    }

    getKeyboardAxisY(side) {
      if (side === "right") {
        if (this.rightUp && !this.rightDown) return -1;
        if (this.rightDown && !this.rightUp) return 1;
        return 0;
      }
      // left defaults
      if (this.leftUp && !this.leftDown) return -1;
      if (this.leftDown && !this.leftUp) return 1;
      return 0;
    }

    _eventToWorld(e) {
      const rect = this.canvas.getBoundingClientRect();
      const xCss = e.clientX - rect.left;
      const yCss = e.clientY - rect.top;

      const x = (xCss - this.offsetX) / this.scale;
      const y = (yCss - this.offsetY) / this.scale;
      return { x, y };
    }
  }

  class Paddle {
    constructor(x, y) {
      this.x = x;
      this.y = y;
      this.vy = 0;
    }

    get rect() {
      return {
        x: this.x - CONFIG.paddle.w / 2,
        y: this.y - CONFIG.paddle.h / 2,
        w: CONFIG.paddle.w,
        h: CONFIG.paddle.h,
      };
    }

    update(dt) {
      this.y += this.vy * dt;
      const half = CONFIG.paddle.h / 2;
      this.y = clamp(this.y, half, CONFIG.world.h - half);
    }
  }

  class Ball {
    constructor() {
      this.reset(1);
    }

    reset(dir) {
      this.x = CONFIG.world.w / 2;
      this.y = CONFIG.world.h / 2;
       this.prevX = this.x;
       this.prevY = this.y;

      const angle = (Math.random() * 0.6 - 0.3); // -0.3..0.3 rad
      this.vx = Math.cos(angle) * CONFIG.ball.speed * dir;
      this.vy = Math.sin(angle) * CONFIG.ball.speed;
      this.speed = CONFIG.ball.speed;
      this.hits = 0;
      this.didWallBounce = false;
    }

    update(dt) {
      this.didWallBounce = false;
       this.prevX = this.x;
       this.prevY = this.y;
      this.x += this.vx * dt;
      this.y += this.vy * dt;

      const r = CONFIG.ball.r;
      if (this.y < r) {
        this.y = r;
        this.vy = Math.abs(this.vy);
        this.didWallBounce = true;
      } else if (this.y > CONFIG.world.h - r) {
        this.y = CONFIG.world.h - r;
        this.vy = -Math.abs(this.vy);
        this.didWallBounce = true;
      }
    }
  }

  function circleRectHit(cx, cy, r, rect) {
    const closestX = clamp(cx, rect.x, rect.x + rect.w);
    const closestY = clamp(cy, rect.y, rect.y + rect.h);
    const dx = cx - closestX;
    const dy = cy - closestY;
    return (dx * dx + dy * dy) <= r * r;
  }

  class Game {
    constructor(canvas, ctx) {
      this.canvas = canvas;
      this.ctx = ctx;
       this.time = 0;
      this.hudEl = document.getElementById("hud");
      this.fxFlash = document.getElementById("fxFlash");
      this._flashTime = 0; // seconds remaining
      this._flashDuration = CONFIG.effects.flashMs / 1000;

      this.left = new Paddle(40, CONFIG.world.h / 2);
      this.right = new Paddle(CONFIG.world.w - 40, CONFIG.world.h / 2);
      this.ball = new Ball();
      this.trail = new TrailBuffer(CONFIG.trail.size);
      this.sound = new Sound(CONFIG.audio);

      this.leftScore = 0;
      this.rightScore = 0;
      this.state = "menu"; // menu | play | over

      this.uiScoreL = document.getElementById("scoreL");
      this.uiScoreR = document.getElementById("scoreR");
      this.uiTimeText = document.getElementById("timeText");
      // Apply score colors from CONFIG
      if (this.uiScoreL) this.uiScoreL.style.color = CONFIG.colors.scoreL;
      if (this.uiScoreR) this.uiScoreR.style.color = CONFIG.colors.scoreR;
      // Apply bar colors to CSS vars on HUD
      if (this.hudEl) {
        this.hudEl.style.setProperty("--barL", CONFIG.colors.barL);
        this.hudEl.style.setProperty("--barR", CONFIG.colors.barR);
      }
      this.chk2p = document.getElementById("chk2p");
      this.overlay = document.getElementById("overlay");
      this.title = document.getElementById("title");
      this.subtitle = document.getElementById("subtitle");
      this.btnStart = document.getElementById("btnStart");
      this.btnQuit = document.getElementById("btnQuit");

      this.btnStart.addEventListener("click", async () => {
        this._armAudio();
        await this._enterFullscreenLandscape();
        this._startOrRestart();
      });
      this.btnQuit?.addEventListener("click", () => this._quitToMenu());
      this.twoPlayer = false;
      this.chk2p?.addEventListener("change", () => {
        this.twoPlayer = !!this.chk2p.checked;
        this.input.setTwoPlayer(this.twoPlayer);
      });

      this.input = new Input(canvas);
      this.input.onStart = () => this._startOrRestart();
      this.input.onRestart = () => this.restart();
      this.input.onAnyInput = () => this._armAudio();
       this.input.onPauseToggle = () => this._togglePause();
      this.input.setTwoPlayer(this.twoPlayer);

      this.matchTimeLeft = CONFIG.match.durationSeconds;
      this._updateScoreUI();
      this._updateTimeUI();
      this.showMenu();

      this._fitToScreen();
      window.addEventListener("resize", () => this._fitToScreen());
      window.addEventListener("orientationchange", () => this._fitToScreen());
      document.addEventListener("fullscreenchange", () => this._fitToScreen());
      window.visualViewport?.addEventListener("resize", () => this._fitToScreen());
    }

    async _enterFullscreenLandscape() {
      try {
        const root = document.documentElement;
        if (!document.fullscreenElement && root.requestFullscreen) {
          try {
            await root.requestFullscreen();
          } catch {}
        }
        if (screen.orientation && screen.orientation.lock) {
          try {
            await screen.orientation.lock("landscape");
          } catch {}
        }
      } catch {}
    }

    _armAudio() {
      this.sound.arm();
    }

     _togglePause() {
       if (this.state === "play" || this.state === "serve") {
         this.prevState = this.state;
         this.state = "pause";
         this.overlay.classList.remove("hidden");
         this.title.textContent = "Paused";
         this.subtitle.textContent = "Press P/Escape to resume.";
         this.btnStart.textContent = "Resume";
         this.btnQuit?.classList.add("hidden");
       } else if (this.state === "pause") {
         this.state = this.prevState || "menu";
         if (this.state !== "menu" && this.state !== "over") {
           this.overlay.classList.add("hidden");
         }
       }
     }

    _quitToMenu() {
      this.showMenu();
    }

    _flash() {
      // Use in-canvas flash constrained to world area
      this._flashTime = this._flashDuration;
    }

    _reservedTopCss() {
      // Reserve the HUD height so the world renders below it
      try {
        if (!this.hudEl) return 0;
        const r = this.hudEl.getBoundingClientRect();
        // Add a small breathing space below HUD
        return Math.ceil(r.bottom + 6);
      } catch {
        return 0;
      }
    }

    _fitToScreen() {
      const dpr = window.devicePixelRatio || 1;
      const cssW = window.innerWidth;
      const cssH = Math.round(window.visualViewport?.height || window.innerHeight);
      const reservedTop = this._reservedTopCss();

      this.canvas.style.width = cssW + "px";
      this.canvas.style.height = cssH + "px";
      this.canvas.width = Math.floor(cssW * dpr);
      this.canvas.height = Math.floor(cssH * dpr);

      // draw in CSS pixels
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const availH = Math.max(0, cssH - reservedTop);
      // compute dynamic padding for consistent margins
      const isLandscape = cssW >= cssH;
      const compactLandscape = isLandscape && cssH < 480;
      const padScaleX = compactLandscape ? 0 : CONFIG.view.padScaleX;
      const padScaleY = compactLandscape ? 0 : CONFIG.view.padScaleY;
      const minPadX = compactLandscape ? 0 : CONFIG.view.minPadX;
      const maxPadX = compactLandscape ? 0 : CONFIG.view.maxPadX;
      const minPadY = compactLandscape ? 0 : CONFIG.view.minPadY;
      const maxPadY = compactLandscape ? 0 : CONFIG.view.maxPadY;

      const padX = Math.max(minPadX, Math.min(maxPadX, Math.round(cssW * padScaleX)));
      const padY = Math.max(minPadY, Math.min(maxPadY, Math.round(availH * padScaleY)));

      const fitW = Math.max(0, cssW - 2 * padX);
      const fitH = Math.max(0, availH - 2 * padY);
      const scale = Math.min(fitW / CONFIG.world.w, fitH / CONFIG.world.h);
      const viewW = CONFIG.world.w * scale;
      const viewH = CONFIG.world.h * scale;
      const offsetX = padX + (fitW - viewW) / 2;
      const offsetY = reservedTop + padY + (fitH - viewH) / 2;

      this.view = { scale, offsetX, offsetY, cssW, cssH };
      this.input.setTransform({ scale, offsetX, offsetY });

      // Keep HUD narrower than playfield
      if (this.hudEl) {
        const hudMax = Math.min(1120, cssW - 28);
        const hudTarget = Math.max(280, Math.min(hudMax, Math.floor(viewW - 24)));
        this.hudEl.style.width = hudTarget + "px";
      }
    }

    _startOrRestart() {
      if (this.state === "menu") this.start();
      else if (this.state === "over") this.restart();
       else if (this.state === "pause") this._togglePause();
       else if (this.state === "play" || this.state === "serve") { /* ignore */ }
    }

    showMenu() {
      this.state = "menu";
      this.overlay.classList.remove("hidden");
      this.title.textContent = "Pong";
      this.title.style.color = "#e8eefc";
      this.title.style.textShadow = "0 2px 12px rgba(0,0,0,0.6)";
       this.subtitle.textContent = "Tap/Drag (P1). W/S: P1, ↑/↓: P2 when 2P ON. Space: Start, P/Esc: Pause, R: Restart.";
      this.btnStart.textContent = "Start";
      this.btnQuit?.classList.add("hidden");
      if (this.chk2p) this.chk2p.checked = false;
      this.twoPlayer = false;
      this.ball.reset(sign(Math.random() - 0.5));
      this.trail.clear();
      this.matchTimeLeft = CONFIG.match.durationSeconds;
      this._updateTimeUI();
    }

    start() {
       this.overlay.classList.add("hidden");
       this.matchTimeLeft = CONFIG.match.durationSeconds;
       this._updateTimeUI();
       this._beginServe(sign(Math.random() - 0.5));
    }

    restart() {
      this.leftScore = 0;
      this.rightScore = 0;
      this._updateScoreUI();
      this.left.y = CONFIG.world.h / 2;
      this.right.y = CONFIG.world.h / 2;
       this.ball.reset(sign(Math.random() - 0.5));
      this.trail.clear();
      this.showMenu();
    }

    _updateScoreUI() {
      if (this.uiScoreL) this.uiScoreL.textContent = String(this.leftScore);
      if (this.uiScoreR) this.uiScoreR.textContent = String(this.rightScore);
    }

    _checkWin() {
      if (this.leftScore >= CONFIG.scoreToWin) return "You Win!";
      if (this.rightScore >= CONFIG.scoreToWin) return "AI Wins!";
      return null;
    }
 
    _updateTimeUI() {
      const t = Math.max(0, Math.ceil(this.matchTimeLeft));
      const m = Math.floor(t / 60);
      const s = t % 60;
      const text = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      if (this.uiTimeText) this.uiTimeText.textContent = text;
    }

     _beginServe(dir) {
       this.state = "serve";
       this.serveRemaining = CONFIG.serve.countdownSeconds + CONFIG.serve.goHold;
       this.lastServeSecond = Math.ceil(this.serveRemaining);
       this.ball.reset(dir);
       this.trail.clear();
       this.trail.push(this.ball.x, this.ball.y);
       this.sound.cue("start");
     }

     _endServeStartPlay() {
       this.state = "play";
     }

    update(dt) {
       if (this.state === "pause" || this.state === "menu" || this.state === "over") return;
       this.time += dt;

       // countdown timer during serve and play
       if (this.state === "serve" || this.state === "play") {
         this.matchTimeLeft = Math.max(0, this.matchTimeLeft - dt);
         this._updateTimeUI();
         if (this.matchTimeLeft <= 0) {
           const outcome = this.leftScore === this.rightScore
             ? "Draw!"
             : (this.leftScore > this.rightScore ? "You Win!" : "AI Wins!");
           return this._gameOver(outcome);
         }
       }
      // decay flash timer
      if (this._flashTime > 0) this._flashTime = Math.max(0, this._flashTime - dt);

       if (this.state === "serve") {
         this.serveRemaining = Math.max(0, this.serveRemaining - dt);
         const sec = Math.ceil(this.serveRemaining);
         if (sec !== this.lastServeSecond) {
           this.lastServeSecond = sec;
           if (this.serveRemaining > CONFIG.serve.goHold) this.sound.cue("count");
           else if (this.serveRemaining > 0) this.sound.cue("go");
         }
         if (this.serveRemaining <= 0) {
           this._endServeStartPlay();
         }
         // During serve, allow paddle movement but ball stays
       }
       if (this.state !== "play") {
         // still update paddles under input even in serve
       }

      // Player 1 (left) paddle: left pointer drag overrides; otherwise W/S keys; else hold position
      if (this.input.isDownLeft && this.input.pointerYLeft != null) {
        const target = clamp(this.input.pointerYLeft, CONFIG.paddle.h / 2, CONFIG.world.h - CONFIG.paddle.h / 2);
        const dy = target - this.left.y;
        const maxStep = CONFIG.paddle.speed * dt;
        this.left.y += clamp(dy, -maxStep, maxStep);
        this.left.vy = 0;
      } else {
         const axis = this.input.getKeyboardAxisY("left");
         if (axis !== 0) this.left.vy = axis * CONFIG.paddle.speed;
         else this.left.vy = 0; // hold position when no input
        this.left.update(dt);
      }

      // Right paddle: either Player 2 (Arrow keys) or AI
      if (this.twoPlayer) {
        if (this.input.isDownRight && this.input.pointerYRight != null) {
          const targetR = clamp(this.input.pointerYRight, CONFIG.paddle.h / 2, CONFIG.world.h - CONFIG.paddle.h / 2);
          const dyR = targetR - this.right.y;
          const maxStepR = CONFIG.paddle.speed * dt;
          this.right.y += clamp(dyR, -maxStepR, maxStepR);
          this.right.vy = 0;
        } else {
          const axisR = this.input.getKeyboardAxisY("right");
          if (axisR !== 0) this.right.vy = axisR * CONFIG.paddle.speed;
          else this.right.vy = 0; // hold position when no input
        }
        this.right.update(dt);
      } else {
        const dy = this.ball.y - this.right.y;
        const dz = CONFIG.ai.deadZone;
        if (Math.abs(dy) < dz) this.right.vy = 0;
        else this.right.vy = clamp(dy * 3.0, -CONFIG.ai.followSpeed, CONFIG.ai.followSpeed);
        this.right.update(dt);
      }

       // Ball updates only during play
       if (this.state === "play") {
         this.ball.update(dt);
         if (this.ball.didWallBounce) this.sound.hit("wall");
       }
      if (this.ball.didWallBounce) this.sound.hit("wall");
      this.trail.push(this.ball.x, this.ball.y);

      // Paddle collisions
      this._handlePaddleHit(this.left, +1);
      this._handlePaddleHit(this.right, -1);

      // Score out of bounds
      if (this.ball.x < -40) {
        this.rightScore++;
        this._updateScoreUI();
        const win = this._checkWin();
         if (win) return this._gameOver(win);
         this.sound.cue("score");
         this.sound.miss();
         this._flash();
         this._beginServe(+1); // serve toward scorer's opponent (left was scored on)
      } else if (this.ball.x > CONFIG.world.w + 40) {
        this.leftScore++;
        this._updateScoreUI();
        const win = this._checkWin();
         if (win) return this._gameOver(win);
         this.sound.cue("score");
         this._beginServe(-1); // serve toward scorer's opponent
      }
    }

    _handlePaddleHit(paddle, towardDir) {
      const b = this.ball;
      const r = CONFIG.ball.r;
      const rect = paddle.rect;

      // Only if ball is moving toward the paddle:
      // left paddle (towardDir > 0) requires vx < 0; right paddle (towardDir < 0) requires vx > 0
      if (towardDir > 0 && b.vx >= 0) return;
      if (towardDir < 0 && b.vx <= 0) return;

       // Swept collision against paddle face to prevent tunneling
       const x0 = b.prevX, y0 = b.prevY;
       const x1 = b.x, y1 = b.y;
       let faceX, prevEdge, currEdge, crossing = false, tHit = 1, yAt = y1;
       if (towardDir < 0) {
         // right paddle, moving right -> left? Actually towardDir < 0 means bounce to left, so paddle is right side, vx > 0 approaching its left face at rect.x
         faceX = rect.x;
         prevEdge = x0 + r;
         currEdge = x1 + r;
         if (prevEdge < faceX && currEdge >= faceX) {
           tHit = (faceX - prevEdge) / (currEdge - prevEdge);
           crossing = true;
         }
       } else {
         // left paddle, moving left -> right? towardDir > 0 means bounce to right, paddle is left side, vx < 0 approaching its right face at rect.x + rect.w
         faceX = rect.x + rect.w;
         prevEdge = x0 - r;
         currEdge = x1 - r;
         if (prevEdge > faceX && currEdge <= faceX) {
           tHit = (faceX - prevEdge) / (currEdge - prevEdge);
           crossing = true;
         }
       }

       let collided = false;
       if (crossing) {
         yAt = y0 + (y1 - y0) * clamp(tHit, 0, 1);
         if (yAt >= rect.y && yAt <= rect.y + rect.h) {
           collided = true;
         }
       } else {
         // fallback to static check if not swept crossing (glancing)
         if (circleRectHit(b.x, b.y, r, rect)) {
           yAt = b.y;
           collided = true;
         }
       }

       if (!collided) return;

      // prevent sticking
       if (towardDir > 0) b.x = rect.x + rect.w + r + 0.001;
       else b.x = rect.x - r - 0.001;

       const offset = clamp((yAt - paddle.y) / (CONFIG.paddle.h / 2), -1, 1);
      const maxAngle = (CONFIG.bounce.maxAngleDeg * Math.PI) / 180;
      const angle = offset * maxAngle;

      b.hits++;
      b.speed = clamp(
        CONFIG.ball.speed + b.hits * CONFIG.ball.speedUpPerHit,
        CONFIG.ball.speed,
        CONFIG.ball.maxSpeed
      );

       // Add spin from paddle vertical velocity
       const spinVy = paddle.vy * CONFIG.bounce.spinFactor;
       const dirVx = Math.cos(angle) * b.speed * towardDir;
       const dirVy = Math.sin(angle) * b.speed + spinVy;
       // Normalize to maintain speed cap tendencies but respect spin
       const mag = Math.hypot(dirVx, dirVy) || b.speed;
       const scale = b.speed / mag;
       b.vx = dirVx * scale;
       b.vy = dirVy * scale;
      this.sound.hit("paddle");
    }

    _gameOver(text) {
      this.state = "over";
      this.overlay.classList.remove("hidden");
      this.title.textContent = text;
      this.subtitle.textContent = "Press Space or click Restart to play again.";
      this.btnStart.textContent = "Restart";
       this.sound.cue("win");
      // Themed game over styling and buttons
      const youWin = /Win!/i.test(text);
      this.title.style.color = youWin ? "#34d399" : "#f87171";
      this.title.style.textShadow = "0 3px 18px rgba(0,0,0,0.7)";
      this.subtitle.textContent = `Final Score: ${this.leftScore} - ${this.rightScore}`;
      this.btnQuit?.classList.remove("hidden");
    }

    draw() {
      const ctx = this.ctx;
      const { scale, offsetX, offsetY, cssW, cssH } = this.view;

      ctx.clearRect(0, 0, cssW, cssH);

      // background
      ctx.fillStyle = CONFIG.colors.outerBg;
      ctx.fillRect(0, 0, cssW, cssH);

      // world
      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);

      // playfield background
      ctx.fillStyle = CONFIG.colors.innerBg;
      ctx.fillRect(0, 0, CONFIG.world.w, CONFIG.world.h);
      // optional frame for desktop; disabled on mobile compact by default
      if (CONFIG.view.showFrame) {
        ctx.lineWidth = CONFIG.view.frameWidth;
        ctx.strokeStyle = CONFIG.colors.frame;
        const r = CONFIG.view.frameRadius;
        const w = CONFIG.world.w, h = CONFIG.world.h;
        if (r > 0) {
          ctx.beginPath();
          ctx.moveTo(r, 0);
          ctx.lineTo(w - r, 0);
          ctx.quadraticCurveTo(w, 0, w, r);
          ctx.lineTo(w, h - r);
          ctx.quadraticCurveTo(w, h, w - r, h);
          ctx.lineTo(r, h);
          ctx.quadraticCurveTo(0, h, 0, h - r);
          ctx.lineTo(0, r);
          ctx.quadraticCurveTo(0, 0, r, 0);
          ctx.closePath();
          ctx.stroke();
        } else {
          ctx.strokeRect(0, 0, w, h);
        }
      }

      // net
      ctx.fillStyle = CONFIG.colors.net;
      const midX = CONFIG.world.w / 2 - CONFIG.net.w / 2;
      for (let y = 0; y < CONFIG.world.h; y += (CONFIG.net.dash + CONFIG.net.gap)) {
        ctx.fillRect(midX, y, CONFIG.net.w, CONFIG.net.dash);
      }

      // paddles
      this._drawPaddle(this.left);
      this._drawPaddle(this.right);

      // ball trail (oldest -> newest)
      this._drawTrail();

      // ball
      this._drawBall();

      // world-area flash overlay
      if (this._flashTime > 0) {
        const alpha = this._flashTime / this._flashDuration;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = CONFIG.effects.playerMissFlash;
        ctx.fillRect(0, 0, CONFIG.world.w, CONFIG.world.h);
        ctx.globalAlpha = 1;
      }

      ctx.restore();

       // serve countdown text
       if (this.state === "serve") {
         this._drawServeCountdown();
       }
    }

    _drawPaddle(p) {
      const rect = p.rect;
      this.ctx.fillStyle = CONFIG.colors.fg;
      this.ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }

    _drawBall() {
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.arc(this.ball.x, this.ball.y, CONFIG.ball.r, 0, TAU);
      ctx.fillStyle = CONFIG.colors.fg;
      ctx.fill();
    }

    _drawTrail() {
      const ctx = this.ctx;
      const total = this.trail.count;
      if (total <= 1) return;
      const a0 = CONFIG.trail.alphaStart;
      const a1 = CONFIG.trail.alphaEnd;
      const base = (this.trail.head - total + this.trail.size) % this.trail.size;
      const colorful = !!CONFIG.trail.colorful;
      const hueSpeed = CONFIG.trail.hueSpeedDegPerSec || 0;
      const hueSweep = CONFIG.trail.hueSweepAlongTrail || 0;
      const sat = CONFIG.trail.saturationPct ?? 85;
      const light = CONFIG.trail.lightnessPct ?? 65;
      let lastAlpha = -1;
      for (let k = 0; k < total; k++) {
        const idx = (base + k) % this.trail.size;
        const x = this.trail.x[idx];
        const y = this.trail.y[idx];
        const t = total <= 1 ? 1 : k / (total - 1);
        const alpha = a0 + (a1 - a0) * t;
        if (alpha !== lastAlpha) {
          ctx.globalAlpha = alpha;
          lastAlpha = alpha;
        }
        if (colorful) {
          const hue = ((this.time * hueSpeed) + (t * hueSweep)) % 360;
          ctx.fillStyle = `hsl(${hue}deg, ${sat}%, ${light}%)`;
        } else {
          ctx.fillStyle = CONFIG.trail.color;
        }
        ctx.beginPath();
        ctx.arc(x, y, CONFIG.ball.r, 0, TAU);
        ctx.fill();
      }
      if (lastAlpha !== -1) ctx.globalAlpha = 1;
    }

     _drawServeCountdown() {
       const ctx = this.ctx;
       const remaining = this.serveRemaining;
       const count = Math.ceil(Math.max(0, remaining - CONFIG.serve.goHold));
       let text = count > 0 ? String(count) : "GO!";
       ctx.save();
       const { scale, offsetX, offsetY } = this.view;
       ctx.translate(offsetX, offsetY);
       ctx.scale(scale, scale);
       ctx.fillStyle = "rgba(232, 238, 252, 0.9)";
       ctx.textAlign = "center";
       ctx.textBaseline = "middle";
       ctx.font = "bold 64px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
       ctx.fillText(text, CONFIG.world.w / 2, CONFIG.world.h * 0.33);
       ctx.restore();
     }
  }

  // Boot
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d", { alpha: false });

  const game = new Game(canvas, ctx);

  let last = performance.now();
  function loop(now) {
    const dt = clamp((now - last) / 1000, 0, 0.033);
    last = now;

    game.update(dt);
    game.draw();

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
