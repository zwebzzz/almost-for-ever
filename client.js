// Almost For Ever — 客户端半
//
// 两个座位（都在 shell.overlay 里，默认右下角）：
//   ① 📌 待确认  —— 有候选时出现，点开是便利贴
//   ② 🗂 记忆库  —— 一直存在，点开是结构面板
// 两者都能拖动；形状 / 颜色 / 大小在「🗂 记忆库」面板的 ⚙ 外观里调，
// 存在 localStorage（界面偏好，不进 memory/，不走接口）。
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
      { id: 'blue', name: '海蓝', bg: 'rgba(23,105,214,0.14)', fg: '#0f5fcc', bd: 'rgba(23,105,214,0.55)' },
      { id: 'violet', name: '雾紫', bg: 'rgba(112,72,196,0.15)', fg: '#6b45c2', bd: 'rgba(112,72,196,0.55)' },
      { id: 'green', name: '苔绿', bg: 'rgba(24,122,78,0.15)', fg: '#17784c', bd: 'rgba(24,122,78,0.55)' },
      { id: 'amber', name: '琥珀', bg: 'rgba(172,102,10,0.16)', fg: '#a5620a', bd: 'rgba(172,102,10,0.55)' },
      { id: 'rose', name: '玫红', bg: 'rgba(178,40,88,0.14)', fg: '#ad2757', bd: 'rgba(178,40,88,0.55)' },
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

      return { items, targets, choices, setChoices, open, setOpen, busy, error, act, dismissAll }
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
        const { items, targets, choices, setChoices, open, setOpen, busy, error, act, dismissAll } =
          useCandidates()
        const [look, setLook] = useLook()
        const drag = useDrag('note', look, setLook)
        if (items.length === 0) return null

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
                h(
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
                ),
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

    function TreePanel({ onClose, look, setLook, startLook }) {
      try {
        const { tree, err, loading, reload } = useTree(true)
        const [expanded, setExpanded] = React.useState({})
        const [query, setQuery] = React.useState('')
        const [lookOpen, setLookOpen] = React.useState(Boolean(startLook))
        const setLookNow = setLook || (() => {})
        const cur = look || LOOK_DEFAULT

        const libs = (tree && tree.libs) || []
        const filtered = query
          ? libs.filter(
              (l) =>
                l.stem.includes(query) ||
                l.label.includes(query) ||
                l.sections.some((s) => s.title.includes(query)),
            )
          : libs

        const total = tree ? tree.totalTokens : 0
        const biggest = libs.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 5)

        return h(
          'div',
          {
            style: {
              position: 'fixed',
              inset: 0,
              zIndex: 80,
              background: 'rgba(0,0,0,0.35)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            },
            onClick: (e) => {
              if (e.target === e.currentTarget) onClose()
            },
          },
          h(
            'div',
            {
              style: {
                width: 'min(720px, 92vw)',
                maxHeight: '82vh',
                display: 'flex',
                flexDirection: 'column',
                background: TH.bg,
                color: TH.fg,
                border: `1px solid ${TH.border}`,
                borderRadius: 14,
                boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
                overflow: 'hidden',
              },
            },
            // 头部
            h(
              'div',
              {
                style: {
                  padding: '12px 16px',
                  borderBottom: `1px solid ${TH.border}`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                },
              },
              h('strong', { style: { fontSize: 14, flex: 1 } }, '记忆库结构'),
              h(
                'span',
                { style: { color: TH.fg2, fontSize: 11 } },
                tree ? `${libs.length} 个库 · 约 ${fmtTok(total)} tok` : '',
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: btn('no'),
                  onClick: () => setLookOpen((v) => !v),
                  title: '浮层的形状 / 颜色 / 大小（拖动圆片可移动位置）',
                },
                lookOpen ? '⚙ 外观' : '⚙',
              ),
              h(
                'input',
                {
                  value: query,
                  placeholder: '筛选库 / 章节',
                  onChange: (e) => setQuery(e.target.value),
                  style: {
                    width: 150,
                    background: TH.bg2,
                    color: TH.fg,
                    border: `1px solid ${TH.border2}`,
                    borderRadius: 6,
                    padding: '3px 8px',
                    fontSize: 11,
                  },
                },
              ),
              h(
                'button',
                { type: 'button', style: btn('no'), onClick: reload },
                loading ? '…' : '刷新',
              ),
              h('button', { type: 'button', style: btn('no'), onClick: onClose }, '关闭'),
            ),
            // 概览条
            h(
              'div',
              {
                style: {
                  padding: '8px 16px',
                  borderBottom: `1px solid ${TH.border}`,
                  color: TH.fg2,
                  fontSize: 11,
                  display: 'flex',
                  gap: 14,
                  flexWrap: 'wrap',
                },
              },
              ...biggest.map((l) =>
                h('span', { key: l.stem }, `${l.label} ${fmtTok(l.tokens)}`),
              ),
            ),
            // 外观（形状 / 颜色 / 大小 / 位置）
            lookOpen
              ? h(
                  'div',
                  {
                    style: {
                      padding: '8px 16px 10px',
                      borderBottom: '1px solid ' + TH.border,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      background: TH.bg1,
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
                          border:
                            cur.color === p.id
                              ? '2px solid ' + TH.fg
                              : '1px solid ' + TH.border2,
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
                          style: Object.assign({}, btn('no'), {
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
                          style: Object.assign({}, btn('no'), {
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
                      {
                        type: 'button',
                        style: btn('no'),
                        onClick: () => setLookNow({ pos: {} }),
                      },
                      '复位到右下角',
                    ),
                    h(
                      'span',
                      { style: { color: TH.fg2, fontSize: 11 } },
                      '按住圆片拖即可移动，位置会记住；右键圆片可直接打开这里。',
                    ),
                  ),
                )
              : null,
            err
              ? h(
                  'div',
                  { style: { padding: '8px 16px', color: TH.warn, fontSize: 11 } },
                  err,
                )
              : null,
            // 列表
            h(
              'div',
              { style: { overflowY: 'auto', padding: '8px 12px 16px' } },
              // 空态：没有记忆库时给一句话，别让面板一片空白
              libs.length === 0
                ? h(
                    'div',
                    {
                      style: {
                        padding: '28px 8px',
                        textAlign: 'center',
                        color: TH.fg2,
                        fontSize: 12,
                        lineHeight: 1.8,
                      },
                    },
                    h('div', { style: { fontSize: 24, marginBottom: 8 } }, '🗂'),
                    h('div', null, '还没有找到任何记忆库。'),
                    h('div', null, '可以一键生成一套起手模板，也可以自己放 markdown 文件进来。'),
                    h(StarterButtons, { onDone: reload }),
                  )
                : null,
              ...filtered.map((lib) => {
                const open2 = expanded[lib.stem]
                return h(
                  'div',
                  { key: lib.stem, style: { marginBottom: 6 } },
                  h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        cursor: 'pointer',
                        padding: '5px 6px',
                        borderRadius: 6,
                        background: open2 ? TH.bg1 : 'transparent',
                      },
                      onClick: () =>
                        setExpanded((prev) => ({ ...prev, [lib.stem]: !prev[lib.stem] })),
                    },
                    h('span', { style: { width: 10, color: TH.fg2 } }, open2 ? '▾' : '▸'),
                    h('span', { style: { fontSize: 12, fontWeight: 600 } }, lib.label),
                    h(
                      'span',
                      { style: { color: TH.fg2, fontSize: 10, fontFamily: 'monospace' } },
                      lib.stem,
                    ),
                    lib.tags.length
                      ? h(
                          'span',
                          { style: { color: TH.brand, fontSize: 10 } },
                          lib.tags.join(' · '),
                        )
                      : null,
                    h('span', { style: { flex: 1 } }),
                    h(
                      'span',
                      { style: { color: TH.fg2, fontSize: 11 } },
                      `${lib.sections.length} 节 · ${fmtTok(lib.tokens)} tok`,
                    ),
                  ),
                  open2
                    ? h(
                        'div',
                        { style: { paddingLeft: 22, paddingTop: 4 } },
                        ...lib.sections.map((s, i) =>
                          h(
                            'div',
                            {
                              key: i,
                              style: {
                                display: 'flex',
                                gap: 8,
                                fontSize: 11,
                                padding: '2px 0',
                                opacity: s.meta ? 0.55 : 1,
                              },
                            },
                            h(
                              'span',
                              {
                                style: {
                                  color: TH.fg2,
                                  fontFamily: 'monospace',
                                  minWidth: 62,
                                },
                                title: '行号区间',
                              },
                              `${s.line}-${s.endLine}`,
                            ),
                            h(
                              'span',
                              { style: { minWidth: 46, color: TH.fg2 } },
                              fmtTok(s.tokens),
                            ),
                            h('span', { style: { flex: 1 } }, s.title),
                            s.entries > 0
                              ? h(
                                  'span',
                                  { style: { color: TH.fg2, fontSize: 10 } },
                                  `${s.entries} 条`,
                                )
                              : null,
                            s.tags.length
                              ? h(
                                  'span',
                                  { style: { color: TH.brand, fontSize: 10 } },
                                  s.tags.slice(0, 3).join('/'),
                                )
                              : null,
                          ),
                        ),
                      )
                    : null,
                )
              }),
            ),
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
                  title: '记忆库结构（拖动可移动，右键调外观）',
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

    return {
      inject: ['slots'],
      apply(ctx) {
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
