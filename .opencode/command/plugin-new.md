---
description: Create a new OpenCode plugin from a template
---

Create a new OpenCode plugin in the .opencode/plugin/ directory.

The plugin name should be provided in $ARGUMENTS (e.g., "my-plugin").

Create a new TypeScript file named `$ARGUMENTS.ts` in `.opencode/plugin/` with the following template:

```typescript
// OpenCode Plugin: $ARGUMENTS
// Generated: [current date]
import type { Plugin } from "@opencode-ai/plugin"

// Plugin metadata (optional)
export const metadata = {
  name: "$ARGUMENTS",
  version: "1.0.0",
  description: "A custom OpenCode plugin",
}

// Main plugin function
export const $ARGUMENTS: Plugin = (input) => {
  // Access to OpenCode client, project info, and shell
  const { client, project, worktree, directory, $ } = input

  return {
    // Config hook: called when plugin loads
    config: async (config) => {
      console.log("Plugin $ARGUMENTS loaded!")
    },

    // Event hook: called for all OpenCode events
    event: async ({ event }) => {
      // Handle OpenCode events
      // console.log("Event received:", event)
    },

    // Tool hook: add custom tools (optional)
    // tool: async () => {
    //   return [{
    //     name: "my_tool",
    //     description: "My custom tool",
    //     parameters: {},
    //     execute: async (params) => {
    //       return { result: "success" }
    //     }
    //   }]
    // },
  }
}
```

After creating the file:

1. Show the full path to the created plugin file
2. Explain that the plugin will be automatically loaded on next OpenCode restart
3. Suggest adding the plugin to .opencode/opencode.jsonc if they want to share it with the team
4. Mention they can test it with `/plugin-test file://<path-to-plugin>` before restarting
5. Suggest enabling debug mode with `OPENCODE_DEBUG_PLUGINS=1` to see detailed loading logs

If the plugin name is missing from $ARGUMENTS, ask the user to provide a plugin name.
