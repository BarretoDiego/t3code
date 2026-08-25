import { describe, expect, it, vi } from "vite-plus/test";

import {
  closeThreadTabFromMiddleClick,
  preventThreadTabMiddleClickDefault,
} from "./threadWorkspaceTabInteractions";

function mouseEvent(button: number) {
  return {
    button,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

describe("thread workspace tab mouse interactions", () => {
  it("prevents the browser middle-button behavior on mouse down", () => {
    const middleClick = mouseEvent(1);
    const primaryClick = mouseEvent(0);

    preventThreadTabMiddleClickDefault(middleClick);
    preventThreadTabMiddleClickDefault(primaryClick);

    expect(middleClick.preventDefault).toHaveBeenCalledOnce();
    expect(primaryClick.preventDefault).not.toHaveBeenCalled();
  });

  it("closes only for a middle-button auxiliary click", () => {
    const middleClick = mouseEvent(1);
    const rightClick = mouseEvent(2);
    const onClose = vi.fn();

    closeThreadTabFromMiddleClick(rightClick, onClose);
    closeThreadTabFromMiddleClick(middleClick, onClose);

    expect(onClose).toHaveBeenCalledOnce();
    expect(middleClick.preventDefault).toHaveBeenCalledOnce();
    expect(middleClick.stopPropagation).toHaveBeenCalledOnce();
    expect(rightClick.preventDefault).not.toHaveBeenCalled();
    expect(rightClick.stopPropagation).not.toHaveBeenCalled();
  });
});
