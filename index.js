/**
 * openai-codex-image — ChatGPT（Codex OAuth）授权 + 生图插件（Host 半边）。
 *
 * 为什么存在：OpenAI 的 gpt-image-2 官方只走付费 API Key；已经订阅 ChatGPT
 * 的账号其实可以通过 Codex OAuth 凭据调用 chatgpt.com/backend-api/codex/responses
 * 的 image_generation 工具，消耗订阅额度而不是 API 额度。
 *
 * 这个插件做三件事：
 * 1. 解析可用授权：插件自己存进 DSH 凭据的 OAuth 记录优先，其次复用本机
 *    Codex CLI 的 ~/.codex/auth.json（只读，不改写，避免破坏 Codex 登录）。
 * 2. 提供 openai_account 工具：status / login_start / login_poll / logout，
 *    用 OpenAI 设备码流程完成独立授权，不再依赖 Codex CLI。
 * 3. 提供 generate_image 工具：调用 codex/responses 的 image_generation，
 *    把 PNG 落到工作区文件，并在当前模型支持图片输入时把图片内联回对话。
 *
 * 只使用 Node 内置模块和 ctx 上的服务，不 import 任何 @deepseek-ai/* 包：
 * 本插件作为本地目录 bundle 安装，裸包名不保证能解析到 DSH 安装目录。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Codex CLI 使用的 OAuth client（与 pi-ai / Codex CLI 一致）。 */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_ORIGIN = 'https://auth.openai.com'
