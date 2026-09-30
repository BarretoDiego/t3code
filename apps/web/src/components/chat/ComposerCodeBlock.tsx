import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { ArrowDownToLineIcon } from "lucide-react";

import { exitComposerCodeBlock } from "~/composerCodeBlockExtension";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CODE_BLOCK_FRAME_CLASS, CODE_BLOCK_HEADER_CLASS } from "./codeBlockPresentation";

export function ComposerCodeBlock({ node, editor, getPos }: NodeViewProps) {
  return (
    <NodeViewWrapper className={cn("composer-code-block", CODE_BLOCK_FRAME_CLASS)}>
      <div
        className={cn("composer-code-block-header", CODE_BLOCK_HEADER_CLASS)}
        contentEditable={false}
      >
        <span className="min-w-0 truncate font-mono text-2xs">{node.attrs.info || "text"}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-xs"
                aria-label="Continue below code block"
                onClick={() => {
                  const position = getPos();
                  if (position === undefined) return;
                  exitComposerCodeBlock(
                    editor.state,
                    (transaction) => editor.view.dispatch(transaction),
                    position,
                  );
                  editor.view.dom.focus({ preventScroll: true });
                }}
              />
            }
          >
            <ArrowDownToLineIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">Continue below code block</TooltipPopup>
        </Tooltip>
      </div>
      <pre className="composer-code-content">
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}
