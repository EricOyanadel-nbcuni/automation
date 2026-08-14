// ==UserScript==
// @name         Jira Copilot Button
// @namespace    http://tampermonkey.net/
// @version      1.0
// @lastModified 2026-08-14
// @description  Adds a Copilot button to Jira ticket pages that copies the description and acceptance criteria to clipboard
// @author       You
// @match        https://nbcnewsdigital.atlassian.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      nbcnewsdigital.atlassian.net
// ==/UserScript==

(function () {
  'use strict';

  const BASE_URL = 'https://nbcnewsdigital.atlassian.net';

  // Cache for field metadata — fetched once, reused on subsequent clicks
  let fieldMapCache = null;

  // ─── URL detection helpers ──────────────────────────────────────────────────

  // Extracts the ticket key from the current page URL.
  // Supports two URL patterns:
  //   1. Direct ticket page: /browse/TAP-1458
  //   2. Board side-panel:   ?selectedIssue=TAP-1433
  function getTicketKey() {
    const browseMatch = window.location.pathname.match(/\/browse\/([A-Z]+-\d+)/);
    if (browseMatch) return browseMatch[1];

    const params   = new URLSearchParams(window.location.search);
    const selected = params.get('selectedIssue');
    if (selected && /^[A-Z]+-\d+$/.test(selected)) return selected;

    return null;
  }

  function isOnTicketPage() {
    return getTicketKey() !== null;
  }

  // ─── Promise wrapper for GM_xmlhttpRequest ──────────────────────────────────

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

  // ─── Build a map of customfield_XXXXX → human-readable field name ───────────

  async function getFieldMap() {
    if (fieldMapCache) return fieldMapCache;
    const fields = await gmGet(`${BASE_URL}/rest/api/3/field`);
    fieldMapCache = {};
    for (const f of fields) {
      fieldMapCache[f.id] = f.name;
    }
    return fieldMapCache;
  }

  // ─── Find the acceptance criteria custom field ID ────────────────────────────
  // Looks for any custom field whose name contains "acceptance" or "criteria"
  // AND that has a non-null value on this particular issue.

  async function findAcFieldId(issueFields) {
    const fieldMap = await getFieldMap();
    for (const [id, name] of Object.entries(fieldMap)) {
      if (!id.startsWith('customfield_')) continue;
      if (/(acceptance|criteria)/i.test(name) && issueFields[id] != null) {
        return id;
      }
    }
    return null;
  }

  // ─── Convert Atlassian Document Format (ADF) to plain text & collect media ──
  // ADF is a JSON tree Jira uses for rich text fields (description, AC, etc.)
  // mediaNodes array (optional) will be populated with {id, alt, type} for images

  function adfToText(node, depth, mediaNodes) {
    if (!node) return '';
    depth = depth || 0;

    if (node.type === 'text') return node.text || '';

    const children = node.content || [];

    switch (node.type) {
      case 'doc':
        return children.map(function (n) { return adfToText(n, depth, mediaNodes); }).join('').trim();

      case 'paragraph':
        return children.map(function (n) { return adfToText(n, depth, mediaNodes); }).join('') + '\n';

      case 'heading': {
        const level  = (node.attrs && node.attrs.level) || 1;
        const prefix = '#'.repeat(level) + ' ';
        return prefix + children.map(function (n) { return adfToText(n, depth, mediaNodes); }).join('') + '\n';
      }

      case 'bulletList':
      case 'orderedList':
        return children.map(function (n) { return adfToText(n, depth, mediaNodes); }).join('') + '\n';

      case 'listItem': {
        const indent = '  '.repeat(depth);
        const body   = children.map(function (n) { return adfToText(n, depth + 1, mediaNodes); }).join('').trimEnd();
        return indent + '• ' + body + '\n';
      }

      case 'codeBlock': {
        const code = children.map(function (n) { return adfToText(n, depth, mediaNodes); }).join('');
        return '```\n' + code + '\n```\n';
      }

      case 'blockquote': {
        const lines = children.map(function (n) { return adfToText(n, depth, mediaNodes); }).join('');
        return lines.split('\n').map(function (l) { return '> ' + l; }).join('\n') + '\n';
      }

      case 'rule':
        return '---\n';

      case 'hardBreak':
        return '\n';

      case 'mention':
        return (node.attrs && node.attrs.text) || '';

      case 'emoji':
        return (node.attrs && node.attrs.text) || '';

      case 'inlineCard':
      case 'blockCard':
        return (node.attrs && node.attrs.url) || '';

      case 'table':
        return children.map(function (n) { return adfToText(n, depth, mediaNodes); }).join('') + '\n';

      case 'tableRow':
        return '| ' + children.map(function (n) { return adfToText(n, depth, mediaNodes).trim(); }).join(' | ') + ' |\n';

      case 'tableHeader':
      case 'tableCell':
        return children.map(function (n) { return adfToText(n, depth, mediaNodes); }).join('').trim();

      case 'mediaSingle':
      case 'mediaGroup':
        // Block-level media container — process children and add newline
        return children.map(function (n) { return adfToText(n, depth, mediaNodes); }).join('') + '\n';

      case 'media': {
        // Actual media node with image data
        const attrs = node.attrs || {};
        const mediaId = attrs.id;
        const alt = attrs.alt || 'Image';
        const mediaType = attrs.type || 'file';
        const collection = attrs.collection || null;

        if (mediaId && mediaNodes) {
          console.log(`[Jira Copilot] Found media node: id=${mediaId}, alt=${alt}, type=${mediaType}, collection=${collection}`);
          mediaNodes.push({ id: mediaId, alt: alt, type: mediaType, collection: collection });
        }

        return `[Image: ${alt}]`;
      }

      case 'mediaInline':
        // Inline media — process children (should contain media node)
        return children.map(function (n) { return adfToText(n, depth, mediaNodes); }).join('');

      default:
        return children.map(function (n) { return adfToText(n, depth, mediaNodes); }).join('');
    }
  }

  // ─── Convert a single field value to plain text ──────────────────────────────

  function fieldToText(value, mediaNodes) {
    if (!value) return '(empty)';
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value.type === 'doc') return adfToText(value, 0, mediaNodes);
    return String(value);
  }

  // ─── Fetch image from Jira attachment API ─────────────────────────────────────

  function fetchJiraImage(mediaId, collection) {
    return new Promise((resolve, reject) => {
      // Try the attachment content endpoint first
      const url = `${BASE_URL}/rest/api/3/attachment/content/${mediaId}`;
      console.log(`[Jira Copilot] Fetching image: ${url}`);
      
      GM_xmlhttpRequest({
        method:          'GET',
        url:             url,
        responseType:    'blob',
        withCredentials: true,
        onload(res) {
          console.log(`[Jira Copilot] Image fetch response for ${mediaId}: ${res.status}`);
          if (res.status >= 200 && res.status < 300) {
            console.log(`[Jira Copilot] Successfully fetched image ${mediaId}, size: ${res.response.size} bytes`);
            resolve(res.response);
          } else {
            reject(new Error(`HTTP ${res.status} fetching image ${mediaId}`));
          }
        },
        onerror() {
          reject(new Error(`Network error fetching image ${mediaId}`));
        },
      });
    });
  }

  // ─── Convert blob to base64 data URL ───────────────────────────────────────────

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = function () { resolve(reader.result); };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // ─── Generate HTML with embedded images ────────────────────────────────────────

  function generateHTML(text, imageDataURLs) {
    // Convert plain text to basic HTML, preserving structure
    let html = '<div style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', sans-serif; font-size: 14px; line-height: 1.6;">';
    
    const lines = text.split('\n');
    let inCodeBlock = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Code blocks
      if (line === '```') {
        if (inCodeBlock) {
          html += '</code></pre>';
          inCodeBlock = false;
        } else {
          html += '<pre style="background: #f6f8fa; padding: 12px; border-radius: 6px; overflow-x: auto;"><code>';
          inCodeBlock = true;
        }
        continue;
      }
      
      if (inCodeBlock) {
        html += escapeHTML(line) + '\n';
        continue;
      }
      
      // Headings
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const content = escapeHTML(headingMatch[2]);
        html += `<h${level} style="margin-top: 16px; margin-bottom: 8px;">${content}</h${level}>`;
        continue;
      }
      
      // Horizontal rule
      if (line.trim() === '---') {
        html += '<hr style="border: none; border-top: 1px solid #e1e4e8; margin: 16px 0;" />';
        continue;
      }
      
      // Bullet points
      if (line.match(/^\s*•\s/)) {
        html += '<div style="margin-left: 20px;">' + escapeHTML(line) + '</div>';
        continue;
      }
      
      // Block quotes
      if (line.startsWith('> ')) {
        html += '<div style="border-left: 3px solid #ddd; padding-left: 12px; color: #666;">' + escapeHTML(line.substring(2)) + '</div>';
        continue;
      }
      
      // Image placeholders - replace with actual images
      const imageMatch = line.match(/\[Image: (.+?)\]/);
      if (imageMatch && imageDataURLs.length > 0) {
        const dataURL = imageDataURLs.shift();
        const alt = escapeHTML(imageMatch[1]);
        html += `<div style="margin: 12px 0;"><img src="${dataURL}" alt="${alt}" style="max-width: 100%; height: auto; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" /></div>`;
        continue;
      }
      
      // Regular lines
      if (line.trim()) {
        html += '<div>' + escapeHTML(line) + '</div>';
      } else {
        html += '<div style="height: 8px;"></div>';
      }
    }
    
    html += '</div>';
    return html;
  }

  // ─── Escape HTML special characters ────────────────────────────────────────────

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Main copilot action ──────────────────────────────────────────────────────

  async function runCopilot() {
    const btn = document.getElementById('jira-copilot-btn');
    btn.textContent = '⏳ Copying…';
    btn.disabled    = true;

    try {
      const ticketKey = getTicketKey();
      if (!ticketKey) {
        alert('No Jira ticket detected.\n\nOpen a specific ticket or click one on the board first.');
        return;
      }

      // Fetch issue — Jira returns all fields by default
      const issue  = await gmGet(`${BASE_URL}/rest/api/3/issue/${ticketKey}`);
      const fields = issue.fields;

      // ── Collect media nodes while parsing ─────────────────────────────────────
      const mediaNodes = [];

      // ── Header ────────────────────────────────────────────────────────────────
      const headerLine = `${ticketKey}: ${fields.summary}`;
      let output       = headerLine + '\n' + '='.repeat(headerLine.length) + '\n\n';

      // ── Description ──────────────────────────────────────────────────────────
      output += 'DESCRIPTION\n';
      output += '-----------\n';
      output += fieldToText(fields.description, mediaNodes) + '\n\n';

      // ── Acceptance Criteria ───────────────────────────────────────────────────
      const acFieldId = await findAcFieldId(fields);
      if (acFieldId) {
        output += 'ACCEPTANCE CRITERIA\n';
        output += '-------------------\n';
        output += fieldToText(fields[acFieldId], mediaNodes) + '\n';
      }

      output = output.trimEnd();

      // ── Fetch images if any were found ────────────────────────────────────────
      let imageDataURLs = [];
      console.log(`[Jira Copilot] Found ${mediaNodes.length} media nodes`);
      
      if (mediaNodes.length > 0) {
        btn.textContent = `⏳ Fetching ${mediaNodes.length} image${mediaNodes.length > 1 ? 's' : ''}…`;
        
        const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB limit
        const imagePromises = mediaNodes.map(async (media) => {
          try {
            const blob = await fetchJiraImage(media.id, media.collection);
            if (blob.size > MAX_IMAGE_SIZE) {
              console.warn(`[Jira Copilot] Skipping large image ${media.id} (${(blob.size / 1024 / 1024).toFixed(2)}MB)`);
              return null;
            }
            const dataURL = await blobToDataURL(blob);
            console.log(`[Jira Copilot] Converted image ${media.id} to data URL (length: ${dataURL.length})`);
            return dataURL;
          } catch (err) {
            console.error(`[Jira Copilot] Failed to fetch image ${media.id}:`, err);
            return null;
          }
        });
        
        const results = await Promise.all(imagePromises);
        imageDataURLs = results.filter(url => url !== null);
        console.log(`[Jira Copilot] Successfully fetched ${imageDataURLs.length} of ${mediaNodes.length} images`);
      }

      // ── Copy to clipboard with images ──────────────────────────────────────────
      if (imageDataURLs.length > 0) {
        console.log(`[Jira Copilot] Creating HTML clipboard item with ${imageDataURLs.length} images`);
        const html = generateHTML(output, imageDataURLs);
        console.log(`[Jira Copilot] Generated HTML length: ${html.length} characters`);
        
        const htmlBlob = new Blob([html], { type: 'text/html' });
        const textBlob = new Blob([output], { type: 'text/plain' });
        
        const clipboardItem = new ClipboardItem({
          'text/html': htmlBlob,
          'text/plain': textBlob
        });
        
        await navigator.clipboard.write([clipboardItem]);
        console.log(`[Jira Copilot] Clipboard write successful`);
        
        const imageText = `& ${imageDataURLs.length} image${imageDataURLs.length > 1 ? 's' : ''}`;
        GM_notification({
          title:   '🤖 Copilot — Copied!',
          text:    ticketKey + (acFieldId ? ' description, AC ' : ' description ') + imageText + ' copied to clipboard.',
          timeout: 4000,
        });
      } else {
        // No images, use text-only clipboard
        console.log(`[Jira Copilot] No images found or all failed, using text-only clipboard`);
        await navigator.clipboard.writeText(output);
        
        GM_notification({
          title:   '🤖 Copilot — Copied!',
          text:    ticketKey + (acFieldId ? ' description & AC' : ' description') + ' copied to clipboard.',
          timeout: 4000,
        });
      }

    } catch (err) {
      console.error('[Jira Copilot]', err);
      alert('Copilot failed:\n' + err.message);
    } finally {
      btn.textContent = '🤖 Copilot';
      btn.disabled    = false;
    }
  }

  // ─── Show or hide button depending on whether a ticket is in view ─────────────

  function syncButton() {
    const existing = document.getElementById('jira-copilot-btn');

    if (isOnTicketPage()) {
      if (existing) return; // Already injected — nothing to do

      const btn = document.createElement('button');
      btn.id          = 'jira-copilot-btn';
      btn.textContent = '🤖 Copilot';

      // Positioned directly to the left of the Standup button (right: 45px, ~100px wide)
      Object.assign(btn.style, {
        position:     'fixed',
        bottom:       '75px',
        right:        '155px',
        zIndex:       '99999',
        padding:      '10px 18px',
        background:   '#6B46C1',
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

      btn.addEventListener('mouseenter', function () { btn.style.background = '#805AD5'; });
      btn.addEventListener('mouseleave', function () { btn.style.background = '#6B46C1'; });
      btn.addEventListener('click', runCopilot);

      document.body.appendChild(btn);
    } else {
      if (existing) existing.remove();
    }
  }

  // ─── Watch for SPA navigation — Jira changes the URL without a full page load ─

  let lastHref = window.location.href;
  setInterval(function () {
    const currentHref = window.location.href;
    if (currentHref !== lastHref) {
      lastHref = currentHref;
      syncButton();
    }
  }, 500);

  // ─── Initial inject on page load ──────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncButton);
  } else {
    syncButton();
  }

})();
