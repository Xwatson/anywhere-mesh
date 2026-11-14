/**
 * Copy text to the clipboard. `navigator.clipboard` only exists in secure
 * contexts (HTTPS or localhost), and this app is often opened over plain HTTP
 * on a LAN or tailnet, so fall back to the legacy execCommand path there.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  const prevFocus = document.activeElement as HTMLElement | null;
  ta.select();
  ta.setSelectionRange(0, text.length); // iOS Safari ignores select()
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  prevFocus?.focus?.({ preventScroll: true });
  return ok;
}
