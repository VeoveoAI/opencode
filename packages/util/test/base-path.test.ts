import { expect, test } from "bun:test"
import { BasePath } from "../src/base-path.js"

test("admits stable external URL mounts and rejects path normalization or HTML injection", () => {
  expect(BasePath.normalize()).toBe("/")
  expect(BasePath.normalize("/computer")).toBe("/computer/")
  expect(BasePath.normalize("/users/alex/computer/")).toBe("/users/alex/computer/")
  for (const value of [
    "computer",
    "//other.example/",
    "/a/../b",
    "/a//b",
    "/a/%2e%2e/",
    "/a/%2F/",
    "/a?b",
    "/a#b",
    '/a" onload="bad',
  ])
    expect(() => BasePath.normalize(value)).toThrow()
})
