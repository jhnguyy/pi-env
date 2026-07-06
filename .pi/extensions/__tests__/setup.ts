import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

initTheme("gruvbox-dark", false);
setKeybindings(new KeybindingsManager({
  ...TUI_KEYBINDINGS,
  "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
}));
