// Groundhog web UI. Plain JS, no build step. Everything from an email is set with
// textContent or attributes, never innerHTML; the HTML body renders in a sandboxed iframe.

const $ = (selector, root = document) => root.querySelector(selector)

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue
    if (key === 'class') el.className = value
    else if (key === 'text') el.textContent = value
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value)
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'dataset') Object.assign(el.dataset, value)
    else el.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

function svg(markup) {
  const template = document.createElement('template')
  template.innerHTML = markup.trim() // Static markup from this file only.
  return template.content.firstElementChild
}

// Groundbot, the robot groundhog: asleep while the inbox is empty, happy when an email is caught,
// crossed-out eyes when a send fails.
const MASCOT = {
  dozing: `<svg class="empty-art" viewBox="0 0 360 200" width="360" height="200" role="img" aria-label="Groundbot asleep in its burrow"><rect x="0" y="150" width="360" height="14" fill="#4a3a29"/><rect x="0" y="164" width="360" height="12" fill="#3a2d20"/><rect x="0" y="176" width="360" height="12" fill="#2c2218"/><rect x="0" y="188" width="360" height="12" fill="#1f1811"/><ellipse cx="180" cy="152" rx="96" ry="18" fill="#0d0a07"/><g transform="translate(95 9.2) scale(0.85)"><rect x="88" y="6" width="5" height="22" fill="#241c15"/><circle cx="90.5" cy="8" r="7" fill="#5f432c" stroke="#241c15" stroke-width="3"/><rect x="34" y="30" width="22" height="26" rx="6" fill="#5f432c" stroke="#241c15" stroke-width="4"/><rect x="144" y="30" width="22" height="26" rx="6" fill="#5f432c" stroke="#241c15" stroke-width="4"/><circle cx="45" cy="43" r="3" fill="#d6bf98"/><circle cx="155" cy="43" r="3" fill="#d6bf98"/><rect x="44" y="26" width="112" height="104" rx="26" fill="#8b6643" stroke="#241c15" stroke-width="4"/><rect x="58" y="50" width="84" height="44" rx="12" fill="#0d0a07" stroke="#241c15" stroke-width="3"/><path d="M72 74 h20 M108 74 h20" fill="none" stroke="#5f432c" stroke-width="5" stroke-linecap="round"/><text x="150" y="22" font-family="Geist, ui-sans-serif, system-ui, sans-serif" font-size="18" font-weight="700" fill="#8b6643">z</text><text x="164" y="10" font-family="Geist, ui-sans-serif, system-ui, sans-serif" font-size="13" font-weight="700" fill="#b48f62">z</text><rect x="78" y="98" width="44" height="22" rx="10" fill="#e8c9a0" stroke="#241c15" stroke-width="3"/><rect x="94" y="100" width="12" height="7" rx="3" fill="#241c15"/><rect x="93" y="116" width="6" height="9" rx="1" fill="#fbf8f1" stroke="#241c15" stroke-width="2"/><rect x="101" y="116" width="6" height="9" rx="1" fill="#fbf8f1" stroke="#241c15" stroke-width="2"/><path d="M52 104h12M52 112h12M136 104h12M136 112h12" stroke="#5f432c" stroke-width="3" stroke-linecap="round"/><rect x="30" y="128" width="140" height="40" rx="8" fill="#241c15"/><rect x="84" y="136" width="32" height="22" rx="4" fill="#5f432c"/><path d="M87 139 L100 149 L113 139" fill="none" stroke="#241c15" stroke-width="2.5" stroke-linejoin="round"/></g></svg>`,
  mail: `<svg viewBox="0 0 60 44" width="48" height="36" aria-hidden="true"><g transform="translate(5 1) scale(0.25)"><rect x="87.5" y="6" width="6" height="22" fill="#241c15"/><circle cx="90.5" cy="8" r="8" fill="#e27d4e" stroke="#241c15" stroke-width="3"/><rect x="34" y="30" width="22" height="26" rx="6" fill="#5f432c" stroke="#241c15" stroke-width="5"/><rect x="144" y="30" width="22" height="26" rx="6" fill="#5f432c" stroke="#241c15" stroke-width="5"/><circle cx="45" cy="43" r="4" fill="#d6bf98"/><circle cx="155" cy="43" r="4" fill="#d6bf98"/><rect x="44" y="26" width="112" height="104" rx="26" fill="#8b6643" stroke="#241c15" stroke-width="6"/><rect x="58" y="50" width="84" height="44" rx="12" fill="#0d0a07"/><path d="M71 78 Q82 62 93 78 M107 78 Q118 62 129 78" fill="none" stroke="#e9b48a" stroke-width="8" stroke-linecap="round"/><rect x="78" y="98" width="44" height="22" rx="10" fill="#e8c9a0" stroke="#241c15" stroke-width="3"/><rect x="94" y="100" width="12" height="7" rx="3" fill="#241c15"/><rect x="93" y="116" width="14" height="9" rx="1" fill="#fbf8f1" stroke="#241c15" stroke-width="2"/><rect x="30" y="128" width="140" height="40" rx="8" fill="#241c15"/><rect x="84" y="136" width="32" height="22" rx="4" fill="#9cb67f"/><path d="M87 139 L100 149 L113 139" fill="none" stroke="#241c15" stroke-width="2.5" stroke-linejoin="round"/></g></svg>`,
  shadow: `<svg viewBox="0 0 120 70" width="56" height="34" aria-hidden="true"><g transform="translate(20.714 2) scale(0.393)"><rect x="87.5" y="6" width="6" height="22" fill="#241c15"/><circle cx="90.5" cy="8" r="8" fill="#e27d4e" stroke="#241c15" stroke-width="3"/><rect x="34" y="30" width="22" height="26" rx="6" fill="#5f432c" stroke="#241c15" stroke-width="5"/><rect x="144" y="30" width="22" height="26" rx="6" fill="#5f432c" stroke="#241c15" stroke-width="5"/><circle cx="45" cy="43" r="4" fill="#d6bf98"/><circle cx="155" cy="43" r="4" fill="#d6bf98"/><rect x="44" y="26" width="112" height="104" rx="26" fill="#8b6643" stroke="#241c15" stroke-width="6"/><rect x="58" y="50" width="84" height="44" rx="12" fill="#0d0a07"/><path d="M75 65 L89 79 M89 65 L75 79 M111 65 L125 79 M125 65 L111 79" fill="none" stroke="#e27d4e" stroke-width="8" stroke-linecap="round"/><rect x="78" y="98" width="44" height="22" rx="10" fill="#e8c9a0" stroke="#241c15" stroke-width="3"/><rect x="94" y="100" width="12" height="7" rx="3" fill="#241c15"/><rect x="93" y="116" width="14" height="9" rx="1" fill="#fbf8f1" stroke="#241c15" stroke-width="2"/><rect x="30" y="128" width="140" height="40" rx="8" fill="#241c15"/><rect x="84" y="136" width="32" height="22" rx="4" fill="#e27d4e"/><path d="M87 139 L100 149 L113 139" fill="none" stroke="#241c15" stroke-width="2.5" stroke-linejoin="round"/></g></svg>`,
}

