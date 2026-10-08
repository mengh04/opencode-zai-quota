/**
 * TUI half of the Z.AI quota plugin: one `sidebar.content` slot contribution
 * that reads the provider's quota endpoint with the configured key and renders
 * the rolling 5-hour, weekly, and monthly metering windows. The key stays in
 * this local process; the sidebar receives only the window readings.
 *
 * Wire parsing follows the dsh plugin (`dsh-zai-quota`): the provider
 * identifies the rolling and weekly windows by `(unit, number)` inside the
 * `limits` array, and the monthly MCP window by the `TIME_LIMIT` type.
 */

import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"

/** Plugin options as passed through cli.json. */
interface Options {
  /** Coding-plan API key, sent as the bearer credential. */
  readonly apiKey?: string
  /** Absolute URL of the provider's quota endpoint. */
  readonly endpoint?: string
  /** Deadline for one provider request, in milliseconds. */
  readonly timeoutMs?: number
  /** How long one successful reading is reused, in milliseconds. */
  readonly cacheMs?: number
  /** How often a fresh reading is taken, in milliseconds. */
  readonly refreshMs?: number
  /** Whether the plan tier (for example `pro`) is shown in the heading. */
  readonly showLevel?: boolean
  /** Progress-bar width in characters. */
  readonly barWidth?: number
}

/** One metering window of a coding plan. */
interface QuotaWindow {
  readonly kind: "rolling" | "weekly" | "monthly"
  readonly limit: number
  readonly used: number
  readonly remaining: number
  readonly percent: number
  readonly resetsAt: number
}

/** Success payload derived from the provider body. */
interface QuotaPayload {
  readonly level: string
  readonly windows: readonly QuotaWindow[]
}

type State =
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly payload: QuotaPayload; readonly at: number }
  | { readonly status: "failed"; readonly message: string }

/** One provider row as it arrives from the wire: every field still unknown. */
interface UpstreamRow {
  readonly type?: unknown
  readonly unit?: unknown
  readonly number?: unknown
  readonly usage?: unknown
  readonly currentValue?: unknown
  readonly remaining?: unknown
  readonly percentage?: unknown
  readonly nextResetTime?: unknown
}

/**
 * Classify one provider row by the allowance it meters.
 * @param row - one row of the provider's `limits` array.
 * @returns The window kind, or null for a row this plugin does not render.
 */
function windowKindOf(row: UpstreamRow): QuotaWindow["kind"] | null {
  if (row.type === "TIME_LIMIT") return "monthly"
  if (row.type !== "TOKENS_LIMIT" && row.type !== "CREDIT_LIMIT") return null
  if (row.unit === 3 && row.number === 5) return "rolling"
  if (row.unit === 6 && row.number === 1) return "weekly"
  return null
}

/** One wire field as a finite number, or null when the provider sent anything else. */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * Read the provider's quota body into the payload the sidebar renders.
 * @param body - the decoded JSON body.
 * @returns The payload, or null when the body carries no readable window.
 */
function readQuota(body: unknown): QuotaPayload | null {
  if (typeof body !== "object" || body === null) return null
  const envelope = body as { readonly code?: unknown; readonly success?: unknown; readonly data?: unknown }
  if (envelope.code !== 200 || envelope.success !== true) return null
  if (typeof envelope.data !== "object" || envelope.data === null) return null
  const { limits, level } = envelope.data as { readonly limits?: unknown; readonly level?: unknown }
  if (!Array.isArray(limits)) return null
  const windows: QuotaWindow[] = []
  for (const raw of limits) {
    if (typeof raw !== "object" || raw === null) continue
    const row = raw as UpstreamRow
    const kind = windowKindOf(row)
    if (kind === null) continue
    const limit = finiteNumber(row.usage)
    const used = finiteNumber(row.currentValue)
    const remaining = finiteNumber(row.remaining)
    const percent = finiteNumber(row.percentage)
    const resetsAt = finiteNumber(row.nextResetTime)
    if (limit === null || used === null || remaining === null || percent === null || resetsAt === null) continue
    windows.push({ kind, limit, used, remaining, percent, resetsAt })
  }
  if (windows.length === 0) return null
  return { level: typeof level === "string" ? level : "", windows }
}

