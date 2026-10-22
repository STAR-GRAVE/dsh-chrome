/**
 * The MAIN-world tap: console and network capture that must run in the page's
 * own JavaScript world.
 *
 * An isolated world can see the DOM but not the page's `console` calls or its
 * `fetch` invocations, so capture has to be installed in the page world at
 * `document_start`. It deliberately writes only into a namespaced global with
 * bounded ring buffers — no messaging, no DOM, no side channel — so the reading
 * side can drain it on demand from either transport.
 *
 * @module @local/dsh-chrome/tap-script
 */

/** Global the tap installs into the page world. */
export const TAP_GLOBAL = '__dshChromeTap'

/**
 * Source text of the tap. Self-contained: a browser evaluates it as inert text
 * in another realm, so it may not reference this module's scope.
 */
export const TAP_SOURCE = String.raw`(function () {
  'use strict';
  var GLOBAL = '__dshChromeTap';
  if (globalThis[GLOBAL] && globalThis[GLOBAL].version === 1) return;

  var LIMIT = 400;
  var consoleBuffer = [];
  var networkBuffer = [];
  var pending = new Map();

  function stamp() {
    var d = new Date();
    return d.toISOString().slice(11, 23);
  }

  function clip(text, max) {
    var flat = String(text == null ? '' : text);
    if (flat.length <= max) return flat;
    return flat.slice(0, max - 1) + '\u2026';
  }

  function describeArg(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    var type = typeof value;
    if (type === 'string') return value;
    if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value);
    if (type === 'function') return '[function ' + (value.name || 'anonymous') + ']';
    if (type === 'symbol') return String(value);
    if (value && value.nodeType === 1) return '<' + value.tagName.toLowerCase() + '>';
    if (value instanceof Error) return value.name + ': ' + value.message;
    try {
      var json = JSON.stringify(value, function (key, inner) {
        if (typeof inner === 'function') return '[function]';
        if (typeof inner === 'bigint') return String(inner);
        return inner;
      });
      return json === undefined ? String(value) : json;
    } catch (error) {
      return String(value);
    }
  }

  function record(level, args, source) {
    consoleBuffer.push({
      time: stamp(),
      level: level,
      text: clip(Array.prototype.map.call(args, describeArg).join(' '), 4000),
      source: source || null
    });
    if (consoleBuffer.length > LIMIT) consoleBuffer.splice(0, consoleBuffer.length - LIMIT);
  }

  var LEVELS = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  for (var i = 0; i < LEVELS.length; i += 1) {
    (function (level) {
      var original = console[level];
      console[level] = function () {
        record(level, arguments, null);
        if (typeof original === 'function') {
          try { return original.apply(console, arguments); } catch (error) { return undefined; }
        }
        return undefined;
      };
    })(LEVELS[i]);
  }

  globalThis.addEventListener('error', function (event) {
    record('uncaught', [event.error || event.message], event.filename || null);
  }, true);

  globalThis.addEventListener('unhandledrejection', function (event) {
    record('unhandledrejection', [event.reason], null);
  }, true);

  function remember(url, method) {
    var entry = {
      id: pending.size + 1,
      method: method || 'GET',
      url: clip(url, 2000),
      status: null,
      ms: null,
      bytes: null,
      failed: false,
      startedAt: Date.now(),
      time: stamp()
    };
    networkBuffer.push(entry);
    if (networkBuffer.length > LIMIT) networkBuffer.splice(0, networkBuffer.length - LIMIT);
    return entry;
  }

  function finish(entry, status, bytes, failed) {
    if (!entry) return;
    entry.status = status === undefined ? null : status;
    entry.failed = failed === true;
    entry.ms = Date.now() - entry.startedAt;
    if (bytes !== undefined) entry.bytes = bytes;
  }

  if (typeof globalThis.fetch === 'function') {
    var originalFetch = globalThis.fetch;
    globalThis.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
      var method = (init && init.method) || (input && input.method) || 'GET';
      var entry = remember(url, String(method).toUpperCase());
      return originalFetch.apply(this, arguments).then(
        function (response) {
          var length = null;
          try {
            var header = response.headers.get('content-length');
            if (header !== null) length = Number(header);
          } catch (error) { length = null; }
          finish(entry, response.status, length, !response.ok);
          return response;
        },
        function (error) {
          finish(entry, null, null, true);
          throw error;
        }
      );
    };
  }

  if (typeof globalThis.XMLHttpRequest === 'function') {
    var open = globalThis.XMLHttpRequest.prototype.open;
    var send = globalThis.XMLHttpRequest.prototype.send;
    globalThis.XMLHttpRequest.prototype.open = function (method, url) {
      this.__dshEntry = remember(String(url), String(method || 'GET').toUpperCase());
      return open.apply(this, arguments);
    };
    globalThis.XMLHttpRequest.prototype.send = function () {
      var entry = this.__dshEntry;
      var xhr = this;
      this.addEventListener('loadend', function () {
        var bytes = null;
        try {
          var length = xhr.getResponseHeader('content-length');
          if (length !== null) bytes = Number(length);
        } catch (error) { bytes = null; }
        finish(entry, xhr.status, bytes, xhr.status === 0 || xhr.status >= 400);
      });
      return send.apply(this, arguments);
    };
  }

  globalThis[GLOBAL] = {
    version: 1,
    drainConsole: function (limit) {
      var take = Math.min(consoleBuffer.length, limit || 50);
      var out = consoleBuffer.slice(Math.max(0, consoleBuffer.length - take));
      return { entries: out, total: consoleBuffer.length };
    },
    drainNetwork: function (limit) {
      var take = Math.min(networkBuffer.length, limit || 50);
      var out = networkBuffer.slice(Math.max(0, networkBuffer.length - take));
      return { entries: out, total: networkBuffer.length };
    },
    clear: function () {
      consoleBuffer.length = 0;
      networkBuffer.length = 0;
    },
    clearConsole: function () { consoleBuffer.length = 0; },
    clearNetwork: function () { networkBuffer.length = 0; }
  };
})();`;