const VIA = {
  smtp: 'SMTP',
  groundmail: 'Groundmail API',
  sendgrid: 'SendGrid API',
  postmark: 'Postmark API',
  mailgun: 'Mailgun API',
  resend: 'Resend API',
  ses: 'Amazon SES API',
}

const FAULTS = [
  { kind: 'rate_limit', code: '429', label: 'Rate limited', desc: 'SMTP 450 4.7.1', color: '#e0a84a' },
  { kind: 'invalid_recipient', code: '422', label: 'Invalid recipient', desc: 'SMTP 550 5.1.1', color: '#ef7a6e' },
  { kind: 'unauthorized', code: '401', label: 'Bad API key', desc: 'SMTP 535 5.7.8', color: '#ef7a6e' },
  { kind: 'outage', code: '5xx', label: 'Provider outage', desc: 'SMTP 451 4.3.0', color: '#ef7a6e' },
  { kind: 'timeout', code: 'T/O', label: 'Timeout after 30s', desc: 'connection hangs', color: '#c9bba8' },
]

const EVENTS = ['delivered', 'bounced', 'complained', 'opened', 'clicked']

const state = {
  info: null,
  emails: [],
  selected: null,
  current: null,
  tab: 'html',
  device: 'desktop',
  scheme: 'light',
  search: '',
  faults: { kind: null, remaining: 0 },
  webhooks: null,
  deliveries: [],
  account: { connected: false },
  connectTab: 'smtp',
  faultChoice: 'rate_limit',
  fresh: new Set(),
  sendTo: '',
  sendResult: null,
}

async function api(path, init = {}) {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body
}

function ago(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(iso).toLocaleDateString()
}

function addr(a) {
  if (!a) return ''
  return a.name ? `${a.name} <${a.address}>` : a.address
}

function bytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function base() {
  return state.info?.url || location.origin
}

