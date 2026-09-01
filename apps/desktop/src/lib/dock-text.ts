export type DockTextOpenRequest = {
  path: string;
  name: string;
};

type DockTextOpenHandler = (request: DockTextOpenRequest) => boolean;

const handlers = new Set<DockTextOpenHandler>();

/** Ask the right Dock to open (or focus) a text preview tab for a workspace file. */
export function requestDockTextPreview(request: DockTextOpenRequest): boolean {
  for (const handler of handlers) {
    try {
      if (handler(request)) return true;
    } catch {
      // A broken or unmounted Dock must not break the calling panel.
    }
  }
  return false;
}

export function subscribeDockText(handler: DockTextOpenHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}
