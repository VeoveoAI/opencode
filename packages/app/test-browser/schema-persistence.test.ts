import { BrowserStorage } from "@opencode/util/browser-storage"
import { describe, expect, test } from "bun:test"
import { Schema, SchemaGetter } from "effect"
import { createComputed, createRoot } from "solid-js"
import type { Platform } from "@/runtime/platform/platform"
import { flushPersisted } from "@/runtime/persistence/persist"
import { Persist, persisted, removePersisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"
import { TabStorage } from "@/shell/tabs/schema"

const Current = Schema.Struct({
  enabled: Schema.Boolean,
  label: Schema.String,
})

const initial = { enabled: true, label: "default" }

const Stored = Persistence.migrate(
  Current,
  Persistence.legacy({ oldLabel: Schema.optional(Schema.String), label: Schema.optional(Schema.String) }).pipe(
    Schema.decode({
      decode: SchemaGetter.transform((value) =>
        value.oldLabel === undefined ? value : { ...value, label: value.oldLabel },
      ),
      encode: SchemaGetter.passthrough(),
    }),
  ),
)

const web: Platform = {
  platform: "web",
  openExternal: () => undefined,
  restart: async () => undefined,
  notify: async () => undefined,
}

function desktop() {
  const values = new Map<string, string>()

  const platform: Platform = {
    ...web,
    platform: "desktop",
    windowID: "schema-test",
    openDirectoryPickerDialog: async () => null,
    storage: (name) => ({
      getItem: async (key) => values.get(`${name}:${key}`) ?? null,
      setItem: async (key, value) => void values.set(`${name}:${key}`, value),
      removeItem: async (key) => void values.delete(`${name}:${key}`),
    }),
  }

  return { values, platform }
}

describe("schema-backed persistence", () => {
  test("clears the recent tab after restoring it from storage", () => {
    const target = Persist.global("schema-recent-clear")
    const key = `${target.storage}:${target.key}`
    localStorage.setItem(key, JSON.stringify({ key: "session-tab" }))
    createRoot((dispose) => {
      const [state, setState] = persisted(target, TabStorage.Recent, { key: undefined }, web)

      try {
        expect(state.key).toBe("session-tab")
        setState("key", undefined)
        expect(state.key).toBeUndefined()
        flushPersisted()
        expect(localStorage.getItem(key)).toBe("{}")
      } finally {
        dispose()
      }
    })
  })

  test("migrates sync storage and writes only the current representation", () => {
    const target = Persist.global("schema-sync")
    const key = `${target.storage}:${target.key}`
    localStorage.setItem(key, JSON.stringify({ oldLabel: "saved" }))
    createRoot((dispose) => {
      const [state, setState, , ready] = persisted(target, Stored, initial, web)
      expect(ready.promise).toBeUndefined()
      expect(state).toEqual({ enabled: true, label: "saved" })
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ enabled: true, label: "saved" })
      setState("enabled", false)
      flushPersisted()
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ enabled: false, label: "saved" })
      dispose()
    })
  })

  test("keeps valid current fields that the migration reader does not name", () => {
    const target = Persist.global("schema-unnamed-field")
    const key = `${target.storage}:${target.key}`
    localStorage.setItem(key, JSON.stringify({ enabled: false, label: "kept" }))
    createRoot((dispose) => {
      const [state] = persisted(target, Stored, initial, web)
      expect(state).toEqual({ enabled: false, label: "kept" })
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ enabled: false, label: "kept" })
      dispose()
    })
  })

  test("recovers invalid fields and strips fields outside the schema", () => {
    const target = Persist.global("schema-invalid-field")
    localStorage.setItem(
      `${target.storage}:${target.key}`,
      JSON.stringify({ enabled: "false", label: "kept", extra: 1 }),
    )
    createRoot((dispose) => {
      const [state] = persisted(target, Stored, initial, web)
      expect(state).toEqual({ enabled: true, label: "kept" })
      dispose()
    })
  })

  test("malformed JSON falls back to a typed initial state", () => {
    const target = Persist.global("schema-invalid-json")
    localStorage.setItem(`${target.storage}:${target.key}`, '{"label":"\\x"}')
    createRoot((dispose) => {
      const [state] = persisted(target, Stored, { enabled: false, label: "initial" }, web)
      expect(state).toEqual({ enabled: false, label: "initial" })
      expect(localStorage.getItem(`${target.storage}:${target.key}`)).toBeNull()
      dispose()
    })
  })

  test("relocates and canonicalizes desktop state before becoming ready", async () => {
    const storage = desktop()
    storage.values.set("undefined:old-schema", JSON.stringify({ oldLabel: "desktop" }))

    const root = createRoot((dispose) => ({
      dispose,
      state: persisted(
        { ...Persist.global("schema-desktop"), previousKey: "old-schema" },
        Stored,
        initial,
        storage.platform,
      ),
    }))

    try {
      expect(root.state[3]()).toBe(false)
      await root.state[3].promise
      expect(root.state[0]).toEqual({ enabled: true, label: "desktop" })
      expect(storage.values.has("undefined:old-schema")).toBe(false)
      expect(JSON.parse(storage.values.get("opencode.global.dat:schema-desktop")!)).toEqual({
        enabled: true,
        label: "desktop",
      })
      root.state[1]("label", "changed")
      flushPersisted()
      expect(JSON.parse(storage.values.get("opencode.global.dat:schema-desktop")!)).toEqual({
        enabled: true,
        label: "changed",
      })
    } finally {
      root.dispose()
    }
  })

  test("a late desktop read does not overwrite an edit made while loading", async () => {
    const pending = Promise.withResolvers<string | null>()
    const storage = desktop()
    storage.platform.storage = () => ({
      getItem: () => pending.promise,
      setItem: async () => undefined,
      removeItem: async () => undefined,
    })

    const root = createRoot((dispose) => ({
      dispose,
      state: persisted(Persist.global("schema-late"), Stored, initial, storage.platform),
    }))

    try {
      root.state[1]("label", "new edit")
      pending.resolve(JSON.stringify({ oldLabel: "old state" }))
      await root.state[3].promise
      expect(root.state[0].label).toBe("new edit")
    } finally {
      root.dispose()
    }
  })

  test("a full or failing storage scope stops writing without disabling other scopes", () => {
    const full = Persist.workspace("/schema-storage-full", "state")
    const failing = Persist.workspace("/schema-storage-failing", "state")
    const healthy = Persist.workspace("/schema-storage-healthy", "state")
    const direct = "schema-storage-direct"
    const values = new Map<string, string>()
    const attempts: string[] = []

    const storage: Storage = {
      get length() {
        return values.size
      },
      key: (index) => [...values.keys()][index] ?? null,
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        attempts.push(key)

        if (key.startsWith(`${full.storage}:`)) throw new DOMException("quota", "QuotaExceededError")

        if (key.startsWith(`${failing.storage}:`)) throw new Error("storage set failed")
        values.set(key, value)
      },
      removeItem: (key) => void values.delete(key),
    }

    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true })

    try {
      createRoot((dispose) => {
        const [, setFull] = persisted(full, Current, initial, web)
        const [, setFailing] = persisted(failing, Current, initial, web)

        const count = () => ({
          full: attempts.filter((key) => key === `${full.storage}:${full.key}`).length,
          failing: attempts.filter((key) => key === `${failing.storage}:${failing.key}`).length,
        })

        setFull("label", "full")
        setFailing("label", "first")
        flushPersisted()
        const first = count()
        expect(first.full).toBeGreaterThan(0)
        expect(first.failing).toBeGreaterThan(0)
        setFull("label", "full again")
        setFailing("label", "second")
        flushPersisted()
        expect(count()).toEqual(first)

        const [, setHealthy] = persisted(healthy, Current, initial, web)
        const [, setDirect] = persisted(direct, Current, initial, web)
        setHealthy("label", "healthy")
        setDirect("label", "direct")
        flushPersisted()
        expect(values.get(`${healthy.storage}:${healthy.key}`)).toBe(
          JSON.stringify({ enabled: true, label: "healthy" }),
        )
        expect(values.get(direct)).toBe(JSON.stringify({ enabled: true, label: "direct" }))
        dispose()
      })
      expect(values.has(`${full.storage}:${full.key}`)).toBe(false)
      createRoot((dispose) => {
        const [state] = persisted(full, Current, initial, web)
        expect(state).toEqual(initial)
        dispose()
      })
    } finally {
      Object.defineProperty(globalThis, "localStorage", original)
    }
  })

  test("cross-window updates use the same migration and validation boundary", async () => {
    const target = { ...Persist.global("schema-sync-channel"), sync: true }
    const channel = new BroadcastChannel(`opencode.persist:${target.storage}:${target.key}`)
    const received = Promise.withResolvers<void>()
    const values: unknown[] = []

    const root = createRoot((dispose) => {
      const [state] = persisted(target, Stored, initial, web)
      createComputed(() => {
        values.push({ enabled: state.enabled, label: state.label })

        if (state.label === "from another window") received.resolve()
      })

      return { dispose, state }
    })

    try {
      channel.postMessage({ key: target.key, newValue: JSON.stringify({ enabled: "false", label: "recovered" }) })
      channel.postMessage({ key: target.key, newValue: JSON.stringify({ oldLabel: "from another window" }) })
      await received.promise
      expect(root.state).toEqual({ enabled: true, label: "from another window" })
      expect(values).toContainEqual({ enabled: true, label: "recovered" })
      expect(values).toContainEqual({ enabled: true, label: "from another window" })
    } finally {
      channel.close()
      root.dispose()
    }
  })
})