function toast({ title, sub, kind = 'mail', warn = false, onClick }) {
  const el = h('div', { class: `toast${warn ? ' warn' : ''}`, role: 'status', style: onClick ? { cursor: 'pointer' } : undefined, onclick: onClick },
    svg(MASCOT[kind]),
    h('span', { class: 'toast-text' }, h('span', { class: 'toast-title', text: title }), sub ? h('span', { class: 'toast-sub', text: sub }) : null),
  )
  const box = $('#toasts')
  box.append(el)
  while (box.children.length > 3) box.firstElementChild.remove()
  setTimeout(() => el.remove(), 4500)
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text)
    if (button) {
      const old = button.textContent
      button.textContent = 'Copied'
      setTimeout(() => (button.textContent = old), 1200)
    }
  } catch {
    // Clipboard blocked: nothing else to do.
  }
}

function codeBlock(text) {
  const button = h('button', { type: 'button', class: 'btn small copy', text: 'Copy' })
  button.addEventListener('click', () => copy(text, button))
  return h('div', { class: 'codeblock' }, h('pre', { text }), button)
}

// ---- Connect snippets (first run) -----------------------------------------

function snippets() {
  const api = base()
  const smtpPort = state.info?.smtpPort ?? 1025
  return [
    { id: 'smtp', label: 'SMTP', hint: 'Anything that speaks SMTP works: Nodemailer, Laravel, Rails, Django, Phoenix. Any username and password.', code: `SMTP_HOST=localhost\nSMTP_PORT=${smtpPort}` },
    { id: 'groundmail', label: 'Groundmail', hint: 'Point the client at Groundhog while you build.', code: `const gm = new Groundmail('gm_test_anything', {\n  baseUrl: '${api}',\n})` },
    { id: 'sendgrid', label: 'SendGrid', hint: 'Keep @sendgrid/mail. Change where it sends.', code: `sgMail.setApiKey('SG.anything')\nsgMail.client.setDefaultRequest('baseUrl', '${api}/sendgrid')` },
    { id: 'postmark', label: 'Postmark', hint: 'Keep the postmark client. Change the host.', code: `new postmark.ServerClient('anything', {\n  requestHost: '${api.replace(/^https?:\/\//, '')}/postmark',\n  useHttps: false,\n})` },
    { id: 'mailgun', label: 'Mailgun', hint: 'Keep mailgun.js. Change the url.', code: `mailgun.client({\n  username: 'api', key: 'anything',\n  url: '${api}/mailgun',\n})` },
    { id: 'resend', label: 'Resend', hint: 'Set one environment variable.', code: `RESEND_BASE_URL=${api}/resend` },
    { id: 'ses', label: 'Amazon SES', hint: 'Keep the AWS SDK. Override the endpoint.', code: `new SESv2Client({\n  endpoint: '${api}/ses',\n  region: 'us-east-1',\n  credentials: { accessKeyId: 'x', secretAccessKey: 'x' },\n})` },
    { id: 'docker', label: 'Docker', hint: 'Add it next to your app and database.', code: `services:\n  groundhog:\n    image: ghcr.io/groundmail/groundhog\n    ports: ["1025:1025", "3025:3025"]` },
  ]
}

function renderEmpty() {
  const root = $('#empty')
  const list = snippets()
  const current = list.find((s) => s.id === state.connectTab) || list[0]
  const tabs = h('div', { class: 'connect-tabs', role: 'tablist', 'aria-label': 'How your app sends' },
    list.map((s) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(s.id === current.id), text: s.label,
      onclick: () => { state.connectTab = s.id; renderEmpty() },
    })),
  )
  root.replaceChildren(
    svg(MASCOT.dozing),
    h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' } },
      h('h1', { text: 'Nothing in the burrow yet' }),
      h('p', { class: 'lede', text: 'Keep the email SDK you already use and point it here. Every email shows up instantly, and nothing reaches a real inbox.' }),
    ),
    h('section', { class: 'connect', 'aria-label': 'Connect your app' }, tabs,
      h('div', { class: 'connect-body', role: 'tabpanel' }, h('span', { class: 'hint', text: current.hint }), codeBlock(current.code)),
    ),
    h('div', { class: 'empty-foot' },
      h('button', { type: 'button', class: 'btn', text: 'Send a sample email', onclick: () => api('/api/emails/sample', { method: 'POST' }).catch((e) => toast({ title: 'Could not send the sample', sub: e.message, kind: 'shadow', warn: true })) }),
    ),
    h('div', { class: 'empty-foot' },
      h('span', {}, 'Testing in CI? ', h('a', { href: 'https://github.com/Groundmail/groundhog#testing', target: '_blank', rel: 'noopener', text: 'waitForEmail()' }), ' grabs codes and links'),
      h('span', { text: 'Your emails stay on this machine' }),
    ),
  )
}

