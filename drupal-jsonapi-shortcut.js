// ==UserScript==
// @name         Multiverse Telemundo – Open JSON:API
// @namespace    nbc-tools
// @version      1.0
// @description  Open the JSON:API resource for the entity being edited, matching Stardust SOURCE.json
// @match        https://*.nbcnewstools.net/node/*/edit*
// @match        https://*.nbcnewstools.net/media/*/edit*
// @match        https://*.nbcnewstools.net/taxonomy/term/*/edit*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Query strings copied from stardust/config/NEBULA/TELEMUNDO_CMS/TELEMUNDO/*/SOURCE.json
  const QUERY = {
    'node/brand': 'include=field_cover_image,field_promotional_image&jsonapi_include=1',
    'node/curated_content_list': 'include=field_qt_curated_content',
    'node/organization': 'include=field_primary_image,field_teaser_image,field_social_image&jsonapi_include=1',
    'node/person': 'include=field_cover_image,field_promotional_image&jsonapi_include=1',
    'node/tv_season': 'include=field_show&jsonapi_include=1',
    'node/tv_show': 'include=field_cover_image,field_promotional_image&jsonapi_include=1',
    'media/mpx_video':
      'include=resolved_video_playlist,field_associated_video_playlist,field_subsection.field_associated_video_playlist,field_show.field_associated_video_playlist,field_brand.field_associated_video_playlist,field_promotional_image.field_media_cloudinary_image&jsonapi_include=1',
  };

  const ENTITY = {
    node: { type: 'node', formPrefix: 'node', idField: 'drupal_internal__nid' },
    media: { type: 'media', formPrefix: 'media', idField: 'drupal_internal__mid' },
    'taxonomy/term': { type: 'taxonomy_term', formPrefix: 'taxonomy-term', idField: 'drupal_internal__tid' },
  };

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const match = location.pathname.match(/^\/(node|media|taxonomy\/term)\/(\d+)\/edit/);
  if (!match) return;
  const [, pathType, entityId] = match;
  const entity = ENTITY[pathType];

  /**
   * Reads the bundle from the Drupal form id, e.g. node-curated-content-list-edit-form -> curated_content_list.
   * @returns {string|null} Bundle machine name
   */
  function getBundle() {
    const re = new RegExp(`^${entity.formPrefix}-(.+?)-(?:edit-)?form(?:--[\\w-]+)?$`);
    for (const form of document.forms) {
      const m = form.id.match(re);
      if (m) return m[1].replace(/-/g, '_');
    }
    return null;
  }

  /**
   * Finds the UUID shown in the Metadata sidebar.
   * @returns {string|null} Entity UUID
   */
  function getUuid() {
    const fields = document.querySelectorAll('input, [class*="uuid"], [id*="uuid"]');
    for (const el of fields) {
      const value = (el.value ?? el.textContent ?? '').trim();
      if (UUID_RE.test(value) && /uuid/i.test(`${el.name || ''} ${el.id} ${el.className}`)) return value;
    }
    return null;
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Open JSON:API';
  Object.assign(button.style, {
    position: 'fixed', bottom: '16px', left: '16px', zIndex: 10000,
    padding: '8px 14px', background: '#0550e6', color: '#fff',
    border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: '600',
  });

  button.addEventListener('click', () => {
    const bundle = getBundle();
    if (!bundle) {
      alert('Could not detect the bundle on this page.');
      return;
    }
    const key = `${entity.type}/${bundle}`;
    const uuid = getUuid();
    // Without a UUID, use a collection filter on the internal id instead.
    const query = [QUERY[key], uuid ? '' : `filter[${entity.idField}]=${entityId}`].filter(Boolean).join('&');
    const url = `${location.origin}/api/${key}${uuid ? `/${uuid}` : ''}${query ? `?${query}` : ''}`;
    window.open(url, '_blank', 'noopener');
  });

  document.body.appendChild(button);
})();