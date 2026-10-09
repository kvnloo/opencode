import { describe, expect, test } from "bun:test"
import { DEFAULT_CSP, csp, cspForHtml } from "../../src/server/shared/ui"

describe("embedded UI CSP", () => {
  test("allows same-origin blob iframes through frame-src", () => {
    expect(DEFAULT_CSP).toContain("frame-src 'self' blob:")
  })

  test("keeps frame-src when a theme preload hash is added", () => {
    const policy = csp("abc123")
    expect(policy).toContain("frame-src 'self' blob:")
    expect(policy).toContain("'sha256-abc123'")
  })

  test("cspForHtml keeps frame-src for documents with a theme preload script", () => {
    const body = '<script id="oc-theme-preload-script">document.title = "test"</script>'
    const policy = cspForHtml(body)
    expect(policy).toContain("frame-src 'self' blob:")
    expect(policy).toContain("'sha256-")
  })
})
