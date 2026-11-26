// Almost For Ever — 客户端半
//
// 四个座位：
//   ① 会话标签页「记忆」 —— conversation.view，整页展示这个对话的运行情况
//   ② 设置页「记忆」     —— settings.section，与标签页里的设置同一份数据
//   ③ 📌 待确认          —— shell.overlay，有候选时出现，点开是便利贴
//   ④ 🗂 记忆库          —— shell.overlay，一直存在，点开是结构面板
// ③④ 都能拖动；形状 / 颜色 / 大小在「🗂 记忆库」面板的 ⚙ 外观里调，
// 存在 localStorage（界面偏好，不进 memory/，不走接口）。
// ③④ 可以在设置里关掉（chips），关掉后连圆片都不出现。
//
// 铁律：座位里任何 throw 都会让控件静默消失，所以全程 try 包裹。
//
// ⚠️ 下面这个 id 必须与 package.json 的 `name` 逐字一致。
// 改包名时漏改这里 → 宿主按包名找不到客户端模块 → 两个座位都不注册 →
// 界面上什么都不出现，且控制台没有明显报错。
// test/manifest.mjs 会检查这一条。

window.__ModuleLoader__.load({
  id: 'almost-for-ever',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/almost-for-ever'
    const POLL_MS = 4000

    // ── 「记忆」标签页接管会话正文时，把输入框收起来 ──────────
    //
    // 会话正文 = 一个滚动容器（[data-conversation-scroll]），里面先放当前视图、
    // 再放输入框（[data-composer-seat]，sticky 贴底）。所以任何一个 view 都会被
    // 输入框压住 —— 对一个「看数据」的页面来说很碍事。
    //
    // 做法：本页挂载时给滚动容器打一个标记，CSS 里把输入框隐藏；切走时摘掉标记。
    // ⚠️ 必须保留「有待审批 / 有问题待答 / 有方案待审」的情况 —— 那些卡片就长在
    // 输入框座位上，藏掉会让人没法确认，会话直接卡死。
    const SURFACE_ATTR = 'data-afe-surface'
    const SURFACE_CSS =
      '[data-conversation-scroll][data-afe-surface]>[data-composer-seat]:not(:has([data-approval-key],[data-question-key],[data-plan-review-key])){display:none}'

    function ensureSurfaceStyle() {
      try {
        const doc = globalThis.document
        if (!doc || doc.querySelector('style[data-afe-surface]')) return
        const style = doc.createElement('style')
        style.setAttribute('data-afe-surface', '')
        style.textContent = SURFACE_CSS
        doc.head.appendChild(style)
      } catch {
        /* 拿不到 document 就算了，页面照样能看 */
      }
    }

    const TH = {
      bg: 'var(--dsw-alias-bg-overlay)',
      bg1: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      fg: 'var(--dsw-alias-label-primary)',
      fg2: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    }

    const FALLBACK_TARGETS = []

    // 空记忆库时给的建议（小白第一次装）
    const EMPTY_HINT = '还没有找到记忆库。到「🗂 记忆库」面板看看，或让你的 AI 助手帮你建一套。'

    const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

    // ── 浮层外观 / 位置（可自定义）──────────────────────────
    //
    // 为什么存 localStorage 而不是让服务端存：
    //   这是「这台机器的界面偏好」，不是记忆内容 —— 不该进 memory/，也不该跨机器同步。
    //   而且它不能失败：存不进 localStorage 也得照常工作（所以全程 try 包裹）。
    //
    // 两个浮层（📌 待确认 / 🗂 记忆库）共用一套外观，位置各自记。

    const LOOK_KEY = 'almost-for-ever:look'
    const LOOK_EVT = 'almost-for-ever:look-changed'

    const PALETTES = [
      { id: 'theme', name: '跟随主题', bg: null, fg: null, bd: null },
      // 这几个 fg 特意取中等明度：浅底上够深、暗底上也够亮。
      // 早先用的是 #0f5fcc 这类深色，暗色主题下压在深背景上几乎看不见。
      { id: 'blue', name: '海蓝', bg: 'rgba(23,105,214,0.14)', fg: '#2f7ce0', bd: 'rgba(23,105,214,0.55)' },
      { id: 'violet', name: '雾紫', bg: 'rgba(112,72,196,0.15)', fg: '#9070e0', bd: 'rgba(112,72,196,0.55)' },
      { id: 'green', name: '苔绿', bg: 'rgba(24,122,78,0.15)', fg: '#2f9e6b', bd: 'rgba(24,122,78,0.55)' },
      { id: 'amber', name: '琥珀', bg: 'rgba(172,102,10,0.16)', fg: '#cf8a2a', bd: 'rgba(172,102,10,0.55)' },
      { id: 'rose', name: '玫红', bg: 'rgba(178,40,88,0.14)', fg: '#d0568a', bd: 'rgba(178,40,88,0.55)' },
    ]

    const SHAPES = [
      { id: 'pill', name: '胶囊', radius: 999 },
      { id: 'round', name: '圆角', radius: 10 },
      { id: 'square', name: '方形', radius: 3 },
      { id: 'circle', name: '圆形', radius: 999 },
    ]

    const SIZES = [
      { id: 'sm', name: '小', emoji: 12, text: 10, padY: 2, padX: 8, dot: 32 },
      { id: 'md', name: '中', emoji: 13, text: 11, padY: 4, padX: 10, dot: 38 },
      { id: 'lg', name: '大', emoji: 16, text: 13, padY: 6, padX: 14, dot: 46 },
    ]

    // 默认锚点：右下角，抬高到输入框上方（输入框高度会变，贴太近会被盖住）
    const ANCHORS = {
      note: { right: 18, bottom: 176 },
      tree: { right: 18, bottom: 112 },
    }

    const LOOK_DEFAULT = { color: 'theme', shape: 'pill', size: 'md', pos: {} }

    let lookCache = null

    function readLook() {
      if (!lookCache) {
        let raw = null
        try {
          raw = window.localStorage.getItem(LOOK_KEY)
        } catch {
          raw = null
        }
        let parsed = null
        if (raw) {
          try {
            const p = JSON.parse(raw)
            if (p && typeof p === 'object') parsed = p
          } catch {
            parsed = null
          }
        }
        lookCache = Object.assign({}, LOOK_DEFAULT, parsed || {}, {
          pos: parsed && parsed.pos && typeof parsed.pos === 'object' ? parsed.pos : {},
        })
      }
      return lookCache
    }

    function writeLook(patch) {
      const next = Object.assign({}, readLook(), patch)
      lookCache = next
      try {
        window.localStorage.setItem(LOOK_KEY, JSON.stringify(next))
      } catch {
        /* 存不进也得能用 */
      }
      try {
        window.dispatchEvent(new Event(LOOK_EVT))
      } catch {
        /* noop */
      }
    }

    function useLook() {
      const [look, setState] = React.useState(readLook)
      React.useEffect(() => {
        const on = () => {
          setState(Object.assign({}, readLook()))
        }
        try {
          window.addEventListener(LOOK_EVT, on)
        } catch {
          /* noop */
        }
        return () => {
          try {
            window.removeEventListener(LOOK_EVT, on)
          } catch {
            /* noop */
          }
        }
      }, [])
      const setLook = React.useCallback((patch) => {
        writeLook(patch)
        setState(Object.assign({}, readLook()))
      }, [])
      return [look, setLook]
    }

    function lookParts(look) {
      const pal = PALETTES.find((p) => p.id === look.color) || PALETTES[0]
      const sh = SHAPES.find((s) => s.id === look.shape) || SHAPES[0]
      const sz = SIZES.find((s) => s.id === look.size) || SIZES[1]
      return { pal, sh, sz }
    }

    // 浮层按钮的样式：形状 / 颜色 / 大小 都在这里落地
    function chipLook(look) {
      const { pal, sh, sz } = lookParts(look)
      const circle = sh.id === 'circle'
      return {
        position: 'relative',
        alignSelf: 'flex-end',
        cursor: 'grab',
        touchAction: 'none',
        userSelect: 'none',
        background: pal.bg || TH.bg2,
        color: pal.fg || TH.fg,
        border: '1px solid ' + (pal.bd || TH.border2),
        borderRadius: sh.radius,
        boxShadow: pal.bd ? '0 2px 10px ' + pal.bg : '0 2px 8px rgba(0,0,0,0.16)',
        padding: circle ? 0 : sz.padY + 'px ' + sz.padX + 'px',
        width: circle ? sz.dot : undefined,
        height: circle ? sz.dot : undefined,
        fontSize: circle ? sz.emoji : sz.text,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: circle ? 0 : 6,
        lineHeight: 1,
      }
    }

    // 浮层容器的定位：没拖过就用默认锚点，拖过就用记住的 left/top
    function boxStyle(look, id, width, livePos) {
      const p = livePos || (look.pos && look.pos[id]) || null
      const a = ANCHORS[id] || ANCHORS.tree
      const base = { position: 'fixed', zIndex: 60 }
      if (!p || typeof p.left !== 'number' || typeof p.top !== 'number') {
        return Object.assign({}, base, { right: a.right, bottom: a.bottom }, width ? { width } : {})
      }
      let vw = 1280
      let vh = 900
      try {
        vw = window.innerWidth || vw
        vh = window.innerHeight || vh
      } catch {
        /* noop */
      }
      const w = width || 72
      const left = Math.max(4, Math.min(p.left, Math.max(4, vw - w - 8)))
      const top = Math.max(4, Math.min(p.top, Math.max(4, vh - 44)))
      return Object.assign({}, base, { left, top }, width ? { width } : {})
    }

    /**
     * 拖动。三条约束：
     *   ① 移动超过 5px 才算拖动 —— 否则手抖 1px 就把点击吞掉，永远点不开
     *   ② 松手才写 localStorage —— 每帧写会把存储刷爆
     *   ③ 位置夹在视口内 —— 拖到窗口外就再也点不到了
     */
    function useDrag(id, look, setLook) {
      const ref = React.useRef(null)
      const st = React.useRef(null)
      const skip = React.useRef(false)
      const liveRef = React.useRef(null)
      const [live, setLive] = React.useState(null)

      const put = (p) => {
        liveRef.current = p
        setLive(p)
      }

      const onPointerDown = (e) => {
        if (e.button !== 0) return
        const el = ref.current
        if (!el) return
        let r
        try {
          r = el.getBoundingClientRect()
        } catch {
          return
        }
        st.current = {
          sx: e.clientX,
          sy: e.clientY,
          ox: e.clientX - r.left,
          oy: e.clientY - r.top,
          w: r.width,
          h: r.height,
          moved: false,
        }
        skip.current = false
        try {
          el.setPointerCapture(e.pointerId)
        } catch {
          /* noop */
        }
      }

      const onPointerMove = (e) => {
        const s = st.current
        if (!s) return
        if (!s.moved) {
          if (Math.abs(e.clientX - s.sx) + Math.abs(e.clientY - s.sy) < 5) return
          s.moved = true
        }
        let vw = 1280
        let vh = 900
        try {
          vw = window.innerWidth || vw
          vh = window.innerHeight || vh
        } catch {
          /* noop */
        }
        put({
          left: Math.max(4, Math.min(e.clientX - s.ox, Math.max(4, vw - s.w - 8))),
          top: Math.max(4, Math.min(e.clientY - s.oy, Math.max(4, vh - s.h - 8))),
        })
      }

      const onPointerUp = (e) => {
        const s = st.current
        st.current = null
        try {
          if (ref.current) ref.current.releasePointerCapture(e.pointerId)
        } catch {
          /* noop */
        }
        if (!s) return
        if (!s.moved) {
          put(null)
          return
        }
        skip.current = true
        let final = liveRef.current
        if (!final && ref.current) {
          try {
            const r = ref.current.getBoundingClientRect()
            final = { left: r.left, top: r.top }
          } catch {
            final = null
          }
        }
        if (final) {
          const next = Object.assign({}, look.pos || {})
          next[id] = final
          setLook({ pos: next })
        }
        put(null)
      }

      // 拖动结束那一次 click 要吞掉，否则松手就把面板弹出来
      const consumeSkip = React.useCallback(() => {
        const v = skip.current
        skip.current = false
        return v
      }, [])

      return {
        ref,
        live,
        handlers: {
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
        },
        consumeSkip,
      }
    }

    // ── 便利贴 ────────────────────────────────────────────

    // 浮层开关（设置页里改）。关掉后两个小圆片不渲染 —— 但它们背后的服务
    // 照常工作，从「记忆」标签页仍能看到全部状态。
    // 单独拉 /settings 而不是 /stats：浮层不需要那些数据，
    // 每 4 秒扫一遍记忆库只为决定「要不要画个按钮」太浪费。
    function useChipsOn() {
      const [on, setOn] = React.useState(true)
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const r = await fetch(`${API}/settings`, { credentials: 'same-origin' })
            if (!r.ok) return
            const d = await r.json()
            if (alive && d && d.settings) setOn(d.settings.chips !== false)
          } catch {
            /* 静默 */
          }
        }
        tick()
        const id = setInterval(tick, 10000)
        return () => {
          alive = false
          clearInterval(id)
        }
      }, [])
      return on
    }

    function useCandidates() {
      const [items, setItems] = React.useState([])
      const [targets, setTargets] = React.useState(FALLBACK_TARGETS)
      const [choices, setChoices] = React.useState({})
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const r = await fetch(`${API}/pending`, { credentials: 'same-origin' })
          if (!r.ok) return
          const data = await r.json()
          const next = Array.isArray(data && data.items) ? data.items : []
          // targets 是「实际扫描到的库」——空数组也要照实反映，别回退成硬编码表
          if (Array.isArray(data && data.targets)) setTargets(data.targets)
          setItems(next)
          if (next.length > 0) setOpen(true)
        } catch {
          /* 静默 */
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = () => {
          if (alive) load()
        }
        tick()
        const id = setInterval(tick, POLL_MS)
        return () => {
          alive = false
          clearInterval(id)
        }
      }, [load])

      const act = React.useCallback(
        async (item, verb) => {
          setBusy(true)
          try {
            const payload = { id: item.id }
            if (verb === 'accept') payload.stem = choices[item.id] || item.guessed || ''
            const r = await fetch(`${API}/${verb}`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            })
            const data = await r.json().catch(() => ({}))
            if (verb === 'accept' && data && data.ok === false) {
              setError(data.reason || data.error || '写入失败')
              return
            }
            setError('')
            setItems((prev) => prev.filter((x) => x.id !== item.id))
          } catch {
            /* 静默 */
          } finally {
            setBusy(false)
          }
        },
        [choices],
      )

      const dismissAll = React.useCallback(async () => {
        setOpen(false)
        try {
          await fetch(`${API}/dismiss`, { method: 'POST', credentials: 'same-origin' })
        } catch {
          /* noop */
        }
        setItems([])
      }, [])

      // 「说两句」：把用户的话挂到那条候选上。这里**不调模型** ——
      // 要求会在下一轮随上下文交给模型判断（见 lib/write-mode.js 的 almost-for-ever-revise）。
      // note 传空串 = 撤回。
      const revise = React.useCallback(async (item, note) => {
        setBusy(true)
        try {
          const r = await fetch(`${API}/revise`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: item.id, note }),
          })
          const data = await r.json().catch(() => ({}))
          if (data && data.ok === false) {
            setError(data.error || '没能记下你的要求')
            return false
          }
          setError('')
          setItems((prev) =>
            prev.map((x) => (x.id === item.id ? { ...x, note: String(note || '') } : x)),
          )
          return true
        } catch {
          return false
        } finally {
          setBusy(false)
        }
      }, [])

      return {
        items, targets, choices, setChoices, open, setOpen, busy, error, act, revise, dismissAll,
      }
    }

    const cardStyle = {
      background: TH.bg,
      color: TH.fg,
      border: `1px solid ${TH.border}`,
      borderRadius: 12,
      boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
      padding: '10px 12px',
      fontSize: 12,
      lineHeight: 1.5,
      maxHeight: '70vh',
      overflowY: 'auto',
    }

    const chipStyle = {
      cursor: 'pointer',
      border: `1px solid ${TH.border2}`,
      background: TH.bg1,
      color: TH.fg,
      borderRadius: 999,
      padding: '4px 10px',
      fontSize: 11,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-end',
    }

    const badgeStyle = {
      background: TH.brand,
      color: '#fff',
      borderRadius: 999,
      minWidth: 16,
      height: 16,
      fontSize: 10,
      lineHeight: '16px',
      textAlign: 'center',
      padding: '0 5px',
    }

    const selectStyle = {
      width: '100%',
      marginTop: 6,
      background: TH.bg2,
      color: TH.fg,
      border: `1px solid ${TH.border2}`,
      borderRadius: 6,
      padding: '3px 6px',
      fontSize: 11,
    }

    const btn = (kind) => ({
      cursor: 'pointer',
      border: `1px solid ${TH.border2}`,
      background: 'transparent',
      color: kind === 'ok' ? TH.ok : TH.fg2,
      borderRadius: 6,
      padding: '3px 10px',
      fontSize: 11,
      marginRight: 6,
      marginTop: 6,
    })

    function StickyNote() {
      try {
        const { items, targets, choices, setChoices, open, setOpen, busy, error, act, revise, dismissAll } =
          useCandidates()
        const [look, setLook] = useLook()
        const drag = useDrag('note', look, setLook)
        const chipsOn = useChipsOn()
        // 「说两句」的输入框：草稿与展开状态都按候选 id 存，不写盘
        const [drafts, setDrafts] = React.useState({})
        const [editing, setEditing] = React.useState({})
        if (items.length === 0) return null
        if (!chipsOn) return null

        const pos = drag.live || (look.pos && look.pos.note) || null
        const shell = Object.assign(
          { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 'calc(100vw - 16px)' },
          boxStyle(look, 'note', open ? 340 : null, pos),
        )
        const badge = Object.assign(
          {},
          badgeStyle,
          look.shape === 'circle' ? { position: 'absolute', top: -4, right: -4 } : null,
        )

        if (!open) {
          return h(
            'div',
            { style: shell },
            h(
              'button',
              Object.assign(
                {
                  type: 'button',
                  ref: drag.ref,
                  style: chipLook(look),
                  title: 'Almost For Ever：' + items.length + ' 条待确认（可拖动）',
                  onClick: () => {
                    if (drag.consumeSkip()) return
                    setOpen(true)
                  },
                  onContextMenu: (e) => {
                    e.preventDefault()
                    setOpen(true)
                  },
                },
                drag.handlers,
              ),
              h('span', null, '📌'),
              look.shape === 'circle' ? null : h('span', null, '待确认'),
              h('span', { style: badge }, String(items.length)),
            ),
          )
        }

        return h(
          'div',
          { style: shell },
          h(
            'div',
            { style: cardStyle },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              h('strong', { style: { flex: 1, fontSize: 12 } }, '📌 值得记下来吗'),
              h(
                'button',
                {
                  type: 'button',
                  style: { ...chipStyle, alignSelf: 'auto', padding: '1px 8px' },
                  onClick: () => setOpen(false),
                  title: '收起',
                },
                '—',
              ),
            ),
            ...items.map((it) => {
              const op = it.op || 'append'
              const isEdit = op !== 'append'
              return h(
                'div',
                {
                  key: it.id,
                  style: {
                    marginTop: 10,
                    paddingTop: 8,
                    borderTop: `1px solid ${TH.border}`,
                  },
                },
                // 改写 / 删除：先把「要被动的原文」原样亮出来，用户才知道动的是哪一条
                isEdit
                  ? h(
                      'div',
                      {
                        style: {
                          color: TH.fg2,
                          fontSize: 11,
                          textDecoration: 'line-through',
                          wordBreak: 'break-word',
                        },
                        title: '要被改掉 / 删掉的那一行',
                      },
                      it.original,
                    )
                  : h('div', { style: { wordBreak: 'break-word' } }, it.text),
                op === 'replace'
                  ? h(
                      'div',
                      { style: { wordBreak: 'break-word', marginTop: 2 } },
                      '→ ' + it.text,
                    )
                  : null,
                h(
                  'div',
                  { style: { color: TH.fg2, fontSize: 11, marginTop: 2 } },
                  isEdit
                    ? (op === 'replace' ? '改写' : '删除') +
                      (it.line ? ` · 第 ${it.line} 行` : '') +
                      (it.guessedLabel ? ` · ${it.guessedLabel}` : '')
                    : it.kindLabel,
                ),
                // 改写/删除的目标由 match 定死，换库就定位不到了，所以不给下拉
                isEdit
                  ? null
                  : h(
                      'select',
                      {
                        style: selectStyle,
                        value: choices[it.id] || it.guessed || '02-preferences',
                        onChange: (e) => {
                          const v = e.target.value
                          setChoices((prev) => ({ ...prev, [it.id]: v }))
                        },
                        title: '这条要写进哪本记忆',
                      },
                      ...targets.map((t) => h('option', { key: t.stem, value: t.stem }, t.label)),
                    ),
                it.note
                  ? h(
                      'div',
                      {
                        style: {
                          marginTop: 6,
                          padding: '6px 8px',
                          borderRadius: 6,
                          background: TH.bg1,
                          border: `1px solid ${TH.border}`,
                          fontSize: 11,
                          lineHeight: 1.6,
                        },
                      },
                      h('div', { style: { color: TH.fg2 } }, '你的要求'),
                      h('div', { style: { wordBreak: 'break-word' } }, it.note),
                      h(
                        'div',
                        { style: { color: TH.fg2, marginTop: 4 } },
                        '下一轮对话时交给模型判断',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          style: { ...chipStyle, alignSelf: 'auto', marginTop: 6, padding: '2px 10px' },
                          disabled: busy,
                          onClick: () => revise(it, ''),
                          title: '撤回这句话，恢复成自己决定',
                        },
                        '撤回',
                      ),
                    )
                  : h(
                      'div',
                      null,
                      h(
                        'button',
                        { type: 'button', style: btn('ok'), disabled: busy, onClick: () => act(it, 'accept') },
                        op === 'replace' ? '改写' : op === 'delete' ? '删掉' : '记住',
                      ),
                      h(
                        'button',
                        { type: 'button', style: btn('no'), disabled: busy, onClick: () => act(it, 'reject') },
                        op === 'delete' ? '保留' : '不要',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          style: btn('no'),
                          disabled: busy,
                          onClick: () => setEditing((p) => ({ ...p, [it.id]: !p[it.id] })),
                          title: '让模型按你的意思判断：改写、合并、换库，或者干脆别记',
                        },
                        '说两句',
                      ),
                    ),
                editing[it.id] && !it.note
                  ? h(
                      'div',
                      { style: { marginTop: 6 } },
                      h('textarea', {
                        style: {
                          width: '100%',
                          minHeight: 48,
                          resize: 'vertical',
                          boxSizing: 'border-box',
                          background: TH.bg1,
                          color: TH.fg,
                          border: `1px solid ${TH.border2}`,
                          borderRadius: 6,
                          padding: '5px 7px',
                          fontSize: 11,
                          lineHeight: 1.5,
                          fontFamily: 'inherit',
                        },
                        placeholder: '比如：太长了压成一句 / 并到上面那条 / 这个不该记',
                        value: drafts[it.id] || '',
                        onChange: (e) => {
                          const v = e.target.value
                          setDrafts((p) => ({ ...p, [it.id]: v }))
                        },
                      }),
                      h(
                        'div',
                        { style: { textAlign: 'right' } },
                        h(
                          'button',
                          {
                            type: 'button',
                            style: { ...chipStyle, alignSelf: 'auto', padding: '2px 10px' },
                            disabled: busy,
                            onClick: async () => {
                              const text = String(drafts[it.id] || '').trim()
                              if (!text) return
                              const ok = await revise(it, text)
                              if (ok) {
                                setEditing((p) => ({ ...p, [it.id]: false }))
                                setDrafts((p) => ({ ...p, [it.id]: '' }))
                              }
                            },
                          },
                          '交给模型',
                        ),
                      ),
                    )
                  : null,
              )
            }),
            error
              ? h(
                  'div',
                  {
                    style: {
                      marginTop: 8,
                      padding: '6px 8px',
                      borderRadius: 6,
                      background: TH.bg2,
                      color: TH.warn,
                      fontSize: 11,
                      lineHeight: 1.5,
                    },
                  },
                  error,
                )
              : null,
            h(
              'div',
              { style: { marginTop: 10, textAlign: 'right' } },
              h(
                'button',
                { type: 'button', style: { ...btn('no'), marginRight: 0 }, onClick: dismissAll },
                '全部忽略',
              ),
            ),
          ),
        )
      } catch {
        return null
      }
    }

    // ── 记忆库结构面板 ───────────────────────────────────

    /**
     * 空态时给的「起手模板」按钮。
     *
     * 为什么是「三本」而不是「八本」：小白第一次打开就看到一堆空表格，
     * 认知负担太重。三本够用，需要再加。
     * 但「更多库」要留出口 —— 已经知道自己要什么的人不该被三本限制。
     */
    function StarterButtons({ onDone }) {
      const [busy, setBusy] = React.useState('')
      const [err, setErr] = React.useState('')

      const make = React.useCallback(
        async (preset) => {
          setBusy(preset)
          setErr('')
          try {
            const r = await fetch(`${API}/scaffold`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ preset }),
            })
            const data = await r.json().catch(() => ({}))
            if (!data.ok) {
              setErr(data.reason || data.error || '生成失败')
              return
            }
            if (onDone) onDone()
          } catch (e) {
            setErr(String(e))
          } finally {
            setBusy('')
          }
        },
        [onDone],
      )

      const b = (label, preset, hint) =>
        h(
          'button',
          {
            type: 'button',
            key: preset,
            disabled: Boolean(busy),
            onClick: () => make(preset),
            title: hint,
            style: {
              cursor: 'pointer',
              border: `1px solid ${TH.border2}`,
              background: preset === 'minimal' ? TH.bg1 : 'transparent',
              color: TH.fg,
              borderRadius: 8,
              padding: '7px 14px',
              fontSize: 12,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
            },
          },
          h('span', { style: { fontWeight: 600 } }, busy === preset ? '生成中…' : label),
          h('span', { style: { color: TH.fg2, fontSize: 10 } }, hint),
        )

      return h(
        'div',
        { style: { marginTop: 16 } },
        h(
          'div',
          {
            style: {
              display: 'flex',
              gap: 8,
              justifyContent: 'center',
              flexWrap: 'wrap',
            },
          },
          b('三本起手', 'minimal', '偏好 / 项目 / 环境'),
          b('全部八本', 'full', '再加 软件 / 网络 / 命令 / 清理 / 排障'),
          b('英文三本', 'en', 'Preferences / Projects / Environment'),
        ),
        err
          ? h(
              'div',
              {
                style: {
                  marginTop: 10,
                  padding: '6px 10px',
                  borderRadius: 6,
                  background: TH.bg2,
                  color: TH.warn,
                  fontSize: 11,
                },
              },
              err,
            )
          : null,
        h(
          'div',
          { style: { marginTop: 10, color: TH.fg2, fontSize: 11 } },
          '生成后可以直接改文件，也可以删。不想要就整批删掉。',
        ),
      )
    }

    function useTree(open) {
      const [tree, setTree] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [loading, setLoading] = React.useState(false)

      const load = React.useCallback(async () => {
        setLoading(true)
        try {
          const r = await fetch(`${API}/tree`, { credentials: 'same-origin' })
          if (!r.ok) {
            setErr(`HTTP ${r.status}`)
            return
          }
          const data = await r.json()
          if (data && data.error) setErr(data.error)
          else setErr('')
          setTree(data)
        } catch (e) {
          setErr(String(e))
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        if (open) load()
      }, [open, load])

      return { tree, err, loading, reload: load }
    }

    // ── 记忆库面板（两层）─────────────────────────────────
    //
    // ① 总览 = 馆藏地图：中央是 AGENTS.md（主文档），四周是各库，面积按体积分档。
    //    摆位是确定性的 —— 中央常驻第一位，其余按体积降序。不随机、不按命中频率漂移
    //    （那样每次打开位置都不一样，就认不出「我的库」了）。
    //    唯一会改顺序的动作是「拖一张卡到另一张卡上」，存在本机 localStorage。
    // ② 库内 = 阅读器：左边章节栏、右边正文，能检索、能改一节、能加减章节与条目。
    //
    // 两条铁律：
    //   · 所有写操作都带版本指纹，服务端发现文件被别处改过就回 conflict，
    //     **绝不静默覆盖** —— 记忆库被悄悄盖掉是不可接受的损失；
    //   · 座位里任何 throw 都会让控件静默消失，所以整块 try 包裹，出错返回 null。

    const ATLAS_ORDER_KEY = 'almost-for-ever:atlas-order'

    const PANEL = {
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'var(--dsw-alias-scrim, rgba(0,0,0,0.38))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 10,
      },
      box: {
        width: 'min(1180px, 94vw)',
        height: 'min(90vh, 900px)',
        display: 'flex',
        flexDirection: 'column',
        background: TH.bg,
        color: TH.fg,
        border: `1px solid ${TH.border}`,
        borderRadius: 14,
        boxShadow: '0 24px 60px var(--dsw-alias-shadow, rgba(0,0,0,0.30))',
        overflow: 'hidden',
        fontSize: 12,
      },
      head: {
        padding: '10px 14px',
        borderBottom: `1px solid ${TH.border}`,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
        flexWrap: 'wrap',
      },
      input: {
        background: TH.bg2,
        color: TH.fg,
        border: `1px solid ${TH.border2}`,
        borderRadius: 6,
        padding: '4px 8px',
        fontSize: 11,
        fontFamily: 'inherit',
        outline: 'none',
      },
    }

    // 面板自己的小按钮：btn() 带 marginRight/marginTop，在 flex + gap 里会错位
    const sb = (tone) => ({
      cursor: 'pointer',
      border: `1px solid ${tone ? TH.ok : TH.border2}`,
      background: 'transparent',
      color: tone ? TH.ok : TH.fg2,
      borderRadius: 8,
      padding: '4px 10px',
      fontSize: 11.5,
      fontFamily: 'inherit',
      lineHeight: '16px',
      whiteSpace: 'nowrap',
    })

    // 头部的小信息片：一行灰字太轻，几个胶囊能立刻读出「多少、多大」
    const chip = () => ({
      fontSize: 10,
      lineHeight: '18px',
      padding: '0 7px',
      borderRadius: 999,
      border: `1px solid ${TH.border}`,
      color: TH.fg2,
      whiteSpace: 'nowrap',
    })

    const MD = {
      p: { margin: '0 0 8px', lineHeight: 1.75, fontSize: 12.5 },
      h: {
        1: { fontSize: 17, fontWeight: 600, margin: '14px 0 8px' },
        2: { fontSize: 15, fontWeight: 600, margin: '14px 0 8px' },
        3: { fontSize: 13.5, fontWeight: 600, margin: '12px 0 6px' },
        4: { fontSize: 12.5, fontWeight: 600, margin: '10px 0 6px' },
        5: { fontSize: 12, fontWeight: 600, margin: '10px 0 6px' },
      },
      list: { margin: '0 0 8px', paddingLeft: 18, lineHeight: 1.75, fontSize: 12.5 },
      code: {
        background: TH.bg2,
        borderRadius: 4,
        padding: '0 4px',
        fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
        fontSize: 11.5,
      },
      pre: {
        background: TH.bg1,
        border: `1px solid ${TH.border}`,
        borderRadius: 8,
        padding: '10px 12px',
        overflowX: 'auto',
        fontSize: 11.5,
        lineHeight: 1.6,
        fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
        margin: '0 0 10px',
      },
      quote: {
        borderLeft: `3px solid ${TH.border2}`,
        paddingLeft: 10,
        margin: '0 0 10px',
        color: TH.fg2,
        fontSize: 12,
        lineHeight: 1.7,
      },
      table: { borderCollapse: 'collapse', margin: '0 0 12px', fontSize: 11.5 },
      th: {
        border: `1px solid ${TH.border}`,
        padding: '4px 8px',
        background: TH.bg1,
        textAlign: 'left',
        fontWeight: 600,
      },
      td: { border: `1px solid ${TH.border}`, padding: '4px 8px', verticalAlign: 'top' },
      link: { color: TH.brand, textDecoration: 'underline' },
      hr: { border: 'none', borderTop: `1px solid ${TH.border}`, margin: '14px 0' },
      del: {
        cursor: 'pointer',
        border: `1px solid ${TH.border2}`,
        background: 'transparent',
        color: TH.warn,
        borderRadius: 4,
        fontSize: 9.5,
        lineHeight: '13px',
        padding: '0 4px',
        marginLeft: 6,
      },
    }

    // 体积分档：√(本库 / 中位数)。记忆库体积差十倍是常态，
    // 线性分档下九成的库会挤进最小一档，地图就没有「大小不一」可言了。
    // 阈值宁高勿低：中间档一多，墙面上全是宽卡，节奏就散了。
    function sizeClass(tokens, median) {
      const r = Math.sqrt(Math.max(tokens, 1) / Math.max(median, 1))
      if (r >= 1.9) return 'L'
      if (r >= 1.02) return 'M'
      return 'S'
    }

    function medianOf(list) {
      const a = list.slice().sort((x, y) => x - y)
      if (!a.length) return 1
      const m = a.length >> 1
      return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
    }

    function readOrder() {
      try {
        const raw = window.localStorage.getItem(ATLAS_ORDER_KEY)
        const arr = raw ? JSON.parse(raw) : []
        return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []
      } catch {
        return []
      }
    }

    function writeOrder(arr) {
      try {
        window.localStorage.setItem(ATLAS_ORDER_KEY, JSON.stringify(arr.slice(0, 300)))
      } catch {
        /* 存不进也得能用 */
      }
    }

    /** 按记住的顺序排；没记过的按体积降序补在后面。 */
    function orderLibs(libs, order) {
      const by = new Map(libs.map((l) => [l.stem, l]))
      const out = []
      for (const stem of order) {
        const l = by.get(stem)
        if (l) {
          out.push(l)
          by.delete(stem)
        }
      }
      const rest = libs.filter((l) => by.has(l.stem)).sort((a, b) => b.tokens - a.tokens)
      return out.concat(rest)
    }

    /** 按 `## ` 切节。跟服务端 doc-store 的口径逐字一致（行号 1 起）。 */
    function splitDocText(content) {
      // 记忆库的文件是 CRLF 存的。不先抹掉 \r，行尾会挂着一个空格，
      // 行号对得上但标题/正文里都带隐藏字符 —— 后面按行匹配全都不准。
      const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n')
      const marks = []
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].startsWith('## ')) marks.push(i)
      }
      const sections = marks.map((start, i) => {
        const end = i + 1 < marks.length ? marks[i + 1] : lines.length
        const body = lines.slice(start, end).join('\n')
        let entries = 0
        for (let j = start + 1; j < end; j += 1) {
          if (/^\s*[-*] /.test(lines[j])) entries += 1
        }
        return {
          i,
          title: lines[start].slice(3).trim(),
          line: start + 1,
          start,
          end,
          endLine: end,
          tokens: Math.max(1, Math.round(body.length / 1.5)),
          entries,
        }
      })

      // 第一个 `## ` 之前的内容不属于任何一节。不单独成节的话，
      // 中央 AGENTS.md 开头的「铁律」既看不到也改不了 —— 那恰恰是最该看的部分。
      // 只写了一行 `# 标题` 的不算内容，不凭空造一节。
      const headEnd = marks.length ? marks[0] : lines.length
      const headBytes = lines.slice(0, headEnd)
      const hasHead = headBytes.some((l, k) => l.trim() && !(k === 0 && /^#\s/.test(l)))
      if (hasHead) {
        const body = headBytes.join('\n')
        sections.unshift({
          i: 0,
          head: true,
          title: '前言',
          line: 1,
          start: 0,
          end: headEnd,
          endLine: headEnd,
          tokens: Math.max(1, Math.round(body.length / 1.5)),
          entries: 0,
        })
        sections.forEach((s, k) => {
          s.i = k
        })
      }
      return { lines, sections }
    }

    function countHits(text, lowerQuery) {
      if (!lowerQuery) return 0
      const lower = String(text || '').toLowerCase()
      let n = 0
      let at = 0
      while (true) {
        const i = lower.indexOf(lowerQuery, at)
        if (i < 0) break
        n += 1
        at = i + lowerQuery.length
      }
      return n
    }

    /** 把一段 Markdown 换成 React 节点。只覆盖记忆库真会用到的那几种语法。 */
    function mdInline(text, key0) {
      const out = []
      const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\n]+\*)/g
      let at = 0
      let m
      let k = 0
      while ((m = re.exec(text))) {
        if (m.index > at) out.push(text.slice(at, m.index))
        const tok = m[0]
        const key = `${key0}-${k++}`
        if (tok.startsWith('**')) {
          out.push(h('strong', { key }, tok.slice(2, -2)))
        } else if (tok.startsWith('`')) {
          out.push(h('code', { key, style: MD.code }, tok.slice(1, -1)))
        } else if (tok.startsWith('[')) {
          const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)
          out.push(
            h(
              'a',
              { key, href: mm[2], target: '_blank', rel: 'noreferrer', style: MD.link },
              mm[1],
            ),
          )
        } else {
          out.push(h('em', { key }, tok.slice(1, -1)))
        }
        at = m.index + tok.length
      }
      if (at < text.length) out.push(text.slice(at))
      return out
    }

    function mdTable(rows, key, onDel) {
      const split = (t) => {
        let s = String(t).trim()
        if (s.startsWith('|')) s = s.slice(1)
        if (s.endsWith('|')) s = s.slice(0, -1)
        return s.split('|').map((x) => x.trim())
      }
      // 分隔行必须整行都是 |---+---| 这种形状。早先只判「含 -」，
      // 结果 2026-11-26、04-projects 这类正文行被当成分隔行整行丢掉。
      const isSep = (t) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(t)
      const head = split(rows[0].text)
      const body = rows.slice(1).filter((r) => !isSep(r.text))
      return h(
        'table',
        { key: `t${key}`, style: MD.table },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            ...head.map((c, i) => h('th', { key: i, style: MD.th }, ...mdInline(c, `th${key}${i}`))),
            onDel ? h('th', { style: { border: 'none' } }) : null,
          ),
        ),
        h(
          'tbody',
          null,
          ...body.map((r, ri) =>
            h(
              'tr',
              { key: ri },
              ...split(r.text).map((c, ci) =>
                h('td', { key: ci, style: MD.td }, ...mdInline(c, `td${key}${ri}${ci}`)),
              ),
              onDel
                ? h(
                    'td',
                    { style: { border: 'none', padding: 0 } },
                    h(
                      'button',
                      { type: 'button', title: '删除这一行', onClick: () => onDel(r.line), style: MD.del },
                      '✕',
                    ),
                  )
                : null,
            ),
          ),
        ),
      )
    }

    /**
     * 渲染正文。base = 这段第一行在文件里的行号 ——
     * 「整理」模式下每行旁边要能删，就必须知道它对应文件里哪一行。
     */
    function renderMd(text, base, onDel) {
      // 统一按 LF 处理：文件是 CRLF 存的，行尾那个 \r 会让
      // `^(#{1,6})\s+(.*)$` 这种「到行尾」的正则整条失配 —— 曾经因此死循环。
      const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
      const out = []
      let i = 0
      let key = 0
      const LM = /^(\s*)([-*+]|\d+[.)])\s+/

      while (i < lines.length) {
        const raw = lines[i]
        if (!raw.trim()) {
          i += 1
          continue
        }

        // `<!-- 标签: ... -->` 是给插件建索引用的，不是给人读的正文 ——
        // 每个 `##` 下面都有一行，原样显示就成了满屏生注释。
        if (/^\s*<!--/.test(raw)) {
          let j = i
          while (j < lines.length && !/-->\s*$/.test(lines[j])) j += 1
          i = j + 1
          continue
        }

        if (/^\s*```/.test(raw)) {
          const buf = []
          i += 1
          while (i < lines.length && !/^\s*```/.test(lines[i])) {
            buf.push(lines[i])
            i += 1
          }
          i += 1
          out.push(h('pre', { key: `k${key++}`, style: MD.pre }, h('code', null, buf.join('\n'))))
          continue
        }

        if (/^\s*\|/.test(raw)) {
          const rows = []
          while (i < lines.length && /^\s*\|/.test(lines[i])) {
            rows.push({ text: lines[i], line: base + i })
            i += 1
          }
          out.push(mdTable(rows, key++, onDel))
          continue
        }

        if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) {
          out.push(h('hr', { key: `k${key++}`, style: MD.hr }))
          i += 1
          continue
        }

        const hm = /^(#{1,6})\s+(.*)$/.exec(raw)
        if (hm) {
          const lv = Math.min(5, hm[1].length)
          out.push(h(`h${lv + 1}`, { key: `k${key++}`, style: MD.h[lv] }, ...mdInline(hm[2], `h${key}`)))
          i += 1
          continue
        }

        if (/^\s*>\s?/.test(raw)) {
          const buf = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
            buf.push(lines[i].replace(/^\s*>\s?/, ''))
            i += 1
          }
          out.push(h('blockquote', { key: `k${key++}`, style: MD.quote }, ...mdInline(buf.join(' '), `q${key}`)))
          continue
        }

        if (LM.test(raw)) {
          const ordered = /^\s*\d+[.)]\s+/.test(raw)
          const items = []
          while (i < lines.length) {
            const m2 = LM.exec(lines[i])
            if (!m2) {
              // 续行：非空、有缩进、不是新条目
              if (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i])) {
                items[items.length - 1].text += ' ' + lines[i].trim()
                i += 1
                continue
              }
              break
            }
            items.push({ indent: m2[1].length, text: lines[i].slice(m2[0].length), line: base + i })
            i += 1
          }
          const kk = key++
          out.push(
            h(
              ordered ? 'ol' : 'ul',
              { key: `k${kk}`, style: MD.list },
              ...items.map((it, j) =>
                h(
                  'li',
                  { key: j, style: { marginLeft: Math.min(it.indent, 8) * 2 } },
                  ...mdInline(it.text, `l${kk}-${j}`),
                  onDel
                    ? h(
                        'button',
                        {
                          type: 'button',
                          title: '删除这一行',
                          onClick: () => onDel(it.line),
                          style: MD.del,
                        },
                        '✕',
                      )
                    : null,
                ),
              ),
            ),
          )
          continue
        }

        const buf = []
        const pStart = i
        while (
          i < lines.length &&
          lines[i].trim() &&
          !/^#{1,6}\s/.test(lines[i]) &&
          !/^\s*```/.test(lines[i]) &&
          !/^\s*\|/.test(lines[i]) &&
          !/^\s*>\s?/.test(lines[i]) &&
          !/^\s*<!--/.test(lines[i]) &&
          !LM.test(lines[i])
        ) {
          buf.push(lines[i])
          i += 1
        }
        // 兜底：万一某一行把上面的分支全躲过去、又过不了这个 while，
        // buf 就是空的 —— 那 i 永远不动，整个界面直接卡死（真出过）。
        // 宁可原样吐一行，也必须往前走。
        if (!buf.length) {
          out.push(h('p', { key: `k${key++}`, style: MD.p }, raw))
          i += 1
          continue
        }
        // 整理模式按「原始行」出 ✕：段落常常由几行折成一段，
        // 整段一个删除键就删多了，也看不出删的是哪一行。
        if (onDel) {
          for (let k2 = 0; k2 < buf.length; k2 += 1) {
            out.push(
              h(
                'p',
                { key: `k${key++}`, style: MD.p },
                ...mdInline(buf[k2], `p${key}`),
                h(
                  'button',
                  {
                    type: 'button',
                    title: '删除这一行',
                    onClick: () => onDel(base + pStart + k2),
                    style: MD.del,
                  },
                  '✕',
                ),
              ),
            )
          }
        } else {
          out.push(h('p', { key: `k${key++}`, style: MD.p }, ...mdInline(buf.join(' '), `p${key}`)))
        }
      }
      return out
    }

    function mergeSectionText(content, sec, text) {
      const lines = String(content || '').split('\n')
      if (!sec) return text
      return lines
        .slice(0, sec.start)
        .concat(text.split('\n'), lines.slice(sec.end))
        .join('\n')
    }

    function docTitleOf(content, stem) {
      if (stem === 'AGENTS') return '中央记忆'
      const m = /^#\s+(.+)$/m.exec(String(content || ''))
      return m ? m[1].trim() : stem
    }

    function LookPanel({ cur, setLookNow }) {
      return h(
        'div',
        {
          style: {
            padding: '8px 14px 10px',
            borderBottom: `1px solid ${TH.border}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            background: TH.bg1,
            flexShrink: 0,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { color: TH.fg2, fontSize: 11, width: 28 } }, '颜色'),
          ...PALETTES.map((p) =>
            h('button', {
              key: p.id,
              type: 'button',
              title: p.name,
              onClick: () => setLookNow({ color: p.id }),
              style: {
                cursor: 'pointer',
                width: 22,
                height: 22,
                borderRadius: 999,
                padding: 0,
                background: p.bd || TH.bg2,
                border: cur.color === p.id ? '2px solid ' + TH.fg : '1px solid ' + TH.border2,
              },
            }),
          ),
          h(
            'span',
            { style: { color: TH.fg2, fontSize: 11 } },
            (PALETTES.find((p) => p.id === cur.color) || PALETTES[0]).name,
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { color: TH.fg2, fontSize: 11, width: 28 } }, '形状'),
          ...SHAPES.map((s) =>
            h(
              'button',
              {
                key: s.id,
                type: 'button',
                title: s.name,
                onClick: () => setLookNow({ shape: s.id }),
                style: Object.assign({}, sb(), {
                  color: cur.shape === s.id ? TH.ok : TH.fg2,
                  borderColor: cur.shape === s.id ? TH.ok : TH.border2,
                }),
              },
              s.name,
            ),
          ),
          h('span', { style: { color: TH.fg2, fontSize: 11, width: 28 } }, '大小'),
          ...SIZES.map((s) =>
            h(
              'button',
              {
                key: s.id,
                type: 'button',
                title: s.name,
                onClick: () => setLookNow({ size: s.id }),
                style: Object.assign({}, sb(), {
                  color: cur.size === s.id ? TH.ok : TH.fg2,
                  borderColor: cur.size === s.id ? TH.ok : TH.border2,
                }),
              },
              s.name,
            ),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { color: TH.fg2, fontSize: 11, width: 28 } }, '位置'),
          h(
            'button',
            { type: 'button', style: sb(), onClick: () => setLookNow({ pos: {} }) },
            '复位到右下角',
          ),
          h(
            'span',
            { style: { color: TH.fg2, fontSize: 11 } },
            '按住圆片拖即可移动，位置会记住；右键圆片可直接打开这里。',
          ),
        ),
      )
    }

    function CentralCard({ central, onOpen, place, wide }) {
      const secs = (central.sections || []).filter((s) => s.title).slice(0, 3)
      const faint = 'rgba(255,255,255,0.70)'
      return h(
        'button',
        {
          type: 'button',
          onClick: () => onOpen(central.stem, 0),
          title: '中央记忆：~/.dsh/AGENTS.md —— 每轮自动加载，所以在总览里常驻中间',
          style: Object.assign(
            {
              gridColumn: 'span 2',
              gridRow: 'span 2',
              position: 'relative',
              display: 'flex',
              flexDirection: wide ? 'row' : 'column',
              gap: wide ? 18 : 0,
              alignItems: 'stretch',
              textAlign: 'left',
              font: 'inherit',
              color: '#f7faff',
              cursor: 'pointer',
              overflow: 'hidden',
              // 中央记忆是封面，不是另一张库卡。品牌色压进深墨底，
              // 明暗主题下都保持同一种「主文档」识别；不支持 color-mix 时退回品牌色。
              background: TH.brand,
              backgroundImage:
                'linear-gradient(135deg, color-mix(in srgb, var(--dsw-alias-brand-primary) 42%, #17263d) 0%, color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, #17263d) 100%)',
              border: '1px solid rgba(255,255,255,0.18)',
              borderRadius: 14,
              padding: '14px 15px',
              boxShadow: '0 10px 26px rgba(30,50,80,0.16)',
            },
            place || null,
          ),
        },
        h(
          'span',
          {
            style: {
              position: 'absolute',
              right: 12,
              top: 5,
              fontSize: 82,
              fontWeight: 700,
              lineHeight: 1,
              color: 'rgba(255,255,255,0.07)',
              pointerEvents: 'none',
            },
          },
          'A',
        ),
        h(
          'div',
          {
            style: {
              position: 'relative',
              display: 'flex',
              flex: wide ? 1 : 'initial',
              alignItems: 'flex-start',
              gap: 8,
            },
          },
          h(
            'div',
            null,
            h(
              'div',
              {
                style: {
                  fontSize: 9,
                  letterSpacing: 1.4,
                  color: faint,
                  fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
                },
              },
              'AGENTS.md',
            ),
            h('div', { style: { fontSize: 20, fontWeight: 650, letterSpacing: 0.5, marginTop: 8 } }, '中央记忆'),
            h('div', { style: { fontSize: 10.5, color: faint, marginTop: 4 } }, '全局规则与记忆入口'),
          ),
          h('span', { style: { flex: 1 } }),
          h(
            'span',
            {
              style: {
                fontSize: 9,
                color: faint,
                border: '1px solid rgba(255,255,255,0.20)',
                borderRadius: 999,
                padding: '2px 7px',
                whiteSpace: 'nowrap',
              },
            },
            '每轮自动加载',
          ),
        ),
        h(
          'div',
          {
            style: {
              position: 'relative',
              marginTop: wide ? 0 : 'auto',
              paddingTop: wide ? 0 : 12,
              width: wide ? '42%' : 'auto',
              paddingLeft: wide ? 16 : 0,
              borderLeft: wide ? '1px solid rgba(255,255,255,0.14)' : 'none',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
            },
          },
          h(
            'div',
            { style: { display: 'flex', gap: 7, fontSize: 10, color: faint, marginBottom: 8 } },
            central.exists
              ? h(
                  React.Fragment,
                  null,
                  h('span', null, `${fmtTok(central.tokens)} tok`),
                  h('span', null, '·'),
                  h('span', null, `${central.sections.length} 节`),
                )
              : h('span', null, '还没有文件，点进来建立'),
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                flexWrap: wide ? 'wrap' : 'nowrap',
                gap: 5,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              },
            },
            ...secs.map((s) =>
              h(
                'span',
                {
                  key: s.title,
                  style: {
                    fontSize: 9.5,
                    color: faint,
                    background: 'rgba(255,255,255,0.08)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 6,
                    padding: '2px 7px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  },
                },
                s.title,
              ),
            ),
          ),
        ),
      )
    }

    // 色相跟着「用途」走，浓度跟着实际 token 体量走；渐变始终混回主题底色。
    // 同一份记忆库颜色稳定，不随机换色；正文仍用主题前景色。
    const LIB_TONES = [
      { re: /^00/, color: '#ef7070', rgb: '239,112,112' },
      { re: /^0[12]/, color: '#a875e6', rgb: '168,117,230' },
      { re: /^03/, color: '#82bd55', rgb: '130,189,85' },
      { re: /^05/, color: '#3cbc88', rgb: '60,188,136' },
      { re: /^09/, color: '#28b8ae', rgb: '40,184,174' },
      { re: /^04/, color: '#eda13c', rgb: '237,161,60' },
      { re: /^06/, color: '#5a8ff2', rgb: '90,143,242' },
      { re: /^07/, color: '#38b6db', rgb: '56,182,219' },
      { re: /^11/, color: '#8578eb', rgb: '133,120,235' },
      { re: /^10/, color: '#ed74a8', rgb: '237,116,168' },
    ]
    const toneOf = (stem) =>
      LIB_TONES.find((t) => t.re.test(stem)) || {
        color: '#72a9c6',
        rgb: '114,169,198',
      }

    function LibCard({ lib, size, heat, onOpen, dragStem, setDragStem, swap }) {
      const span =
        size === 'L'
          ? { gridColumn: 'span 2', gridRow: 'span 2' }
          : size === 'M'
            ? { gridColumn: 'span 2', gridRow: 'span 1' }
            : { gridColumn: 'span 1', gridRow: 'span 1' }
      const bare = size === 'S'
      const tone = toneOf(lib.stem)
      // 体量连续映射到色彩重量：最大的库最浓，小库只留一层淡彩，而不是只有三档。
      const weight = typeof heat === 'number' ? heat : size === 'L' ? 0.85 : size === 'M' ? 0.5 : 0.18
      const strong = Math.round(8 + weight * 30)
      const soft = Math.round(3 + weight * 15)
      const ink = `color-mix(in srgb, ${tone.color} 72%, ${TH.fg})`
      const restingBorder = `rgba(${tone.rgb},${(0.16 + weight * 0.3).toFixed(2)})`
      const secs = (lib.sections || []).filter((s) => !s.meta && s.title)
      const listed = size === 'L' ? secs.slice(0, 5) : []
      const chips = size === 'M' ? secs.slice(0, 2) : []
      const border = (on) => (e) => {
        e.currentTarget.style.borderColor = on ? tone.color : restingBorder
        e.currentTarget.style.borderLeftColor = tone.color
      }
      return h(
        'button',
        {
          type: 'button',
          draggable: true,
          onDragStart: (e) => {
            setDragStem(lib.stem)
            try {
              e.dataTransfer.setData('text/plain', lib.stem)
            } catch {
              /* noop */
            }
          },
          onDragEnd: () => setDragStem(''),
          onDragOver: (e) => e.preventDefault(),
          onDrop: (e) => {
            e.preventDefault()
            let from = dragStem
            try {
              from = from || e.dataTransfer.getData('text/plain')
            } catch {
              /* noop */
            }
            swap(from, lib.stem)
            setDragStem('')
          },
          onClick: () => onOpen(lib.stem, 0),
          onMouseEnter: border(true),
          onMouseLeave: border(false),
          title: `${lib.label} · ${lib.sections.length} 节 · 约 ${fmtTok(lib.tokens)} tok\n${lib.stem}.md\n拖动可以排序`,
          style: Object.assign(
            {
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'stretch',
              textAlign: 'left',
              font: 'inherit',
              color: TH.fg,
              cursor: 'pointer',
              overflow: 'hidden',
              // 颜色既分用途，也随实际 token 体量连续加深；混色始终落回主题底色。
              backgroundColor: `rgba(${tone.rgb},${(0.03 + weight * 0.08).toFixed(2)})`,
              backgroundImage: `linear-gradient(135deg, color-mix(in srgb, ${tone.color} ${strong}%, ${TH.bg1}) 0%, color-mix(in srgb, ${tone.color} ${soft}%, ${TH.bg1}) 100%)`,
              border: `1px solid ${restingBorder}`,
              borderLeft: `${3 + Math.round(weight * 2)}px solid ${tone.color}`,
              borderRadius: 12,
              padding: '10px 11px',
              opacity: dragStem && dragStem !== lib.stem ? 0.4 : 1,
            },
            span,
          ),
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
          h(
            'span',
            {
              style: {
                color: ink,
                fontSize: bare ? 12 : 12.5,
                fontWeight: size === 'L' ? 650 : 600,
                lineHeight: 1.4,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            lib.label,
          ),
          h('span', { style: { flex: 1 } }),
          h(
            'span',
            { style: { fontSize: 9.5, color: ink, whiteSpace: 'nowrap' } },
            fmtTok(lib.tokens),
          ),
        ),
        h(
          'div',
          {
            style: {
              fontSize: 9.5,
              color: TH.fg2,
              opacity: 0.65,
              fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginTop: 1,
            },
          },
          lib.stem,
        ),
        chips.length
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  gap: 8,
                  marginTop: 6,
                  fontSize: 10,
                  color: TH.fg2,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                },
              },
              ...chips.map((s) =>
                h(
                  'span',
                  {
                    key: s.title,
                    style: {
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      borderLeft: `1px solid ${tone.color}`,
                      paddingLeft: 8,
                    },
                  },
                  s.title,
                ),
              ),
            )
          : null,
        listed.length
          ? h(
              'div',
              { style: { marginTop: 7, display: 'flex', flexDirection: 'column', gap: 1 } },
              ...listed.map((s) =>
                h(
                  'div',
                  {
                    key: s.title,
                    style: {
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 6,
                      fontSize: 10,
                      lineHeight: '17px',
                      color: TH.fg2,
                      overflow: 'hidden',
                    },
                  },
                  h(
                    'span',
                    { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    s.title,
                  ),
                  h('span', { style: { flex: 1, borderBottom: `1px dotted ${TH.border}`, transform: 'translateY(-3px)' } }),
                  h('span', { style: { opacity: 0.7, whiteSpace: 'nowrap' } }, fmtTok(s.tokens || 0)),
                ),
              ),
            )
          : null,
        h(
          'div',
          {
            style: {
              marginTop: 'auto',
              paddingTop: 6,
              fontSize: 9.5,
              color: TH.fg2,
              display: 'flex',
              alignItems: 'baseline',
              gap: 6,
              whiteSpace: 'nowrap',
            },
          },
          h('span', null, `${lib.sections.length} 节`),
        ),
      )
    }

    function AtlasMap({ central, libs, median, onOpen, dragStem, setDragStem, swap, reload }) {
      // 注意：central 永远有值（文件不存在也是一个对象），
      // 所以空态判断只能看 libs —— 否则新装的机器永远看不到起手模板。
      const empty = !libs.length
      const maxTokens = Math.max(1, ...libs.map((l) => l.tokens || 0))

      // 主卡得落在正中间。grid 自动排是「行优先」，主卡作为第一项永远顶左上角，
      // 跟「四周环绕」正好相反 —— 所以先量出一行能排几列，再显式指定位置。
      const gridRef = React.useRef(null)
      const [cols, setCols] = React.useState(0)
      React.useLayoutEffect(() => {
        const el = gridRef.current
        if (!el) return undefined
        const measure = () => {
          const w = el.clientWidth
          if (w > 0) setCols(Math.max(2, Math.floor((w + 10) / 152)))
        }
        measure()
        if (typeof ResizeObserver === 'undefined') return undefined
        const ro = new ResizeObserver(measure)
        ro.observe(el)
        return () => ro.disconnect()
      }, [])
      // 宽屏给中央主卡三条轨道，横向封面才装得下标题与章节入口；高度仍只占两行。
      // 若「总列数 - 主卡列数」是奇数，就多预留一条轨道，再按 s/(s+1) 缩回视觉宽度，
      // 通用公式 = 预留宽的 s/r - g/r（g=10px），保证奇偶列都真正居中。
      const span = cols >= 7 ? 3 : cols >= 3 ? 2 : 1
      const rowSpan = cols >= 3 ? 2 : 1
      const needsPad = cols > span && (cols - span) % 2 === 1
      const reserved = needsPad ? span + 1 : span
      const place = cols
        ? Object.assign(
            {
              gridColumn: `${Math.max(1, Math.floor((cols - reserved) / 2) + 1)} / span ${reserved}`,
              gridRow: `2 / span ${rowSpan}`,
            },
            needsPad
              ? {
                  width: `calc(${(span / reserved) * 100}% - ${10 / reserved}px)`,
                  justifySelf: 'center',
                }
              : null,
          )
        : null

      return h(
        'div',
        { style: { flex: 1, overflowY: 'auto', padding: '16px 18px 18px' } },
        h(
          'div',
          {
            ref: gridRef,
            style: {
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(142px, 1fr))',
              gridAutoFlow: 'row dense',
              gridAutoRows: '96px',
              gap: 10,
            },
          },
          central ? h(CentralCard, { key: 'central', central, onOpen, place, wide: span >= 3 }) : null,
          ...libs.map((l) =>
            h(LibCard, {
              key: l.stem,
              lib: l,
              size: sizeClass(l.tokens, median),
              heat: Math.sqrt((l.tokens || 0) / maxTokens),
              onOpen,
              dragStem,
              setDragStem,
              swap,
            }),
          ),
        ),
        empty
          ? h(
              'div',
              {
                style: {
                  padding: '26px 8px 8px',
                  textAlign: 'center',
                  color: TH.fg2,
                  fontSize: 12,
                  lineHeight: 1.9,
                },
              },
              h('div', null, '目录里还没有记忆库文件。'),
              h('div', null, '可以一键生成一套起手模板，也可以自己放 markdown 文件进来。'),
              h(StarterButtons, { onDone: reload }),
            )
          : h(
              'div',
              { style: { marginTop: 12, color: TH.fg2, fontSize: 10.5, lineHeight: 1.7 } },
              '点卡片进库看正文；拖动一张卡到另一张卡上可以排序（只记在这台机器上）。',
            ),
      )
    }

    function HitList({ hits, onOpen }) {
      if (hits === null) {
        return h(
          'div',
          { style: { padding: 32, textAlign: 'center', color: TH.fg2, fontSize: 12 } },
          '检索中…',
        )
      }
      if (!hits.length) {
        return h(
          'div',
          { style: { padding: 32, textAlign: 'center', color: TH.fg2, fontSize: 12, lineHeight: 1.8 } },
          '没有命中。换个词试试 ——',
          h('div', null, '这里用的是跟自动注入同一套打分，命中什么就说明真正喂给模型的是什么。'),
        )
      }
      return h(
        'div',
        { style: { flex: 1, overflowY: 'auto', padding: '8px 14px 18px' } },
        ...hits.map((hit, i) =>
          h(
            'div',
            {
              key: `${hit.stem}-${hit.line}-${i}`,
              onClick: () => onOpen(hit.stem, hit.entry ? hit.entry.line : hit.line),
              style: {
                padding: '8px 10px',
                borderBottom: `1px solid ${TH.border}`,
                cursor: 'pointer',
              },
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('strong', { style: { fontSize: 12 } }, hit.label),
              h(
                'span',
                { style: { color: TH.fg2, fontSize: 10, fontFamily: 'ui-monospace, Menlo, monospace' } },
                `${hit.stem}:${hit.entry ? hit.entry.line : hit.line}`,
              ),
              h('span', { style: { flex: 1 } }),
              ...(hit.why || []).slice(0, 4).map((w, j) =>
                h(
                  'span',
                  {
                    key: j,
                    style: {
                      color: TH.brand,
                      fontSize: 9.5,
                      border: `1px solid ${TH.border2}`,
                      borderRadius: 999,
                      padding: '0 5px',
                      lineHeight: '14px',
                    },
                  },
                  w,
                ),
              ),
            ),
            h(
              'div',
              { style: { fontSize: 11.5, marginTop: 3 } },
              hit.entry ? `${hit.title} → ${String(hit.entry.head || '').slice(0, 60)}` : hit.title,
            ),
            hit.snippet
              ? h(
                  'div',
                  { style: { fontSize: 10.5, color: TH.fg2, marginTop: 3, lineHeight: 1.6 } },
                  hit.snippet,
                )
              : null,
          ),
        ),
      )
    }

    function AtlasView({ tree, err, loading, reload, onOpen, lookOpen, setLookOpen, cur, setLookNow, onClose }) {
      const libs = (tree && tree.libs) || []
      const central = tree && tree.central
      const [query, setQuery] = React.useState('')
      const [hits, setHits] = React.useState(null)
      const [order, setOrder] = React.useState(readOrder)
      const [dragStem, setDragStem] = React.useState('')

      const ordered = React.useMemo(() => orderLibs(libs, order), [libs, order])
      const median = React.useMemo(() => medianOf(libs.map((l) => l.tokens || 0)), [libs])
      const total = tree ? tree.totalTokens : 0

      // 检索走服务端：260ms 防抖，别每敲一个字打一次
      React.useEffect(() => {
        const q = query.trim()
        if (!q) {
          setHits(null)
          return undefined
        }
        let alive = true
        const id = setTimeout(() => {
          fetch(`${API}/search?q=${encodeURIComponent(q)}`, { credentials: 'same-origin' })
            .then((r) => r.json())
            .then((d) => {
              if (alive) setHits(d && Array.isArray(d.hits) ? d.hits : [])
            })
            .catch(() => {
              if (alive) setHits([])
            })
        }, 260)
        return () => {
          alive = false
          clearTimeout(id)
        }
      }, [query])

      const swap = (from, to) => {
        if (!from || !to || from === to) return
        const arr = ordered.map((l) => l.stem)
        const i = arr.indexOf(from)
        const j = arr.indexOf(to)
        if (i < 0 || j < 0) return
        arr.splice(i, 1)
        arr.splice(j, 0, from)
        writeOrder(arr)
        setOrder(arr)
      }

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { style: Object.assign({}, PANEL.head, { padding: '11px 16px', gap: 9 }) },
          h('strong', { style: { fontSize: 14, letterSpacing: 0.3 } }, '记忆库'),
          tree
            ? h(
                'span',
                { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                h('span', { style: chip() }, `${libs.length} 个库`),
                h('span', { style: chip() }, `约 ${fmtTok(total)} tok`),
              )
            : h('span', { style: { color: TH.fg2, fontSize: 11 } }, '正在读取…'),
          h('span', { style: { flex: 1 } }),
          h('input', {
            value: query,
            placeholder: '搜记忆正文…',
            onChange: (e) => setQuery(e.target.value),
            style: Object.assign(
              { width: 200, padding: '5px 9px', borderRadius: 8, fontSize: 11.5 },
              PANEL.input,
            ),
          }),
          h(
            'button',
            {
              type: 'button',
              style: sb(),
              onClick: () => setLookOpen((v) => !v),
              title: '圆片的形状 / 颜色 / 大小 / 位置',
            },
            lookOpen ? '⚙ 外观' : '⚙',
          ),
          h('button', { type: 'button', style: sb(), onClick: reload }, loading ? '…' : '刷新'),
          h('button', { type: 'button', style: sb(), onClick: onClose }, '关闭'),
        ),
        lookOpen ? h(LookPanel, { cur, setLookNow }) : null,
        err ? h('div', { style: { padding: '6px 14px', color: TH.warn, fontSize: 11 } }, err) : null,
        !tree && !err
          ? h(
              'div',
              { style: { padding: 40, textAlign: 'center', color: TH.fg2, fontSize: 12 } },
              '读取中…',
            )
          : query.trim()
            ? h(HitList, { hits, onOpen })
            : h(AtlasMap, {
                central,
                libs: ordered,
                median,
                onOpen,
                dragStem,
                setDragStem,
                swap,
                reload,
              }),
      )
    }
    /**
     * 库内视图：左边章节栏、右边正文。
     * 三种模式 —— read（读）/ edit（改当前这一节）/ organize（整理，每行能删）。
     * 只改当前这一节，而不是整个大文本框：改一节的风险面小得多。
     */
    function DocView({ stem, startLine, onBack, onChanged, onGuard }) {
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [active, setActive] = React.useState(0)
      const [q, setQ] = React.useState('')
      const [mode, setMode] = React.useState('read')
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [flash, setFlash] = React.useState('')
      const [conflict, setConflict] = React.useState(null)
      const [adding, setAdding] = React.useState(false)
      const [newTitle, setNewTitle] = React.useState('')

      const load = React.useCallback(async () => {
        setBusy(true)
        try {
          const r = await fetch(`${API}/doc?stem=${encodeURIComponent(stem)}`, {
            credentials: 'same-origin',
          })
          const d = await r.json()
          if (!d || !d.ok) {
            setErr((d && d.error) || '读不到这个库')
          } else {
            setErr('')
            // 换了正文就必须退出编辑态：否则草稿还是旧的、版本却是新的，
            // 一保存就把别处刚写的那一节静默盖掉。
            setMode('read')
            setDraft('')
            setConflict(null)
            setData(d)
          }
        } catch (e) {
          setErr(String(e))
        } finally {
          setBusy(false)
        }
      }, [stem])

      React.useEffect(() => {
        load()
      }, [load])

      // 记忆库的文件是 CRLF 存的。视图里统一按 LF 算行，存回去再换回 CRLF ——
      // 不然一次保存就把整篇的换行符悄悄改了，diff 全是噪音。
      const srcText = data ? String(data.content || '').replace(/\r\n?/g, '\n') : ''
      const usesCRLF = Boolean(data && /\r\n/.test(String(data.content || '')))
      const parsed = React.useMemo(() => splitDocText(srcText), [srcText])
      const sections = parsed.sections
      const curSec = sections.length ? sections[Math.min(active, sections.length - 1)] : null

      // 从检索结果点进来时，跳到命中那一节。只跳一次 ——
      // 之后每次保存都会换一份 sections，不能把用户手动选的节顶回去。
      const jumped = React.useRef(false)
      React.useEffect(() => {
        if (jumped.current || !startLine || !sections.length) return
        jumped.current = true
        const i = sections.findIndex((s) => startLine >= s.line && startLine <= s.endLine)
        if (i >= 0) setActive(i)
      }, [sections, startLine])

      React.useEffect(() => {
        if (!flash) return undefined
        const id = setTimeout(() => setFlash(''), 5000)
        return () => clearTimeout(id)
      }, [flash])

      /**
       * 保存。永远带版本指纹 —— 服务端对不上就回 conflict，
       * 这时候把选择权交给用户，而不是替他决定「谁赢」。
       */
      const save = React.useCallback(
        async (content, note, version) => {
          if (!data) return null
          // 视图里是 LF，落盘按这个文件原来的习惯（CRLF 的还写 CRLF）。
          const wire = usesCRLF ? String(content).replace(/\n/g, '\r\n') : content
          setBusy(true)
          try {
            const r = await fetch(`${API}/doc/save`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                stem,
                content: wire,
                version: typeof version === 'string' ? version : data.version,
              }),
            })
            const d = await r.json()
            if (d && d.ok) {
              setData(
                d.content
                  ? d
                  : Object.assign({}, data, { content: wire, version: d.version || data.version }),
              )
              setConflict(null)
              setFlash(note || '已保存')
              if (onChanged) onChanged()
              return d
            }
            if (d && d.conflict) {
              // 把「我原本要写什么」一起存下来。冲突条上那个「用我的覆盖」
              // 必须写这份待存内容，而不是 draft —— draft 只装当前这一节，
              // 删行/删节时甚至是空的，直接提交会把整库写成一节。
              setConflict(Object.assign({}, d, { pending: content, note: note || '' }))
              setFlash('')
              return null
            }
            setErr((d && d.error) || '保存失败')
            return null
          } catch (e) {
            setErr(String(e))
            return null
          } finally {
            setBusy(false)
          }
        },
        [data, stem, onChanged, usesCRLF],
      )

      /** 某一节在原文里的原始文本（编辑态草稿的基准）。 */
      const secTextOf = (sec) =>
        sec ? parsed.lines.slice(sec.start, sec.end).join('\n') : srcText

      /** 编辑态还有没保存的改动 —— 切节、返回、关浮层之前都要问一句。 */
      const dirty = mode === 'edit' && draft !== secTextOf(curSec)
      const guardDirty = React.useCallback(() => {
        if (!dirty) return true
        return window.confirm('这一节还有没保存的修改，真的放弃吗？')
      }, [dirty])

      // 关浮层是点遮罩触发的，事件在 TreePanel 手里 —— 把守卫交出去。
      React.useEffect(() => {
        if (!onGuard) return undefined
        onGuard(guardDirty)
        return () => onGuard(null)
      }, [onGuard, guardDirty])

      const startEdit = () => {
        if (!data) return
        setDraft(secTextOf(curSec))
        setMode('edit')
      }

      const commit = async () => {
        if (!data) return
        const next = mergeSectionText(srcText, curSec, draft)
        const d = await save(next, '已保存这一节')
        if (d) {
          setMode('read')
          setDraft('')
        }
      }

      const delLine = async (lineNo) => {
        if (!data) return
        const lines = srcText.split('\n')
        const idx = lineNo - 1
        if (idx < 0 || idx >= lines.length) return
        const preview = lines[idx]
          .replace(/^\s*[-*]\s*/, '')
          .trim()
          .slice(0, 80)
        if (!window.confirm(`删除这一行？\n\n${preview}`)) return
        const next = lines
          .slice(0, idx)
          .concat(lines.slice(idx + 1))
          .join('\n')
        await save(next, '已删除 1 行')
      }

      const undo = async () => {
        setBusy(true)
        try {
          const r = await fetch(`${API}/doc/undo`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ stem, version: data ? data.version : undefined }),
          })
          const d = await r.json()
          if (d && d.ok && d.content) {
            setMode('read')
            setDraft('')
            setData(d)
            setConflict(null)
            setFlash('已撤销上一步')
            if (onChanged) onChanged()
          } else if (d && d.conflict) {
            // 撤销也要过版本关：期间别处写过，就不能一键盖回去。
            setConflict(Object.assign({}, d, { pending: null, note: '' }))
          } else {
            setFlash((d && d.error) || '没有可撤销的版本')
          }
        } catch (e) {
          setFlash(String(e))
        } finally {
          setBusy(false)
        }
      }

      const addSection = async () => {
        const t = newTitle.trim()
        if (!t || !data) return
        const base = srcText.replace(/\s+$/, '')
        const next = `${base}\n\n## ${t}\n\n`
        const d = await save(next, '已新增章节')
        if (d) {
          setAdding(false)
          setNewTitle('')
          setActive(Math.max(0, splitDocText(d.content || next).sections.length - 1))
        }
      }

      const delSection = async () => {
        if (!curSec || !data) return
        if (!window.confirm(`删除章节「${curSec.title}」？\n整节（含下面所有条目）都会一起删掉。`)) {
          return
        }
        const lines = srcText.split('\n')
        const next = lines
          .slice(0, curSec.start)
          .concat(lines.slice(curSec.end))
          .join('\n')
        const d = await save(next, '已删除这一节')
        if (d) setActive(0)
      }

      // 「+ 条目」不直接写空行：先落到编辑态，让用户当场把内容打出来再存
      const startAddEntry = () => {
        if (!data) return
        const secText = curSec ? parsed.lines.slice(curSec.start, curSec.end).join('\n') : srcText
        setDraft(`${secText.replace(/\s+$/, '')}\n- `)
        setMode('edit')
      }

      const ql = q.trim().toLowerCase()
      const shown = ql
        ? sections
            .map((s) => {
              const text = parsed.lines.slice(s.start, s.end).join('\n')
              const lower = text.toLowerCase()
              return lower.includes(ql) ? Object.assign({}, s, { count: countHits(text, ql) }) : null
            })
            .filter(Boolean)
        : sections

      const bodyText = curSec
        ? parsed.lines.slice(curSec.start + 1, curSec.end).join('\n')
        : srcText
      const bodyBase = curSec ? curSec.start + 2 : 1

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { style: PANEL.head },
          h(
            'button',
            {
              type: 'button',
              style: sb(),
              onClick: () => {
                if (!guardDirty()) return
                onBack()
              },
              title: '回到总览',
            },
            '← 返回',
          ),
          h(
            'strong',
            { style: { fontSize: 13, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            data ? docTitleOf(srcText, stem) : stem,
          ),
          h(
            'span',
            {
              style: {
                fontSize: 9.5,
                color: stem === 'AGENTS' ? TH.brand : TH.fg2,
                border: `1px solid ${stem === 'AGENTS' ? TH.brand : TH.border2}`,
                borderRadius: 999,
                padding: '0 6px',
                lineHeight: '15px',
              },
              title: stem === 'AGENTS' ? '每轮自动加载的中央记忆' : '只在命中时注入',
            },
            stem === 'AGENTS' ? 'AGENTS.md' : `${stem}.md`,
          ),
          h('span', { style: { flex: 1 } }),
          h('input', {
            value: q,
            placeholder: '在本库内找…',
            onChange: (e) => setQ(e.target.value),
            style: Object.assign({ width: 150 }, PANEL.input),
          }),
          h(
            'button',
            {
              type: 'button',
              style: sb(),
              onClick: () => {
                if (!guardDirty()) return
                load()
              },
            },
            busy ? '…' : '刷新',
          ),
        ),
        // 冲突条：只在真的撞车时出现，且必给两条明确出路
        conflict
          ? h(
              'div',
              {
                style: {
                  padding: '8px 14px',
                  background: TH.bg1,
                  borderBottom: `1px solid ${TH.border}`,
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  fontSize: 11,
                  color: TH.warn,
                },
              },
              h(
                'span',
                { style: { flex: 1, minWidth: 200 } },
                conflict.pending === null
                  ? '这个文件刚被别处改过了 —— 撤销会把那些改动一起盖回去，先载入最新再说。'
                  : '这个文件刚被别处改过了，你手上的不是最新版 —— 直接保存会盖掉那些改动。',
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: sb(),
                  onClick: () => {
                    setMode('read')
                    setDraft('')
                    setData(Object.assign({}, data, { content: conflict.content, version: conflict.version }))
                    setConflict(null)
                    setFlash('已载入最新版本')
                  },
                },
                '载入最新（我的改动丢掉）',
              ),
              conflict.pending === null
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      style: sb(true),
                      onClick: async () => {
                        const d = await save(
                          conflict.pending,
                          conflict.note || '已用我的版本覆盖',
                          conflict.version,
                        )
                        if (d) {
                          setMode('read')
                          setDraft('')
                        }
                      },
                    },
                    '用我的覆盖',
                  ),
            )
          : null,
        flash || err
          ? h(
              'div',
              {
                style: {
                  padding: '6px 14px',
                  fontSize: 11,
                  color: err ? TH.warn : TH.fg2,
                  borderBottom: `1px solid ${TH.border}`,
                  display: 'flex',
                  gap: 10,
                  alignItems: 'center',
                },
              },
              h('span', { style: { flex: 1 } }, err || flash),
              h('button', { type: 'button', style: sb(), onClick: () => (setFlash(''), setErr('')) }, '×'),
            )
          : null,
        h(
          'div',
          { style: { flex: 1, display: 'flex', minHeight: 0 } },
          // 左栏：章节
          h(
            'div',
            {
              style: {
                width: 248,
                flexShrink: 0,
                borderRight: `1px solid ${TH.border}`,
                overflowY: 'auto',
                padding: '8px 8px 16px',
              },
            },
            ...shown.map((s) =>
              h(
                'div',
                {
                  key: s.i,
                  onClick: () => {
                    if (s.i === (curSec ? curSec.i : -1)) return
                    if (!guardDirty()) return
                    setActive(s.i)
                    setMode('read')
                    setDraft('')
                  },
                  style: {
                    padding: '5px 8px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: curSec && curSec.i === s.i ? TH.bg2 : 'transparent',
                    opacity: s.meta ? 0.6 : 1,
                  },
                },
                h(
                  'div',
                  {
                    style: {
                      fontSize: 11.5,
                      lineHeight: 1.45,
                      fontWeight: curSec && curSec.i === s.i ? 600 : 400,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                  },
                  s.title,
                ),
                h(
                  'div',
                  { style: { fontSize: 9.5, color: TH.fg2, marginTop: 1 } },
                  `${fmtTok(s.tokens)} tok · ${s.entries} 条`,
                  s.count ? ` · 命中 ${s.count}` : '',
                ),
              ),
            ),
            !sections.length
              ? h(
                  'div',
                  { style: { padding: '8px', fontSize: 10.5, color: TH.fg2, lineHeight: 1.7 } },
                  '这个文件还没有 `## ` 章节 —— 从下面「+ 章节」加一节。',
                )
              : null,
            ql && !shown.length
              ? h(
                  'div',
                  { style: { padding: '8px', fontSize: 10.5, color: TH.fg2, lineHeight: 1.7 } },
                  '没有哪一节含这个词。',
                )
              : null,
            h(
              'div',
              { style: { marginTop: 8, paddingTop: 8, borderTop: `1px solid ${TH.border}` } },
              adding
                ? h(
                    'div',
                    { style: { display: 'flex', gap: 6 } },
                    h('input', {
                      value: newTitle,
                      placeholder: '新章节标题',
                      autoFocus: true,
                      onChange: (e) => setNewTitle(e.target.value),
                      onKeyDown: (e) => {
                        if (e.key === 'Enter') addSection()
                        if (e.key === 'Escape') setAdding(false)
                      },
                      style: Object.assign({ flex: 1, minWidth: 0 }, PANEL.input),
                    }),
                    h('button', { type: 'button', style: sb(true), onClick: addSection }, '建'),
                  )
                : h(
                    'button',
                    {
                      type: 'button',
                      style: Object.assign({ width: '100%' }, sb()),
                      onClick: () => {
                        setAdding(true)
                        setNewTitle('')
                      },
                    },
                    '+ 章节',
                  ),
            ),
          ),
          // 右栏：正文 / 编辑器
          h(
            'div',
            { style: { flex: 1, minWidth: 0, overflowY: 'auto', padding: '12px 22px 40px' } },
            mode === 'edit'
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                  h(
                    'div',
                    { style: { fontSize: 10.5, color: TH.fg2, lineHeight: 1.7 } },
                    curSec
                      ? `正在改「${curSec.title}」—— 只覆盖这一节，别的节一个字节都不动。`
                      : '正在改整篇。',
                  ),
                  h('textarea', {
                    value: draft,
                    spellCheck: false,
                    onChange: (e) => setDraft(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault()
                        commit()
                      }
                    },
                    style: {
                      width: '100%',
                      minHeight: 340,
                      height: 'calc(90vh - 320px)',
                      resize: 'vertical',
                      background: TH.bg1,
                      color: TH.fg,
                      border: `1px solid ${TH.border2}`,
                      borderRadius: 8,
                      padding: '10px 12px',
                      fontSize: 12.5,
                      lineHeight: 1.75,
                      fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
                      outline: 'none',
                    },
                  }),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                    h(
                      'button',
                      { type: 'button', style: sb(true), onClick: commit, disabled: busy },
                      busy ? '保存中…' : '保存（Ctrl+S）',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: sb(),
                        onClick: () => {
                          setMode('read')
                          setDraft('')
                        },
                      },
                      '取消',
                    ),
                    curSec
                      ? h('button', { type: 'button', style: sb(), onClick: delSection }, '删除这一节')
                      : null,
                    h('span', { style: { flex: 1 } }),
                    h(
                      'span',
                      { style: { fontSize: 10.5, color: TH.fg2 } },
                      `${draft.length} 字`,
                    ),
                  ),
                )
              : h(
                  'div',
                  null,
                  h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        marginBottom: 10,
                        flexWrap: 'wrap',
                      },
                    },
                    data && data.exists === false
                      ? h(
                          'button',
                          {
                            type: 'button',
                            style: sb(true),
                            onClick: () =>
                              save(`# ${stem === 'AGENTS' ? 'AGENTS' : stem}\n\n`, '已建立文件'),
                          },
                          '建立文件',
                        )
                      : null,
                    h('button', { type: 'button', style: sb(), onClick: startEdit }, '✎ 编辑本节'),
                    h('button', { type: 'button', style: sb(), onClick: startAddEntry }, '+ 条目'),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: Object.assign({}, sb(), mode === 'organize' ? { color: TH.warn, borderColor: TH.warn } : {}),
                        onClick: () => setMode(mode === 'organize' ? 'read' : 'organize'),
                        title: '整理模式下每行右边出现删除键',
                      },
                      mode === 'organize' ? '✓ 整理中' : '整理',
                    ),
                    // 撤销以前只长在 5 秒就消失的提示条里 —— 想用的时候早没了。
                    h(
                      'button',
                      {
                        type: 'button',
                        style: sb(),
                        onClick: () => {
                          if (!guardDirty()) return
                          undo()
                        },
                        title: '把文件退回上一次保存之前（也会过版本关）',
                      },
                      '↶ 撤销',
                    ),
                    h('span', { style: { flex: 1 } }),
                    h(
                      'span',
                      { style: { fontSize: 10.5, color: TH.fg2 } },
                      data ? `${sections.length} 节 · 约 ${fmtTok(data.tokens)} tok` : '',
                    ),
                  ),
                  data && data.exists === false
                    ? h(
                        'div',
                        {
                          style: {
                            fontSize: 11.5,
                            color: TH.fg2,
                            lineHeight: 1.8,
                            margin: '0 0 12px',
                          },
                        },
                        '这个文件还不存在 —— 点「建立文件」写一个标题，或者直接从左边加章节。',
                      )
                    : null,
                  data && data.exists !== false && !String(data.content || '').trim()
                    ? h(
                        'div',
                        { style: { fontSize: 11.5, color: TH.fg2, lineHeight: 1.8, margin: '0 0 12px' } },
                        '这个文件是空的 —— 从左边「+ 章节」加第一节，或者点「✎ 编辑本节」直接写。',
                      )
                    : null,
                  curSec
                    ? h(
                        'h3',
                        { style: { fontSize: 16, fontWeight: 600, margin: '2px 0 10px' } },
                        curSec.title,
                      )
                    : null,
                  ...renderMd(bodyText, bodyBase, mode === 'organize' ? delLine : null),
                ),
          ),
        ),
      )
    }

    function TreePanel({ onClose, look, setLook, startLook }) {
      try {
        const { tree, err, loading, reload } = useTree(true)
        const [lookOpen, setLookOpen] = React.useState(Boolean(startLook))
        const [openDoc, setOpenDoc] = React.useState(null)
        const setLookNow = setLook || (() => {})
        const cur = look || LOOK_DEFAULT
        // DocView 里「还有没保存的修改」这个判断，交给遮罩点击时问一句，
        // 否则点一下就整页关掉、草稿没了。
        const guardRef = React.useRef(null)
        const setGuard = React.useCallback((fn) => {
          guardRef.current = fn
        }, [])

        return h(
          'div',
          {
            style: PANEL.overlay,
            onClick: (e) => {
              if (e.target !== e.currentTarget) return
              if (guardRef.current && !guardRef.current()) return
              onClose()
            },
          },
          h(
            'div',
            { style: PANEL.box },
            openDoc
              ? h(DocView, {
                  stem: openDoc.stem,
                  startLine: openDoc.line,
                  onGuard: setGuard,
                  onBack: () => {
                    setOpenDoc(null)
                    reload()
                  },
                  onChanged: reload,
                })
              : h(AtlasView, {
                  tree,
                  err,
                  loading,
                  reload,
                  onOpen: (stem, line) => setOpenDoc({ stem, line: line || 0 }),
                  lookOpen,
                  setLookOpen,
                  cur,
                  setLookNow,
                  onClose,
                }),
          ),
        )
      } catch {
        return null
      }
    }
    // 浮层入口：小圆片，点开树面板。
    // 为什么放 shell.overlay 而不是 sidebar.panellist ——
    //   sidebar.panellist 的约定是「每个 id 对应一个主面板」，侧栏自己画按钮、
    //   组件只接收 { size, active } 当图标；在那注册会要求同时注册一个主面板。
    //   shell.overlay 已验证可用（便利贴就在这），叠一张自己的浮层最稳。
    function TreeEntry() {
      try {
        const [open, setOpen] = React.useState(false)
        const [wantLook, setWantLook] = React.useState(false)
        const [look, setLook] = useLook()
        const drag = useDrag('tree', look, setLook)
        const chipsOn = useChipsOn()
        if (!chipsOn) return null

        const pos = drag.live || (look.pos && look.pos.tree) || null
        const shell = Object.assign(
          { display: 'flex', flexDirection: 'column', gap: 8 },
          boxStyle(look, 'tree', null, pos),
        )

        return h(
          React.Fragment,
          null,
          h(
            'div',
            { style: shell },
            h(
              'button',
              Object.assign(
                {
                  type: 'button',
                  ref: drag.ref,
                  style: chipLook(look),
                  title: '记忆库（拖动可移动，右键调外观）',
                  onClick: () => {
                    if (drag.consumeSkip()) return
                    setWantLook(false)
                    setOpen(true)
                  },
                  onContextMenu: (e) => {
                    e.preventDefault()
                    if (drag.consumeSkip()) return
                    setWantLook(true)
                    setOpen(true)
                  },
                },
                drag.handlers,
              ),
              h('span', null, '🗂'),
              look.shape === 'circle' ? null : h('span', null, '记忆库'),
            ),
          ),
          open
            ? h(TreePanel, {
                onClose: () => {
                  setOpen(false)
                  setWantLook(false)
                },
                look,
                setLook,
                startLook: wantLook,
              })
            : null,
        )
      } catch {
        return null
      }
    }

    // ── 「记忆」标签页（座位 conversation.view）──────────────
    //
    // 会话顶部那排标签页就是 conversation.view。注册字段：id / order / label，
    // 再加一个 inject(sessionId) —— 它的返回值会作为 props 交给组件，
    // 组件自己占满整个 viewArea。
    //
    // 数据全部来自 host 的 /almost-for-ever/stats，每 4 秒拉一次。
    // 拉不到就显示「未连接」，全程不 throw（座位里 throw = 整页空白）。

    const V = {
      page: {
        padding: '18px 20px 48px',
        maxWidth: 1000,
        margin: '0 auto',
        minHeight: '100%',
        color: TH.fg,
        fontSize: 13,
        lineHeight: 1.6,
        boxSizing: 'border-box',
      },
      card: {
        background: TH.bg1,
        border: `1px solid ${TH.border}`,
        borderRadius: 12,
        padding: '14px 16px',
      },
      label: { fontSize: 11, color: TH.fg2, letterSpacing: 0.3 },
      value: { fontSize: 20, fontWeight: 600, lineHeight: 1.25, marginTop: 2 },
      sectionTitle: {
        fontSize: 11,
        fontWeight: 600,
        color: TH.fg2,
        letterSpacing: 1,
        margin: '22px 0 10px',
      },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))',
        gap: 10,
      },
      btn: {
        height: 28,
        minWidth: 28,
        padding: '0 8px',
        borderRadius: 8,
        border: `1px solid ${TH.border2}`,
        background: TH.bg,
        color: TH.fg,
        cursor: 'pointer',
        fontSize: 14,
        lineHeight: 1,
      },
    }

    const agoText = (at) => {
      if (!at) return '—'
      const s = Math.max(0, Math.round((Date.now() - at) / 1000))
      if (s < 60) return `${s} 秒前`
      const m = Math.round(s / 60)
      if (m < 60) return `${m} 分钟前`
      const hh = Math.round(m / 60)
      if (hh < 24) return `${hh} 小时前`
      return `${Math.round(hh / 24)} 天前`
    }

    const durText = (ms) => {
      const m = Math.floor((ms || 0) / 60000)
      if (m < 60) return `${m} 分钟`
      const hh = Math.floor(m / 60)
      return `${hh} 小时 ${m % 60} 分`
    }

    // 插件标识：一张带三行字的卡片 —— 跟 icon.svg 同一套形状。
    function Mark({ size = 30 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          style: { flexShrink: 0 },
        },
        h('rect', {
          x: 3.2,
          y: 4.2,
          width: 17.6,
          height: 15.6,
          rx: 3,
          stroke: TH.brand,
          strokeWidth: 1.6,
        }),
        h('path', {
          d: 'M7.4 9.2h9.2M7.4 12.4h9.2M7.4 15.6h5.4',
          stroke: TH.brand,
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          opacity: 0.8,
        }),
      )
    }

    function StatCard({ label, value, hint, tone }) {
      return h(
        'div',
        { style: V.card },
        h('div', { style: V.label }, label),
        h(
          'div',
          { style: Object.assign({}, V.value, tone ? { color: tone } : null) },
          value,
        ),
        hint ? h('div', { style: { fontSize: 11, color: TH.fg2 } }, hint) : null,
      )
    }

    function Progress({ done, total }) {
      const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
      return h(
        'div',
        {
          style: {
            height: 6,
            borderRadius: 999,
            background: TH.bg2,
            overflow: 'hidden',
            marginTop: 8,
          },
        },
        h('div', {
          style: {
            width: `${pct}%`,
            height: '100%',
            background: TH.brand,
            borderRadius: 999,
            transition: 'width 0.2s',
          },
        }),
      )
    }

    function LibBar({ item, max }) {
      const pct = max > 0 ? Math.max(2, Math.round((item.tokens / max) * 100)) : 0
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '2px 0' } },
        h(
          'div',
          {
            title: item.stem,
            style: {
              width: 148,
              flexShrink: 0,
              fontSize: 12,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          item.label || item.stem,
        ),
        h(
          'div',
          {
            style: {
              flex: 1,
              height: 8,
              background: TH.bg2,
              borderRadius: 999,
              overflow: 'hidden',
            },
          },
          h('div', {
            style: {
              width: `${pct}%`,
              height: '100%',
              background: TH.brand,
              opacity: 0.72,
              borderRadius: 999,
            },
          }),
        ),
        h(
          'div',
          { style: { width: 52, textAlign: 'right', fontSize: 11, color: TH.fg2 } },
          fmtTok(item.tokens),
        ),
      )
    }

    function Toggle({ label, hint, value, onChange, disabled }) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '9px 0',
            borderBottom: `1px solid ${TH.border}`,
          },
        },
        h(
          'div',
          null,
          h('div', { style: { fontSize: 13 } }, label),
          hint ? h('div', { style: { fontSize: 11, color: TH.fg2 } }, hint) : null,
        ),
        h(
          'button',
          {
            type: 'button',
            disabled: Boolean(disabled),
            onClick: () => onChange(!value),
            title: value ? '点一下关掉' : '点一下打开',
            style: {
              flexShrink: 0,
              width: 44,
              height: 24,
              borderRadius: 999,
              border: 'none',
              position: 'relative',
              cursor: disabled ? 'default' : 'pointer',
              background: value ? TH.brand : TH.bg2,
              opacity: disabled ? 0.55 : 1,
              transition: 'background 0.15s',
            },
          },
          h('span', {
            style: {
              position: 'absolute',
              top: 3,
              left: value ? 23 : 3,
              width: 18,
              height: 18,
              borderRadius: 999,
              background: '#fff',
              boxShadow: '0 1px 3px rgba(0,0,0,0.28)',
              transition: 'left 0.15s',
            },
          }),
        ),
      )
    }

    function Stepper({ label, hint, value, min, max, onChange, disabled }) {
      const step = (d) => {
        const next = Math.min(max, Math.max(min, (Number(value) || min) + d))
        if (next !== value) onChange(next)
      }
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '9px 0',
            borderBottom: `1px solid ${TH.border}`,
          },
        },
        h(
          'div',
          null,
          h('div', { style: { fontSize: 13 } }, label),
          hint ? h('div', { style: { fontSize: 11, color: TH.fg2 } }, hint) : null,
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 } },
          h(
            'button',
            Object.assign(
              {
                type: 'button',
                disabled: Boolean(disabled) || value <= min,
                onClick: () => step(-1),
              },
              { style: Object.assign({}, V.btn, { opacity: value <= min ? 0.45 : 1 }) },
            ),
            '−',
          ),
          h(
            'div',
            {
              style: {
                minWidth: 38,
                textAlign: 'center',
                fontSize: 15,
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
              },
            },
            String(value),
          ),
          h(
            'button',
            Object.assign(
              {
                type: 'button',
                disabled: Boolean(disabled) || value >= max,
                onClick: () => step(1),
              },
              { style: Object.assign({}, V.btn, { opacity: value >= max ? 0.45 : 1 }) },
            ),
            '+',
          ),
        ),
      )
    }

    /** 设置区（标签页和「设置」页共用同一个组件，只是外面包不包卡片）。 */
    function SettingsBlock({ settings, intervalUnit, onPatch, busy }) {
      if (!settings) return null
      const unit = intervalUnit === 'tokens' ? 'token' : '轮'
      return h(
        'div',
        null,
        h(Stepper, {
          label: '自动审视间隔',
          hint:
            intervalUnit === 'tokens'
              ? '每累计这么多 token 让模型回头看一眼'
              : '每这么多轮让模型回头看一眼（改完立刻生效，但当前会话的计数不清零）',
          value: settings.intervalValue,
          min: 1,
          max: 50,
          disabled: busy,
          onChange: (v) => onPatch({ intervalValue: v }),
        }),
        h(Toggle, {
          label: '写入提醒',
          hint: '关掉后模型不会再收到「该审视一下」的提示，弹窗也不会出现',
          value: settings.writeEnabled !== false,
          disabled: busy,
          onChange: (v) => onPatch({ writeEnabled: v }),
        }),
        h(Toggle, {
          label: '浮层小圆片',
          hint: '右下角那两个（📌 待确认 / 🗂 记忆库）要不要显示；关掉后仍可从本页操作',
          value: settings.chips !== false,
          disabled: busy,
          onChange: (v) => onPatch({ chips: v }),
        }),
        h(Toggle, {
          label: '调试日志',
          hint: '把每个事件写进 ~/.dsh/almost-for-ever/debug.log（排查用）',
          value: settings.debug === true,
          disabled: busy,
          onChange: (v) => onPatch({ debug: v }),
        }),
        h(
          'div',
          { style: { fontSize: 11, color: TH.fg2, marginTop: 10 } },
          `单位：每 ${settings.intervalValue} ${unit}。重启 DSH 后计数从 0 开始，前 ${settings.intervalValue} 轮不会自动提醒。`,
        ),
      )
    }

    const EV_NAME = {
      nudge: '安排审视',
      injected: '提醒进上下文',
      cue: '口令触发',
      propose: '提交候选',
      accept: '已确认',
      reject: '丢弃',
      hit: '记忆命中',
      revise: '说两句',
      settings: '改设置',
    }

    const EV_COLOR = {
      nudge: TH.brand,
      injected: TH.ok,
      cue: TH.warn,
      propose: TH.brand,
      accept: TH.ok,
      reject: TH.fg2,
      hit: TH.brand,
      revise: TH.warn,
      settings: TH.fg2,
    }

    /** 会话标签页本体。props.sessionId 由注册时的 inject(sessionId) 提供。 */
    function MemoryView(props) {
      const raw = props && props.sessionId
      const sessionId =
        typeof raw === 'string' ? raw : raw && typeof raw.id === 'string' ? raw.id : ''

      const [data, setData] = React.useState(null)
      const [offline, setOffline] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const pageRef = React.useRef(null)

      // 占住正文：收起输入框（保留审批 / 提问 / 方案卡），并把滚动位置归零 ——
      // 否则从「对话」切过来时沿用的是聊天页停在底部的滚动位置，一进来就看见半截。
      React.useLayoutEffect(() => {
        ensureSurfaceStyle()
        const node = pageRef.current
        const scroll = node ? node.closest('[data-conversation-scroll]') : null
        if (!scroll) return undefined
        scroll.setAttribute(SURFACE_ATTR, '')
        scroll.scrollTop = 0
        return () => {
          scroll.removeAttribute(SURFACE_ATTR)
        }
      }, [])

      const load = React.useCallback(async () => {
        try {
          const r = await fetch(
            `${API}/stats?session=${encodeURIComponent(sessionId)}`,
            { credentials: 'same-origin' },
          )
          if (!r.ok) throw new Error(String(r.status))
          const d = await r.json()
          if (d && d.ok) {
            setData(d)
            setOffline(false)
          } else {
            setOffline(true)
          }
        } catch {
          setOffline(true)
        }
      }, [sessionId])

      React.useEffect(() => {
        let alive = true
        const tick = () => {
          if (alive) load()
        }
        tick()
        const id = setInterval(tick, POLL_MS)
        return () => {
          alive = false
          clearInterval(id)
        }
      }, [load])

      const patch = React.useCallback(async (p) => {
        setBusy(true)
        try {
          const r = await fetch(`${API}/settings`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(p),
          })
          const d = await r.json().catch(() => ({}))
          if (d && d.settings) {
            setData((prev) =>
              prev
                ? Object.assign({}, prev, {
                    settings: d.settings,
                    interval: Object.assign({}, prev.interval, {
                      value: d.settings.intervalValue,
                    }),
                  })
                : prev,
            )
          }
        } catch {
          /* 静默 */
        } finally {
          setBusy(false)
        }
      }, [])

      const s = data && data.session
      const g = data && data.global
      const libs = (data && data.libs) || []
      const maxTok = libs.length ? libs[0].tokens : 0
      const topLibs = libs.slice(0, 10)
      const recent = (data && data.recent) || []
      const intervalValue = (data && data.interval && data.interval.value) || 0

      return h(
        'div',
        { style: V.page, ref: pageRef },
        // ① 标识
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 } },
          h(Mark, { size: 34 }),
          h(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            h(
              'div',
              { style: { fontSize: 17, fontWeight: 600, letterSpacing: 0.2 } },
              'Almost For Ever',
            ),
            h(
              'div',
              { style: { fontSize: 11, color: TH.fg2 } },
              '长期、可塑的记忆 —— 索引在运行时从你的记忆库派生，不预存',
            ),
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                color: offline ? TH.fg2 : TH.ok,
                flexShrink: 0,
              },
              title: offline ? '拉不到数据：DSH 可能刚重启，或插件没装上' : '运行中',
            },
            h('span', {
              style: {
                width: 7,
                height: 7,
                borderRadius: 999,
                background: offline ? TH.fg2 : TH.ok,
                display: 'inline-block',
              },
            }),
            offline ? '未连接' : '运行中',
          ),
        ),
        offline
          ? h(
              'div',
              {
                style: Object.assign({}, V.card, {
                  marginTop: 14,
                  borderColor: TH.border2,
                  fontSize: 12,
                  color: TH.fg2,
                }),
              },
              '拉不到运行数据。这个页面每 4 秒重试一次；如果一直这样，多半是 DSH 刚重启还没加载完插件，或者这个插件没装进当前 profile。',
            )
          : null,

        // ② 本会话
        h('div', { style: V.sectionTitle }, '本会话'),
        s
          ? h(
              React.Fragment,
              null,
              h(
                'div',
                { style: V.grid },
                h(StatCard, {
                  label: '轮次',
                  value: String(s.turns),
                  hint: `距下次自动审视 ${Math.max(0, intervalValue - (s.turns % Math.max(1, intervalValue)))} 轮`,
                }),
                h(StatCard, {
                  label: '提醒已注入',
                  value: String(s.injected),
                  hint: s.lastNudgeAt ? `最近 ${agoText(s.lastNudgeAt)}` : '还没注入过',
                  tone: s.injected > 0 ? TH.ok : null,
                }),
                h(StatCard, {
                  label: '记忆命中',
                  value: String(s.hits),
                  hint: s.hits ? `约 ${fmtTok(s.hitTokens)} tok 进过上下文` : '本会话还没命中',
                }),
                h(StatCard, {
                  label: '候选',
                  value: `${s.accepted} / ${s.added}`,
                  hint: `确认 / 提交（丢弃 ${s.rejected}）`,
                }),
              ),
              s.hitLibs && s.hitLibs.length
                ? h(
                    'div',
                    {
                      style: {
                        marginTop: 10,
                        fontSize: 11,
                        color: TH.fg2,
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 6,
                      },
                    },
                    h('span', null, '命中过：'),
                    ...s.hitLibs.map((it) =>
                      h(
                        'span',
                        {
                          key: it.stem,
                          style: {
                            border: `1px solid ${TH.border}`,
                            borderRadius: 999,
                            padding: '1px 8px',
                            color: TH.fg,
                          },
                        },
                        `${it.label || it.stem} ×${it.count}`,
                      ),
                    ),
                  )
                : null,
            )
          : h(
              'div',
              { style: Object.assign({}, V.card, { fontSize: 12, color: TH.fg2 }) },
              '本会话还没开始计数。每开一轮就 +1，攒够 ',
              String(intervalValue || 3),
              ' 轮后模型会自动回头看一眼。刚重启过 DSH 的话，计数从 0 开始。',
            ),

        // ③ 记忆库
        h(
          'div',
          { style: Object.assign({}, V.sectionTitle, { display: 'flex', justifyContent: 'space-between' }) },
          h('span', null, '记忆库'),
          h(
            'span',
            { style: { fontWeight: 400, letterSpacing: 0, color: TH.fg2 } },
            data ? `${libs.length} 个库 · 约 ${fmtTok(data.totalTokens)} tok` : '—',
          ),
        ),
        libs.length
          ? h(
              'div',
              { style: V.card },
              ...topLibs.map((it) => h(LibBar, { key: it.stem, item: it, max: maxTok })),
              libs.length > topLibs.length
                ? h(
                    'div',
                    { style: { fontSize: 11, color: TH.fg2, marginTop: 8 } },
                    `另有 ${libs.length - topLibs.length} 个库未列出（按体积排序，只显示前 ${topLibs.length} 个）`,
                  )
                : null,
            )
          : h(
              'div',
              { style: Object.assign({}, V.card, { fontSize: 12, color: TH.fg2 }) },
              EMPTY_HINT,
            ),

        // ④ 最近活动
        h('div', { style: V.sectionTitle }, '最近活动'),
        recent.length
          ? h(
              'div',
              { style: Object.assign({}, V.card, { padding: '8px 16px' }) },
              ...recent.slice(0, 14).map((it, i) =>
                h(
                  'div',
                  {
                    key: `${it.at}-${i}`,
                    style: {
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 10,
                      padding: '5px 0',
                      borderTop: i === 0 ? 'none' : `1px solid ${TH.border}`,
                      fontSize: 12,
                    },
                  },
                  h(
                    'span',
                    {
                      style: {
                        width: 84,
                        flexShrink: 0,
                        color: EV_COLOR[it.ev] || TH.fg2,
                        fontWeight: 600,
                      },
                    },
                    EV_NAME[it.ev] || it.ev,
                  ),
                  h(
                    'span',
                    {
                      style: {
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                      title: it.text,
                    },
                    it.text || '—',
                  ),
                  h(
                    'span',
                    { style: { flexShrink: 0, fontSize: 11, color: TH.fg2 } },
                    agoText(it.at),
                  ),
                ),
              ),
            )
          : h(
              'div',
              { style: Object.assign({}, V.card, { fontSize: 12, color: TH.fg2 }) },
              '这次启动以来还没有活动记录。',
            ),

        // ⑤ 本次运行
        g
          ? h(
              'div',
              { style: { marginTop: 18, fontSize: 11, color: TH.fg2, lineHeight: 1.9 } },
              `本次运行：${g.sessions} 个会话 · ${g.turns} 轮 · 提醒注入 ${g.injected} 次 · 命中 ${g.hits} 次 · 已确认 ${g.accepted} 条 · 待确认 ${g.queue} 条 · 已跑 ${durText(g.uptimeMs)}`,
            )
          : null,

        // ⑥ 设置
        h('div', { style: V.sectionTitle }, '设置'),
        h(
          'div',
          { style: V.card },
          h(SettingsBlock, {
            settings: data && data.settings,
            intervalUnit: data && data.interval && data.interval.unit,
            onPatch: patch,
            busy,
          }),
        ),
      )
    }

    /** DSH 设置里的「记忆」页：同一套控件，外面不套卡片。 */
    function SettingsSection() {
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const r = await fetch(`${API}/stats`, { credentials: 'same-origin' })
          if (!r.ok) return
          const d = await r.json()
          if (d && d.ok) setData(d)
        } catch {
          /* 静默 */
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = () => {
          if (alive) load()
        }
        tick()
        const id = setInterval(tick, POLL_MS * 3)
        return () => {
          alive = false
          clearInterval(id)
        }
      }, [load])

      const patch = React.useCallback(async (p) => {
        setBusy(true)
        try {
          const r = await fetch(`${API}/settings`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(p),
          })
          const d = await r.json().catch(() => ({}))
          if (d && d.settings) {
            setData((prev) =>
              prev
                ? Object.assign({}, prev, {
                    settings: d.settings,
                    interval: Object.assign({}, prev.interval, {
                      value: d.settings.intervalValue,
                    }),
                  })
                : prev,
            )
          }
        } catch {
          /* 静默 */
        } finally {
          setBusy(false)
        }
      }, [])

      return h(
        'div',
        { style: { padding: '4px 2px 12px', color: TH.fg, fontSize: 13, lineHeight: 1.6 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 } },
          h(Mark, { size: 26 }),
          h(
            'div',
            null,
            h('div', { style: { fontSize: 14, fontWeight: 600 } }, 'Almost For Ever'),
            h(
              'div',
              { style: { fontSize: 11, color: TH.fg2 } },
              data
                ? `${(data.libs || []).length} 个记忆库 · 约 ${fmtTok(data.totalTokens)} tok`
                : '正在读取…',
            ),
          ),
        ),
        h(SettingsBlock, {
          settings: data && data.settings,
          intervalUnit: data && data.interval && data.interval.unit,
          onPatch: patch,
          busy,
        }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 会话标签页：「记忆」
        try {
          ctx.slots.inject('conversation.view', () =>
            ctx.slots.register(
              {
                name: 'conversation.view',
                id: 'memory',
                order: 40,
                label: () => '记忆',
                // inject 的返回值会作为 props 交给组件 —— 这里是这个会话的 id，
                // 组件拿它去查「这个对话的运行情况」。
                inject: (sessionId) => ({ sessionId }),
              },
              MemoryView,
            ),
          )
        } catch {
          /* 座位未声明时静默 */
        }
        // DSH 设置里的「记忆」页
        try {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'almost-for-ever', order: 120, label: () => '记忆' },
              SettingsSection,
            ),
          )
        } catch {
          /* 同上 */
        }
        try {
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              { name: 'shell.overlay', id: 'almost-for-ever-note', order: 60 },
              StickyNote,
            ),
          )
        } catch {
          /* 座位未声明时静默 */
        }
        try {
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              { name: 'shell.overlay', id: 'almost-for-ever-tree', order: 59 },
              TreeEntry,
            ),
          )
        } catch {
          /* 同上 */
        }
      },
    }
  },
})