const TOKEN_URL = `${AUTH_ORIGIN}/oauth/token`
const DEVICE_USERCODE_URL = `${AUTH_ORIGIN}/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_URL = `${AUTH_ORIGIN}/api/accounts/deviceauth/token`
const DEVICE_VERIFICATION_URL = 'https://auth.openai.com/codex/device'
const DEVICE_REDIRECT_URI = `${AUTH_ORIGIN}/deviceauth/callback`
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

/** 本插件在 DSH 凭据服务里的记录键：<scope>/<id>。 */
const CREDENTIAL_KEY = 'openai-image/chatgpt'

/** gpt-image-2 支持的尺寸。 */
const IMAGE_SIZES = [
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '2048x2048',
  '2048x1152',
  '3840x2160',
  '2160x3840',
]
const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high']

const DEFAULTS = {
  authFile: '~/.codex/auth.json',
  hostModel: 'gpt-6.1-sol',
  imageModel: 'gpt-image-2',
  defaultSize: '1024x1024',
  outputDir: 'generated_images',
  timeoutMs: 240_000,
}

export const name = 'openai-codex-image'
export const inject = ['tools']

/**
 * 插件入口：注册两个工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown> | undefined} config
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  /** 当前进程里正在等待用户完成的设备码授权。 */
  let pendingLogin
  const pending = {
    getPending: () => pendingLogin,
    setPending: (next) => {
      pendingLogin = next
    },
  }

  ctx.tools.register(createGenerateImageTool(ctx, cfg))
  ctx.tools.register(createAccountTool(ctx, cfg, pending))
  registerWebApi(ctx, cfg, pending)
  ctx.logger?.info?.('openai-codex-image v1.1.0: 已注册 generate_image、openai_account 与 Web API')
}

/**
 * 给插件自己的设置页（client.js）提供同源 JSON 路由。
 *
 * 只暴露状态与授权流程，从不返回 token：状态里账号 ID 已打码，email/档位是
 * 界面上要显示的信息。路由挂在 /api/openai-codex-image 前缀下；因为插件前缀
 * 比内核 `/api` 更长、会先命中，所以必须自己做与内核一致的信任校验。
 * @param ctx - 插件上下文
 * @param cfg - 归一化后的配置
 * @param pending - 设备码登录的共享状态（与 openai_account 工具共用）
 */
function registerWebApi(ctx, cfg, pending) {
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'prefix',
          path: '/api/openai-codex-image',
          handler: (req, res) => handleWebApi(ctx, cfg, pending, req, res),
        }),
      'openai-codex-image: /api routes',
    )
  })
}

async function handleWebApi(ctx, cfg, pending, req, res) {
  const send = (status, payload) => {
    if (res.headersSent) return
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }
  const rejection = rejectionFor(req, ctx.get('connection'))
  if (rejection !== undefined) {
    return send(rejection, {
      error: rejection === 401 ? 'unauthorized' : rejection === 503 ? 'admission unavailable' : 'forbidden',
    })
  }
  const suffix = (() => {
    try {
      return new URL(req.url ?? '/', 'http://localhost').pathname.slice('/api/openai-codex-image'.length) || '/'
    } catch {
      return '/'
    }
  })()
  try {
    if (suffix === '/status' && req.method === 'GET') return send(200, await accountStatus(ctx, cfg))
    if (suffix === '/login/start' && req.method === 'POST') return send(200, await loginStart(pending))
    if (suffix === '/login/poll' && req.method === 'POST') return send(200, await loginPoll(ctx, cfg, pending))
    if (suffix === '/logout' && req.method === 'POST') return send(200, await logout(ctx))
    if (['/status', '/login/start', '/login/poll', '/logout'].includes(suffix)) {
      return send(405, { error: `method ${req.method} is not allowed for ${suffix}` })
    }
    send(404, { error: 'not found' })
  } catch (error) {
    send(400, { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 与内核 `/api` 一致的信任校验：有 `connection` 服务时直接用它的判断
 * （浏览器 cookie / 本机信任）；没有时退回结构化检查，只允许本机同源请求。
 * @param req - Node 请求
 * @param connection - 可选的 connection 服务
 * @returns 拒绝状态码，或 undefined（放行）
 */
function rejectionFor(req, connection) {
  if (connection && typeof connection.requestRejection === 'function') {
    try {
      const status = connection.requestRejection({ headers: req.headers })
      return status === undefined ? undefined : status
    } catch {
      return 503
    }
  }
  return structuralRejection(req)
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

function structuralRejection(req) {
  const authority = parseAuthority(req.headers.host, 'http')
  if (!authority || !LOOPBACK_HOSTS.has(authority.hostname)) return 403
  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403
  for (const header of ['origin', 'referer']) {
    const raw = req.headers[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const source = parseAuthority(raw.trim())
    if (!source || source.hostname !== authority.hostname || source.port !== authority.port) return 403
  }
  return undefined
}

function parseAuthority(value, defaultScheme = 'http') {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const url = new URL(value.includes('://') ? value.trim() : `${defaultScheme}://${value.trim()}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
    return { hostname: url.hostname.toLowerCase(), port }
  } catch {
    return undefined
  }
}

/** 归一化配置，坏值回落到默认值。 */
function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const cfg = { ...DEFAULTS }
  if (typeof raw.authFile === 'string' && raw.authFile.trim()) cfg.authFile = raw.authFile.trim()
  if (typeof raw.hostModel === 'string' && raw.hostModel.trim()) cfg.hostModel = raw.hostModel.trim()
  if (typeof raw.imageModel === 'string' && raw.imageModel.trim()) cfg.imageModel = raw.imageModel.trim()
  if (typeof raw.defaultSize === 'string' && IMAGE_SIZES.includes(raw.defaultSize)) cfg.defaultSize = raw.defaultSize
  if (typeof raw.outputDir === 'string' && raw.outputDir.trim()) cfg.outputDir = raw.outputDir.trim()
  if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs >= 30_000) {
    cfg.timeoutMs = Math.min(Math.trunc(raw.timeoutMs), 600_000)
  }
  return cfg
}

// ---------------------------------------------------------------------------
// 工具：generate_image
// ---------------------------------------------------------------------------

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height'],
      properties: {
        width: { type: 'integer' },
        height: { type: 'integer' },
      },
    },
  },
}

