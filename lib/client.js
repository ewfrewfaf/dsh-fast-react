/**
 * dsh-fast-react · CLIENT half — 「快速反应」官方应用级页面。
 *
 * 挂载面（与「插件 / 技能 / 自动化任务」完全一致，走官方 slots 服务）：
 *   1. sidebar.panellist 列表里的一行（应用级导航），order 15；
 *   2. layout 的 main 槽（keyed by 同一个 id）——点导航行就把中间列换成这页。
 *
 * 页面内容是 /fr：由 dsh-fast-react 本体提供的整页控制台（前后台相位、state、
 * 步骤、心跳、T3、最近事件）。这里不重复实现任何控制台逻辑，只负责把它放进官方壳子。
 *
 * 格式：client-modules 协议 —— 经典脚本，通过 window.__ModuleLoader__.load 注册工厂；
 * 工厂拿到 require，返回插件导出（apply/inject）。无 JSX。
 */

window.__ModuleLoader__.load({
  // ★ 必须等于包名：client-modules 用包名派生 graph row id，
  //   注册 id 不一致会被判定「这一行没注册成功」→ 再执行一次 → duplicate factory。
  id: 'dsh-fast-react',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'fast-react'
    const PANEL_ORDER = 15

    /** 导航行图标：闪电（快速反应）。 */
    function FastReactIcon (props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          'data-dsh-panel-entry': PANEL_ID,
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.5',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M9 1.5 3.5 9h3.2L7 14.5 12.5 7H9.3z' }),
      )
    }

    /** 整页 occupant：把 /fr 嵌进主列。 */
    function FastReactPage () {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            height: '100%',
            minHeight: 0,
            background: 'transparent',
          },
        },
        h('iframe', {
          src: '/fr',
          title: '快速反应控制台',
          style: {
            flex: '1 1 auto',
            width: '100%',
            height: '100%',
            minHeight: 0,
            border: '0',
            display: 'block',
            background: 'transparent',
          },
        }),
      )
    }

    function apply (ctx) {
      const disposeRow = ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: '快速反应',
          },
          FastReactIcon,
        ),
      )

      const disposePage = ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, FastReactPage),
      )

      ctx.effect(() => () => {
        disposePage()
        disposeRow()
      })

      try {
        console.log('[fast-react-ui] client: 导航行 + 页面已注册（order ' + PANEL_ORDER + '）')
      } catch { /* 忽略 */ }
    }

    return {
      name: 'dsh-fast-react-ui',
      inject: ['slots'],
      apply,
    }
  },
})