// ---- List -------------------------------------------------------------------

function visibleEmails() {
  const q = state.search.trim().toLowerCase()
  if (!q) return state.emails
  return state.emails.filter((e) => [e.subject, e.from?.address, e.from?.name, ...e.to.map((a) => a.address), e.preview, e.code].join('\n').toLowerCase().includes(q))
}

function renderList() {
  const emails = visibleEmails()
  const total = state.emails.length
  $('#list-count').textContent = state.search
    ? `${emails.length} of ${total} match`
    : `Caught ${total} ${total === 1 ? 'email' : 'emails'}. None left your laptop.`
  $('#rows').replaceChildren(...emails.map((e) => {
    const to = e.to.map((a) => a.address).join(', ') || e.bcc.map((a) => a.address).join(', ')
    return h('button', {
      type: 'button', role: 'option', 'aria-selected': String(e.id === state.selected),
      class: `row${e.id === state.selected ? ' active' : ''}${state.fresh.has(e.id) ? ' new' : ''}`,
      onclick: () => select(e.id),
    },
      h('span', { class: 'row-top' }, h('span', { class: 'row-subject', text: e.subject || '(no subject)' }), h('span', { class: 'row-time', text: ago(e.createdAt), title: new Date(e.createdAt).toLocaleString() })),
      h('span', { class: 'row-to', text: `To ${to || '(nobody)'}` }),
      h('span', { class: 'tags' },
        h('span', { class: 'tag', text: VIA[e.via] || e.via }),
        e.code ? h('span', { class: 'tag code', text: `code ${e.code}` }) : null,
        e.attachments.length ? h('span', { class: 'tag att', text: `${e.attachments.length} attachment${e.attachments.length === 1 ? '' : 's'}` }) : null,
      ),
    )
  }))
  state.fresh.clear()
}

function renderLayout() {
  const has = state.emails.length > 0
  $('#list').hidden = !has
  $('#view').hidden = !has
  $('#empty').hidden = has
  if (!has) renderEmpty()
}

// ---- Email view ---------------------------------------------------------------

async function select(id) {
  state.selected = id
  state.sendResult = null
  renderList()
  try {
    state.current = await api(`/api/emails/${encodeURIComponent(id)}`)
    state.deliveries = (await api(`/api/webhooks/deliveries?email=${encodeURIComponent(id)}`)).data
  } catch {
    state.current = null
  }
  if (state.tab === 'attachments' && !state.current?.attachments.length) state.tab = 'html'
  renderView()
  history.replaceState(null, '', `#${id}`)
}

function seg(items, current, onPick, role = 'tab') {
  return h('div', { class: 'seg', role: role === 'tab' ? 'tablist' : 'group' }, items.map(([id, label]) => h('button', {
    type: 'button', role: role === 'tab' ? 'tab' : undefined,
    [role === 'tab' ? 'aria-selected' : 'aria-pressed']: String(current === id),
    text: label, onclick: () => onPick(id),
  })))
}

