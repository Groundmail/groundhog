/**
 * Pull the one-time code and the links out of an email, so a test (or an agent)
 * can finish a sign-in without reading the email itself.
 */

type EmailLike = { html?: string | null; text?: string | null; subject?: string | null }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase()
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16))
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10))
    return ENTITIES[lower] ?? match
  })
}

/** A rough plain-text rendering of HTML, good enough for finding codes. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

function toParts(input: EmailLike | string): { html: string; text: string; subject: string } {
  if (typeof input === 'string') {
    const looksHtml = /<[a-z][\s\S]*>/i.test(input)
    return { html: looksHtml ? input : '', text: looksHtml ? htmlToText(input) : input, subject: '' }
  }
  const html = input.html ?? ''
  const text = input.text?.trim() ? input.text : html ? htmlToText(html) : ''
  return { html, text, subject: input.subject ?? '' }
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]]+/gi

function cleanUrl(url: string): string {
  return decodeEntities(url.trim()).replace(/[.,;:!?]+$/, '')
}

/** Every http(s) link in the email, in the order it appears, without duplicates. */
export function extractLinks(input: EmailLike | string): string[] {
  const { html, text } = toParts(input)
  const seen = new Set<string>()
  const out: string[] = []
  const add = (url: string) => {
    const clean = cleanUrl(url)
    if (!/^https?:\/\//i.test(clean) || seen.has(clean)) return
    seen.add(clean)
    out.push(clean)
  }
  if (html) {
    for (const match of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      add(match[1] ?? match[2] ?? match[3] ?? '')
    }
  }
  for (const match of (text || '').matchAll(URL_IN_TEXT)) add(match[0])
  return out
}

const CODE_WORDS = /(code|otp|one[- ]time|passcode|pin|verification|verify|confirm|token|sign[- ]?in|log[- ]?in|2fa|mfa)/i

/**
 * The one-time code in the email: digits (4–8, also "123 456" / "123-456"), or a short
 * letters-and-digits code next to a word like "code". `null` when nothing looks like one.
 */
export function extractCode(input: EmailLike | string): string | null {
  const { text, subject } = toParts(input)
  const haystacks = [subject, text].filter(Boolean)
  let best: { value: string; score: number; order: number } | null = null
  let order = 0
  for (const source of haystacks) {
    const scrubbed = source.replace(URL_IN_TEXT, ' ').replace(/#[0-9a-f]{3,8}\b/gi, ' ')
    const candidates: Array<{ value: string; index: number; alnum: boolean }> = []
    for (const match of scrubbed.matchAll(/(?<![\w.$€£-])(\d{3}[ -]\d{3}|\d{4,8})(?![\w%-]|[.,]\d)/g)) {
      candidates.push({ value: match[1], index: match.index ?? 0, alnum: false })
    }
    for (const match of scrubbed.matchAll(/(?<![\w-])([A-Z0-9]{5,8})(?![\w-])/g)) {
      const value = match[1]
      if (/\d/.test(value) && /[A-Z]/.test(value)) candidates.push({ value, index: match.index ?? 0, alnum: true })
    }
    for (const candidate of candidates) {
      const value = candidate.value.replace(/[ -]/g, '')
      const before = scrubbed.slice(Math.max(0, candidate.index - 60), candidate.index)
      const near = CODE_WORDS.test(before)
      let score = near ? 10 : 0
      if (candidate.alnum && !near) continue
      if (!candidate.alnum) {
        if (value.length === 6) score += 4
        else if (value.length === 4 || value.length === 8) score += 1
        if (value.length === 4 && /^(19|20)\d\d$/.test(value)) score -= 8
        if (/^0+$/.test(value)) score -= 8
      }
      if (/[$€£]\s*$/.test(before) || /(#|no\.?|number|order|invoice|receipt)\s*$/i.test(before)) score -= 6
      order += 1
      if (score <= 0) continue
      if (!best || score > best.score) best = { value, score, order }
    }
  }
  return best && best.score > 0 ? best.value : null
}

/** The first link whose URL contains `contains` (or the first link that isn't an unsubscribe/asset link). */
export function pickLink(links: string[], contains?: string): string | null {
  if (contains) return links.find((link) => link.includes(contains)) ?? null
  const useful = links.filter((link) => !/unsubscribe|\.(png|jpe?g|gif|svg|css)(\?|$)|list-manage|privacy|terms/i.test(link))
  return useful[0] ?? links[0] ?? null
}