test("mounted relocation and removal never read or erase another mount or root", () => {
  const base = document.createElement("base")
  base.setAttribute("href", "/mount/relocation/")
  document.head.append(base)
  const namespace = BrowserStorage.namespace()
  const target = {
    ...Persist.global(`mount-copy-${crypto.randomUUID()}`),
    previousKey: "mount-previous",
    copyFrom: [{ key: "mount-copy" }],
  }
  const root = JSON.stringify({ enabled: true, label: "root" })
  localStorage.setItem("mount-previous", root)
  localStorage.setItem("mount-copy", root)
  localStorage.setItem(namespace.key("mount-copy"), JSON.stringify({ enabled: true, label: "own" }))
  createRoot((dispose) => {
    try {
      const [state] = persisted(target, Current, initial, web)
      expect(state.label).toBe("own")
      localStorage.setItem(namespace.key("mount-previous"), JSON.stringify({ enabled: true, label: "stale" }))
      removePersisted(target, web)
      expect(localStorage.getItem(namespace.key(`${target.storage}:${target.key}`))).toBeNull()
      expect(localStorage.getItem(namespace.key("mount-previous"))).toBeNull()
      expect(localStorage.getItem(namespace.key("mount-copy"))).toBeNull()
      expect(localStorage.getItem("mount-previous")).toBe(root)
      expect(localStorage.getItem("mount-copy")).toBe(root)
    } finally {
      dispose()
      base.remove()
      localStorage.removeItem("mount-previous")
      localStorage.removeItem("mount-copy")
    }
  })
})

