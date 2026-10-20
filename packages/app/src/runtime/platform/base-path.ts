import { BasePath } from "@opencode/util/base-path"

/** Read the mount supplied by the native web host, independent of the current SPA route. */
export function basePath() {
  return BasePath.current()
}

/** Solid Router retains a trailing slash when joining absolute route paths. */
export function routerBasePath() {
  return basePath().slice(0, -1)
}

/** Router locations include its base; domain route parsing remains mount-independent. */
export function routePath(pathname: string) {
  const base = basePath()
  if (base === "/") return pathname
  if (pathname === base.slice(0, -1)) return "/"
  return pathname.startsWith(base) ? `/${pathname.slice(base.length)}` : pathname
}
