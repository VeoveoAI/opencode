export * as BrowserStorage from "./browser-storage.js"

import { BasePath } from "./base-path.js"

const MOUNT_PREFIX = "opencode.mount:"

/** UI cache separation for mounted apps, not an origin or authorization boundary. */
export function namespace(basePath = BasePath.current()) {
  const mount = BasePath.normalize(basePath)
  const prefix = mount === "/" ? "" : `${MOUNT_PREFIX}${encodeURIComponent(mount)}:`
  return {
    key: (name: string) => prefix + name,
    owns: (name: string) =>
      prefix ? name.startsWith(prefix) : name.startsWith("opencode.") && !name.startsWith(MOUNT_PREFIX),
  }
}
