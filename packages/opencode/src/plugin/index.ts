import type { Hooks, PluginInput, Plugin as PluginInstance } from "@opencode-ai/plugin"
import { Config } from "../config/config"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Server } from "../server/server"
import { BunProc } from "../bun"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"

export namespace Plugin {
  const log = Log.create({ service: "plugin" })

  export type PluginStatus = {
    path: string
    status: "loaded" | "failed" | "disabled"
    error?: string
    loadedAt?: Date
    hooks?: string[]
  }

  const state = Instance.state(async () => {
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
      // @ts-ignore - fetch type incompatibility
      fetch: async (...args) => Server.App().fetch(...args),
    })
    const config = await Config.get()
    const hooks = []
    const pluginStatuses: PluginStatus[] = []
    const input: PluginInput = {
      client,
      project: Instance.project,
      worktree: Instance.worktree,
      directory: Instance.directory,
      $: Bun.$,
    }

    // Check if plugins are disabled entirely
    if (Flag.OPENCODE_DISABLE_PLUGINS) {
      log.info("plugins disabled via OPENCODE_DISABLE_PLUGINS flag")
      return { hooks, input, pluginStatuses }
    }

    const plugins = [...(config.plugin ?? [])]
    if (!Flag.OPENCODE_DISABLE_DEFAULT_PLUGINS) {
      plugins.push("opencode-copilot-auth@0.0.5")
      plugins.push("opencode-anthropic-auth@0.0.2")
    }

    for (let plugin of plugins) {
      const originalPath = plugin
      log.info("loading plugin", { path: plugin })

      try {
        // Install npm package if needed
        if (!plugin.startsWith("file://")) {
          const lastAtIndex = plugin.lastIndexOf("@")
          const pkg = lastAtIndex > 0 ? plugin.substring(0, lastAtIndex) : plugin
          const version = lastAtIndex > 0 ? plugin.substring(lastAtIndex + 1) : "latest"

          try {
            plugin = await BunProc.install(pkg, version)
            log.info("plugin package installed", { pkg, version, path: plugin })
          } catch (installError) {
            const errorMessage = installError instanceof Error ? installError.message : String(installError)
            log.error("plugin installation failed", { pkg, version, error: errorMessage })
            pluginStatuses.push({
              path: originalPath,
              status: "failed",
              error: `Installation failed: ${errorMessage}`,
            })
            continue // Skip to next plugin
          }
        }

        // Import the plugin module
        let mod: any
        try {
          mod = await import(plugin)
          log.info("plugin module imported", { path: plugin })
        } catch (importError) {
          const errorMessage = importError instanceof Error ? importError.message : String(importError)
          log.error("plugin import failed", { path: plugin, error: errorMessage })
          pluginStatuses.push({
            path: originalPath,
            status: "failed",
            error: `Import failed: ${errorMessage}`,
          })
          continue // Skip to next plugin
        }

        // Initialize plugin functions
        const pluginHookNames: string[] = []
        let pluginHookCount = 0
        for (const [name, fn] of Object.entries<PluginInstance>(mod)) {
          if (typeof fn !== "function") continue

          try {
            const init = await fn(input)
            hooks.push(init)
            pluginHookCount++

            // Track which hooks this plugin provides
            if (init) {
              for (const hookName of Object.keys(init)) {
                if (typeof init[hookName] === "function") {
                  pluginHookNames.push(hookName)
                }
              }
            }
          } catch (initError) {
            const errorMessage = initError instanceof Error ? initError.message : String(initError)
            log.error("plugin initialization failed", {
              path: plugin,
              function: name,
              error: errorMessage,
            })
            // Don't fail the entire plugin if one function fails
            // Just log and continue with other functions
          }
        }

        if (pluginHookCount > 0) {
          log.info("plugin loaded successfully", {
            path: plugin,
            hooks: pluginHookCount,
            hookNames: pluginHookNames,
          })
          pluginStatuses.push({
            path: originalPath,
            status: "loaded",
            loadedAt: new Date(),
            hooks: pluginHookNames,
          })
        } else {
          log.warn("plugin loaded but provided no hooks", { path: plugin })
          pluginStatuses.push({
            path: originalPath,
            status: "failed",
            error: "Plugin module exported no valid functions",
          })
        }
      } catch (unknownError) {
        // Catch-all for any unexpected errors
        const errorMessage = unknownError instanceof Error ? unknownError.message : String(unknownError)
        log.error("unexpected plugin error", { path: originalPath, error: errorMessage })
        pluginStatuses.push({
          path: originalPath,
          status: "failed",
          error: `Unexpected error: ${errorMessage}`,
        })
      }
    }

    // Log summary
    const loaded = pluginStatuses.filter((p) => p.status === "loaded").length
    const failed = pluginStatuses.filter((p) => p.status === "failed").length
    log.info("plugin loading complete", {
      total: plugins.length,
      loaded,
      failed,
      hooks: hooks.length,
    })

    return {
      hooks,
      input,
      pluginStatuses,
    }
  })

  export async function trigger<
    Name extends Exclude<keyof Required<Hooks>, "auth" | "event" | "tool">,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(name: Name, input: Input, output: Output): Promise<Output> {
    if (!name) return output
    for (const hook of await state().then((x) => x.hooks)) {
      const fn = hook[name]
      if (!fn) continue
      try {
        // @ts-expect-error if you feel adventurous, please fix the typing, make sure to bump the try-counter if you
        // give up.
        // try-counter: 2
        await fn(input, output)
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        log.error("plugin hook execution failed", {
          hook: name,
          error: errorMessage,
        })
        // Continue with other hooks even if one fails
      }
    }
    return output
  }

  export async function list() {
    try {
      return state().then((x) => x.hooks)
    } catch (error) {
      log.error("failed to list plugins", { error })
      return []
    }
  }

  export async function status(): Promise<PluginStatus[]> {
    try {
      return state().then((x) => x.pluginStatuses)
    } catch (error) {
      log.error("failed to get plugin status", { error })
      return []
    }
  }

  export async function init() {
    try {
      const hooks = await state().then((x) => x.hooks)
      const config = await Config.get()
      for (const hook of hooks) {
        try {
          await hook.config?.(config)
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          log.error("plugin config hook failed", { error: errorMessage })
          // Continue with other plugins
        }
      }
      Bus.subscribeAll(async (input) => {
        const hooks = await state().then((x) => x.hooks)
        for (const hook of hooks) {
          try {
            hook["event"]?.({
              event: input,
            })
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error)
            log.error("plugin event hook failed", { error: errorMessage })
            // Continue with other plugins
          }
        }
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error("plugin initialization completely failed", { error: errorMessage })
      // Don't throw - allow the app to continue without plugins
    }
  }
}