function createGenerateImageTool(ctx, cfg) {
  return {
    name: 'generate_image',
    description:
      '用已授权的 ChatGPT 账号（Codex OAuth，消耗 ChatGPT 订阅额度）生成一张图片，保存为工作区里的 PNG 文件。' +
      '默认尺寸 1024x1024，默认模型 gpt-image-2。当前对话模型支持图片输入时，图片会内联显示；否则只返回文件路径。' +
      '未授权时先用 openai_account 工具完成授权，或在「设置 → ChatGPT 生图」页面里完成。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description: '画面描述。写得具体（主体、构图、风格、光线、背景）效果更好；支持中文。',
        },
        size: {
          type: 'string',
          enum: [...IMAGE_SIZES],
          description: '输出尺寸，默认取插件配置 defaultSize（1024x1024）。',
        },
        quality: {
          type: 'string',
          enum: [...IMAGE_QUALITIES],
          description: '生成质量，可选；不传则用服务端默认值。',
        },
        model: {
          type: 'string',
          description: '生图模型，默认 gpt-image-2。一般不用改。',
        },
        host_model: {
          type: 'string',
          description:
            '承载 image_generation 工具调用的对话模型，默认取插件配置 hostModel。只在默认模型对账号不可用时才需要改。',
        },
        output_dir: {
          type: 'string',
          description: '输出目录：相对会话工作目录，或绝对路径。默认取插件配置 outputDir（generated_images）。',
        },
        file_name: {
          type: 'string',
          description: '可选文件名（会自动补 .png，并去掉路径部分）。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'width', 'height', 'bytes', 'model', 'size'],
        properties: {
          path: { type: 'string', description: '图片的绝对路径。' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
          model: { type: 'string' },
          size: { type: 'string' },
          revised_prompt: { type: 'string' },
          image: IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => {
        const blocks = [
          {
            type: 'text',
            text:
              `<path>${value.path}</path>\n` +
              `<type>image</type>\n` +
              `<content>\n` +
              `${value.model} 生成，${value.size}，实际 ${value.width}x${value.height} px，${value.bytes} bytes` +
              `${value.revised_prompt ? `\n修订后的提示词：${value.revised_prompt}` : ''}` +
              `${value.image ? '' : '\n（当前模型不接受图片输入，图片只保存为文件，未内联显示）'}` +
              `\n</content>`,
          },
        ]
        if (value.image) blocks.push({ type: 'image', attachment: value.image })
        return blocks
      },
    },
    async execute(args, exec) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (!prompt) throw new Error('generate_image: prompt 不能为空')
      const size = args.size && IMAGE_SIZES.includes(args.size) ? args.size : cfg.defaultSize
      const model = args.model ?? cfg.imageModel
      const hostModel = args.host_model ?? cfg.hostModel
      const auth = await resolveAuth(ctx, cfg, exec.signal)
      const signal = combineSignals(exec.signal, cfg.timeoutMs)

      let result
      try {
        result = await requestImage(auth, { prompt, size, model, hostModel, quality: args.quality }, signal)
      } catch (error) {
        throw explainImageError(error)
      }

      const data = Buffer.from(result.b64, 'base64')
      const dims = pngSize(data) ?? parseSize(size)
      const base = await sessionWorkingDirectory(ctx, exec)
      const configuredDir = args.output_dir ?? cfg.outputDir
      const dir = isAbsolute(configuredDir) ? configuredDir : join(base, configuredDir)
      await mkdir(dir, { recursive: true })
      const file = uniqueFilePath(join(dir, imageFileName(args.file_name)))
      await writeFile(file, data)

      const attachment = await attachImage(ctx, exec, data, basename(file))
      return {
        path: file,
        width: attachment?.width ?? dims.width,
        height: attachment?.height ?? dims.height,
        bytes: data.byteLength,
        model,
        size,
        ...(result.revisedPrompt ? { revised_prompt: result.revisedPrompt } : {}),
        ...(attachment ? { image: attachment } : {}),
      }
    },
    presentCall(args) {
      const prompt = typeof args.prompt === 'string' ? args.prompt : ''
      const short = prompt.length > 48 ? `${prompt.slice(0, 48)}…` : prompt
      return { card: 'generic', title: `生成图片：${short || '(无提示词)'}`, kind: 'other', rawInput: args }
    },
  }
}

