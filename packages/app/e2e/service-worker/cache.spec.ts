import { chromium, expect, test, type Page } from "@playwright/test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { once } from "node:events"
import { createHash } from "node:crypto"
import { join, extname, relative, sep, dirname } from "node:path"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { build } from "vite"
import { onDemandAsset, serviceWorker } from "../../vite.pwa"

type Site = {
  url: string
  deploy: (fault?: "failed" | "html" | "corrupt" | "mixed-html" | "blocked") => void
  legacy: () => void
  requests: string[]
  release: () => void
}

const fixture = test.extend<{ site: Site }, { builds: Record<string, Record<string, Buffer>> }>({
  builds: [
    async ({}, use) => {
      const directory = await mkdtemp(join(tmpdir(), "opencode-precache-"))
      const builds: Record<string, Record<string, Buffer>> = {}

      try {
        for (const version of ["old", "new"]) {
          const root = join(directory, version)
          const outDir = join(root, "dist")
          await mkdir(join(root, "public", "nested"), { recursive: true })
          await Promise.all(
            Object.entries({
              "index.html": `<html><head><base href="/" /></head><body><h1>Loading</h1><label>Draft<textarea></textarea></label><button>Load lazy</button><output></output><script type="module" src="/main.js"></script></body></html>`,
              "main.js": `document.querySelector("h1").textContent = "${version}";
            document.querySelector("button").onclick = async () => {
              document.querySelector("output").textContent = await (await import("./lazy.js")).load()
            };`,
              "lazy.js": `export async function load() { return (await import("./nested.js")).value }`,
              "nested.js": `export const value = "${version} nested lazy loaded"`,
              "public/nested/data.json": JSON.stringify({ version }),
              "public/nested/font.woff2": `font-${version}`,
              "public/nested/module.wasm": Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
              "public/large.bin": Buffer.alloc(2 * 1024 * 1024 + 1, version === "old" ? 1 : 2),
              "public/_headers": "/*\n  Cache-Control: no-cache",
              "public/_redirects": "/* /index.html 200",
            }).map(([path, contents]) => writeFile(join(root, path), contents)),
          )
          await build({
            configFile: false,
            root,
            base: "./",
            logLevel: "silent",
            build: { outDir, assetsDir: "_assets", sourcemap: true },
            plugins: serviceWorker(outDir),
          })
          builds[version] = Object.fromEntries(
            await Promise.all(
              (await readdir(outDir, { recursive: true, withFileTypes: true }))
                .filter((entry) => entry.isFile())
                .map(async (entry) => {
                  const path = join(entry.parentPath, entry.name)

                  return ["/" + relative(outDir, path).split(sep).join("/"), await readFile(path)]
                }),
            ),
          )
        }

        await use(builds)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
    { scope: "worker" },
  ],
  site: async ({ builds }, use) => {
    const state = { version: "old", fault: "", legacy: false }
    const requests: string[] = []
    const blocked: ServerResponse[] = []
    const release = () => blocked.splice(0).forEach((response) => response.end(builds.new["/large.bin"]))

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost")
      const path = url.pathname
      requests.push(path)
      response.setHeader("cache-control", "no-store")

      if (path === "/observer.html")
        return void response.writeHead(200, { "content-type": "text/html" }).end("<title>Worker observer</title>")

      if (path === "/api/info")
        return void response
          .writeHead(200, { "content-type": "application/json" })
          .end(`{"version":"test","pid":1,"urls":["${url.origin}"],"paths":{"tmp":"/tmp/opencode"}}`)

      if (path === "/sw.js" && state.legacy && state.version === "old") {
        // Model the shipped worker's shared precache name and cache-first navigation behavior.
        const urls = Object.keys(builds.old).filter(
          (path) => path === "/index.html" || (path.startsWith("/_assets/") && path.endsWith(".js")),
        )

        response.setHeader("content-type", "text/javascript")

        return void response.end(`
          self.addEventListener("install", event => event.waitUntil(
            caches.open("workbox-precache-v2-" + self.registration.scope).then(cache => cache.addAll(${JSON.stringify(urls)}))
          ));
          self.addEventListener("fetch", event => event.respondWith(
            caches.match(event.request.mode === "navigate" ? "/index.html" : event.request)
              .then(response => response || fetch(event.request))
          ));
        `)
      }

      if (path === "/index.html" && state.fault === "mixed-html")
        return void response.writeHead(200, { "content-type": "text/html" }).end(builds.old["/index.html"])

      if (path === "/large.bin" && state.fault && state.fault !== "mixed-html") {
        if (state.fault === "blocked") return void blocked.push(response)

        if (state.fault === "failed") return void response.writeHead(503).end("Unavailable")

        if (state.fault === "html")
          return void response.writeHead(200, { "content-type": "text/html" }).end("<html>Wrong fallback</html>")

        return void response.end("Incorrect bytes with a successful status")
      }

      const file = builds[state.version][path]

      const types = new Map([
        [".js", "text/javascript"],
        [".html", "text/html"],
        [".json", "application/json"],
        [".wasm", "application/wasm"],
      ])

      response.setHeader("content-type", types.get(extname(path)) ?? "application/octet-stream")

      if (file) return void response.end(file)

      if (extname(path)) return void response.writeHead(404).end("Not found")
      response.setHeader("content-type", "text/html")
      response.end(builds[state.version]["/index.html"])
    })

    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    // SAFETY: a server listening on a host and port reports an AddressInfo; only pipe servers report a string.
    const address = server.address() as AddressInfo

    try {
      await use({
        url: `http://127.0.0.1:${address.port}`,
        deploy: (fault = undefined) => {
          state.version = "new"
          state.fault = fault ?? ""
        },
        legacy: () => {
          state.legacy = true
        },
        requests,
        release,
      })
    } finally {
      release()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  },
})

async function install(page: Page, url: string) {
  await page.goto(url)
  await expect(page.getByRole("heading")).toHaveText("old")
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js")
    await navigator.serviceWorker.ready
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe("activated")
  await expect(page.getByRole("heading")).toHaveText("old")
}

async function update(page: Page) {
  return page.evaluateHandle(async () => {
    const registration = await navigator.serviceWorker.getRegistration()

    if (!registration) throw new Error("Missing installed worker")

    const found = new Promise<ServiceWorker>((resolve) =>
      registration.addEventListener(
        "updatefound",
        () => {
          if (!registration.installing) throw new Error("Missing installing worker")
          resolve(registration.installing)
        },
        { once: true },
      ),
    )

    await registration.update()

    return found
  })
}

async function waiting(page: Page) {
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state))
    .toBe("installed")
}

