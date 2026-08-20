"use client";

import { useEffect, useMemo, useState } from "react";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import type { DiagramPlugin, MathPlugin, PluginConfig } from "streamdown";

/**
 * `@streamdown/mermaid` and `@streamdown/math` statically import the whole of
 * Mermaid and KaTeX, which together dwarf the rest of the chat route. Most
 * conversations contain neither, so both are fetched only once a message body
 * shows it needs them, and the message re-renders with the plugin in place.
 */
const MERMAID_FENCE = /```[ \t]*mermaid\b/i;
const MATH_DELIMITER = /\$|\\\(|\\\[/;

type LazyPlugins = {
  mermaid?: DiagramPlugin;
  math?: MathPlugin;
};

let mermaidPlugin: DiagramPlugin | undefined;
let mathPlugin: MathPlugin | undefined;

export function useStreamdownPlugins(content: unknown): PluginConfig {
  const markdown = typeof content === "string" ? content : "";
  const wantsMermaid = MERMAID_FENCE.test(markdown);
  const wantsMath = MATH_DELIMITER.test(markdown);
  const [loaded, setLoaded] = useState<LazyPlugins>(() => ({
    ...(mermaidPlugin ? { mermaid: mermaidPlugin } : {}),
    ...(mathPlugin ? { math: mathPlugin } : {}),
  }));

  useEffect(() => {
    if (!wantsMermaid || loaded.mermaid) return;
    let active = true;
    void import("@streamdown/mermaid").then(({ mermaid }) => {
      mermaidPlugin = mermaid;
      if (active) setLoaded((current) => ({ ...current, mermaid }));
    });
    return () => {
      active = false;
    };
  }, [loaded.mermaid, wantsMermaid]);

  useEffect(() => {
    if (!wantsMath || loaded.math) return;
    let active = true;
    void import("@streamdown/math").then(({ math }) => {
      mathPlugin = math;
      if (active) setLoaded((current) => ({ ...current, math }));
    });
    return () => {
      active = false;
    };
  }, [loaded.math, wantsMath]);

  return useMemo(
    () => ({
      cjk,
      code,
      ...(loaded.mermaid ? { mermaid: loaded.mermaid } : {}),
      ...(loaded.math ? { math: loaded.math } : {}),
    }),
    [loaded.math, loaded.mermaid],
  );
}
