/**
 * Tests for filetypes.ts and hints.ts
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { isLspSupported } from "../filetypes";
import { BACKEND_CONFIGS } from "../backend-configs";
import { LspBackend } from "../backend";
import {
  createHintState,
  resetHintState,
  detectDevToolsHint,
  MAX_HINTS,
  COOLDOWN,
  type HintState,
} from "../hints";

// ─── filetypes.ts ─────────────────────────────────────────────────────────────

describe("filetypes", () => {
  describe("isLspSupported", () => {
    it("returns true for .ts files", () => {
      expect(isLspSupported("foo.ts")).toBe(true);
    });
    it("returns true for .tsx files", () => {
      expect(isLspSupported("foo.tsx")).toBe(true);
    });
    it("returns true for .js files", () => {
      expect(isLspSupported("foo.js")).toBe(true);
    });
    it("returns true for .jsx files", () => {
      expect(isLspSupported("foo.jsx")).toBe(true);
    });
    it("returns true for .mts files", () => {
      expect(isLspSupported("foo.mts")).toBe(true);
    });
    it("returns true for .cts files", () => {
      expect(isLspSupported("foo.cts")).toBe(true);
    });
    it("returns true for .mjs files", () => {
      expect(isLspSupported("foo.mjs")).toBe(true);
    });
    it("returns true for .cjs files", () => {
      expect(isLspSupported("foo.cjs")).toBe(true);
    });
    it("returns true for .sh files", () => {
      expect(isLspSupported("foo.sh")).toBe(true);
    });
    it("returns true for .bash files", () => {
      expect(isLspSupported("foo.bash")).toBe(true);
    });
    it("returns true for .zsh files", () => {
      expect(isLspSupported("foo.zsh")).toBe(true);
    });
    it("returns true for .ksh files", () => {
      expect(isLspSupported("foo.ksh")).toBe(true);
    });
    it("returns false for .md files", () => {
      expect(isLspSupported("foo.md")).toBe(false);
    });
    it("returns false for .py files", () => {
      expect(isLspSupported("foo.py")).toBe(false);
    });
    it("returns false for files with no extension", () => {
      expect(isLspSupported("Makefile")).toBe(false);
    });
    it("works with absolute paths", () => {
      expect(isLspSupported("/home/user/project/src/index.ts")).toBe(true);
    });
  });

  describe("LspBackend.handles and getLanguageId (via configs)", () => {
    const backends = BACKEND_CONFIGS.map((c) => new LspBackend(c));
    const getBackend = (path: string) => backends.find((b) => b.handles(path));

    it("typescript backend handles .ts", () => {
      const b = getBackend("foo.ts");
      expect(b?.name).toBe("typescript");
      expect(b?.getLanguageId("foo.ts")).toBe("typescript");
    });
    it("typescript backend returns typescriptreact for .tsx", () => {
      expect(getBackend("foo.tsx")?.getLanguageId("foo.tsx")).toBe("typescriptreact");
    });
    it("typescript backend returns javascript for .js", () => {
      expect(getBackend("foo.js")?.getLanguageId("foo.js")).toBe("javascript");
    });
    it("typescript backend returns javascriptreact for .jsx", () => {
      expect(getBackend("foo.jsx")?.getLanguageId("foo.jsx")).toBe("javascriptreact");
    });
    it("bash backend handles .sh", () => {
      const b = getBackend("foo.sh");
      expect(b?.name).toBe("bash");
      expect(b?.getLanguageId("foo.sh")).toBe("shellscript");
    });
    it("bash backend handles .bash", () => {
      expect(getBackend("foo.bash")?.name).toBe("bash");
    });
    it("nil backend handles .nix", () => {
      const b = getBackend("foo.nix");
      expect(b?.name).toBe("nil");
      expect(b?.getLanguageId("foo.nix")).toBe("nix");
    });
    it("no backend handles .md", () => {
      expect(getBackend("foo.md")).toBeUndefined();
    });
    it("no backend handles .py", () => {
      expect(getBackend("foo.py")).toBeUndefined();
    });
  });
});

// ─── hints.ts — detection ─────────────────────────────────────────────────────

describe("hints detection", () => {
  let state: HintState;

  beforeEach(() => {
    state = createHintState();
  });

  it("read on .ts file without offset → hint", () => {
    const hint = detectDevToolsHint("read", { path: "/src/foo.ts" }, state);
    expect(hint).toContain("[dev-tools]");
    expect(hint).toContain("dev-tools symbols");
    expect(hint).toContain("/src/foo.ts");
  });

  it("read on .ts file with offset → no hint", () => {
    const hint = detectDevToolsHint("read", { path: "/src/foo.ts", offset: 10 }, state);
    expect(hint).toBeNull();
  });

  it("read on .ts file with limit → no hint", () => {
    const hint = detectDevToolsHint("read", { path: "/src/foo.ts", limit: 50 }, state);
    expect(hint).toBeNull();
  });

  it("read on .js file without offset → hint (now covered)", () => {
    const hint = detectDevToolsHint("read", { path: "/src/foo.js" }, state);
    expect(hint).toContain("[dev-tools]");
    expect(hint).toContain("dev-tools symbols");
  });

  it("read on .md file → no hint", () => {
    const hint = detectDevToolsHint("read", { path: "/docs/README.md" }, state);
    expect(hint).toBeNull();
  });

  it("bash with grep for PascalCase symbol → targeted hint with symbol name", () => {
    const hint = detectDevToolsHint("bash", { command: 'grep -rn "LspClient" src/' }, state);
    expect(hint).toContain("[dev-tools]");
    expect(hint).toContain('"LspClient"');
    expect(hint).toContain("dev-tools references");
    expect(hint).toContain("dev-tools incoming-calls");
  });

  it("bash with rg for camelCase symbol → targeted hint with symbol name", () => {
    const hint = detectDevToolsHint("bash", { command: 'rg "handleRequest" -t ts' }, state);
    expect(hint).toContain("[dev-tools]");
    expect(hint).toContain('"handleRequest"');
    expect(hint).toContain("dev-tools incoming-calls");
  });

  it("bash with grep for non-symbol pattern → generic hint", () => {
    const hint = detectDevToolsHint("bash", { command: 'grep -rn "TODO" src/' }, state);
    expect(hint).toContain("[dev-tools]");
    expect(hint).toContain("incoming-calls/outgoing-calls");
  });

  it("bash with cat foo.ts → hint (symbols)", () => {
    const hint = detectDevToolsHint("bash", { command: "cat foo.ts" }, state);
    expect(hint).toContain("[dev-tools]");
    expect(hint).toContain("dev-tools symbols");
  });

  it("bash with cat foo.md → no hint", () => {
    const hint = detectDevToolsHint("bash", { command: "cat README.md" }, state);
    expect(hint).toBeNull();
  });

  it("bash with non-grep command → no hint", () => {
    const hint = detectDevToolsHint("bash", { command: "npm install" }, state);
    expect(hint).toBeNull();
  });

  it("edit tool → no hint", () => {
    const hint = detectDevToolsHint("edit", { path: "/src/foo.ts" }, state);
    expect(hint).toBeNull();
  });
});

// ─── hints.ts — stateful behavior ─────────────────────────────────────────────

describe("hints stateful behavior", () => {
  let state: HintState;

  beforeEach(() => {
    state = createHintState();
  });

  it("budget: 6th hint returns null", () => {
    // Show MAX_HINTS hints (on different files and spaced apart)
    const files = ["/a.ts", "/b.ts", "/c.ts", "/d.ts", "/e.ts", "/f.ts"];
    const results: (string | null)[] = [];

    for (const file of files) {
      // Advance currentIndex past cooldown between hints
      for (let i = 0; i < COOLDOWN; i++) {
        detectDevToolsHint("bash", { command: "npm install" }, state);
      }
      results.push(detectDevToolsHint("read", { path: file }, state));
    }

    // First MAX_HINTS should be non-null
    for (let i = 0; i < MAX_HINTS; i++) {
      expect(results[i]).not.toBeNull();
    }
    // 6th should be null
    expect(results[MAX_HINTS]).toBeNull();
  });

  it("dedup: same file hinted twice → hint only once", () => {
    const hint1 = detectDevToolsHint("read", { path: "/src/foo.ts" }, state);
    expect(hint1).not.toBeNull();

    // Advance past cooldown
    for (let i = 0; i < COOLDOWN; i++) {
      detectDevToolsHint("bash", { command: "npm install" }, state);
    }

    const hint2 = detectDevToolsHint("read", { path: "/src/foo.ts" }, state);
    expect(hint2).toBeNull();
  });

  it("cooldown: consecutive hints within COOLDOWN → no hint", () => {
    // First hint should fire
    const hint1 = detectDevToolsHint("read", { path: "/src/foo.ts" }, state);
    expect(hint1).not.toBeNull();

    // Next call immediately (within cooldown) → no hint even for different file
    const hint2 = detectDevToolsHint("read", { path: "/src/bar.ts" }, state);
    expect(hint2).toBeNull();

    // Still within cooldown
    const hint3 = detectDevToolsHint("read", { path: "/src/baz.ts" }, state);
    expect(hint3).toBeNull();
  });

  it("cooldown: hint fires again after COOLDOWN calls", () => {
    // First hint
    const hint1 = detectDevToolsHint("read", { path: "/src/foo.ts" }, state);
    expect(hint1).not.toBeNull();

    // Exhaust cooldown with neutral calls
    for (let i = 0; i < COOLDOWN - 1; i++) {
      detectDevToolsHint("bash", { command: "npm install" }, state);
    }

    // Should still be in cooldown (lastHintIndex=1, currentIndex=1+COOLDOWN-1, diff=COOLDOWN-1 < COOLDOWN)
    const hint2 = detectDevToolsHint("read", { path: "/src/bar.ts" }, state);
    // After exactly COOLDOWN neutral calls, diff = COOLDOWN >= COOLDOWN → hint fires
    // But we only did COOLDOWN-1 neutral calls above + this read = COOLDOWN calls total → diff = COOLDOWN
    expect(hint2).not.toBeNull();
  });

  it("resetHintState clears all state", () => {
    // Trigger some hints
    detectDevToolsHint("read", { path: "/src/foo.ts" }, state);
    detectDevToolsHint("read", { path: "/src/bar.ts" }, state);
    expect(state.hintCount).toBeGreaterThan(0);

    resetHintState(state);
    expect(state.hintCount).toBe(0);
    expect(state.hintedFiles.size).toBe(0);
    expect(state.lastHintIndex).toBe(0);
    expect(state.currentIndex).toBe(0);

    // Should be able to hint same file again after reset
    const hint = detectDevToolsHint("read", { path: "/src/foo.ts" }, state);
    expect(hint).not.toBeNull();
  });

  it("MAX_HINTS and COOLDOWN are exported constants", () => {
    expect(MAX_HINTS).toBe(5);
    expect(COOLDOWN).toBe(3);
  });
});
