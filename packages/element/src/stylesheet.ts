/**
 * Shadow styles are adopted as a constructed sheet rather than appended as a
 * `<style>` element.
 *
 * `style-src` applies to style elements, so under a nonce-based policy without
 * `'unsafe-inline'` the shadow sheet was blocked outright — and `:host` is in
 * it. The element then lost `display: flex` and its declared height, the
 * viewport stopped being a flex item and grew to the scroll spacer, and the
 * canvas followed until it crossed the 65,535px limit and painted nothing at
 * all. A constructed sheet is not a style element and no policy applies to it,
 * which fixes that without a consumer having to route a nonce through.
 *
 * Sharing is the other half: every instance of one element adopts the same
 * sheet instead of parsing a copy of the same text.
 */
const sheets = new Map<string, CSSStyleSheet>();

export function sharedStyleSheet(css: string): CSSStyleSheet {
  let sheet = sheets.get(css);
  if (!sheet) {
    // Built on demand rather than at module scope: importing this package
    // where there is no DOM has to keep working, which is the same reason
    // `defineHexCanvasElement` checks for `customElements` first.
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    sheets.set(css, sheet);
  }
  return sheet;
}
