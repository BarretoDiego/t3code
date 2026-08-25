interface ThreadTabMouseEvent {
  readonly button: number;
  preventDefault: () => void;
}

interface ThreadTabAuxClickEvent extends ThreadTabMouseEvent {
  stopPropagation: () => void;
}

export function preventThreadTabMiddleClickDefault(event: ThreadTabMouseEvent): void {
  if (event.button === 1) event.preventDefault();
}

export function closeThreadTabFromMiddleClick(
  event: ThreadTabAuxClickEvent,
  onClose: () => void,
): void {
  if (event.button !== 1) return;
  event.preventDefault();
  event.stopPropagation();
  onClose();
}
