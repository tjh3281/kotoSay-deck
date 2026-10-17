/* ==========================================================================
   Deck controller
   - Paging is a spring on a single value p (in slide units), so any
     transition can be grabbed mid-flight and reversed, and velocity carries
     through every retarget (no "brick wall" when you change your mind).
   - Drag / swipe tracks 1:1, projects momentum on release, rubber-bands at
     the first and last slide.
   - Keyboard, presenter clickers, trackpad swipes and mouse wheels all work.
   - prefers-reduced-motion: no sliding, a short cross-fade instead.
   - Videos marked data-autoplay play when their slide arrives and pause
     when you leave.
   ========================================================================== */
(() => {
  "use strict";

  const stage = document.getElementById("stage");
  const track = document.getElementById("track");
  const slides = Array.from(track.children).filter((el) => el.classList.contains("slide"));
  const n = slides.length;

  const chrome = document.getElementById("chrome");
  const btnPrev = document.getElementById("prev");
  const btnNext = document.getElementById("next");
  const btnFull = document.getElementById("fullscreen");
  const countEl = document.getElementById("count");
  const labelEl = document.getElementById("label");
  const dotsEl = document.getElementById("dots");
  const announcer = document.getElementById("announcer");

  const SPRING_PAGE = { damping: 1.0, response: 0.42 };   // keys, buttons, dots: no overshoot
  const SPRING_FLICK = { damping: 0.86, response: 0.38 }; // released with momentum: a touch of bounce
  const DRAG_SLOP = 10;        // px before a drag commits to a direction
  const FLICK_SPEED = 350;     // px/s — faster than this counts as a flick
  const VELOCITY_WINDOW = 100; // ms of pointer history used for release velocity

  const reducedMQ = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = reducedMQ.matches;
  if (reducedMQ.addEventListener) reducedMQ.addEventListener("change", (e) => { reduced = e.matches; });

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pad = (v) => String(v).padStart(2, "0");
  const labels = slides.map((s, i) => s.dataset.label || `Slide ${i + 1}`);

  /* ---------- Semantics ---------- */
  slides.forEach((s, i) => {
    s.setAttribute("role", "group");
    s.setAttribute("aria-roledescription", "slide");
    s.setAttribute("aria-label", `${i + 1} of ${n}: ${labels[i]}`);
  });

  const dots = slides.map((_, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chrome__dot";
    b.setAttribute("aria-label", `Go to slide ${i + 1}: ${labels[i]}`);
    b.addEventListener("click", () => goTo(i));
    dotsEl.appendChild(b);
    return b;
  });

  /* ---------- State ---------- */
  function indexFromHash() {
    const m = /^#(\d+)$/.exec(window.location.hash);
    return m ? clamp(parseInt(m[1], 10) - 1, 0, n - 1) : null;
  }

  let index = indexFromHash() ?? 0;
  const spring = new Spring(index);
  let width = stage.clientWidth || 1;
  let raf = 0;
  let lastTime = 0;
  let shownIndex = -1;
  let announce = false;

  /* Soft edges past the first and last slide (p in slide units) */
  function soften(p) {
    if (p < 0) return -rubberband(-p * width, width) / width;
    if (p > n - 1) return n - 1 + rubberband((p - (n - 1)) * width, width) / width;
    return p;
  }

  /* ---------- Render ---------- */
  function render(p) {
    track.style.transform = `translate3d(${(-p * width).toFixed(2)}px, 0, 0)`;
    for (let i = 0; i < n; i++) {
      const s = slides[i];
      const d = Math.abs(p - i);
      const visible = d < 0.995;
      if (visible !== s.classList.contains("is-visible")) s.classList.toggle("is-visible", visible);
      // Neighbours recede a little as they travel: reads as depth, keeps focus on the arriving slide
      s.style.opacity = visible && d > 0.001 ? (1 - Math.min(d, 1) * 0.45).toFixed(3) : "";
    }
  }

  function updateUI() {
    if (shownIndex === index) return;
    shownIndex = index;
    countEl.textContent = `${pad(index + 1)} / ${pad(n)}`;
    labelEl.textContent = labels[index];
    btnPrev.disabled = index === 0;
    btnNext.disabled = index === n - 1;
    dots.forEach((d, i) => d.setAttribute("aria-current", i === index ? "true" : "false"));
    slides.forEach((s, i) => {
      const off = i !== index;
      s.toggleAttribute("inert", off);
      s.setAttribute("aria-hidden", off ? "true" : "false");
    });
    syncMedia();
    // the page around the 16:9 stage takes the slide's colour, so dark slides get no cream bars
    document.body.classList.toggle("is-dark-slide", slides[index].classList.contains("slide--dark"));
    if (announce) announcer.textContent = `Slide ${index + 1} of ${n}: ${labels[index]}`;
    announce = true;
    const hash = `#${index + 1}`;
    if (window.location.hash !== hash) history.replaceState(null, "", hash);
  }

  /* ---------- Spring loop ---------- */
  function frame(now) {
    const dt = clamp((now - lastTime) / 1000, 0, 0.064);
    lastTime = now;
    spring.step(dt);
    if (spring.resting) {
      spring.settle();
      render(spring.value);
      raf = 0;
      return;
    }
    render(spring.value);
    raf = requestAnimationFrame(frame);
  }
  function run() {
    if (raf) return;
    lastTime = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  /* Retargeting keeps the current value and velocity: always interruptible */
  function goTo(i, opts = {}) {
    const target = clamp(i, 0, n - 1);
    const changed = target !== index;
    index = target;
    updateUI();

    if (reduced) {
      stop();
      spring.jump(index);
      render(index);
      if (changed && slides[index].animate) {
        slides[index].animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
      }
      return;
    }
    spring.configure(opts.spring || SPRING_PAGE);
    spring.target = index;
    if (opts.velocity !== undefined) spring.velocity = opts.velocity;
    run();
  }
  const next = () => goTo(index + 1);
  const prev = () => goTo(index - 1);

  /* Release: project where the gesture is going, snap to the nearest slide
     there (at most one away), and hand the finger's velocity to the spring. */
  function release(fromIndex, velocityPx) {
    const projected = spring.value + projectMomentum(-velocityPx) / width;
    const target = clamp(Math.round(projected), fromIndex - 1, fromIndex + 1);
    goTo(target, {
      velocity: -velocityPx / width,
      spring: Math.abs(velocityPx) > FLICK_SPEED ? SPRING_FLICK : SPRING_PAGE,
    });
  }

  function velocityOf(samples) {
    if (samples.length < 2) return 0;
    const a = samples[0];
    const b = samples[samples.length - 1];
    const dt = (b.t - a.t) / 1000;
    return dt > 0 ? (b.x - a.x) / dt : 0;
  }
  function pushSample(samples, x, t) {
    samples.push({ x, t });
    while (samples.length > 2 && t - samples[0].t > VELOCITY_WINDOW) samples.shift();
  }

  /* ---------- Pointer: drag / swipe ---------- */
  // Keep native image dragging from cancelling the slide gesture.
  stage.addEventListener("dragstart", (e) => e.preventDefault());
  let drag = null;
  let swallowClick = false;
  window.addEventListener("click", (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || drag) return;
    if (e.target.closest("a, button, input, select, textarea")) return;
    const wasMoving = raf !== 0;
    stop(); // catch it mid-flight: it holds at its on-screen value
    drag = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      p0: spring.value,
      from: Math.round(clamp(spring.value, 0, n - 1)),
      wasMoving,
      active: false,
      dx: 0,
      samples: [{ x: e.clientX, t: e.timeStamp }],
    };
  });

  window.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;

    if (!drag.active) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      if (Math.abs(dy) > Math.abs(dx)) { endDrag(e, true); return; } // vertical: not ours
      drag.active = true;
      drag.x0 = e.clientX;             // start tracking from here: no jump at commit
      drag.p0 = spring.value;
      try { stage.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      stage.classList.add("is-dragging");
    }

    drag.dx = e.clientX - drag.x0;
    pushSample(drag.samples, e.clientX, e.timeStamp);
    if (reduced) return; // no sliding under reduced motion; direction is decided on release

    spring.value = soften(drag.p0 - drag.dx / width); // 1:1 with the finger
    spring.velocity = 0;
    render(spring.value);
  });

  function endDrag(e, cancelled) {
    const d = drag;
    drag = null;
    stage.classList.remove("is-dragging");
    if (!d) return;

    if (!d.active) {
      if (d.wasMoving) goTo(index); // a tap that caught a moving slide: let it finish
      return;
    }
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 60);
    if (reduced) {
      if (Math.abs(d.dx) > 40) goTo(d.from + (d.dx < 0 ? 1 : -1));
      return;
    }
    let v = cancelled ? 0 : velocityOf(d.samples);
    const lastT = d.samples[d.samples.length - 1].t;
    if (e && e.timeStamp - lastT > 80) v = 0; // paused before lifting: no throw
    release(d.from, v);
  }

  window.addEventListener("pointerup", (e) => {
    if (drag && e.pointerId === drag.id) endDrag(e, false);
  });
  window.addEventListener("pointercancel", (e) => {
    if (drag && e.pointerId === drag.id) endDrag(e, true);
  });

  /* ---------- Wheel: trackpad swipes track 1:1, mouse wheels step ---------- */
  let wheel = null;
  let wheelLock = false;
  let wheelLockTimer = 0;

  function endWheel() {
    const w = wheel;
    wheel = null;
    if (w) release(w.from, velocityOf(w.samples));
  }

  stage.addEventListener("wheel", (e) => {
    if (e.ctrlKey) return; // pinch-zoom
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? width : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    e.preventDefault();

    if (Math.abs(dx) > Math.abs(dy) && !reduced && !drag) {
      if (!wheel) {
        stop();
        wheel = { p0: spring.value, from: Math.round(clamp(spring.value, 0, n - 1)), acc: 0, samples: [], timer: 0 };
      }
      wheel.acc += dx;
      const raw = clamp(wheel.p0 + wheel.acc / width, wheel.from - 1, wheel.from + 1);
      spring.value = soften(raw);
      spring.velocity = 0;
      render(spring.value);
      pushSample(wheel.samples, -wheel.acc, e.timeStamp);
      clearTimeout(wheel.timer);
      wheel.timer = setTimeout(endWheel, 110);
      return;
    }

    const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
    if (Math.abs(delta) < 4) return;
    clearTimeout(wheelLockTimer);
    wheelLockTimer = setTimeout(() => { wheelLock = false; }, 240); // one step per wheel gesture
    if (wheelLock) return;
    wheelLock = true;
    goTo(index + (delta > 0 ? 1 : -1));
  }, { passive: false });

  /* ---------- Fullscreen & controls visibility ---------- */
  const displayModeMQ = window.matchMedia("(display-mode: fullscreen)");
  let isCurrentlyFullscreen = false;

  function isFullscreen() {
    return Boolean(document.fullscreenElement) ||
      displayModeMQ.matches ||
      (Math.abs(window.innerHeight - screen.height) <= 1 && Math.abs(window.innerWidth - screen.width) <= 1);
  }

  function hideChromeNow() {
    clearTimeout(idleTimer);
    if (chrome.contains(document.activeElement)) document.activeElement.blur();
    chrome.classList.add("is-hidden");
    document.body.classList.add("is-idle");
  }

  /* ---------- Keyboard & presenter clickers ---------- */
  document.addEventListener("keydown", (e) => {
    if (e.key === "F11") {
      // Browser toggles fullscreen on F11; schedule check to update bar visibility
      setTimeout(handleFullscreenChange, 80);
      setTimeout(handleFullscreenChange, 250);
      return;
    }
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || drag) return;
    const onControl = e.target.closest && e.target.closest("a, button, input, select, textarea");
    switch (e.key) {
      case "ArrowRight": case "ArrowDown": case "PageDown": next(); break;
      case "ArrowLeft": case "ArrowUp": case "PageUp": prev(); break;
      case " ": if (onControl) return; if (e.shiftKey) prev(); else next(); break;
      case "Enter": if (onControl) return; next(); break;
      case "Home": goTo(0); break;
      case "End": goTo(n - 1); break;
      case "f": case "F": toggleFullscreen(); break;
      default: return;
    }
    e.preventDefault();
  });

  /* ---------- Controls ---------- */
  btnPrev.addEventListener("click", prev);
  btnNext.addEventListener("click", next);
  btnFull.addEventListener("click", toggleFullscreen);

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      const req = document.documentElement.requestFullscreen;
      if (req) {
        req.call(document.documentElement)
          .then(() => hideChromeNow())
          .catch(() => {});
      }
    } else if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }

  function handleFullscreenChange() {
    const active = isFullscreen();
    if (active === isCurrentlyFullscreen) return;
    isCurrentlyFullscreen = active;
    btnFull.setAttribute("aria-label", active ? "Exit full screen (F)" : "Enter full screen (F)");
    if (active) {
      hideChromeNow();
    } else {
      wake();
    }
  }

  document.addEventListener("fullscreenchange", handleFullscreenChange);
  if (displayModeMQ.addEventListener) {
    displayModeMQ.addEventListener("change", handleFullscreenChange);
  }
  window.addEventListener("resize", handleFullscreenChange);

  /* Controls float in, then step aside while you present */
  let idleTimer = 0;
  function wake() {
    if (isFullscreen()) return; // In fullscreen mode, mouse movement will not bring it back
    chrome.classList.remove("is-hidden");
    document.body.classList.remove("is-idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(sleep, 2600);
  }
  function sleep() {
    if (isFullscreen()) {
      hideChromeNow();
      return;
    }
    if (chrome.matches(":hover") || chrome.querySelector(":focus-visible")) {
      idleTimer = setTimeout(sleep, 1500);
      return;
    }
    hideChromeNow();
  }
  document.addEventListener("pointermove", wake, { passive: true });
  document.addEventListener("pointerdown", wake, { passive: true });
  chrome.addEventListener("focusin", () => {
    if (!isFullscreen()) wake();
  });

  /* ---------- Demo video ----------
     Plays from the start when its slide arrives, pauses when you leave.
     Muted and looping by default, so it never talks over you.
     data-sound: plays with its own sound (the live-demo slide). If the browser
       refuses sound, it plays muted and the sound button turns pink.
     data-once: plays once and stops on the last frame; press play to replay.
     A [data-video-meter] on the same slide shows progress and time.
     Tapping the video pauses it.
     Reduced motion: nothing autoplays; press play. */
  const clock = (t) => {
    const s = Math.max(0, Math.round(t || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  const media = slides.map((s) => Array.from(s.querySelectorAll("video[data-autoplay]")).map((video) => {
    const phone = video.closest(".phone") || video.parentElement;
    const playBtn = phone.querySelector(".phone__play");
    const once = video.hasAttribute("data-once");
    const meter = video.hasAttribute("data-sound") ? s.querySelector("[data-video-meter]") : null;
    const m = { video };
    video.muted = !video.hasAttribute("data-sound");

    const showMuted = () => {
      if (!meter) return;
      meter.classList.toggle("is-muted", video.muted);
      const btn = meter.querySelector("[data-video-sound]");
      if (btn) btn.setAttribute("aria-label", video.muted ? "Unmute demo" : "Mute demo");
    };

    m.play = (fromStart) => {
      if (fromStart) {
        try { video.currentTime = 0; } catch (_) { /* not seekable yet */ }
      }
      const p = video.play();
      if (p && p.catch) p.catch((err) => {
        if (video.muted || !err || err.name !== "NotAllowedError") { phone.classList.add("is-paused"); return; }
        video.muted = true;                       // sound refused: play silently instead
        showMuted();
        video.play().catch(() => phone.classList.add("is-paused"));
      });
    };

    video.addEventListener("play", () => phone.classList.remove("is-paused"));
    video.addEventListener("pause", () => { if (!video.ended) phone.classList.add("is-paused"); });
    video.addEventListener("ended", () => {
      if (once) { phone.classList.add("is-paused"); return; }
      video.currentTime = 0;
      video.play().catch(() => phone.classList.add("is-paused"));
    });
    video.addEventListener("click", () => { if (video.paused) m.play(false); else video.pause(); });
    if (playBtn) playBtn.addEventListener("click", () => m.play(false));
    phone.classList.add("is-paused");

    // the phone takes the recording's own shape, so nothing is cropped
    const fitShape = () => {
      if (video.videoWidth && video.videoHeight) phone.style.setProperty("--ar", `${video.videoWidth} / ${video.videoHeight}`);
    };
    video.addEventListener("loadedmetadata", fitShape);
    fitShape();

    if (meter) {
      const fill = meter.querySelector(".demo__fill");
      const now = meter.querySelector("[data-video-time]");
      const total = meter.querySelector("[data-video-duration]");
      const soundBtn = meter.querySelector("[data-video-sound]");
      let raf = 0;
      const draw = () => {
        const d = video.duration || 0;
        if (fill) fill.style.setProperty("--p", d ? String(Math.min(1, video.currentTime / d)) : "0");
        if (now) now.textContent = clock(video.currentTime);
        if (total && d && isFinite(d)) total.textContent = clock(d);
      };
      const tick = () => { draw(); raf = video.paused ? 0 : requestAnimationFrame(tick); };
      video.addEventListener("play", () => { if (!raf) raf = requestAnimationFrame(tick); });
      ["loadedmetadata", "seeked", "pause", "ended", "timeupdate"].forEach((e) => video.addEventListener(e, draw));
      if (soundBtn) soundBtn.addEventListener("click", () => { video.muted = !video.muted; showMuted(); });
      draw();
      showMuted();
    }
    return m;
  }));

  function syncMedia() {
    media.forEach((list, i) => list.forEach((m) => {
      if (i === index) {
        if (!reduced) m.play(true);
      } else if (!m.video.paused) {
        m.video.pause();
      }
    }));
  }

  /* ---------- Resize, deep links ---------- */
  new ResizeObserver(() => {
    width = stage.clientWidth || 1;
    render(spring.value);
  }).observe(stage);

  window.addEventListener("hashchange", () => {
    const i = indexFromHash();
    if (i !== null && i !== index) goTo(i);
  });

  /* ---------- Start ---------- */
  render(index);
  updateUI();
  slides[index].classList.remove("is-visible"); // let the first slide's reveal play
  requestAnimationFrame(() => requestAnimationFrame(() => slides[index].classList.add("is-visible")));
  wake();

  // Expose a tiny API for debugging / automation
  window.deck = { goTo, next, prev, get index() { return index; }, count: n };
})();
