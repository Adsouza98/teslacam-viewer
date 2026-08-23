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
  let isMuted = false;
  let duration = 0;
  let lastTap = { time: 0, tile: null };
  let overlaySrc = null;
  let overlayResumeAt = 0;
  let segmentDurations = [];
  let segmentIndex = 0;
  let playGen = 0;
  let seeking = false;

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
  const syncMuteBtn = $("#syncMuteBtn");
  const backToListBtn = $("#backToListBtn");
  const frontFsBtn = $("#frontFsBtn");
  const fsLayer = $("#fsLayer");
  const fsVideo = $("#fsVideo");
  const fsLabel = $("#fsLabel");
  const fsCloseBtn = $("#fsCloseBtn");
  const playerListBtn = $("#playerListBtn");
  const fsSeekBar = $("#fsSeekBar");
  const fsTime = $("#fsTime");
  const fsPlayBtn = $("#fsPlayBtn");
  const fsMuteBtn = $("#fsMuteBtn");
  const hudBtn = $("#hudBtn");
  const hudEl = $("#hud");
  const hudAp = $("#hudAp");
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
    return videos.find((v) => v._cam === "front") || videos[0];
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
      hudAp.className = "hud-ap" + (ap === "FSD" ? " on-fsd" : ap === "AUTOSTEER" ? " on-ap" : ap === "TACC" ? " on-tacc" : "");
    }
    if (hudWheel) {
      const deg = Math.max(-140, Math.min(140, s.steer || 0));
      hudWheel.style.transform = `rotate(${deg}deg)`;
    }
    if (hudAccelFill) {
      const pct = Math.max(0, Math.min(100, (s.accel || 0) * 100));
      hudAccelFill.style.height = `${pct}%`;
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

  function setMutedUi() {
    const label = isMuted ? "🔇" : "🔊";
    if (syncMuteBtn) syncMuteBtn.textContent = label;
    if (fsMuteBtn) fsMuteBtn.textContent = label;
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
    return new Promise((resolve) => {
      if (video.readyState >= 1) {
        resolve();
        return;
      }
      const on = () => resolve();
      video.addEventListener("loadedmetadata", on, { once: true });
      video.addEventListener("error", on, { once: true });
    });
  }


  function loadAllSegments(idx) {
    let changed = false;
    videos.forEach((v) => {
      const files = v._files || [];
      if (!files.length) return;
      const use = Math.min(idx, files.length - 1);
      const url = files[use];
      if (v._idx !== use || !(v.currentSrc || v.src || "").includes(url.split("/").pop())) {
        v._idx = use;
        v.src = url;
        changed = true;
      } else {
        v._idx = use;
      }
    });
    segmentIndex = idx;
    if (overlayOpen() && overlaySrc) {
      const files = overlaySrc._files || [];
      const use = Math.min(idx, Math.max(0, files.length - 1));
      if (files[use]) fsVideo.src = files[use];
    }
    return changed;
  }

  async function applySegment(idx, offset, play, gen) {
    loadAllSegments(idx);
    const targets = videos.slice();
    if (overlayOpen()) targets.push(fsVideo);
    await Promise.all(targets.map(waitMeta));
    if (gen !== playGen) return;
    targets.forEach((v) => {
      try {
        if (Math.abs((v.currentTime || 0) - offset) > 0.15) v.currentTime = offset;
      } catch (_) {}
    });
    if (play) {
      videos.forEach((v) => v.play().catch(() => {}));
      if (overlayOpen()) fsVideo.play().catch(() => {});
    }
  }

  function onSegmentEnded(video) {
    const master = masterVideo();
    if (video !== master && !(overlayOpen() && video === fsVideo)) return;
    const files = (master && master._files) || [];
    if (segmentIndex + 1 < files.length) {
      applySegment(segmentIndex + 1, 0, true, playGen);
      setPlaying(true);
    } else {
      setPlaying(false);
    }
  }

  function closeOverlay() {
    if (!overlayOpen()) return;
    const t = globalTime();
    fsVideo.pause();
    fsLayer.hidden = true;
    fsVideo.removeAttribute("src");
    fsVideo.load();
    overlaySrc = null;
    overlayResumeAt = t;
    seekTo(t);
    if (isPlaying) {
      videos.forEach((v) => v.play().catch(() => {}));
    }
  }

  function openOverlay(tile) {
    const video = tile.querySelector("video");
    if (!video || !fsLayer || !fsVideo) return;
    overlaySrc = video;
    overlayResumeAt = video.currentTime || 0;
    fsLabel.textContent = (tile.querySelector(".camera-label")?.textContent || "Camera").trim();
    fsVideo.muted = isMuted;
    fsVideo.src = video.currentSrc || video.src;
    if (fsSeekBar) {
      fsSeekBar.max = totalDuration() || video.duration || 100;
      fsSeekBar.value = globalTime();
    }
    fsLayer.hidden = false;
    videos.forEach((v) => v.pause());

    const start = () => {
      try {
        fsVideo.currentTime = overlayResumeAt;
      } catch (_) {}
      fsVideo.play().catch(() => {});
      setPlaying(true);
    };

    if (fsVideo.readyState >= 1) start();
    else fsVideo.addEventListener("loadedmetadata", start, { once: true });
  }

  function toggleTileFullscreen(tile) {
    if (overlayOpen()) {
      closeOverlay();
      return;
    }

    const video = tile.querySelector("video");
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

    videos.forEach((v) => {
      v.pause();
      v.removeAttribute("src");
      v.load();
    });
    videos = [];
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

      const video = document.createElement("video");
      video.preload = "metadata";
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      video.muted = isMuted;
      video._files = files;
      video._idx = 0;
      video._cam = name;
      if (files[0]) video.src = files[0];

      video.addEventListener("loadedmetadata", () => {
        if (!segmentDurations.length && video.duration > duration) {
          duration = video.duration;
          seekBar.max = duration;
          if (fsSeekBar) fsSeekBar.max = duration;
          updateTimeDisplay();
        }
      });

      video.addEventListener("timeupdate", () => {
        if (masterVideo() === video && !seeking && !overlayOpen()) {
          seekBar.value = globalTime();
          updateTimeDisplay();
          updateHud();
        }
      });

      video.addEventListener("ended", () => onSegmentEnded(video));

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

      tile.appendChild(video);
      tile.appendChild(label);
      tile.appendChild(fsBtn);
      cameraGrid.appendChild(tile);
      videos.push(video);
    });

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

    const activeCard = eventList.querySelector(".event-card.active");
    if (activeCard) activeCard.scrollIntoView({ block: "nearest" });
  }

  function showEventList() {
    closeOverlay();
    toggleSidebar();
  }

  function togglePlay() {
    if (overlayOpen()) {
      if (fsVideo.paused) {
        fsVideo.play().catch(() => {});
        videos.forEach((v) => v.play().catch(() => {}));
        setPlaying(true);
      } else {
        fsVideo.pause();
        videos.forEach((v) => v.pause());
        setPlaying(false);
      }
      return;
    }
    if (!videos.length) return;
    if (isPlaying) {
      videos.forEach((v) => v.pause());
      setPlaying(false);
    } else {
      const loc = locateSegment(globalTime());
      applySegment(loc.idx, loc.offset, true, playGen);
      setPlaying(true);
    }
  }

  function toggleMute() {
    isMuted = !isMuted;
    videos.forEach((v) => (v.muted = isMuted));
    if (fsVideo) fsVideo.muted = isMuted;
    setMutedUi();
  }

  function seekTo(time) {
    const loc = locateSegment(time);
    applySegment(loc.idx, loc.offset, isPlaying && !seeking, playGen);
    updateTimeDisplay();
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
  if (fsMuteBtn) fsMuteBtn.addEventListener("click", toggleMute);
  if (sidebarScrim) sidebarScrim.addEventListener("click", toggleSidebar);

  if (fsVideo) {
    fsVideo.addEventListener("timeupdate", () => {
      if (!overlayOpen() || seeking) return;
      seekBar.value = globalTime();
      updateTimeDisplay();
      updateHud();
    });
    fsVideo.addEventListener("ended", () => onSegmentEnded(fsVideo));
    fsVideo.addEventListener("click", togglePlay);
  }

  loadMoreBtn.addEventListener("click", () => {
    fetchEvents(currentOffset, true);
  });

  syncPlayBtn.addEventListener("click", togglePlay);
  syncMuteBtn.addEventListener("click", toggleMute);

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
    } else if (e.code === "KeyM") {
      toggleMute();
    } else if (e.code === "Escape") {
      closeOverlay();
      exitNativeFs();
    }
  });

  fetchEvents(0, false);
})();
