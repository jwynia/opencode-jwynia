import { test, expect, beforeAll, afterAll } from "bun:test"
import { Plugin } from "../../src/plugin"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"

// Disable default plugins for all tests
beforeAll(() => {
  process.env["OPENCODE_DISABLE_DEFAULT_PLUGINS"] = "true"
})

afterAll(() => {
  delete process.env["OPENCODE_DISABLE_DEFAULT_PLUGINS"]
})

test("plugin validation rejects missing file", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const nonExistentPlugin = `file://${path.join(tmp.path, "nonexistent.ts")}`
      await Bun.write(
        path.join(tmp.path, "opencode.json"),
        JSON.stringify({
          plugin: [nonExistentPlugin],
        }),
      )
      await Config.get()
      const statuses = await Plugin.status()
      const ourPlugin = statuses.find((s) => s.path === nonExistentPlugin)
      expect(ourPlugin).toBeDefined()
      expect(ourPlugin?.status).toBe("failed")
      expect(ourPlugin?.error).toContain("File not found")
    },
  })
})

test("plugin validation rejects invalid file extension", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "plugin.txt"), "console.log('test')")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const invalidPlugin = `file://${path.join(tmp.path, "plugin.txt")}`
      await Bun.write(
        path.join(tmp.path, "opencode.json"),
        JSON.stringify({
          plugin: [invalidPlugin],
        }),
      )
      await Config.get()
      const statuses = await Plugin.status()
      const ourPlugin = statuses.find((s) => s.path === invalidPlugin)
      expect(ourPlugin).toBeDefined()
      expect(ourPlugin?.status).toBe("failed")
      expect(ourPlugin?.error).toContain("Unsupported file type")
    },
  })
})

test("plugin validation accepts valid TypeScript file", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "plugin.ts"),
        `
        export const testPlugin = (input) => {
          return {
            config: async (config) => {}
          }
        }
      `,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const validPlugin = `file://${path.join(tmp.path, "plugin.ts")}`
      await Bun.write(
        path.join(tmp.path, "opencode.json"),
        JSON.stringify({
          plugin: [validPlugin],
        }),
      )
      await Config.get()
      const statuses = await Plugin.status()
      const ourPlugin = statuses.find((s) => s.path === validPlugin)
      expect(ourPlugin).toBeDefined()
      expect(ourPlugin?.status).toBe("loaded")
      expect(ourPlugin?.hooks).toBeDefined()
    },
  })
})

test("plugin loading continues after one plugin fails", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "broken.ts"),
        `
        throw new Error("Intentional error")
        export const broken = (input) => ({})
      `,
      )
      await Bun.write(
        path.join(dir, "working.ts"),
        `
        export const working = (input) => {
          return {
            config: async (config) => {}
          }
        }
      `,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const brokenPlugin = `file://${path.join(tmp.path, "broken.ts")}`
      const workingPlugin = `file://${path.join(tmp.path, "working.ts")}`
      await Bun.write(
        path.join(tmp.path, "opencode.json"),
        JSON.stringify({
          plugin: [brokenPlugin, workingPlugin],
        }),
      )
      await Config.get()
      const statuses = await Plugin.status()
      const broken = statuses.find((s) => s.path === brokenPlugin)
      const working = statuses.find((s) => s.path === workingPlugin)
      // Broken should fail
      expect(broken).toBeDefined()
      expect(broken?.status).toBe("failed")
      expect(broken?.error).toContain("Import failed")
      // Working should succeed
      expect(working).toBeDefined()
      expect(working?.status).toBe("loaded")
      expect(working?.hooks).toContain("config")
    },
  })
})

test("disabled_plugins config prevents plugin loading", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "plugin.ts"),
        `
        export const testPlugin = (input) => {
          return {
            config: async (config) => {}
          }
        }
      `,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const pluginPath = `file://${path.join(tmp.path, "plugin.ts")}`
      await Bun.write(
        path.join(tmp.path, "opencode.json"),
        JSON.stringify({
          plugin: [pluginPath],
          disabled_plugins: [pluginPath],
        }),
      )
      await Config.get()
      const statuses = await Plugin.status()
      const ourPlugin = statuses.find((s) => s.path === pluginPath)
      expect(ourPlugin).toBeDefined()
      expect(ourPlugin?.status).toBe("disabled")
      expect(ourPlugin?.error).toContain("Disabled in configuration")
    },
  })
})

