import type { Hooks, PluginInput, Plugin as PluginInstance } from "@opencode-ai/plugin"
import { Config } from "../config/config"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Server } from "../server/server"
import { BunProc } from "../bun"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import fs from "fs/promises"
import path from "path"

export namespace Plugin {
  const log = Log.create({ service: "plugin" })
  const debugMode = Flag.OPENCODE_DEBUG_PLUGINS

  export type PluginStatus = {
    path: string
    status: "loaded" | "failed" | "disabled"
    error?: string
    loadedAt?: Date
    hooks?: string[]
    metadata?: {
      name?: string
      version?: string
      description?: string
    }
  }

  /**
   * Extract metadata from a plugin module if available
   */
  function extractMetadata(mod: any): PluginStatus["metadata"] {
    const metadata: PluginStatus["metadata"] = {}

    // Look for metadata exports
    if (mod.metadata && typeof mod.metadata === "object") {
      metadata.name = mod.metadata.name
      metadata.version = mod.metadata.version
      metadata.description = mod.metadata.description
    }

    // Alternative: look for individual exports
    if (!metadata.name && typeof mod.name === "string") {
      metadata.name = mod.name
    }
    if (!metadata.version && typeof mod.version === "string") {
      metadata.version = mod.version
    }
    if (!metadata.description && typeof mod.description === "string") {
      metadata.description = mod.description
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined
  }

  type ValidationResult = {
    valid: boolean
    error?: string
    suggestion?: string
  }

  /**
   * Generate actionable error suggestions based on error type
   */
  function getErrorSuggestion(error: unknown, context: "install" | "import" | "init"): string {
    const errorMessage = error instanceof Error ? error.message : String(error)

    // Installation errors
    if (context === "install") {
      if (errorMessage.includes("404") || errorMessage.includes("not found")) {
        return "Package not found on npm. Verify the package name and version are correct."
      }
      if (errorMessage.includes("network") || errorMessage.includes("ENOTFOUND")) {
        return "Network error. Check your internet connection and try again."
      }
      if (errorMessage.includes("permission") || errorMessage.includes("EACCES")) {
        return "Permission denied. Check file permissions or try running with appropriate permissions."
      }
      return "Check the package name and version, ensure npm registry is accessible."
    }

    // Import errors
    if (context === "import") {
      if (errorMessage.includes("SyntaxError") || errorMessage.includes("Unexpected token")) {
        return "Syntax error in plugin code. Fix syntax errors in the plugin file and try again."
      }
      if (errorMessage.includes("Cannot find module") || errorMessage.includes("Module not found")) {
        return "Missing dependency. Run 'bun install' in the plugin directory or check import paths."
      }
      if (errorMessage.includes("Unexpected identifier")) {
        return "Invalid JavaScript/TypeScript syntax. Review the plugin code for syntax errors."
      }
      return "Check plugin syntax and ensure all dependencies are installed."
    }

    // Initialization errors
    if (context === "init") {
      if (errorMessage.includes("is not a function")) {
        return "Plugin export is not a valid function. Ensure the plugin exports functions that return hook objects."
      }
      if (errorMessage.includes("undefined") || errorMessage.includes("null")) {
        return "Plugin returned invalid value. Check that plugin functions return valid hook objects."
      }
      return "Check plugin initialization logic and ensure it follows the plugin API specification."
    }

    return "Review the error message and plugin code to identify the issue."
  }

  /**
   * Validate a plugin path before attempting to load it
   */
  async function validatePlugin(pluginPath: string): Promise<ValidationResult> {
    // Check for file:// URLs
    if (pluginPath.startsWith("file://")) {
      const filePath = pluginPath.replace("file://", "")

      // Check if file exists
      try {
        const stats = await fs.stat(filePath)
        if (!stats.isFile()) {
          return {
            valid: false,
            error: "Path exists but is not a file",
            suggestion: `Expected a file but found a directory at: ${filePath}`,
          }
        }
      } catch (err) {
        return {
          valid: false,
          error: "File not found",
          suggestion: `Plugin file does not exist: ${filePath}. Check the path and ensure the file is present.`,
        }
      }

      // Check file extension
      const ext = path.extname(filePath)
      if (![".ts", ".js", ".mjs", ".cjs"].includes(ext)) {
        return {
          valid: false,
          error: `Unsupported file type: ${ext}`,
          suggestion: `Plugin files must be TypeScript (.ts) or JavaScript (.js, .mjs, .cjs). Found: ${ext}`,
        }
      }

      return { valid: true }
    }

    // Validate npm package name format
    const lastAtIndex = pluginPath.lastIndexOf("@")
    const pkg = lastAtIndex > 0 ? pluginPath.substring(0, lastAtIndex) : pluginPath
    const version = lastAtIndex > 0 ? pluginPath.substring(lastAtIndex + 1) : "latest"

    // Check for invalid characters in package name
    if (pkg.includes(" ") || pkg.includes("\n") || pkg.includes("\t")) {
      return {
        valid: false,
        error: "Invalid package name",
        suggestion: `Package name contains whitespace: "${pkg}". Remove spaces and special characters.`,
      }
    }

    // Check for scoped package format
    if (pkg.startsWith("@") && !pkg.includes("/")) {
      return {
        valid: false,
        error: "Invalid scoped package name",
        suggestion: `Scoped packages must include a slash: @scope/package. Found: ${pkg}`,
      }
    }

    // Check for empty package name
    if (!pkg || pkg.trim() === "") {
      return {
        valid: false,
        error: "Empty package name",
        suggestion: "Package name cannot be empty",
      }
    }

    return { valid: true }
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

    const disabledPlugins = new Set(config.disabled_plugins ?? [])

    for (let plugin of plugins) {
      const originalPath = plugin
      log.info("loading plugin", { path: plugin })

      // Check if plugin is disabled in config
      if (disabledPlugins.has(plugin)) {
        log.info("plugin disabled via config", { path: plugin })
        pluginStatuses.push({
          path: originalPath,
          status: "disabled",
          error: "Disabled in configuration (disabled_plugins list)",
        })
        continue // Skip to next plugin
      }

      // Validate plugin before attempting to load
      const validation = await validatePlugin(plugin)
      if (!validation.valid) {
        log.error("plugin validation failed", {
          path: plugin,
          error: validation.error,
          suggestion: validation.suggestion,
        })
        pluginStatuses.push({
          path: originalPath,
          status: "failed",
          error: `${validation.error}${validation.suggestion ? `: ${validation.suggestion}` : ""}`,
        })
        continue // Skip to next plugin
      }

      if (debugMode) {
        log.info("plugin validation passed", { path: plugin })
      }

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
            const suggestion = getErrorSuggestion(installError, "install")
            log.error("plugin installation failed", { pkg, version, error: errorMessage, suggestion })
            pluginStatuses.push({
              path: originalPath,
              status: "failed",
              error: `Installation failed: ${errorMessage}. ${suggestion}`,
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
          const suggestion = getErrorSuggestion(importError, "import")
          log.error("plugin import failed", { path: plugin, error: errorMessage, suggestion })
          pluginStatuses.push({
            path: originalPath,
            status: "failed",
            error: `Import failed: ${errorMessage}. ${suggestion}`,
          })
          continue // Skip to next plugin
        }

        // Initialize plugin functions
        const pluginHookNames: string[] = []
        let pluginHookCount = 0
        for (const [name, fn] of Object.entries<PluginInstance>(mod)) {
          if (typeof fn !== "function") continue

          try {
            if (debugMode) {
              log.info("initializing plugin function", { path: plugin, function: name })
            }
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
            if (debugMode) {
              log.info("plugin function initialized", {
                path: plugin,
                function: name,
                providedHooks: Object.keys(init || {}),
              })
            }
          } catch (initError) {
            const errorMessage = initError instanceof Error ? initError.message : String(initError)
            const suggestion = getErrorSuggestion(initError, "init")
            log.error("plugin initialization failed", {
              path: plugin,
              function: name,
              error: errorMessage,
              suggestion,
            })
            // Don't fail the entire plugin if one function fails
            // Just log and continue with other functions
          }
        }

        if (pluginHookCount > 0) {
          const metadata = extractMetadata(mod)
          log.info("plugin loaded successfully", {
            path: plugin,
            hooks: pluginHookCount,
            hookNames: pluginHookNames,
            metadata,
          })
          pluginStatuses.push({
            path: originalPath,
            status: "loaded",
            loadedAt: new Date(),
            hooks: pluginHookNames,
            metadata,
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