/** Compact remaining time, for example `46m`, `2h`, or `3d`. */
function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000))
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)}h`
  return `${String(Math.round(hours / 24))}d`
}

/** Sidebar label per window kind. */
const LABEL = {
  rolling: "5小时",
  weekly: "本周",
  monthly: "月度",
} as const satisfies Record<QuotaWindow["kind"], string>

/** Display width of a line: CJK and other fullwidth characters count twice. */
function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += char.charCodeAt(0) > 0xff ? 2 : 1
  return width
}

/** Column at which every bar starts: the widest label plus one space. */
const LABEL_COLUMN = Math.max(...Object.values(LABEL).map(displayWidth)) + 1

/** Left padding that places a string's content at the shared bar column. */
function paddingOf(text: string): string {
  return " ".repeat(LABEL_COLUMN - displayWidth(text))
}

/** Readable text for an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * First string color at one of the dotted candidate paths inside the resolved
 * theme. The token tree is not part of the public plugin API, so every lookup
 * degrades to the caller's guaranteed fallback (`text.base` lives last).
 * @param theme - the resolved theme tokens from the plugin context.
 * @param paths - candidate dotted paths, most specific first.
 * @returns The color string, or undefined when nothing matched.
 */
function pickColor(theme: unknown, paths: readonly string[]): string | undefined {
  for (const path of paths) {
    let node: unknown = theme
    for (const segment of path.split(".")) {
      if (typeof node !== "object" || node === null) break
      node = (node as Record<string, unknown>)[segment]
    }
    if (typeof node === "string" && node !== "") return node
  }
  return undefined
}

/** Candidate color paths for a bar below the warning threshold. */
const COLOR_ACCENT = ["text.action.primary.base", "text.base"] as const

/** Candidate color paths for a bar at or above the warning threshold (60%). */
const COLOR_WARNING = ["text.status.warning", "text.warning", "text.base"] as const

/** Candidate color paths for a bar at or above the danger threshold (85%). */
const COLOR_DANGER = ["text.status.danger", "text.status.error", "text.error", "text.base"] as const

/** Usage thresholds that recolor the bar. */
const WARNING_PERCENT = 60
const DANGER_PERCENT = 85

/**
 * One usage bar as terminal blocks: filled and light tracks in one string.
 * @param percent - consumed share, clamped to 0-100.
 * @param width - bar width in characters.
 * @returns The bar, for example `██░░░░░░░░`.
 */
function barOf(percent: number, width: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

export default Plugin.define({
  id: "zai.quota.tui",
  setup(context) {
    const options = (context.options ?? {}) as Options
    const apiKey = options.apiKey
    if (apiKey === undefined || apiKey === "") {
      context.ui.toast.show({ message: "zai-quota: 未配置 apiKey，插件未启动" })
      return
    }
    const endpoint = options.endpoint ?? "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
    const timeoutMs = options.timeoutMs ?? 10_000
    const cacheMs = options.cacheMs ?? 60_000
    const refreshMs = Math.max(options.refreshMs ?? 300_000, 30_000)
    const showLevel = options.showLevel ?? false
    const barWidth = Math.min(30, Math.max(4, options.barWidth ?? 12))

    const [state, setState] = createSignal<State>({ status: "loading" })
    let fetchedAt = 0
    let inFlight: Promise<void> | undefined

    /**
     * Take one reading, reusing a fresh one unless forced. An old reading is
     * kept on failure so a transient provider error does not blank the sidebar.
     */
    const refresh = (force = false): Promise<void> => {
      if (inFlight !== undefined) return inFlight
      if (!force && Date.now() - fetchedAt < cacheMs) return Promise.resolve()
      inFlight = (async () => {
        try {
          const response = await fetch(endpoint, {
            headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
          })
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
          const payload = readQuota(await response.json())
          if (payload === null) throw new Error("响应中没有可识别的额度数据")
          fetchedAt = Date.now()
          setState({ status: "ok", payload, at: fetchedAt })
        } catch (error: unknown) {
          setState(current =>
            current.status === "ok"
              ? current
              : { status: "failed", message: messageOf(error) },
          )
        } finally {
          inFlight = undefined
        }
      })()
      return inFlight
    }

    // Re-render the countdown every minute; take a fresh reading on the interval.
    const minute = setInterval(() => setState(current => ({ ...current })), 60_000)
    const auto = setInterval(() => void refresh(true), refreshMs)
    void refresh(true)

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const theme = context.theme
        const current = state()
        if (current.status === "loading") {
          return (
            <box>
              <text fg={theme.text.base}>智谱额度</text>
              <text> </text>
              <text fg={theme.text.muted}>读取中…</text>
            </box>
          )
        }
        if (current.status === "failed") {
          return (
            <box>
              <text fg={theme.text.base}>智谱额度</text>
              <text> </text>
              <text fg={theme.text.muted}>读取失败：{current.message}</text>
            </box>
          )
        }
        return (
          <box>
            <text fg={theme.text.base}>
              智谱额度
              {showLevel && current.payload.level !== "" ? ` · ${current.payload.level}` : ""}
            </text>
            <text> </text>
            {current.payload.windows.map(window => {
              const percent = Math.round(window.percent)
              const color =
                percent >= DANGER_PERCENT ? pickColor(theme, COLOR_DANGER)
              : percent >= WARNING_PERCENT ? pickColor(theme, COLOR_WARNING)
              : pickColor(theme, COLOR_ACCENT)
              const label = LABEL[window.kind]
              const resets = formatDuration(window.resetsAt - Date.now())
              return (
                <text fg={color}>
                  {`${label}${paddingOf(label)}${barOf(percent, barWidth)} ${String(percent).padStart(3)}% · ${resets}`}
                </text>
              )
            })}
          </box>
        )
      },
    })

    return () => {
      clearInterval(minute)
      clearInterval(auto)
      unregister()
    }
  },
})