test("plugin metadata is extracted when available", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "plugin.ts"),
        `
        export const metadata = {
          name: "Test Plugin",
          version: "1.0.0",
          description: "A test plugin"
        }
        export const testPlugin = (input) => {
          return {
            config: async (config) => {}
          }
        }
      `,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const pluginPath = `file://${path.join(tmp.path, "plugin.ts")}`
      await Bun.write(
        path.join(tmp.path, "opencode.json"),
        JSON.stringify({
          plugin: [pluginPath],
        }),
      )
      await Config.get()
      const statuses = await Plugin.status()
      const ourPlugin = statuses.find((s) => s.path === pluginPath)
      expect(ourPlugin).toBeDefined()
      expect(ourPlugin?.status).toBe("loaded")
      expect(ourPlugin?.metadata).toBeDefined()
      expect(ourPlugin?.metadata?.name).toBe("Test Plugin")
      expect(ourPlugin?.metadata?.version).toBe("1.0.0")
      expect(ourPlugin?.metadata?.description).toBe("A test plugin")
    },
  })
})

test("plugin tracks which hooks it provides", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "plugin.ts"),
        `
        export const testPlugin = (input) => {
          return {
            config: async (config) => {},
            event: async ({ event }) => {},
          }
        }
      `,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const pluginPath = `file://${path.join(tmp.path, "plugin.ts")}`
      await Bun.write(
        path.join(tmp.path, "opencode.json"),
        JSON.stringify({
          plugin: [pluginPath],
        }),
      )
      await Config.get()
      const statuses = await Plugin.status()
      const ourPlugin = statuses.find((s) => s.path === pluginPath)
      expect(ourPlugin).toBeDefined()
      expect(ourPlugin?.status).toBe("loaded")
      expect(ourPlugin?.hooks).toContain("config")
      expect(ourPlugin?.hooks).toContain("event")
    },
  })
})

test("plugin validation rejects invalid package names", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const invalidPackage = "invalid package name with spaces"
      await Bun.write(
        path.join(tmp.path, "opencode.json"),
        JSON.stringify({
          plugin: [invalidPackage],
        }),
      )
      await Config.get()
      const statuses = await Plugin.status()
      const ourPlugin = statuses.find((s) => s.path === invalidPackage)
      expect(ourPlugin).toBeDefined()
      expect(ourPlugin?.status).toBe("failed")
      expect(ourPlugin?.error).toContain("Invalid package name")
    },
  })
})

test("plugin validation rejects invalid scoped package format", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const invalidScoped = "@invalid-scope"
      await Bun.write(
        path.join(tmp.path, "opencode.json"),
        JSON.stringify({
          plugin: [invalidScoped],
        }),
      )
      await Config.get()
      const statuses = await Plugin.status()
      const ourPlugin = statuses.find((s) => s.path === invalidScoped)
      expect(ourPlugin).toBeDefined()
      expect(ourPlugin?.status).toBe("failed")
      expect(ourPlugin?.error).toContain("Invalid scoped package name")
    },
  })
})

test("plugin with no exports fails with helpful error", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "plugin.ts"),
        `
        // Plugin with no exports
        console.log("No exports here")
      `,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const pluginPath = `file://${path.join(tmp.path, "plugin.ts")}`
      await Bun.write(
        path.join(tmp.path, "opencode.json"),
        JSON.stringify({
          plugin: [pluginPath],
        }),
      )
      await Config.get()
      const statuses = await Plugin.status()
      const ourPlugin = statuses.find((s) => s.path === pluginPath)
      expect(ourPlugin).toBeDefined()
      expect(ourPlugin?.status).toBe("failed")
      expect(ourPlugin?.error).toContain("no valid functions")
    },
  })
})
