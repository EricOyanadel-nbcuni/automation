// ==UserScript==
// @name         Nebula Message Logs — Better Modal
// @namespace    http://tampermonkey.net/
// @version      1.0
// @lastModified 2026-10-07
// @description  Widens the Message Logs message/response modal, makes it scrollable, and adds a Copy button
// @author       You
// @match        https://*.nbcnewstools.net/*
// @match        http://localhost:*/*
// @match        http://127.0.0.1:*/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
    .modal-dialog:has(pre.modal-body) {
      max-width: min(1400px, 92vw);
    }
    .modal-dialog:has(pre.modal-body) .modal-content {
      max-height: 90vh;
    }
    pre.modal-body {
      max-height: 75vh;
      overflow: auto;
      margin: 0;
      padding: 16px 20px;
      background: #1e1e1e;
      color: #d4d4d4;
      font-family: Menlo, Monaco, Consolas, "Courier New", monospace;
      font-size: 13px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      tab-size: 2;
    }
    .nml-copy-btn {
      margin-left: auto;
      margin-right: 12px;
      padding: 4px 14px;
      background: #0d6efd;
      color: #fff;
      border: none;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .nml-copy-btn:hover { background: #0b5ed7; }
    .nml-copy-btn.nml-copied { background: #198754; }
    .modal-header:has(.nml-copy-btn) { align-items: center; }
    .modal-header:has(.nml-copy-btn) .close { margin-left: 0; }
  `;
  document.head.appendChild(style);

  function enhanceModal(modal) {
    const pre = modal.querySelector('pre.modal-body');
    const header = modal.querySelector('.modal-header');
    if (!pre || !header || header.querySelector('.nml-copy-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nml-copy-btn';
    btn.textContent = 'Copy';

    btn.addEventListener('click', async function () {
      try {
        await navigator.clipboard.writeText(pre.textContent);
        btn.textContent = 'Copied!';
        btn.classList.add('nml-copied');
      } catch (err) {
        console.error('[Nebula Message Logs]', err);
        btn.textContent = 'Copy failed';
      }
      setTimeout(function () {
        btn.textContent = 'Copy';
        btn.classList.remove('nml-copied');
      }, 1500);
    });

    const closeBtn = header.querySelector('.close');
    header.insertBefore(btn, closeBtn);
  }

  // Modals are rendered dynamically by the SPA, so watch for them
  const observer = new MutationObserver(function () {
    document.querySelectorAll('.modal').forEach(enhanceModal);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
