export interface ComposerKey {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}

export function shouldSubmitComposer(event: ComposerKey): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}
