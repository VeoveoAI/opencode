export * as BasePath from "./base-path.js"

/** The externally visible mount path. The HTTP gateway strips it before forwarding. */
export function normalize(value = "/") {
  if (!value.startsWith("/") || value.startsWith("//") || /[\\?#\s<>"']/.test(value))
    throw new Error("Base path must be an absolute URL path without a query or fragment")
  const path = value.endsWith("/") ? value : `${value}/`
  if (new URL(path, "http://localhost").pathname !== path)
    throw new Error("Base path must not contain URL normalization segments")
  for (const segment of path.split("/").slice(1, -1)) {
    const decoded = decodeURIComponent(segment)
    if (!decoded || decoded === "." || decoded === ".." || /[/\\]/.test(decoded))
      throw new Error("Base path must contain nonempty URL path segments")
  }
  return path
}

/** Read the native web host's mount without deriving it from an SPA route. */
export function current() {
  return normalize(
    typeof document === "undefined" ? "/" : (document.querySelector("base")?.getAttribute("href") ?? "/"),
  )
}
