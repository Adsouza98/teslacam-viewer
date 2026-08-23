/**
 * TeslaCam Viewer - Frontend
 * Folder-level events with sequential 1-minute clip playback
 */

(() => {
  "use strict";

  let events = [];
  let totalEvents = 0;
  let currentOffset = 0;
  const PAGE_SIZE = 50;
  let currentFilter = "";
  let fromDate = "";
  let toDate = "";
  let activeEvent = null;
  let videos = [];
  let isPlaying = false;
  let isMuted = true;
  let duration = 0;
  let lastTap = { time: 0, tile: null };
  let overlaySrc = null;
  let overlayResumeAt = 0;
  let segmentDurations = [];
  let segmentIndex = 0;
  let cameras = [];
  let advancing = false;
  let playGen = 0;
  let seeking = false;
  let buffering = false;
  let overlayShown = false;
  let overlayTimer = null;
  let resumeTimer = null;
  let syncTimer = null;
  let resuming = false;
  let stallSince = 0;
  let frozenTicks = 0;
  const PREFETCH_LEAD = 12;
  const SYNC_SLACK = 1.0;
  const SHOW_BUFFER_MS = 500;
  const WATCH_MS = 500;

  const $ = (sel) => document.querySelector(sel);
  const appEl = $("#app");
  const eventList = $("#eventList");
  const eventCount = $("#eventCount");
  const statusEl = $("#status");
  const emptyState = $("#emptyState");
  const playerContainer = $("#playerContainer");
  const cameraGrid = $("#cameraGrid");
  const loadMore = $("#loadMore");
  const loadMoreBtn = $("#loadMoreBtn");
  const seekBar = $("#seekBar");
  const timeDisplay = $("#timeDisplay");
  const syncPlayBtn = $("#syncPlayBtn");
  const skipBackBtn = $("#skipBackBtn");
  const skipFwdBtn = $("#skipFwdBtn");
  const backToListBtn = $("#backToListBtn");
  const frontFsBtn = $("#frontFsBtn");
  const fsLayer = $("#fsLayer");
  let fsVideo = $("#fsVideo");
  let fsStandby = $("#fsStandby");
  const fsLabel = $("#fsLabel");
  const fsCloseBtn = $("#fsCloseBtn");
  const playerListBtn = $("#playerListBtn");
  const fsSeekBar = $("#fsSeekBar");
  const fsTime = $("#fsTime");
  const fsPlayBtn = $("#fsPlayBtn");
  const fsSkipBackBtn = $("#fsSkipBackBtn");
  const fsSkipFwdBtn = $("#fsSkipFwdBtn");
  const hudBtn = $("#hudBtn");
  const hudEl = $("#hud");
  const hudAp = $("#hudAp");
  const hudApVer = $("#hudApVer");
  const hudWheel = $("#hudWheel");
  const hudAccelFill = $("#hudAccelFill");
  const hudBrake = $("#hudBrake");
  const hudSpeed = $("#hudSpeed");
  const hudGear = $("#hudGear");
  const hudBlinkL = $("#hudBlinkL");
  const hudBlinkR = $("#hudBlinkR");
  const sidebarScrim = $("#sidebarScrim");

  let telemetry = null;
  let hudEnabled = localStorage.getItem("teslacam-hud") !== "0";

  const CAMERA_LAYOUT = [
    "left_pillar",
    "front",
    "right_pillar",
    "left_repeater",
    "back",
    "right_repeater",
  ];

  function orderedCameras(cameras) {
    const entries = [];
    const seen = new Set();
    CAMERA_LAYOUT.forEach((name) => {
      if (cameras[name]) {
        entries.push([name, cameras[name]]);
        seen.add(name);
      }
    });
    Object.entries(cameras).forEach(([name, file]) => {
      if (!seen.has(name)) entries.push([name, file]);
    });
    return entries;
  }

  function masterVideo() {
    const c = cameras.find((x) => x.cam === "front") || cameras[0];
    if (c) return c.active;
    return videos.find((v) => v._cam === "front") || videos[0];
  }

  function fileUrl(files, idx) {
    if (!files || !files.length) return null;
    return files[Math.min(Math.max(0, idx), files.length - 1)];
  }

  function srcMatches(video, url) {
    if (!video || !url) return false;
    const src = video.currentSrc || video.getAttribute("src") || "";
    if (!src) return false;
    if (src === url) return true;
    const name = url.split("/").pop();
    return !!(name && src.includes(name));
  }

  function setVideoSrc(video, url, idx) {
    if (!video || !url) return false;
    if (video._idx === idx && srcMatches(video, url)) return false;
    video._idx = idx;
    video.preload = "auto";
    video.src = url;
    return true;
  }

  function readyEnough(video, url, idx) {
    return !!(video && video._idx === idx && srcMatches(video, url) && video.readyState >= 2);
  }

  function waitReady(video, minState = 2) {
    return new Promise((resolve) => {
      if (!video || video.readyState >= minState) {
        resolve();
        return;
      }
      const done = () => resolve();
      video.addEventListener("loadeddata", done, { once: true });
      video.addEventListener("canplay", done, { once: true });
      video.addEventListener("error", done, { once: true });
      setTimeout(done, 5000);
    });
  }

  function makePlayerVideo(files, cam) {
    const v = document.createElement("video");
    v.preload = "auto";
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.setAttribute("webkit-playsinline", "");
    v.muted = isMuted;
    v._files = files;
    v._idx = -1;
    v._cam = cam;
    v.addEventListener("timeupdate", onBufferedTimeUpdate);
    v.addEventListener("ended", () => onSegmentEnded(v));
    wireStallHandlers(v);
    return v;
  }

  function liveVideos() {
    if (overlayOpen() && fsVideo) return [fsVideo];
    return cameras.map((c) => c.active).filter(Boolean);
  }

  function clockVideo() {
    return overlayOpen() ? fsVideo : masterVideo();
  }

  function showBuffering(on) {
    buffering = !!on;
    const el = $("#bufferingOverlay");
    const fsEl = $("#fsBuffering");
    if (!on) {
      if (overlayTimer) {
        clearTimeout(overlayTimer);
        overlayTimer = null;
      }
      overlayShown = false;
      if (el) el.hidden = true;
      if (fsEl) fsEl.hidden = true;
      return;
    }
    if (overlayShown || overlayTimer) return;
    overlayTimer = setTimeout(() => {
      overlayTimer = null;
      if (!buffering) return;
      overlayShown = true;
      if (el) el.hidden = false;
      if (fsEl) fsEl.hidden = false;
    }, SHOW_BUFFER_MS);
  }

  function pauseLive() {
    liveVideos().forEach((v) => {
      try { v.pause(); } catch (_) {}
    });
  }

  function maxDrift() {
    const master = clockVideo();
    if (!master) return 0;
    const t = master.currentTime || 0;
    let max = 0;
    liveVideos().forEach((v) => {
      if (v === master || v.ended) return;
      const d = Math.abs((v.currentTime || 0) - t);
      if (d > max) max = d;
    });
    return max;
  }

  function allReady(minState = 2) {
    return liveVideos().every((v) => {
      if (!v || v.error || v.ended) return true;
      return v.readyState >= minState;
    });
  }

  function isNearEnd(v) {
    if (!v) return false;
    if (v.ended) return true;
    const dur = v.duration;
    return isFinite(dur) && dur > 0 && v.currentTime >= dur - 0.45;
  }

  function anyFrozen() {
    if (!isPlaying || overlayOpen() || buffering || seeking || resuming) return false;
    const master = masterVideo();
    if (!master || master.ended || isNearEnd(master)) return false;
    return cameras.some((c) => {
      const v = c.active;
      if (!v || v === master) return false;
      if (isNearEnd(v)) return false;
      return v.paused && (master.currentTime || 0) > 0.6;
    });
  }

  function isLiveVideo(v) {
    if (!v) return false;
    if (overlayOpen()) return v === fsVideo;
    return cameras.some((c) => c.active === v);
  }

  function scheduleResume(delay) {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      resumeInSync();
    }, delay);
  }

  async function resumeInSync() {
    if (!isPlaying || seeking || advancing) {
      showBuffering(false);
      return;
    }
    const master = clockVideo();
    if (!master) return;
    resuming = true;
    const t = master.currentTime || 0;
    const targets = liveVideos();
    targets.forEach((v) => {
      if (v.ended || isNearEnd(v)) return;
      try {
        if (Math.abs((v.currentTime || 0) - t) > 0.45) v.currentTime = t;
      } catch (_) {}
    });
    await Promise.all(targets.map((v) => waitReady(v, 2)));
    resuming = false;
    if (!isPlaying || seeking) return;
    if (!allReady(2)) {
      showBuffering(true);
      scheduleResume(280);
      return;
    }
    stallSince = 0;
    frozenTicks = 0;
    showBuffering(false);
    await Promise.all(targets.map((v) => v.play().catch(() => {})));
  }

  function onVideoWaiting(ev) {
    if (!isPlaying || seeking || advancing || resuming) return;
    const v = ev && ev.target;
    if (v && !isLiveVideo(v)) return;
    if (!stallSince) stallSince = Date.now();
  }

  function onVideoCanPlay() {
    stallSince = 0;
    if (buffering && isPlaying && !seeking) scheduleResume(60);
  }

  function wireStallHandlers(v) {
    v.addEventListener("waiting", onVideoWaiting);
    v.addEventListener("stalled", onVideoWaiting);
    v.addEventListener("canplay", onVideoCanPlay);
  }

  function watchdogTick() {
    if (!isPlaying || seeking || advancing || resuming) return;
    if (!cameras.length && !overlayOpen()) return;
    const master = clockVideo();
    if (!master) return;

    const drift = maxDrift();
    const stalledLong = stallSince && Date.now() - stallSince > 400;
    if (anyFrozen()) frozenTicks += 1;
    else frozenTicks = 0;

    const needsHold = drift > SYNC_SLACK || frozenTicks >= 2 || stalledLong;
    if (!needsHold) {
      if (buffering) scheduleResume(0);
      return;
    }
    showBuffering(true);
    pauseLive();
    scheduleResume(80);
  }

  function startWatchdog() {
    if (syncTimer) return;
    syncTimer = setInterval(watchdogTick, WATCH_MS);
  }

  function stopWatchdog() {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
    stallSince = 0;
    frozenTicks = 0;
    resuming = false;
    showBuffering(false);
  }

  function syncVideoList() {
    videos = cameras.map((c) => c.active);
  }

  function prefetchNext(idx) {
    const next = idx + 1;
    cameras.forEach((c) => {
      if (next >= c.files.length) return;
      setVideoSrc(c.standby, c.files[next], next);
    });
    if (overlayOpen() && fsStandby && overlaySrc) {
      const files = overlaySrc._files || [];
      if (next < files.length) setVideoSrc(fsStandby, files[next], next);
    }
  }

  function maybePrefetch() {
    const master = overlayOpen() ? fsVideo : masterVideo();
    if (!master) return;
    const dur = master.duration || segmentDurations[segmentIndex] || 60;
    const remain = dur - (master.currentTime || 0);
    if (remain <= PREFETCH_LEAD) prefetchNext(segmentIndex);
  }

  function maybeAutoAdvance(video) {
    if (!isPlaying || advancing || seeking) return;
    const master = overlayOpen() ? fsVideo : masterVideo();
    if (video !== master) return;
    const dur = video.duration;
    if (!isFinite(dur) || dur <= 0) return;
    if (dur - (video.currentTime || 0) > 0.12) return;
    const files = master._files || [];
    if (segmentIndex + 1 < files.length) advanceSegment(true);
  }

  function onBufferedTimeUpdate(ev) {
    const video = ev.target;
    const isActive = cameras.some((c) => c.active === video);
    if (!isActive && video !== fsVideo) return;
    if (masterVideo() === video && !seeking && !overlayOpen()) {
      seekBar.value = globalTime();
      updateTimeDisplay();
      updateHud();
    }
    maybePrefetch();
    maybeAutoAdvance(video);
  }

  function promoteStandby(c) {
    c.active.pause();
    c.active.classList.remove("active");
    c.active.classList.add("standby");
    c.standby.classList.remove("standby");
    c.standby.classList.add("active");
    const old = c.active;
    c.active = c.standby;
    c.standby = old;
  }

  function promoteFsStandby() {
    if (!fsVideo || !fsStandby) return;
    fsVideo.pause();
    fsVideo.classList.remove("active");
    fsVideo.classList.add("standby");
    fsStandby.classList.remove("standby");
    fsStandby.classList.add("active");
    const old = fsVideo;
    fsVideo = fsStandby;
    fsStandby = old;
  }

  async function advanceSegment(play) {
    if (advancing) return;
    const master = masterVideo();
    const files = (master && master._files) || [];
    if (segmentIndex + 1 >= files.length) {
      setPlaying(false);
      return;
    }
    advancing = true;
    try {
      await applySegment(segmentIndex + 1, 0, play, playGen);
      if (play) setPlaying(true);
    } finally {
      advancing = false;
    }
  }

  function findTelemetrySample(t, idx) {
    if (!telemetry || !telemetry.available || !telemetry.segments) return null;
    const seg = telemetry.segments[idx];
    if (!seg || !seg.samples || !seg.samples.length) return null;
    const samples = seg.samples;
    let lo = 0;
    let hi = samples.length - 1;
    if (t <= samples[0].t) return samples[0];
    if (t >= samples[hi].t) return samples[hi];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    const a = samples[Math.max(0, lo - 1)];
    const b = samples[lo];
    return t - a.t <= b.t - t ? a : b;
  }

  function updateHud() {
    if (!hudEl) return;
    if (!hudEnabled || !telemetry || !telemetry.available) {
      hudEl.hidden = true;
      return;
    }
    const master = masterVideo();
    const idx = master && Number.isInteger(master._idx) ? master._idx : segmentIndex;
    const t = master ? master.currentTime || 0 : 0;
    const s = findTelemetrySample(t, idx);
    if (!s) {
      hudEl.hidden = true;
      return;
    }
    hudEl.hidden = false;
    const ap = s.ap || "NONE";
    if (hudAp) {
      hudAp.textContent = ap === "NONE" ? "MANUAL" : ap;
      hudAp.className =
        "hud-ap" + (ap === "FSD" ? " on-fsd" : ap === "AUTOSTEER" ? " on-ap" : ap === "TACC" ? " on-tacc" : "");
    }
    if (hudApVer) {
      const ver = s.fw || (telemetry && telemetry.fsd_version);
      if (ver) {
        hudApVer.hidden = false;
        hudApVer.textContent = String(ver).startsWith("v") ? String(ver) : `v${ver}`;
      } else {
        hudApVer.hidden = true;
        hudApVer.textContent = "";
      }
    }
    if (hudWheel) {
      const deg = Math.max(-140, Math.min(140, s.steer || 0));
      hudWheel.style.transform = `rotate(${deg}deg)`;
      hudWheel.classList.toggle("on-fsd", ap === "FSD");
    }
    if (hudAccelFill) {
      const pct = Math.max(0, Math.min(100, (s.accel || 0) * 100));
      hudAccelFill.style.setProperty("--fill", `${pct}%`);
    }
    if (hudBrake) hudBrake.classList.toggle("on", !!s.brake);
    if (hudSpeed) hudSpeed.textContent = Math.round(s.speed || 0);
    if (hudGear) hudGear.textContent = s.gear || "P";
    if (hudBlinkL) hudBlinkL.classList.toggle("on", !!s.bl);
    if (hudBlinkR) hudBlinkR.classList.toggle("on", !!s.br);
  }

  async function loadTelemetry(event) {
    telemetry = null;
    if (hudEl) hudEl.hidden = true;
    try {
      const res = await fetch(`/api/telemetry/${encodeURIComponent(event.id)}`);
      if (!res.ok) return;
      telemetry = await res.json();
      updateHud();
    } catch (_) {
      telemetry = null;
    }
  }

  function syncHudButton() {
    if (hudBtn) hudBtn.classList.toggle("active", hudEnabled);
  }

  function prefersCssOverlay() {
    return (
      window.matchMedia("(pointer: coarse)").matches ||
      window.matchMedia("(max-width: 900px)").matches ||
      window.matchMedia("(hover: none)").matches
    );
  }

  async function fetchEvents(offset = 0, append = false) {
    statusEl.textContent = "Loading…";
    const params = new URLSearchParams({
      limit: PAGE_SIZE,
      offset: offset,
    });
    if (currentFilter) params.set("type", currentFilter);
    if (fromDate) params.set("from_date", fromDate);
    if (toDate) params.set("to_date", toDate);

    try {
      const res = await fetch(`/api/events?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      totalEvents = data.total;
      events = append ? events.concat(data.events) : data.events;
      currentOffset = offset + data.events.length;

      renderEventList();
      eventCount.textContent = `${totalEvents} event${totalEvents !== 1 ? "s" : ""}`;
      statusEl.textContent = "Ready";
      loadMore.style.display = currentOffset < totalEvents ? "block" : "none";
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Error loading events";
      eventList.innerHTML = `<div style="padding:1rem;color:var(--danger)">Failed to load events.<br>${err.message}</div>`;
    }
  }

  function formatDateTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function formatShortTime(iso) {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function eventTitle(e) {
    if (e.datetime_end && e.clip_count > 1) {
      const start = new Date(e.datetime);
      const end = new Date(e.datetime_end);
      const sameDay = start.toDateString() === end.toDateString();
      const day = start.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
      if (sameDay) {
        return `${day} · ${formatShortTime(e.datetime)}–${formatShortTime(e.datetime_end)}`;
      }
      return `${formatDateTime(e.datetime)} – ${formatDateTime(e.datetime_end)}`;
    }
    return formatDateTime(e.datetime);
  }

  function cameraFiles(event, cam, filename) {
    const segs = event.segments && event.segments[cam];
    if (Array.isArray(segs) && segs.length) return segs;
    return filename ? [filename] : [];
  }

  function mediaUrl(event, filename) {
    return `/media/${event.path}/${filename}`;
  }

  function renderEventList() {
    if (events.length === 0) {
      eventList.innerHTML = `<div style="padding:1.5rem;text-align:center;color:var(--text-muted)">No events found</div>`;
      return;
    }

    eventList.innerHTML = events
      .map((e) => {
        const camCount = Object.keys(e.cameras).length;
        const clips = e.clip_count || 1;
        const thumbUrl = e.thumb
          ? `/media/${e.path}/${e.thumb}`
          : `/api/thumb/${encodeURIComponent(e.id)}`;
        const clipLabel =
          clips > 1
            ? `${clips} clips · ${camCount} camera${camCount !== 1 ? "s" : ""}`
            : `${camCount} camera${camCount !== 1 ? "s" : ""}`;

        return `
          <div class="event-card ${activeEvent?.id === e.id ? "active" : ""}" data-id="${e.id}">
            <img class="event-thumb" src="${thumbUrl}" alt="" loading="lazy"
                 onerror="this.style.background='var(--bg-tertiary)';this.removeAttribute('src');" />
            <div class="event-details">
              <div class="event-type ${e.type.toLowerCase()}">${e.type}</div>
              <div class="event-time">${eventTitle(e)}</div>
              <div class="event-cams">${clipLabel}</div>
            </div>
          </div>
        `;
      })
      .join("");

    eventList.querySelectorAll(".event-card").forEach((card) => {
      card.addEventListener("click", () => {
        const ev = events.find((x) => x.id === card.dataset.id);
        if (ev) selectEvent(ev);
      });
    });
  }

  function setEventOpen(open) {
    appEl.classList.toggle("event-open", open);
    if (open) appEl.classList.add("sidebar-collapsed");
    else appEl.classList.remove("sidebar-collapsed");
    if (backToListBtn) backToListBtn.hidden = !open;
    if (playerListBtn) playerListBtn.hidden = !open;
    syncScrim();
  }

  function toggleSidebar() {
    if (!appEl.classList.contains("event-open")) return;
    appEl.classList.toggle("sidebar-collapsed");
    syncScrim();
  }

  function syncScrim() {
    if (!sidebarScrim) return;
    const show =
      appEl.classList.contains("event-open") &&
      !appEl.classList.contains("sidebar-collapsed");
    sidebarScrim.hidden = !show;
  }

  function setPlaying(playing) {
    isPlaying = playing;
    const label = playing ? "⏸ Pause" : "▶ Play";
    if (syncPlayBtn) syncPlayBtn.textContent = label;
    if (fsPlayBtn) fsPlayBtn.textContent = label;
  }

  function exitNativeFs() {
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }

  function overlayOpen() {
    return fsLayer && !fsLayer.hidden;
  }

  function totalDuration() {
    if (segmentDurations.length) {
      return segmentDurations.reduce((a, b) => a + (b || 0), 0);
    }
    return duration;
  }

  function prefixDuration(idx) {
    let acc = 0;
    for (let i = 0; i < idx && i < segmentDurations.length; i++) {
      acc += segmentDurations[i] || 0;
    }
    return acc;
  }

  function globalTime() {
    const src = overlayOpen() ? fsVideo : masterVideo();
    if (!src) return 0;
    return prefixDuration(segmentIndex) + (src.currentTime || 0);
  }

  function locateSegment(time) {
    const total = totalDuration();
    const t = Math.max(0, Math.min(time, total || time));
    if (!segmentDurations.length) return { idx: 0, offset: t };
    let acc = 0;
    for (let i = 0; i < segmentDurations.length; i++) {
      const d = segmentDurations[i] || 0;
      if (t < acc + d || i === segmentDurations.length - 1) {
        const offset = Math.min(Math.max(0, t - acc), Math.max(0, d - 0.05));
        return { idx: i, offset };
      }
      acc += d;
    }
    return { idx: 0, offset: 0 };
  }

  function probeDuration(url) {
    return new Promise((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      const done = (val) => {
        v.removeAttribute("src");
        v.load();
        resolve(val);
      };
      const timer = setTimeout(() => done(60), 8000);
      v.onloadedmetadata = () => {
        clearTimeout(timer);
        done(isFinite(v.duration) && v.duration > 0 ? v.duration : 60);
      };
      v.onerror = () => {
        clearTimeout(timer);
        done(60);
      };
      v.src = url;
    });
  }

  async function probePlaylist(urls, gen) {
    const durs = await Promise.all(urls.map(probeDuration));
    if (gen !== playGen) return;
    segmentDurations = durs;
    duration = durs.reduce((a, b) => a + b, 0);
    seekBar.max = duration || 100;
    if (fsSeekBar) fsSeekBar.max = duration || 100;
    updateTimeDisplay();
  }

  function waitMeta(video) {
    return waitReady(video, 1);
  }

  function loadAllSegments(idx) {
    cameras.forEach((c) => {
      const url = fileUrl(c.files, idx);
      if (!url) return;
      if (c.active._idx === idx && srcMatches(c.active, url)) {
        c.active._idx = idx;
        return;
      }
      if (c.standby._idx === idx && srcMatches(c.standby, url) && c.standby.readyState >= 1) {
        promoteStandby(c);
        return;
      }
      setVideoSrc(c.active, url, idx);
    });
    syncVideoList();
    segmentIndex = idx;
    if (overlayOpen() && overlaySrc) {
      const files = overlaySrc._files || [];
      const url = fileUrl(files, idx);
      if (url && fsStandby && srcMatches(fsStandby, url) && fsStandby.readyState >= 1) {
        promoteFsStandby();
      } else if (url && fsVideo && !srcMatches(fsVideo, url)) {
        setVideoSrc(fsVideo, url, idx);
      }
      const cam = cameras.find((c) => c.cam === overlaySrc._cam);
      if (cam) overlaySrc = cam.active;
    }
  }

  async function applySegment(idx, offset, play, gen) {
    if (gen !== playGen) return;
    idx = Math.max(0, idx);
    loadAllSegments(idx);
    const targets = cameras.map((c) => c.active);
    if (overlayOpen() && fsVideo) targets.push(fsVideo);
    await Promise.all(targets.map((v) => waitReady(v, 2)));
    if (gen !== playGen) return;
    targets.forEach((v) => {
      try {
        if (Math.abs((v.currentTime || 0) - offset) > 0.2) v.currentTime = offset;
      } catch (_) {}
      v.muted = isMuted;
    });
    if (play) {
      showBuffering(false);
      await Promise.all(targets.map((v) => v.play().catch(() => {})));
      startWatchdog();
    }
    prefetchNext(idx);
  }

  function onSegmentEnded(video) {
    const master = overlayOpen() ? fsVideo : masterVideo();
    if (video !== master) return;
    const files = (master && master._files) || [];
    if (segmentIndex + 1 < files.length) {
      advanceSegment(true);
    } else {
      setPlaying(false);
      stopWatchdog();
    }
  }

  function closeOverlay() {
    if (!overlayOpen()) return;
    const t = globalTime();
    fsVideo.pause();
    fsLayer.hidden = true;
    [fsVideo, fsStandby].forEach((v) => {
      if (!v) return;
      v.pause();
      v.removeAttribute("src");
      v._idx = -1;
      try { v.load(); } catch (_) {}
    });
    overlaySrc = null;
    overlayResumeAt = t;
    if (isPlaying) {
      startWatchdog();
      seekTo(t);
    } else {
      seekTo(t);
    }
  }

  function openOverlay(tile) {
    const video = tile.querySelector("video.active") || tile.querySelector("video");
    if (!video || !fsLayer || !fsVideo) return;
    overlaySrc = video;
    overlayResumeAt = video.currentTime || 0;
    fsVideo._files = video._files;
    fsVideo._cam = video._cam;
    if (fsStandby) {
      fsStandby._files = video._files;
      fsStandby._cam = video._cam;
    }
    fsLabel.textContent = (tile.querySelector(".camera-label")?.textContent || "Camera").trim();
    fsVideo.muted = isMuted;
    fsVideo.classList.add("active");
    fsVideo.classList.remove("standby");
    if (fsStandby) {
      fsStandby.classList.add("standby");
      fsStandby.classList.remove("active");
    }
    setVideoSrc(fsVideo, video.currentSrc || video.src, video._idx >= 0 ? video._idx : segmentIndex);
    if (fsSeekBar) {
      fsSeekBar.max = totalDuration() || video.duration || 100;
      fsSeekBar.value = globalTime();
    }
    fsLayer.hidden = false;
    cameras.forEach((c) => {
      c.active.pause();
      c.standby.pause();
    });

    const start = () => {
      try {
        fsVideo.currentTime = overlayResumeAt;
      } catch (_) {}
      fsVideo.play().catch(() => {});
      setPlaying(true);
      prefetchNext(segmentIndex);
    };

    if (fsVideo.readyState >= 1) start();
    else fsVideo.addEventListener("loadedmetadata", start, { once: true });
  }

  function toggleTileFullscreen(tile) {
    if (overlayOpen()) {
      closeOverlay();
      return;
    }

    const video = tile.querySelector("video.active") || tile.querySelector("video");
    const nativeEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (nativeEl === tile || nativeEl === video) {
      exitNativeFs();
      return;
    }

    if (prefersCssOverlay()) {
      openOverlay(tile);
      return;
    }

    const req = tile.requestFullscreen
      ? tile.requestFullscreen()
      : video && video.requestFullscreen
        ? video.requestFullscreen()
        : null;

    if (req && typeof req.then === "function") {
      req.catch(() => openOverlay(tile));
      return;
    }

    if (video && video.webkitEnterFullscreen) {
      try {
        video.webkitEnterFullscreen();
        return;
      } catch (_) {}
    }

    openOverlay(tile);
  }

  function fullscreenPreferredCamera() {
    const tiles = [...cameraGrid.querySelectorAll(".camera-tile")];
    if (!tiles.length) return;
    const front = tiles.find((t) => /front/i.test(t.querySelector(".camera-label")?.textContent || ""));
    toggleTileFullscreen(front || tiles[0]);
  }

  function selectEvent(event) {
    activeEvent = event;
    playGen += 1;
    const gen = playGen;
    setEventOpen(true);
    closeOverlay();
    exitNativeFs();

    eventList.querySelectorAll(".event-card").forEach((c) => {
      c.classList.toggle("active", c.dataset.id === event.id);
    });

    emptyState.style.display = "none";
    playerContainer.style.display = "flex";

    const badge = $("#eventTypeBadge");
    badge.textContent = event.type;
    badge.className = `event-type-badge ${event.type.toLowerCase()}`;
    $("#eventDatetime").textContent = eventTitle(event);

    const metaEl = $("#eventMeta");
    if (event.event) {
      metaEl.style.display = "block";
      const parts = [];
      if (event.event.reason) parts.push(`Reason: ${event.event.reason}`);
      if (event.event.camera) parts.push(`Trigger: ${event.event.camera}`);
      if (event.event.city) parts.push(`${event.event.city}`);
      metaEl.textContent = parts.join(" · ") || "Event metadata available";
    } else {
      metaEl.style.display = "none";
    }

    const cams = orderedCameras(event.cameras);
    const n = Math.min(cams.length, 6);
    const names = cams.map(([name]) => name);
    const hasPillars = names.includes("left_pillar") || names.includes("right_pillar");
    cameraGrid.className = `camera-grid cams-${n} tesla${hasPillars ? " has-pillars" : " no-pillars"}`;
    cameraGrid.innerHTML = "";

    cameras.forEach((c) => {
      [c.active, c.standby].forEach((v) => {
        v.pause();
        v.removeAttribute("src");
        try { v.load(); } catch (_) {}
      });
    });
    cameras = [];
    videos = [];
    advancing = false;
    stopWatchdog();
    setPlaying(false);
    duration = 0;
    segmentDurations = [];
    segmentIndex = 0;
    seekBar.value = 0;
    timeDisplay.textContent = "0:00 / 0:00";

    cams.forEach(([name, filename]) => {
      const files = cameraFiles(event, name, filename).map((f) => mediaUrl(event, f));
      const tile = document.createElement("div");
      tile.className = `camera-tile cam-${name}`;

      const label = document.createElement("div");
      label.className = "camera-label";
      label.textContent = name.replace(/_/g, " ");

      const fsBtn = document.createElement("button");
      fsBtn.type = "button";
      fsBtn.className = "cam-fs";
      fsBtn.title = "Fullscreen this camera";
      fsBtn.setAttribute("aria-label", `Fullscreen ${name.replace(/_/g, " ")}`);
      fsBtn.innerHTML = `<span class="cam-fs-text">Full</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`;
      fsBtn.addEventListener("pointerup", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        toggleTileFullscreen(tile);
      });

      const active = makePlayerVideo(files, name);
      active.className = "active";
      const standby = makePlayerVideo(files, name);
      standby.className = "standby";
      if (files[0]) setVideoSrc(active, files[0], 0);
      if (files[1]) setVideoSrc(standby, files[1], 1);

      active.addEventListener("loadedmetadata", () => {
        if (!segmentDurations.length && active.duration > duration) {
          duration = active.duration;
          seekBar.max = duration;
          if (fsSeekBar) fsSeekBar.max = duration;
          updateTimeDisplay();
        }
      });

      tile.addEventListener("pointerup", (ev) => {
        if (ev.target.closest(".cam-fs")) return;
        const now = Date.now();
        if (lastTap.tile === tile && now - lastTap.time < 350) {
          toggleTileFullscreen(tile);
          lastTap = { time: 0, tile: null };
        } else {
          lastTap = { time: now, tile };
        }
      });

      tile.appendChild(active);
      tile.appendChild(standby);
      tile.appendChild(label);
      tile.appendChild(fsBtn);
      cameraGrid.appendChild(tile);
      cameras.push({ cam: name, files, active, standby, tile });
    });
    syncVideoList();

    const master = masterVideo();
    if (master && master._files && master._files.length) {
      const guess = master._files.map(() => 60);
      segmentDurations = guess;
      duration = guess.reduce((a, b) => a + b, 0);
      seekBar.max = duration;
      if (fsSeekBar) fsSeekBar.max = duration;
      probePlaylist(master._files, gen);
    }
    loadTelemetry(event);
    prefetchNext(0);

    const activeCard = eventList.querySelector(".event-card.active");
    if (activeCard) activeCard.scrollIntoView({ block: "nearest" });
  }

  function showEventList() {
    closeOverlay();
    toggleSidebar();
  }

  function togglePlay() {
    if (overlayOpen()) {
      if (fsVideo.paused && !buffering) {
        setPlaying(true);
        startWatchdog();
        scheduleResume(0);
      } else {
        setPlaying(false);
        stopWatchdog();
        fsVideo.pause();
        cameras.forEach((c) => {
          c.active.pause();
          c.standby.pause();
        });
      }
      return;
    }
    if (!cameras.length) return;
    if (isPlaying) {
      setPlaying(false);
      stopWatchdog();
      cameras.forEach((c) => {
        c.active.pause();
        c.standby.pause();
      });
    } else {
      setPlaying(true);
      startWatchdog();
      const loc = locateSegment(globalTime());
      applySegment(loc.idx, loc.offset, true, playGen);
    }
  }

  function seekTo(time) {
    const loc = locateSegment(time);
    applySegment(loc.idx, loc.offset, isPlaying && !seeking, playGen);
    updateTimeDisplay();
  }

  function skipBy(delta) {
    seekTo(Math.max(0, Math.min(totalDuration(), globalTime() + delta)));
  }

  function formatTime(sec) {
    if (!isFinite(sec)) return "0:00";
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function updateTimeDisplay() {
    const cur = globalTime();
    const tot = totalDuration();
    timeDisplay.textContent = `${formatTime(cur)} / ${formatTime(tot)}`;
    if (fsTime) fsTime.textContent = `${formatTime(cur)} / ${formatTime(tot)}`;
    if (fsSeekBar && overlayOpen() && !seeking) fsSeekBar.value = cur;
  }

  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.dataset.type || "";
      currentOffset = 0;
      fetchEvents(0, false);
    });
  });

  $("#fromDate").addEventListener("change", (e) => {
    fromDate = e.target.value || "";
    currentOffset = 0;
    fetchEvents(0, false);
  });
  $("#toDate").addEventListener("change", (e) => {
    toDate = e.target.value || "";
    currentOffset = 0;
    fetchEvents(0, false);
  });
  $("#clearDates").addEventListener("click", () => {
    $("#fromDate").value = "";
    $("#toDate").value = "";
    fromDate = "";
    toDate = "";
    currentOffset = 0;
    fetchEvents(0, false);
  });

  $("#refreshBtn").addEventListener("click", () => {
    currentOffset = 0;
    fetchEvents(0, false);
  });

  if (backToListBtn) {
    backToListBtn.addEventListener("click", showEventList);
  }

  if (frontFsBtn) {
    frontFsBtn.addEventListener("click", fullscreenPreferredCamera);
  }

  if (hudBtn) {
    syncHudButton();
    hudBtn.addEventListener("click", () => {
      hudEnabled = !hudEnabled;
      localStorage.setItem("teslacam-hud", hudEnabled ? "1" : "0");
      syncHudButton();
      updateHud();
    });
  }

  if (playerListBtn) {
    playerListBtn.addEventListener("click", showEventList);
  }

  if (fsCloseBtn) {
    fsCloseBtn.addEventListener("click", closeOverlay);
  }
  if (fsPlayBtn) fsPlayBtn.addEventListener("click", togglePlay);
  if (sidebarScrim) sidebarScrim.addEventListener("click", toggleSidebar);

  function wireOverlayVideo(el) {
    if (!el) return;
    el.addEventListener("timeupdate", () => {
      if (!overlayOpen() || seeking || el !== fsVideo) return;
      seekBar.value = globalTime();
      updateTimeDisplay();
      updateHud();
      maybePrefetch();
      maybeAutoAdvance(el);
    });
    el.addEventListener("ended", () => onSegmentEnded(el));
    el.addEventListener("click", togglePlay);
    wireStallHandlers(el);
  }

  wireOverlayVideo(fsVideo);
  wireOverlayVideo(fsStandby);
  if (fsVideo) fsVideo.classList.add("active");
  if (fsStandby) fsStandby.classList.add("standby");

  loadMoreBtn.addEventListener("click", () => {
    fetchEvents(currentOffset, true);
  });

  syncPlayBtn.addEventListener("click", togglePlay);
  if (skipBackBtn) skipBackBtn.addEventListener("click", () => skipBy(-5));
  if (skipFwdBtn) skipFwdBtn.addEventListener("click", () => skipBy(5));
  if (fsSkipBackBtn) fsSkipBackBtn.addEventListener("click", () => skipBy(-5));
  if (fsSkipFwdBtn) fsSkipFwdBtn.addEventListener("click", () => skipBy(5));

  seekBar.addEventListener("pointerdown", () => (seeking = true));
  seekBar.addEventListener("input", () => {
    seekTo(parseFloat(seekBar.value));
  });
  seekBar.addEventListener("pointerup", () => {
    seeking = false;
    seekTo(parseFloat(seekBar.value));
  });
  seekBar.addEventListener("pointercancel", () => (seeking = false));

  if (fsSeekBar) {
    fsSeekBar.addEventListener("pointerdown", () => (seeking = true));
    fsSeekBar.addEventListener("input", () => seekTo(parseFloat(fsSeekBar.value)));
    fsSeekBar.addEventListener("pointerup", () => {
      seeking = false;
      seekTo(parseFloat(fsSeekBar.value));
    });
    fsSeekBar.addEventListener("pointercancel", () => (seeking = false));
  }

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.code === "Space") {
      e.preventDefault();
      togglePlay();
    } else if (e.code === "ArrowRight") {
      seekTo(Math.min(totalDuration(), globalTime() + 5));
    } else if (e.code === "ArrowLeft") {
      seekTo(Math.max(0, globalTime() - 5));
    } else if (e.code === "Escape") {
      closeOverlay();
      exitNativeFs();
    }
  });

  fetchEvents(0, false);
})();
