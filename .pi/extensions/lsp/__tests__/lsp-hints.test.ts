/**
 * Tests for filetypes.ts and hints.ts
 */

import { describe, expect, it, beforeEach } from "bun:test";
import {
  isLspSupported,
  isTypeScript,
  isBashScript,
  getLanguageId,
} from "../filetypes";
import {
  createHintState,
  resetHintState,
  detectLspHint,
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

  describe("isTypeScript", () => {
    it("returns true for .ts", () => expect(isTypeScript("foo.ts")).toBe(true));
    it("returns true for .tsx", () => expect(isTypeScript("foo.tsx")).toBe(true));
    it("returns true for .js", () => expect(isTypeScript("foo.js")).toBe(true));
    it("returns true for .jsx", () => expect(isTypeScript("foo.jsx")).toBe(true));
    it("returns true for .mts", () => expect(isTypeScript("foo.mts")).toBe(true));
    it("returns true for .cts", () => expect(isTypeScript("foo.cts")).toBe(true));
    it("returns true for .mjs", () => expect(isTypeScript("foo.mjs")).toBe(true));
    it("returns true for .cjs", () => expect(isTypeScript("foo.cjs")).toBe(true));
    it("returns false for .sh", () => expect(isTypeScript("foo.sh")).toBe(false));
    it("returns false for .md", () => expect(isTypeScript("foo.md")).toBe(false));
  });

  describe("isBashScript", () => {
    it("returns true for .sh", () => expect(isBashScript("foo.sh")).toBe(true));
    it("returns true for .bash", () => expect(isBashScript("foo.bash")).toBe(true));
    it("returns true for .zsh", () => expect(isBashScript("foo.zsh")).toBe(true));
    it("returns true for .ksh", () => expect(isBashScript("foo.ksh")).toBe(true));
    it("returns false for .ts", () => expect(isBashScript("foo.ts")).toBe(false));
    it("returns false for .md", () => expect(isBashScript("foo.md")).toBe(false));
  });

  describe("getLanguageId", () => {
    it("returns typescriptreact for .tsx", () => {
      expect(getLanguageId("foo.tsx")).toBe("typescriptreact");
    });
    it("returns javascriptreact for .jsx", () => {
      expect(getLanguageId("foo.jsx")).toBe("javascriptreact");
    });
    it("returns typescript for .ts", () => {
      expect(getLanguageId("foo.ts")).toBe("typescript");
    });
    it("returns typescript for .mts", () => {
      expect(getLanguageId("foo.mts")).toBe("typescript");
    });
    it("returns typescript for .cts", () => {
      expect(getLanguageId("foo.cts")).toBe("typescript");
    });
    it("returns shellscript for .sh", () => {
      expect(getLanguageId("foo.sh")).toBe("shellscript");
    });
    it("returns shellscript for .bash", () => {
      expect(getLanguageId("foo.bash")).toBe("shellscript");
    });
    it("returns shellscript for .zsh", () => {
      expect(getLanguageId("foo.zsh")).toBe("shellscript");
    });
    it("returns javascript for .js", () => {
      expect(getLanguageId("foo.js")).toBe("javascript");
    });
    it("returns javascript for .mjs", () => {
      expect(getLanguageId("foo.mjs")).toBe("javascript");
    });
    it("returns javascript for .cjs", () => {
      expect(getLanguageId("foo.cjs")).toBe("javascript");
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
    const hint = detectLspHint("read", { path: "/src/foo.ts" }, state);
    expect(hint).toContain("[lsp]");
    expect(hint).toContain("lsp symbols");
    expect(hint).toContain("/src/foo.ts");
  });

  it("read on .ts file with offset → no hint", () => {
    const hint = detectLspHint("read", { path: "/src/foo.ts", offset: 10 }, state);
    expect(hint).toBeNull();
  });

  it("read on .ts file with limit → no hint", () => {
    const hint = detectLspHint("read", { path: "/src/foo.ts", limit: 50 }, state);
    expect(hint).toBeNull();
  });

  it("read on .js file without offset → hint (now covered)", () => {
    const hint = detectLspHint("read", { path: "/src/foo.js" }, state);
    expect(hint).toContain("[lsp]");
    expect(hint).toContain("lsp symbols");
  });

  it("read on .md file → no hint", () => {
    const hint = detectLspHint("read", { path: "/docs/README.md" }, state);
    expect(hint).toBeNull();
  });

  it("bash with grep -rn → hint", () => {
    const hint = detectLspHint("bash", { command: 'grep -rn "Symbol" src/' }, state);
    expect(hint).toContain("[lsp]");
    expect(hint).toContain("lsp references");
  });

  it("bash with rg and -t ts → hint", () => {
    const hint = detectLspHint("bash", { command: 'rg "Type" -t ts' }, state);
    expect(hint).toContain("[lsp]");
    expect(hint).toContain("lsp references");
  });

  it("bash with cat foo.ts → hint (symbols)", () => {
    const hint = detectLspHint("bash", { command: "cat foo.ts" }, state);
    expect(hint).toContain("[lsp]");
    expect(hint).toContain("lsp symbols");
  });

  it("bash with cat foo.md → no hint", () => {
    const hint = detectLspHint("bash", { command: "cat README.md" }, state);
    expect(hint).toBeNull();
  });

  it("bash with non-grep command → no hint", () => {
    const hint = detectLspHint("bash", { command: "npm install" }, state);
    expect(hint).toBeNull();
  });

  it("edit tool → no hint", () => {
    const hint = detectLspHint("edit", { path: "/src/foo.ts" }, state);
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
        detectLspHint("bash", { command: "npm install" }, state);
      }
      results.push(detectLspHint("read", { path: file }, state));
    }

    // First MAX_HINTS should be non-null
    for (let i = 0; i < MAX_HINTS; i++) {
      expect(results[i]).not.toBeNull();
    }
    // 6th should be null
    expect(results[MAX_HINTS]).toBeNull();
  });

  it("dedup: same file hinted twice → hint only once", () => {
    const hint1 = detectLspHint("read", { path: "/src/foo.ts" }, state);
    expect(hint1).not.toBeNull();

    // Advance past cooldown
    for (let i = 0; i < COOLDOWN; i++) {
      detectLspHint("bash", { command: "npm install" }, state);
    }

    const hint2 = detectLspHint("read", { path: "/src/foo.ts" }, state);
    expect(hint2).toBeNull();
  });

  it("cooldown: consecutive hints within COOLDOWN → no hint", () => {
    // First hint should fire
    const hint1 = detectLspHint("read", { path: "/src/foo.ts" }, state);
    expect(hint1).not.toBeNull();

    // Next call immediately (within cooldown) → no hint even for different file
    const hint2 = detectLspHint("read", { path: "/src/bar.ts" }, state);
    expect(hint2).toBeNull();

    // Still within cooldown
    const hint3 = detectLspHint("read", { path: "/src/baz.ts" }, state);
    expect(hint3).toBeNull();
  });

  it("cooldown: hint fires again after COOLDOWN calls", () => {
    // First hint
    const hint1 = detectLspHint("read", { path: "/src/foo.ts" }, state);
    expect(hint1).not.toBeNull();

    // Exhaust cooldown with neutral calls
    for (let i = 0; i < COOLDOWN - 1; i++) {
      detectLspHint("bash", { command: "npm install" }, state);
    }

    // Should still be in cooldown (lastHintIndex=1, currentIndex=1+COOLDOWN-1, diff=COOLDOWN-1 < COOLDOWN)
    const hint2 = detectLspHint("read", { path: "/src/bar.ts" }, state);
    // After exactly COOLDOWN neutral calls, diff = COOLDOWN >= COOLDOWN → hint fires
    // But we only did COOLDOWN-1 neutral calls above + this read = COOLDOWN calls total → diff = COOLDOWN
    expect(hint2).not.toBeNull();
  });

  it("resetHintState clears all state", () => {
    // Trigger some hints
    detectLspHint("read", { path: "/src/foo.ts" }, state);
    detectLspHint("read", { path: "/src/bar.ts" }, state);
    expect(state.hintCount).toBeGreaterThan(0);

    resetHintState(state);
    expect(state.hintCount).toBe(0);
    expect(state.hintedFiles.size).toBe(0);
    expect(state.lastHintIndex).toBe(0);
    expect(state.currentIndex).toBe(0);

    // Should be able to hint same file again after reset
    const hint = detectLspHint("read", { path: "/src/foo.ts" }, state);
    expect(hint).not.toBeNull();
  });

  it("MAX_HINTS and COOLDOWN are exported constants", () => {
    expect(MAX_HINTS).toBe(5);
    expect(COOLDOWN).toBe(3);
  });
});
