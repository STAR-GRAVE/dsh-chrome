/**
 * Browser half: the 「Chrome 连接」 page in the main navigation.
 *
 * The pairing token used to be reachable only through `chrome_status
 * action=pair`: the user had to ask an agent, copy a string out of a tool
 * result, and paste it into the extension's options page. This page shows the
 * live token instead, and lets the user replace it without touching a file.
 *
 * It registers the same pair of slots every first-class page uses: a `main`
 * entry keyed by the panel id (the page itself) and a `sidebar.panellist` row
 * (the navigation item that selects it).
 *
 * The bundle is hand-written in the format `dsh-client-modules` loads: the
 * loader registers this factory at boot and materializes the module body
 * lazily, exactly like a compiled bundle. Only `react` is required from the
 * shell's frozen module table, so this file needs no build step.
 *
 * Transport: one channel only, the Host Remote (`ctx.remote`). It is the
 * documented way for a page to read and change Host state, it is authorized by
 * the Client peer rather than by an origin header, and it keeps working when the
 * bridge failed to bind — which is exactly when the port must be fixable.
 *
 * @module @star-grave/dsh-chrome/client
 */

window.__ModuleLoader__.load({
  id: '@star-grave/dsh-chrome',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** Panel id shared by the `main` entry and its navigation row. */
    const PANEL_ID = 'chrome-pairing'
    /** Where the row sits among 插件 / 技能 · MCP · 专家 / 自动化任务. */
    const PANEL_ORDER = 6
    /** Wire namespace of the Host-side pairing service. */
    const PAIRING_SERVICE = 'chromePairing'

    /**
     * The browser half's declaration of what it may call.
     *
     * The Host service marks the same three methods with `@Remote`; `$mount`
     * turns this contribution into `remote.chromePairing`. The two lists are
     * compared by `test/typert.test.mjs`, because a mismatch is a silent 404.
     */
    const ANY_VALUE = { parse: (value) => value }
    const codec = (symbol) => ({ mode: 'strict', typeSymbol: `@star-grave/dsh-chrome#${symbol}`, schema: ANY_VALUE, create: () => ANY_VALUE })
    const param = (name) => ({ name, wire: name, source: 'json', codec: codec(name) })
    /**
     * Result codec. Results travel Host → Client, so they carry no Client-supplied
     * type: the protocol's own `src-json` marker is the correct declaration for
     * them, and it is what a published plugin using `$mount` without generated
     * artifacts declares. Only *parameters* need a strict codec, because those
     * are the fields the Client supplies.
     */
    const RESULT = { mode: 'src-json' }
    const PAIRING_CONTRIBUTION = {
      package: '@star-grave/dsh-chrome',
      descriptors: [
        {
          id: '@star-grave/dsh-chrome#chromePairing/read',
          service: PAIRING_SERVICE,
          namespace: PAIRING_SERVICE,
          method: 'read',
          invocation: { kind: 'direct' },
          parameters: [],
          result: RESULT,
        },
        {
          id: '@star-grave/dsh-chrome#chromePairing/setToken',
          service: PAIRING_SERVICE,
          namespace: PAIRING_SERVICE,
          method: 'setToken',
          invocation: { kind: 'direct' },
          parameters: [param('token')],
          result: RESULT,
        },
        {
          id: '@star-grave/dsh-chrome#chromePairing/setPort',
          service: PAIRING_SERVICE,
          namespace: PAIRING_SERVICE,
          method: 'setPort',
          invocation: { kind: 'direct' },
          parameters: [param('port')],
          result: RESULT,
        },
      ],
    }
    /** Set in `apply`: resolves the mounted proxy, or null without a gateway. */
    let pairingProxy = () => null
    /** Resolves once the Remote contribution is mounted (or has failed to mount). */
    let mountReady = Promise.resolve()

    /** Whether the interface should speak Chinese. */
    const wantsChinese = () =>
      typeof navigator !== 'undefined' && String(navigator.language ?? '').toLowerCase().startsWith('zh')

    const COPY = {
      zh: {
        nav: 'Chrome 连接',
        title: 'Chrome 连接',
        description: '扩展凭这串令牌连接本机桥。',
        port: '端口',
        portHint: '扩展里填同一个端口。',
        extension: '扩展目录',
        copyPath: '复制路径',
        installHint: '打开 chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选这个目录。',
        pathCopied: '路径已复制。',
        current: '当前令牌',
        draft: '新令牌',
        status: '扩展状态',
        channel: '通道',
        connected: '已连接',
        disconnected: '未连接',
        bridgeDown: '桥未监听',
        copy: '复制',
        apply: '应用',
        invalidPort: '端口要填 1–65535。',
        portSaved: (port) => `已换到 ${port}，扩展里也要改。`,
        portPending: (port, reason) => `已记住 ${port}，但桥起不来：${reason ?? '未知原因'}`,

        copied: '已复制。',
        generate: '随机生成',
        save: '保存',
        saving: '保存中…',
        retry: '重试',
        loading: '正在读取…',
        unreachable: '读不到主机端的状态。',
        saved: '已保存，扩展里要填新令牌。',
        unchanged: '和当前令牌相同。',
        invalid: '至少 16 个字符，不能有空白。',
        copyFailed: '复制失败，请手动选中。',
        readFailed: '读取失败',
        writeFailed: '保存失败',
      },
      en: {
        nav: 'Chrome connection',
        title: 'Chrome connection',
        description: 'The extension connects to the local bridge with this token.',
        port: 'Port',
        portHint: 'Use the same port in the extension.',
        extension: 'Extension folder',
        copyPath: 'Copy path',
        installHint: 'Open chrome://extensions → enable Developer mode → Load unpacked → pick this folder.',
        pathCopied: 'Path copied.',
        current: 'Current token',
        draft: 'New token',
        status: 'Extension',
        channel: 'Channel',
        connected: 'Connected',
        disconnected: 'Not connected',
        bridgeDown: 'Bridge is not listening',
        copy: 'Copy',
        apply: 'Apply',
        invalidPort: 'A port is 1–65535.',
        portSaved: (port) => `Moved to ${port}; change it in the extension too.`,
        portPending: (port, reason) => `Saved ${port}, but the bridge cannot start: ${reason ?? 'unknown'}`,

        copied: 'Copied.',
        generate: 'Generate',
        save: 'Save',
        saving: 'Saving…',
        retry: 'Retry',
        loading: 'Loading…',
        unreachable: 'Could not read the pairing state from the host.',
        saved: 'Saved. Use the new token in the extension.',
        unchanged: 'Same as the current token.',
        invalid: 'At least 16 characters, no spaces.',
        copyFailed: 'Copy failed; select it by hand.',
        readFailed: 'Read failed',
        writeFailed: 'Save failed',
      },
    }

    /** Copy for the current interface language. */
    const copy = () => (wantsChinese() ? COPY.zh : COPY.en)

    /** A 32-character base64url token, same shape the host generates. */
    function randomToken() {
      const bytes = new Uint8Array(24)
      crypto.getRandomValues(bytes)
      let raw = ''
      for (const byte of bytes) raw += String.fromCharCode(byte)
      return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }

    /** Put text on the clipboard, falling back to a temporary selection. */
    async function copyText(value) {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
        return true
      }
      const holder = document.createElement('textarea')
      holder.value = value
      holder.setAttribute('readonly', '')
      holder.style.position = 'fixed'
      holder.style.opacity = '0'
      document.body.appendChild(holder)
      holder.select()
      const copied = document.execCommand('copy')
      holder.remove()
      return copied
    }

    /** The navigation glyph: a key, drawn in the row's inherited colour. */
    function PanelGlyph(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('circle', { cx: 8.5, cy: 12, r: 3.8 }),
        h('path', { d: 'M12.5 12H21M17.6 12v3.4M20.4 12v2.6' }),
      )
    }

    /** A button, styled to sit next to the shell's own controls. */
    function Action(props) {
      return h(
        'button',
        {
          type: 'button',
          className: `dc-button${props.variant === 'primary' ? ' dc-primary' : ''}`,
          disabled: props.disabled === true,
          onClick: props.onClick,
        },
        props.children,
      )
    }

    /** One label/value pair. */
    function Row(props) {
      return h(
        'div',
        { className: 'dc-row' },
        h('span', { className: 'dc-key' }, props.label),
        h('div', { className: 'dc-value' }, props.children),
      )
    }

    /** Read the pairing facts from the Host. */
    async function readPairingState() {
      const value = await callRemote('read')
      if (value === null || typeof value !== 'object') throw new Error('主机端没有返回配对信息')
      return { ...value, via: 'remote' }
    }

    /** Call one Host method through the mounted Remote proxy. */
    async function callRemote(method, ...args) {
      // Mounting is asynchronous, and the page's first render is not.
      await mountReady
      const proxy = pairingProxy()
      const fn = proxy === null ? null : proxy[method]
      if (typeof fn !== 'function') throw new Error(`remote ${PAIRING_SERVICE}.${method} 不可用`)
      const result = await (args.length === 0 ? fn.call(proxy) : fn.call(proxy, ...args))
      if (result !== null && typeof result === 'object' && result.ok === false) {
        throw new Error(result.error?.message ?? result.error?.code ?? '调用失败')
      }
      if (result !== null && typeof result === 'object' && Object.hasOwn(result, 'value')) return result.value
      return result
    }

    /** Replace the pairing token. */
    async function writePairingToken(token) {
      return (await callRemote('setToken', token)) ?? { token }
    }

    /** Move the bridge to another port. */
    async function writePairingPort(port) {
      return (await callRemote('setPort', port)) ?? { port, listening: true, error: null }
    }

    /**
     * The page itself.
     * @returns the page element tree.
     */
    function ChromePairingPage() {
      const t = copy()
      const [phase, setPhase] = React.useState('loading')
      const [live, setLive] = React.useState(null)
      const [draftPort, setDraftPort] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [note, setNote] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      /** Fold one Host snapshot into the component's state. */
      const applyState = (state) => {
        setLive(state)
        setDraftPort(String(state.port ?? ''))
        setDraft(state.token ?? '')
        setPhase('ready')
      }

      const load = async () => {
        setBusy(true)
        try {
          applyState(await readPairingState())
          setNote(null)
        } catch (error) {
          setPhase('unreachable')
          setNote({ tone: 'bad', text: `${t.readFailed}：${error?.message ?? error}` })
        } finally {
          setBusy(false)
        }
      }

      React.useEffect(() => {
        let cancelled = false
        setPhase('loading')
        readPairingState()
          .then((state) => {
            if (!cancelled) applyState(state)
          })
          .catch((error) => {
            if (cancelled) return
            setPhase('unreachable')
            setNote({ tone: 'bad', text: `${t.readFailed}：${error?.message ?? error}` })
          })
        return () => {
          cancelled = true
        }
      }, [])

      const savePort = async () => {
        const next = Number(draftPort)
        if (!Number.isInteger(next) || next < 1 || next > 65535) {
          setNote({ tone: 'bad', text: t.invalidPort })
          return
        }
        setBusy(true)
        try {
          const body = await writePairingPort(next)
          const bound = Number(body.port ?? next)
          const listening = body.listening !== false
          setDraftPort(String(bound))
          setLive((current) => ({
            ...(current ?? {}),
            port: bound,
            endpoint: listening ? `http://127.0.0.1:${bound}` : null,
            listening,
          }))
          if (listening) setNote({ tone: 'ok', text: t.portSaved(bound) })
          else setNote({ tone: 'bad', text: t.portPending(bound, body.error) })
        } catch (error) {
          setNote({ tone: 'bad', text: `${t.writeFailed}：${error?.message ?? error}` })
        } finally {
          setBusy(false)
        }
      }

      const save = async () => {
        const next = draft.trim()
        if (next.length < 16 || /\s/.test(next)) {
          setNote({ tone: 'bad', text: t.invalid })
          return
        }
        if (live !== null && next === live.token) {
          setNote({ tone: 'ok', text: t.unchanged })
          return
        }
        setBusy(true)
        try {
          const body = await writePairingToken(next)
          setLive((current) => ({ ...(current ?? {}), token: body.token ?? next }))
          setDraft(body.token ?? next)
          setNote({ tone: 'ok', text: t.saved })
        } catch (error) {
          setNote({ tone: 'bad', text: `${t.writeFailed}：${error?.message ?? error}` })
        } finally {
          setBusy(false)
        }
      }

      const copyToken = async () => {
        try {
          await copyText(live?.token ?? '')
          setNote({ tone: 'ok', text: t.copied })
        } catch (error) {
          setNote({ tone: 'bad', text: `${t.copyFailed}（${error?.message ?? error}）` })
        }
      }

      /** Copy the extension folder for Chrome's "load unpacked" picker. */
      const copyPath = async () => {
        try {
          await copyText(live?.extensionPath ?? '')
          setNote({ tone: 'ok', text: t.pathCopied })
        } catch (error) {
          setNote({ tone: 'bad', text: `${t.copyFailed}（${error?.message ?? error}）` })
        }
      }

      const children = [
        h(
          'header',
          { className: 'dc-header', key: 'header' },
          h('h1', { className: 'dc-title' }, t.title),
          h('p', { className: 'dc-description' }, t.description),
        ),
        // Chrome ignores chrome:// URLs on the command line and refuses
        // --load-extension, so the folder picker is the one step left manual.
        // This card removes the other one: finding the folder.
        h(
          'div',
          { className: 'dc-card', key: 'install' },
          h(
            Row,
            { label: t.extension },
            h('code', { className: 'dc-code dc-path' }, live?.extensionPath ?? '…'),
            h(Action, { variant: 'outline', onClick: copyPath, disabled: busy || live === null }, t.copyPath),
          ),
          h('p', { className: 'dc-hint' }, t.installHint),
        ),
        // The port control stays usable when the bridge is down: that is the
        // case it exists for.
        h(
          'div',
          { className: 'dc-card', key: 'port' },
          h(
            Row,
            { label: t.port },
            h('input', {
              type: 'number',
              className: 'dc-input dc-port',
              value: draftPort,
              min: 1,
              max: 65535,
              inputMode: 'numeric',
              'aria-label': t.port,
              onChange: (event) => setDraftPort(event.target.value),
            }),
            h(Action, { variant: 'outline', onClick: savePort, disabled: busy }, t.apply),
          ),
          h('p', { className: 'dc-hint' }, t.portHint),
        ),
      ]

      if (phase === 'loading') {
        children.push(h('p', { className: 'dc-muted', key: 'loading' }, t.loading))
      } else if (phase === 'unreachable') {
        children.push(
          h(
            'div',
            { className: 'dc-banner', key: 'unreachable' },
            h('p', { className: 'dc-bad' }, t.unreachable),
            h(Action, { variant: 'outline', onClick: load, disabled: busy }, t.retry),
          ),
        )
      } else if (live !== null) {
        const status =
          live.listening === false
            ? `${t.bridgeDown}${live.error ? `：${live.error}` : ''}`
            : live.connected === true
              ? t.connected
              : t.disconnected
        children.push(
          h(
            'div',
            { className: 'dc-card', key: 'token' },
            h(
              Row,
              { label: t.current },
              h('code', { className: 'dc-code dc-token' }, live.token ?? ''),
              h(Action, { variant: 'outline', onClick: copyToken, disabled: busy }, t.copy),
            ),
            h(
              Row,
              { label: t.draft },
              h('input', {
                type: 'text',
                className: 'dc-input',
                value: draft,
                spellCheck: false,
                autoComplete: 'off',
                'aria-label': t.draft,
                onChange: (event) => setDraft(event.target.value),
              }),
              h(Action, { variant: 'outline', onClick: () => setDraft(randomToken()), disabled: busy }, t.generate),
              h(Action, { variant: 'primary', onClick: save, disabled: busy }, busy ? t.saving : t.save),
            ),
            h(Row, { label: t.status }, h('span', { className: live.connected ? 'dc-ok' : 'dc-muted' }, status)),
            h(
              Row,
              { label: t.channel },
              h(
                'span',
                { className: 'dc-muted' },
                live.via === 'remote' ? 'Remote (ctx.remote)' : 'HTTP',
              ),
            ),
          ),
        )
      }

      if (note !== null) {
        children.push(h('p', { className: note.tone === 'bad' ? 'dc-bad' : 'dc-ok', key: 'note' }, note.text))
      }

      return h('div', { className: 'dc-page' }, children)
    }

    /** Style the page once; the loader removes tags owned by this plugin. */
    function injectStyles() {
      const id = 'dsh-chrome/panel.css'
      if (document.querySelector(`style[data-plugin-css="${id}"]`)) return
      const tag = document.createElement('style')
      tag.dataset.plugin = '@star-grave/dsh-chrome'
      tag.dataset.pluginCss = id
      tag.textContent = `
.dc-page { height: 100%; overflow: auto; box-sizing: border-box; padding: 24px 28px 40px; font: inherit; }
.dc-header { display: flex; flex-direction: column; gap: 6px; margin-bottom: 18px; max-width: 760px; }
.dc-title { margin: 0; font-size: 18px; font-weight: 600; }
.dc-description, .dc-hint, .dc-muted { margin: 0; font-size: 12px; line-height: 1.7; opacity: .72; }
.dc-card { display: flex; flex-direction: column; gap: 12px; padding: 14px; border-radius: 8px; max-width: 760px;
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent); }
.dc-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dc-key { min-width: 76px; font-size: 12px; opacity: .72; }
.dc-value { display: flex; align-items: center; gap: 8px; flex: 1 1 260px; flex-wrap: wrap; }
.dc-code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; padding: 2px 6px;
  border-radius: 4px; background: color-mix(in srgb, currentColor 8%, transparent); user-select: all; }
.dc-port { flex: 0 0 120px; min-width: 96px; }
.dc-path { user-select: all; word-break: break-all; }
.dc-input { font: inherit; font-size: 12px; flex: 1 1 240px; min-width: 180px; padding: 5px 8px; border-radius: 6px;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; }
.dc-button { font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; }
.dc-button.dc-primary { border-color: transparent; background: color-mix(in srgb, currentColor 88%, transparent);
  color: color-mix(in srgb, Canvas 92%, transparent); }
.dc-button[disabled] { opacity: .5; cursor: default; }
.dc-banner { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
.dc-hint { margin-top: 14px; }
.dc-ok { color: #2f9e44; font-size: 12px; }
.dc-bad { color: #e03131; font-size: 12px; }
`
      document.head.appendChild(tag)
    }

    /**
     * Register the page, mount the Remote contribution, and publish the row.
     * @param {object} ctx - the client plugin context.
     */
    function apply(ctx) {
      try {
        injectStyles()
      } catch {
        /* a shell that forbids style tags must not cost the user the page */
      }

      // The Remote is the page's only channel to the Host, so mount it once and
      // let `callRemote` wait for it instead of degrading to something else.
      const resolveProxy = () => {
        const fromCtx = typeof ctx.get === 'function' ? ctx.get(`remote.${PAIRING_SERVICE}`) : null
        return fromCtx ?? ctx.remote?.[PAIRING_SERVICE] ?? null
      }
      if (typeof ctx.remote?.$mount === 'function') {
        ctx.effect(() => {
          let dispose = null
          let disposed = false
          mountReady = Promise.resolve(ctx.remote.$mount(PAIRING_CONTRIBUTION))
            .then((off) => {
              if (disposed) off?.()
              else dispose = off
            })
            .catch(() => {})
          pairingProxy = resolveProxy
          return () => {
            disposed = true
            try {
              dispose?.()
            } catch {
              /* already gone */
            }
          }
        }, 'chrome-pairing: remote contribution')
      }

      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, label: () => copy().nav }, ChromePairingPage),
      )
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => copy().nav },
          PanelGlyph,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'remote']
    return module.exports
  },
})
