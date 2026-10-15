// -----------------------------------------------------------------------------
// Parsers of the plain answers of VAPIX: `param.cgi` lines and the small XML
// documents of the applications list. No XML library: the shapes are flat
// and known, and the sandbox has 256 MB.
// -----------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML entities decoded (`&amp;`, `&#233;`, `&#xE9;`). */
export function decodeXml(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * `param.cgi?action=list` lines (`root.Brand.ProdNbr=M1065-LW`) into an
 * object keyed without the `root.` prefix. Error lines (`# Error: …`) and
 * blank lines are skipped: a group the device does not have is simply absent.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseParams(text) {
  const params = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) {
      continue;
    }
    const at = line.indexOf('=');
    if (at <= 0) {
      continue;
    }
    const key = line
      .slice(0, at)
      .trim()
      .replace(/^root\./, '');
    params[key] = line.slice(at + 1).trim();
  }
  return params;
}

/** The attributes of one XML start tag, names as written. */
export function parseAttributes(tag) {
  const attributes = {};
  for (const [, name, double, single] of String(tag).matchAll(
    /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    attributes[name] = decodeXml(double ?? single);
  }
  return attributes;
}

/**
 * The applications of `/axis-cgi/applications/list.cgi`:
 * `<reply result="ok"><application Name="vmd" Status="Running" …/></reply>`.
 * @returns {Array<{ name: string, niceName: string, status: string }>}
 */
export function parseApplications(xml) {
  const list = [];
  for (const [tag] of String(xml ?? '').matchAll(/<application\b[^>]*>/gi)) {
    const attributes = parseAttributes(tag);
    if (attributes.Name) {
      list.push({
        name: attributes.Name,
        niceName: attributes.NiceName ?? attributes.Name,
        status: attributes.Status ?? '',
      });
    }
  }
  return list;
}

/** `yes`/`no`, `true`/`false`, `1`/`0` as a boolean; null when absent. */
export function yesNo(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return /^(yes|true|1|on)$/i.test(String(value).trim());
}
