import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";

type Submit = NonNullable<EditorComponent["onSubmit"]>;

export function routeShare(editor: EditorComponent): void {
  let submit = editor.onSubmit;
  // Pi assigns onSubmit after constructing the editor. Keep routing on later assignments too.
  Object.defineProperty(editor, "onSubmit", {
    configurable: true,
    get: () => submit ? (text: string) => submit!(text.trim() === "/share" ? "/share-private" : text) : undefined,
    set: (handler: Submit | undefined) => { submit = handler; },
  });
}

export function installShareRouting(pi: ExtensionAPI): void {
  let installed = false;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || installed) return;
    const previous = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = previous ? previous(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
      routeShare(editor);
      return editor;
    });
    installed = true;
  });
}