function renderView() {
  const root = $('#view')
  const e = state.current
  if (!e) {
    root.replaceChildren(h('div', { class: 'stage' }, h('p', { class: 'note', text: state.emails.length ? 'Pick an email on the left.' : '' })))
    return
  }
  const link = (e.links || []).find((l) => !/unsubscribe|\.(png|jpe?g|gif|svg|css)(\?|$)/i.test(l)) || e.links?.[0]
  const head = h('div', { class: 'view-head' },
    h('div', { class: 'view-title' },
      h('h1', { text: e.subject || '(no subject)' }),
      h('div', { class: 'view-actions' },
        h('button', { type: 'button', class: 'btn small', text: 'Send to my real inbox', onclick: () => { state.tab = 'inbox'; renderView() } }),
        h('a', { class: 'btn small', href: `/api/emails/${e.id}/source?download`, download: `${e.id}.eml`, text: 'Download .eml' }),
        h('button', { type: 'button', class: 'btn small danger', text: 'Delete', onclick: () => api(`/api/emails/${e.id}`, { method: 'DELETE' }) }),
      ),
    ),
    h('dl', { class: 'meta' },
      h('dt', { text: 'From' }), h('dd', { text: addr(e.from) || '(none)' }),
      h('dt', { text: 'To' }), h('dd', { text: e.to.map(addr).join(', ') || '(none)' }),
      e.cc.length ? [h('dt', { text: 'Cc' }), h('dd', { text: e.cc.map(addr).join(', ') })] : null,
      e.bcc.length ? [h('dt', { text: 'Bcc' }), h('dd', { text: e.bcc.map(addr).join(', ') })] : null,
      e.replyTo.length ? [h('dt', { text: 'Reply-To' }), h('dd', { text: e.replyTo.map(addr).join(', ') })] : null,
      h('dt', { text: 'Sent via' }), h('dd', { class: 'plain', text: `${VIA[e.via] || e.via} · ${ago(e.createdAt)} · ${bytes(e.size)}` }),
    ),
    (e.code || link) ? h('div', { class: 'chips' },
      e.code ? h('button', { type: 'button', class: 'chip code', title: 'Copy code', onclick: (ev) => copy(e.code, null).then(() => toast({ title: 'Code copied', sub: e.code })) }, 'Code ', h('strong', { text: e.code })) : null,
      link ? h('a', { class: 'chip', href: link, target: '_blank', rel: 'noopener noreferrer', title: link }, 'Link ', h('span', { class: 'mono', text: link })) : null,
    ) : null,
  )

  const tabs = [['html', 'HTML'], ['text', 'Text'], ['source', 'Source'], ['headers', 'Headers']]
  if (e.attachments.length) tabs.push(['attachments', `Attachments (${e.attachments.length})`])
  tabs.push(['webhooks', 'Webhooks'])
  const bar = h('div', { class: 'view-bar' },
    seg(tabs, state.tab, (id) => { state.tab = id; renderView() }),
    state.tab === 'html' ? h('div', { class: 'seg' },
      seg([['desktop', 'Desktop'], ['mobile', 'Mobile']], state.device, (id) => { state.device = id; renderView() }, 'toggle'),
      seg([['light', 'Light'], ['dark', 'Dark']], state.scheme, (id) => { state.scheme = id; renderView() }, 'toggle'),
    ) : null,
  )
  root.replaceChildren(head, bar, h('div', { class: 'stage' }, stage(e)))
}

function stage(e) {
  switch (state.tab) {
    case 'html': {
      const frame = h('iframe', {
        title: 'Email preview',
        sandbox: 'allow-popups allow-popups-to-escape-sandbox',
        referrerpolicy: 'no-referrer',
        src: `/api/emails/${e.id}/html?scheme=${state.scheme}`,
        style: { colorScheme: state.scheme },
      })
      frame.addEventListener('load', () => {
        // Sandboxed without same-origin, so height can't be read; size to a generous default.
        frame.style.height = state.device === 'mobile' ? '760px' : '720px'
      })
      return h('div', { class: `frame-wrap ${state.device}${state.scheme === 'dark' ? ' dark' : ''}` }, frame)
    }
    case 'text':
      return h('pre', { class: 'raw', text: e.text || '(This email has no plain-text part.)' })
    case 'source': {
      const pre = h('pre', { class: 'raw', text: 'Loading…' })
      fetch(`/api/emails/${e.id}/source`).then((r) => r.text()).then((t) => (pre.textContent = t))
      return pre
    }
    case 'headers':
      return h('table', { class: 'headers' }, h('tbody', {}, e.headers.map(([k, v]) => h('tr', {}, h('td', { text: k }), h('td', { text: v })))))
    case 'attachments':
      return h('div', { class: 'attachments' }, e.attachments.map((a) => h('div', { class: 'attachment' },
        h('span', {}, h('strong', { text: a.filename }), ' ', h('span', { class: 'muted', text: `${a.contentType} · ${bytes(a.size)}${a.inline ? ' · inline' : ''}` })),
        h('a', { class: 'btn small', href: `/api/emails/${e.id}/attachments/${a.id}?download`, download: a.filename, text: 'Download' }),
      )))
    case 'webhooks':
      return webhookPanel(e)
    case 'inbox':
      return inboxPanel(e)
  }
  return h('div')
}

// ---- Webhooks -------------------------------------------------------------------

const FORMAT_LABELS = { groundmail: 'Groundmail', sendgrid: 'SendGrid', postmark: 'Postmark', mailgun: 'Mailgun', resend: 'Resend', ses: 'Amazon SES (SNS)' }

