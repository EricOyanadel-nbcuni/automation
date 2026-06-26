// ==UserScript==
// @name         Jira Story Points Backfill
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Backfills story points into existing standup_data JSON snapshots using customfield_10004
// @author       Eric Oyanadel
// @match        https://nbcnewsdigital.atlassian.net/*
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
  'use strict';

  // ── Config ─────────────────────────────────────────────
  const DB_NAME            = 'jira-standup-db';   // same DB as jira-standup.user.js
  const STORE_NAME         = 'handles';
  const HANDLE_KEY         = 'standupDir';
  const STORY_POINTS_FIELD = 'customfield_10004';
  const BATCH_SIZE         = 5;
  const BATCH_DELAY_MS     = 300;

  // ── IndexedDB helpers ──────────────────────────────────
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore(STORE_NAME);
      req.onsuccess  = e => resolve(e.target.result);
      req.onerror    = e => reject(e.target.error);
    });
  }

  async function loadDirHandle() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function saveDirHandle(handle) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function verifyPermission(handle) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  }

  async function getOutputDir() {
    let handle = await loadDirHandle();
    if (handle) {
      try {
        const ok = await verifyPermission(handle);
        if (ok) {
          for await (const _ of handle.entries()) { break; }
          return handle;
        }
      } catch (err) {
        console.warn('[Backfill] Stored directory handle invalid:', err.message);
      }
    }
    alert(
      'Select your standup_data folder:\n\n' +
      '  ~/NBC/automation/standup_data\n\n' +
      '(This is the same folder used by the Standup script.)'
    );
    handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await saveDirHandle(handle);
    return handle;
  }

  // ── GM_xmlhttpRequest promise wrapper ──────────────────
  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:          'GET',
        url,
        withCredentials: true,
        headers:         { 'Content-Type': 'application/json' },
        onload(res) {
          if (res.status >= 200 && res.status < 300) {
            try { resolve(JSON.parse(res.responseText)); }
            catch (e) { reject(new Error('JSON parse failed: ' + e.message)); }
          } else if (res.status === 404) {
            resolve(null); // ticket deleted/moved — treat as no points
          } else {
            reject(new Error(`HTTP ${res.status} for ${url}`));
          }
        },
        onerror() { reject(new Error('Network error fetching: ' + url)); },
      });
    });
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Progress modal ─────────────────────────────────────
  function createModal() {
    document.getElementById('jira-backfill-modal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'jira-backfill-modal';
    Object.assign(overlay.style, {
      position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
      background: 'rgba(0,0,0,0.6)', zIndex: '1000001',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    });

    const modal = document.createElement('div');
    Object.assign(modal.style, {
      background: '#fff', borderRadius: '8px', padding: '28px',
      width: '500px', maxWidth: '92vw',
      display: 'flex', flexDirection: 'column', gap: '14px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    });

    const title = document.createElement('h3');
    title.id = 'backfill-title';
    title.textContent = '⚡ Backfilling Story Points';
    Object.assign(title.style, { margin: '0', fontSize: '17px', color: '#172B4D' });

    const statusEl = document.createElement('div');
    statusEl.id = 'backfill-status';
    statusEl.textContent = 'Starting…';
    Object.assign(statusEl.style, { fontSize: '13px', color: '#5E6C84' });

    // Progress bar
    const barWrap = document.createElement('div');
    Object.assign(barWrap.style, {
      background: '#F4F5F7', borderRadius: '4px', height: '8px', overflow: 'hidden',
    });
    const bar = document.createElement('div');
    bar.id = 'backfill-bar';
    Object.assign(bar.style, {
      background: '#0052CC', height: '100%', width: '0%',
      transition: 'width 0.2s ease', borderRadius: '4px',
    });
    barWrap.appendChild(bar);

    const detailEl = document.createElement('div');
    detailEl.id = 'backfill-detail';
    Object.assign(detailEl.style, { fontSize: '12px', color: '#97A0AF', minHeight: '16px' });

    const closeBtn = document.createElement('button');
    closeBtn.id = 'backfill-close';
    closeBtn.textContent = 'Close';
    closeBtn.disabled = true;
    Object.assign(closeBtn.style, {
      padding: '8px 18px', background: '#0052CC', color: '#fff',
      border: 'none', borderRadius: '4px', fontSize: '14px',
      fontWeight: '600', cursor: 'not-allowed', opacity: '0.5',
      alignSelf: 'flex-end', marginTop: '4px',
    });
    closeBtn.addEventListener('click', () => overlay.remove());

    modal.appendChild(title);
    modal.appendChild(statusEl);
    modal.appendChild(barWrap);
    modal.appendChild(detailEl);
    modal.appendChild(closeBtn);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function enableClose() {
      closeBtn.disabled = false;
      closeBtn.style.cursor = 'pointer';
      closeBtn.style.opacity = '1';
    }

    return {
      setStatus:   (text) => { statusEl.textContent = text; },
      setDetail:   (text) => { detailEl.textContent = text; },
      setProgress: (pct)  => { bar.style.width = `${Math.min(100, Math.round(pct))}%`; },
      setDone: (text) => {
        document.getElementById('backfill-title').textContent = '✅ Backfill Complete';
        statusEl.textContent = text;
        bar.style.background = '#36B37E';
        bar.style.width = '100%';
        enableClose();
      },
      setError: (text) => {
        document.getElementById('backfill-title').textContent = '❌ Backfill Failed';
        statusEl.textContent = text;
        bar.style.background = '#FF5630';
        enableClose();
      },
    };
  }

  // ── Main backfill logic ────────────────────────────────
  async function runBackfill() {
    const ui = createModal();

    try {
      // 1. Get directory handle
      ui.setStatus('Accessing standup_data folder…');
      const dirHandle = await getOutputDir();

      // 2. Read all snapshot files
      ui.setStatus('Reading snapshot files…');
      const files = []; // { name, handle, data }
      for await (const [name, handle] of dirHandle.entries()) {
        if (handle.kind !== 'file') continue;
        if (!/^jira-tickets-\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
        try {
          const file = await handle.getFile();
          const data = JSON.parse(await file.text());
          files.push({ name, handle, data });
        } catch { /* skip malformed */ }
      }

      if (files.length === 0) {
        ui.setError('No standup JSON files found in the selected folder.');
        return;
      }
      ui.setDetail(`Found ${files.length} snapshot file${files.length !== 1 ? 's' : ''}`);

      // 3. Collect unique ticket keys that still have null story points
      const ticketKeys = new Set();
      for (const { data } of files) {
        for (const col of (data.columns || [])) {
          for (const t of col.tickets) {
            if (t.storyPoints === null || t.storyPoints === undefined) {
              ticketKeys.add(t.key);
            }
          }
        }
      }

      const keys = [...ticketKeys];
      if (keys.length === 0) {
        ui.setDone('All tickets already have story points — nothing to backfill.');
        return;
      }

      // 4. Fetch story points from Jira in throttled batches
      ui.setStatus(`Fetching story points for ${keys.length} ticket${keys.length !== 1 ? 's' : ''}…`);
      const pointsMap = {}; // ticketKey -> story points value (number or null)
      let fetched = 0;
      let withPoints = 0;

      for (let i = 0; i < keys.length; i += BATCH_SIZE) {
        const batch = keys.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (key) => {
          try {
            const data = await gmGet(
              `https://nbcnewsdigital.atlassian.net/rest/api/3/issue/${key}` +
              `?fields=${STORY_POINTS_FIELD}`
            );
            const pts = data?.fields?.[STORY_POINTS_FIELD] ?? null;
            pointsMap[key] = pts;
            if (pts !== null) withPoints++;
          } catch {
            pointsMap[key] = null;
          }
          fetched++;
          ui.setProgress((fetched / keys.length) * 80);
          ui.setDetail(`Fetched ${fetched} / ${keys.length} tickets…`);
        }));

        // Throttle between batches to avoid rate limiting
        if (i + BATCH_SIZE < keys.length) await sleep(BATCH_DELAY_MS);
      }

      // 5. Write updated JSON files
      ui.setStatus('Writing updated snapshots…');
      let filesUpdated = 0;

      for (let fi = 0; fi < files.length; fi++) {
        const { handle, data } = files[fi];
        let changed = false;

        for (const col of (data.columns || [])) {
          for (const t of col.tickets) {
            if (
              t.key in pointsMap &&
              (t.storyPoints === null || t.storyPoints === undefined) &&
              pointsMap[t.key] !== null
            ) {
              t.storyPoints = pointsMap[t.key];
              changed = true;
            }
          }
        }

        if (changed) {
          const writable = await handle.createWritable();
          await writable.write(JSON.stringify(data, null, 2));
          await writable.close();
          filesUpdated++;
        }

        ui.setProgress(80 + ((fi + 1) / files.length) * 20);
      }

      ui.setDone(
        `${withPoints} of ${keys.length} ticket${keys.length !== 1 ? 's' : ''} had story points. ` +
        `Updated ${filesUpdated} snapshot file${filesUpdated !== 1 ? 's' : ''}.`
      );

    } catch (err) {
      console.error('[Backfill]', err);
      ui.setError('Error: ' + err.message);
    }
  }

  // ── Inject floating button ─────────────────────────────
  function injectButton() {
    if (document.getElementById('jira-backfill-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'jira-backfill-btn';
    btn.textContent = '⚡ Backfill Points';
    Object.assign(btn.style, {
      position:   'fixed',
      bottom:     '130px',
      right:      '45px',
      zIndex:     '99999',
      padding:    '10px 18px',
      background: '#6554C0',
      color:      '#fff',
      border:     'none',
      borderRadius: '20px',
      fontSize:   '14px',
      fontWeight: '600',
      cursor:     'pointer',
      boxShadow:  '0 4px 12px rgba(0,0,0,0.3)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      transition: 'background 0.15s ease',
      userSelect: 'none',
    });
    btn.addEventListener('mouseenter', () => { btn.style.background = '#8777D9'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#6554C0'; });
    btn.addEventListener('click', runBackfill);

    document.body.appendChild(btn);
  }

  // ── Init ───────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectButton);
  } else {
    injectButton();
  }

  // Re-inject on Jira's SPA navigation
  const observer = new MutationObserver(() => injectButton());
  observer.observe(document.body, { childList: true, subtree: false });

})();