// ---------------------------------------------------------------------------
// 工具：openai_account
// ---------------------------------------------------------------------------

function createAccountTool(ctx, cfg, pending) {
  return {
    name: 'openai_account',
    description:
      '查看或管理 ChatGPT（OpenAI）账号授权，用于 generate_image 扣除 ChatGPT 订阅额度。' +
      'action=status 查看当前授权来源与到期时间；login_start 发起设备码登录（返回一个网址和 8 位代码）；' +
      'login_poll 在用户完成网页登录后确认并保存授权；logout 删除插件保存的授权（不影响本机 Codex CLI 登录）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'login_start', 'login_poll', 'logout'],
          description: '要执行的操作。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'status'],
        properties: {
          action: { type: 'string' },
          status: { type: 'string' },
          authorized: { type: 'boolean' },
          source: { type: 'string' },
          account_id: { type: 'string' },
          email: { type: 'string' },
          plan: { type: 'string' },
          expires_at: { type: 'string' },
          expires_in_minutes: { type: 'integer' },
          verification_url: { type: 'string' },
          user_code: { type: 'string' },
          interval_seconds: { type: 'integer' },
          host_model: { type: 'string' },
          image_model: { type: 'string' },
          default_size: { type: 'string' },
          output_dir: { type: 'string' },
          auth_file: { type: 'string' },
          message: { type: 'string' },
          render_text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.render_text ?? value.message ?? value.status }],
    },
    async execute(args) {
      switch (args.action) {
        case 'status':
          return accountStatus(ctx, cfg)
        case 'login_start':
          return loginStart(pending)
        case 'login_poll':
          return loginPoll(ctx, cfg, pending)
        case 'logout':
          return logout(ctx)
        default:
          throw new Error(`openai_account: 未知 action "${args.action}"`)
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `ChatGPT 授权：${args.action}`, kind: 'other', rawInput: args }
    },
  }
}

async function accountStatus(ctx, cfg) {
  const auth = await resolveAuthQuiet(ctx, cfg)
  if (!auth) {
    const message =
      '当前没有可用的 ChatGPT 授权。可以：\n' +
      '1. 运行 `codex login` 用本机 Codex CLI 登录（插件会只读复用）；或\n' +
      '2. 调用 openai_account(action="login_start") 在插件内完成设备码授权。'
    return {
      action: 'status',
      status: 'unauthorized',
      authorized: false,
      host_model: cfg.hostModel,
      image_model: cfg.imageModel,
      default_size: cfg.defaultSize,
      output_dir: cfg.outputDir,
      auth_file: cfg.authFile,
      message,
      render_text: message,
    }
  }
  const expiresInMinutes =
    typeof auth.expiresAt === 'number' ? Math.max(0, Math.round((auth.expiresAt - Date.now()) / 60_000)) : undefined
  const lines = [
    `已授权：${auth.source === 'dsh-credential' ? '插件内授权（DSH 凭据 openai-image/chatgpt）' : '本机 Codex CLI（~/.codex/auth.json，只读复用）'}`,
    auth.email ? `账号：${auth.email}` : undefined,
    auth.plan ? `订阅档位：${auth.plan}` : undefined,
    auth.accountId ? `账号 ID：${mask(auth.accountId)}` : undefined,
    typeof auth.expiresAt === 'number'
      ? `Access Token 到期：${new Date(auth.expiresAt).toLocaleString('zh-CN')}（约 ${expiresInMinutes} 分钟后）`
      : undefined,
    `生图默认：${cfg.imageModel} / ${cfg.defaultSize}，宿主模型 ${cfg.hostModel}`,
  ].filter(Boolean)
  return {
    action: 'status',
    status: 'authorized',
    authorized: true,
    source: auth.source,
    account_id: auth.accountId ? mask(auth.accountId) : undefined,
    email: auth.email,
    plan: auth.plan,
    expires_at: typeof auth.expiresAt === 'number' ? new Date(auth.expiresAt).toISOString() : undefined,
    expires_in_minutes: expiresInMinutes,
    host_model: cfg.hostModel,
    image_model: cfg.imageModel,
    default_size: cfg.defaultSize,
    output_dir: cfg.outputDir,
    auth_file: cfg.authFile,
    message: lines.join('\n'),
    render_text: lines.join('\n'),
  }
}

