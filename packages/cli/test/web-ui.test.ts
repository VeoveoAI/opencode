import { NodeFileSystem, NodeHttpServer } from "@effect/platform-node"
import { ServerProcess } from "@opencode/server/process"
import { OpenCode } from "@opencode/client/promise"
import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpServer, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { brotliCompressSync } from "node:zlib"
import { WebUi } from "../src/services/web-ui"
import { it } from "../../core/test/lib/effect"

const root = await mkdtemp(path.join(tmpdir(), "opencode-web-ui-"))
afterAll(() => rm(root, { recursive: true, force: true }))

describe("web UI", () => {
  it.live("serves the web shell and assets before server authentication", () =>
    Effect.gen(function* () {
      const transform = yield* WebUi.handler({
        assets: {
          "index.html": "<html><body>connect</body></html>",
          "_assets/app.js": "console.log('connect')",
          "_assets/app.css": "body { color: black; }",
          "icons/icon.svg": "<svg></svg>",
          "font.woff2": new Uint8Array([0, 1, 2, 255]),
          "sw.js": "service worker",
        },
      })
      const server = yield* ServerProcess.start<never, never>(
        { hostname: "127.0.0.1", port: 0, password: "secret", database: { path: ":memory:" } },
        undefined,
        transform,
      )
      const origin = HttpServer.formatAddress(server.address)
      yield* Effect.forEach(
        [
          "/",
          "/settings",
          "/workspace/example",
          "/_assets/app.js",
          "/_assets/app.css",
          "/icons/icon.svg",
          "/font.woff2",
          "/sw.js",
        ],
        (pathname) =>
          Effect.gen(function* () {
            yield* Effect.forEach(["GET", "HEAD"], (method) =>
              Effect.gen(function* () {
                const response = yield* Effect.promise(() => fetch(new URL(pathname, origin), { method }))
                expect(response.status).toBe(200)
                expect(response.headers.get("www-authenticate")).toBeNull()
                yield* Effect.promise(() => response.arrayBuffer())
              }),
            )
          }),
      )
      yield* Effect.forEach(["/api", "/api/info", "/api/event", "/api/missing", "/openapi.json"], (pathname) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() => fetch(new URL(pathname, origin)))
          expect(response.status).toBe(401)
          expect(response.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')
          yield* Effect.promise(() => response.arrayBuffer())
        }),
      )
      const response = yield* Effect.promise(() =>
        fetch(new URL("/api/info", origin), { headers: { authorization: `Basic ${btoa("opencode:secret")}` } }),
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toHaveProperty("pid")

      const pairing = yield* Effect.promise(() =>
        fetch(new URL("/api/pair", origin), {
          method: "POST",
          headers: { authorization: `Basic ${btoa("opencode:secret")}` },
        }).then((response) => response.json() as Promise<{ code: string }>),
      )
      const redirect = yield* Effect.promise(() =>
        fetch(new URL(`/auth/connect/${pairing.code}`, origin), {
          redirect: "manual",
          headers: { accept: "text/html" },
        }),
      )
      expect(redirect.status).toBe(302)
      const cookie = (redirect.headers.get("set-cookie") ?? "").split(";")[0]
      const authorized = yield* Effect.promise(() => fetch(new URL("/api/info", origin), { headers: { cookie } }))
      expect(authorized.status).toBe(200)
      yield* Effect.promise(() => authorized.arrayBuffer())
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  )

  it.live("serves deep links, assets, API and pairing through a prefix-stripping gateway", () =>
    Effect.gen(function* () {
      const basePath = "/computer/c/opaque-id/"
      const index = '<html><head><base href="/" /></head><body><script src="_assets/app.js"></script></body></html>'
      const originalIntegrity = `sha256-${createHash("sha256").update(index).digest("base64")}`
      const worker = `precache([{url:"index.html",integrity:"${originalIntegrity}"}])`
      const transform = yield* WebUi.handler({
        basePath,
        brotli: { "sw.js": brotliCompressSync(worker) },
        assets: {
          "index.html": index,
          "_assets/app.js": "hosted script",
          "sw.js": worker,
        },
      })
      const server = yield* ServerProcess.start<never, never>(
        {
          hostname: "127.0.0.1",
          port: 0,
          password: "secret",
          basePath,
          database: { path: ":memory:" },
          models: { fetch: false },
        },
        undefined,
        transform,
      )
      const upstream = HttpServer.formatAddress(server.address)
      const gateway = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
      yield* gateway.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const url = new URL(request.url, upstream)
          if (!url.pathname.startsWith(basePath)) return HttpServerResponse.empty({ status: 404 })
          url.pathname = url.pathname.slice(basePath.length - 1)
          const response = yield* Effect.promise(() =>
            fetch(url, {
              method: request.method,
              headers: request.headers,
              redirect: "manual",
              decompress: false,
            }),
          )
          // This hop buffers the encoded body; its HTTP server owns the new
          // message framing. Preserve Content-Encoding, never upstream framing.
          const headers = new Headers(response.headers)
          headers.delete("transfer-encoding")
          headers.delete("content-length")
          headers.delete("connection")
          return HttpServerResponse.raw(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer())), {
            status: response.status,
            headers: Object.fromEntries(headers),
          })
        }),
      )
      const origin = HttpServer.formatAddress(gateway.address)
      const pageUrl = new URL(`${basePath}server/local/session/example`, origin)
      const page = yield* Effect.promise(() => fetch(pageUrl).then((response) => response.text()))
      expect(page).toContain(`<base href="${basePath}" />`)
      const mount = /<base href="([^"]+)"/.exec(page)?.[1]
      const script = /<script src="([^"]+)"/.exec(page)?.[1]
      if (!mount || !script) throw new Error("Hosted page is missing its mount or script")
      const base = new URL(mount, pageUrl)
      const asset = new URL(script, base)
      expect(asset.pathname).toBe(`${basePath}_assets/app.js`)
      expect(yield* Effect.promise(() => fetch(asset).then((response) => response.text()))).toBe("hosted script")
      const mountedWorker = yield* Effect.promise(() =>
        fetch(new URL("sw.js", base), { headers: { "accept-encoding": "br" } }),
      )
      const workerBody = yield* Effect.promise(() => mountedWorker.text())
      expect(workerBody).toContain(`sha256-${createHash("sha256").update(page).digest("base64")}`)
      expect(workerBody).not.toContain(originalIntegrity)
      const headers = { authorization: `Basic ${btoa("opencode:secret")}` }
      const client = OpenCode.make({ baseUrl: base.href, headers })
      expect(yield* Effect.promise(() => client.server.info())).toHaveProperty("pid")
      const pairing = yield* Effect.promise(() => client.server.pair())
      const redirect = yield* Effect.promise(() =>
        fetch(new URL(`auth/connect/${pairing.code}`, base), {
          redirect: "manual",
          headers: { accept: "text/html" },
        }),
      )
      expect(redirect.status).toBe(302)
      expect(redirect.headers.get("location")).toBe(basePath)
      expect(redirect.headers.get("set-cookie")).toContain(`Path=${basePath}`)
      const cookie = (redirect.headers.get("set-cookie") ?? "").split(";")[0]
      const authorized = yield* Effect.promise(() => fetch(new URL("api/info", base), { headers: { cookie } }))
      expect(authorized.status).toBe(200)
      yield* Effect.promise(() => authorized.arrayBuffer())
      const outside = yield* Effect.promise(() => fetch(new URL("/api/info", origin)))
      expect(outside.status).toBe(404)
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  )

  it.live("keeps a trusted proxy shell online-only without changing ordinary PWA serving", () =>
    Effect.gen(function* () {
      const transform = yield* WebUi.handler({
        cache: "online-only",
        assets: {
          "index.html": '<html><head><base href="/" /></head><body>private shell</body></html>',
          "_assets/app.js": "private script",
          "sw.js": "worker",
          "registerSW.js": "registration",
        },
      })
      const server = yield* ServerProcess.start<never, never>(
        { hostname: "127.0.0.1", port: 0, trustedLocalProxy: true, database: { path: ":memory:" } },
        undefined,
        transform,
      )
      const origin = HttpServer.formatAddress(server.address)
      yield* Effect.forEach(
        ["/", "/server/local/session/private", "/_assets/app.js", "/sw.js", "/registerSW.js"],
        (pathname) =>
          Effect.gen(function* () {
            const response = yield* Effect.promise(() => fetch(new URL(pathname, origin)))
            expect(response.headers.get("cache-control")).toBe("private, no-store")
            expect(response.status).toBe(pathname.endsWith("sw.js") || pathname.endsWith("registerSW.js") ? 404 : 200)
            const body = yield* Effect.promise(() => response.text())
            if (pathname === "/") expect(body).toContain('<meta name="opencode-cache" content="online-only" />')
          }),
      )
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  )

  test("sends embedded brotli bytes as they are to browsers that accept them", async () => {
    const script = "console.log('compressed')".repeat(50)
    const html = "<html><body>compressed</body></html>"
    const brotli = { "_assets/app.js": brotliCompressSync(script), "index.html": brotliCompressSync(html) }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transform = yield* WebUi.handler({ assets: { "_assets/app.js": script, "index.html": html }, brotli })
          const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
          yield* http.serve(transform(Effect.succeed(HttpServerResponse.empty({ status: 404 }))))
          const origin = HttpServer.formatAddress(http.address)
          const get = (pathname: string, encoding: string) =>
            Effect.promise(async () => {
              const response = await fetch(`${origin}${pathname}`, {
                headers: { "accept-encoding": encoding },
                decompress: false,
              })
              return { headers: response.headers, body: new Uint8Array(await response.arrayBuffer()) }
            })

          const encoded = yield* get("/_assets/app.js", "gzip, deflate, br")
          expect(encoded.headers.get("content-encoding")).toBe("br")
          expect(encoded.headers.get("vary")).toBe("accept-encoding")
          expect(encoded.headers.get("content-type")).toContain("javascript")
          expect(encoded.body).toEqual(new Uint8Array(brotli["_assets/app.js"]))

          yield* Effect.forEach(["gzip", "br;q=0"], (encoding) =>
            Effect.gen(function* () {
              const plain = yield* get("/_assets/app.js", encoding)
              expect(plain.headers.get("content-encoding")).toBeNull()
              expect(plain.headers.get("vary")).toBe("accept-encoding")
              expect(new TextDecoder().decode(plain.body)).toBe(script)
            }),
          )

          const page = yield* get("/", "br")
          expect(page.headers.get("content-encoding")).toBeNull()
          expect(new TextDecoder().decode(page.body)).toBe(html)
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
  })

  test("falls back from API routes to assets and the SPA index", async () => {
    const index = path.join(root, "index.html")
    const asset = path.join(root, "app.js")
    await writeFile(index, "<html><body>embedded</body></html>")
    await writeFile(asset, "console.log('embedded')")
    const assets = {
      "index.html": await Bun.file(index).text(),
      "_assets/app.js": await Bun.file(asset).text(),
      "sw.js": "service worker",
      "registerSW.js": "registration",
      "font.woff2": new Uint8Array([0, 1, 2, 255]),
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transform = yield* WebUi.handler({ assets })
          const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
          yield* http.serve(
            transform(
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest
                const pathname = new URL(request.url, "http://localhost").pathname
                if (pathname === "/api/info")
                  return HttpServerResponse.jsonUnsafe({
                    version: "test",
                    pid: 1,
                    urls: [origin],
                    paths: { tmp: "/tmp/opencode" },
                  })
                return yield* Effect.fail(
                  new HttpServerError.HttpServerError({
                    reason: new HttpServerError.RouteNotFound({ request }),
                  }),
                )
              }),
            ),
          )
          const origin = HttpServer.formatAddress(http.address)

          const status = yield* Effect.promise(() => fetch(`${origin}/api/info`))
          expect(yield* Effect.promise(() => status.json())).toEqual({
            version: "test",
            pid: 1,
            urls: [origin],
            paths: { tmp: "/tmp/opencode" },
          })

          const missing = yield* Effect.promise(() => fetch(`${origin}/api/missing`))
          expect(missing.status).toBe(404)
          expect(yield* Effect.promise(() => missing.text())).toBe("")

          yield* Effect.forEach(["/_assets/old.js", "/_assets/old.css", "/_assets/missing"], (pathname) =>
            Effect.gen(function* () {
              const missing = yield* Effect.promise(() => fetch(`${origin}${pathname}`))
              expect(missing.status).toBe(404)
              expect(missing.headers.get("cache-control")).toBe("no-store")
              expect(yield* Effect.promise(() => missing.text())).toBe("")
            }),
          )

          const script = yield* Effect.promise(() => fetch(`${origin}/_assets/app.js`))
          expect(yield* Effect.promise(() => script.text())).toBe("console.log('embedded')")
          expect(script.headers.get("content-type")).toContain("javascript")
          expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")

          const worker = yield* Effect.promise(() => fetch(`${origin}/sw.js`))
          expect(worker.headers.get("cache-control")).toBe("no-cache")

          const registration = yield* Effect.promise(() => fetch(`${origin}/registerSW.js`))
          expect(registration.headers.get("cache-control")).toBe("no-cache")

          const font = yield* Effect.promise(() => fetch(`${origin}/font.woff2`))
          expect(font.headers.get("content-type")).toBe("font/woff2")
          expect(new Uint8Array(yield* Effect.promise(() => font.arrayBuffer()))).toEqual(
            new Uint8Array([0, 1, 2, 255]),
          )

          const fallback = yield* Effect.promise(() => fetch(`${origin}/workspace/example`))
          expect(yield* Effect.promise(() => fallback.text())).toContain("embedded")
          expect(fallback.headers.get("content-security-policy")).toContain("default-src 'self'")
          expect(fallback.headers.get("content-security-policy")).toContain("connect-src * data: blob:")
          expect(fallback.headers.get("content-security-policy")).toContain("worker-src 'self' blob:")

          const dotted = yield* Effect.promise(() => fetch(`${origin}/workspace/example.js`))
          expect(dotted.status).toBe(200)
          expect(yield* Effect.promise(() => dotted.text())).toContain("embedded")

          const legacy = yield* Effect.promise(() => fetch(`${origin}/assets/missing.js`))
          expect(legacy.status).toBe(200)
          expect(yield* Effect.promise(() => legacy.text())).toContain("embedded")
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
  })
})
