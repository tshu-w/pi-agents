import { BorderedLoader, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export async function waitForBackground<Lease extends { release(): void }>(
  ctx: ExtensionContext,
  controller: AbortController,
  wait: (signal: AbortSignal) => Promise<Lease>,
) {
  const result = await ctx.ui.custom<{ lease?: Lease; error?: unknown }>((tui, theme, _keys, done) => {
    const loader = new BorderedLoader(tui, theme, '[pi-agents] Waiting for the background Worker to exit');
    let settled = false;
    const dispose = loader.dispose.bind(loader);
    loader.dispose = () => {
      if (!settled) controller.abort();
      dispose();
    };
    loader.onAbort = () => controller.abort();
    void wait(controller.signal).then(lease => {
      if (controller.signal.aborted) {
        lease.release();
        settled = true;
        done({ error: controller.signal.reason });
      } else {
        settled = true;
        done({ lease });
      }
    }, error => {
      settled = true;
      done({ error });
    });
    return loader;
  });
  if (result?.error) throw result.error;
  return result?.lease;
}
