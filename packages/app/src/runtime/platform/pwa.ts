import { BrowserStorage } from "@opencode/util/browser-storage"
import { basePath } from "./base-path"
import { useLocation } from "@solidjs/router"
import { createEffect } from "solid-js"

const LAST_ROUTE_KEY = "opencode.pwa.last-route"

export function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && navigator.standalone === true)
  )
}

export function restorePwaRoute() {
  const base = basePath()
  if (location.pathname !== base || location.search || location.hash) return

  try {
    const value = localStorage.getItem(BrowserStorage.namespace().key(LAST_ROUTE_KEY))

    if (!value) return
    const url = new URL(value, location.origin)

    if (url.origin !== location.origin || url.searchParams.has("auth_token") || !url.pathname.startsWith(base)) return
    const pathname = `/${url.pathname.slice(base.length)}`

    if (pathname !== "/" && pathname !== "/new-session" && !/^\/server\/[^/]+\/session\/[^/]+$/.test(pathname)) return
    history.replaceState(history.state, "", url.pathname + url.search + url.hash)
  } catch {
    // Storage may be unavailable; keep the launch URL in that case.
  }
}

export function PwaRoutePersistence() {
  const location = useLocation()
  const namespace = BrowserStorage.namespace()
  createEffect(() => {
    const value = location.pathname + location.search + location.hash

    try {
      localStorage.setItem(namespace.key(LAST_ROUTE_KEY), value)
    } catch {
      // Navigation must still work when storage is unavailable or full.
    }
  })

  return null
}

/** Outer-authenticated mounts must reach their gateway on every navigation. */
export function registerServiceWorker() {
  if (document.querySelector('meta[name="opencode-cache"]')?.getAttribute("content") === "online-only") return
  if (!("serviceWorker" in navigator)) return
  window.addEventListener(
    "load",
    () => void navigator.serviceWorker.register(`${basePath()}sw.js`, { scope: basePath() }),
    { once: true },
  )
}