async function loginStart(pending) {
  const res = await fetch(DEVICE_USERCODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  })
  const body = await readJsonBody(res)
  if (!res.ok) throw new Error(`openai_account: 申请设备码失败（HTTP ${res.status}）：${summary(body)}`)
  const deviceAuthId = body?.device_auth_id
  const userCode = body?.user_code
  const interval = Number(body?.interval)
  if (!deviceAuthId || !userCode) throw new Error(`openai_account: 设备码响应缺少字段：${summary(body)}`)
  const expiresAt = body?.expires_at ? Date.parse(body.expires_at) : Date.now() + 15 * 60_000
  const intervalSeconds = Number.isFinite(interval) && interval > 0 ? interval : 5
  pending.setPending({ deviceAuthId, userCode, intervalSeconds, expiresAt })
  const message =
    `请在浏览器打开：${DEVICE_VERIFICATION_URL}\n` +
    `输入代码：${userCode}\n` +
    `登录完成后，调用 openai_account(action="login_poll") 让我确认并保存授权。\n` +
    `（代码约 ${Math.max(1, Math.round((expiresAt - Date.now()) / 60_000))} 分钟内有效）`
  return {
    action: 'login_start',
    status: 'awaiting_user',
    verification_url: DEVICE_VERIFICATION_URL,
    user_code: userCode,
    interval_seconds: intervalSeconds,
    expires_at: new Date(expiresAt).toISOString(),
    message,
    render_text: message,
  }
}

async function loginPoll(ctx, cfg, pending) {
  const current = pending.getPending()
  if (!current) throw new Error('openai_account: 没有进行中的登录，请先调用 openai_account(action="login_start")')
  if (Date.now() > current.expiresAt) {
    pending.setPending(undefined)
    throw new Error('openai_account: 设备码已过期，请重新调用 openai_account(action="login_start")')
  }
  const res = await fetch(DEVICE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_auth_id: current.deviceAuthId, user_code: current.userCode }),
  })
  const body = await readJsonBody(res)
  const errorCode = typeof body?.error === 'object' ? body.error?.code : body?.error
  const isPending =
    res.status === 403 ||
    res.status === 404 ||
    errorCode === 'deviceauth_authorization_pending' ||
    errorCode === 'authorization_pending'
  if (isPending) return pendingResult(current)
  if (!res.ok) throw new Error(`openai_account: 查询设备码失败（HTTP ${res.status}）：${summary(body)}`)
  if (!body?.authorization_code || !body?.code_verifier) {
    throw new Error(`openai_account: 设备码授权响应缺少字段：${summary(body)}`)
  }
  const credential = await exchangeAuthorizationCode(body.authorization_code, body.code_verifier)
  await writeStoredCredential(ctx, credential)
  pending.setPending(undefined)
  return accountStatus(ctx, cfg)
}

function pendingResult(current) {
  const message =
    `尚未完成登录。请先在浏览器打开 ${DEVICE_VERIFICATION_URL} 并输入代码 ${current.userCode}，` +
    '然后再次调用 openai_account(action="login_poll")。'
  return {
    action: 'login_poll',
    status: 'pending',
    verification_url: DEVICE_VERIFICATION_URL,
    user_code: current.userCode,
    interval_seconds: current.intervalSeconds,
    expires_at: new Date(current.expiresAt).toISOString(),
    message,
    render_text: message,
  }
}

async function logout(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials) await credentials.deleteRecord(CREDENTIAL_KEY)
  const message =
    '已删除插件内保存的 ChatGPT 授权。若本机 Codex CLI 仍处于登录状态，generate_image 会继续只读复用它的授权；' +
    '需要彻底断开时请另外运行 `codex logout`。'
  return { action: 'logout', status: 'signed_out', authorized: false, message, render_text: message }
}

