/**
 * openai-codex-image — browser half（DSH 设置页）。
 *
 * 在「设置」里贡献一个 ChatGPT 生图页面：
 *   - 显示授权来源、账号、订阅档位、Access Token 到期时间；
 *   - 设备码授权全流程（开始 → 打开网页输代码 → 确认）；
 *   - 退出插件内授权；
 *   - 显示当前生图默认参数（模型 / 尺寸 / 输出目录）。
 *
 * 数据走宿主插件自己的同源路由 /api/openai-codex-image/*（见 index.js），
 * 不返回任何 token。手写 ModuleLoader 包：只依赖宿主的 react 与 locale，
 * 无构建步骤；颜色全部取主题变量。
 */

window.__ModuleLoader__.load({
  id: 'openai-codex-image',
  factory: require => {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const NS = 'settings.openaiCodexImage'
    const inject = ['slots', 'locale']

    const API = (() => {
      try {
        return new URL('api/openai-codex-image', document.baseURI).pathname
      } catch {
        return '/api/openai-codex-image'
      }
    })()

    /** 同源 JSON 请求：15 秒超时，错误统一转成可显示的文本。 */
    async function api(path, options) {
      const { timeout = 15000, ...rest } = options ?? {}
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...rest, redirect: 'error', signal: controller.signal })
        const text = await response.text()
        let payload
        try {
          payload = text === '' ? {} : JSON.parse(text)
        } catch {
          payload = { error: text.slice(0, 300) }
        }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const post = path => api(path, { method: 'POST' })

    const CSS = `
.oai_root{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-size:13.5px;line-height:1.55}
.oai_hero{display:flex;flex-direction:column;gap:6px;padding:18px 20px;border-radius:16px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 6%,transparent)}
.oai_hero h2{margin:0;font-size:19px;font-weight:700;letter-spacing:-.2px}
.oai_sub{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.oai_actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}
.oai_btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:7px 14px;border-radius:10px;cursor:pointer;transition:background .15s ease,border-color .15s ease}
.oai_btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent)}
.oai_btn.primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff;font-weight:600}
.oai_btn.primary:hover:not(:disabled){filter:brightness(1.06)}
.oai_btn:disabled{opacity:.55;cursor:default}
.oai_card{display:flex;flex-direction:column;gap:10px;padding:16px 18px;border-radius:16px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,transparent)}
.oai_card h3{margin:0;font-size:14px;font-weight:650}
.oai_cardhead{display:flex;align-items:center;justify-content:space-between;gap:10px}
.oai_badge{font-size:11.5px;font-weight:600;padding:2px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.oai_badge.ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.oai_rows{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px 18px}
.oai_row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px dashed color-mix(in srgb,var(--dsw-alias-border-l1) 80%,transparent)}
.oai_label{color:var(--dsw-alias-label-secondary);font-size:12.5px}
.oai_value{font-variant-numeric:tabular-nums;text-align:right;word-break:break-all}
.oai_muted{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.oai_hint{font-size:12px;opacity:.85}
.oai_error{padding:10px 14px;border-radius:12px;font-size:12.5px;color:var(--dsw-alias-state-danger-primary);border:1px solid color-mix(in srgb,var(--dsw-alias-state-danger-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-danger-primary) 8%,transparent);white-space:pre-wrap;word-break:break-word}
.oai_login{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,transparent)}
.oai_link{color:var(--dsw-alias-state-business-primary);word-break:break-all}
.oai_code{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);border:1px dashed var(--dsw-alias-border-l2)}
.oai_code span{color:var(--dsw-alias-label-secondary);font-size:12px}
.oai_code code{font-size:22px;font-weight:700;letter-spacing:2px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;user-select:all}
`

    const DICT = {
      zh: {
        nav: 'ChatGPT 生图',
        title: 'ChatGPT 生图',
        subtitle: '用 ChatGPT 账号（Codex OAuth）授权，消耗订阅额度生成图片，不走付费 API Key。',
        statusTitle: '授权状态',
        authorized: '已授权',
        unauthorized: '未授权',
        loading: '正在读取授权状态…',
        source: '授权来源',
        sourcePlugin: '插件内授权',
        sourceCodex: '本机 Codex CLI（只读复用）',
        account: '账号',
        plan: '订阅档位',
        expires: 'Access Token 到期',
        start: '开始授权',
        reauth: '重新授权',
        logout: '退出授权',
        unauthorizedHint: '还没有可用的 ChatGPT 授权。点「开始授权」，按提示在浏览器完成一次登录即可。',
        loginTitle: '浏览器授权',
        loginIntro: '在浏览器打开下面的地址，输入代码并完成 ChatGPT 登录：',
        codeLabel: '代码',
        loginPending: '登录完成后回到这里点下面的确认按钮。代码约 15 分钟内有效。',
        pollButton: '我已登录，确认授权',
        polling: '正在确认…',
        defaultsTitle: '生图默认参数',
        imageModel: '生图模型',
        hostModel: '宿主模型',
        defaultSize: '默认尺寸',
        outputDir: '输出目录',
        configHint: '这些值来自插件配置（cordis.patch.yml），改配置后重启 DSH 生效。',
        loadFailed: '无法连接插件后端',
      },
      en: {
        nav: 'ChatGPT Image',
        title: 'ChatGPT Image',
        subtitle:
          'Sign in with a ChatGPT account (Codex OAuth) and generate images with the subscription quota instead of a paid API key.',
        statusTitle: 'Authorization',
        authorized: 'Authorized',
        unauthorized: 'Not authorized',
        loading: 'Reading authorization state…',
        source: 'Source',
        sourcePlugin: 'Plugin credential',
        sourceCodex: 'Local Codex CLI (read-only)',
        account: 'Account',
        plan: 'Plan',
        expires: 'Access token expires',
        start: 'Start authorization',
        reauth: 'Authorize again',
        logout: 'Sign out',
        unauthorizedHint:
          'No ChatGPT authorization yet. Click “Start authorization” and finish one browser login with the code shown.',
        loginTitle: 'Browser authorization',
        loginIntro: 'Open the address below in a browser, enter the code, and finish the ChatGPT login:',
        codeLabel: 'Code',
        loginPending: 'After the browser login, come back and press the confirm button. The code is valid for about 15 minutes.',
        pollButton: 'I have signed in — confirm',
        polling: 'Confirming…',
        defaultsTitle: 'Image defaults',
        imageModel: 'Image model',
        hostModel: 'Host model',
        defaultSize: 'Default size',
        outputDir: 'Output directory',
        configHint: 'These values come from the plugin config (cordis.patch.yml); restart DSH after changing them.',
        loadFailed: 'Cannot reach the plugin backend',
      },
    }

    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleString()
    }

    function Badge({ tone, children }) {
      return h('span', { className: `oai_badge${tone ? ` ${tone}` : ''}` }, children)
    }

    function Button({ primary, disabled, onClick, children }) {
      return h(
        'button',
        { type: 'button', className: `oai_btn${primary ? ' primary' : ''}`, disabled, onClick },
        children,
      )
    }

    function Row({ label, value }) {
      return h(
        'div',
        { className: 'oai_row' },
        h('span', { className: 'oai_label' }, label),
        h('span', { className: 'oai_value' }, value === undefined || value === null || value === '' ? '—' : value),
      )
    }

    function Section(props) {
      const t = props.t
      const [status, setStatus] = useState(undefined)
      const [error, setError] = useState('')
      const [login, setLogin] = useState(undefined)
      const [busy, setBusy] = useState(false)

      const reload = useCallback(() => {
        setError('')
        api('/status')
          .then(setStatus)
          .catch(err => setError(String(err?.message ?? err)))
      }, [])

      useEffect(() => {
        reload()
      }, [reload])

      const run = async action => {
        setBusy(true)
        setError('')
        try {
          await action()
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }

      const startLogin = () =>
        run(async () => {
          const payload = await post('/login/start')
          setLogin({ phase: 'awaiting', payload })
        })

      const pollLogin = () =>
        run(async () => {
          const payload = await post('/login/poll')
          if (payload?.status === 'pending') {
            setLogin(current => ({ ...current, phase: 'awaiting', payload }))
            return
          }
          setLogin(undefined)
          setStatus(payload)
        })

      const doLogout = () =>
        run(async () => {
          await post('/logout')
          setLogin(undefined)
          reload()
        })

      const authorized = status?.authorized === true
      const defaults = status ?? {}
      const actions = authorized
        ? [
            h(Button, { key: 'reauth', disabled: busy, onClick: startLogin }, t('reauth')),
            h(Button, { key: 'logout', disabled: busy, onClick: doLogout }, t('logout')),
          ]
        : h(Button, { key: 'start', primary: true, disabled: busy, onClick: startLogin }, t('start'))

      return h(
        'div',
        { className: 'oai_root' },
        h(
          'header',
          { className: 'oai_hero' },
          h('h2', null, t('title')),
          h('p', { className: 'oai_sub' }, t('subtitle')),
          h('div', { className: 'oai_actions' }, actions),
        ),
        error ? h('div', { className: 'oai_error' }, error) : null,
        h(
          'section',
          { className: 'oai_card' },
          h(
            'div',
            { className: 'oai_cardhead' },
            h('h3', null, t('statusTitle')),
            authorized
              ? h(Badge, { tone: 'ok' }, t('authorized'))
              : h(Badge, null, status === undefined ? t('loading') : t('unauthorized')),
          ),
          status === undefined
            ? h('p', { className: 'oai_muted' }, t('loading'))
            : authorized
              ? h(
                  'div',
                  { className: 'oai_rows' },
                  h(Row, {
                    label: t('source'),
                    value: status.source === 'dsh-credential' ? t('sourcePlugin') : t('sourceCodex'),
                  }),
                  h(Row, { label: t('account'), value: status.email || status.account_id }),
                  h(Row, { label: t('plan'), value: status.plan }),
                  h(Row, { label: t('expires'), value: formatTime(status.expires_at) }),
                )
              : h('p', { className: 'oai_muted' }, t('unauthorizedHint')),
        ),
        login?.payload
          ? h(
              'section',
              { className: 'oai_card oai_login' },
              h('h3', null, t('loginTitle')),
              h('p', { className: 'oai_muted' }, t('loginIntro')),
              h(
                'a',
                {
                  className: 'oai_link',
                  href: login.payload.verification_url,
                  target: '_blank',
                  rel: 'noreferrer noopener',
                },
                login.payload.verification_url,
              ),
              h(
                'div',
                { className: 'oai_code' },
                h('span', null, t('codeLabel')),
                h('code', null, login.payload.user_code ?? ''),
              ),
              h('p', { className: 'oai_muted' }, t('loginPending')),
              h(
                'div',
                { className: 'oai_actions' },
                h(Button, { primary: true, disabled: busy, onClick: pollLogin }, busy ? t('polling') : t('pollButton')),
              ),
            )
          : null,
        h(
          'section',
          { className: 'oai_card' },
          h('h3', null, t('defaultsTitle')),
          h(
            'div',
            { className: 'oai_rows' },
            h(Row, { label: t('imageModel'), value: defaults.image_model }),
            h(Row, { label: t('hostModel'), value: defaults.host_model }),
            h(Row, { label: t('defaultSize'), value: defaults.default_size }),
            h(Row, { label: t('outputDir'), value: defaults.output_dir }),
          ),
          h('p', { className: 'oai_muted oai_hint' }, t('configHint')),
        ),
      )
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'openai-codex-image: dictionaries')
      ctx.effect(
        () => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'openai-codex-image')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        },
        'openai-codex-image: styles',
      )
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'openai-codex-image',
            order: 40,
            label: () => t('nav'),
            locale: NS,
          },
          props => h(Section, { ...props, t, ctx }),
        ),
      )
    }

    return { apply, inject, name: 'openai-codex-image' }
  },
})
