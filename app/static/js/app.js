/**
 * TeslaCam Viewer - Frontend
 * Lightweight multi-camera synchronized playback
 */

(() => {
  "use strict";

  // State
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

  // DOM
  const $ = (sel) => document.querySelector(sel);
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
      if (append) {
        events = events.concat(data.events);
      } else {
        events = data.events;
      }
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
                 onerror="this.style.background='var(--bg-tertiary)';this.src='';" />
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
        const id = card.dataset.id;
        const ev = events.find((x) => x.id === id);
        if (ev) selectEvent(ev);
      });
    });
  }

  function selectEvent(event) {
    activeEvent = event;

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
      v.src = "";
    });
    videos = [];
    isPlaying = false;
    syncPlayBtn.textContent = "▶ Play";
    duration = 0;
    seekBar.value = 0;
    timeDisplay.textContent = "0:00 / 0:00";

    cams.forEach(([name, filename]) => {
      const tile = document.createElement("div");
      tile.className = "camera-tile";

      const label = document.createElement("div");
      label.className = "camera-label";
      label.textContent = name.replace("_", " ");

      const video = document.createElement("video");
      video.preload = "metadata";
      video.playsInline = true;
      video.muted = isMuted;
      video.src = `/media/${event.path}/${filename}`;

      video.addEventListener("loadedmetadata", () => {
        if (video.duration > duration) {
          duration = video.duration;
          seekBar.max = duration;
          updateTimeDisplay();
        }
      });

      video.addEventListener("timeupdate", () => {
        if (videos[0] === video && !seekBar.dragging) {
          seekBar.value = video.currentTime;
          updateTimeDisplay();
        }
      });

      video.addEventListener("ended", () => {
        if (videos.every((v) => v.ended || v.paused)) {
          isPlaying = false;
          syncPlayBtn.textContent = "▶ Play";
        }
      });

      tile.appendChild(video);
      tile.appendChild(label);
      cameraGrid.appendChild(tile);
      videos.push(video);
    });
  }

  function togglePlay() {
    if (!videos.length) return;
    if (isPlaying) {
      videos.forEach((v) => v.pause());
      isPlaying = false;
      syncPlayBtn.textContent = "▶ Play";
    } else {
      const t = videos[0].currentTime;
      videos.forEach((v) => {
        v.currentTime = t;
        v.play().catch(() => {});
      });
      isPlaying = true;
      syncPlayBtn.textContent = "⏸ Pause";
    }
  }

  function toggleMute() {
    isMuted = !isMuted;
    videos.forEach((v) => (v.muted = isMuted));
    syncMuteBtn.textContent = isMuted ? "🔇" : "🔊";
  }

  function seekTo(time) {
    videos.forEach((v) => {
      if (Math.abs(v.currentTime - time) > 0.3) {
        v.currentTime = time;
      }
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
    const cur = videos[0] ? videos[0].currentTime : 0;
    timeDisplay.textContent = `${formatTime(cur)} / ${formatTime(duration)}`;
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

  loadMoreBtn.addEventListener("click", () => {
    fetchEvents(currentOffset, true);
  });

  syncPlayBtn.addEventListener("click", togglePlay);
  syncMuteBtn.addEventListener("click", toggleMute);

  let seeking = false;
  seekBar.addEventListener("mousedown", () => (seeking = true));
  seekBar.addEventListener("touchstart", () => (seeking = true));
  seekBar.addEventListener("input", () => {
    if (seeking) {
      seekTo(parseFloat(seekBar.value));
    }
  });
  seekBar.addEventListener("mouseup", () => {
    seeking = false;
    seekTo(parseFloat(seekBar.value));
  });
  seekBar.addEventListener("touchend", () => {
    seeking = false;
    seekTo(parseFloat(seekBar.value));
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.code === "Space") {
      e.preventDefault();
      togglePlay();
    } else if (e.code === "ArrowRight") {
      seekTo(Math.min(duration, (videos[0]?.currentTime || 0) + 5));
    } else if (e.code === "ArrowLeft") {
      seekTo(Math.max(0, (videos[0]?.currentTime || 0) - 5));
    } else if (e.code === "KeyM") {
      toggleMute();
    }
  });

  fetchEvents(0, false);
})();
