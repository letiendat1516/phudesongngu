/**
 * TTML/DFXP Subtitle Parser
 * Parses Netflix's TTML subtitle format into cue objects.
 */
const TTMLParser = (function () {
  'use strict';

  /**
   * Convert a TTML time string to seconds.
   * @param {string} timeStr - The time string (e.g. "191051109t", "00:01:30.500", "90.5s")
   * @param {number} tickRate - Ticks per second (from ttp:tickRate attribute)
   * @param {number} frameRate - Frames per second (from ttp:frameRate, fallback)
   * @param {number} subFrameRate - Sub-frames per frame (from ttp:subFrameRate)
   */
  function timeToSeconds(timeStr, tickRate, frameRate, subFrameRate) {
    if (!timeStr) return 0;

    tickRate = tickRate || 1;
    frameRate = frameRate || 25;
    subFrameRate = subFrameRate || 1;

    timeStr = String(timeStr).trim();

    // Format: HH:MM:SS.mmm or HH:MM:SS,mmm
    const hmsMatch = timeStr.match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
    if (hmsMatch) {
      const h = parseInt(hmsMatch[1], 10);
      const m = parseInt(hmsMatch[2], 10);
      const s = parseInt(hmsMatch[3], 10);
      const ms = parseInt(hmsMatch[4].padEnd(3, '0'), 10);
      return h * 3600 + m * 60 + s + ms / 1000;
    }

    // Format: HH:MM:SS (no milliseconds)
    const hmsNoMs = timeStr.match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
    if (hmsNoMs) {
      const h = parseInt(hmsNoMs[1], 10);
      const m = parseInt(hmsNoMs[2], 10);
      const s = parseInt(hmsNoMs[3], 10);
      return h * 3600 + m * 60 + s;
    }

    // Format: MM:SS.mmm
    const msMatch = timeStr.match(/^(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
    if (msMatch) {
      const m = parseInt(msMatch[1], 10);
      const s = parseInt(msMatch[2], 10);
      const ms = parseInt(msMatch[3].padEnd(3, '0'), 10);
      return m * 60 + s + ms / 1000;
    }

    // Format: HH:MM:SS:FF (frames) — uses frameRate
    const hmsfMatch = timeStr.match(/^(\d{1,2}):(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
    if (hmsfMatch) {
      const h = parseInt(hmsfMatch[1], 10);
      const m = parseInt(hmsfMatch[2], 10);
      const s = parseInt(hmsfMatch[3], 10);
      const f = parseInt(hmsfMatch[4], 10);
      return h * 3600 + m * 60 + s + f / frameRate;
    }

    // Format: ticks (e.g. "191051109t") — uses tickRate
    const tickMatch = timeStr.match(/^(\d+)t$/);
    if (tickMatch) {
      return parseInt(tickMatch[1], 10) / tickRate;
    }

    // Format: frames (e.g. "456f") — uses frameRate
    const frameMatch = timeStr.match(/^(\d+)f$/);
    if (frameMatch) {
      return parseInt(frameMatch[1], 10) / frameRate;
    }

    // Format: Ns, N.Ns, N.NNs (seconds with unit)
    const secMatch = timeStr.match(/^(\d+(?:\.\d+)?)s$/);
    if (secMatch) {
      return parseFloat(secMatch[1]);
    }

    // Format: plain number (assume seconds)
    const plainNum = timeStr.match(/^(\d+(?:\.\d+)?)$/);
    if (plainNum) {
      return parseFloat(plainNum[1]);
    }

    return 0;
  }

  /**
   * Extract text from a DOM element, converting <br/> to \n and
   * treating </span> boundaries as line breaks (Netflix uses spans for lines).
   * This is more reliable than innerHTML for XML-parsed TTML.
   */
  function extractTextFromNode(element) {
    let result = '';
    for (let i = 0; i < element.childNodes.length; i++) {
      const node = element.childNodes[i];
      if (node.nodeType === 3) {
        // Text node
        result += node.textContent;
      } else if (node.nodeType === 1) {
        // Element node
        const tag = (node.localName || node.nodeName || '').toLowerCase();
        if (tag === 'br') {
          result += '\n';
        } else if (tag === 'span' || tag === 'p' || tag === 'div') {
          // Recurse into container elements
          result += extractTextFromNode(node);
          // Add a line break after a span if there is a following sibling
          // (Netflix puts each subtitle line in its own span)
          if (tag === 'span' && node.nextSibling) {
            result += '\n';
          }
        } else {
          // Other elements — just get their text content
          result += node.textContent;
        }
      }
    }
    return stripTags(result);
  }

  /**
   * Strip HTML/XML tags from text and decode entities.
   */
  function stripTags(text) {
    if (!text) return '';

    return text
      // <br> tags → newline. Use \b to also match <br xmlns="..."> etc.
      .replace(/<br\b[^>]*>/gi, '\n')
      // Closing </span> → newline (Netflix uses spans for each line)
      .replace(/<\/span\s*>/gi, '\n')
      .replace(/<span[^>]*>/gi, '')
      .replace(/<\/?(div|p|body)[^>]*>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
      // Collapse spaces/tabs but PRESERVE newlines (so multi-line subs keep line breaks)
      .replace(/[^\S\n]+/g, ' ')
      // Collapse 3+ consecutive newlines into max 2
      .replace(/\n{3,}/g, '\n\n')
      // Trim each line
      .split('\n').map(function (l) { return l.trim(); }).join('\n')
      .trim();
  }

  /**
   * Parse TTML/DFXP XML string into an array of cue objects.
   * Returns: { language, cues: [{start, end, text}] }
   */
  function parse(xmlString) {
    const result = { language: '', cues: [] };

    if (!xmlString || typeof xmlString !== 'string') return result;

    let doc;
    try {
      const parser = new DOMParser();
      doc = parser.parseFromString(xmlString, 'text/xml');
    } catch (e) {
      return parseFallback(xmlString);
    }

    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      return parseFallback(xmlString);
    }

    // ===== Extract tickRate / frameRate from the root <tt> element =====
    const ttEl = doc.querySelector('tt') || doc.documentElement;
    let tickRate = 0;
    let frameRate = 0;
    let subFrameRate = 1;
    let language = '';

    if (ttEl) {
      // ttp:tickRate — Netflix uses 10000000 (10M ticks per second)
      const tr = ttEl.getAttribute('ttp:tickRate');
      if (tr) tickRate = parseInt(tr, 10);

      const fr = ttEl.getAttribute('ttp:frameRate');
      if (fr) frameRate = parseInt(fr, 10);

      const sfr = ttEl.getAttribute('ttp:subFrameRate');
      if (sfr) subFrameRate = parseInt(sfr, 10);

      // xml:lang on root element
      language = ttEl.getAttribute('xml:lang') || ttEl.getAttribute('lang') || '';
    }

    // Fallback: detect tickRate from the time values if not specified
    // (Netflix always specifies it, but just in case)
    if (!tickRate) {
      // Try to detect from a sample time value
      const sampleP = doc.querySelector('p[begin]');
      if (sampleP) {
        const begin = sampleP.getAttribute('begin') || '';
        const tickMatch = begin.match(/^(\d+)t$/);
        if (tickMatch) {
          // If the value is very large, assume 10M ticks/sec (Netflix default)
          const val = parseInt(tickMatch[1], 10);
          if (val > 100000) {
            tickRate = 10000000;
          } else {
            tickRate = 1;
          }
        }
      }
    }

    result.language = language;
    result.tickRate = tickRate;

    // ===== Extract all <p> cues =====
    const paragraphs = doc.querySelectorAll('p');

    paragraphs.forEach(function (p) {
      const begin = p.getAttribute('begin');
      const end = p.getAttribute('end');
      const dur = p.getAttribute('dur');

      if (!begin) return;

      let startTime = timeToSeconds(begin, tickRate, frameRate, subFrameRate);
      let endTime;

      if (end) {
        endTime = timeToSeconds(end, tickRate, frameRate, subFrameRate);
      } else if (dur) {
        endTime = startTime + timeToSeconds(dur, tickRate, frameRate, subFrameRate);
      } else {
        endTime = startTime + 5;
      }

      // Extract text content with proper line breaks from <br> and </span>.
      // Using a DOM tree walk is more reliable than innerHTML for XML documents
      // (which may not serialize <br/> correctly).
      const text = extractTextFromNode(p);

      if (text) {
        result.cues.push({
          start: startTime,
          end: endTime,
          text: text
        });
      }
    });

    result.cues.sort((a, b) => a.start - b.start);
    return result;
  }

  /**
   * Fallback regex-based parser for when DOMParser fails.
   */
  function parseFallback(xmlString) {
    const result = { language: '', cues: [] };

    // Extract tickRate
    const tickRateMatch = xmlString.match(/ttp:tickRate="(\d+)"/);
    const tickRate = tickRateMatch ? parseInt(tickRateMatch[1], 10) : 10000000;

    // Extract language
    const langMatch = xmlString.match(/xml:lang="([^"]+)"/);
    result.language = langMatch ? langMatch[1] : '';
    result.tickRate = tickRate;

    // Match <p> elements
    const pRegex = /<p\b[^>]*?\bbegin=["']([^"']+)["'][^>]*?(?:\bend=["']([^"']+)["'])?[^>]*?>([\s\S]*?)<\/p>/gi;

    let match;
    while ((match = pRegex.exec(xmlString)) !== null) {
      const begin = match[1];
      const end = match[2] || null;
      const innerContent = match[3];

      let durMatch = match[0].match(/\bdur=["']([^"']+)["']/);

      const startTime = timeToSeconds(begin, tickRate);
      let endTime;

      if (end) {
        endTime = timeToSeconds(end, tickRate);
      } else if (durMatch) {
        endTime = startTime + timeToSeconds(durMatch[1], tickRate);
      } else {
        endTime = startTime + 5;
      }

      const text = stripTags(innerContent);
      if (text) {
        result.cues.push({ start: startTime, end: endTime, text: text });
      }
    }

    result.cues.sort((a, b) => a.start - b.start);
    return result;
  }

  /**
   * Check if a string looks like TTML/DFXP content.
   */
  function isTTML(data) {
    if (!data || typeof data !== 'string') return false;
    const trimmed = data.trim();
    return (
      trimmed.startsWith('<?xml') ||
      trimmed.startsWith('<tt') ||
      trimmed.indexOf('<tt ') !== -1 ||
      trimmed.indexOf('<tt>') !== -1 ||
      trimmed.indexOf('xmlns="http://www.w3.org/ns/ttml"') !== -1
    );
  }

  return {
    parse: parse,
    timeToSeconds: timeToSeconds,
    stripTags: stripTags,
    isTTML: isTTML
  };
})();
