import { NodeFileSystem, NodeHttpServer } from "@effect/platform-node"
import { Effect } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createServer } from "node:http"
import { readFile, readdir } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { WebUi } from "../../../cli/src/services/web-ui"

const [directory, mount, cache] = process.argv.slice(2)
if (!directory || !mount) throw new Error("Native web UI fixture requires its archive directory and mount")
const assets = Object.fromEntries(
  await Promise.all(
    (await readdir(directory, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name)
        const bytes = await readFile(path)
        return [relative(directory, path).split(sep).join("/"), /\.(html|js)$/.test(path) ? bytes.toString() : bytes]
      }),
  ),
)

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const transform = yield* WebUi.handler({
        basePath: mount,
        assets,
        cache: cache === "online-only" ? "online-only" : "offline",
      })
      const server = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
      yield* server.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const url = new URL(request.url, "http://localhost")
          if (!url.pathname.startsWith(mount)) return HttpServerResponse.empty({ status: 404 })
          url.pathname = url.pathname.slice(mount.length - 1)
          return yield* transform(Effect.succeed(HttpServerResponse.empty({ status: 404 }))).pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              request.modify({ url: url.pathname + url.search }),
            ),
          )
        }),
      )
      console.log(HttpServer.formatAddress(server.address))
      yield* Effect.never
    }),
  ).pipe(Effect.provide(NodeFileSystem.layer)),
)
