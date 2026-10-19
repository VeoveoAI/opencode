import { createNotificationCoordinator } from "@/shell/notifications/coordinator"
import { createRoot } from "solid-js"
import { Schema } from "effect"
import { Persist, persisted, removePersisted } from "@/runtime/persistence/storage"
import { flushPersisted } from "@/runtime/persistence/persist"
import { createBrowserDraftStore } from "@/runtime/persistence/drafts"
import { serverState, ServerKey } from "@/runtime/server/persistence"
import { TabStorage } from "@/shell/tabs/schema"
import type { Platform } from "@/runtime/platform/platform"

const draft = createBrowserDraftStore()
const platform: Platform = {
  platform: "web",
  openExternal: () => {},
  restart: async () => {},
  notify: async () => {},
}
const targets = {
  tabs: Persist.window("tabs"),
  registry: { ...Persist.global("server"), sync: true, previousKey: "server.v3" },
}
const state = createRoot(() => {
  const [tabs, setTabs] = persisted(targets.tabs, TabStorage.Tabs, [], platform)
  const [registry, setRegistry] = persisted(
    targets.registry,
    serverState(),
    {
      list: [],
      hidden: {},
      projects: {},
      lastProject: {},
      recentlyClosed: {},
    },
    platform,
  )
  return { tabs, setTabs, registry, setRegistry, notifications: createNotificationCoordinator() }
})

const api = {
  read: () => JSON.parse(JSON.stringify({ tabs: state.tabs, registry: state.registry })),
  write: (label: string) => {
    state.setTabs([
      { type: "draft", draftID: label, server: Schema.decodeUnknownSync(ServerKey)("local"), directory: "/workspace" },
    ])
    state.setRegistry("list", [{ type: "http", http: { url: `https://example.test/${label}` } }])
    flushPersisted()
  },
  writeDraft: (value: string) => draft.setDocument("same-draft", { prompt: [{ type: "text", content: value }] }),
  readDraft: () => draft.getItem("same-draft"),
  notify: async (event: string) => {
    let delivered = false
    await state.notifications.sound(event, () => {
      delivered = true
    })
    return delivered
  },
  remove: () => {
    removePersisted(targets.tabs, platform)
    removePersisted(targets.registry, platform)
  },
}

declare global {
  interface Window {
    persistence: typeof api
  }
}
window.persistence = api
