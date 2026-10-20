import { BrowserStorage } from "@opencode/util/browser-storage"
import { basePath, routerBasePath } from "../src/runtime/platform/base-path"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { A, MemoryRouter, createMemoryHistory, useNavigate } from "@solidjs/router"
import { createComponent, render } from "solid-js/web"
import { createEffect } from "solid-js"
import { useCurrentRoute } from "../src/shell/state/layout"
import { isStandalone, PwaRoutePersistence, restorePwaRoute } from "../src/runtime/platform/pwa"

const key = "opencode.pwa.last-route"

const originalUrl = window.location.href

beforeEach(() => {
  window.location.href = "http://localhost/"
})

afterEach(() => {
  document.querySelector("base")?.remove()
  localStorage.removeItem(key)
  window.location.href = originalUrl
})

test("normal browser windows are not standalone", () => {
  expect(isStandalone()).toBe(false)
})

test("detects iOS home-screen apps when the standalone media query does not match", () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "standalone")
  Object.defineProperty(navigator, "standalone", { configurable: true, value: true })

  try {
    expect(window.matchMedia("(display-mode: standalone)").matches).toBe(false)
    expect(isStandalone()).toBe(true)
  } finally {
    if (descriptor) Object.defineProperty(navigator, "standalone", descriptor)

    if (!descriptor) delete (navigator as Navigator & { standalone?: boolean }).standalone
  }
})

test("restores the last PWA route including query and hash without adding history", () => {
  window.history.replaceState({ retained: true }, "", "http://localhost/")
  const length = window.history.length
  localStorage.setItem(key, "/server/local/session/session-1?view=files#file")

  restorePwaRoute()

  expect(window.location.pathname + window.location.search + window.location.hash).toBe(
    "/server/local/session/session-1?view=files#file",
  )
  expect(window.history.length).toBe(length)
  expect(window.history.state).toEqual({ retained: true })
})

test("preserves explicit launch routes, queries, and hashes", () => {
  localStorage.setItem(key, "/server/local/session/saved")

  for (const route of ["/server/local/session/linked", "/new-session?draftId=123", "/?launch=1", "/#launch"]) {
    window.history.replaceState(null, "", `http://localhost${route}`)
    restorePwaRoute()
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(route)
  }
})

test("ignores missing, invalid, external, and auth-bearing saved routes", () => {
  window.history.replaceState(null, "", "http://localhost/")
  restorePwaRoute()
  expect(window.location.pathname).toBe("/")

  for (const value of [
    "/removed-route",
    "https://example.com/new-session",
    "//example.com/new-session",
    "http://[",
    "/new-session?auth_token=secret",
  ]) {
    localStorage.setItem(key, value)
    restorePwaRoute()
    expect(window.location.href).toBe("http://localhost/")
  }
})

test("persists router navigation including returning home", async () => {
  const host = document.createElement("div")
  const history = createMemoryHistory()
  history.set({ value: "/new-session?draftId=123", replace: true, scroll: false })
  const dispose = render(() => createComponent(MemoryRouter, { history, root: PwaRoutePersistence }), host)

  try {
    expect(localStorage.getItem(key)).toBe("/new-session?draftId=123")
    history.set({ value: "/server/local/session/next#file", scroll: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(localStorage.getItem(key)).toBe("/server/local/session/next#file")
    history.set({ value: "/", scroll: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(localStorage.getItem(key)).toBe("/")
  } finally {
    dispose()
  }
})

test("restores only routes within the hosted mount and persists prefixed router navigation", async () => {
  const base = document.createElement("base")
  base.href = "/computer/"
  document.head.append(base)
  window.history.replaceState(null, "", "http://localhost/computer/")
  localStorage.setItem(key, "/server/local/session/foreign")
  restorePwaRoute()
  expect(window.location.pathname).toBe("/computer/")
  const mountedKey = BrowserStorage.namespace().key(key)
  localStorage.setItem(mountedKey, "/computer/server/local/session/saved")
  restorePwaRoute()
  expect(window.location.pathname).toBe("/computer/server/local/session/saved")

  const host = document.createElement("div")
  const history = createMemoryHistory()
  history.set({ value: "/computer/new-session?draftId=123", replace: true, scroll: false })
  const Root = () => {
    const route = useCurrentRoute()
    const label = document.createElement("output")
    createEffect(() => {
      label.textContent = route().type
    })
    return [label, createComponent(PwaRoutePersistence, {})]
  }
  const dispose = render(() => createComponent(MemoryRouter, { base: "/computer/", history, root: Root }), host)
  try {
    expect(localStorage.getItem(mountedKey)).toBe("/computer/new-session?draftId=123")
    expect(host.textContent).toBe("draft")
    history.set({ value: "/computer/", scroll: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(localStorage.getItem(mountedKey)).toBe("/computer/")
    expect(host.textContent).toBe("home")
  } finally {
    dispose()
    localStorage.removeItem(mountedKey)
  }
})

test("router links and navigation join root and hosted mounts with one separator", async () => {
  for (const mount of ["/", "/computer/c/opaque-id/"]) {
    const base = document.createElement("base")
    base.href = mount
    document.head.append(base)
    const host = document.createElement("div")
    const history = createMemoryHistory()
    history.set({ value: mount, replace: true, scroll: false })
    const navigation: ReturnType<typeof useNavigate>[] = []
    const Root = () => {
      navigation.push(useNavigate())
      return [
        createComponent(A, { href: "/settings", children: "Settings" }),
        createComponent(A, { href: "/new-session", children: "New session" }),
      ]
    }
    const dispose = render(() => createComponent(MemoryRouter, { base: routerBasePath(), history, root: Root }), host)
    try {
      // The HTML/assets/PWA mount retains its canonical trailing slash.
      expect(basePath()).toBe(mount)
      expect(Array.from(host.querySelectorAll("a"), (link) => link.getAttribute("href"))).toEqual([
        `${mount}settings`,
        `${mount}new-session`,
      ])
      for (const route of ["settings", "new-session?draftId=123#draft"]) {
        navigation[0](`/${route}`)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(history.get()).toBe(`${mount}${route}`)
      }
    } finally {
      dispose()
      base.remove()
    }
  }
})