test("quota eviction is confined to the current mount, including root", () => {
  for (const mount of ["/", "/mount/eviction/"]) {
    const base = document.createElement("base")
    base.setAttribute("href", mount)
    document.head.append(base)
    const namespace = BrowserStorage.namespace()
    const target = { storage: `opencode.eviction.${crypto.randomUUID()}`, key: "value" }
    const key = namespace.key(`${target.storage}:${target.key}`)
    const old = namespace.key("opencode.workspace.evict-me.dat:value")
    const foreign = BrowserStorage.namespace("/mount/foreign/").key("opencode.global.dat:foreign")
    const values = new Map([
      [old, "own"],
      [foreign, "foreign".repeat(1000)],
    ])
    if (mount !== "/") values.set("opencode.global.dat:root", "root".repeat(1000))
    const storage = {
      get length() {
        return values.size
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => void values.delete(key),
      setItem: (name: string, value: string) => {
        if (name === key && values.has(old)) throw new DOMException("fixture quota", "QuotaExceededError")
        values.set(name, value)
      },
    }
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true })
    createRoot((dispose) => {
      try {
        const [, setState] = persisted(target, Current, initial, web)
        setState("label", "saved")
        flushPersisted()
        expect(values.has(old)).toBe(false)
        expect(JSON.parse(values.get(key)!)).toMatchObject({ label: "saved" })
        expect(values.get(foreign)).toBe("foreign".repeat(1000))
        if (mount !== "/") expect(values.get("opencode.global.dat:root")).toBe("root".repeat(1000))
      } finally {
        dispose()
        Object.defineProperty(globalThis, "localStorage", original)
        base.remove()
      }
    })
  }
})