function webhookPanel(e) {
  const settings = state.webhooks
  if (!settings) return h('p', { class: 'note', text: 'Loading…' })
  const auto = e.via === 'smtp' ? 'groundmail' : e.via
  const format = settings.format === 'auto' ? auto : settings.format
  const names = state.info?.providers?.[format]?.events || {}
  const url = h('input', { id: 'wh-url', class: 'input', type: 'url', placeholder: 'http://localhost:3000/api/webhooks/email', value: settings.url || '' })
  const select = h('select', { id: 'wh-format', class: 'input', style: { flex: '0 0 auto' } },
    h('option', { value: 'auto', text: `Match this email (${FORMAT_LABELS[auto]})` }),
    settings.formats.map((f) => h('option', { value: f, text: FORMAT_LABELS[f] || f })),
  )
  select.value = settings.format
  const save = async () => {
    try {
      state.webhooks = await api('/api/webhooks', { method: 'PUT', body: JSON.stringify({ url: url.value.trim() || null, format: select.value }) })
      renderView()
    } catch (err) {
      toast({ title: 'Could not save', sub: err.message, kind: 'shadow', warn: true })
    }
  }
  url.addEventListener('change', save)
  select.addEventListener('change', save)
  const autoBox = h('input', { type: 'checkbox', id: 'wh-auto', checked: settings.autoDelivered })
  autoBox.addEventListener('change', async () => {
    state.webhooks = await api('/api/webhooks', { method: 'PUT', body: JSON.stringify({ autoDelivered: autoBox.checked }) })
  })
  const fire = async (event) => {
    if (url.value.trim() !== (settings.url || '')) await save()
    try {
      await api(`/api/emails/${e.id}/webhooks`, { method: 'POST', body: JSON.stringify({ event }) })
    } catch (err) {
      toast({ title: 'Webhook not sent', sub: err.message, kind: 'shadow', warn: true })
    }
  }
  const verify = settings.verification?.[format] || {}
  return h('div', { class: 'panel' },
    h('div', { class: 'card' },
      h('h2', { text: 'Webhook simulation' }),
      h('p', { text: "Fire delivery events at your app's webhook handler, in the exact payload and signature format of the provider this email came through." }),
      h('div', { class: 'field' }, h('label', { for: 'wh-url', text: 'Your webhook URL' }), h('div', { class: 'field-row' }, url, select)),
      h('div', { class: 'events' }, EVENTS.map((ev) => h('button', { type: 'button', class: 'btn small', text: names[ev] || ev, onclick: () => fire(ev) }))),
      h('label', { class: 'note', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, autoBox, 'Send “delivered” automatically for every caught email'),
      h('div', { class: 'kv' },
        verify.header ? [h('span', { class: 'label', text: 'Signature header' }), h('code', { text: verify.header })] : null,
        verify.secret ? [h('span', { class: 'label', text: 'Signing secret' }), h('code', { text: verify.secret })] : null,
        verify.signingKey ? [h('span', { class: 'label', text: 'Signing key' }), h('code', { text: verify.signingKey })] : null,
        verify.publicKey ? [h('span', { class: 'label', text: 'Verification key' }), h('code', { text: verify.publicKey })] : null,
        verify.note ? [h('span', { class: 'label', text: 'Note' }), h('code', { text: verify.note })] : null,
      ),
      h('p', { class: 'note', text: 'Local dev keys only. Put them in your development env so your verification code runs unchanged.' }),
    ),
    h('div', { class: 'card' },
      h('h2', { text: 'Delivery log' }),
      state.deliveries.length ? h('div', { class: 'log' }, state.deliveries.map(deliveryRow)) : h('p', { text: 'Nothing fired yet for this email.' }),
    ),
  )
}

function deliveryRow(d) {
  const good = d.ok
  const status = d.status == null ? (d.error || 'failed') : `${d.status}${good ? ' OK' : ' from your app'}`
  return h('div', { class: 'log-row' },
    h('span', {}, h('strong', { text: d.eventName }), ` → ${d.eventId}`, h('span', { class: 'note', text: ` · ${FORMAT_LABELS[d.format] || d.format} · ${d.durationMs} ms` })),
    h('span', { class: good ? 'ok' : 'bad', text: status }),
    h('details', {}, h('summary', { text: `POST ${d.url}` }),
      h('pre', { text: `${Object.entries(d.requestHeaders).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${pretty(d.requestBody)}` }),
      d.responseBody ? h('pre', { text: `Response ${d.status ?? ''}\n\n${d.responseBody}` }) : null,
    ),
  )
}

function pretty(body) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

// ---- Send to my real inbox ------------------------------------------------------

function inboxPanel(e) {
  const account = state.account
  const to = h('input', { id: 'real-to', class: 'input', type: 'email', placeholder: 'you@yourcompany.com', value: state.sendTo || account.email || '' })
  to.addEventListener('input', () => (state.sendTo = to.value))
  const result = state.sendResult
  const send = async (button) => {
    button.disabled = true
    try {
      const sent = await api(`/api/emails/${e.id}/send-to-inbox`, { method: 'POST', body: JSON.stringify({ to: to.value.trim() || undefined }) })
      state.sendResult = { ok: true, text: `Sent from Groundmail's sandbox sender to ${sent.to}.` }
    } catch (err) {
      state.sendResult = { ok: false, text: err.message }
    }
    renderView()
  }
  const connect = async (button) => {
    button.disabled = true
    try {
      state.account = await api('/api/groundmail/connect', { method: 'POST' })
      if (state.account.pending) window.open(state.account.pending.url, '_blank', 'noopener')
    } catch (err) {
      state.sendResult = { ok: false, text: err.message }
    }
    renderView()
  }
  const sendButton = h('button', { type: 'button', class: 'btn primary', text: 'Send a copy' })
  sendButton.addEventListener('click', () => send(sendButton))
  const connectButton = h('button', { type: 'button', class: 'btn primary', text: 'Connect Groundmail' })
  connectButton.addEventListener('click', () => connect(connectButton))
  return h('div', { class: 'panel' },
    h('div', { class: 'card' },
      h('h2', { text: 'Send to my real inbox' }),
      h('p', { text: 'See this email in real Gmail or Outlook, sent through a free Groundmail account.' }),
      h('div', { class: 'field' }, h('label', { for: 'real-to', text: 'Send a copy to' }), h('div', { class: 'field-row' }, to, account.connected ? sendButton : null)),
      account.connected
        ? h('p', { class: 'note' }, `Connected to Groundmail${account.email ? ` as ${account.email}` : ''}. Copies come from the sandbox sender, which only delivers to your own address until you verify a domain, so this can't email real users by mistake. `,
            h('button', { type: 'button', class: 'linkish', style: { fontSize: '12px' }, text: 'Disconnect', onclick: async () => { state.account = await api('/api/groundmail/disconnect', { method: 'POST' }); renderView() } }))
        : account.pending
          ? h('div', { class: 'field' },
              h('p', {}, 'Approve code ', h('strong', { class: 'mono', text: account.pending.userCode }), ' in the browser. ',
                h('a', { href: account.pending.url, target: '_blank', rel: 'noopener', text: 'Open the Groundmail sign-in' }), '. This page updates when it’s done.'))
          : h('div', { class: 'field' },
              h('p', {}, 'Real sending goes through Groundmail. Connect a ',
                h('a', { href: 'https://app.groundmail.dev/signup?utm_source=groundhog&utm_medium=app&utm_campaign=real_inbox', target: '_blank', rel: 'noopener', text: 'free account' }),
                " once (3,000 emails a month free); Groundhog only uses it when you click send. It opens the Groundmail sign-in in your browser; there's no key to paste."),
              h('div', {}, connectButton)),
      result ? h('p', { class: result.ok ? 'ok-text' : 'bad-text', text: result.text }) : null,
      account.error && !result ? h('p', { class: 'bad-text', text: account.error }) : null,
    ),
  )
}

// ---- Failure mode ---------------------------------------------------------------

function renderFaults() {
  const f = state.faults
  const on = Boolean(f.kind && f.remaining > 0)
  const meta = FAULTS.find((x) => x.kind === f.kind)
  $('#fault-banner').hidden = !on
  $('#btn-faults').classList.toggle('warn', on)
  $('#btn-faults').textContent = on ? `Failure mode: ${meta.code}` : 'Failure mode'
  if (on) {
    const text = $('#fault-banner-text')
    text.replaceChildren(`Failure mode on: the next ${f.remaining} ${f.remaining === 1 ? 'send returns' : 'sends return'} `, h('strong', { text: meta.code }), ` (${meta.label.toLowerCase()}), on every provider API and SMTP. The banner stays until it's off.`)
  }
}

function renderFaultOptions() {
  $('#fault-options').replaceChildren(...FAULTS.map((f) => h('button', {
    type: 'button', role: 'radio', class: 'fault', 'aria-checked': String(state.faultChoice === f.kind),
    onclick: () => { state.faultChoice = f.kind; renderFaultOptions() },
  }, h('span', { class: 'code', style: { color: f.color }, text: f.code }), h('span', { text: f.label }), h('span', { class: 'desc', text: f.desc }))))
}

// ---- Wiring ---------------------------------------------------------------------

function setupDialogs() {
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog || event.target.closest('[data-close]')) dialog.close()
    })
  }
  $('#btn-golive').addEventListener('click', () => $('#dlg-golive').showModal())
  $('#btn-faults').addEventListener('click', () => {
    if (state.faults.kind) state.faultChoice = state.faults.kind
    renderFaultOptions()
    $('#fault-curl-url').textContent = base()
    $('#dlg-faults').showModal()
  })
  $('#fault-on').addEventListener('click', async () => {
    const next = Math.max(1, Number($('#fault-next').value) || 1)
    state.faults = await api('/api/faults', { method: 'POST', body: JSON.stringify({ kind: state.faultChoice, next }) })
    renderFaults()
    $('#dlg-faults').close()
  })
  $('#fault-off').addEventListener('click', async () => {
    state.faults = await api('/api/faults', { method: 'DELETE' })
    renderFaults()
  })
  $('#btn-clear').addEventListener('click', async () => {
    if (!state.emails.length) return
    await api('/api/emails', { method: 'DELETE' })
  })
  $('#search').addEventListener('input', (event) => {
    state.search = event.target.value
    renderList()
  })
}

