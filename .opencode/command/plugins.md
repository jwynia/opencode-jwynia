---
description: Show status of all loaded and failed plugins
---

Fetch the plugin status from the GET /plugin API endpoint and display it in a clear, readable format.

For each plugin, show:
- Plugin path/name
- Status (loaded/failed/disabled)
- Error message (if failed)
- Loaded time (if loaded)
- Hooks provided (if loaded)

Format the output as a table or list that's easy to read. If any plugins failed, highlight them and show the error messages prominently so the user knows what went wrong.

If the OPENCODE_DISABLE_PLUGINS flag is set, mention that all plugins are disabled.

Also show summary statistics:
- Total plugins configured
- Successfully loaded
- Failed to load
- Hooks registered

Make the output actionable - if there are errors, suggest what the user might do to fix them (e.g., check file paths, install dependencies, fix syntax errors).