fixture(
  "opens an uncached route offline and executes never-used nested lazy chunks",
  async ({ page, context, site }) => {
    await install(page, site.url)
    await expect(page.getByRole("status")).toBeEmpty()
    await context.setOffline(true)
    await page.goto(`${site.url}/workspace/never-visited`)
    await expect(page.getByRole("heading")).toHaveText("old")
    await page.getByRole("button", { name: "Load lazy" }).click()
    await expect(page.getByRole("status")).toHaveText("old nested lazy loaded")
  },
)

fixture(
  "precaches public files of every type and size, excluding deployment metadata and source maps",
  async ({ page, site, builds, context }) => {
    for (const output of Object.values(builds)) {
      expect(output["/sw.js.map"]).toBeUndefined()
      expect(Object.keys(output).some((path) => path.startsWith("/_assets/") && path.endsWith(".map"))).toBe(true)
    }

    await install(page, site.url)
    const files = ["/nested/data.json", "/nested/font.woff2", "/nested/module.wasm", "/large.bin"]
    await context.setOffline(true)

    for (const path of files) {
      const digest = await page.evaluate(
        async (path) =>
          Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await (await fetch(path)).arrayBuffer()))),
        path,
      )

      expect(Buffer.from(digest)).toEqual(createHash("sha256").update(builds.old[path]).digest())
    }

    expect(site.requests).not.toContain("/_headers")
    expect(site.requests).not.toContain("/_redirects")
    expect(site.requests.filter((path) => path.endsWith(".map"))).toEqual([])
  },
)