function connectEvents() {
  const source = new EventSource('/api/events')
  const dots = () => document.querySelectorAll('.top .dot')
  source.addEventListener('open', () => dots().forEach((d) => d.classList.remove('off')))
  source.addEventListener('error', () => dots().forEach((d) => d.classList.add('off')))
  source.addEventListener('email', (event) => {
    const email = JSON.parse(event.data)
    state.emails = [email, ...state.emails.filter((e) => e.id !== email.id)]
    state.fresh.add(email.id)
    const first = state.emails.length === 1
    renderLayout()
    if (first || !state.selected) select(email.id)
    else renderList()
    toast({ title: 'Caught one', sub: `${email.subject || '(no subject)'} → ${email.to[0]?.address || '(nobody)'} (${VIA[email.via] || email.via})`, onClick: () => select(email.id) })
  })
  source.addEventListener('delete', (event) => {
    const { id } = JSON.parse(event.data)
    state.emails = state.emails.filter((e) => e.id !== id)
    if (state.selected === id) {
      state.selected = null
      state.current = null
      if (state.emails[0]) select(state.emails[0].id)
    }
    renderLayout()
    renderList()
    renderView()
  })
  source.addEventListener('clear', () => {
    state.emails = []
    state.selected = null
    state.current = null
    renderLayout()
    renderList()
  })
  source.addEventListener('faults', (event) => {
    state.faults = JSON.parse(event.data)
    renderFaults()
  })
  source.addEventListener('fault-fired', (event) => {
    const fired = JSON.parse(event.data)
    const meta = FAULTS.find((x) => x.kind === fired.kind)
    toast({ title: `Simulated ${meta?.code ?? ''} ${meta?.label.toLowerCase() ?? ''}`, sub: `${VIA[fired.provider] || fired.provider} send failed on purpose`, kind: 'shadow', warn: true })
  })
  source.addEventListener('webhook', (event) => {
    const entry = JSON.parse(event.data)
    if (entry.emailId === state.selected) {
      state.deliveries = [entry, ...state.deliveries.filter((d) => d.id !== entry.id)]
      if (state.tab === 'webhooks') renderView()
    }
    if (!entry.ok) toast({ title: `${entry.eventName} webhook: ${entry.status ?? 'no answer'}`, sub: entry.error || `${entry.url} answered ${entry.status}`, kind: 'shadow', warn: true })
  })
  source.addEventListener('webhook-settings', (event) => {
    state.webhooks = { ...state.webhooks, ...JSON.parse(event.data) }
  })
  source.addEventListener('account', (event) => {
    state.account = JSON.parse(event.data)
    if (state.tab === 'inbox') renderView()
  })
}

async function init() {
  setupDialogs()
  const [info, list, faults, webhooks, account] = await Promise.all([
    api('/api/info'),
    api('/api/emails?summary=1&limit=500'),
    api('/api/faults'),
    api('/api/webhooks'),
    api('/api/groundmail'),
  ])
  state.info = info
  state.emails = list.data
  state.faults = faults
  state.webhooks = webhooks
  state.account = account
  $('#version').textContent = info.version
  $('#pill-smtp span:last-child').textContent = `SMTP :${info.smtpPort}`
  $('#pill-api span:last-child').textContent = `API :${info.httpPort}`
  renderFaults()
  renderLayout()
  renderList()
  const wanted = location.hash.slice(1)
  const first = state.emails.find((e) => e.id === wanted) || state.emails[0]
  if (first) await select(first.id)
  connectEvents()
  setInterval(() => {
    if (state.emails.length) document.querySelectorAll('.row-time').forEach((el, i) => {
      const e = visibleEmails()[i]
      if (e) el.textContent = ago(e.createdAt)
    })
  }, 30_000)
}

init().catch((error) => {
  document.body.prepend(h('p', { style: { padding: '16px', color: '#ef7a6e' }, text: `Groundhog UI failed to load: ${error.message}` }))
})
