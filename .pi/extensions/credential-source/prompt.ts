import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

class SecretInput implements Component, Focusable {
  focused = false;
  readonly #done: (value: string | undefined) => void;
  #value = "";

  constructor(done: (value: string | undefined) => void) {
    this.#done = done;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter)) {
      this.#done(this.#value);
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.#done(undefined);
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.#value = this.#value.slice(0, -1);
      return;
    }
    if (/^[\x20-\x7e]+$/.test(data)) this.#value += data;
  }

  render(width: number): string[] {
    const mask = "•".repeat(this.#value.length);
    return [
      truncateToWidth("Bitwarden session key", width),
      truncateToWidth(`${mask}${this.focused ? CURSOR_MARKER : ""} `, width),
      truncateToWidth("enter submit • esc cancel", width),
    ];
  }

  invalidate(): void {}
}

export function promptBitwardenSession(ctx: ExtensionContext): Promise<string | undefined> {
  if (!ctx.hasUI) return Promise.resolve(undefined);
  return ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
    const input = new SecretInput(done);
    return {
      get focused() {
        return input.focused;
      },
      set focused(value: boolean) {
        input.focused = value;
      },
      render: (width) => input.render(width),
      handleInput: (data) => {
        input.handleInput(data);
        tui.requestRender();
      },
      invalidate: () => input.invalidate(),
    };
  });
}
