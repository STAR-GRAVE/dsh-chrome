/**
 * The page-side runtime shared by BOTH transports.
 *
 * `PAGE_RUNTIME_SOURCE` is the exact text installed into a page's isolated
 * world: the extension injects it with `chrome.scripting.executeScript({files})`
 * and the CDP backend evaluates it with `Runtime.evaluate` in a named isolated
 * world. Keeping one source is what makes snapshot/act behave identically, so
 * `scripts/sync-extension.mjs` writes it to `extension/injected-page.js` and
 * `test/page-script.test.mjs` asserts the two copies never drift.
 *
 * The source is self-contained on purpose: nothing inside it may reference this
 * module's scope, because a browser executes it as inert text in another realm.
 *
 * @module @star-grave/dsh-chrome/page-script
 */

/** Attribute an element carries while it owns a ref from the latest snapshot. */
export const REF_ATTR = 'data-dsh-ref';

/** Global the installed runtime hangs off, in both worlds. */
export const RUNTIME_GLOBAL = '__dshChrome';

/**
 * Version stamped into the injected runtime.
 *
 * The extension's worker keeps its own copy (`EXPECTED_RUNTIME_VERSION` in
 * `extension/sw.js`) because it cannot import this module. Both the CDP lane's
 * "already installed?" probe and the runtime's own early return compare against
 * this number, so raising it invalidates every already-injected page.
 */
export const RUNTIME_VERSION = 4;

/**
 * Source text of the page runtime. Written with `String.raw` so the regexes and
 * escapes it contains survive verbatim; the body therefore contains no template
 * literals and no `${` sequences.
 */
