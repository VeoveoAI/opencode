import { NodeServices } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, Redacted } from "effect"
import { Command } from "effect/cli"
import { Commands } from "../src/commands/commands"
import { ServerProcess } from "../src/server-process"

test("serve explicitly selects trusted local proxy mode", async () => {
  const received: boolean[] = []
  const command = Commands.commands.serve.spec.pipe(
    Command.withHandler((input) => Effect.sync(() => void received.push(input.trustedLocalProxy))),
  )
  await Effect.runPromise(
    Command.runWith(command, { version: "test" })(["--trusted-local-proxy", "--hostname", "127.0.0.1"]).pipe(
      Effect.provide(NodeServices.layer),
    ),
  )
  expect(received).toEqual([true])
})

test("trusted local proxy requires literal loopback, foreground and no configured password", () => {
  const options = { mode: "default", hostname: "127.0.0.1", trustedLocalProxy: true } as const
  for (const hostname of ["127.0.0.1", "::1"])
    expect(ServerProcess.authentication({ ...options, hostname })).toEqual({ mode: "trusted-local-proxy" })
  for (const hostname of ["0.0.0.0", "::", "localhost", "127.0.0.2", "[::1]", "example.com"])
    expect(() => ServerProcess.authentication({ ...options, hostname })).toThrow("literal loopback")
  for (const mode of ["service", "stdio"] as const)
    expect(() => ServerProcess.authentication({ ...options, mode })).toThrow("foreground")
  for (const password of ["", "configured"])
    expect(() => ServerProcess.authentication(options, Redacted.make(password))).toThrow("password configuration")
  expect(() => ServerProcess.authentication(options, undefined, "configured")).toThrow("password configuration")
})

test("ordinary foreground and service authentication still require generated or configured passwords", () => {
  const options = { mode: "default", hostname: "0.0.0.0" } as const
  const generated = ServerProcess.authentication(options)
  expect(generated.mode).toBe("password")
  if (generated.mode !== "password") throw new Error("Missing ordinary password")
  expect(generated.password.length).toBeGreaterThan(32)
  expect(ServerProcess.authentication(options, Redacted.make("foreground-secret"))).toEqual({
    mode: "password",
    password: "foreground-secret",
  })
  expect(ServerProcess.authentication({ ...options, mode: "service" }, undefined, "service-secret")).toEqual({
    mode: "password",
    password: "service-secret",
  })
})
