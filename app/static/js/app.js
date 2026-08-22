/**
 * TeslaCam Viewer - Frontend
 * Lightweight multi-camera synchronized playback
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
  const sidebarScrim = $("#sidebarScrim");

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

  function renderEventList() {
    if (events.length === 0) {
      eventList.innerHTML = `<div style="padding:1.5rem;text-align:center;color:var(--text-muted)">No events found</div>`;
      return;
    }

    eventList.innerHTML = events
      .map((e) => {
        const camCount = Object.keys(e.cameras).length;
        const thumbUrl = e.thumb
          ? `/media/${e.path}/${e.thumb}`
          : `/api/thumb/${encodeURIComponent(e.id)}`;

        return `
          <div class="event-card ${activeEvent?.id === e.id ? "active" : ""}" data-id="${e.id}">
            <img class="event-thumb" src="${thumbUrl}" alt="" loading="lazy"
                 onerror="this.style.background='var(--bg-tertiary)';this.removeAttribute('src');" />
            <div class="event-details">
              <div class="event-type ${e.type.toLowerCase()}">${e.type}</div>
              <div class="event-time">${formatDateTime(e.datetime)}</div>
              <div class="event-cams">${camCount} camera${camCount !== 1 ? "s" : ""}</div>
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

  function closeOverlay() {
    if (!overlayOpen()) return;
    const t = fsVideo.currentTime || overlayResumeAt;
    fsVideo.pause();
    fsLayer.hidden = true;
    fsVideo.removeAttribute("src");
    fsVideo.load();
    overlaySrc = null;
    videos.forEach((v) => {
      if (Math.abs(v.currentTime - t) > 0.25) v.currentTime = t;
    });
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
      fsSeekBar.max = duration || video.duration || 100;
      fsSeekBar.value = overlayResumeAt;
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
    $("#eventDatetime").textContent = formatDateTime(event.datetime);

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

    const cams = Object.entries(event.cameras);
    cameraGrid.className = `camera-grid cams-${Math.min(cams.length, 6)}`;
    cameraGrid.innerHTML = "";

    videos.forEach((v) => {
      v.pause();
      v.removeAttribute("src");
      v.load();
    });
    videos = [];
    setPlaying(false);
    duration = 0;
    seekBar.value = 0;
    timeDisplay.textContent = "0:00 / 0:00";

    cams.forEach(([name, filename]) => {
      const tile = document.createElement("div");
      tile.className = "camera-tile";

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
      video.src = `/media/${event.path}/${filename}`;

      video.addEventListener("loadedmetadata", () => {
        if (video.duration > duration) {
          duration = video.duration;
          seekBar.max = duration;
          if (fsSeekBar) fsSeekBar.max = duration;
          updateTimeDisplay();
        }
      });

      video.addEventListener("timeupdate", () => {
        if (videos[0] === video && !seeking && !overlayOpen()) {
          seekBar.value = video.currentTime;
          updateTimeDisplay();
        }
      });

      video.addEventListener("ended", () => {
        if (videos.every((v) => v.ended || v.paused)) setPlaying(false);
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

      tile.appendChild(video);
      tile.appendChild(label);
      tile.appendChild(fsBtn);
      cameraGrid.appendChild(tile);
      videos.push(video);
    });

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
        setPlaying(true);
      } else {
        fsVideo.pause();
        setPlaying(false);
      }
      return;
    }
    if (!videos.length) return;
    if (isPlaying) {
      videos.forEach((v) => v.pause());
      setPlaying(false);
    } else {
      const t = videos[0].currentTime;
      videos.forEach((v) => {
        v.currentTime = t;
        v.play().catch(() => {});
      });
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
    if (overlayOpen()) {
      fsVideo.currentTime = time;
    }
    videos.forEach((v) => {
      if (Math.abs(v.currentTime - time) > 0.3) v.currentTime = time;
    });
    updateTimeDisplay();
  }

  function formatTime(sec) {
    if (!isFinite(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function updateTimeDisplay() {
    const cur = overlayOpen()
      ? fsVideo.currentTime
      : videos[0]
        ? videos[0].currentTime
        : 0;
    timeDisplay.textContent = `${formatTime(cur)} / ${formatTime(duration)}`;
    if (fsTime) fsTime.textContent = `${formatTime(cur)} / ${formatTime(duration)}`;
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
      seekBar.value = fsVideo.currentTime;
      updateTimeDisplay();
    });
    fsVideo.addEventListener("ended", () => setPlaying(false));
    fsVideo.addEventListener("click", togglePlay);
  }

  loadMoreBtn.addEventListener("click", () => {
    fetchEvents(currentOffset, true);
  });

  syncPlayBtn.addEventListener("click", togglePlay);
  syncMuteBtn.addEventListener("click", toggleMute);

  let seeking = false;
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
      const cur = overlayOpen() ? fsVideo.currentTime : videos[0]?.currentTime || 0;
      seekTo(Math.min(duration, cur + 5));
    } else if (e.code === "ArrowLeft") {
      const cur = overlayOpen() ? fsVideo.currentTime : videos[0]?.currentTime || 0;
      seekTo(Math.max(0, cur - 5));
    } else if (e.code === "KeyM") {
      toggleMute();
    } else if (e.code === "Escape") {
      closeOverlay();
      exitNativeFs();
    }
  });

  fetchEvents(0, false);
})();
