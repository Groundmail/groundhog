import { describe, expect, it } from 'vitest'
import { extractCode, extractLinks, pickLink } from '../src/extract.js'

describe('extractCode', () => {
  it.each([
    ['Your code is 482913', '482913'],
    ['Your verification code: 604 112.', '604112'],
    ['Use 123-456 to sign in', '123456'],
    ['Enter PIN 4821 to continue', '4821'],
    ['Your one-time passcode is X7K9PQ', 'X7K9PQ'],
    ['<p>Code</p><div style="font-size:30px">839224</div>', '839224'],
  ])('%s', (input, code) => {
    expect(extractCode(input)).toBe(code)
  })

  it('ignores years, prices, order numbers, colors and URLs', () => {
    expect(extractCode('© 2026 Acme. We received $20.00 for order #1042.')).toBeNull()
    expect(extractCode('<div style="color:#111827">Hello</div>')).toBeNull()
    expect(extractCode('Open http://localhost:3000/invite/123456 to join')).toBeNull()
    expect(extractCode('Invoice number 99812 is attached')).toBeNull()
  })

  it('prefers the number next to a code word', () => {
    expect(extractCode({ subject: 'Welcome', text: 'Ticket 555123 is open. Your sign-in code is 908172.' })).toBe('908172')
  })

  it('looks at the subject too', () => {
    expect(extractCode({ subject: '771204 is your Acme code', text: 'Hi' })).toBe('771204')
  })
})

describe('extractLinks', () => {
  it('finds hrefs and bare URLs once, decoding entities', () => {
    const html = '<a href="https://app.test/verify?t=1&amp;u=2">Verify</a> <a href=\'https://app.test/verify?t=1&u=2\'>again</a> or go to https://app.test/help.'
    expect(extractLinks({ html, text: null })).toEqual(['https://app.test/verify?t=1&u=2', 'https://app.test/help'])
  })

  it('skips mailto and anchors', () => {
    expect(extractLinks({ html: '<a href="mailto:a@b.c">m</a><a href="#top">t</a><a href="http://x.test/">x</a>' })).toEqual(['http://x.test/'])
  })

  it('pickLink skips unsubscribe and image links unless asked', () => {
    const links = ['https://x.test/logo.png', 'https://x.test/unsubscribe?u=1', 'https://x.test/reset?t=9']
    expect(pickLink(links)).toBe('https://x.test/reset?t=9')
    expect(pickLink(links, 'unsubscribe')).toBe('https://x.test/unsubscribe?u=1')
    expect(pickLink([])).toBeNull()
  })
})
