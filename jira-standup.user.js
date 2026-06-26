// ==UserScript==
// @name         Jira Standup Generator
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Generates a standup message from your active sprint tickets, copies to clipboard, and saves JSON for Copilot
// @author       Eric Oyanadel
// @match        https://nbcnewsdigital.atlassian.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      nbcnewsdigital.atlassian.net
// ==/UserScript==

(function () {
  'use strict';

  // ─── IndexedDB helpers for persisting the directory handle ────────────────
  const DB_NAME    = 'jira-standup-db';
  const STORE_NAME = 'handles';
  const HANDLE_KEY = 'standupDir';

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

  // Verify or request write permission for a stored handle
  async function verifyPermission(handle) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  }

  // Get a valid directory handle — use stored one or prompt user to pick
  async function getOutputDir() {
    let handle = await loadDirHandle();
    if (handle) {
      try {
        // Verify both permission and that directory still exists
        const ok = await verifyPermission(handle);
        if (ok) {
          // Test that we can actually access the directory
          for await (const _ of handle.entries()) {
            break; // Just test if we can iterate, no need to read all entries
          }
          return handle;
        }
      } catch (err) {
        // Stored handle is invalid (directory moved/deleted), clear it and reprompt
        console.warn('[Jira Standup] Stored directory handle is invalid:', err.message);
      }
    }
    // First time (or permission revoked) — ask user to pick ~/NBC/automation/standup_data
    alert(
      'One-time setup:\n\n' +
      'In the folder picker that opens, navigate to:\n' +
      '  ~/NBC/automation/standup_data\n\n' +
      'Select that folder. You will not be asked again.'
    );
    handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await saveDirHandle(handle);
    return handle;
  }

  // Write JSON snapshot directly to the chosen folder
  async function writeJsonFile(dirHandle, filename, data) {
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable   = await fileHandle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  }

  // Read JSON file from the chosen folder (returns null if not found)
  async function readJsonFile(dirHandle, filename) {
    try {
      const fileHandle = await dirHandle.getFileHandle(filename);
      const file       = await fileHandle.getFile();
      const text       = await file.text();
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // Find and read yesterday's jira-tickets-YYYY-MM-DD.json (actual yesterday, or Friday if today is Monday)
  async function getYesterdaySnapshot(dirHandle, todayDate) {
    // Calculate yesterday's date (or Friday if today is Monday)
    const yesterday = new Date(todayDate);
    const dayOfWeek = yesterday.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
    
    if (dayOfWeek === 1) {
      // Today is Monday, go back to Friday (3 days ago)
      yesterday.setDate(yesterday.getDate() - 3);
    } else {
      // Any other day, just go back 1 day
      yesterday.setDate(yesterday.getDate() - 1);
    }
    
    const yesterdayStr = yesterday.getFullYear()
      + '-' + String(yesterday.getMonth() + 1).padStart(2, '0')
      + '-' + String(yesterday.getDate()).padStart(2, '0');
    
    // Try to read yesterday's file
    return readJsonFile(dirHandle, `jira-tickets-${yesterdayStr}.json`);
  }

  // Build plain-text standup message
  function buildStandupText(date, yesterdaySnapshot, todayGroups, todayOrder) {
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const yy = String(date.getFullYear()).slice(2);
    let text = `Stand Up for ${mm}/${dd}/${yy}\n`;

    text += `Yesterday\n`;
    if (yesterdaySnapshot && yesterdaySnapshot.columns && yesterdaySnapshot.columns.length) {
      for (const col of yesterdaySnapshot.columns) {
        // hiding Done from the modal edit 4/28/26
        if (col.name === 'Done') continue;
        for (const ticket of col.tickets) {
          text += `• ${ticket.key} - ${ticket.summary} : ${col.name}\n`;
        }
      }
    } else {
      text += `• (no previous data or took the day off)\n`;
    }

    text += `Today\n`;
    for (const status of todayOrder) {
      // hiding Done from the modal edit 4/28/26
      if (status === 'Done') continue;
      for (const ticket of todayGroups[status]) {
        text += `• ${ticket.key} - ${ticket.summary} : ${status}\n`;
      }
    }

    text += `\nBlockers: None\nAfter Talk: None`;
    return text;
  }

  // Convert ticket keys (e.g. TAP-1172) to clickable Jira links in HTML
  function ticketKeysToLinks(text) {
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return escaped.replace(/([A-Z]+-\d+)/g, (
      '<a href="https://nbcnewsdigital.atlassian.net/browse/$1" ' +
      'target="_blank" ' +
      'style="color:#0052CC;text-decoration:none;font-weight:600;">$1</a>'
    ));
  }

  // Show standup modal with editable content and copy button
  function showStandupModal(plainText) {
    document.getElementById('jira-standup-modal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'jira-standup-modal';
    Object.assign(overlay.style, {
      position:       'fixed',
      top:            '0',
      left:           '0',
      width:          '100%',
      height:         '100%',
      background:     'rgba(0,0,0,0.6)',
      zIndex:         '1000000',
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center',
    });

    const modal = document.createElement('div');
    Object.assign(modal.style, {
      background:    '#fff',
      borderRadius:  '8px',
      padding:       '24px',
      width:         '700px',
      maxWidth:      '90vw',
      maxHeight:     '80vh',
      display:       'flex',
      flexDirection: 'column',
      gap:           '16px',
      boxShadow:     '0 8px 32px rgba(0,0,0,0.4)',
      fontFamily:    '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      boxSizing:     'border-box',
    });

    // Header
    const header = document.createElement('div');
    Object.assign(header.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center' });

    const titleEl = document.createElement('h3');
    titleEl.textContent = '📋 Standup';
    Object.assign(titleEl.style, { margin: '0', fontSize: '18px', color: '#172B4D' });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, {
      background: 'none', border: 'none', fontSize: '18px',
      cursor: 'pointer', color: '#6B778C', lineHeight: '1',
    });
    closeBtn.addEventListener('click', () => overlay.remove());

    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    // Editable content area with linked ticket keys
    const textarea = document.createElement('div');
    textarea.contentEditable = 'true';
    textarea.spellcheck = false;
    textarea.innerHTML = ticketKeysToLinks(plainText).replace(/\n/g, '<br>');
    Object.assign(textarea.style, {
      flex:         '1',
      minHeight:    '300px',
      overflowY:    'auto',
      fontFamily:   '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      fontSize:     '13px',
      padding:      '12px',
      border:       '1px solid #DFE1E6',
      borderRadius: '4px',
      outline:      'none',
      boxSizing:    'border-box',
      lineHeight:   '1.7',
      color:        '#172B4D',
      width:        '100%',
      whiteSpace:   'pre-wrap',
      wordBreak:    'break-word',
      background:   '#fff',
    });

    // Footer
    const footer = document.createElement('div');
    Object.assign(footer.style, { display: 'flex', justifyContent: 'flex-end', gap: '8px' });

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 Copy';
    Object.assign(copyBtn.style, {
      padding:      '8px 18px',
      background:   '#0052CC',
      color:        '#fff',
      border:       'none',
      borderRadius: '4px',
      fontSize:     '14px',
      fontWeight:   '600',
      cursor:       'pointer',
    });
    copyBtn.addEventListener('click', async () => {
      // Copy both plain text and HTML to clipboard so Slack preserves links and formatting
      const plainText = textarea.innerText;
      const htmlText = textarea.innerHTML;
      
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
          'text/html': new Blob([htmlText], { type: 'text/html' })
        })
      ]);
      
      copyBtn.textContent = '✅ Copied!';
      setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
    });

    const doneBtn = document.createElement('button');
    doneBtn.textContent = 'Close';
    Object.assign(doneBtn.style, {
      padding:      '8px 18px',
      background:   '#F4F5F7',
      color:        '#172B4D',
      border:       '1px solid #DFE1E6',
      borderRadius: '4px',
      fontSize:     '14px',
      cursor:       'pointer',
    });
    doneBtn.addEventListener('click', () => overlay.remove());

    footer.appendChild(copyBtn);
    footer.appendChild(doneBtn);

    modal.appendChild(header);
    modal.appendChild(textarea);
    modal.appendChild(footer);
    overlay.appendChild(modal);

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    textarea.focus();
  }

  // ─── Inject floating button ────────────────────────────────────────────────
  function injectButton() {
    if (document.getElementById('jira-standup-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'jira-standup-btn';
    btn.textContent = '📋 Standup';

    Object.assign(btn.style, {
      position:     'fixed',
      bottom:       '75px',
      right:        '45px',
      zIndex:       '99999',
      padding:      '10px 18px',
      background:   '#0052CC',
      color:        '#fff',
      border:       'none',
      borderRadius: '20px',
      fontSize:     '14px',
      fontWeight:   '600',
      cursor:       'pointer',
      boxShadow:    '0 4px 12px rgba(0,0,0,0.3)',
      fontFamily:   '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      transition:   'background 0.15s ease',
      userSelect:   'none',
    });

    btn.addEventListener('mouseenter', () => { btn.style.background = '#0065FF'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#0052CC'; });
    btn.addEventListener('click', runStandup);

    // Add context menu for reset
    btn.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      if (confirm('Reset stored directory?\n\nThis will let you select a new folder location.')) {
        await indexedDB.deleteDatabase(DB_NAME);
        alert('Directory reset! Click the Standup button to select a new folder.');
      }
    });

    document.body.appendChild(btn);
  }

  // ─── Promise wrapper for GM_xmlhttpRequest ─────────────────────────────────
  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:          'GET',
        url,
        withCredentials: true,
        headers:         { 'Content-Type': 'application/json' },
        onload(res) {
          if (res.status >= 200 && res.status < 300) {
            try {
              resolve(JSON.parse(res.responseText));
            } catch (e) {
              reject(new Error('Failed to parse JSON response: ' + e.message));
            }
          } else if (res.status === 401 || res.status === 403) {
            reject(new Error(`Auth error (${res.status}) — make sure you are logged in to Jira.`));
          } else {
            reject(new Error(`HTTP ${res.status} from ${url}`));
          }
        },
        onerror() {
          reject(new Error('Network request failed for: ' + url));
        },
      });
    });
  }

  // ─── Main standup logic ────────────────────────────────────────────────────
  async function runStandup() {
    const btn = document.getElementById('jira-standup-btn');
    btn.textContent = '⏳ Loading…';
    btn.disabled = true;

    try {
      const baseUrl = 'https://nbcnewsdigital.atlassian.net';

      // 1. Extract board ID from current URL
      const boardMatch = window.location.href.match(/\/boards\/(\d+)/);
      if (!boardMatch) {
        alert('Navigate to a Jira board page first.\nURL must contain /boards/{id}');
        return;
      }
      const boardId = boardMatch[1];

      // 2. Get active sprint for this board
      const sprintData = await gmGet(
        `${baseUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active`
      );

      const sprints = sprintData.values;
      if (!sprints || sprints.length === 0) {
        alert('No active sprint found for this board.');
        return;
      }
      const sprint = sprints[0];

      // 3. Fetch issues in this sprint assigned to current user (up to 100)
      const jql = encodeURIComponent(
        `sprint = ${sprint.id} AND assignee = currentUser() ORDER BY status ASC`
      );
      const issueData = await gmGet(
        `${baseUrl}/rest/agile/1.0/sprint/${sprint.id}/issue` +
        `?fields=summary,status,issuetype,priority,customfield_10004&jql=${jql}&maxResults=100`
      );

      const issues = issueData.issues || [];
      if (issues.length === 0) {
        alert('No tickets assigned to you in the active sprint.');
        return;
      }

      // 4. Group tickets by status/column name
      const grouped = {};
      for (const issue of issues) {
        const statusName = issue.fields.status.name;
        if (!grouped[statusName]) grouped[statusName] = [];
        grouped[statusName].push({
          key:         issue.key,
          summary:     issue.fields.summary,
          issueType:   issue.fields.issuetype?.name  || 'Task',
          priority:    issue.fields.priority?.name   || 'Medium',
          storyPoints: issue.fields.customfield_10004 ?? null,
        });
      }

      // 5. Sort columns in a sensible standup order
      //    (adjust these names to match your board's exact column titles)
      const COLUMN_ORDER = [
        'In Progress',
        'In Review',
        'Code Review',
        'QA',
        'To Do',
        'Backlog',
        'Blocked',
        'Done',
      ];

      const sortedStatuses = Object.keys(grouped).sort((a, b) => {
        const ai = COLUMN_ORDER.indexOf(a);
        const bi = COLUMN_ORDER.indexOf(b);
        if (ai === -1 && bi === -1) return a.localeCompare(b);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });

      // 6. Build Slack-formatted standup message
      const today = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        month:   'long',
        day:     'numeric',
      });

      let standupText = `*🗓 Standup — ${today}*\n*Sprint: ${sprint.name}*\n`;

      for (const status of sortedStatuses) {
        standupText += `\n*${status}*\n`;
        for (const ticket of grouped[status]) {
          standupText += `${ticket.key} : ${ticket.summary}\n`;
        }
      }

      standupText = standupText.trimEnd();

      // 7. Copy standup message to clipboard
      await navigator.clipboard.writeText(standupText);

      // 8. Build date string and JSON snapshot for Copilot
      const now = new Date();
      const ts = now.getFullYear()
        + '-' + String(now.getMonth() + 1).padStart(2, '0')
        + '-' + String(now.getDate()).padStart(2, '0');

      const snapshot = {
        generatedAt: new Date().toISOString(),
        date:        ts,
        sprint: {
          id:        sprint.id,
          name:      sprint.name,
          state:     sprint.state,
          startDate: sprint.startDate || null,
          endDate:   sprint.endDate   || null,
        },
        columns: sortedStatuses.map(status => ({
          name:    status,
          tickets: grouped[status],
        })),
      };

      // 9. Write JSON snapshot to ~/NBC/automation/standup_data/
      const outputDir = await getOutputDir();

      // Read yesterday's file (actual yesterday, not just most recent)
      const previousSnapshot = await getYesterdaySnapshot(outputDir, now);

      // jira-tickets-YYYY-MM-DD.json (overwrites if same day)
      const timestampedFilename = `jira-tickets-${ts}.json`;

      // Write dated snapshot only
      await writeJsonFile(outputDir, timestampedFilename, snapshot);

      // 10. Build standup text and show modal
      const modalText = buildStandupText(now, previousSnapshot, grouped, sortedStatuses);
      showStandupModal(modalText);

      GM_notification({
        title:   '📋 Standup ready!',
        text:    `${issues.length} ticket(s) saved.\n${timestampedFilename}`,
        timeout: 5000,
      });

    } catch (err) {
      console.error('[Jira Standup]', err);
      alert('Standup failed:\n' + err.message);
    } finally {
      btn.textContent = '📋 Standup';
      btn.disabled = false;
    }
  }

  // ─── Wait for DOM before injecting button ─────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectButton);
  } else {
    injectButton();
  }

})();
