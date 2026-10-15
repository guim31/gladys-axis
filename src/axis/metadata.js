// -----------------------------------------------------------------------------
// The events of an Axis device, whichever stream carried them, as one shape:
//
//   { topic, operation, source: { name: value }, data: { name: value } }
//
//   - RTSP metadata stream: ONVIF XML documents, one or more
//     `<wsnt:NotificationMessage>` each (topic, `PropertyOperation`
//     Initialized / Changed / Deleted, `SimpleItem`s of the Source and of the
//     Data);
//   - WebSocket stream: JSON-RPC `events:notify` messages whose
//     `params.notification` holds `topic` and `message.{source,data}`.
//
// Prefixes vary between firmwares (`tt:`, `wsnt:`, none): the parser ignores
// them. (Shapes from Kane610/axis, MIT, and its test fixtures.)
// -----------------------------------------------------------------------------

import { decodeXml, parseAttributes } from './parse.js';

export const OPERATIONS = Object.freeze({
  INITIALIZED: 'Initialized',
  CHANGED: 'Changed',
  DELETED: 'Deleted',
});

const blockOf = (xml, name) => {
  const match = xml.match(
    new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>)`),
  );
  return match ? (match[1] ?? '') : null;
};

/** The SimpleItems of a block, `Name` → `Value`; the first occurrence wins. */
function simpleItems(block) {
  const items = {};
  if (!block) {
    return items;
  }
  for (const [tag] of block.matchAll(/<(?:[\w-]+:)?SimpleItem\b[^>]*>/g)) {
    const attributes = parseAttributes(tag);
    if (attributes.Name !== undefined && !(attributes.Name in items)) {
      items[attributes.Name] = attributes.Value ?? '';
    }
  }
  return items;
}

/**
 * Every event of one metadata document (an RTSP frame).
 * @param {string|Buffer} xml
 * @returns {Array<{ topic, operation, source, data }>}
 */
export function parseMetadata(xml) {
  const text = Buffer.isBuffer(xml) ? xml.toString('utf8') : String(xml ?? '');
  const events = [];
  const pattern =
    /<(?:[\w-]+:)?NotificationMessage\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?NotificationMessage>/g;
  for (const [, body] of text.matchAll(pattern)) {
    const topicMatch = body.match(/<(?:[\w-]+:)?Topic\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Topic>/);
    const topic = topicMatch ? decodeXml(topicMatch[1]).trim() : '';
    if (!topic) {
      continue;
    }
    const messageTag = body.match(/<(?:[\w-]+:)?Message\b[^>]*PropertyOperation[^>]*>/);
    const operation = messageTag
      ? (parseAttributes(messageTag[0]).PropertyOperation ?? OPERATIONS.CHANGED)
      : OPERATIONS.CHANGED;
    events.push({
      topic,
      operation,
      source: simpleItems(blockOf(body, 'Source')),
      data: simpleItems(blockOf(body, 'Data')),
    });
  }
  return events;
}

const flat = (object) =>
  Object.fromEntries(
    Object.entries(object && typeof object === 'object' ? object : {})
      .filter(([, value]) => value === null || typeof value !== 'object')
      .map(([key, value]) => [key, value === null ? '' : String(value)]),
  );

/**
 * The event of one WebSocket message, or null when it is not a notification.
 * @param {object} message a parsed JSON-RPC message
 */
export function parseNotification(message) {
  if (message?.method !== 'events:notify') {
    return null;
  }
  const notification = message.params?.notification;
  if (!notification || typeof notification.topic !== 'string' || !notification.topic) {
    return null;
  }
  const body = notification.message ?? {};
  return {
    topic: notification.topic,
    // The WebSocket stream says nothing of the operation: every message is a
    // value of the property, as a change.
    operation: body.operation ?? body.propertyOperation ?? OPERATIONS.CHANGED,
    source: flat(body.source),
    data: flat(body.data),
  };
}