// ---------------------------------------------------------------------------
// 授权解析与刷新
// ---------------------------------------------------------------------------

async function resolveAuth(ctx, cfg, signal) {
  const stored = await readStoredCredential(ctx)
  if (stored) {
    if (typeof stored.expiresAt !== 'number' || stored.expiresAt - Date.now() < 60_000) {
      const refreshed = await refreshCredential(stored, signal)
      await writeStoredCredential(ctx, refreshed)
      return refreshed
    }
    return stored
  }
  const codex = await readCodexAuth(cfg.authFile)
  if (codex) {
    if (typeof codex.expiresAt === 'number' && codex.expiresAt - Date.now() < 60_000) {
      throw new Error(
        `本机 Codex CLI 的 ChatGPT 登录已过期（${new Date(codex.expiresAt).toLocaleString('zh-CN')}）。` +
          '请运行 `codex login` 重新登录，或调用 openai_account(action="login_start") 在插件内重新授权。',
      )
    }
    return codex
  }
  throw new Error(
    '没有可用的 ChatGPT 授权。请运行 `codex login`，或调用 openai_account(action="login_start") 在插件内完成设备码授权。',
  )
}

async function resolveAuthQuiet(ctx, cfg) {
  try {
    return await resolveAuth(ctx, cfg)
  } catch {
    const codex = await readCodexAuth(cfg.authFile)
    return codex && (typeof codex.expiresAt !== 'number' || codex.expiresAt > Date.now()) ? codex : undefined
  }
}

async function readStoredCredential(ctx) {
  const credentials = ctx.get('credentials')
  if (!credentials) return undefined
  let record
  try {
    record = await credentials.readRecord(CREDENTIAL_KEY)
  } catch {
    return undefined
  }
  if (!record || record.kind !== 'grant') return undefined
  const payload = record.payload
  if (!payload || payload.type !== 'oauth' || typeof payload.access !== 'string') return undefined
  const claims = decodeJwt(payload.access)
  const authClaim = claims?.['https://api.openai.com/auth']
  return {
    accessToken: payload.access,
    refreshToken: payload.refresh,
    expiresAt: typeof payload.expires === 'number' ? payload.expires : claims?.exp ? claims.exp * 1000 : undefined,
    accountId: payload.accountId ?? authClaim?.chatgpt_account_id,
    idToken: payload.idToken,
    email: payload.email,
    plan: payload.plan ?? authClaim?.chatgpt_plan_type,
    source: 'dsh-credential',
  }
}

async function writeStoredCredential(ctx, credential) {
  const credentials = ctx.get('credentials')
  if (!credentials) {
    throw new Error(
      '当前 DSH 组合没有挂载凭据服务（ctx.credentials），无法保存插件内授权；请改用 `codex login` 让插件只读复用。',
    )
  }
  await credentials.modifyRecord(CREDENTIAL_KEY, () =>
    Promise.resolve({
      kind: 'grant',
      payload: {
        type: 'oauth',
        access: credential.accessToken,
        ...(credential.refreshToken ? { refresh: credential.refreshToken } : {}),
        ...(typeof credential.expiresAt === 'number' ? { expires: credential.expiresAt } : {}),
        ...(credential.accountId ? { accountId: credential.accountId } : {}),
        ...(credential.idToken ? { idToken: credential.idToken } : {}),
        ...(credential.email ? { email: credential.email } : {}),
        ...(credential.plan ? { plan: credential.plan } : {}),
        savedAt: new Date().toISOString(),
      },
    }),
  )
}

async function readCodexAuth(authFile) {
  let text
  try {
    text = await readFile(expandHome(authFile), 'utf8')
  } catch {
    return undefined
  }
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return undefined
  }
  const tokens = doc?.tokens
  if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) return undefined
  const claims = decodeJwt(tokens.access_token)
  const authClaim = claims?.['https://api.openai.com/auth']
  const idClaims = decodeJwt(tokens.id_token)
  return {
    accessToken: tokens.access_token,
    refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined,
    expiresAt: claims?.exp ? claims.exp * 1000 : undefined,
    accountId: tokens.account_id ?? authClaim?.chatgpt_account_id,
    email: idClaims?.email,
    plan: authClaim?.chatgpt_plan_type,
    source: 'codex-cli',
  }
}

