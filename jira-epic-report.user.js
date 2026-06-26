// ==UserScript==
// @name         Jira Epic Report Generator
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Generates a confidence-scored roadmap report from the Jira Epic Report page and saves it as Markdown
// @author       Eric Oyanadel
// @match        https://nbcnewsdigital.atlassian.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      nbcnewsdigital.atlassian.net
// ==/UserScript==

(function () {
  'use strict';

  const BASE_URL   = 'https://nbcnewsdigital.atlassian.net';
  const DB_NAME    = 'jira-epic-report-db';
  const STORE_NAME = 'handles';
  const HANDLE_KEY = 'epicReportDir';

  // ─── IndexedDB helpers for persisting the directory handle ────────────────

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
        console.warn('[Epic Report] Stored directory handle is invalid:', err.message);
      }
    }
    alert(
      'One-time setup:\n\n' +
      'In the folder picker that opens, navigate to:\n' +
      '  ~/NBC/automation/epic_reports\n\n' +
      'Select that folder. You will not be asked again.'
    );
    handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await saveDirHandle(handle);
    return handle;
  }

  async function writeTextFile(dirHandle, filename, content) {
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable   = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  // ─── URL / page detection helpers ─────────────────────────────────────────

  function isOnEpicReportPage() {
    return window.location.pathname.includes('/reports/epic-report');
  }

  function getBoardId() {
    const match = window.location.href.match(/\/boards\/(\d+)/);
    return match ? match[1] : null;
  }

  // Parse the epic key from any /browse/KEY-123 link visible on the Epic Report page.
  // The page renders the epic key as a linked heading (e.g. "TAP-1538 Vertical Video | Q2 2026").
  function getEpicKeyFromDom() {
    const links = document.querySelectorAll('a[href*="/browse/"]');
    for (const link of links) {
      const match = link.href.match(/\/browse\/([A-Z]+-\d+)$/);
      if (match) return match[1];
    }
    return null;
  }

  // ─── Story points field discovery ─────────────────────────────────────────
  // customfield_10016 is not universal — look up the correct field ID at runtime.

  let _storyPointsFieldId = null;

  async function getStoryPointsFieldId() {
    if (_storyPointsFieldId) return _storyPointsFieldId;
    const fields = await gmGet(`${BASE_URL}/rest/api/3/field`);
    const found = fields.find(f => f.name === 'Story Points');
    _storyPointsFieldId = found ? found.id : 'customfield_10016';
    return _storyPointsFieldId;
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

  // ─── Issue status classification ───────────────────────────────────────────

  function isBlocked(status) {
    return /blocked/i.test(status);
  }

  function isDone(status) {
    return /^(done|closed|resolved|complete|completed)$/i.test(status);
  }

  function isInProgress(status) {
    return /in[\s-]?progress|in[\s-]?review|code[\s-]?review|qa/i.test(status);
  }

  function groupIssues(issues) {
    const groups = { blocked: [], todo: [], inprogress: [], done: [] };
    for (const issue of issues) {
      if (isBlocked(issue.status))       groups.blocked.push(issue);
      else if (isDone(issue.status))     groups.done.push(issue);
      else if (isInProgress(issue.status)) groups.inprogress.push(issue);
      else                               groups.todo.push(issue);
    }
    return groups;
  }

  // ─── Confidence score ──────────────────────────────────────────────────────

  function computeConfidence(issues, sprint) {
    const now        = new Date();
    const sprintStart = new Date(sprint.startDate);
    const sprintEnd   = new Date(sprint.endDate);

    const totalSprintMs  = sprintEnd - sprintStart;
    const elapsedMs      = Math.max(0, now - sprintStart);
    const timeElapsedPct = Math.min(1, elapsedMs / totalSprintMs);

    const totalPoints = issues.reduce((sum, i) => sum + (i.storyPoints || 0), 0);
    const donePoints  = issues
      .filter(i => isDone(i.status))
      .reduce((sum, i) => sum + (i.storyPoints || 0), 0);
    const pointsDonePct = totalPoints > 0 ? donePoints / totalPoints : 0;

    const blockedIssues = issues.filter(i => isBlocked(i.status));
    const blockedP1     = blockedIssues.filter(i => i.priority === 'P1').length;
    const blockedP2     = blockedIssues.filter(i => i.priority === 'P2').length;
    const blockedP3     = blockedIssues.filter(i => i.priority !== 'P1' && i.priority !== 'P2').length;
    const unestimated   = issues.filter(i => !isDone(i.status) && i.storyPoints === null).length;

    const remainingDays = Math.max(0, Math.ceil((sprintEnd - now) / (1000 * 60 * 60 * 24)));

    let score = 100;

    // Schedule gap penalty: how far behind expected progress
    const gap = timeElapsedPct - pointsDonePct;
    if      (gap > 0.6) score -= 40;
    else if (gap > 0.4) score -= 30;
    else if (gap > 0.2) score -= 15;
    else if (gap > 0)   score -= 5;

    // Blocked issue penalties
    score -= blockedP1 * 15;
    score -= blockedP2 * 8;
    score -= blockedP3 * 3;

    // Unestimated incomplete issue penalty
    score -= unestimated * 5;

    score = Math.max(0, Math.min(100, score));

    const emoji = score >= 70 ? '🟢' : score >= 40 ? '🟡' : '🔴';
    const label = score >= 70 ? 'High'   : score >= 40 ? 'Medium' : 'Low';

    const factors = {
      timeElapsedPct:  Math.round(timeElapsedPct * 100),
      pointsDonePct:   Math.round(pointsDonePct * 100),
      gapPct:          Math.round(gap * 100),
      blockedP1,
      blockedP2,
      blockedP3,
      unestimated,
      remainingDays,
    };

    return { score, emoji, label, factors };
  }

  // ─── Markdown report builder ───────────────────────────────────────────────

  function pad2(n) { return String(n).padStart(2, '0'); }

  function formatDate(dateObj) {
    return dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function buildMarkdown(epicKey, epicName, sprint, issues, confidence) {
    const now      = new Date();
    const dueDate  = formatDate(new Date(sprint.endDate));
    const todayStr = formatDate(now);

    const totalIssues = issues.length;
    const doneIssues  = issues.filter(i => isDone(i.status)).length;
    const totalPoints = issues.reduce((sum, i) => sum + (i.storyPoints || 0), 0);
    const donePoints  = issues.filter(i => isDone(i.status)).reduce((sum, i) => sum + (i.storyPoints || 0), 0);

    const { score, emoji, label, factors } = confidence;
    const groups = groupIssues(issues);

    let md = '';

    // ── Header ──
    md += `# Epic Report: ${epicName}\n\n`;
    md += `**Epic**: [${epicKey}](${BASE_URL}/browse/${epicKey})  \n`;
    md += `**Sprint**: ${sprint.name}  \n`;
    md += `**Due Date**: ${dueDate}  \n`;
    md += `**Generated**: ${todayStr}  \n\n`;
    md += `---\n\n`;

    // ── Summary table ──
    md += `## Summary\n\n`;
    md += `| Metric | Value |\n`;
    md += `|---|---|\n`;
    md += `| Total Issues | ${totalIssues} |\n`;
    md += `| Completed Issues | ${doneIssues} |\n`;
    md += `| Story Points Total | ${totalPoints} |\n`;
    md += `| Story Points Done | ${donePoints} |\n`;
    md += `| Days Remaining | ${factors.remainingDays} |\n\n`;
    md += `---\n\n`;

    // ── Confidence score ──
    md += `## ${emoji} Confidence Score: ${score}% — ${label}\n\n`;
    md += `**Risk factors:**\n\n`;
    if (factors.gapPct > 0) {
      md += `- ⚠️ Behind schedule: ${factors.timeElapsedPct}% of sprint elapsed, only ${factors.pointsDonePct}% of story points completed\n`;
    } else if (factors.gapPct < 0) {
      md += `- ✅ Ahead of schedule: ${factors.timeElapsedPct}% elapsed, ${factors.pointsDonePct}% of story points completed\n`;
    } else {
      md += `- ✅ On track with sprint timeline\n`;
    }
    if (factors.blockedP1 > 0)    md += `- 🔴 ${factors.blockedP1} blocked P1 issue(s)\n`;
    if (factors.blockedP2 > 0)    md += `- 🟡 ${factors.blockedP2} blocked P2 issue(s)\n`;
    if (factors.blockedP3 > 0)    md += `- 🔵 ${factors.blockedP3} blocked lower-priority issue(s)\n`;
    if (factors.unestimated > 0)  md += `- ❓ ${factors.unestimated} incomplete unestimated issue(s) add unknown scope risk\n`;
    if (factors.remainingDays === 0) md += `- 🚨 Sprint ends today\n`;
    md += `\n---\n\n`;

    // ── Roadmap ──
    md += `## Roadmap\n\n`;

    const sections = [
      { key: 'blocked',    label: '🚫 Blocked',              items: groups.blocked   },
      { key: 'todo',       label: '📋 To Do / Not Started',  items: groups.todo      },
      { key: 'inprogress', label: '🔄 In Progress',          items: groups.inprogress },
      { key: 'done',       label: '✅ Done',                  items: groups.done      },
    ];

    for (const section of sections) {
      const sectionPts = section.items.reduce((sum, i) => sum + (i.storyPoints || 0), 0);
      const issueWord  = section.items.length === 1 ? 'issue' : 'issues';
      md += `### ${section.label} (${section.items.length} ${issueWord} — ${sectionPts} pts)\n\n`;

      if (section.items.length === 0) {
        md += `*None*\n\n`;
      } else {
        md += `| Key | Summary | Type | Priority | Points |\n`;
        md += `|---|---|---|---|---|\n`;
        for (const issue of section.items) {
          const pts = issue.storyPoints !== null ? issue.storyPoints : '—';
          // Escape pipe characters in summary to avoid breaking the markdown table
          const summary = issue.summary.replace(/\|/g, '\\|');
          md += `| [${issue.key}](${BASE_URL}/browse/${issue.key}) | ${summary} | ${issue.issueType} | ${issue.priority} | ${pts} |\n`;
        }
        md += `\n`;
      }
    }

    return md;
  }

  // ─── Report preview modal ──────────────────────────────────────────────────

  function showReportModal(markdown, filename) {
    document.getElementById('jira-epic-report-modal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'jira-epic-report-modal';
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
      width:         '780px',
      maxWidth:      '92vw',
      maxHeight:     '82vh',
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
    titleEl.textContent = '📊 Epic Report';
    Object.assign(titleEl.style, { margin: '0', fontSize: '18px', color: '#172B4D' });

    const savedLabel = document.createElement('span');
    savedLabel.textContent = `✅ Saved: ${filename}`;
    Object.assign(savedLabel.style, { fontSize: '12px', color: '#36B37E', fontWeight: '600' });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, {
      background: 'none', border: 'none', fontSize: '18px',
      cursor: 'pointer', color: '#6B778C', lineHeight: '1',
    });
    closeBtn.addEventListener('click', () => overlay.remove());

    header.appendChild(titleEl);
    header.appendChild(savedLabel);
    header.appendChild(closeBtn);

    // Markdown content (read-only monospace view)
    const content = document.createElement('textarea');
    content.readOnly = true;
    content.value    = markdown;
    Object.assign(content.style, {
      flex:        '1',
      minHeight:   '400px',
      fontFamily:  '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      fontSize:    '12px',
      padding:     '12px',
      border:      '1px solid #DFE1E6',
      borderRadius:'4px',
      resize:      'none',
      color:       '#172B4D',
      background:  '#FAFBFC',
      lineHeight:  '1.6',
      boxSizing:   'border-box',
      width:       '100%',
    });

    // Footer
    const footer = document.createElement('div');
    Object.assign(footer.style, { display: 'flex', justifyContent: 'flex-end', gap: '8px' });

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 Copy Markdown';
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
      await navigator.clipboard.writeText(markdown);
      copyBtn.textContent = '✅ Copied!';
      setTimeout(() => { copyBtn.textContent = '📋 Copy Markdown'; }, 2000);
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
    modal.appendChild(content);
    modal.appendChild(footer);
    overlay.appendChild(modal);

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  // ─── Main report logic ─────────────────────────────────────────────────────

  async function runEpicReport() {
    const btn = document.getElementById('jira-epic-report-btn');
    btn.textContent = '⏳ Loading…';
    btn.disabled = true;

    try {
      // 1. Resolve the output directory first — must happen before any network
      //    awaits so the browser's user-gesture context is still active when
      //    showDirectoryPicker() is called on first-time setup.
      const outputDir = await getOutputDir();

      // 2. Get board ID from URL
      const boardId = getBoardId();
      if (!boardId) {
        alert('Could not find board ID in the URL.\nNavigate to a Jira board\'s Epic Report page.');
        return;
      }

      // 3. Get epic key from DOM (the page renders the epic key as a /browse/ link)
      const epicKey = getEpicKeyFromDom();
      if (!epicKey) {
        alert('Could not detect the epic key on this page.\nMake sure you are on the Epic Report page for a specific epic.');
        return;
      }

      // 4. Fetch active sprint to get due date (sprint end date)
      const sprintData = await gmGet(
        `${BASE_URL}/rest/agile/1.0/board/${boardId}/sprint?state=active`
      );
      const sprints = sprintData.values || [];
      if (sprints.length === 0) {
        alert('No active sprint found for this board.');
        return;
      }
      const sprint = sprints[0];

      // 5. Discover the correct story points field ID for this Jira instance
      const spField = await getStoryPointsFieldId();

      // 6. Fetch all issues in this epic (up to 200)
      const epicIssueData = await gmGet(
        `${BASE_URL}/rest/agile/1.0/epic/${epicKey}/issue` +
        `?fields=summary,status,issuetype,priority,${spField}&maxResults=200`
      );
      const rawIssues = epicIssueData.issues || [];

      if (rawIssues.length === 0) {
        alert(`No issues found for epic ${epicKey}.\nThe epic may be empty or the API returned no results.`);
        return;
      }

      // 7. Normalize issue shape
      const issues = rawIssues.map(issue => ({
        key:         issue.key,
        summary:     issue.fields.summary || '',
        issueType:   issue.fields.issuetype?.name  || 'Task',
        priority:    issue.fields.priority?.name   || 'Unknown',
        status:      issue.fields.status?.name     || 'Unknown',
        storyPoints: issue.fields[spField] ?? null,
      }));

      // 8. Get epic display name from the DOM heading (cleaner than a separate API call)
      const epicNameEl = document.querySelector('a[href*="/browse/' + epicKey + '"]');
      const epicName   = epicNameEl
        ? (epicNameEl.textContent.trim() || epicKey)
        : epicKey;

      // 9. Compute confidence score
      const confidence = computeConfidence(issues, sprint);

      // 10. Build markdown report
      const markdown = buildMarkdown(epicKey, epicName, sprint, issues, confidence);

      // 9. Save .md file to epic_reports/
      const now = new Date();
      const dateStr = now.getFullYear()
        + '-' + pad2(now.getMonth() + 1)
        + '-' + pad2(now.getDate());
      const filename = `epic-report-${epicKey}-${dateStr}.md`;

      await writeTextFile(outputDir, filename, markdown);

      // 10. Copy to clipboard automatically
      await navigator.clipboard.writeText(markdown);

      // 11. Show preview modal
      showReportModal(markdown, filename);

      GM_notification({
        title:   '📊 Epic Report ready!',
        text:    `${issues.length} issue(s) · Score: ${confidence.emoji} ${confidence.score}%\nSaved: ${filename}`,
        timeout: 6000,
      });

    } catch (err) {
      console.error('[Epic Report]', err);
      alert('Epic Report failed:\n' + err.message);
    } finally {
      btn.textContent = '📊 Epic Report';
      btn.disabled = false;
    }
  }

  // ─── Inject floating button ────────────────────────────────────────────────

  function injectButton() {
    if (!isOnEpicReportPage()) return;
    if (document.getElementById('jira-epic-report-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'jira-epic-report-btn';
    btn.textContent = '📊 Epic Report';

    Object.assign(btn.style, {
      position:     'fixed',
      bottom:       '130px',   // sits above the Standup button (75px)
      right:        '45px',
      zIndex:       '99999',
      padding:      '10px 18px',
      background:   '#6554C0',
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

    btn.addEventListener('mouseenter', () => { btn.style.background = '#8777D9'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#6554C0'; });
    btn.addEventListener('click', runEpicReport);

    // Right-click to reset stored directory handle
    btn.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      if (confirm('Reset stored output directory?\n\nThis will let you select a new folder location.')) {
        await indexedDB.deleteDatabase(DB_NAME);
        alert('Directory reset. Click the button again to select a new folder.');
      }
    });

    document.body.appendChild(btn);
  }

  // ─── SPA navigation observer ───────────────────────────────────────────────
  // Jira is a SPA — re-check on every URL change so the button appears when
  // the user navigates to the Epic Report page without a full page reload.

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // Wait briefly for the SPA to render the new view
      setTimeout(injectButton, 600);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(injectButton, 600));
  } else {
    setTimeout(injectButton, 600);
  }

})();
