import { BrowserStorage } from "@opencode/util/browser-storage"
import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/oc-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

const setSystemDark = (matches: boolean) =>
  Object.defineProperty(window, "matchMedia", {
    value: () => ({ matches }) as MediaQueryList,
    configurable: true,
  })

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  document.documentElement.style.removeProperty("background-color")
  localStorage.clear()
  setSystemDark(false)
})

describe("theme preload", () => {
  test.each([
    { stored: undefined, systemDark: false, scheme: "light", background: "#fafafa" },
    { stored: "dark", systemDark: false, scheme: "dark", background: "#080808" },
    { stored: "light", systemDark: true, scheme: "light", background: "#fafafa" },
    { stored: "system", systemDark: true, scheme: "dark", background: "#080808" },
  ])(
    "paints the default theme in $scheme for stored scheme $stored (system dark: $systemDark)",
    ({ stored, systemDark, scheme, background }) => {
      setSystemDark(systemDark)

      if (stored) localStorage.setItem("opencode-color-scheme", stored)
      run()

      expect(document.documentElement.dataset.theme).toBe("oc-2")
      expect(document.documentElement.dataset.colorScheme).toBe(scheme)
      expect(document.documentElement.style.backgroundColor).toBe(background)
    },
  )

  test.each([
    { scheme: undefined, key: "opencode-theme-css-light", css: "--background-base:#fff;", expected: "light" },
    { scheme: "dark", key: "opencode-theme-css-dark", css: "--background-base:#010203;", expected: "dark" },
  ])("restores the cached $expected css of a custom theme", ({ scheme, key, css, expected }) => {
    localStorage.setItem("opencode-theme-id", "nightowl")

    if (scheme) localStorage.setItem("opencode-color-scheme", scheme)
    localStorage.setItem(key, css)
    run()

    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(document.documentElement.dataset.colorScheme).toBe(expected)
    expect(document.getElementById("oc-theme-preload")?.textContent).toContain(css)
  })
})

test("hosted mounts restore only their own theme cache and never import root preferences", () => {
  localStorage.setItem("opencode-theme-id", "nightowl")
  localStorage.setItem("opencode-color-scheme", "dark")
  const base = document.createElement("base")
  document.head.append(base)
  for (const [mount, theme, scheme] of [
    ["/mount/a/", "nord", "light"],
    ["/mount/b/", "vesper", "dark"],
  ]) {
    base.setAttribute("href", mount)
    const namespace = BrowserStorage.namespace()
    localStorage.setItem(namespace.key("opencode-theme-id"), theme)
    localStorage.setItem(namespace.key("opencode-color-scheme"), scheme)
  }
  for (const [mount, theme, scheme] of [
    ["/mount/a/", "nord", "light"],
    ["/mount/b/", "vesper", "dark"],
    ["/mount/empty/", "oc-2", "light"],
  ]) {
    base.setAttribute("href", mount)
    run()
    expect(document.documentElement.dataset.theme).toBe(theme)
    expect(document.documentElement.dataset.colorScheme).toBe(scheme)
  }
  expect(localStorage.getItem("opencode-theme-id")).toBe("nightowl")
})