fixture(
  "keeps drafts and removed old lazy chunks until every controlled tab closes",
  async ({ page, context, site, builds }) => {
    await install(page, site.url)
    const second = await context.newPage()
    await second.goto(site.url)
    await expect(second.getByRole("heading")).toHaveText("old")
    await second.getByLabel("Draft").fill("Keep this unsent prompt")

    site.deploy()
    const created = context.waitForEvent("serviceworker")
    const worker = await update(page)
    const replacement = await created
    await waiting(page)
    expect(await worker.evaluate((worker) => worker.state)).toBe("installed")
    await expect(second.getByLabel("Draft")).toHaveValue("Keep this unsent prompt")
    await page.close()
    await waiting(second)
    await expect(second.getByRole("heading")).toHaveText("old")
    await expect(second.getByLabel("Draft")).toHaveValue("Keep this unsent prompt")

    const removed = Object.keys(builds.old).find((path) => path.includes("/nested-") && path.endsWith(".js"))
    expect(removed).toBeDefined()
    expect((await second.request.get(`${site.url}${removed}`)).status()).toBe(404)
    await second.getByRole("button", { name: "Load lazy" }).click()
    await expect(second.getByRole("status")).toHaveText("old nested lazy loaded")
    await expect(second.getByLabel("Draft")).toHaveValue("Keep this unsent prompt")
    await second.close()

    await expect
      .poll(() =>
        replacement.evaluate(() => {
          // This runs in the service worker, whose global scope holds its registration.
          const registration =
            "registration" in self && self.registration instanceof ServiceWorkerRegistration
              ? self.registration
              : undefined

          return { waiting: !!registration?.waiting, active: registration?.active?.state }
        }),
      )
      .toEqual({ waiting: false, active: "activated" })
    await context.setOffline(true)
    const observer = await context.newPage()
    await observer.goto(`${site.url}/workspace/reopened`)
    await expect(observer.getByRole("heading")).toHaveText("new")
    await observer.getByRole("button", { name: "Load lazy" }).click()
    await expect(observer.getByRole("status")).toHaveText("new nested lazy loaded")
  },
)

for (const fault of ["failed", "html", "corrupt", "mixed-html"] as const) {
  fixture(`retains the old complete build when a precache download is ${fault}`, async ({ page, context, site }) => {
    await install(page, site.url)
    await page.getByLabel("Draft").fill("Still editing")
    site.deploy(fault)
    const worker = await update(page)
    await expect.poll(() => worker.evaluate((worker) => worker.state)).toBe("redundant")
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting)).toBeNull()
    await expect(page.getByLabel("Draft")).toHaveValue("Still editing")
    await context.setOffline(true)
    await page.goto(`${site.url}/workspace/after-failure`)
    await expect(page.getByRole("heading")).toHaveText("old")
    await page.getByRole("button", { name: "Load lazy" }).click()
    await expect(page.getByRole("status")).toHaveText("old nested lazy loaded")
  })
}

fixture("does not expose new HTML while a precache download is blocked", async ({ page, context, site }) => {
  await install(page, site.url)
  site.requests.length = 0
  site.deploy("blocked")
  const worker = await update(page)
  await expect.poll(() => site.requests.includes("/large.bin")).toBe(true)
  expect(await worker.evaluate((worker) => worker.state)).toBe("installing")
  const second = await context.newPage()
  await second.goto(`${site.url}/workspace/during-install`)
  await expect(second.getByRole("heading")).toHaveText("old")
  site.release()
  await waiting(page)
  await second.reload()
  await expect(second.getByRole("heading")).toHaveText("old")
})

fixture("upgrades the legacy shared precache only after old tabs close", async ({ page, context, site, builds }) => {
  site.legacy()
  const observer = await context.newPage()
  await observer.goto(`${site.url}/observer.html`)
  await install(page, site.url)
  await page.getByLabel("Draft").fill("Legacy unsent prompt")
  // A stale runtime-cache HTML response must not contaminate the new generated precache.
  const entry = Object.keys(builds.new).find((path) => path.includes("/index-") && path.endsWith(".js"))
  expect(entry).toBeDefined()
  await page.evaluate(async (entry) => {
    await (
      await caches.open("opencode-assets")
    ).put(entry!, new Response("<html>stale fallback</html>", { headers: { "content-type": "text/html" } }))
  }, entry)
  site.deploy()
  await update(page)
  await waiting(page)
  await expect(page.getByLabel("Draft")).toHaveValue("Legacy unsent prompt")
  await page.getByRole("button", { name: "Load lazy" }).click()
  await expect(page.getByRole("status")).toHaveText("old nested lazy loaded")
  await page.close()
  await expect
    .poll(() => observer.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting))
    .toBe(false)
  await context.setOffline(true)
  await observer.goto(`${site.url}/workspace/legacy-upgraded`)
  await expect(observer.getByRole("heading")).toHaveText("new")
  await observer.getByRole("button", { name: "Load lazy" }).click()
  await expect(observer.getByRole("status")).toHaveText("new nested lazy loaded")
})

fixture("does not substitute cached HTML for API or missing asset navigations", async ({ page, site }) => {
  await install(page, site.url)
  const api = await page.goto(`${site.url}/api/info`)
  expect(await api?.json()).toEqual({
    version: "test",
    pid: 1,
    urls: ["http://localhost"],
    paths: { tmp: "/tmp/opencode" },
  })
  expect(api?.fromServiceWorker()).toBe(false)
  const asset = await page.goto(`${site.url}/_assets/missing.js`)
  expect(asset?.status()).toBe(404)
  expect(await asset?.text()).toBe("Not found")
})

