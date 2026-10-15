// ==UserScript==
// @name         Nebula Telemundo – Open Negasonic
// @namespace    nbc-tools
// @version      1.0
// @description  Open the Negasonic scm-document for the Telemundo entity being edited in Nebula
// @match        https://*.nbcnewstools.net/telemundo/*
// @grant        GM_xmlhttpRequest
// @connect      nbcnewstools.net
// ==/UserScript==

(function () {
  'use strict';

  // Nebula host -> paired Multiverse + Negasonic hosts
  const ENVS = {
    'uat-nebula.dev.nbcnewstools.net': {
      multiverse: 'https://uat-multiverse-telemundo.dev.nbcnewstools.net',
      negasonic: 'https://develop-negasonic.dev.nbcnewstools.net',
    },
  };

  // Nebula entity param -> [JSON:API resource from stardust SOURCE.json, Negasonic prefix]
  const TYPES = {
    'curated-content-list': ['node/curated_content_list', 'tmcl'],
    marquee: ['node/marquee', 'tmbr'],
    organization: ['node/organization', 'tmrg'],
    person: ['node/person', 'tmpn'],
    brand: ['node/brand', 'tmsr'],
    'tv-show': ['node/tv_show', 'tmsr'],
    'section-show-brand': ['node/section_shows_brands', 'tmsr'],
    'tv-season': ['node/tv_season', 'tmsn'],
    'mpx-video': ['media/mpx_video', 'tmvo'],
    'video-playlist': ['dynamic_queue/video_playlist', 'tmls'],
    'menu-link': ['menu_link_content/menu_link_content', 'tmmn'],
    'taxonomy-category': ['taxonomy_term/categories', 'tmtx'],
    genre: ['taxonomy_term/genre', 'tmtx'],
    'taxonomy-keyword': ['taxonomy_term/keywords', 'tmtx'],
    'taxonomy-mpx': ['taxonomy_term/mpx_categories', 'tmtx'],
    'taxonomy-subsection': ['taxonomy_term/subsection', 'tmtx'],
  };

  const env = ENVS[location.host];
  if (!env) return;

  /**
   * Parses the current Nebula entity edit URL.
   * @returns {{resource: string, prefix: string, uuid: string}|null} Entity info, or null when not on a supported edit page
   */
  function parsePage() {
    const m = location.pathname.match(/^\/telemundo\/entity\/edit\/([^/]+)\/([0-9a-f-]{36})/i);
    if (!m || !TYPES[m[1]]) return null;
    const [resource, prefix] = TYPES[m[1]];
    return { resource, prefix, uuid: m[2] };
  }

  /**
   * Fetches the Drupal internal id for a UUID from Multiverse JSON:API.
   * @param {string} resource - JSON:API resource path, e.g. node/curated_content_list
   * @param {string} uuid - Entity UUID
   * @returns {Promise<string>} Drupal internal id
   */
  function fetchInternalId(resource, uuid) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `${env.multiverse}/api/${resource}/${uuid}`,
        headers: { Accept: 'application/vnd.api+json' },
        onload: (res) => {
          try {
            const attrs = JSON.parse(res.responseText).data.attributes;
            const id = attrs.drupal_internal__nid ?? attrs.drupal_internal__tid
              ?? attrs.drupal_internal__mid ?? attrs.drupal_internal__id;
            id ? resolve(String(id)) : reject(new Error('No drupal_internal id in response'));
          } catch (e) {
            reject(new Error(`Multiverse returned ${res.status}`));
          }
        },
        onerror: () => reject(new Error('Request to Multiverse failed')),
      });
    });
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Open Negasonic';
  Object.assign(button.style, {
    position: 'fixed', bottom: '16px', left: '16px', zIndex: 10000,
    padding: '8px 14px', background: '#0550e6', color: '#fff',
    border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: '600',
  });

  button.addEventListener('click', async () => {
    const page = parsePage();
    if (!page) return;
    // Open the tab synchronously so the popup blocker allows it, then navigate after the lookup.
    const tab = window.open('about:blank', '_blank');
    try {
      const id = await fetchInternalId(page.resource, page.uuid);
      tab.opener = null;
      tab.location.href = `${env.negasonic}/scm-documents/${page.prefix}${id}`;
    } catch (e) {
      tab.close();
      alert(`Could not resolve Negasonic id: ${e.message}`);
    }
  });

  document.body.appendChild(button);

  // Nebula is an SPA, so show the button only while on a supported edit route.
  setInterval(() => { button.style.display = parsePage() ? '' : 'none'; }, 1000);
})();