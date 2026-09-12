/**
 * Copy text to the clipboard, resolving to whether it actually succeeded.
 *
 * The async Clipboard API (`navigator.clipboard.writeText`) needs the page to be a
 * secure context AND, inside an iframe, the `clipboard-write` permission — which
 * Discord's Activity iframe does NOT grant, so it rejects there. We try it first
 * (it's the right API where allowed), then fall back to the legacy hidden-textarea
 * `execCommand('copy')`, which works in more restricted embeds. Callers should only
 * show "Copied" when this resolves true — the old `void navigator.clipboard?.…`
 * pattern reported success even when the write silently failed.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* blocked (e.g. Discord iframe) — fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