async function refreshCredential(credential, signal) {
  if (!credential.refreshToken) {
    throw new Error('授权已过期且没有 refresh token，请重新调用 openai_account(action="login_start") 授权')
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
      client_id: CLIENT_ID,
    }),
    signal,
  })
  const body = await readJsonBody(res)
  if (!res.ok || !body?.access_token) throw new Error(`ChatGPT 授权刷新失败（HTTP ${res.status}）：${summary(body)}`)
  const claims = decodeJwt(body.access_token)
  const authClaim = claims?.['https://api.openai.com/auth']
  const idClaims = decodeJwt(body.id_token ?? credential.idToken)
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : credential.refreshToken,
    expiresAt:
      typeof body.expires_in === 'number'
        ? Date.now() + body.expires_in * 1000
        : claims?.exp
          ? claims.exp * 1000
          : credential.expiresAt,
    accountId: authClaim?.chatgpt_account_id ?? credential.accountId,
    idToken: body.id_token ?? credential.idToken,
    email: idClaims?.email ?? credential.email,
    plan: authClaim?.chatgpt_plan_type ?? credential.plan,
    source: credential.source,
  }
}

async function exchangeAuthorizationCode(code, codeVerifier) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: DEVICE_REDIRECT_URI,
    }),
  })
  const body = await readJsonBody(res)
  if (!res.ok || !body?.access_token) {
    throw new Error(`openai_account: 换取 access token 失败（HTTP ${res.status}）：${summary(body)}`)
  }
  const claims = decodeJwt(body.access_token)
  const authClaim = claims?.['https://api.openai.com/auth']
  const idClaims = decodeJwt(body.id_token)
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresAt:
      typeof body.expires_in === 'number'
        ? Date.now() + body.expires_in * 1000
        : claims?.exp
          ? claims.exp * 1000
          : undefined,
    accountId: authClaim?.chatgpt_account_id,
    idToken: body.id_token,
    email: idClaims?.email,
    plan: authClaim?.chatgpt_plan_type,
    source: 'dsh-credential',
  }
}

// ---------------------------------------------------------------------------
// 生图请求
// ---------------------------------------------------------------------------

async function requestImage(auth, options, signal) {
  const body = {
    model: options.hostModel,
    store: false,
    stream: true,
    instructions: 'Generate the requested image. Do not add extra prose.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: options.prompt }] }],
    tools: [
      {
        type: 'image_generation',
        model: options.model,
        size: options.size,
        ...(options.quality ? { quality: options.quality } : {}),
      },
    ],
    tool_choice: { type: 'image_generation' },
  }
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    'chatgpt-account-id': auth.accountId,
    originator: 'pi',
    'OpenAI-Beta': 'responses=experimental',
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    'User-Agent': 'dsh-openai-codex-image/1.0.0',
    session_id: `dsh-${randomBytes(8).toString('hex')}`,
  }
  const res = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const error = new Error(`HTTP ${res.status} ${text}`)
    error.httpStatus = res.status
    throw error
  }
  const text = await res.text()
  const parsed = parseImageEvents(text)
  if (!parsed) throw new Error('响应里没有找到图片结果（image_generation_call.result 为空）')
  return parsed
}

/** 从 SSE 文本里取最后一张完整图片；没有完整结果时退回最后一张预览帧。 */
function parseImageEvents(text) {
  let partial
  let final
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    let event
    try {
      event = JSON.parse(data)
    } catch {
      continue
    }
    if (typeof event?.partial_image_b64 === 'string' && event.partial_image_b64) partial = event.partial_image_b64
    const item = event?.item
    if (item && item.type === 'image_generation_call' && typeof item.result === 'string' && item.result) {
      final = item
    }
  }
  if (final) {
    return {
      b64: final.result,
      revisedPrompt: typeof final.revised_prompt === 'string' ? final.revised_prompt : undefined,
      outputFormat: final.output_format,
      size: final.size,
    }
  }
  if (partial) return { b64: partial }
  return undefined
}

