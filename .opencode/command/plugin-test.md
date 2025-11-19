---
description: Test and validate a plugin without loading it into OpenCode
---

Test an OpenCode plugin to verify it works correctly before adding it to your configuration.

The plugin path should be provided in $ARGUMENTS (e.g., "file:///path/to/plugin.ts" or "my-plugin-package@1.0.0").

Perform the following validation steps:

1. **Path Validation**
   - For file:// paths: Check if the file exists
   - For npm packages: Validate package name format
   - Report any path/format issues

2. **Import Test**
   - Try to import the plugin module
   - Report syntax errors or missing dependencies
   - Show any import failures with detailed error messages

3. **Structure Validation**
   - Check that the plugin exports valid functions
   - Verify each function follows the Plugin API
   - Check for optional metadata export

4. **Dry Run**
   - Call each plugin function with test input
   - Verify it returns a valid hooks object
   - List all hooks the plugin provides (config, event, tool, auth)
   - Do NOT actually register the hooks

5. **Report Results**
   - Show validation status (PASS/FAIL)
   - List all hooks provided
   - Display metadata if present (name, version, description)
   - Show any errors or warnings
   - Provide suggestions for fixes if validation fails

6. **Next Steps**
   - If validation passes: Suggest adding to .opencode/opencode.jsonc plugin array
   - If validation fails: Show how to fix the issues
   - Mention that `/plugins` command shows status of loaded plugins
   - Suggest using `OPENCODE_DEBUG_PLUGINS=1` for detailed logs

Format the output clearly with sections for each validation step and a summary at the end.

If no plugin path is provided in $ARGUMENTS, show usage examples:

- Test local file: `/plugin-test file:///path/to/my-plugin.ts`
- Test npm package: `/plugin-test my-plugin-package@1.0.0`
