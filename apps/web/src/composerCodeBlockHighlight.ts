import { Extension } from "@tiptap/core";
import type { DiffsHighlighter } from "@pierre/diffs";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { resolveDiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

export const ComposerCodeBlockHighlight = Extension.create({
  name: "composer-code-highlight",
  addProseMirrorPlugins() {
    const key = new PluginKey<DecorationSet>("composer-code-highlight");
    const highlighters = new Map<string, DiffsHighlighter>();
    const pending = new Set<string>();
    const cached = new WeakMap<
      ProseMirrorNode,
      { from: number; to: number; attrs: Record<string, string> }[]
    >();
    const languageFor = (node: ProseMirrorNode) => {
      const language = (node.attrs.info as string).split(/\s+/)[0] || "text";
      return language === "gitignore" ? "ini" : language;
    };
    const decorations = (doc: ProseMirrorNode) => {
      const result: Decoration[] = [];
      doc.descendants((node, position) => {
        if (node.type.name !== "codeBlock") return;
        const language = languageFor(node);
        const highlighter = highlighters.get(language);
        if (!highlighter || node.content.size > 20_000) return false;
        let tokens = cached.get(node);
        if (!tokens) {
          tokens = [];
          try {
            const light = highlighter
              .codeToTokens(node.textContent, {
                lang: language,
                theme: resolveDiffThemeName("light"),
              })
              .tokens.flat();
            const dark = highlighter
              .codeToTokens(node.textContent, {
                lang: language,
                theme: resolveDiffThemeName("dark"),
              })
              .tokens.flat();
            tokens = light.flatMap((token, index) =>
              !token.content || !token.color
                ? []
                : [
                    {
                      from: token.offset,
                      to: token.offset + token.content.length,
                      attrs: {
                        class: "composer-code-token",
                        style: `--composer-code-light:${token.color};--composer-code-dark:${dark[index]?.color ?? token.color}`,
                      },
                    },
                  ],
            );
          } catch {
            tokens = [];
          }
          cached.set(node, tokens);
        }
        result.push(
          ...tokens.map((token) =>
            Decoration.inline(position + 1 + token.from, position + 1 + token.to, token.attrs),
          ),
        );
        return false;
      });
      return DecorationSet.create(doc, result);
    };
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => decorations(state.doc),
          apply: (transaction, previous) =>
            transaction.docChanged || transaction.getMeta(key)
              ? decorations(transaction.doc)
              : previous,
        },
        props: { decorations: (state) => key.getState(state) },
        view(view) {
          let destroyed = false;
          const load = () =>
            view.state.doc.descendants((node) => {
              if (node.type.name !== "codeBlock") return;
              const language = languageFor(node);
              if (!pending.has(language)) {
                pending.add(language);
                void getSyntaxHighlighterPromise(language)
                  .then((highlighter) => {
                    if (destroyed) return;
                    highlighters.set(language, highlighter);
                    view.dispatch(view.state.tr.setMeta(key, true));
                  })
                  .catch(() => {});
              }
              return false;
            });
          load();
          return {
            update(view, previousState) {
              if (view.state.doc !== previousState.doc) load();
            },
            destroy() {
              destroyed = true;
            },
          };
        },
      }),
    ];
  },
});