test("the production build precaches every deployable file except on-demand Office assets", async ({
  page,
  context,
}) => {
  const directory = new URL("../../dist/", import.meta.url)

  const deployable = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => "/" + relative(fileURLToPath(directory), join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter((path) => !path.endsWith(".map") && !["/_headers", "/_redirects", "/sw.js"].includes(path))

  const files = deployable.filter((path) => !onDemandAsset(path))

  expect(files.length).toBeGreaterThan(1)
  // The Office engines ship but load on demand, so a build without them would make this exclusion vacuous.
  expect(deployable.some((path) => path.endsWith(".wasm") && onDemandAsset(path))).toBe(true)

  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname
    response.setHeader("cache-control", "no-store")

    if (path === "/probe.html")
      return void response.writeHead(200, { "content-type": "text/html" }).end("<title>Precache probe</title>")
    const bytes = await readFile(new URL(`.${path}`, directory)).catch(() => undefined)

    if (!bytes) return void response.writeHead(404).end("Not found")

    if (path.endsWith(".js")) response.setHeader("content-type", "text/javascript")

    if (path.endsWith(".html")) {
      response.setHeader("content-type", "text/html")
      // Inspect the real cached HTML without executing the app or contacting a backend.
      response.setHeader("content-security-policy", "default-src 'none'")
    }

    response.end(bytes)
  })

  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  // SAFETY: a server listening on a host and port reports an AddressInfo; only pipe servers report a string.
  const address = server.address() as AddressInfo
  const url = `http://127.0.0.1:${address.port}`

  try {
    await page.goto(`${url}/probe.html`)
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js")
      await navigator.serviceWorker.ready
    })

    const cached = await page.evaluate(async () =>
      (
        await Promise.all(
          (await caches.keys()).map(async (name) =>
            (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname),
          ),
        )
      )
        .flat()
        .sort(),
    )

    expect(cached).toEqual(files.sort())
    await context.setOffline(true)
    const response = await page.goto(`${url}/workspace/offline-probe`)
    expect(response?.fromServiceWorker()).toBe(true)
    expect(await response?.text()).toBe(await readFile(new URL("index.html", directory), "utf8"))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test("the production build installs as an app behind an authenticating proxy", async () => {
  const directory = new URL("../../dist/", import.meta.url)

  const server = createServer(async (request, response) => {
    // Model a reverse proxy that rejects every request without the signed-in user's cookie.
    if (!request.headers.cookie?.includes("session=signed-in")) return void response.writeHead(401).end()
    const path = new URL(request.url ?? "/", "http://localhost").pathname
    const file = extname(path) ? path : "/index.html"
    const bytes = await readFile(new URL(`.${file}`, directory)).catch(() => undefined)

    if (!bytes) return void response.writeHead(404).end("Not found")

    // Check the real HTML without starting the app or its service worker.
    if (file === "/index.html")
      response.writeHead(200, { "content-type": "text/html", "content-security-policy": "script-src 'none'" })

    response.end(bytes)
  })

  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  // SAFETY: a server listening on a host and port reports an AddressInfo; only pipe servers report a string.
  const address = server.address() as AddressInfo
  const url = `http://127.0.0.1:${address.port}`
  // Chrome Headless Shell has no install checks and reports no errors for any page, and an incognito context always
  // reports one, so check in a persistent Chrome profile.
  const context = await chromium.launchPersistentContext("", { channel: "chromium" })

  try {
    await context.addCookies([{ name: "session", value: "signed-in", url }])
    const page = await context.newPage()
    await page.goto(url)
    const session = await context.newCDPSession(page)
    expect((await session.send("Page.getInstallabilityErrors")).installabilityErrors).toEqual([])
  } finally {
    await context.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

fixture(
  "mounts one built archive under a nested prefix without weakening precache integrity",
  async ({ page, context, builds }) => {
    const mount = "/computer/c/browser/"
    const directory = await mkdtemp(join(tmpdir(), "opencode-native-web-ui-"))
    await Promise.all(
      Object.entries(builds.old).map(async ([path, bytes]) => {
        const target = join(directory, path.slice(1))
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, bytes)
      }),
    )
    // Native Effect modules use Bun's TypeScript runtime, outside Playwright's Babel transform.
    const server = spawn("bun", [fileURLToPath(new URL("./native-web-ui.ts", import.meta.url)), directory, mount], {
      stdio: ["ignore", "pipe", "inherit"],
    })
    const exited = once(server, "exit")
    const output = createInterface({ input: server.stdout })
    try {
      const origin = await Promise.race([
        once(output, "line").then(([line]) => new URL(line).origin),
        exited.then(() => {
          throw new Error("Native web UI fixture exited before listening")
        }),
      ])
      await page.goto(`${origin}${mount}server/local/session/deep`)
      await expect(page.getByRole("heading")).toHaveText("old")
      await page.evaluate(async () => {
        await navigator.serviceWorker.register(new URL("sw.js", document.baseURI), {
          scope: new URL(".", document.baseURI).pathname,
        })
        await navigator.serviceWorker.ready
      })
      await page.reload()
      await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe("activated")
      expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope)).toBe(
        `${origin}${mount}`,
      )
      await context.setOffline(true)
      await page.goto(`${origin}${mount}server/local/session/offline`)
      await expect(page.getByRole("heading")).toHaveText("old")
      await page.getByRole("button", { name: "Load lazy" }).click()
      await expect(page.getByRole("status")).toHaveText("old nested lazy loaded")
      await context.setOffline(false)
      const denied = await page.goto(`${origin}${mount}auth/connect/missing`)
      expect(denied?.status()).toBe(404)
    } finally {
      server.kill()
      await exited
      output.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test("an online-only native shell cannot bypass a later outer-gateway denial", async ({ browser }) => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-online-only-"))
  const source = join(directory, "source")
  const archive = join(directory, "archive")
  const mount = "/private/c/online/"
  await mkdir(source)
  await writeFile(
    join(source, "index.html"),
    '<html><head><base href="/" /></head><body><h1>Loading</h1><script type="module" src="/main.js"></script></body></html>',
  )
  await writeFile(
    join(source, "main.js"),
    `import { registerServiceWorker } from ${JSON.stringify(fileURLToPath(new URL("../../src/runtime/platform/pwa.ts", import.meta.url)))}; registerServiceWorker(); document.querySelector("h1").textContent = "Private shell";`,
  )
  await build({ configFile: false, root: source, base: "./", logLevel: "silent", build: { outDir: archive } })
  const native = spawn(
    "bun",
    [fileURLToPath(new URL("./native-web-ui.ts", import.meta.url)), archive, mount, "online-only"],
    { stdio: ["ignore", "pipe", "inherit"] },
  )
  const exited = once(native, "exit")
  const output = createInterface({ input: native.stdout })
  const requests: string[] = []
  const context = await browser.newContext()
  const gateway = createServer()
  try {
    const backend = await Promise.race([
      once(output, "line").then(([line]) => new URL(line).origin),
      exited.then(() => {
        throw new Error("Native online-only fixture exited before listening")
      }),
    ])
    gateway.on("request", async (request, response) => {
      const path = request.url ?? "/"
      requests.push(path)
      if (!request.headers.cookie?.includes("session=signed-in"))
        return void response
          .writeHead(401, { "cache-control": "private, no-store", "content-type": "text/html" })
          .end("<h1>Sign in</h1>")
      const upstream = await fetch(`${backend}${path}`)
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers))
      response.end(Buffer.from(await upstream.arrayBuffer()))
    })
    gateway.listen(0, "127.0.0.1")
    await once(gateway, "listening")
    const origin = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`
    await context.addCookies([{ name: "session", value: "signed-in", url: origin }])
    const page = await context.newPage()
    const initial = await page.goto(`${origin}${mount}`)
    expect(initial?.headers()["cache-control"]).toBe("private, no-store")
    await expect(page.getByRole("heading")).toHaveText("Private shell")
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistration())).toBeUndefined()
    expect(requests.some((path) => path.endsWith("sw.js"))).toBe(false)
    await context.clearCookies()
    const denied = await page.goto(`${origin}${mount}server/local/session/known`)
    expect(denied?.status()).toBe(401)
    await expect(page.getByRole("heading")).toHaveText("Sign in")
    await context.setOffline(true)
    await expect(page.goto(`${origin}${mount}server/local/session/offline`)).rejects.toThrow()
    await expect(page.getByRole("heading", { name: "Private shell" })).toHaveCount(0)
  } finally {
    await context.close()
    gateway.closeAllConnections()
    if (gateway.listening) await new Promise<void>((resolve) => gateway.close(() => resolve()))
    native.kill()
    await exited
    output.close()
    await rm(directory, { recursive: true, force: true })
  }
})
