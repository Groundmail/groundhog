import type { IncomingMessage, ServerResponse } from 'node:http'
import busboy from 'busboy'

export const MAX_BODY_BYTES = 60 * 1024 * 1024

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export type HttpResult = {
  status: number
  headers?: Record<string, string>
  body?: unknown
}

export type MultipartFile = { field: string; filename: string; contentType: string; content: Buffer }

export type MultipartForm = { fields: Array<[string, string]>; files: MultipartFile[] }

export class RequestContext {
  readonly url: URL
  params: Record<string, string> = {}
  private bodyPromise: Promise<Buffer> | null = null

  constructor(
    readonly req: IncomingMessage,
    readonly res: ServerResponse,
  ) {
    this.url = new URL(req.url ?? '/', 'http://localhost')
  }

  get method(): string {
    return (this.req.method ?? 'GET').toUpperCase()
  }

  header(name: string): string {
    const value = this.req.headers[name.toLowerCase()]
    return Array.isArray(value) ? value.join(', ') : (value ?? '')
  }

  query(name: string): string | undefined {
    return this.url.searchParams.get(name) ?? undefined
  }

  body(): Promise<Buffer> {
    if (!this.bodyPromise) {
      this.bodyPromise = new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        this.req.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            reject(new HttpError(413, 'Request body is too large'))
            this.req.destroy()
            return
          }
          chunks.push(chunk)
        })
        this.req.on('end', () => resolve(Buffer.concat(chunks)))
        this.req.on('error', reject)
      })
    }
    return this.bodyPromise
  }

  async json<T = Record<string, unknown>>(): Promise<T> {
    const raw = await this.body()
    if (!raw.length) return {} as T
    try {
      return JSON.parse(raw.toString('utf8')) as T
    } catch {
      throw new HttpError(400, 'The request body is not valid JSON')
    }
  }

  /** application/x-www-form-urlencoded, as ordered pairs (keys repeat). */
  async formPairs(): Promise<Array<[string, string]>> {
    const raw = await this.body()
    return [...new URLSearchParams(raw.toString('utf8')).entries()]
  }

  async multipart(): Promise<MultipartForm> {
    const contentType = this.header('content-type')
    if (!contentType.toLowerCase().startsWith('multipart/')) {
      return { fields: await this.formPairs(), files: [] }
    }
    const raw = await this.body()
    return new Promise((resolve, reject) => {
      const form: MultipartForm = { fields: [], files: [] }
      const parser = busboy({ headers: { 'content-type': contentType }, limits: { fileSize: MAX_BODY_BYTES, fieldSize: MAX_BODY_BYTES } })
      parser.on('field', (name, value) => form.fields.push([name, value]))
      parser.on('file', (name, stream, info) => {
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () =>
          form.files.push({ field: name, filename: info.filename || 'attachment', contentType: info.mimeType || 'application/octet-stream', content: Buffer.concat(chunks) }),
        )
      })
      parser.on('close', () => resolve(form))
      parser.on('error', reject)
      parser.end(raw)
    })
  }

  send(result: HttpResult): void {
    if (this.res.headersSent) return
    const headers: Record<string, string> = { ...(result.headers ?? {}) }
    let payload: string | Buffer = ''
    if (Buffer.isBuffer(result.body)) payload = result.body
    else if (typeof result.body === 'string') payload = result.body
    else if (result.body !== undefined) {
      payload = JSON.stringify(result.body)
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json; charset=utf-8'
    }
    this.res.writeHead(result.status, headers)
    this.res.end(payload)
  }
}

export type Handler = (ctx: RequestContext) => Promise<HttpResult | void> | HttpResult | void

export type Route = {
  method: string
  /** Path with `:params`, e.g. `/emails/:id`. A trailing `*` matches the rest. */
  path: string
  handler: Handler
}

export function compileRoute(path: string): RegExp {
  const pattern = path
    .split('/')
    .map((segment) => {
      if (segment === '*') return '(?<rest>.*)'
      if (segment.startsWith(':')) return `(?<${segment.slice(1)}>[^/]+)`
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return new RegExp(`^${pattern}/?$`)
}

export class Router {
  private routes: Array<Route & { regex: RegExp }> = []

  add(method: string, path: string, handler: Handler): this {
    this.routes.push({ method: method.toUpperCase(), path, handler, regex: compileRoute(path) })
    return this
  }

  get(path: string, handler: Handler) {
    return this.add('GET', path, handler)
  }
  post(path: string, handler: Handler) {
    return this.add('POST', path, handler)
  }
  put(path: string, handler: Handler) {
    return this.add('PUT', path, handler)
  }
  delete(path: string, handler: Handler) {
    return this.add('DELETE', path, handler)
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | 'method' | null {
    let pathMatched = false
    for (const route of this.routes) {
      const match = route.regex.exec(pathname)
      if (!match) continue
      pathMatched = true
      if (route.method !== method && !(route.method === 'GET' && method === 'HEAD')) continue
      const params: Record<string, string> = {}
      for (const [key, value] of Object.entries(match.groups ?? {})) params[key] = decodeURIComponent(value ?? '')
      return { route, params }
    }
    return pathMatched ? 'method' : null
  }
}
