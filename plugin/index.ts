/**
 * Server half of the Z.AI quota plugin: a no-op placeholder so the package
 * has a main entrypoint beside `./tui`. All work happens in the TUI half,
 * which runs locally in the terminal process and keeps the API key there.
 */

import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "zai.quota.server",
  setup() {},
})