function explainImageError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return new Error('生成图片超时或被取消；可以调大 timeoutMs 后重试')
  }
  if (error?.httpStatus) {
    const raw = String(error.message ?? '')
    const detail = raw.replace(/^HTTP \d+\s*/, '')
    let parsed
    try {
      parsed = JSON.parse(detail)
    } catch {
      parsed = undefined
    }
    const message = parsed?.error?.message ?? parsed?.detail ?? parsed?.message ?? (detail ? detail.slice(0, 800) : '')
    const hint =
      error.httpStatus === 401 || error.httpStatus === 403
        ? '（授权无效或过期，请重新授权：openai_account(action="login_start")）'
        : error.httpStatus === 429
          ? '（可能触发额度或频率限制；订阅额度用尽时需等待重置）'
          : error.httpStatus === 400 && /model/i.test(String(message))
            ? '（当前账号不支持该宿主模型，可通过 host_model 参数换成账号可用的模型）'
            : ''
    return new Error(`ChatGPT 生图失败（HTTP ${error.httpStatus}）：${message}${hint}`)
  }
  return error instanceof Error ? error : new Error(String(error))
}

// ---------------------------------------------------------------------------
// 落盘与附件
// ---------------------------------------------------------------------------

function imageFileName(requested) {
  const stamp = timestamp(new Date())
  const fallback = `image-${stamp}.png`
  if (typeof requested !== 'string' || !requested.trim()) return fallback
  const base = basename(requested.trim()).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
  const safe = base.replace(/^\.+/, '') || fallback
  return safe.toLowerCase().endsWith('.png') ? safe : `${safe}.png`
}

async function sessionWorkingDirectory(ctx, exec) {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory && exec.agent) {
    try {
      return await workingDirectory.ensure(exec.agent, exec.signal)
    } catch {
      // 落回进程目录
    }
  }
  return process.cwd()
}

function uniqueFilePath(candidate) {
  if (!existsSync(candidate)) return candidate
  const ext = extname(candidate)
  const stem = candidate.slice(0, -ext.length)
  return `${stem}-${randomBytes(3).toString('hex')}${ext}`
}

async function attachImage(ctx, exec, data, fileName) {
  const attachments = ctx.get('attachments')
  if (!attachments) return undefined
  if (!(await routeAcceptsImages(ctx, exec))) return undefined
  try {
    const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: fileName })
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
      ...(ref.originalDimensions === undefined
        ? {}
        : { originalDimensions: { width: ref.originalDimensions.width, height: ref.originalDimensions.height } }),
    }
  } catch (error) {
    ctx.logger?.warn?.(`openai-codex-image: 图片附件保存失败，只返回文件路径：${error?.message ?? error}`)
    return undefined
  }
}

/** 当前路由是否声明了图片输入；不支持的模型只拿文字和路径。 */
async function routeAcceptsImages(ctx, exec) {
  const llm = ctx.get('llm')
  const agent = exec.agent
  if (!llm || !agent) return false
  try {
    const routed = agent.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? agent.options?.provider
    const model = routed?.model ?? agent.options?.model
    if (!provider || !model) return false
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal
}

function decodeJwt(token) {
  if (typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    return undefined
  }
}

function pngSize(buffer) {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  return undefined
}

function parseSize(size) {
  const match = /^(\d+)x(\d+)$/.exec(size)
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 0, height: 0 }
}

function timestamp(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `-${randomBytes(2).toString('hex')}`
  )
}

function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

function mask(value) {
  const text = String(value)
  if (text.length <= 12) return text
  return `${text.slice(0, 8)}…${text.slice(-4)}`
}

async function readJsonBody(res) {
  const text = await res.text().catch(() => '')
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

function summary(body) {
  if (!body) return '(空响应)'
  if (typeof body === 'string') return body.slice(0, 800)
  return JSON.stringify(body).slice(0, 800)
}
