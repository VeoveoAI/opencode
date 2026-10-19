import { expect, test } from "@playwright/test"
import { build } from "vite"
import solid from "vite-plugin-solid"
import { once } from "node:events"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import type {} from "./persistence/fixture"

test("same-origin mounts isolate tabs, registry, real IndexedDB drafts and cross-tab sync", async ({ browser }) => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-mounted-persistence-"))
  const files = new Map<string, Buffer>()
  const root = fileURLToPath(new URL("./persistence", import.meta.url))
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname
    const mount = ["/mount/a/", "/mount/b/"].find((mount) => pathname.startsWith(mount))
    if (!mount) return void response.writeHead(404).end()
    const name = pathname.slice(mount.length) || "index.html"
    const file = files.get(name)
    if (!file) return void response.writeHead(404).end()
    response.setHeader("cache-control", "no-store")
    response.setHeader("content-type", name.endsWith(".html") ? "text/html" : "text/javascript")
    response.end(name === "index.html" ? file.toString().replace('<base href="/"', `<base href="${mount}"`) : file)
  })
  const context = await browser.newContext()
  try {
    await build({
      configFile: false,
      root,
      base: "./",
      logLevel: "silent",
      plugins: [solid()],
      resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
      build: { outDir: directory, target: "esnext" },
    })
    for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = join(entry.parentPath, entry.name)
      files.set(relative(directory, path).replaceAll("\\", "/"), await readFile(path))
    }
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const a = await context.newPage()
    await a.goto(`${origin}/mount/a/`)
    await a.waitForFunction(() => !!window.persistence)
    // Root history is deliberately present on this same browser origin.
    await a.evaluate(() => {
      localStorage.setItem("server.v3", JSON.stringify({ list: ["https://root.example"] }))
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID: "root", server: "local", directory: "/root" }]),
      )
    })
    await a.reload()
    await a.waitForFunction(() => !!window.persistence)
    expect(await a.evaluate(() => window.persistence.read().tabs)).toEqual([])
    expect(await a.evaluate(() => window.persistence.read().registry.list)).toEqual([])
    await a.evaluate(async () => {
      window.persistence.write("alpha")
      await window.persistence.writeDraft("alpha draft")
    })
    const same = await context.newPage()
    await same.goto(`${origin}/mount/a/`)
    await same.waitForFunction(() => !!window.persistence)
    const b = await context.newPage()
    await b.goto(`${origin}/mount/b/`)
    await b.waitForFunction(() => !!window.persistence)
    expect(await same.evaluate(() => window.persistence.read().tabs[0].draftID)).toBe("alpha")
    expect(await same.evaluate(() => window.persistence.readDraft())).toContain("alpha draft")
    expect(await b.evaluate(() => window.persistence.read().tabs)).toEqual([])
    expect(await b.evaluate(() => window.persistence.read().registry.list)).toEqual([])
    expect(await b.evaluate(() => window.persistence.readDraft())).toBeNull()
    expect(await a.evaluate(() => window.persistence.notify("same-event"))).toBe(true)
    expect(await same.evaluate(() => window.persistence.notify("same-event"))).toBe(false)
    expect(await b.evaluate(() => window.persistence.notify("same-event"))).toBe(true)
    await b.evaluate(async () => {
      window.persistence.write("beta")
      await window.persistence.writeDraft("beta draft")
    })
    await a.evaluate(() => window.persistence.write("alpha-updated"))
    await expect
      .poll(() => same.evaluate(() => window.persistence.read().registry.list[0]?.http.url))
      .toBe("https://example.test/alpha-updated")
    expect(await b.evaluate(() => window.persistence.read().registry.list[0].http.url)).toBe(
      "https://example.test/beta",
    )
    await b.reload()
    await b.waitForFunction(() => !!window.persistence)
    expect(await b.evaluate(() => window.persistence.read().tabs[0].draftID)).toBe("beta")
    expect(await b.evaluate(() => window.persistence.readDraft())).toContain("beta draft")
    await a.evaluate(() => window.persistence.remove())
    await a.reload()
    await a.waitForFunction(() => !!window.persistence)
    expect(await a.evaluate(() => window.persistence.read().tabs)).toEqual([])
    expect(await a.evaluate(() => window.persistence.read().registry.list)).toEqual([])
    expect(await a.evaluate(() => localStorage.getItem("server.v3"))).toContain("root.example")
    expect(await a.evaluate(() => localStorage.getItem("opencode.window.browser.dat:tabs"))).toContain('"root"')
    await b.reload()
    await b.waitForFunction(() => !!window.persistence)
    expect(await b.evaluate(() => window.persistence.read().tabs[0].draftID)).toBe("beta")
    expect(await b.evaluate(() => window.persistence.readDraft())).toContain("beta draft")
  } finally {
    await context.close()
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
