/**
 * Stable, human-sized tab labels over a backend's opaque tab identifiers.
 *
 * Both backends produce different identifiers — the extension uses numeric tab
 * ids, the CDP fallback uses target ids — so the tools speak `t1`, `t2`, … and
 * this registry is the only place that knows the mapping.
 *
 * Labels are stable for the lifetime of a tab: a later `listTabs` that returns
 * the same identifier keeps its label, so a model that took a snapshot can keep
 * acting on `t2` without re-listing.
 *
 * @module @star-grave/dsh-chrome/tabs
 */

/** Registry of label ↔ backend identifier pairs. */
export class TabRegistry {
  #byId = new Map()
  #nextLabel = 1
  #bound = null

  /**
   * Reconcile the registry against a fresh listing.
   * @param {Array<{ id: string, title?: string, url?: string, active?: boolean }>} tabs - current tabs.
   * @returns {Array<{ label: string, id: string, title: string, url: string, active: boolean }>} labelled tabs.
   */
  sync(tabs) {
    const seen = new Set()
    const labelled = []
    for (const tab of tabs) {
      seen.add(tab.id)
      let label = this.#byId.get(tab.id)
      if (label === undefined) {
        label = `t${this.#nextLabel}`
        this.#nextLabel += 1
        this.#byId.set(tab.id, label)
      }
      labelled.push({
        label,
        id: tab.id,
        title: tab.title ?? '',
        url: tab.url ?? '',
        active: tab.active === true,
      })
    }
    for (const id of [...this.#byId.keys()]) {
      if (!seen.has(id)) {
        this.#byId.delete(id)
        if (this.#bound === id) this.#bound = null
      }
    }
    return labelled
  }

  /**
   * Resolve a tool's `tab` argument to a backend identifier.
   * @param {string | undefined} requested - a `tN` label, or undefined for the bound tab.
   * @param {Array<{ label: string, id: string, active: boolean }>} labelled - the current listing.
   * @returns {string} the backend identifier.
   * @throws when the label is unknown or nothing is bound.
   */
  resolve(requested, labelled) {
    if (labelled.length === 0) throw new Error('没有可用的 Chrome 标签页；用 chrome_tabs action=new 打开一个')
    if (requested === undefined || requested === null || String(requested).trim() === '') {
      if (this.#bound !== null) {
        const bound = labelled.find((tab) => tab.id === this.#bound)
        if (bound) return bound.id
      }
      const active = labelled.find((tab) => tab.active)
      const fallback = active ?? labelled[0]
      this.#bound = fallback.id
      return fallback.id
    }
    const wanted = String(requested).trim().toLowerCase()
    const match = labelled.find((tab) => tab.label.toLowerCase() === wanted || tab.id === String(requested))
    if (!match) {
      const available = labelled.map((tab) => tab.label).join(', ')
      throw new Error(`不认识的标签页 "${requested}"；可选的是：${available}。用 chrome_tabs action=list 可以看到标题与地址。`)
    }
    return match.id
  }

  /** Bind a tab as the default target for later calls. */
  bind(id) {
    this.#bound = id
  }

  /**
   * Forget every label.
   *
   * A new browser has no relationship to the previous one's tab identifiers, so
   * carrying labels across a relaunch would silently point `t3` at a different
   * page. Started labels also return to `t1`, which is what a reader expects
   * from a fresh browser.
   */
  reset() {
    this.#byId.clear()
    this.#nextLabel = 1
    this.#bound = null
  }

  /** The bound backend identifier, if any. */
  get bound() {
    return this.#bound
  }

  /** The label for a backend identifier, for output. */
  labelOf(id) {
    return this.#byId.get(id) ?? null
  }
}