export const PAGE_RUNTIME_SOURCE = String.raw`(function () {
  'use strict';
  var REF_ATTR = 'data-dsh-ref';
  var GLOBAL = '__dshChrome';
  if (globalThis[GLOBAL] && globalThis[GLOBAL].version === 4) return;

  var refs = new Map();
  var nextRef = 1;
  var generation = 0;

  var INTERACTIVE = 'a,button,input,select,textarea,label,summary,details,option,'
    + '[role],[contenteditable=""],[contenteditable="true"],[tabindex],[onclick],[href]';

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    var style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (!style) return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.display === 'none') return false;
    if (parseFloat(style.opacity) === 0) return false;
    if (typeof el.checkVisibility === 'function' && el.checkVisibility() === false) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) return false;
    // Exclude elements parked outside the viewport horizontally (the
    // screen-reader-only left:-9999px idiom). Elements below the fold stay
    // listed: a snapshot must cover the whole document, not just what is
    // visible without scrolling.
    var width = globalThis.innerWidth || 0;
    if (width > 0 && (rect.right < 0 || rect.left > width)) return false;
    return true;
  }

  function isDisabled(el) {
    if (el.disabled === true) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    return false;
  }

  function roleOf(el) {
    var explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit.trim().toLowerCase();
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'label') return 'label';
    if (tag === 'option') return 'option';
    if (tag === 'details') return 'group';
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'file') return 'file';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  }

  function nameOf(el) {
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    var labelled = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelled) {
      var doc = el.ownerDocument;
      var parts = String(labelled).split(/\s+/).map(function (id) {
        var target = doc.getElementById(id);
        return target ? (target.innerText || target.textContent || '').trim() : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.id) {
        var label = el.ownerDocument.querySelector('label[for="' + el.id.replace(/"/g, '\\"') + '"]');
        if (label) {
          var text = (label.innerText || label.textContent || '').trim();
          if (text) return text;
        }
      }
      var wrapper = el.closest && el.closest('label');
      if (wrapper) {
        var wrapped = (wrapper.innerText || wrapper.textContent || '').trim();
        if (wrapped) return wrapped;
      }
    }
    var alt = el.getAttribute && el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
    var title = el.getAttribute && el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    var placeholder = el.getAttribute && el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();
    var text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return text;
    var value = el.value;
    if (typeof value === 'string' && value.trim()) return value.trim();
    return '';
  }

  function clip(text, max) {
    var limit = max || 80;
    var flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (flat.length <= limit) return flat;
    return flat.slice(0, limit - 1) + '\u2026';
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    var rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: clip(nameOf(el), 120),
      ref: el.getAttribute(REF_ATTR) || null,
      disabled: isDisabled(el),
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }

  function centreOf(el) {
    var rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  }

  function clearRefs() {
    var doc = globalThis.document;
    if (!doc) return;
    var tagged = doc.querySelectorAll('[' + REF_ATTR + ']');
    for (var i = 0; i < tagged.length; i += 1) tagged[i].removeAttribute(REF_ATTR);
    // Keep the last few generations so a stale ref reports "stale" instead of
    // silently resolving to a different element, and drop the rest so a long
    // session cannot grow the table without bound.
    var cutoff = generation - 3;
    refs.forEach(function (entry, key) {
      if (entry.generation < cutoff) refs.delete(key);
    });
  }

  function resolve(target) {
    if (!target) throw new Error('需要 ref 或 selector');
    var doc = globalThis.document;
    if (!doc) throw new Error('这个 frame 里没有 document');
    if (target.ref) {
      var wanted = String(target.ref).replace(/^e/i, '');
      var found = refs.get(wanted);
      if (!found) {
        throw new Error('未知编号 e' + wanted + '：没有任何有效的快照产出过它。页面导航会让所有编号作废，每次快照也会产出新的编号。请重新执行 chrome_observe action=snapshot，并使用它给出的编号。');
      }
      if (found.generation !== generation) {
        throw new Error('编号 e' + wanted + ' 已过期：它来自更早的一次快照。请再执行一次 chrome_observe action=snapshot，并使用新编号。');
      }
      if (!found.element || !found.element.isConnected) {
        throw new Error('编号 e' + wanted + ' 已过期：它指向的元素已不在文档里。请重新执行 chrome_observe action=snapshot。');
      }
      return found.element;
    }
    if (target.selector) {
      var el = doc.querySelector(target.selector);
      if (!el) throw new Error('选择器 "' + target.selector + '" 没有匹配到任何元素');
      return el;
    }
    throw new Error('需要 ref 或 selector');
  }

  /**
   * 拒绝检查 Chrome 不会暴露给注入脚本的页面。
   *
   * WebUI 页面（chrome://settings）能正常导航、甚至能建出隔离世界，但它的 document
   * 是不透明的：快照会返回 0 个元素、正文会返回空。那读起来像「页面是空的」，
   * 而不是「这个页面没法被检查」。
   */
  function assertInspectable() {
    var protocol = globalThis.location ? String(globalThis.location.protocol) : '';
    if (protocol === 'chrome:' || protocol === 'chrome-untrusted:' || protocol === 'chrome-extension:' || protocol === 'devtools:' || protocol === 'edge:') {
      throw new Error(
        '无法检查 ' + globalThis.location.href + '：这是 Chrome 内部页面（chrome://、chrome-extension://、devtools://），它不会把自己的 document 暴露给注入脚本。请换成一个普通的 http(s) 或 file 页面。',
      );
    }
  }

  function snapshot(options) {
    var doc = globalThis.document;
    if (!doc || !doc.body) throw new Error('文档还没有 body，请等页面加载完成');
    assertInspectable();
    clearRefs();
    generation += 1;

    var scope = doc;
    if (options && options.selector) {
      var root = doc.querySelector(options.selector);
      if (!root) throw new Error('快照选择器 "' + options.selector + '" 没有匹配到任何元素');
      scope = root;
    }

    var limit = (options && options.limit) || 300;
    var candidates = scope.querySelectorAll(INTERACTIVE);
    var lines = [];
    var seen = 0;
    for (var i = 0; i < candidates.length; i += 1) {
      var el = candidates[i];
      if (!isVisible(el)) continue;
      if (isDisabled(el) && roleOf(el) === 'generic') continue;
      // A label that merely names a control already in the list would duplicate
      // that control's name and invite a typed action against the wrapper.
      if (el.tagName === 'LABEL' && el.control && isVisible(el.control)) continue;
      seen += 1;
      if (lines.length >= limit) continue;
      var serial = nextRef;
      nextRef += 1;
      var ref = 'e' + serial;
      refs.set(String(serial), { element: el, generation: generation });
      el.setAttribute(REF_ATTR, ref);
      var rect = el.getBoundingClientRect();
      var line = ref + ' ' + roleOf(el) + ' "' + clip(nameOf(el)) + '"';
      if (el.value !== undefined && el.value !== null && String(el.value).length > 0 && roleOf(el) !== 'button') {
        line += ' value="' + clip(el.value, 60) + '"';
      }
      if (el.type === 'checkbox' || el.type === 'radio' || el.getAttribute('aria-checked') === 'true') {
        line += el.checked || el.getAttribute('aria-checked') === 'true' ? ' checked' : ' unchecked';
      }
      if (isDisabled(el)) line += ' disabled';
      line += ' [' + Math.round(rect.left) + ',' + Math.round(rect.top) + ' ' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ']';
      lines.push(line);
    }

    var docEl = doc.documentElement;
    return {
      url: globalThis.location ? String(globalThis.location.href) : '',
      title: doc.title || '',
      scrollY: Math.round(globalThis.scrollY || 0),
      maxScrollY: Math.max(0, Math.round((docEl ? docEl.scrollHeight : 0) - (globalThis.innerHeight || 0))),
      viewport: { width: globalThis.innerWidth || 0, height: globalThis.innerHeight || 0 },
      elementCount: seen,
      truncated: seen > lines.length,
      frameCount: doc.querySelectorAll('iframe').length,
      generation: generation,
      lines: lines
    };
  }

  function text(options) {
    var doc = globalThis.document;
    if (!doc || !doc.body) throw new Error('文档还没有 body，请等页面加载完成');
    assertInspectable();
    var scope = doc.body;
    if (options && options.selector) {
      var root = doc.querySelector(options.selector);
      if (!root) throw new Error('选择器 "' + options.selector + '" 没有匹配到任何元素');
      scope = root;
    }
    return String(scope.innerText || scope.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function html(options) {
    var doc = globalThis.document;
    if (!doc || !doc.documentElement) throw new Error('文档还没有 documentElement');
    assertInspectable();
    if (options && options.selector) {
      var root = doc.querySelector(options.selector);
      if (!root) throw new Error('选择器 "' + options.selector + '" 没有匹配到任何元素');
      return root.outerHTML;
    }
    return doc.documentElement.outerHTML;
  }

  function fire(el, type, init) {
    var view = globalThis;
    var Ctor = type.indexOf('pointer') === 0 ? view.PointerEvent : view.MouseEvent;
    if (!Ctor) Ctor = view.MouseEvent;
    var event;
    try {
      event = new Ctor(type, Object.assign({
        bubbles: true,
        cancelable: true,
        composed: true,
        view: view
      }, init || {}));
    } catch (error) {
      event = new view.Event(type, { bubbles: true, cancelable: true });
    }
    el.dispatchEvent(event);
    return event;
  }

  function clickAt(el, count) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    var point = centreOf(el);
    var init = {
      clientX: point.x,
      clientY: point.y,
      button: 0,
      buttons: 1,
      detail: count || 1
    };
    fire(el, 'pointerover', { pointerId: 1, pointerType: 'mouse', isPrimary: true });
    fire(el, 'pointerenter', { pointerId: 1, pointerType: 'mouse', isPrimary: true });
    fire(el, 'mouseover', init);
    fire(el, 'mousemove', init);
    fire(el, 'pointerdown', { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 });
    fire(el, 'mousedown', init);
    if (typeof el.focus === 'function') {
      try { el.focus({ preventScroll: true }); } catch (error) { /* focus is best effort */ }
    }
    fire(el, 'pointerup', { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0 });
    fire(el, 'mouseup', init);
    fire(el, 'click', Object.assign({}, init, { buttons: 0, detail: count || 1 }));
    if ((count || 1) >= 2) fire(el, 'dblclick', Object.assign({}, init, { buttons: 0, detail: 2 }));

    var hit = null;
    try {
      hit = el.ownerDocument.elementFromPoint(point.x, point.y);
    } catch (error) {
      hit = null;
    }
    return {
      element: describe(el),
      hitTarget: hit ? describe(hit) : null,
      covered: !!(hit && hit !== el && !el.contains(hit) && !hit.contains(el))
    };
  }

  /**
   * Map a resolved element onto the control that actually holds text.
   *
   * A snapshot deliberately lists labels and wrappers too, because clicking one
   * is meaningful; typing is not, so a label forwards to the control it names
   * instead of applying an input setter to the wrong prototype.
   */
  function textTarget(el) {
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return el;
    var control = el.control;
    if (control && (control.tagName === 'INPUT' || control.tagName === 'TEXTAREA')) return control;
    if (el.isContentEditable === true) return el;
    var inner = el.querySelector && el.querySelector('input, textarea, [contenteditable=""], [contenteditable="true"]');
    if (inner) return inner;
    var labelled = el.getAttribute && el.getAttribute('for');
    if (labelled) {
      var byId = el.ownerDocument.getElementById(labelled);
      if (byId && (byId.tagName === 'INPUT' || byId.tagName === 'TEXTAREA' || byId.isContentEditable === true)) return byId;
    }
    throw new Error('不能往 <' + tag.toLowerCase() + '> 里输入：它不承载文本。请直接指定 input、textarea 或 contenteditable 元素。');
  }

  /**
   * Scroll an element into view and report its settled viewport geometry.
   *
   * The trusted-input path needs this as a separate step: attaching a debugger
   * shows an infobar that pushes the page down, so a rect measured before the
   * attach is wrong by the height of that bar. Measuring after the attach and
   * after a settle delay keeps the point under the element the caller named.
   */
  function measure(args) {
    var el = resolve(args);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    if (args && args.focus === true && typeof el.focus === 'function') {
      try { el.focus({ preventScroll: true }); } catch (error) { /* focus is best effort */ }
    }
    var rect = el.getBoundingClientRect();
    return {
      element: describe(el),
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      viewport: {
        width: globalThis.innerWidth || 0,
        height: globalThis.innerHeight || 0,
        scrollY: Math.round(globalThis.scrollY || 0)
      }
    };
  }

  function setValue(el, value) {
    var target = textTarget(el);
    // Read the setter from THIS realm's prototype. Elements reached from an
    // isolated world are wrapped per world, so another world's setter throws
    // "Illegal invocation" when applied here.
    var proto = target.tagName === 'TEXTAREA' ? globalThis.HTMLTextAreaElement.prototype : globalThis.HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(target, value);
    else target.value = value;
    target.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
    target.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
    return target;
  }

  function rightClickAt(el) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    var point = centreOf(el);
    var init = { clientX: point.x, clientY: point.y, button: 2, buttons: 2, detail: 1 };
    fire(el, 'pointerdown', { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 2, buttons: 2 });
    fire(el, 'mousedown', init);
    if (typeof el.focus === 'function') {
      try { el.focus({ preventScroll: true }); } catch (error) { /* focus is best effort */ }
    }
    fire(el, 'pointerup', { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 2, buttons: 0 });
    fire(el, 'mouseup', { clientX: point.x, clientY: point.y, button: 2, buttons: 0, detail: 1 });
    fire(el, 'contextmenu', { clientX: point.x, clientY: point.y, button: 2, buttons: 0, detail: 1 });
    return { element: describe(el) };
  }

  function typeInto(el, value, submit) {
    var target = textTarget(el);
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    if (typeof target.focus === 'function') {
      try { target.focus({ preventScroll: true }); } catch (error) { /* focus is best effort */ }
    }
    var editable = target.isContentEditable === true;
    if (editable) {
      target.textContent = value;
      target.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
    } else {
      setValue(target, value);
    }
    if (submit === true) {
      fire(target, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
      fire(target, 'keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
      fire(target, 'keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
      var form = target.form || (target.closest && target.closest('form'));
      if (form) {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      }
    }
    return { element: describe(target), value: editable ? String(target.textContent || '') : String(target.value == null ? '' : target.value) };
  }

  /**
   * Dispatch a key.
   *
   * With no element the key goes to whatever currently holds focus, which is
   * the behaviour a real keyboard has — but the reply must name that element,
   * because "sent Enter" alone leaves a caller unable to tell where it landed.
   */
  function press(el, key, modifiers) {
    var target = el;
    var implicit = false;
    if (!target) {
      var active = globalThis.document.activeElement;
      target = active && active !== globalThis.document.body ? active : globalThis.document.body;
      implicit = true;
    }
    var parts = String(key).split('+').map(function (part) { return part.trim(); }).filter(Boolean);
    var main = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    var mods = parts.slice(0, Math.max(0, parts.length - 1));
    var init = {
      key: main,
      code: main.length === 1 ? 'Key' + main.toUpperCase() : main,
      ctrlKey: mods.indexOf('Ctrl') >= 0 || mods.indexOf('Control') >= 0 || (modifiers && modifiers.ctrl),
      shiftKey: mods.indexOf('Shift') >= 0 || (modifiers && modifiers.shift),
      altKey: mods.indexOf('Alt') >= 0 || (modifiers && modifiers.alt),
      metaKey: mods.indexOf('Meta') >= 0 || mods.indexOf('Cmd') >= 0 || (modifiers && modifiers.meta)
    };
    if (typeof target.focus === 'function') {
      try { target.focus({ preventScroll: true }); } catch (error) { /* ignore */ }
    }
    fire(target, 'keydown', init);
    fire(target, 'keyup', init);
    return {
      key: main,
      modifiers: mods,
      implicitTarget: implicit,
      target: target === globalThis.document.body ? null : describe(target),
      targetTag: target === globalThis.document.body ? 'body' : target.tagName.toLowerCase()
    };
  }

  function scroll(target, deltaX, deltaY) {
    var dx = Number(deltaX) || 0;
    var dy = Number(deltaY) || 0;
    if (target) {
      var el = resolve(target);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      if (deltaY) el.scrollTop = el.scrollTop + dy;
      if (deltaX) el.scrollLeft = el.scrollLeft + dx;
      fire(el, 'scroll');
      return { element: describe(el), scrollTop: Math.round(el.scrollTop), scrollLeft: Math.round(el.scrollLeft) };
    }
    globalThis.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    var docEl = globalThis.document.documentElement;
    return {
      scrollY: Math.round(globalThis.scrollY || 0),
      maxScrollY: Math.max(0, Math.round((docEl ? docEl.scrollHeight : 0) - (globalThis.innerHeight || 0)))
    };
  }

  function setChecked(el, wanted) {
    if (el.checked === wanted) return { element: describe(el), changed: false };
    fire(el, 'click', { button: 0, detail: 1 });
    if (el.checked !== wanted) {
      el.checked = wanted;
      el.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
      el.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
    }
    return { element: describe(el), changed: true, checked: el.checked === true };
  }

  function selectOption(el, option) {
    if (!el.options) throw new Error('目标不是 <select> 元素');
    var wanted = String(option == null ? '' : option);
    var match = null;
    for (var i = 0; i < el.options.length; i += 1) {
      var candidate = el.options[i];
      if (candidate.value === wanted || (candidate.text || '').trim() === wanted.trim()) {
        match = candidate;
        break;
      }
    }
    if (!match) {
      var available = [];
      for (var index = 0; index < el.options.length && available.length < 20; index += 1) {
        available.push(JSON.stringify(el.options[index].value));
      }
      throw new Error('没有 value 或文字为 "' + wanted + '" 的 <option>；可用的 value 有：' + available.join(', '));
    }
    el.value = match.value;
    el.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
    el.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
    return { element: describe(el), value: el.value };
  }

  function evaluate(expression, awaitPromise) {
    var runner = function () {
      var fn = new globalThis.Function('"use strict"; return (' + expression + ');');
      return fn();
    };
    var value = runner();
    if (awaitPromise !== false && value && typeof value.then === 'function') {
      return Promise.resolve(value).then(serialize);
    }
    return serialize(value);
  }

  function serialize(value) {
    if (value === undefined) return { kind: 'undefined' };
    if (value === null) return { kind: 'null' };
    if (typeof value === 'function') return { kind: 'function', text: String(value).slice(0, 400) };
    if (typeof value === 'bigint') return { kind: 'bigint', text: String(value) };
    if (typeof value !== 'object') return { kind: typeof value, value: value };
    if (value.nodeType === 1) return { kind: 'element', text: describe(value) };
    try {
      var json = JSON.stringify(value, function (key, inner) {
        if (typeof inner === 'function') return '[function]';
        if (typeof inner === 'bigint') return String(inner);
        if (inner && inner.nodeType === 1) return '[' + inner.tagName.toLowerCase() + ']';
        return inner;
      }, 2);
      if (json === undefined) return { kind: 'object', text: String(value) };
      return { kind: 'json', text: json };
    } catch (error) {
      return { kind: 'object', text: String(value) };
    }
  }

  function waitCheck(spec) {
    var doc = globalThis.document;
    if (spec.mode === 'selector') {
      var el = doc.querySelector(spec.value);
      return { matched: !!el, detail: el ? describe(el) : null };
    }
    if (spec.mode === 'text') {
      var haystack = String((doc.body && (doc.body.innerText || doc.body.textContent)) || '');
      return { matched: haystack.indexOf(spec.value) >= 0, detail: null };
    }
    if (spec.mode === 'url') {
      var href = String(globalThis.location.href);
      return { matched: href.indexOf(spec.value) >= 0, detail: href };
    }
    if (spec.mode === 'load') {
      return { matched: doc.readyState === 'complete', detail: doc.readyState };
    }
    throw new Error('不支持的等待模式：' + spec.mode);
  }

  var HANDLERS = {
    snapshot: function (args) { return snapshot(args || {}); },
    text: function (args) { return text(args || {}); },
    html: function (args) { return html(args || {}); },
    describe: function (args) { return describe(resolve(args)); },
    click: function (args) { return clickAt(resolve(args), args.count || 1); },
    rightClick: function (args) { return rightClickAt(resolve(args)); },
    hover: function (args) {
      var el = resolve(args);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      var point = centreOf(el);
      fire(el, 'pointerover', { pointerId: 1, pointerType: 'mouse', isPrimary: true });
      fire(el, 'mouseover', { clientX: point.x, clientY: point.y });
      fire(el, 'mousemove', { clientX: point.x, clientY: point.y });
      return { element: describe(el) };
    },
    type: function (args) { return typeInto(resolve(args), String(args.text == null ? '' : args.text), args.submit === true); },
    press: function (args) { return press(args.ref || args.selector ? resolve(args) : null, args.key, args.modifiers); },
    scroll: function (args) {
      var target = args.ref || args.selector ? args : null;
      return scroll(target, args.deltaX, args.deltaY);
    },
    check: function (args) { return setChecked(resolve(args), true); },
    uncheck: function (args) { return setChecked(resolve(args), false); },
    selectOption: function (args) { return selectOption(resolve(args), args.option); },
    measure: function (args) { return measure(args || {}); },
    eval: function (args) { return evaluate(String(args.expression), args.awaitPromise); },
    waitCheck: function (args) { return waitCheck(args); }
  };

  globalThis[GLOBAL] = {
    version: 4,
    run: function (op, args) {
      var handler = HANDLERS[op];
      if (!handler) throw new Error('未知的页面操作：' + op);
      return handler(args || {});
    },
    clearRefs: clearRefs,
    generation: function () { return generation; }
  };
})();`;
